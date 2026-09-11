import {
  MultiAssetBenchmarkReport,
  AssetBenchmark,
  ProtocolMarketRate,
  LpPoolBenchmark,
} from './graph-feed.types.js';
import {
  LENDING_SUBGRAPHS,
  MESSARI_MULTI_ASSET_QUERY,
  MIN_TVL_USD,
  UNISWAP_V3_ETHEREUM_SUBGRAPH_ID,
  UNISWAP_TOP_STABLE_POOLS_QUERY,
} from './subgraphs.config.js';
import { graphMcpClient } from './graph-mcp.client.js';

interface MessariRate {
  rate: string;
  side: string;
  type: string;
}

interface MessariMarket {
  name: string | null;
  isActive?: boolean;
  inputToken?: { id?: string; symbol: string };
  totalValueLockedUSD: string;
  rates: MessariRate[];
}

interface UniswapPool {
  name: string | null;
  inputTokens?: Array<{ symbol: string }>;
  fees?: Array<{ feeType: string; feePercentage: string }>;
  totalValueLockedUSD: string;
  hourlySnapshots?: Array<{
    hourlySupplySideRevenueUSD: string;
    totalValueLockedUSD: string;
  }>;
}

const ASSET_SYMBOLS = ['USDC', 'USDT', 'DAI'] as const;
const ASSET_ALIASES: Record<string, (typeof ASSET_SYMBOLS)[number]> = {
  USDC: 'USDC',
  'USDC.E': 'USDC',
  USDBC: 'USDC',
  USDCN: 'USDC',
  USDT: 'USDT',
  DAI: 'DAI',
};

const FALLBACK_BENCHMARKS: Record<string, AssetBenchmark> = {
  USDC: {
    symbol: 'USDC',
    averageSupplyApy: 0.048,
    maxSupplyApy: 0.052,
    minSupplyApy: 0.044,
    topMarket: 'Aave v3 (Ethereum)',
    marketsCount: 2,
  },
  USDT: {
    symbol: 'USDT',
    averageSupplyApy: 0.051,
    maxSupplyApy: 0.055,
    minSupplyApy: 0.047,
    topMarket: 'Compound v3 (Ethereum)',
    marketsCount: 2,
  },
  DAI: {
    symbol: 'DAI',
    averageSupplyApy: 0.062,
    maxSupplyApy: 0.065,
    minSupplyApy: 0.058,
    topMarket: 'Aave v3 (Ethereum)',
    marketsCount: 2,
  },
};

const TARGET_TIMEOUT_MS = 30_000;
const TARGET_RETRY_BACKOFF_MS = 250;

export class GraphFeedService {
  private readonly apiKey: string;

  constructor() {
    this.apiKey =
      process.env.GRAPH_API_KEY || '';
  }

  /**
   * Stateless concurrent fetch across every registered Messari lending
   * subgraph. No internal caching; the caller decides freshness policy.
   */
  async getStandardizedLendingBenchmarks(): Promise<MultiAssetBenchmarkReport> {
    const rawRates: ProtocolMarketRate[] = [];

    const fetches = LENDING_SUBGRAPHS.map(async (target) => {
      const markets = await this.fetchMarketsWithRetry(target);
      for (const market of markets) {
        this.collectMarketRate(target, market, rawRates);
      }
    });

    await Promise.allSettled(fetches);

    if (rawRates.length === 0) {
      return this.getFallbackReport();
    }

    // Q1/Q2 hardening: a single (protocol, chain, symbol) may still surface
    // more than once when a subgraph lists both native and bridged markets
    // as active (e.g. USDCn vs USDC.e). Keep only the deepest-liquidity
    // market per key so benchmarks are never diluted.
    const rates = this.deduplicateByDeepestTvl(rawRates);

    return {
      timestamp: Date.now(),
      benchmarks: this.aggregateBenchmarks(rates),
      detailedRates: rates,
      source: 'The Graph Decentralized Network (Messari Standardized)',
    };
  }

  /**
   * Comparative DEX LP yields from live Uniswap v3 data via the Subgraph MCP
   * singleton; falls back to static reference pools if MCP is offline.
   */
  async getDEXLiquidityYield(): Promise<LpPoolBenchmark[]> {
    try {
      const result = await graphMcpClient.queryDynamic(
        UNISWAP_V3_ETHEREUM_SUBGRAPH_ID,
        UNISWAP_TOP_STABLE_POOLS_QUERY,
      );
      const pools = (result?.data as { liquidityPools?: UniswapPool[] })
        ?.liquidityPools;
      const benchmarks: LpPoolBenchmark[] = [];
      for (const pool of pools ?? []) {
        const benchmark = this.toLpBenchmark(pool);
        if (benchmark) benchmarks.push(benchmark);
      }
      if (benchmarks.length > 0) return benchmarks;
      console.warn('[GraphFeed] MCP returned no usable LP pools, using fallback');
      return this.getFallbackLpPools();
    } catch (err) {
      console.warn(
        '[GraphFeed] DEX LP fetch failed, using fallback:',
        err instanceof Error ? err.message : err,
      );
      return this.getFallbackLpPools();
    }
  }

