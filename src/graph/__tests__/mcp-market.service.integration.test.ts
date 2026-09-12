import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQueryDynamic, mockSearchSubgraphs } = vi.hoisted(() => ({
  mockQueryDynamic: vi.fn(),
  mockSearchSubgraphs: vi.fn(),
}));

vi.mock('../graph-feed/graph-mcp.client.js', () => ({
  graphMcpClient: {
    queryDynamic: mockQueryDynamic,
    searchSubgraphs: mockSearchSubgraphs,
  },
}));

import { McpMarketService } from '../graph-feed/mcp-market.service.js';

const listType = {
  kind: 'NON_NULL',
  name: null,
  ofType: {
    kind: 'LIST',
    name: null,
    ofType: {
      kind: 'NON_NULL',
      name: null,
      ofType: { kind: 'OBJECT', name: 'Market', ofType: null },
    },
  },
};

const scalar = (name: string) => ({
  name,
  type: { kind: 'SCALAR', name: 'String', ofType: null },
});

function marketSchemaResponse() {
  return {
    data: {
      __schema: {
        queryType: {
          fields: [
            { name: 'markets', type: listType },
            { name: 'accounts', type: listType },
          ],
        },
      },
    },
  };
}

function vaultSchemaResponse() {
  return {
    data: {
      __schema: {
        queryType: {
          fields: [{ name: 'vaults', type: listType }],
        },
      },
    },
  };
}

function marketTypeResponse() {
  return {
    data: {
      __type: {
        fields: [
          scalar('id'),
          scalar('name'),
          scalar('totalValueLockedUSD'),
          scalar('isActive'),
          {
            name: 'inputToken',
            type: { kind: 'OBJECT', name: 'Token', ofType: null },
          },
          {
            name: 'rates',
            type: { kind: 'LIST', name: null, ofType: null },
          },
        ],
      },
    },
  };
}

function vaultTypeResponse() {
  return {
    data: {
      __type: {
        fields: [
          scalar('id'),
          scalar('symbol'),
          scalar('totalAssetsUSD'),
          {
            name: 'underlyingToken',
            type: { kind: 'OBJECT', name: 'Token', ofType: null },
          },
          {
            name: 'dailySnapshots',
            type: {
              kind: 'LIST',
              name: null,
              ofType: { kind: 'OBJECT', name: 'DailySnapshot', ofType: null },
            },
          },
        ],
      },
    },
  };
}

function marketRows(subgraphId: string) {
  if (subgraphId === 'aave-v3-id') {
    return {
      data: {
        markets: [
          {
            name: 'Aave V3 Ethereum USDC',
            isActive: true,
            inputToken: { id: '0xusdc', symbol: 'USDC', name: 'USD Coin' },
            totalValueLockedUSD: '50000000',
            rates: [{ rate: '4.00', side: 'LENDER', type: 'VARIABLE' }],
          },
        ],
      },
    };
  }
  return {
    data: {
      markets: [
        {
          name: 'Aave V2 Ethereum DAI',
          isActive: true,
          inputToken: { id: '0xdai', symbol: 'DAI', name: 'DAI' },
          totalValueLockedUSD: '8000000',
          rates: [{ rate: '0.29', side: 'LENDER', type: 'VARIABLE' }],
        },
        {
          name: 'Aave V2 Ethereum WETH',
          isActive: true,
          inputToken: { id: '0xweth', symbol: 'WETH', name: 'WETH' },
          totalValueLockedUSD: '100000000',
          rates: [{ rate: '8.00', side: 'LENDER', type: 'VARIABLE' }],
        },
      ],
    },
  };
}

function vaultRows() {
  return {
    data: {
      vaults: [
        {
          id: 'vault-1',
          symbol: 'USDC',
          underlyingToken: { symbol: 'USDC', name: 'USD Coin' },
          totalAssetsUSD: '25000000',
          dailySnapshots: [
            { timestamp: '1700000000', sharePrice: '1.0000' },
            { timestamp: '1725920000', sharePrice: '1.0250' },
          ],
        },
      ],
    },
  };
}

function nestedTypeResponse(typeName: string) {
  if (typeName === 'DailySnapshot') {
    return {
      data: {
        __type: {
          fields: [
            scalar('timestamp'),
            scalar('sharePrice'),
          ],
        },
      },
    };
  }
  return {
    data: {
      __type: {
        fields: [scalar('id'), scalar('symbol'), scalar('name')],
      },
    },
  };
}

