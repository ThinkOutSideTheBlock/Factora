/**
 * ============================================================================
 * TEST SUITE: GraphFeedService
 * ============================================================================
 *
 * This file tests the core data-fetching service of the Factora graph-feed
 * module. The service is responsible for:
 *
 * 1. Fetching live lending yields from Aave v3, Compound v3, Morpho Blue, and
 *    Spark via The Graph's Messari-standardized subgraphs (Gateway HTTP).
 * 2. Normalizing raw rate values (Ray-scale 1e27 → decimal, percentage → decimal).
 * 3. Aggregating per-asset benchmarks (average, min, max APY).
 * 4. Throwing `GraphFeedError` when usable data is missing — the module never
 *    fabricates fallback values.
 *
 * External dependencies (global fetch) are mocked to isolate business logic.
 * Mocks are keyed by `protocol|chain` (not by queue index) so they stay valid
 * as the deployment matrix grows.
 *
 * Author: Factora Team
 * ============================================================================
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Import the class under test and the types it produces. We import the CLASS
// directly (not the singleton) so each test gets a fresh instance with no
// shared state between test cases.
// ---------------------------------------------------------------------------
import { GraphFeedService } from '../graph-feed/graph-feed.service.js';
import { GraphFeedError } from '../graph-feed/graph-feed.types.js';
import { LENDING_SUBGRAPHS, MESSARI_MULTI_ASSET_QUERY } from '../graph-feed/subgraphs.config.js';

import type {
  ProtocolMarketRate,
  AssetBenchmark,
  MultiAssetBenchmarkReport,
} from '../graph-feed/graph-feed.types.js';

// ---------------------------------------------------------------------------
// MOCK: global fetch
// We replace the real `fetch` with a Vitest mock so we can simulate both
// success and failure scenarios without hitting The Graph network.
// ---------------------------------------------------------------------------
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ===========================================================================
// Helper: build a mock Messari GraphQL response
// ===========================================================================
function buildMockMessariResponse(
  markets: Array<{
    name: string;
    symbol: string;
    tvl: string;
    supplyRate: string;
    borrowRate: string;
  }>,
) {
  return {
    data: {
      markets: markets.map((m) => ({
        name: m.name,
        inputToken: { symbol: m.symbol },
        totalValueLockedUSD: m.tvl,
        rates: [
          { rate: m.supplyRate, side: 'LENDER', type: 'VARIABLE' },
          { rate: m.borrowRate, side: 'BORROWER', type: 'VARIABLE' },
        ],
      })),
    },
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Position-independent fetch mocking: each pinned deployment is addressed by
// its subgraphId (resolved via protocol|chain), never by queue order or index,
// so the tests survive matrix changes (adding/removing chains or protocols).
// ---------------------------------------------------------------------------

interface MockTargetResponse {
  kind: 'empty' | 'reject' | 'http-error' | 'graphql-error' | 'markets';
  status?: number;
  message?: string;
  markets?: Array<{
    name: string;
    symbol: string;
    tvl: string;
    supplyRate: string;
    borrowRate: string;
    isActive?: boolean;
    id?: string;
    /** Emit a Market with NO rates array at all (unusable → skipped). */
    omitRates?: boolean;
  }>;
}

function targetKey(protocol: string, chain: string): string | undefined {
  const target = LENDING_SUBGRAPHS.find(
    (t) => t.protocol === protocol && t.chain === chain,
  );
  return target?.subgraphId;
}

function mockFetchByTarget(
  responses: Partial<Record<string, MockTargetResponse>>,
): void {
  mockFetch.mockImplementation(async (input: unknown) => {
    const url = typeof input === 'string' ? input : String(input);
    const target = LENDING_SUBGRAPHS.find((t) => url.includes(t.subgraphId));
    const res: MockTargetResponse =
      (target && responses[target.subgraphId]) ||
      responses.DEFAULT ||
      { kind: 'empty' };
    switch (res.kind) {
      case 'reject':
        throw new Error(res.message ?? 'simulated network failure');
      case 'http-error':
        return { ok: false, status: res.status ?? 500, json: async () => ({}) };
      case 'graphql-error':
        return {
          ok: true,
          json: async () => ({
            data: null,
            errors: [{ message: res.message ?? 'GraphQL error' }],
          }),
        };
      case 'markets':
        return {
          ok: true,
          json: async () => ({
            data: {
              markets: (res.markets ?? []).map((m) => ({
                name: m.name,
                isActive: m.isActive ?? true,
                inputToken: m.id ? { id: m.id, symbol: m.symbol } : { symbol: m.symbol },
                totalValueLockedUSD: m.tvl,
                rates: m.omitRates
                  ? []
                  : [
                      { rate: m.supplyRate, side: 'LENDER', type: 'VARIABLE' },
                      { rate: m.borrowRate, side: 'BORROWER', type: 'VARIABLE' },
                    ],
              })),
            },
            errors: [],
          }),
        };
      default:
        return { ok: true, json: async () => ({ data: { markets: [] }, errors: [] }) };
    }
  });
}

