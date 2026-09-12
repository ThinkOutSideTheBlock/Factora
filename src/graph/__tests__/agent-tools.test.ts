/**
 * ============================================================================
 * TEST SUITE: Agent Tools — Dynamic MCP Interface
 * ============================================================================
 *
 * Tests for the agent-facing tool layer that wraps GraphMcpClient. These
 * tools give an LLM agent the ability to:
 *   1. Search 15,000+ subgraphs by keyword (discovery step)
 *   2. Query any subgraph with arbitrary GraphQL (data fetch step)
 *
 * Key behaviors tested:
 *   - querySubgraph: passes subgraphId and query to MCP client
 *   - querySubgraph: includes variables when provided
 *   - querySubgraph: returns isError:false on success
 *   - querySubgraph: returns isError:true on MCP failure (never throws)
 *   - querySubgraph: tracks elapsed time
 *   - searchSubgraphs: maps raw MCP results to typed response
 *   - searchSubgraphs: handles null/empty results gracefully
 *   - searchSubgraphs: returns isError:true on MCP failure (never throws)
 *   - agentTools registry: exports both tools as a single object
 *
 * External dependency: graphMcpClient is mocked so no subprocess is spawned.
 *
 * Author: Factora Team
 * ============================================================================
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// MOCK: graphMcpClient
// We mock the MCP client so we can control what it returns (or throws)
// without spawning a real subprocess.
//
// IMPORTANT: vi.mock is hoisted to the top of the file by Vitest, so the
// factory function runs BEFORE variable declarations. We use vi.hoisted()
// to declare the mock functions so they exist when the factory runs.
// ---------------------------------------------------------------------------
const { mockQueryDynamic, mockSearchSubgraphs } = vi.hoisted(() => ({
  mockQueryDynamic: vi.fn(),
  mockSearchSubgraphs: vi.fn(),
}));

vi.mock('../graph-feed/graph-mcp.client.js', () => ({
  graphMcpClient: {
    queryDynamic: mockQueryDynamic,
    searchSubgraphs: mockSearchSubgraphs,
    close: vi.fn(),
  },
}));

// Import AFTER mock so the mock is used by the module under test.
import { querySubgraph, searchSubgraphs, agentTools } from '../graph-feed/agent-tools.js';

// ===========================================================================
// TEST SUITE: querySubgraph
// ===========================================================================
describe('querySubgraph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call graphMcpClient.queryDynamic with correct arguments', async () => {
    mockQueryDynamic.mockResolvedValueOnce({ data: { markets: [] } });

    await querySubgraph('test-subgraph-id', '{ markets { name } }');

    expect(mockQueryDynamic).toHaveBeenCalledWith(
      'test-subgraph-id',
      '{ markets { name } }',
      undefined,
    );
  });

  it('should pass variables when provided', async () => {
    mockQueryDynamic.mockResolvedValueOnce({ data: {} });
    const vars = { first: 10, symbol: 'USDC' };

    await querySubgraph('sub-id', '{ q }', vars);

    expect(mockQueryDynamic).toHaveBeenCalledWith(
      'sub-id',
      '{ q }',
      vars,
    );
  });

  it('should return isError:false with data on success', async () => {
    const mockData = { data: { markets: [{ name: 'Aave v3' }] } };
    mockQueryDynamic.mockResolvedValueOnce(mockData);

    const result = await querySubgraph('sub-id', '{ q }');

    expect(result.isError).toBe(false);
    expect(result.data).toEqual(mockData);
    expect(result.subgraphId).toBe('sub-id');
    expect(result.error).toBeUndefined();
  });

  it('should return isError:true with error message when MCP throws', async () => {
    mockQueryDynamic.mockRejectedValueOnce(new Error('MCP subprocess crashed'));

    const result = await querySubgraph('sub-id', '{ q }');

    expect(result.isError).toBe(true);
    expect(result.error).toBe('MCP subprocess crashed');
    expect(result.data).toBeNull();
    // Should NOT throw — agent tools are fire-and-forget safe
  });

  it('should track elapsed time in milliseconds', async () => {
    // Simulate a 50ms delay
    mockQueryDynamic.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ data: {} }), 50)),
    );

    const result = await querySubgraph('sub-id', '{ q }');

    expect(result.elapsedMs).toBeGreaterThanOrEqual(40);
  });

  it('should handle non-Error thrown values gracefully', async () => {
    mockQueryDynamic.mockRejectedValueOnce('string error');

    const result = await querySubgraph('sub-id', '{ q }');

    expect(result.isError).toBe(true);
    expect(result.error).toBe('string error');
  });
});

// ===========================================================================
// TEST SUITE: searchSubgraphs
// ===========================================================================
describe('searchSubgraphs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call graphMcpClient.searchSubgraphs with keyword', async () => {
    mockSearchSubgraphs.mockResolvedValueOnce({
      keyword: 'aave',
      resultsCount: 2,
      results: [],
    });

    await searchSubgraphs('aave');

    expect(mockSearchSubgraphs).toHaveBeenCalledWith('aave');
  });

  it('should map raw MCP results to typed SubgraphSearchResult[]', async () => {
    mockSearchSubgraphs.mockResolvedValueOnce({
      keyword: 'curve',
      resultsCount: 2,
      results: [
        {
          subgraphId: 'abc123',
          displayName: 'Curve Finance Ethereum',
          currentDeploymentIpfsHash: 'QmHash1',
        },
        {
          subgraphId: 'def456',
          displayName: 'Curve Finance Arbitrum',
          currentDeploymentIpfsHash: null,
        },
      ],
    });

    const result = await searchSubgraphs('curve');

    expect(result.isError).toBe(false);
    expect(result.keyword).toBe('curve');
    expect(result.resultsCount).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({
      subgraphId: 'abc123',
      displayName: 'Curve Finance Ethereum',
      currentDeploymentIpfsHash: 'QmHash1',
    });
    expect(result.results[1]).toEqual({
      subgraphId: 'def456',
      displayName: 'Curve Finance Arbitrum',
      currentDeploymentIpfsHash: null,
    });
  });

  it('should map the current MCP subgraphs response shape', async () => {
    mockSearchSubgraphs.mockResolvedValueOnce({
      returned: 1,
      total: 82,
      subgraphs: [
        {
          id: 'uniswap-v3-id',
          metadata: { displayName: 'Uniswap V3 Ethereum' },
          currentVersion: {
            subgraphDeployment: { ipfsHash: 'QmUniswapHash' },
          },
        },
      ],
    });

    const result = await searchSubgraphs('uniswap v3');

    expect(result.isError).toBe(false);
    expect(result.resultsCount).toBe(82);
    expect(result.results).toEqual([
      {
        subgraphId: 'uniswap-v3-id',
        displayName: 'Uniswap V3 Ethereum',
        currentDeploymentIpfsHash: 'QmUniswapHash',
      },
    ]);
  });

  it('should handle null response (MCP returned nothing)', async () => {
    mockSearchSubgraphs.mockResolvedValueOnce(null);

    const result = await searchSubgraphs('nonexistent');

    expect(result.isError).toBe(false);
    expect(result.resultsCount).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('should handle empty results array', async () => {
    mockSearchSubgraphs.mockResolvedValueOnce({
      keyword: 'nonexistent',
      resultsCount: 0,
      results: [],
    });

    const result = await searchSubgraphs('nonexistent');

    expect(result.isError).toBe(false);
    expect(result.results).toEqual([]);
  });

  it('should return isError:true when MCP throws', async () => {
    mockSearchSubgraphs.mockRejectedValueOnce(new Error('MCP offline'));

    const result = await searchSubgraphs('aave');

    expect(result.isError).toBe(true);
    expect(result.error).toBe('MCP offline');
    expect(result.results).toEqual([]);
    // Should NOT throw
  });

  it('should handle missing fields in raw results gracefully', async () => {
    mockSearchSubgraphs.mockResolvedValueOnce({
      keyword: 'test',
      resultsCount: 1,
      results: [
        {
          // Missing subgraphId and displayName
          someOtherField: 'value',
        },
      ],
    });

    const result = await searchSubgraphs('test');

    expect(result.isError).toBe(false);
    expect(result.results[0].subgraphId).toBe('');
    expect(result.results[0].displayName).toBe('');
    expect(result.results[0].currentDeploymentIpfsHash).toBeNull();
  });
});

// ===========================================================================
// TEST SUITE: agentTools registry
// ===========================================================================
describe('agentTools registry', () => {
  it('should export querySubgraph as a function', () => {
    expect(typeof agentTools.querySubgraph).toBe('function');
  });

  it('should export searchSubgraphs as a function', () => {
    expect(typeof agentTools.searchSubgraphs).toBe('function');
  });

  it('should expose the dynamic yield tool alongside the raw MCP tools', () => {
    const keys = Object.keys(agentTools);
    expect(keys).toHaveLength(3);
    expect(keys).toContain('querySubgraph');
    expect(keys).toContain('searchSubgraphs');
    expect(keys).toContain('getDynamicYieldOpportunities');
  });
});
