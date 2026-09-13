/**
 * AI market commentary: turns the live graph feed (Messari benchmarks + MCP
 * opportunities) into a short, Factora-specific review for invoice buyers.
 *
 * The review is garnish, not underwriting: any failure resolves to null and
 * the paid report still ships. It runs in parallel with the underwriter call
 * so it adds no latency to the smart-report flow.
 */
import { z } from "zod";
import type { GraphMarketData } from "../graph/graph-feed.js";
import { callLlmJsonWithUsage } from "./llm.client.js";
import { createLogger } from "../common/logger.js";

const log = createLogger("market-review");

export interface MarketReviewResult {
    review: string | null;
    /**
     * AI-assessed "medium" (median-style) DeFi hurdle rate in percent — a
     * realistic representative rate across the supplied market list, unlike
     * the arithmetic average which low MCP rows drag down. Null when the LLM
     * did not provide one.
     */
    mediumApyPct: number | null;
}

const MarketReviewSchema = z.object({
    review: z.string().trim().min(1).max(1200),
    mediumApyPct: z
        .number()
        .min(0)
        .max(100)
        .nullish()
        .transform((v) => (typeof v === "number" && Number.isFinite(v) ? v : null)),
});

const MARKET_REVIEW_SYSTEM_PROMPT = `You are the market analyst for Factora, an invoice-factoring marketplace.
On Factora, sellers list outstanding invoices and buyers purchase them at a discount;
the buyer's return is the invoice APY. Idle buyer capital could instead sit in third-party
DeFi stablecoin money markets, so those live APYs are the opportunity cost (hurdle rate)
of funding invoices: a factor position must out-earn them AND compensate for debtor
default risk, which DeFi lending does not carry.

You are given live data scraped from DeFi lending subgraphs. It contains ZERO information
about invoices listed on Factora — no invoice APYs, no Factora marketplace rates. Every
rate below is a third-party DeFi money-market rate for idle stablecoin capital.

Field semantics (respect them exactly):
- unifiedMarketApyPct: the ARITHMETIC AVERAGE supply APY across ALL tracked third-party
  DeFi markets. It is NOT "the market APY for invoices on Factora", and being a plain
  average it can be dragged down by low-yield rows — do not treat it as the hurdle rate.
- marketRatesPct[]: the individual lend rate of EVERY tracked market. This is the list
  you should reason over.
- stablecoinBenchmarks[]: per-asset distribution of variable lend rates.
  averageSupplyApyPct is the per-asset average; maxSupplyApyPct is the single
  highest-paying market and may be reward-inflated — cite it only as a ceiling with
  its topMarket name. topMarket is where maxSupplyApyPct was observed; do not attach
  averageSupplyApyPct to it.
- mcpOpportunities[]: extra DeFi yields discovered beyond the tracked set (empty
  list means nothing additional was found — say so plainly).

Your first job: derive mediumApyPct — the representative "medium" DeFi hurdle rate.
Take the median-style middle of marketRatesPct (a realistic single number between the
lowest and highest market rates, unaffected by one outlier). Round to 2 decimals.

Your second job: write a 2-4 sentence review (plain prose, no markdown, no bullets)
telling an invoice buyer what that medium hurdle rate means for the invoice APYs they
should demand on Factora. Anchor every number in the supplied data; never invent rates.
Name the strongest stablecoin market by protocol, chain, and asset. Neutral,
professional tone. No disclaimers.

Respond with strict JSON of exactly this shape and nothing else:
{"review": "<your 2-4 sentence market review>", "mediumApyPct": <number>}`;

export function buildMarketReviewPrompt(marketData: GraphMarketData): string {
    const benchmarks = Object.entries(marketData.messari?.benchmarks ?? {}).map(
        ([symbol, benchmark]) => ({
            symbol,
            averageSupplyApyPct: Number((benchmark.averageSupplyApy * 100).toFixed(2)),
            minSupplyApyPct: Number((benchmark.minSupplyApy * 100).toFixed(2)),
            maxSupplyApyPct: Number((benchmark.maxSupplyApy * 100).toFixed(2)),
            topMarket: benchmark.topMarket,
            marketsCount: benchmark.marketsCount,
        }),
    );
    return JSON.stringify(
        {
            unifiedMarketApyPct_arithmeticAverage: marketData.averageMarketApy,
            marketRatesPct: (marketData.messari?.detailedRates ?? []).map((rate) => ({
                protocol: rate.protocol,
                chain: rate.chain,
                symbol: rate.symbol,
                supplyApyPct: Number((rate.supplyApy * 100).toFixed(2)),
                totalValueLockedUSD: Math.round(rate.totalValueLockedUSD),
            })),
            stablecoinBenchmarks: benchmarks,
            mcpOpportunities: marketData.mcp.map((opportunity) => ({
                protocol: opportunity.protocol,
                chain: opportunity.chain,
                symbol: opportunity.symbol,
                supplyApyPct: Number((opportunity.supplyApy * 100).toFixed(2)),
                totalValueLockedUSD: Math.round(opportunity.totalValueLockedUSD),
                category: opportunity.category,
                tier: opportunity.tier,
            })),
            dataSource: marketData.messari?.source,
            dataTimestamp: marketData.timestamp,
        },
        null,
        2,
    );
}

/**
 * Generates the market review + AI-assessed medium hurdle rate. Returns nulls
 * when the LLM is unavailable/invalid — never throws, callers degrade softly.
 */
export async function generateMarketReview(
    marketData: GraphMarketData,
): Promise<MarketReviewResult> {
    try {
        log.info("Generating AI market review");
        const { data } = await callLlmJsonWithUsage({
            systemPrompt: MARKET_REVIEW_SYSTEM_PROMPT,
            userPrompt: buildMarketReviewPrompt(marketData),
        });
        const parsed = MarketReviewSchema.parse(data);
        log.info(
            `AI market review OK · medium hurdle rate ${parsed.mediumApyPct ?? "n/a"}%`,
        );
        return { review: parsed.review, mediumApyPct: parsed.mediumApyPct };
    } catch (error) {
        log.warn(
            `Market review unavailable, shipping report without it: ${error instanceof Error ? error.message : error}`,
        );
        return { review: null, mediumApyPct: null };
    }
}