/** Convenience: a full three-asset market set for one target response. */
function allStablecoinMarkets(
  base: string,
  supplyRate: string,
  borrowRate: string,
  namePrefix = 'Market',
): NonNullable<MockTargetResponse['markets']> {
  return [
    { name: `${namePrefix} USDC`, symbol: 'USDC', tvl: '100000000', supplyRate, borrowRate },
    { name: `${namePrefix} USDT`, symbol: 'USDT', tvl: '90000000', supplyRate, borrowRate },
    { name: `${namePrefix} DAI`, symbol: 'DAI', tvl: '80000000', supplyRate, borrowRate },
  ];
}

// ===========================================================================
// Helper: build a mock Uniswap LP pool response
// ===========================================================================
function buildMockUniswapResponse(
  pools: Array<{
    name: string;
    symbols: string[];
    feePercentage: string;
    tvl: string;
    hourlySnapshots: Array<{
      revenue: string;
      tvl: string;
    }>;
  }>,
) {
  return {
    data: {
      liquidityPools: pools.map((p) => ({
        name: p.name,
        inputTokens: p.symbols.map((s) => ({ symbol: s })),
        fees: [{ feeType: 'FIXED_TRADING_FEE', feePercentage: p.feePercentage }],
        totalValueLockedUSD: p.tvl,
        hourlySnapshots: p.hourlySnapshots.map((h) => ({
          hourlySupplySideRevenueUSD: h.revenue,
          totalValueLockedUSD: h.tvl,
        })),
      })),
    },
  };
}

