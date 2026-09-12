export interface ProtocolMarketRate {
  protocol: string;
  chain: string;
  symbol: string;
  supplyApy: number;
  /** Optional for backward compatibility; may be 0 when borrow data is unavailable. */
  borrowApy?: number;
  totalValueLockedUSD: number;
  /** Additive metadata for labeling native vs bridged markets (e.g. "Aave Arbitrum USDCn"). */
  marketName?: string;
  /** Underlying token contract address (lowercase hex) when the subgraph exposes it. */
  inputTokenId?: string;
  /** True when the subgraph reports the market as active. */
  isActive?: boolean;
}


export interface AssetBenchmark {
  symbol: string;
  averageSupplyApy: number;
  maxSupplyApy: number;
  minSupplyApy: number;
  topMarket: string;
  marketsCount: number;
}

export interface MultiAssetBenchmarkReport {
  timestamp: number;
  benchmarks: Record<string, AssetBenchmark>;
  detailedRates: ProtocolMarketRate[];
  source: string;
}

export interface LpPoolBenchmark {
  protocol: string;
  pair: string;
  estimatedApy: number;
  tvlUSD: number;
}

export interface SubgraphSearchResultItem {
  subgraphId: string;
  displayName: string;
  currentDeploymentIpfsHash: string | null;
}

export interface SubgraphSearchResponse {
  keyword: string;
  resultsCount: number;
  results: SubgraphSearchResultItem[];
}

export interface RawQueryResult {
  subgraphId: string;
  data: Record<string, unknown> | null;
  errors: string[];
  elapsedMs: number;
}

// ===========================================================================
// Error contract — missing or unusable data is an error
// ===========================================================================

export type GraphFeedErrorCode =
  | 'NO_LIVE_DATA'
  | 'ALL_TARGETS_FAILED'
  | 'MCP_UNAVAILABLE';

export interface GraphFeedErrorDetail {
  target: string;
  error: string;
}

/**
 * Thrown whenever the feed cannot return live, usable data. The module never
 * fabricates fallback values: an absent dataset is always an error.
 */
export class GraphFeedError extends Error {
  readonly code: GraphFeedErrorCode;
  readonly missingAssets?: string[];
  readonly candidateErrors?: GraphFeedErrorDetail[];

  constructor(
    code: GraphFeedErrorCode,
    message: string,
    options?: {
      missingAssets?: string[];
      candidateErrors?: GraphFeedErrorDetail[];
    },
  ) {
    super(message);
    this.name = 'GraphFeedError';
    this.code = code;
    this.missingAssets = options?.missingAssets;
    this.candidateErrors = options?.candidateErrors;
  }
}

// ===========================================================================
// Dynamic Engine B (Subgraph MCP) — protocol-agnostic market discovery
// ===========================================================================

export type RiskProfile = 'low' | 'mid';
export type SupportedChain = 'Ethereum' | 'Arbitrum' | 'Base' | 'Polygon';
export type MarketTier = 'established' | 'emerging';
export type ApyMethod = 'direct-rate' | 'share-price-growth' | 'fee-annualization';
export type YieldRiskClass = 'lending' | 'vault' | 'staking' | 'liquidity';

/** Trust-gate defaults per risk profile (override with DynamicYieldQuery.minTvlUsd). */
export const RISK_PROFILE_TVLS: Record<RiskProfile, number> = {
  low: 10_000_000,
  mid: 1_000_000,
};

/**
 * Fully dynamic Engine B query. The service discovers deployments at runtime from
 * these parameters only.
 */
export interface DynamicYieldQuery {
  /** Low-risk defaults to $10M; mid-risk defaults to $1M and both can be overridden. */
  riskProfile: RiskProfile;
  /** Chains to consider. Default: all three supported chains. */
  chains?: SupportedChain[];
  /** Generic discovery keyword seeds. MUST be category words (e.g. 'lending'), never protocol names. Default: ['lending']. */
  protocolKeywords?: string[];
  /** Overrides the risk-profile TVL floor. */
  minTvlUsd?: number;
  /** Max opportunities returned. Default: 20. */
  limit?: number;
  /** Engine A markets to exclude when MCP is used as an additive source. */
  excludeMarkets?: Array<{
    protocol: string;
    chain: string;
    symbol: string;
  }>;
}

/** A live yield opportunity discovered dynamically via the Subgraph MCP. */
export interface DynamicYieldOpportunity {
  protocol: string;
  chain: SupportedChain;
  symbol: string;
  /** Runtime classification used to rank and group additive opportunities. */
  category: 'lending' | 'vault' | 'staking' | 'liquidity' | 'other';
  apyMethod: ApyMethod;
  confidence: 'high' | 'medium';
  riskClass: YieldRiskClass;
  /** Decimal APY fraction (0.0335 = 3.35%). */
  supplyApy: number;
  totalValueLockedUSD: number;
  /** 'established' = TVL >= 10x the profile floor; 'emerging' = above the floor but smaller — the watchlist for new opportunities. */
  tier: MarketTier;
  /** Provenance: exactly where this row came from. */
  deploymentId: string;
  source: string;
  timestamp: number;
}
