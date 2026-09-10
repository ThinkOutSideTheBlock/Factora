/**
 * ============================================================================
 * TEST SUITE: GraphFeedService
 * ============================================================================
 *
 * This file tests the core data-fetching service of the Factora graph-feed
 * module. The service is responsible for:
 *
 * 1. Fetching live lending yields from Aave v3, Compound v3, and Morpho via
 *    The Graph's Messari-standardized subgraphs.
 * 2. Normalizing raw rate values (Ray-scale 1e27 → decimal, percentage → decimal).
 * 3. Aggregating per-asset benchmarks (average, min, max APY).
 * 4. Providing deterministic fallback baselines when the network is unreachable.
 *
 * External dependencies (fetch, MCP client) are mocked to isolate business
 * logic. Tests focus on correctness of:
 * - Rate normalization math
 * - Benchmark aggregation (average, min, max, top market selection)
 * - Fallback behavior when all sources fail
 * - Edge cases: empty data, malformed rates, zero TVL
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

// ---------------------------------------------------------------------------
// MOCK: graphMcpClient
// The DEX LP method delegates to the MCP singleton. We mock it to return
// controlled data (or throw) so we can test the service's fallback logic
// in isolation.
// ---------------------------------------------------------------------------
vi.mock('../graph-feed/graph-mcp.client.js', () => ({
  graphMcpClient: {
    queryDynamic: vi.fn(),
    close: vi.fn(),
  },
}));

import { graphMcpClient } from '../graph-feed/graph-mcp.client.js';
const mockQueryDynamic = vi.mocked(graphMcpClient.queryDynamic);

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
    // Arrange: simulate a single Aave v3 Ethereum market returning 3.63% APY
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        buildMockMessariResponse([
          { name: 'Aave v3 USDC', symbol: 'USDC', tvl: '50000000', supplyRate: '3.63', borrowRate: '5.12' },
        ]),
    });
    // Fill remaining subgraph slots with empty responses
    for (let i = 1; i < LENDING_SUBGRAPHS.length; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { markets: [] }, errors: [] }),
      });
    }

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
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        buildMockMessariResponse([
          { name: 'Aave USDC.e', symbol: 'USDC.e', tvl: '50000000', supplyRate: '3.63', borrowRate: '5.12' },
        ]),
    });
    for (let i = 1; i < LENDING_SUBGRAPHS.length; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { markets: [] }, errors: [] }),
      });
    }

    const report = await service.getStandardizedLendingBenchmarks();

    expect(report.detailedRates[0].symbol).toBe('USDC');
    expect(report.benchmarks.USDC.averageSupplyApy).toBeCloseTo(0.0363, 4);
  });

  it('should normalize Ray-scale rates (e.g. 3.63e25 → 0.0363)', async () => {
    // LENDING_SUBGRAPHS (5 active entries):
    //   [0] Aave v3 Ethereum, [1] Aave v3 Arbitrum,
    //   [2] Compound v3 Ethereum, [3] Compound v3 Arbitrum,
    //   [4] Morpho Aave Ethereum
    // Morpho Aave is at index 4. Mock indices 0-3 with empty, index 4 with Ray-scale data.
    for (let i = 0; i < 4; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { markets: [] }, errors: [] }),
      });
    }
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        buildMockMessariResponse([
          { name: 'Morpho Aave USDC', symbol: 'USDC', tvl: '20000000', supplyRate: String(3.63e25), borrowRate: String(5.12e25) },
        ]),
    });

    const report = await service.getStandardizedLendingBenchmarks();
    const rate = report.detailedRates.find((r) => r.protocol === 'Morpho Aave');

    expect(rate).toBeDefined();
    expect(rate!.supplyApy).toBeCloseTo(0.0363, 4);
  });

  it('should skip non-finite rate values (NaN, Infinity)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        buildMockMessariResponse([
          { name: 'Aave v3 USDC', symbol: 'USDC', tvl: '50000000', supplyRate: 'not-a-number', borrowRate: 'NaN' },
        ]),
    });
    for (let i = 1; i < LENDING_SUBGRAPHS.length; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { markets: [] }, errors: [] }),
      });
    }

    const report = await service.getStandardizedLendingBenchmarks();
    const rate = report.detailedRates.find((r) => r.protocol === 'Aave v3' && r.chain === 'Ethereum');

    // Both rates should default to 0 since parsing failed
    expect(rate!.supplyApy).toBe(0);
    expect(rate!.borrowApy).toBe(0);
  });

  it('should skip markets with no rates array', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          markets: [
            {
              name: 'Empty Market',
              inputToken: { symbol: 'USDC' },
              totalValueLockedUSD: '1000000',
              rates: [], // empty rates
            },
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
    // Market with empty rates should be excluded entirely
    expect(report.detailedRates.length).toBe(0);
  });

  it('should skip non-VARIABLE rate types (e.g. FIXED)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          markets: [
            {
              name: 'Aave v3 USDC',
              inputToken: { symbol: 'USDC' },
              totalValueLockedUSD: '50000000',
              rates: [
                { rate: '3.63', side: 'LENDER', type: 'FIXED' }, // skipped
                { rate: '5.00', side: 'LENDER', type: 'VARIABLE' }, // picked up
              ],
            },
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
    // LENDING_SUBGRAPHS (5 active entries):
    //   [0] Aave v3 Ethereum, [1] Aave v3 Arbitrum,
    //   [2] Compound v3 Ethereum, [3] Compound v3 Arbitrum,
    //   [4] Morpho Aave Ethereum
    // Index 0: Aave v3 Ethereum — 4%
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        buildMockMessariResponse([
          { name: 'Aave v3 USDC', symbol: 'USDC', tvl: '100000000', supplyRate: '4.00', borrowRate: '6.00' },
        ]),
    });
    // Index 1: Aave v3 Arbitrum — empty
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { markets: [] }, errors: [] }),
    });
    // Index 2: Compound v3 Ethereum — 6%
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        buildMockMessariResponse([
          { name: 'Compound v3 USDC', symbol: 'USDC', tvl: '80000000', supplyRate: '6.00', borrowRate: '8.00' },
        ]),
    });
    // Index 3: Compound v3 Arbitrum — empty
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { markets: [] }, errors: [] }),
    });
    // Index 4: Morpho Aave Ethereum — 8%
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        buildMockMessariResponse([
          { name: 'Morpho Aave USDC', symbol: 'USDC', tvl: '50000000', supplyRate: '8.00', borrowRate: '10.00' },
        ]),
    });

    const report = await service.getStandardizedLendingBenchmarks();
    const usdc = report.benchmarks.USDC;

    expect(usdc.averageSupplyApy).toBeCloseTo(0.06, 4);
    expect(usdc.maxSupplyApy).toBeCloseTo(0.08, 4);
    expect(usdc.minSupplyApy).toBeCloseTo(0.04, 4);
    expect(usdc.topMarket).toBe('Morpho Aave (Ethereum)');
    expect(usdc.marketsCount).toBe(3);
  });

  it('should correctly identify the top market by highest supply APY', async () => {
    // LENDING_SUBGRAPHS (5 active entries):
    //   [0] Aave v3 Ethereum, [1] Aave v3 Arbitrum,
    //   [2] Compound v3 Ethereum, [3] Compound v3 Arbitrum,
    //   [4] Morpho Aave Ethereum
    // Index 0: Aave v3 Ethereum — 3%
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        buildMockMessariResponse([
          { name: 'Aave v3 USDC', symbol: 'USDC', tvl: '100000000', supplyRate: '3.00', borrowRate: '5.00' },
        ]),
    });
    // Index 1: Aave v3 Arbitrum — empty
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { markets: [] }, errors: [] }),
    });
    // Index 2: Compound v3 Ethereum — empty
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { markets: [] }, errors: [] }),
    });
    // Index 3: Compound v3 Arbitrum — 9%
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        buildMockMessariResponse([
          { name: 'Compound v3 USDC', symbol: 'USDC', tvl: '80000000', supplyRate: '9.00', borrowRate: '11.00' },
        ]),
    });
    // Index 4: Morpho Aave Ethereum — empty
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { markets: [] }, errors: [] }),
    });

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
describe('GraphFeedService — Fallback Resilience', () => {
  let service: GraphFeedService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { markets: [] }, errors: [] }) });
    process.env.GRAPH_API_KEY = 'test-api-key';
    service = new GraphFeedService();
  });

  it('should return deterministic fallback report when all fetch calls fail', async () => {
    // Arrange: every subgraph fetch throws a network error
    for (let i = 0; i < LENDING_SUBGRAPHS.length; i++) {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    }

    const report = await service.getStandardizedLendingBenchmarks();

    // The fallback report should contain valid benchmarks for all 3 assets
    expect(report.benchmarks.USDC).toBeDefined();
    expect(report.benchmarks.USDT).toBeDefined();
    expect(report.benchmarks.DAI).toBeDefined();
    // Fallback source label should indicate it's a baseline
    expect(report.source).toContain('Fallback');
    // No live rates in fallback mode
    expect(report.detailedRates).toHaveLength(0);
    // Timestamp should be present
    expect(report.timestamp).toBeGreaterThan(0);
  });

  it('should return fallback when HTTP response is not OK (e.g. 429 rate limit)', async () => {
    // Simulate rate limiting on all subgraphs
    for (let i = 0; i < LENDING_SUBGRAPHS.length; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({}),
      });
    }

    const report = await service.getStandardizedLendingBenchmarks();
    expect(report.source).toContain('Fallback');
  });

  it('should return fallback when GraphQL returns errors', async () => {
    for (let i = 0; i < LENDING_SUBGRAPHS.length; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: null,
          errors: [{ message: 'Rate limit exceeded' }],
        }),
      });
    }

    const report = await service.getStandardizedLendingBenchmarks();
    expect(report.source).toContain('Fallback');
  });

  it('should still produce a report if only some subgraphs fail (partial success)', async () => {
    // First subgraph succeeds, rest fail
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

    const report = await service.getStandardizedLendingBenchmarks();

    // Should NOT use fallback — we got at least one live rate
    expect(report.source).toContain('The Graph');
    expect(report.detailedRates.length).toBeGreaterThan(0);
    expect(report.benchmarks.USDC.marketsCount).toBe(1);
    expect(report.benchmarks.USDC.averageSupplyApy).toBeCloseTo(0.05, 4);
    expect(report.benchmarks.USDT.averageSupplyApy).toBeCloseTo(0.051, 4);
    expect(report.benchmarks.DAI.averageSupplyApy).toBeCloseTo(0.062, 4);
  });
});

// ===========================================================================
// TEST SUITE: DEX LP Yields — Uniswap v3 pool annualization
// ===========================================================================
describe('GraphFeedService — DEX LP Yield Calculation', () => {
  let service: GraphFeedService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { markets: [] }, errors: [] }) });
    process.env.GRAPH_API_KEY = 'test-api-key';
    service = new GraphFeedService();
  });

  it('should annualize hourly fee revenue into estimated APY', async () => {
    // Arrange: a pool with 0.3% fee, $100 hourly revenue, $1M TVL
    // Over 24 hours: totalRevenue = 24 * 100 = $2400
    // Annualized: (2400 / 24) * 24 * 365 / 1_000_000 = 0.8760
    mockQueryDynamic.mockResolvedValueOnce(
      buildMockUniswapResponse([
        {
          name: 'USDC/USDT 0.3%',
          symbols: ['USDC', 'USDT'],
          feePercentage: '0.3',
          tvl: '1000000',
          hourlySnapshots: Array.from({ length: 24 }, (_, i) => ({
            revenue: '100',
            tvl: '1000000',
          })),
        },
      ]),
    );

    const pools = await service.getDEXLiquidityYield();

    expect(pools.length).toBe(1);
    expect(pools[0].protocol).toBe('Uniswap v3');
    expect(pools[0].pair).toBe('USDC/USDT (0.3%)');
    // (100/1) * 24 * 365 / 1_000_000 = 0.8760
    expect(pools[0].estimatedApy).toBeCloseTo(0.8760, 3);
    expect(pools[0].tvlUSD).toBe(1000000);
  });

  it('should skip pools with fewer than 2 hourly snapshots (insufficient data)', async () => {
    mockQueryDynamic.mockResolvedValueOnce(
      buildMockUniswapResponse([
        {
          name: 'USDC/USDT',
          symbols: ['USDC', 'USDT'],
          feePercentage: '0.01',
          tvl: '50000000',
          hourlySnapshots: [
            { revenue: '10', tvl: '50000000' },
            // only 1 snapshot → below threshold of 2
          ],
        },
      ]),
    );

    const pools = await service.getDEXLiquidityYield();

    // Pool with insufficient snapshots should be skipped
    // Falls back to static fallback pools
    expect(pools.length).toBeGreaterThan(0);
    expect(pools[0].protocol).toContain('Fallback');
  });

  it('should skip pools with zero TVL (division by zero protection)', async () => {
    mockQueryDynamic.mockResolvedValueOnce(
      buildMockUniswapResponse([
        {
          name: 'Dead Pool',
          symbols: ['USDC', 'USDT'],
          feePercentage: '0.01',
          tvl: '0',
          hourlySnapshots: [
            { revenue: '0', tvl: '0' },
            { revenue: '0', tvl: '0' },
          ],
        },
      ]),
    );

    const pools = await service.getDEXLiquidityYield();

    // Zero-TVL pool should be excluded
    expect(pools.every((p) => p.tvlUSD > 0)).toBe(true);
  });

  it('should return fallback LP pools when MCP client throws', async () => {
    mockQueryDynamic.mockRejectedValueOnce(new Error('MCP subprocess crashed'));

    const pools = await service.getDEXLiquidityYield();

    expect(pools.length).toBe(2);
    expect(pools[0].protocol).toContain('Fallback');
    expect(pools[1].protocol).toContain('Fallback');
  });

  it('should return fallback when MCP returns null/empty data', async () => {
    mockQueryDynamic.mockResolvedValueOnce(null);

    const pools = await service.getDEXLiquidityYield();

    expect(pools.length).toBeGreaterThan(0);
    expect(pools[0].protocol).toContain('Fallback');
  });
});

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
    // Market without inputToken should be filtered out
    expect(report.detailedRates.length).toBe(0);
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
      json: async () => ({ data: { markets: [] }, errors: [] }),
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
});