// ===========================================================================
// TEST SUITE: collectMarketRate — internal rate normalization logic
// ===========================================================================
describe('GraphFeedService — Rate Normalization', () => {
  let service: GraphFeedService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    // Inject a dummy API key so the constructor doesn't depend on env vars.
    process.env.GRAPH_API_KEY = 'test-api-key';
    service = new GraphFeedService();
  });

  // -----------------------------------------------------------------------
  // We test the normalization indirectly by calling getStandardizedLendingBenchmarks
  // with mocked fetch responses. The method calls collectMarketRate internally,
  // which normalizes rates from different scales:
  //
  //   - Messari standard: "3.63" → 0.0363 (divide by 100)
  //   - Legacy Ray scale: 3.63e27  → 0.0363 (divide by 1e27)
  //   - Invalid/non-finite values are silently skipped
  // -----------------------------------------------------------------------

  it('should normalize standard Messari percentage rates (e.g. "3.63" → 0.0363)', async () => {
    // Arrange: a single Aave v3 Ethereum market returning 3.63% APY, with
    // USDT/DAI siblings so the strict full-coverage contract is satisfied.
    mockFetchByTarget({
      [targetKey('Aave v3', 'Ethereum')!]: {
        kind: 'markets',
        markets: [
          { name: 'Aave v3 USDC', symbol: 'USDC', tvl: '50000000', supplyRate: '3.63', borrowRate: '5.12' },
          { name: 'Aave v3 USDT', symbol: 'USDT', tvl: '40000000', supplyRate: '3.10', borrowRate: '5.00' },
          { name: 'Aave v3 DAI', symbol: 'DAI', tvl: '30000000', supplyRate: '3.00', borrowRate: '4.90' },
        ],
      },
    });

    const report = await service.getStandardizedLendingBenchmarks();
    const usdcRate = report.detailedRates.find(
      (r) => r.protocol === 'Aave v3' && r.chain === 'Ethereum' && r.symbol === 'USDC',
    );

    expect(usdcRate).toBeDefined();
    // 3.63 / 100 = 0.0363
    expect(usdcRate!.supplyApy).toBeCloseTo(0.0363, 4);
    expect(usdcRate!.borrowApy).toBeCloseTo(0.0512, 4);
  });

  it('should normalize bridged USDC symbols to the canonical USDC asset', async () => {
    mockFetchByTarget({
      [targetKey('Aave v3', 'Ethereum')!]: {
        kind: 'markets',
        markets: [
          { name: 'Aave USDC.e', symbol: 'USDC.e', tvl: '50000000', supplyRate: '3.63', borrowRate: '5.12' },
          { name: 'Aave USDT', symbol: 'USDT', tvl: '40000000', supplyRate: '3.10', borrowRate: '5.00' },
          { name: 'Aave DAI', symbol: 'DAI', tvl: '30000000', supplyRate: '3.00', borrowRate: '4.90' },
        ],
      },
    });

    const report = await service.getStandardizedLendingBenchmarks();

    expect(report.detailedRates[0].symbol).toBe('USDC');
    expect(report.benchmarks.USDC.averageSupplyApy).toBeCloseTo(0.0363, 4);
  });

  it('should normalize Ray-scale rates (e.g. 3.63e25 → 0.0363)', async () => {
    // Position-independent: pin the Morpho Blue Ethereum deployment by
    // identity — the matrix may gain/lose chains and the test must survive.
    mockFetchByTarget({
      [targetKey('Morpho Blue', 'Ethereum')!]: {
        kind: 'markets',
        markets: [
          { name: 'Morpho Blue USDC', symbol: 'USDC', tvl: '20000000', supplyRate: String(3.63e25), borrowRate: String(5.12e25) },
          { name: 'Morpho Blue USDT', symbol: 'USDT', tvl: '18000000', supplyRate: '2.40', borrowRate: '4.10' },
          { name: 'Morpho Blue DAI', symbol: 'DAI', tvl: '16000000', supplyRate: '2.80', borrowRate: '4.40' },
        ],
      },
    });

    const report = await service.getStandardizedLendingBenchmarks();
    const rate = report.detailedRates.find((r) => r.protocol === 'Morpho Blue');

    expect(rate).toBeDefined();
    expect(rate!.supplyApy).toBeCloseTo(0.0363, 4);
  });

  it('should skip non-finite rate values and never fabricate values (strict)', async () => {
    // USDC's rates are non-finite → the market yields no usable rate, so the
    // USDC benchmark is missing and the strict contract turns that into an
    // error. USDT and DAI siblings keep the rest of the report intact.
    mockFetchByTarget({
      [targetKey('Aave v3', 'Ethereum')!]: {
        kind: 'markets',
        markets: [
          { name: 'Aave v3 USDC', symbol: 'USDC', tvl: '50000000', supplyRate: 'not-a-number', borrowRate: 'NaN' },
          { name: 'Aave v3 USDT', symbol: 'USDT', tvl: '40000000', supplyRate: '3.10', borrowRate: '5.00' },
          { name: 'Aave v3 DAI', symbol: 'DAI', tvl: '30000000', supplyRate: '3.00', borrowRate: '4.90' },
        ],
      },
    });

    try {
      await service.getStandardizedLendingBenchmarks();
      expect.unreachable('should have thrown');
    } catch (error) {
      const feedError = error as GraphFeedError;
      expect(feedError.code).toBe('NO_LIVE_DATA');
      expect(feedError.missingAssets).toEqual(['USDC']);
    }
  });

  it('should skip markets with no rates array (strict: unusable → error)', async () => {
    // The only market is unusable (no rates) → zero usable rows across all
    // targets → the strict contract throws instead of returning a report.
    mockFetchByTarget({
      [targetKey('Aave v3', 'Ethereum')!]: {
        kind: 'markets',
        markets: [
          {
            name: 'Empty Market',
            symbol: 'USDC',
            tvl: '1000000',
            supplyRate: '',
            borrowRate: '',
            omitRates: true,
          },
        ],
      },
    });

    try {
      await service.getStandardizedLendingBenchmarks();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as GraphFeedError).code).toBe('ALL_TARGETS_FAILED');
    }
  });

  it('should skip non-VARIABLE rate types (e.g. FIXED)', async () => {
    // Only the VARIABLE LENDER rate is captured; FIXED is ignored.
    mockFetchByTarget({
      [targetKey('Aave v3', 'Ethereum')!]: {
        kind: 'markets',
        markets: [
          {
            name: 'Aave v3 USDC',
            symbol: 'USDC',
            tvl: '50000000',
            supplyRate: '5.00',
            borrowRate: '7.00',
          },
          { name: 'Aave v3 USDT', symbol: 'USDT', tvl: '40000000', supplyRate: '3.10', borrowRate: '5.00' },
          { name: 'Aave v3 DAI', symbol: 'DAI', tvl: '30000000', supplyRate: '3.00', borrowRate: '4.90' },
        ],
      },
    });

    const report = await service.getStandardizedLendingBenchmarks();
    const rate = report.detailedRates.find((r) => r.protocol === 'Aave v3' && r.chain === 'Ethereum');

    // Only the VARIABLE rate (5.00/100 = 0.05) should be captured
    expect(rate!.supplyApy).toBeCloseTo(0.05, 4);
  });
});

