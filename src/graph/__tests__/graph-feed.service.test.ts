import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphFeedService } from '../graph-feed/graph-feed.service.js';
import { GraphFeedError } from '../graph-feed/graph-feed.types.js';
import {
  LENDING_SUBGRAPHS,
  MESSARI_MULTI_ASSET_QUERY,
  MIN_TVL_USD,
} from '../graph-feed/subgraphs.config.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

type MarketInput = {
  name: string;
  symbol: string;
  tvl: string;
  supplyRate: string;
  borrowRate?: string;
  isActive?: boolean;
  inputTokenId?: string;
  omitRates?: boolean;
};

type TargetResponse =
  | { kind: 'empty' }
  | { kind: 'reject'; message?: string }
  | { kind: 'http-error'; status?: number }
  | { kind: 'graphql-error'; message?: string }
  | { kind: 'markets'; markets: MarketInput[] };

function targetId(protocol: string, chain: string): string {
  const target = LENDING_SUBGRAPHS.find(
    (candidate) => candidate.protocol === protocol && candidate.chain === chain,
  );
  if (!target) throw new Error(`Unknown target ${protocol}|${chain}`);
  return target.subgraphId;
}

function messariResponse(markets: MarketInput[]) {
  return {
    data: {
      markets: markets.map((market) => ({
        name: market.name,
        isActive: market.isActive ?? true,
        inputToken: {
          ...(market.inputTokenId ? { id: market.inputTokenId } : {}),
          symbol: market.symbol,
        },
        totalValueLockedUSD: market.tvl,
        rates: market.omitRates
          ? []
          : [
              { rate: market.supplyRate, side: 'LENDER', type: 'VARIABLE' },
              {
                rate: market.borrowRate ?? '0',
                side: 'BORROWER',
                type: 'VARIABLE',
              },
            ],
      })),
    },
    errors: [],
  };
}

function mockFetchByTarget(
  responses: Partial<Record<string, TargetResponse>>,
): void {
  mockFetch.mockImplementation(async (input: unknown) => {
    const url = String(input);
    const target = LENDING_SUBGRAPHS.find((candidate) =>
      url.includes(candidate.subgraphId),
    );
    const response =
      (target && responses[`${target.protocol}|${target.chain}`]) ??
      responses.DEFAULT ??
      { kind: 'empty' };

    if (response.kind === 'reject') {
      throw new Error(response.message ?? 'simulated network failure');
    }
    if (response.kind === 'http-error') {
      return { ok: false, status: response.status ?? 500, json: async () => ({}) };
    }
    if (response.kind === 'graphql-error') {
      return {
        ok: true,
        json: async () => ({
          data: null,
          errors: [{ message: response.message ?? 'GraphQL error' }],
        }),
      };
    }
    return {
      ok: true,
      json: async () =>
        response.kind === 'markets'
          ? messariResponse(response.markets)
          : { data: { markets: [] }, errors: [] },
    };
  });
}

function stablecoins(prefix: string, rate: string): MarketInput[] {
  return [
    { name: `${prefix} USDC`, symbol: 'USDC', tvl: '50000000', supplyRate: rate, borrowRate: '6.00' },
    { name: `${prefix} USDT`, symbol: 'USDT', tvl: '40000000', supplyRate: rate, borrowRate: '6.00' },
    { name: `${prefix} DAI`, symbol: 'DAI', tvl: '30000000', supplyRate: rate, borrowRate: '6.00' },
  ];
}

