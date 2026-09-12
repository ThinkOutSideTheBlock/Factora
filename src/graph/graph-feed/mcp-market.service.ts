import { graphMcpClient } from './graph-mcp.client.js';
import { MESSARI_MULTI_ASSET_QUERY } from './subgraphs.config.js';
import {
  DynamicYieldQuery,
  DynamicYieldOpportunity,
  GraphFeedError,
  RISK_PROFILE_TVLS,
  SupportedChain,
} from './graph-feed.types.js';

interface DiscoveredCandidate {
  subgraphId: string;
  displayName: string;
}

interface DynamicMessariMarket {
  name: string | null;
  isActive?: boolean;
  inputToken?: { id?: string; symbol: string };
  totalValueLockedUSD: string;
  rates?: Array<{ rate: string; side: string; type: string }>;
}

const ASSET_ALIASES: Record<string, string> = {
  USDC: 'USDC',
  'USDC.E': 'USDC',
  USDBC: 'USDC',
  USDCN: 'USDC',
  USDT: 'USDT',
  DAI: 'DAI',
};

/** A candidate deployment must expose this Messari `Market` shape to be used. */
const REQUIRED_MARKET_FIELDS = [
  'rates',
  'inputToken',
  'totalValueLockedUSD',
  'isActive',
];

const MARKET_SCHEMA_CHECK_QUERY = `
  query MarketSchemaCheck {
    __type(name: "Market") {
      fields {
        name
      }
    }
  }
`;

/** Cap on deployments probed per discovery run (schema validation is not free). */
const MAX_CANDIDATES_PROBED = 8;

const MCP_SOURCE_TAG = 'The Graph Subgraph MCP (dynamic discovery)';

/**
 * Fully dynamic Engine B over the Subgraph MCP.
 *
 * There are NO pinned protocol names, deployment IDs, or queries in this
 * path: candidates are discovered at runtime from generic category keywords
 * only, every deployment is schema-validated against the Messari `Market`
 * shape before use, and every returned opportunity carries its exact
 * provenance (`deploymentId`). Nothing usable discovered → `GraphFeedError`
 * (never a fabricated value).
 */
