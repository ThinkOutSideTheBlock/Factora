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
