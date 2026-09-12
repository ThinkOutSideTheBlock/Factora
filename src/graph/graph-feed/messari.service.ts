import {
  MultiAssetBenchmarkReport,
  AssetBenchmark,
  ProtocolMarketRate,
  GraphFeedError,
} from './graph-feed.types.js';
import {
  LENDING_SUBGRAPHS,
  MESSARI_MULTI_ASSET_QUERY,
  MIN_TVL_USD,
} from './subgraphs.config.js';

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

const ASSET_SYMBOLS = ['USDC', 'USDT', 'DAI'] as const;
const ASSET_ALIASES: Record<string, (typeof ASSET_SYMBOLS)[number]> = {
  USDC: 'USDC',
  'USDC.E': 'USDC',
  USDBC: 'USDC',
  USDCN: 'USDC',
  USDT: 'USDT',
  DAI: 'DAI',
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
    const candidateErrors: { target: string; error: string }[] = [];
    const rawRates: ProtocolMarketRate[] = [];

    const fetches = LENDING_SUBGRAPHS.map(async (target) => {
      const markets = await this.fetchMarketsWithRetry(target);
      for (const market of markets) {
        this.collectMarketRate(target, market, rawRates);
      }
    });

    const settled = await Promise.allSettled(fetches);
    for (let i = 0; i < settled.length; i += 1) {
      const outcome = settled[i];
      if (outcome.status === 'rejected') {
        const target = LENDING_SUBGRAPHS[i];
        candidateErrors.push({
          target: `${target.protocol} on ${target.chain}`,
          error:
            outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason),
        });
      }
    }

    // STRICT DATA CONTRACT: no targets returned usable markets above the
    // quality gates — this module never fabricates benchmark values.
    if (rawRates.length === 0) {
      throw new GraphFeedError(
        'ALL_TARGETS_FAILED',
        'no Messari lending subgraph returned usable markets above the quality gates — refusing to fabricate benchmarks',
        { candidateErrors },
      );
    }

    // Q1/Q2 hardening: a single (protocol, chain, symbol) may still surface
    // more than once when a subgraph lists both native and bridged markets
    // as active (e.g. USDCn vs USDC.e). Keep only the deepest-liquidity
    // market per key so benchmarks are never diluted.
    const rates = this.deduplicateByDeepestTvl(rawRates);
    const benchmarks = this.aggregateBenchmarks(rates);

    // STRICT DATA CONTRACT: every canonical underwriting stablecoin must be
    // present in the live set; a missing asset is an error.
    const missingAssets = ASSET_SYMBOLS.filter(
      (symbol) => !benchmarks[symbol],
    );
    if (missingAssets.length > 0) {
      throw new GraphFeedError(
        'NO_LIVE_DATA',
        `live markets returned but canonical assets are missing: ${missingAssets.join(', ')} — refusing to fabricate benchmarks`,
        { missingAssets: [...missingAssets], candidateErrors },
      );
    }

    return {
      timestamp: Date.now(),
      benchmarks,
      detailedRates: rates,
      source: 'The Graph Decentralized Network (Messari Standardized)',
    };
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
    const rawSymbol = market.inputToken?.symbol?.toUpperCase();
    const symbol = rawSymbol ? ASSET_ALIASES[rawSymbol] : undefined;
    if (!symbol) return;
    // Spark currently reports its large DAI reserve as inactive while still
    // exposing a live rate and TVL. Keep that canonical DAI row; paused
    // non-underwriting assets remain excluded.
    if (market.isActive === false && symbol !== 'DAI') return;
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
   * A single (protocol, chain, canonical symbol) key must resolve to exactly
   * one market: the deepest-liquidity live market. Native Circle USDC and a
   * still-listed bridged variant (USDC.e) collapse to one row instead of a
   * duplicate that dilutes the benchmark.
   */
  private deduplicateByDeepestTvl(
    rates: ProtocolMarketRate[],
  ): ProtocolMarketRate[] {
    const deepest = new Map<string, ProtocolMarketRate>();
    for (const rate of rates) {
      const key = `${rate.protocol}|${rate.chain}|${rate.symbol}`;
      const current = deepest.get(key);
      if (!current || rate.totalValueLockedUSD > current.totalValueLockedUSD) {
        deepest.set(key, rate);
      }
    }
    return [...deepest.values()].sort(
      (a, b) => b.totalValueLockedUSD - a.totalValueLockedUSD,
    );
  }

  private aggregateBenchmarks(
    rates: ProtocolMarketRate[],
  ): Record<string, AssetBenchmark> {
    const benchmarks: Record<string, AssetBenchmark> = {};
    for (const symbol of ASSET_SYMBOLS) {
      const markets = rates.filter(
        (rate) => rate.symbol === symbol && rate.supplyApy > 0,
      );
      if (markets.length === 0) continue;
      const averageSupplyApy =
        markets.reduce((sum, m) => sum + m.supplyApy, 0) / markets.length;
      const top = markets.reduce((best, m) =>
        m.supplyApy > best.supplyApy ? m : best,
      );
      benchmarks[symbol] = {
        symbol,
        averageSupplyApy: Number(averageSupplyApy.toFixed(4)),
        maxSupplyApy: Number(
          Math.max(...markets.map((m) => m.supplyApy)).toFixed(4),
        ),
        minSupplyApy: Number(
          Math.min(...markets.map((m) => m.supplyApy)).toFixed(4),
        ),
        topMarket: `${top.protocol} (${top.chain})`,
        marketsCount: markets.length,
      };
    }
    return benchmarks;
  }

  private toFiniteNonNegativeNumber(value: string): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }
}

export const graphFeedService = new GraphFeedService();
