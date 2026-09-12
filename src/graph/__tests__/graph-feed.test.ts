import { describe, expect, it } from "vitest";
import { createGraphFeed } from "../graph-feed.js";
import {
    DynamicYieldOpportunity,
    MultiAssetBenchmarkReport,
} from "../graph-feed/graph-feed.types.js";

const messari: MultiAssetBenchmarkReport = {
    timestamp: 1,
    source: "Messari",
    detailedRates: [],
    benchmarks: {
        USDC: {
            symbol: "USDC",
            averageSupplyApy: 0.04,
            maxSupplyApy: 0.04,
            minSupplyApy: 0.04,
            topMarket: "Aave (Ethereum)",
            marketsCount: 1,
        },
    },
};

const mcp: DynamicYieldOpportunity[] = [
    {
        protocol: "Vault",
        chain: "Ethereum",
        symbol: "USDC",
        category: "vault",
        apyMethod: "direct-rate",
        confidence: "high",
        riskClass: "vault",
        supplyApy: 0.08,
        totalValueLockedUSD: 2_000_000,
        tier: "emerging",
        deploymentId: "deployment-1",
        source: "MCP",
        timestamp: 1,
    },
];

describe("createGraphFeed", () => {
    it("returns both sources and calculates a truthful APY summary", () => {
        const result = createGraphFeed({ messari, mcp });

        expect(result.messari).toBe(messari);
        expect(result.mcp).toBe(mcp);
        expect(result.averageMarketApy).toBe(6);
        expect(result.benchmarkDefaultRate).toBeNull();
        expect(result.liquidityIndex).toBeNull();
        expect(Number.isNaN(Date.parse(result.timestamp))).toBe(false);
    });
});