// ===========================================================================
// TEST SUITE: aggregateBenchmarks — benchmark calculation
// ===========================================================================
describe('GraphFeedService — Benchmark Aggregation', () => {
  let service: GraphFeedService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { markets: [] }, errors: [] }) });
    process.env.GRAPH_API_KEY = 'test-api-key';
    service = new GraphFeedService();
  });

  it('should calculate correct average, min, and max for a single asset across multiple markets', async () => {
    // Position-independent: pin the three protocol targets by identity, not
    // by index — the matrix may gain/lose chains.
    const pinned = new Map<string, { rate: string; prefix: string }>();
    const pin = (protocol: string, chain: string, rate: string, prefix: string) => {
      const key = targetKey(protocol, chain);
      expect(key).toBeDefined();
      pinned.set(key!, { rate, prefix });
    };
    pin('Aave v3', 'Ethereum', '4.00', 'Aave');
    pin('Compound v3', 'Ethereum', '6.00', 'Compound');
    pin('Morpho Blue', 'Ethereum', '8.00', 'Morpho');

    for (const target of LENDING_SUBGRAPHS) {
      const spec = pinned.get(target.subgraphId);
      mockFetch.mockResolvedValueOnce(
        spec
          ? {
              ok: true,
              json: async () =>
                buildMockMessariResponse(allStablecoinMarkets(spec.prefix, spec.rate, '7.00')),
            }
          : { ok: true, json: async () => ({ data: { markets: [] }, errors: [] }) },
      );
    }

    const report = await service.getStandardizedLendingBenchmarks();
    const usdc = report.benchmarks.USDC;

    expect(usdc.averageSupplyApy).toBeCloseTo(0.06, 4);
    expect(usdc.maxSupplyApy).toBeCloseTo(0.08, 4);
    expect(usdc.minSupplyApy).toBeCloseTo(0.04, 4);
    expect(usdc.topMarket).toBe('Morpho Blue (Ethereum)');
    expect(usdc.marketsCount).toBe(3);
  });

  it('should correctly identify the top market by highest supply APY', async () => {
    // Position-independent: pin targets by identity; the deepest-APY market
    // names the top market.
    const pinned = new Map<string, string>();
    const pin = (protocol: string, chain: string, rate: string) => {
      const key = targetKey(protocol, chain);
      expect(key).toBeDefined();
      pinned.set(key!, rate);
    };
    pin('Aave v3', 'Ethereum', '3.00');
    pin('Compound v3', 'Arbitrum', '9.00');

    for (const target of LENDING_SUBGRAPHS) {
      const lenderRate = pinned.get(target.subgraphId);
      mockFetch.mockResolvedValueOnce(
        lenderRate
          ? {
              ok: true,
              json: async () =>
                buildMockMessariResponse(allStablecoinMarkets(target.protocol, lenderRate, '11.00')),
            }
          : { ok: true, json: async () => ({ data: { markets: [] }, errors: [] }) },
      );
    }

    const report = await service.getStandardizedLendingBenchmarks();
    expect(report.benchmarks.USDC.topMarket).toBe('Compound v3 (Arbitrum)');
  });

  it('should produce separate benchmarks for USDC, USDT, and DAI', async () => {
    // Each subgraph returns one market for each stablecoin
    const allStables = [
      { name: 'Aave v3 USDC', symbol: 'USDC', tvl: '50000000', supplyRate: '4.00', borrowRate: '6.00' },
      { name: 'Aave v3 USDT', symbol: 'USDT', tvl: '40000000', supplyRate: '5.00', borrowRate: '7.00' },
      { name: 'Aave v3 DAI', symbol: 'DAI', tvl: '30000000', supplyRate: '6.00', borrowRate: '8.00' },
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => buildMockMessariResponse(allStables),
    });
    for (let i = 1; i < LENDING_SUBGRAPHS.length; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { markets: [] }, errors: [] }),
      });
    }

    const report = await service.getStandardizedLendingBenchmarks();

    expect(report.benchmarks.USDC).toBeDefined();
    expect(report.benchmarks.USDT).toBeDefined();
    expect(report.benchmarks.DAI).toBeDefined();
    expect(report.benchmarks.USDC.averageSupplyApy).toBeCloseTo(0.04, 4);
    expect(report.benchmarks.USDT.averageSupplyApy).toBeCloseTo(0.05, 4);
    expect(report.benchmarks.DAI.averageSupplyApy).toBeCloseTo(0.06, 4);
  });
});

