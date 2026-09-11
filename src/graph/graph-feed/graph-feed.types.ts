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
