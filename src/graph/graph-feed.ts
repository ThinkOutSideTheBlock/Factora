import "dotenv/config";
import { pathToFileURL } from "node:url";
import {
    DynamicYieldOpportunity,
    MultiAssetBenchmarkReport,
} from "./graph-feed/graph-feed.types.js";
import { getStandardizedLendingBenchmarks } from "./graph-feed/messari.service.js";
import { mcpMarketService } from "./graph-feed/mcp-market.service.js";
import { graphMcpClient } from "./graph-feed/graph-mcp.client.js";

export interface GraphMarketData {
    timestamp: string;
    averageMarketApy: number;
    benchmarkDefaultRate: number | null;
    liquidityIndex: number | null;
    messari: MultiAssetBenchmarkReport;
    mcp: DynamicYieldOpportunity[];
}

export interface GraphFeedInput {
    messari: MultiAssetBenchmarkReport;
    mcp: DynamicYieldOpportunity[];
}

function calculateAverageMarketApy(input: GraphFeedInput): number {
    const messariApys = Object.values(input.messari.benchmarks).map(
        (benchmark) => benchmark.averageSupplyApy,
    );
    const mcpApys = input.mcp.map((opportunity) => opportunity.supplyApy);
    const apys = [...messariApys, ...mcpApys].filter(Number.isFinite);

    if (apys.length === 0) return 0;
    return Number(
        ((apys.reduce((sum, apy) => sum + apy, 0) / apys.length) * 100).toFixed(
            2,
        ),
    );
}

/** Combines the two graph engines without inventing unavailable metrics. */
export function createGraphFeed(input: GraphFeedInput): GraphMarketData {
    return {
        timestamp: new Date().toISOString(),
        averageMarketApy: calculateAverageMarketApy(input),
        benchmarkDefaultRate: null,
        liquidityIndex: null,
        messari: input.messari,
        mcp: input.mcp,
    };
}

/** Fetches the live Messari and additive MCP datasets and unifies them. */
export async function getGraphFeed(): Promise<GraphMarketData> {
    console.log("messari");

    const messari = await getStandardizedLendingBenchmarks();
    console.log("mcp");
    const mcp = await mcpMarketService.getDynamicYieldOpportunities({
        riskProfile: "low",
        minTvlUsd: 1_000_000,
        protocolKeywords: [
            "aave",
            "compound",
            "spark",
            "vault",
            "staking",
            "yield",
            "liquidity pool",
        ],
        excludeMarkets: messari.detailedRates.map((rate) => ({
            protocol: rate.protocol,
            chain: rate.chain,
            symbol: rate.symbol,
        })),
    });
    return createGraphFeed({ messari, mcp });
}

// async function main() {
//     const res = await getGraphFeed();

//     console.dir(res, {
//         depth: null,
//         colors: true,
//     });
// }

// main();