export class McpMarketService {
  async getDynamicYieldOpportunities(
    query: DynamicYieldQuery,
  ): Promise<DynamicYieldOpportunity[]> {
    const floorUsd =
      query.minTvlUsd ?? RISK_PROFILE_TVLS[query.riskProfile];
    const tierThresholdUsd = floorUsd * 10;
    const keywords =
      query.protocolKeywords && query.protocolKeywords.length > 0
        ? query.protocolKeywords
        : ['lending'];
    const limit = query.limit ?? 20;

    const candidates = await this.discoverCandidates(keywords);
    if (candidates.length === 0) {
      throw new GraphFeedError(
        'MCP_UNAVAILABLE',
        `dynamic MCP discovery found no deployments for keywords [${keywords.join(', ')}] — refusing to fabricate opportunities`,
      );
    }

    const candidateErrors: { target: string; error: string }[] = [];
    const opportunities: DynamicYieldOpportunity[] = [];
    const timestamp = Date.now();

    for (const candidate of candidates.slice(0, MAX_CANDIDATES_PROBED)) {
      try {
        const schemaOk = await this.validateMarketSchema(candidate.subgraphId);
        if (!schemaOk) {
          candidateErrors.push({
            target: candidate.displayName,
            error: 'deployment does not expose the Messari Market schema',
          });
          continue;
        }

        const result = await graphMcpClient.queryDynamic(
          candidate.subgraphId,
          MESSARI_MULTI_ASSET_QUERY,
        );
        // queryDynamic returns the parsed GraphQL response: { data: { markets } }
        const markets = (
          result?.data as { data?: { markets?: DynamicMessariMarket[] } } | null
        )?.data?.markets;

        for (const market of markets ?? []) {
          const opportunity = this.toOpportunity(
            market,
            candidate,
            query.chains,
            floorUsd,
            tierThresholdUsd,
            timestamp,
          );
          if (opportunity) opportunities.push(opportunity);
        }
      } catch (err) {
        candidateErrors.push({
          target: candidate.displayName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (opportunities.length === 0) {
      throw new GraphFeedError(
        'MCP_UNAVAILABLE',
        `dynamic MCP discovery found no usable markets above the ${floorUsd} USD gate — refusing to fabricate opportunities`,
        { candidateErrors },
      );
    }

    opportunities.sort((a, b) => b.totalValueLockedUSD - a.totalValueLockedUSD);
    return opportunities.slice(0, limit);
  }

  /**
   * Runtime discovery from generic category keywords only. The MCP client
   * already probes hyphen/space keyword variants; rows are read across the
   * payload shapes the search service emits and deduplicated by deployment.
   */
  private async discoverCandidates(
    keywords: string[],
  ): Promise<DiscoveredCandidate[]> {
    const byId = new Map<string, DiscoveredCandidate>();

    for (const keyword of keywords) {
      let raw: Record<string, unknown> | null = null;
      try {
        raw = await graphMcpClient.searchSubgraphs(keyword);
      } catch (err) {
        console.warn(
          `[McpMarket] keyword search failed for "${keyword}":`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }
      if (!raw) continue;

      const rows = Array.isArray(raw.results)
        ? raw.results
        : Array.isArray(raw.subgraphs)
          ? raw.subgraphs
          : [];

      for (const row of rows) {
        const subgraphId =
          typeof row?.subgraphId === 'string'
            ? row.subgraphId
            : typeof row?.id === 'string'
              ? row.id
              : '';
        if (!subgraphId || byId.has(subgraphId)) continue;
        const displayName =
          typeof row?.displayName === 'string'
            ? row.displayName
            : typeof row?.metadata?.displayName === 'string'
              ? row.metadata.displayName
              : subgraphId;
        byId.set(subgraphId, { subgraphId, displayName });
      }
    }

    return [...byId.values()];
  }

  /**
   * Schema trust gate: probe the deployment's `Market` entity shape via
   * introspection and require the Messari standardized fields. Deployments
   * with custom schemas (e.g. Compound v3 Base) are rejected here instead of
   * crashing the unified query later.
   */
  private async validateMarketSchema(subgraphId: string): Promise<boolean> {
    const result = await graphMcpClient.queryDynamic(
      subgraphId,
      MARKET_SCHEMA_CHECK_QUERY,
    );
    const fields = (
      result?.data as
        | { data?: { __type?: { fields?: Array<{ name: string }> | null } } }
        | undefined
    )?.data?.__type?.fields;
    const names = new Set((fields ?? []).map((field) => field.name));
    return REQUIRED_MARKET_FIELDS.every((field) => names.has(field));
  }

  private toOpportunity(
    market: DynamicMessariMarket,
    candidate: DiscoveredCandidate,
    chains: SupportedChain[] | undefined,
    floorUsd: number,
    tierThresholdUsd: number,
    timestamp: number,
  ): DynamicYieldOpportunity | null {
    if (market.isActive === false) return null;

    const rawSymbol = market.inputToken?.symbol?.toUpperCase();
    const symbol = rawSymbol ? ASSET_ALIASES[rawSymbol] : undefined;
    if (!symbol) return null;
    if (!market.rates || market.rates.length === 0) return null;

    const tvl = this.toFiniteNonNegativeNumber(market.totalValueLockedUSD);
    if (tvl < floorUsd) return null;

    let supplyApy = 0;
    for (const rate of market.rates) {
      if (rate.type !== 'VARIABLE' || rate.side !== 'LENDER') continue;
      const parsed = Number(rate.rate);
      if (!Number.isFinite(parsed)) continue;
      supplyApy = this.normalizeRate(parsed);
    }
    if (supplyApy <= 0) return null;

    const chain = this.inferChain(candidate.displayName);
    // Chain gate is label-based: a candidate whose chain cannot be proven
    // from its name is kept only when the caller did not restrict chains.
    if (chains && chains.length > 0 && chain && !chains.includes(chain)) {
      return null;
    }

    return {
      protocol: candidate.displayName,
      chain: chain ?? candidate.displayName,
      symbol,
      supplyApy: Number(supplyApy.toFixed(4)),
      totalValueLockedUSD: tvl,
      tier: tvl >= tierThresholdUsd ? 'established' : 'emerging',
      deploymentId: candidate.subgraphId,
      source: MCP_SOURCE_TAG,
      timestamp,
    };
  }

  private inferChain(displayName: string): SupportedChain | null {
    const label = displayName.toLowerCase();
    if (label.includes('arbitrum')) return 'Arbitrum';
    if (label.includes('base')) return 'Base';
    if (label.includes('ethereum') || label.includes('mainnet'))
      return 'Ethereum';
    return null;
  }

  private toFiniteNonNegativeNumber(value: string): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  /**
   * Normalize rate values into decimal APY fractions (independent copy —
   * this service is decoupled from Engine A):
   *   - Ray-scale payloads (>1e18) → /1e27
   *   - Percentage APY (0.0001 < value <= 100) → /100
   *   - Already-decimal values pass through unchanged.
   */
  private normalizeRate(value: number): number {
    if (value > 1e18) return value / 1e27;
    if (value > 0.0001 && value <= 100) return value / 100;
    return value;
  }
}

export const mcpMarketService = new McpMarketService();