  /**
   * Query a single Messari target with one automatic retry. The Morpho Blue
   * deployments are substreams-based and can exceed a tight timeout on cold
   * gateway routes, so the per-target timeout is generous and a transient
   * failure gets a second chance before the target is skipped. Deterministic
   * failures (HTTP != 2xx, GraphQL errors) return empty without retrying.
   */
  private async fetchMarketsWithRetry(
    target: { protocol: string; chain: string; subgraphId: string },
  ): Promise<MessariMarket[]> {
    try {
      return await this.fetchMarkets(target);
    } catch (err) {
      console.warn(
        `[GraphFeed] Failed querying ${target.protocol} on ${target.chain} (${
          err instanceof Error ? err.message : err
        }); retrying once`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, TARGET_RETRY_BACKOFF_MS));
    try {
      return await this.fetchMarkets(target);
    } catch (err) {
      console.warn(
        `[GraphFeed] Retry failed for ${target.protocol} on ${target.chain}:`,
        err instanceof Error ? err.message : err,
      );
      return [];
    }
  }

  private async fetchMarkets(target: {
    protocol: string;
    chain: string;
    subgraphId: string;
  }): Promise<MessariMarket[]> {
    const endpoint = `https://gateway.thegraph.com/api/${this.apiKey}/subgraphs/id/${target.subgraphId}`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: MESSARI_MULTI_ASSET_QUERY }),
      signal: AbortSignal.timeout(TARGET_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(
        `[GraphFeed] HTTP ${res.status} querying ${target.protocol} on ${target.chain}`,
      );
      return [];
    }
    const body = (await res.json()) as {
      data?: { markets?: MessariMarket[] | null };
      errors?: Array<{ message: string }>;
    };
    if (body.errors && body.errors.length > 0) {
      console.warn(
        `[GraphFeed] GraphQL error from ${target.protocol} on ${target.chain}: ${body.errors[0].message}`,
      );
      return [];
    }
    return body.data?.markets ?? [];
  }

  private collectMarketRate(
    target: { protocol: string; chain: string },
    market: MessariMarket,
    out: ProtocolMarketRate[],
  ): void {
    // Q1: paused/frozen markets never enter benchmarks (client-side guard;
    // the shared query also filters server-side). Undefined in mocks = keep.
    if (market.isActive === false) return;

    const rawSymbol = market.inputToken?.symbol?.toUpperCase();
    const symbol = rawSymbol ? ASSET_ALIASES[rawSymbol] : undefined;
    if (!symbol) return;
    if (!market.rates || market.rates.length === 0) return;

    // Q2: dust markets are excluded as defense in depth (isolated Morpho
    // Blue micro-markets can be worth single-digit dollars).
    const tvl = this.toFiniteNonNegativeNumber(market.totalValueLockedUSD);
    if (tvl < MIN_TVL_USD) return;

    let supplyRate = 0;
    let borrowRate = 0;
    for (const r of market.rates) {
      if (r.type !== 'VARIABLE') continue;
      const parsed = Number(r.rate);
      if (!Number.isFinite(parsed)) continue;
      const val = this.normalizeRate(parsed);
      if (r.side === 'LENDER') supplyRate = val;
      if (r.side === 'BORROWER') borrowRate = val;
    }

    out.push({
      protocol: target.protocol,
      chain: target.chain,
      symbol,
      supplyApy: Number(supplyRate.toFixed(4)),
      borrowApy: Number(borrowRate.toFixed(4)),
      totalValueLockedUSD: tvl,
      marketName: market.name ?? undefined,
      ...(market.inputToken?.id ? { inputTokenId: market.inputToken.id } : {}),
      ...(typeof market.isActive === 'boolean' ? { isActive: market.isActive } : {}),
    });
  }

  /**
   * Normalize rate values into decimal APY fractions:
   *   - Ray/wei-style payloads (1e27 scale, e.g. 3.63e25) → /1e27
   *   - Messari percentage APY ("3.63" = 3.63%) → /100
   *   - Already-decimal values pass through unchanged.
   * The band boundaries matter: Morpho Blue returns true decimal APYs like
   * 0.0018 (0.18%) that must not be re-divided, while Aave/Compound return
   * percentages like 3.63 that must be. Any value in (100, 1e18] passes
   * through unchanged (outside both known scales).
   */
  private normalizeRate(value: number): number {
    if (value > 1e18) return value / 1e27; // Ray-scale payload
    if (value > 0.0001 && value <= 100) return value / 100; // Percentage APY
    return value; // Already decimal
  }

  /**
   * Collapse duplicate (protocol, chain, symbol) rows, keeping the
   * deepest-liquidity market. Native and bridged stablecoin variants (USDCn,
   * USDC.e, USDbC) normalize to the same canonical symbol; on ties the first
   * occurrence wins.
   */
  private deduplicateByDeepestTvl(
    rates: ProtocolMarketRate[],
  ): ProtocolMarketRate[] {
    const deepest = new Map<string, ProtocolMarketRate>();
    for (const rate of rates) {
      const key = `${rate.protocol}|${rate.chain}|${rate.symbol}`;
      const incumbent = deepest.get(key);
      if (!incumbent || rate.totalValueLockedUSD > incumbent.totalValueLockedUSD) {
        deepest.set(key, rate);
      }
    }
    return [...deepest.values()];
  }

  private aggregateBenchmarks(
    rawRates: ProtocolMarketRate[],
  ): Record<string, AssetBenchmark> {
    const benchmarks: Record<string, AssetBenchmark> = {};
    for (const sym of ASSET_SYMBOLS) {
      const matching = rawRates.filter((r) => r.symbol === sym && r.supplyApy > 0);
      if (matching.length === 0) {
        benchmarks[sym] = { ...FALLBACK_BENCHMARKS[sym] };
        continue;
      }
      const avg =
        matching.reduce((acc, cur) => acc + cur.supplyApy, 0) / matching.length;
      const sorted = [...matching].sort((a, b) => b.supplyApy - a.supplyApy);
      benchmarks[sym] = {
        symbol: sym,
        averageSupplyApy: Number(avg.toFixed(4)),
        maxSupplyApy: sorted[0].supplyApy,
        minSupplyApy: sorted[sorted.length - 1].supplyApy,
        topMarket: `${sorted[0].protocol} (${sorted[0].chain})`,
        marketsCount: matching.length,
      };
    }
    return benchmarks;
  }

  private toLpBenchmark(pool: UniswapPool): LpPoolBenchmark | null {
    const symbols = (pool.inputTokens ?? []).map((t) => t.symbol);
    if (symbols.length !== 2) return null;

    const tradingFee = Number(
      pool.fees?.find((f) => f.feeType === 'FIXED_TRADING_FEE')?.feePercentage ?? NaN,
    );
    const snapshots = pool.hourlySnapshots ?? [];
    if (!Number.isFinite(tradingFee) || snapshots.length < 2) return null;

    // Annualize realized supply-side fee revenue over the snapshot window.
    const hours = Math.min(snapshots.length, 24);
    const window = snapshots.slice(0, hours);
    const revenues = window.map((snapshot) =>
      Number(snapshot.hourlySupplySideRevenueUSD),
    );
    const tvls = window.map((snapshot) => Number(snapshot.totalValueLockedUSD));
    if (revenues.some((value) => !Number.isFinite(value)) || tvls.some((value) => !Number.isFinite(value))) {
      return null;
    }
    const feeRevenue = revenues.reduce((acc, value) => acc + value, 0);
    const avgTvl = tvls.reduce((acc, value) => acc + value, 0) / hours;
    if (avgTvl <= 0) return null;

    const annualized = (feeRevenue / hours) * 24 * 365 / avgTvl;
    const tvlUsd = this.toFiniteNonNegativeNumber(pool.totalValueLockedUSD);
    if (!Number.isFinite(annualized) || tvlUsd <= 0) return null;

    return {
      protocol: 'Uniswap v3',
      pair: `${symbols[0]}/${symbols[1]} (${tradingFee}%)`,
      estimatedApy: Number(annualized.toFixed(4)),
      tvlUSD: tvlUsd,
    };
  }

  private getFallbackLpPools(): LpPoolBenchmark[] {
    return [
      {
        protocol: 'Uniswap v3 (Fallback)',
        pair: 'USDC/USDT (0.01%)',
        estimatedApy: 0.075,
        tvlUSD: 50_000_000,
      },
      {
        protocol: 'Uniswap v3 (Fallback)',
        pair: 'USDC/WETH (0.05%)',
        estimatedApy: 0.12,
        tvlUSD: 250_000_000,
      },
    ];
  }

  private getFallbackReport(): MultiAssetBenchmarkReport {
    return {
      timestamp: Date.now(),
      benchmarks: Object.fromEntries(
        ASSET_SYMBOLS.map((symbol) => [symbol, { ...FALLBACK_BENCHMARKS[symbol] }]),
      ),
      detailedRates: [],
      source: 'Deterministic Baseline Fallback',
    };
  }

  private toFiniteNonNegativeNumber(value: string): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }
}

export const graphFeedService = new GraphFeedService();