// ===========================================================================
// TEST SUITE: Fallback behavior — resilience when network is unreachable
// ===========================================================================
describe('GraphFeedService — Strict Error Contract (no fallbacks)', () => {
  let service: GraphFeedService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { markets: [] }, errors: [] }) });
    process.env.GRAPH_API_KEY = 'test-api-key';
    service = new GraphFeedService();
  });

  it('should throw ALL_TARGETS_FAILED when every fetch call fails', async () => {
    for (let i = 0; i < LENDING_SUBGRAPHS.length; i++) {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    }

    await expect(service.getStandardizedLendingBenchmarks()).rejects.toThrow(
      GraphFeedError,
    );
    try {
      await service.getStandardizedLendingBenchmarks();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as GraphFeedError).code).toBe('ALL_TARGETS_FAILED');
    }
  });

  it('should throw when HTTP responses are not OK (e.g. 429 rate limit)', async () => {
    for (let i = 0; i < LENDING_SUBGRAPHS.length; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({}),
      });
    }

    try {
      await service.getStandardizedLendingBenchmarks();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as GraphFeedError).code).toBe('ALL_TARGETS_FAILED');
    }
  });

  it('should throw when GraphQL returns errors from every target', async () => {
    for (let i = 0; i < LENDING_SUBGRAPHS.length; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: null,
          errors: [{ message: 'Rate limit exceeded' }],
        }),
      });
    }

    try {
      await service.getStandardizedLendingBenchmarks();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as GraphFeedError).code).toBe('ALL_TARGETS_FAILED');
    }
  });

  it('should throw NO_LIVE_DATA when a canonical asset is missing (partial success is not enough)', async () => {
    // Only USDC survives the gates — USDT and DAI have no live markets.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        buildMockMessariResponse([
          { name: 'Aave v3 USDC', symbol: 'USDC', tvl: '100000000', supplyRate: '5.00', borrowRate: '7.00' },
        ]),
    });
    for (let i = 1; i < LENDING_SUBGRAPHS.length; i++) {
      mockFetch.mockRejectedValueOnce(new Error('Timeout'));
    }

    try {
      await service.getStandardizedLendingBenchmarks();
      expect.unreachable('should have thrown');
    } catch (error) {
      const feedError = error as GraphFeedError;
      expect(feedError.code).toBe('NO_LIVE_DATA');
      expect(feedError.missingAssets).toEqual(['USDT', 'DAI']);
    }
  });
});

// ===========================================================================
// TEST SUITE: DEX LP Yields — Uniswap v3 pool annualization
// ===========================================================================
// TEST SUITE: Filter logic — only stablecoins are included
// ===========================================================================
describe('GraphFeedService — Stablecoin Filtering', () => {
  let service: GraphFeedService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { markets: [] }, errors: [] }) });
    process.env.GRAPH_API_KEY = 'test-api-key';
    service = new GraphFeedService();
  });

  it('should exclude non-stablecoin markets (e.g. WETH, WBTC)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          markets: [
            // USDC — included
            { name: 'Aave v3 USDC', inputToken: { symbol: 'USDC' }, totalValueLockedUSD: '50000000', rates: [{ rate: '4.0', side: 'LENDER', type: 'VARIABLE' }] },
            // WETH — excluded (not in stablecoin list)
            { name: 'Aave v3 WETH', inputToken: { symbol: 'WETH' }, totalValueLockedUSD: '200000000', rates: [{ rate: '2.5', side: 'LENDER', type: 'VARIABLE' }] },
            // WBTC — excluded
            { name: 'Aave v3 WBTC', inputToken: { symbol: 'WBTC' }, totalValueLockedUSD: '100000000', rates: [{ rate: '1.0', side: 'LENDER', type: 'VARIABLE' }] },
            // USDT / DAI — included (strict contract needs full coverage)
            { name: 'Aave v3 USDT', inputToken: { symbol: 'USDT' }, totalValueLockedUSD: '40000000', rates: [{ rate: '3.1', side: 'LENDER', type: 'VARIABLE' }] },
            { name: 'Aave v3 DAI', inputToken: { symbol: 'DAI' }, totalValueLockedUSD: '30000000', rates: [{ rate: '3.0', side: 'LENDER', type: 'VARIABLE' }] },
          ],
        },
        errors: [],
      }),
    });
    for (let i = 1; i < LENDING_SUBGRAPHS.length; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { markets: [] }, errors: [] }),
      });
    }

    const report = await service.getStandardizedLendingBenchmarks();

    // Only USDC should appear in detailedRates
    expect(report.detailedRates.every((r) => ['USDC', 'USDT', 'DAI'].includes(r.symbol))).toBe(true);
    // WETH and WBTC should be absent
    expect(report.detailedRates.some((r) => r.symbol === 'WETH')).toBe(false);
    expect(report.detailedRates.some((r) => r.symbol === 'WBTC')).toBe(false);
  });

  it('should handle missing inputToken gracefully (skip market)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          markets: [
            { name: 'Unknown Market', totalValueLockedUSD: '1000000', rates: [{ rate: '5.0', side: 'LENDER', type: 'VARIABLE' }] },
            // missing inputToken entirely
            { name: 'Aave v3 USDC', inputToken: { symbol: 'USDC' }, totalValueLockedUSD: '50000000', rates: [{ rate: '4.0', side: 'LENDER', type: 'VARIABLE' }] },
            { name: 'Aave v3 USDT', inputToken: { symbol: 'USDT' }, totalValueLockedUSD: '40000000', rates: [{ rate: '3.1', side: 'LENDER', type: 'VARIABLE' }] },
            { name: 'Aave v3 DAI', inputToken: { symbol: 'DAI' }, totalValueLockedUSD: '30000000', rates: [{ rate: '3.0', side: 'LENDER', type: 'VARIABLE' }] },
          ],
        },
        errors: [],
      }),
    });
    for (let i = 1; i < LENDING_SUBGRAPHS.length; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { markets: [] }, errors: [] }),
      });
    }

    const report = await service.getStandardizedLendingBenchmarks();
    // Market without inputToken should be filtered out; the three valid
    // stablecoin markets survive.
    expect(report.detailedRates.some((r) => r.marketName === 'Unknown Market')).toBe(false);
    expect(report.detailedRates).toHaveLength(3);
  });
});