describe('McpMarketService integration contract', () => {
  let service: McpMarketService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new McpMarketService();
    mockSearchSubgraphs.mockResolvedValue({
      results: [
        { id: 'aave-v3-id', metadata: { displayName: 'Aave V3 Ethereum' } },
        { id: 'aave-v2-id', metadata: { displayName: 'Aave V2 Ethereum' } },
        { id: 'aave-v3-id', metadata: { displayName: 'Duplicate Aave V3' } },
        { id: 'broken-id', metadata: { displayName: 'Broken Deployment' } },
      ],
      total: 4,
    });
    mockQueryDynamic.mockImplementation(async (
      subgraphId: string,
      query: string,
      variables?: Record<string, unknown>,
    ) => {
      if (subgraphId === 'broken-id') {
        throw new Error('subgraph unavailable');
      }
      if (subgraphId === 'vault-id' && query.includes('__schema')) return vaultSchemaResponse();
      if (subgraphId === 'vault-id' && query.includes('__type')) {
        const typeName = variables?.typeName;
        return typeName ? nestedTypeResponse(String(typeName)) : vaultTypeResponse();
      }
      if (subgraphId === 'vault-id') return vaultRows();
      if (query.includes('__schema')) return marketSchemaResponse();
      if (query.includes('__type')) return marketTypeResponse();
      return marketRows(subgraphId);
    });
  });

  it('discovers schema, queries markets, normalizes APY, and excludes Engine A duplicates', async () => {
    const opportunities = await service.getDynamicYieldOpportunities({
      riskProfile: 'low',
      protocolKeywords: ['aave'],
      minTvlUsd: 1_000_000,
      excludeMarkets: [
        { protocol: 'Aave v3', chain: 'Ethereum', symbol: 'USDC' },
      ],
    });

    expect(opportunities).toEqual([
      expect.objectContaining({
        protocol: 'Aave V2 Ethereum',
        chain: 'Ethereum',
        symbol: 'DAI',
        supplyApy: 0.0029,
        totalValueLockedUSD: 8_000_000,
        category: 'lending',
        tier: 'emerging',
        deploymentId: 'aave-v2-id',
      }),
    ]);
    expect(opportunities.some((item) => item.symbol === 'USDC')).toBe(false);
    expect(opportunities.some((item) => item.symbol === 'WETH')).toBe(false);
    expect(mockSearchSubgraphs).toHaveBeenCalledWith('aave');
    expect(mockQueryDynamic).toHaveBeenCalledWith(
      'aave-v3-id',
      expect.stringContaining('markets(first: 100)'),
    );
    expect(mockQueryDynamic).toHaveBeenCalledWith(
      'aave-v3-id',
      expect.stringContaining('__type'),
      { typeName: 'Market' },
    );
  });

  it('isolates broken deployments and returns an empty array when discovery fails', async () => {
    mockSearchSubgraphs.mockResolvedValueOnce({
      results: [{ id: 'broken-id', metadata: { displayName: 'Broken' } }],
    });

    await expect(
      service.getDynamicYieldOpportunities({
        riskProfile: 'low',
        protocolKeywords: ['broken'],
      }),
    ).resolves.toEqual([]);

    mockSearchSubgraphs.mockRejectedValueOnce(new Error('MCP offline'));
    await expect(
      service.getDynamicYieldOpportunities({
        riskProfile: 'low',
        protocolKeywords: ['offline'],
      }),
    ).resolves.toEqual([]);
  });

  it('derives APY from stablecoin vault share-price snapshots', async () => {
    mockSearchSubgraphs.mockResolvedValueOnce({
      results: [{ id: 'vault-id', metadata: { displayName: 'Stablecoin Vault Ethereum' } }],
    });

    const opportunities = await service.getDynamicYieldOpportunities({
      riskProfile: 'mid',
      protocolKeywords: ['stablecoin vault'],
      minTvlUsd: 1_000_000,
    });

    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]).toMatchObject({
      symbol: 'USDC',
      category: 'vault',
      apyMethod: 'share-price-growth',
      confidence: 'high',
      riskClass: 'vault',
    });
    expect(opportunities[0].supplyApy).toBeGreaterThan(0.01);
  });
});
