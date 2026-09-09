export interface GraphMarketData {
  averageMarketApy: number;
  benchmarkDefaultRate: number;
  liquidityIndex: number;
  timestamp: string;
}

export const mockGraphData: GraphMarketData = {
  averageMarketApy: 14.5,
  benchmarkDefaultRate: 0.03, // 3% default rate
  liquidityIndex: 88.2,       // 0 to 100
  timestamp: new Date().toISOString()
};

/**
 * Retrieves market data benchmarks (live or mocked from Graph Protocol).
 */
export async function getMarketBenchmark(): Promise<GraphMarketData> {
  return {
    ...mockGraphData,
    timestamp: new Date().toISOString()
  };
}