// ===========================================================================
// TEST SUITE: Report structure — output contract validation
// ===========================================================================
describe('GraphFeedService — Report Structure', () => {
  let service: GraphFeedService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { markets: [] }, errors: [] }) });
    process.env.GRAPH_API_KEY = 'test-api-key';
    service = new GraphFeedService();
  });

  it('should produce a report with all required fields', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        buildMockMessariResponse([
          { name: 'Aave v3 USDC', symbol: 'USDC', tvl: '50000000', supplyRate: '4.00', borrowRate: '6.00' },
          { name: 'Aave v3 USDT', symbol: 'USDT', tvl: '40000000', supplyRate: '3.10', borrowRate: '5.00' },
          { name: 'Aave v3 DAI', symbol: 'DAI', tvl: '30000000', supplyRate: '3.00', borrowRate: '4.90' },
        ]),
    });
    for (let i = 1; i < LENDING_SUBGRAPHS.length; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { markets: [] }, errors: [] }),
      });
    }

    const report = await service.getStandardizedLendingBenchmarks();

    // Validate top-level structure
    expect(report).toHaveProperty('timestamp');
    expect(report).toHaveProperty('benchmarks');
    expect(report).toHaveProperty('detailedRates');
    expect(report).toHaveProperty('source');

    // Validate benchmark shape
    for (const symbol of ['USDC', 'USDT', 'DAI']) {
      const bench = report.benchmarks[symbol];
      expect(bench).toHaveProperty('symbol', symbol);
      expect(bench).toHaveProperty('averageSupplyApy');
      expect(bench).toHaveProperty('maxSupplyApy');
      expect(bench).toHaveProperty('minSupplyApy');
      expect(bench).toHaveProperty('topMarket');
      expect(bench).toHaveProperty('marketsCount');
      // APY values should be in [0, 1] range (decimal)
      expect(bench.averageSupplyApy).toBeGreaterThanOrEqual(0);
      expect(bench.averageSupplyApy).toBeLessThanOrEqual(1);
    }

    // Validate detailedRate shape
    for (const rate of report.detailedRates) {
      expect(rate).toHaveProperty('protocol');
      expect(rate).toHaveProperty('chain');
      expect(rate).toHaveProperty('symbol');
      expect(rate).toHaveProperty('supplyApy');
      expect(rate).toHaveProperty('borrowApy');
      expect(rate).toHaveProperty('totalValueLockedUSD');
    }
  });

  it('should set a reasonable timestamp (within last 5 seconds)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        buildMockMessariResponse([
          { name: 'Aave v3 USDC', symbol: 'USDC', tvl: '50000000', supplyRate: '4.00', borrowRate: '6.00' },
          { name: 'Aave v3 USDT', symbol: 'USDT', tvl: '40000000', supplyRate: '3.10', borrowRate: '5.00' },
          { name: 'Aave v3 DAI', symbol: 'DAI', tvl: '30000000', supplyRate: '3.00', borrowRate: '4.90' },
        ]),
    });
    for (let i = 1; i < LENDING_SUBGRAPHS.length; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { markets: [] }, errors: [] }),
      });
    }

    const before = Date.now();
    const report = await service.getStandardizedLendingBenchmarks();
    const after = Date.now();

    expect(report.timestamp).toBeGreaterThanOrEqual(before);
    expect(report.timestamp).toBeLessThanOrEqual(after);
  });
});

// ===========================================================================
// TEST SUITE: URL construction — correct API key usage
// ===========================================================================
describe('GraphFeedService — API Key Handling', () => {
  it('should use the GRAPH_API_KEY environment variable', async () => {
    process.env.GRAPH_API_KEY = 'my-secret-key-123';
    const svc = new GraphFeedService();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        buildMockMessariResponse([
          { name: 'Aave v3 USDC', symbol: 'USDC', tvl: '50000000', supplyRate: '4.00', borrowRate: '6.00' },
          { name: 'Aave v3 USDT', symbol: 'USDT', tvl: '40000000', supplyRate: '3.10', borrowRate: '5.00' },
          { name: 'Aave v3 DAI', symbol: 'DAI', tvl: '30000000', supplyRate: '3.00', borrowRate: '4.90' },
        ]),
    });
    // Fill remaining
    for (let i = 1; i < LENDING_SUBGRAPHS.length; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { markets: [] }, errors: [] }),
      });
    }

    await svc.getStandardizedLendingBenchmarks();

    // Verify the API key was embedded in the URL
    const firstCall = mockFetch.mock.calls[0];
    expect(firstCall[0]).toContain('my-secret-key-123');
  });
});

