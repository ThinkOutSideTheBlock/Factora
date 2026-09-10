import {
  MultiAssetBenchmarkReport,
  AssetBenchmark,
  ProtocolMarketRate,
  LpPoolBenchmark,
} from './graph-feed.types';
import {
  LENDING_SUBGRAPHS,
  MESSARI_MULTI_ASSET_QUERY,
  UNISWAP_V3_ETHEREUM_SUBGRAPH_ID,
  UNISWAP_TOP_STABLE_POOLS_QUERY,
} from './subgraphs.config';
import { graphMcpClient } from './graph-mcp.client';

interface MessariRate {
  rate: string;
  side: string;
  type: string;
}

interface MessariMarket {
  name: string | null;
  inputToken?: { symbol: string };
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

const BASELINE_USDC: AssetBenchmark = {
  symbol: 'USDC',
  averageSupplyApy: 0.048,
  maxSupplyApy: 0.052,
  minSupplyApy: 0.044,
  topMarket: 'Aave v3 (Ethereum)',
  marketsCount: 2,
};

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
      const endpoint = `https://gateway.thegraph.com/api/${this.apiKey}/subgraphs/id/${target.subgraphId}`;
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: MESSARI_MULTI_ASSET_QUERY }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          console.warn(
            `[GraphFeed] HTTP ${res.status} querying ${target.protocol} on ${target.chain}`,
          );
          return;
        }
        const body = (await res.json()) as {
          data?: { markets?: MessariMarket[] | null };
          errors?: Array<{ message: string }>;
        };
        if (body.errors && body.errors.length > 0) {
          console.warn(
            `[GraphFeed] GraphQL error from ${target.protocol} on ${target.chain}: ${body.errors[0].message}`,
          );
          return;
        }
        for (const market of body.data?.markets ?? []) {
          this.collectMarketRate(target, market, rawRates);
        }
      } catch (err) {
        console.warn(
          `[GraphFeed] Failed querying ${target.protocol} on ${target.chain}:`,
          err instanceof Error ? err.message : err,
        );
      }
    });

    await Promise.allSettled(fetches);

    if (rawRates.length === 0) {
      return this.getFallbackReport();
    }

    return {
      timestamp: Date.now(),
      benchmarks: this.aggregateBenchmarks(rawRates),
      detailedRates: rawRates,
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

  private collectMarketRate(
    target: { protocol: string; chain: string },
    market: MessariMarket,
    out: ProtocolMarketRate[],
  ): void {
    const symbol = market.inputToken?.symbol?.toUpperCase();
    if (!symbol || !['USDC', 'USDT', 'DAI'].includes(symbol)) return;
    if (!market.rates || market.rates.length === 0) return;

    let supplyRate = 0;
    let borrowRate = 0;
    for (const r of market.rates) {
      if (r.type !== 'VARIABLE') continue;
      let val = Number(r.rate);
      if (!Number.isFinite(val)) continue;
      // Messari stores percentage APY ("3.63" = 3.63%); Ray payloads (1e27
      // scale) from legacy deployments are normalized here too.
      if (val > 1e6) val = val / 1e27;
      else val = val / 100;
      if (r.side === 'LENDER') supplyRate = val;
      if (r.side === 'BORROWER') borrowRate = val;
    }

    out.push({
      protocol: target.protocol,
      chain: target.chain,
      symbol,
      supplyApy: Number(supplyRate.toFixed(4)),
      borrowApy: Number(borrowRate.toFixed(4)),
      totalValueLockedUSD: Number(market.totalValueLockedUSD || 0),
    });
  }

  private aggregateBenchmarks(
    rawRates: ProtocolMarketRate[],
  ): Record<string, AssetBenchmark> {
    const benchmarks: Record<string, AssetBenchmark> = {};
    for (const sym of ['USDC', 'USDT', 'DAI']) {
      const matching = rawRates.filter((r) => r.symbol === sym && r.supplyApy > 0);
      if (matching.length === 0) {
        benchmarks[sym] = { ...BASELINE_USDC, symbol: sym };
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
    const feeRevenue = snapshots
      .slice(0, hours)
      .reduce((acc, s) => acc + Number(s.hourlySupplySideRevenueUSD || 0), 0);
    const avgTvl =
      snapshots
        .slice(0, hours)
        .reduce((acc, s) => acc + Number(s.totalValueLockedUSD || 0), 0) / hours;
    if (avgTvl <= 0) return null;

    const annualized = (feeRevenue / hours) * 24 * 365 / avgTvl;
    const tvlUsd = Number(pool.totalValueLockedUSD || 0);
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
      benchmarks: {
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
      },
      detailedRates: [],
      source: 'The Graph Gateway (Deterministic Baseline Fallback)',
    };
  }
}

export const graphFeedService = new GraphFeedService();