describe('GraphFeedService', () => {
  let service: GraphFeedService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    process.env.GRAPH_API_KEY = 'test-api-key';
    service = new GraphFeedService();
  });

  it('normalizes percentage and Ray-scale rates', async () => {
    mockFetchByTarget({
      'Aave v3|Ethereum': {
        kind: 'markets',
        markets: stablecoins('Aave', '3.63'),
      },
      'Morpho Blue|Ethereum': {
        kind: 'markets',
        markets: stablecoins('Morpho', String(8e25)),
      },
    });

    const report = await service.getStandardizedLendingBenchmarks();
    expect(report.benchmarks.USDC).toBeDefined();
    expect(report.detailedRates.some((rate) => rate.supplyApy === 0.0363)).toBe(true);
    expect(report.detailedRates.some((rate) => rate.supplyApy === 0.08)).toBe(true);
  });

  it('maps bridged and Spark DAI symbols to canonical assets', async () => {
    mockFetchByTarget({
      'Aave v3|Ethereum': {
        kind: 'markets',
        markets: [
          { name: 'Aave USDC.e', symbol: 'USDC.e', tvl: '50000000', supplyRate: '3.00' },
          { name: 'Aave USDT', symbol: 'USDT', tvl: '40000000', supplyRate: '3.00' },
          { name: 'Aave DAI', symbol: 'DAI', tvl: '30000000', supplyRate: '3.00' },
        ],
      },
      'Spark|Ethereum': {
        kind: 'markets',
        markets: [
          { name: 'Spark DAI', symbol: 'DAI', tvl: '25000000', supplyRate: '4.00', isActive: false },
          { name: 'Spark USDC', symbol: 'USDC', tvl: '25000000', supplyRate: '4.00' },
          { name: 'Spark USDT', symbol: 'USDT', tvl: '25000000', supplyRate: '4.00' },
        ],
      },
    });

    const report = await service.getStandardizedLendingBenchmarks();
    expect(report.detailedRates.some((rate) => rate.symbol === 'USDC')).toBe(true);
    expect(report.detailedRates.some((rate) => rate.protocol === 'Spark' && rate.symbol === 'DAI')).toBe(true);
    expect(report.benchmarks.DAI.marketsCount).toBe(2);
  });

  it('aggregates and deduplicates each canonical asset by deepest TVL', async () => {
    mockFetchByTarget({
      'Aave v3|Ethereum': {
        kind: 'markets',
        markets: [
          { name: 'shallow USDC', symbol: 'USDC.e', tvl: '2000000', supplyRate: '9.00' },
          { name: 'deep USDC', symbol: 'USDC', tvl: '50000000', supplyRate: '4.00' },
          { name: 'Aave USDT', symbol: 'USDT', tvl: '40000000', supplyRate: '3.00' },
          { name: 'Aave DAI', symbol: 'DAI', tvl: '30000000', supplyRate: '2.00' },
        ],
      },
      'Compound v3|Ethereum': {
        kind: 'markets',
        markets: stablecoins('Compound', '6.00'),
      },
    });

    const report = await service.getStandardizedLendingBenchmarks();
    const usdc = report.detailedRates.filter((rate) => rate.symbol === 'USDC');
    expect(usdc).toHaveLength(2);
    expect(usdc.find((rate) => rate.protocol === 'Aave v3')?.supplyApy).toBe(0.04);
    expect(report.benchmarks.USDC.averageSupplyApy).toBeCloseTo(0.05, 4);
    expect(report.benchmarks.USDC.topMarket).toBe('Compound v3 (Ethereum)');
  });

  it('filters non-stablecoins, inactive markets, and sub-million TVL', async () => {
    mockFetchByTarget({
      'Aave v3|Ethereum': {
        kind: 'markets',
        markets: [
          { name: 'WETH', symbol: 'WETH', tvl: '100000000', supplyRate: '8.00' },
          { name: 'Frozen USDC', symbol: 'USDC', tvl: '50000000', supplyRate: '8.00', isActive: false },
          { name: 'Dust USDC', symbol: 'USDC', tvl: '500000', supplyRate: '8.00' },
        ],
      },
    });

    await expect(service.getStandardizedLendingBenchmarks()).rejects.toMatchObject({
      code: 'ALL_TARGETS_FAILED',
    });
    expect(MIN_TVL_USD).toBe(1_000_000);
  });

  it('reports missing canonical assets without fabricating fallbacks', async () => {
    mockFetchByTarget({
      'Aave v3|Ethereum': {
        kind: 'markets',
        markets: [{ name: 'USDC only', symbol: 'USDC', tvl: '50000000', supplyRate: '5.00' }],
      },
    });

    await expect(service.getStandardizedLendingBenchmarks()).rejects.toSatisfy((error) => {
      return error instanceof GraphFeedError &&
        error.code === 'NO_LIVE_DATA' &&
        JSON.stringify(error.missingAssets) === JSON.stringify(['USDT', 'DAI']);
    });
  });

  it('returns ALL_TARGETS_FAILED for HTTP, GraphQL, and network failures', async () => {
    mockFetchByTarget({ DEFAULT: { kind: 'reject', message: 'ECONNREFUSED' } });
    await expect(service.getStandardizedLendingBenchmarks()).rejects.toMatchObject({
      code: 'ALL_TARGETS_FAILED',
    });

    mockFetchByTarget({ DEFAULT: { kind: 'http-error', status: 429 } });
    await expect(service.getStandardizedLendingBenchmarks()).rejects.toMatchObject({
      code: 'ALL_TARGETS_FAILED',
    });

    mockFetchByTarget({ DEFAULT: { kind: 'graphql-error', message: 'rate limited' } });
    await expect(service.getStandardizedLendingBenchmarks()).rejects.toMatchObject({
      code: 'ALL_TARGETS_FAILED',
    });
  });

  it('preserves metadata and uses the configured API key', async () => {
    process.env.GRAPH_API_KEY = 'key-for-test';
    service = new GraphFeedService();
    mockFetchByTarget({
      'Aave v3|Arbitrum': {
        kind: 'markets',
        markets: [
          { name: 'USDCn', symbol: 'USDC', inputTokenId: '0xaf88', tvl: '50000000', supplyRate: '2.76', borrowRate: '5.12' },
          { name: 'USDT', symbol: 'USDT', tvl: '40000000', supplyRate: '3.10' },
          { name: 'DAI', symbol: 'DAI', tvl: '30000000', supplyRate: '3.00' },
        ],
      },
    });

    const report = await service.getStandardizedLendingBenchmarks();
    const rate = report.detailedRates.find((item) => item.marketName === 'USDCn');
    expect(rate?.inputTokenId).toBe('0xaf88');
    expect(rate?.borrowApy).toBeCloseTo(0.0512, 4);
    expect(mockFetch.mock.calls[0][0]).toContain('key-for-test');
  });

  it('keeps the shared query constrained to the three stablecoins', () => {
    expect(MESSARI_MULTI_ASSET_QUERY).toContain('USDC');
    expect(MESSARI_MULTI_ASSET_QUERY).toContain('USDT');
    expect(MESSARI_MULTI_ASSET_QUERY).toContain('DAI');
    expect(MESSARI_MULTI_ASSET_QUERY).not.toContain('WETH');
    expect(LENDING_SUBGRAPHS.some((target) => target.protocol === 'Spark')).toBe(true);
  });
});
