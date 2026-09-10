export interface ProtocolMarketRate {
  protocol: string;
  chain: string;
  symbol: string;
  supplyApy: number;
  borrowApy: number;
  totalValueLockedUSD: number;
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
