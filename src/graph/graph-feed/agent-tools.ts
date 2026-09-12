import { graphMcpClient } from './graph-mcp.client.js';
import type {
  RawQueryResult,
  SubgraphSearchResponse,
} from './graph-feed.types.js';

export async function querySubgraph(
  subgraphId: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<RawQueryResult & { isError: boolean; error?: string }> {
  const startedAt = Date.now();
  try {
    const data = await graphMcpClient.queryDynamic(subgraphId, query, variables);
    return {
      subgraphId,
      data,
      errors: [],
      elapsedMs: Date.now() - startedAt,
      isError: false,
    };
  } catch (error) {
    return {
      subgraphId,
      data: null,
      errors: [],
      elapsedMs: Date.now() - startedAt,
      isError: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function searchSubgraphs(
  keyword: string,
): Promise<SubgraphSearchResponse & { isError: boolean; error?: string }> {
  try {
    const raw = await graphMcpClient.searchSubgraphs(keyword);
    const rawResults = Array.isArray(raw?.results)
      ? raw.results
      : Array.isArray(raw?.subgraphs)
        ? raw.subgraphs
        : [];
    return {
      keyword: typeof raw?.keyword === 'string' ? raw.keyword : keyword,
      resultsCount:
        typeof raw?.resultsCount === 'number'
          ? raw.resultsCount
          : typeof raw?.total === 'number'
            ? raw.total
            : rawResults.length,
      results: dedupeBySubgraphId(
        rawResults.map((result) => ({
        subgraphId:
          typeof result?.subgraphId === 'string'
            ? result.subgraphId
            : typeof result?.id === 'string'
              ? result.id
              : '',
        displayName:
          typeof result?.displayName === 'string'
            ? result.displayName
            : typeof result?.metadata?.displayName === 'string'
              ? result.metadata.displayName
              : '',
        currentDeploymentIpfsHash:
          typeof result?.currentDeploymentIpfsHash === 'string'
            ? result.currentDeploymentIpfsHash
            : typeof result?.currentVersion?.subgraphDeployment?.ipfsHash ===
                'string'
              ? result.currentVersion.subgraphDeployment.ipfsHash
            : null,
        })),
      ),
      isError: false,
    };
  } catch (error) {
    return {
      keyword,
      resultsCount: 0,
      results: [],
      isError: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const agentTools = {
  querySubgraph,
  searchSubgraphs,
};

/**
 * Collapse duplicate search hits for the same subgraph (the keyword index can
 * surface the same deployment under multiple protocol aliases). Entries with
 * an empty subgraphId are kept so callers can still see partial metadata.
 */
function dedupeBySubgraphId<T extends { subgraphId: string }>(results: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const result of results) {
    if (result.subgraphId) {
      if (seen.has(result.subgraphId)) continue;
      seen.add(result.subgraphId);
    }
    out.push(result);
  }
  return out;
}

// ===========================================================================
// Function-calling catalog (OpenAI / MCP-compatible JSON Schema definitions)
// ===========================================================================

export interface AgentToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool parameters (OpenAI function-calling compatible). */
  parameters: Record<string, unknown>;
}

/**
 * Structured tool catalog for registering the Factora graph-feed skill with
 * any LLM function-calling host. `get_lending_hurdle_rate` and
 * `get_dex_liquidity_yield` are backed by graphFeedService (Engine A / Engine
 * B); `search_subgraphs` and `query_subgraph` map 1:1 to the exported
 * agentTools functions above. Full contracts: see src/graph/SKILL.md.
 */
export const AGENT_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: 'get_lending_hurdle_rate',
    description:
      'Fetch live stablecoin lending supply APY benchmarks (Aave v3, Compound v3, Morpho Blue on Ethereum/Arbitrum/Base) via the Messari standardized subgraphs. Returns the average/max/min decimal APY plus the deepest live market. All APYs are DECIMAL FRACTIONS: 0.0335 = 3.35%.',
    parameters: {
      type: 'object',
      properties: {
        asset: {
          type: 'string',
          enum: ['USDC', 'USDT', 'DAI'],
          description:
            'Canonical stablecoin symbol to benchmark. Defaults to USDC (the primary underwriting asset).',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_dex_liquidity_yield',
    description:
      "Fetch DEX liquidity opportunity cost: the top Uniswap v3 stablecoin pools (USDC/USDT/DAI) with pool depth (TVL) and an annualized supply-side fee APY estimate. Returns DECIMAL APY fractions (0.0750 = 7.50%). Fallback pools are tagged protocol='Uniswap v3 (Fallback)' when the network is degraded.",
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'search_subgraphs',
    description:
      "Search ~15,000 subgraphs on The Graph's decentralized network by keyword to discover deployment IDs for any protocol or chain. Multi-keyword retry is built in (spaces/hyphens). Returns clean { subgraphId, displayName, currentDeploymentIpfsHash } rows. Never throws.",
    parameters: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description:
            "Search keyword, e.g. 'uniswap v3', 'aave', 'morpho blue'. Separation-insensitive: hyphenated variants are probed automatically.",
        },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'query_subgraph',
    description:
      "Execute arbitrary GraphQL against the latest deployment of any subgraph on The Graph's decentralized network. Validate the schema first (e.g. via a small __type introspection query) — deployments do not all share the Messari markets schema. Never throws.",
    parameters: {
      type: 'object',
      properties: {
        subgraphId: {
          type: 'string',
          description:
            "Subgraph deployment ID from search_subgraphs (e.g. 'FQ6JYszEKApsBpAmiHesRsd9Ygc6mzmpNRANeVQFYoVX').",
        },
        query: {
          type: 'string',
          description:
            'GraphQL query string. Reference pattern: markets(where: { isActive: true, inputToken_: { symbol_in: ["USDC"] } }, first: 10) { name inputToken { id symbol } totalValueLockedUSD rates { rate side type } }',
        },
        variables: {
          type: 'object',
          description: 'Optional GraphQL variables.',
        },
      },
      required: ['subgraphId', 'query'],
    },
  },
];