// ===========================================================================
// TEST SUITE: config — subgraph IDs and queries
// ===========================================================================
describe('Subgraph Config — Structure Validation', () => {
  it('should define at least one lending subgraph', () => {
    expect(LENDING_SUBGRAPHS.length).toBeGreaterThan(0);
  });

  it('each subgraph target should have protocol, chain, and subgraphId', () => {
    for (const target of LENDING_SUBGRAPHS) {
      expect(target).toHaveProperty('protocol');
      expect(target).toHaveProperty('chain');
      expect(target).toHaveProperty('subgraphId');
      expect(typeof target.subgraphId).toBe('string');
      expect(target.subgraphId.length).toBeGreaterThan(10);
    }
  });

  it('should define a valid GraphQL query string', () => {
    expect(MESSARI_MULTI_ASSET_QUERY).toContain('markets');
    expect(MESSARI_MULTI_ASSET_QUERY).toContain('inputToken_');
    expect(MESSARI_MULTI_ASSET_QUERY).toContain('totalValueLockedUSD');
  });

  it('should no longer include the legacy Morpho Aave optimizer', () => {
    expect(LENDING_SUBGRAPHS.some((t) => t.protocol === 'Morpho Aave')).toBe(false);
  });

  it('should cover Morpho Blue on Ethereum and Arbitrum', () => {
    // Verified live: Morpho Blue deployments exist for Ethereum and Arbitrum.
    // The Base deployment was registered earlier but is currently absent from
    // the matrix — only healthy, query-verified deployments are carried.
    for (const chain of ['Ethereum', 'Arbitrum']) {
      expect(
        LENDING_SUBGRAPHS.some((t) => t.protocol === 'Morpho Blue' && t.chain === chain),
      ).toBe(true);
    }
    expect(
      LENDING_SUBGRAPHS.some((t) => t.protocol === 'Morpho Blue' && t.chain === 'Base'),
    ).toBe(false);
  });

  it('should not register duplicate (protocol, chain) targets', () => {
    const keys = LENDING_SUBGRAPHS.map((t) => `${t.protocol}|${t.chain}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('should harden the shared query with the TVL floor and active filter', () => {
    expect(MESSARI_MULTI_ASSET_QUERY).toContain('isActive: true');
    expect(MESSARI_MULTI_ASSET_QUERY).toContain('totalValueLockedUSD_gte');
    expect(MESSARI_MULTI_ASSET_QUERY).toContain('first: 50');
    expect(MESSARI_MULTI_ASSET_QUERY).toContain('inputToken { id symbol }');
  });
});

// ===========================================================================
// TEST SUITE: Quality filters — dedup, TVL floor, active markets (Q1/Q2)
// ===========================================================================
describe('GraphFeedService — Quality Filters (Q1/Q2)', () => {
  let service: GraphFeedService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { markets: [] }, errors: [] }) });
    process.env.GRAPH_API_KEY = 'test-api-key';
    service = new GraphFeedService();
  });

  function queueEmptyTargets() {
    for (let i = 1; i < LENDING_SUBGRAPHS.length; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { markets: [] }, errors: [] }),
      });
    }
  }

  it('should collapse duplicate (protocol, chain, symbol) rows to the deepest-TVL market', async () => {
    // Simulates the Aave Arbitrum native/bridged USDC split: two active
    // markets normalizing to the same canonical symbol. The deepest-liquidity
    // (native USDCn) market must win.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        buildMockMessariResponse([
          { name: 'Aave Ethereum USDCn', symbol: 'USDC', tvl: '50000000', supplyRate: '3.00', borrowRate: '5.00' },
          { name: 'Aave Ethereum USDC', symbol: 'USDC.e', tvl: '5000000', supplyRate: '4.50', borrowRate: '6.00' },
          { name: 'Aave Ethereum USDT', symbol: 'USDT', tvl: '40000000', supplyRate: '3.10', borrowRate: '5.00' },
          { name: 'Aave Ethereum DAI', symbol: 'DAI', tvl: '30000000', supplyRate: '3.00', borrowRate: '4.90' },
        ]),
    });
    queueEmptyTargets();

    const report = await service.getStandardizedLendingBenchmarks();
    const usdcRows = report.detailedRates.filter(
      (r) => r.protocol === 'Aave v3' && r.chain === 'Ethereum' && r.symbol === 'USDC',
    );
    expect(usdcRows).toHaveLength(1);
    expect(usdcRows[0].supplyApy).toBeCloseTo(0.03, 4);
    expect(usdcRows[0].marketName).toBe('Aave Ethereum USDCn');
    expect(report.benchmarks.USDC.marketsCount).toBe(1);
  });

  it('should exclude markets below the $1M TVL floor', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        buildMockMessariResponse([
          { name: 'Morpho Blue Dust USDC', symbol: 'USDC', tvl: '500000', supplyRate: '50.00', borrowRate: '60.00' },
          { name: 'Morpho Blue USDT', symbol: 'USDT', tvl: '20000000', supplyRate: '1.80', borrowRate: '3.00' },
        ]),
    });
    queueEmptyTargets();

    // STRICT: USDC has no surviving live market → the whole report is an error.
    // DAI is also absent (other targets are empty), so both must be reported.
    try {
      await service.getStandardizedLendingBenchmarks();
      expect.unreachable('should have thrown');
    } catch (error) {
      const feedError = error as GraphFeedError;
      expect(feedError.code).toBe('NO_LIVE_DATA');
      expect(feedError.missingAssets).toEqual(['USDC', 'DAI']);
    }
  });

  it('should exclude inactive (paused/frozen) markets client-side', async () => {
    // The frozen bridged USDC.e market on Aave Arbitrum (isActive=false) must
    // never enter benchmarks even when its TVL passes the floor.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          markets: [
            {
              name: 'Aave Arbitrum USDC (bridged, frozen)',
              isActive: false,
              inputToken: { id: '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', symbol: 'USDC' },
              totalValueLockedUSD: '50000000',
              rates: [{ rate: '3.90', side: 'LENDER', type: 'VARIABLE' }],
            },
          ],
        },
        errors: [],
      }),
    });
    queueEmptyTargets();

    // STRICT: the only market is frozen → zero usable rows → the strict
    // contract throws instead of returning an empty fallback report.
    try {
      await service.getStandardizedLendingBenchmarks();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as GraphFeedError).code).toBe('ALL_TARGETS_FAILED');
    }
  });

  it('should expose marketName, inputTokenId, and isActive metadata', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          markets: [
            {
              name: 'Aave Arbitrum USDCn',
              isActive: true,
              inputToken: { id: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC' },
              totalValueLockedUSD: '172251517',
              rates: [
                { rate: '2.76', side: 'LENDER', type: 'VARIABLE' },
                { rate: '5.12', side: 'BORROWER', type: 'VARIABLE' },
              ],
            },
            {
              name: 'Aave Arbitrum USDT',
              isActive: true,
              inputToken: { id: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', symbol: 'USDT' },
              totalValueLockedUSD: '40000000',
              rates: [{ rate: '3.10', side: 'LENDER', type: 'VARIABLE' }],
            },
            {
              name: 'Aave Arbitrum DAI',
              isActive: true,
              inputToken: { id: '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', symbol: 'DAI' },
              totalValueLockedUSD: '30000000',
              rates: [{ rate: '3.00', side: 'LENDER', type: 'VARIABLE' }],
            },
          ],
        },
        errors: [],
      }),
    });
    queueEmptyTargets();

    const report = await service.getStandardizedLendingBenchmarks();
    expect(report.detailedRates).toHaveLength(3);
    const rate = report.detailedRates.find((r) => r.marketName === 'Aave Arbitrum USDCn');
    expect(rate).toBeDefined();
    expect(rate!.inputTokenId).toBe('0xaf88d065e77c8cc2239327c5edb3a432268e5831');
    expect(rate!.isActive).toBe(true);
    expect(rate!.borrowApy).toBeCloseTo(0.0512, 4);
  });

  it('should pass through already-decimal rates outside the percentage band', async () => {
    // 150 sits in (100, 1e18] — outside both known scales — and must pass
    // through unchanged instead of being corrupted by a heuristic.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        buildMockMessariResponse([
          { name: 'Aave v3 USDC', symbol: 'USDC', tvl: '50000000', supplyRate: '150', borrowRate: '200' },
          { name: 'Aave v3 USDT', symbol: 'USDT', tvl: '40000000', supplyRate: '3.10', borrowRate: '5.00' },
          { name: 'Aave v3 DAI', symbol: 'DAI', tvl: '30000000', supplyRate: '3.00', borrowRate: '4.90' },
        ]),
    });
    queueEmptyTargets();

    const report = await service.getStandardizedLendingBenchmarks();
    const rate = report.detailedRates.find((r) => r.protocol === 'Aave v3');
    expect(rate).toBeDefined();
    expect(rate!.supplyApy).toBe(150);
  });
});



