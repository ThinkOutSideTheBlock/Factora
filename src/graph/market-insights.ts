/**
 * Standalone graph analytics product: live DeFi market intelligence sold
 * separately from the buyer/seller flows via x402 (POST /api/graph/insights).
 *
 * Combines three engines into one agent-friendly JSON payload:
 *   1. Engine A (messari.service.ts) — standardized lending benchmarks from The
 *      Graph gateway (Messari-standardized subgraphs).
 *   2. Engine B (mcp-market.service.ts) — additive opportunities discovered at
 *      runtime through The Graph's Subgraph MCP server.
 *   3. AI review (underwriter/market-review.ts) — a professional on-chain
 *      markets APY status review with factoring hurdle-rate guidance.
 *
 * External agents pay per call with x402 and use the result as the
 * capital-cost input for their own debt analytics.
 */
import { getGraphFeed } from "./graph-feed.js";
import { generateMarketReview } from "../underwriter/market-review.js";
import { createLogger } from "../common/logger.js";

const log = createLogger("graph-insights");

export interface GraphInsightsResponse {
    /** What this payload is — self-describing for external agents. */
    about: {
        product: string;
        description: string;
        /** How an agent should use the numbers. */
        usage: string;
        fieldSemantics: Record<string, string>;
    };
    generatedAt: string;
    latencyMs: number;
    review: string | null;
    market: {
        /**
         * AI-assessed "medium" (median-style) DeFi hurdle rate, in percent —
         * the realistic capital-cost signal. Falls back to the arithmetic
         * average when the AI review was unavailable.
         */
        unifiedApyPct: number;
        /** Raw arithmetic average supply APY across tracked markets, in percent. */
        averageApyPct: number;
        marketsTracked: number;
        /** Per-asset distribution of variable lend rates (0.05 = 5% -> see *Pct fields). */
        benchmarks: Array<{
            symbol: string;
            averageSupplyApyPct: number;
            minSupplyApyPct: number;
            maxSupplyApyPct: number;
            topMarket: string;
            marketsCount: number;
        }>;
        /** Every tracked market row (protocol, chain, asset, rates, TVL). */
        detailedRates: Array<{
            protocol: string;
            chain: string;
            symbol: string;
            supplyApyPct: number;
            borrowApyPct: string;
            totalValueLockedUSD: number;
            marketName?: string;
            isActive?: boolean;
        }>;
        /** Additive opportunities discovered via the Subgraph MCP (may be empty). */
        mcpOpportunities: Array<{
            protocol: string;
            chain: string;
            symbol: string;
            supplyApyPct: number;
            totalValueLockedUSD: number;
            category: string;
            tier: string;
            deploymentId: string;
        }>;
        dataSource: string;
        dataTimestamp: number;
    };
}

/** Fetches the live feed, adds the AI review, and shapes the sold JSON payload. */
export async function generateMarketInsights(): Promise<GraphInsightsResponse> {
    const startedAt = Date.now();
    log.info("Generating graph insights payload");

    const feed = await getGraphFeed();
    const reviewResult = await generateMarketReview(feed);
    return shapeInsights(feed, reviewResult, Date.now() - startedAt);
}

function shapeInsights(
    feed: Awaited<ReturnType<typeof getGraphFeed>>,
    reviewResult: { review: string | null; mediumApyPct: number | null },
    latencyMs: number,
): GraphInsightsResponse {
    const review = reviewResult.review;
    // The AI's "medium" (median-style) hurdle rate is the headline number; the
    // arithmetic average is kept for transparency (low-yield MCP rows drag it down).
    const unifiedApyPct = reviewResult.mediumApyPct ?? feed.averageMarketApy;
    const benchmarks = Object.entries(feed.messari.benchmarks).map(
        ([symbol, benchmark]) => ({
            symbol,
            averageSupplyApyPct: Number((benchmark.averageSupplyApy * 100).toFixed(2)),
            minSupplyApyPct: Number((benchmark.minSupplyApy * 100).toFixed(2)),
            maxSupplyApyPct: Number((benchmark.maxSupplyApy * 100).toFixed(2)),
            topMarket: benchmark.topMarket,
            marketsCount: benchmark.marketsCount,
        }),
    );

    return {
        about: {
            product: "Factora Graph Market Insights",
            description:
                "Live on-chain stablecoin lending intelligence queried from The Graph " +
                "(Messari-standardized subgraphs via the gateway + dynamic discovery through " +
                "the Subgraph MCP), with an AI market review for invoice-factoring capital allocation.",
            usage:
                "Use market.unifiedApyPct (the AI-assessed median hurdle rate) and " +
                "market.benchmarks[].averageSupplyApyPct as the risk-free hurdle rate for " +
                "short-term capital: any debt/invoice position must out-earn these rates plus " +
                "a default-risk premium. maxSupplyApyPct is the best single market (may be " +
                "reward-inflated). These are DeFi rates, not Factora invoice rates.",
            fieldSemantics: {
                "market.unifiedApyPct":
                    "AI-assessed median-style DeFi hurdle rate (%) — the representative capital-cost signal across tracked markets. Not a Factora invoice rate.",
                "market.averageApyPct":
                    "Raw arithmetic average supply APY (%) across tracked markets, for transparency.",
                "market.benchmarks[].averageSupplyApyPct":
                    "Average variable lend APY (%) for that stablecoin across tracked markets.",
                "market.benchmarks[].maxSupplyApyPct":
                    "Highest single-market lend APY (%) for that stablecoin (may be reward-inflated).",
                "market.detailedRates[]":
                    "Every tracked market: protocol, chain, asset, supply/borrow APY (%), TVL in USD.",
                "market.mcpOpportunities[]":
                    "Additive DeFi yields dynamically discovered through the Subgraph MCP beyond the tracked set.",
                review: "AI-written market status review with factoring hurdle-rate guidance.",
            },
        },
        generatedAt: new Date().toISOString(),
        latencyMs,
        review,
        market: {
            unifiedApyPct,
            averageApyPct: feed.averageMarketApy,
            marketsTracked: feed.messari.detailedRates.length,
            benchmarks,
            detailedRates: feed.messari.detailedRates.map((rate) => ({
                protocol: rate.protocol,
                chain: rate.chain,
                symbol: rate.symbol,
                supplyApyPct: Number((rate.supplyApy * 100).toFixed(2)),
                borrowApyPct: ((rate.borrowApy ?? 0) * 100).toFixed(2),
                totalValueLockedUSD: rate.totalValueLockedUSD,
                marketName: rate.marketName,
                isActive: rate.isActive,
            })),
            mcpOpportunities: feed.mcp.map((opportunity) => ({
                protocol: opportunity.protocol,
                chain: opportunity.chain,
                symbol: opportunity.symbol,
                supplyApyPct: Number((opportunity.supplyApy * 100).toFixed(2)),
                totalValueLockedUSD: opportunity.totalValueLockedUSD,
                category: opportunity.category,
                tier: opportunity.tier,
                deploymentId: opportunity.deploymentId,
            })),
            dataSource: feed.messari.source,
            dataTimestamp: feed.messari.timestamp,
        },
    };
}
