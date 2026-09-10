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
    const results = Array.isArray(raw?.results) ? raw.results : [];
    return {
      keyword: typeof raw?.keyword === 'string' ? raw.keyword : keyword,
      resultsCount:
        typeof raw?.resultsCount === 'number' ? raw.resultsCount : results.length,
      results: results.map((result) => ({
        subgraphId:
          typeof result?.subgraphId === 'string' ? result.subgraphId : '',
        displayName:
          typeof result?.displayName === 'string' ? result.displayName : '',
        currentDeploymentIpfsHash:
          typeof result?.currentDeploymentIpfsHash === 'string'
            ? result.currentDeploymentIpfsHash
            : null,
      })),
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