/**
 * x402 pricing strategies.
 *
 * Smart-report pricing is usage-based in two steps:
 *  1. Challenge (pre-charge): the server estimates the token cost from the
 *     candidate count that will actually enter the LLM prompt
 *     (overhead + per-candidate × N) — the client no longer picks the price.
 *  2. Refund (post-run): once real usage is known, the unused portion of the
 *     pre-charge is refunded on-chain (see usage-settlement.ts), making the
 *     effective price base + per1k × ⌈actual tokens / 1000⌉.
 *
 * Pricing functions must be deterministic — the middleware re-runs them on the
 * paid retry. The pool can change between the two calls, so the estimate is
 * cached per criteria for a short TTL and reused on the retry.
 */
import { filterProposals } from "../buyer/buyer.service.js";
import { getAllProposals } from "../proposal/proposal.storage.js";
import type { BuyerSearchRequest } from "../buyer/buyer.model.js";
import type { AssetAmount, Price } from "@x402/core/types";
import type { HTTPRequestContext } from "@x402/core/server";
import { createLogger } from "../common/logger.js";

const log = createLogger("pricing");

/** Native HBAR, expressed as its HTS token id inside Hedera's x402 scheme. */
export const HBAR_ASSET = "0.0.0";

export const TINYBARS_PER_HBAR = 100_000_000;

export const PROPOSAL_FIXED_PRICE: AssetAmount = {
    asset: HBAR_ASSET,
    amount: process.env.PROPOSAL_PRICE_TINYBAR ?? "100000",
};

/**
 * Fixed price for the standalone graph-analytics endpoint
 * (POST /api/graph/insights): live DeFi benchmarks + MCP opportunities + AI
 * market review, sold independently of the buyer/seller flows. A flat fee —
 * the payload shape is constant regardless of request content.
 */
export const GRAPH_INSIGHTS_PRICE: AssetAmount = {
    asset: HBAR_ASSET,
    amount: process.env.GRAPH_INSIGHTS_PRICE_TINYBAR ?? "50000",
};

export interface SmartReportPricingConfig {
    /** Flat fee charged regardless of usage, in tinybars. */
    baseFeeTinybars: number;
    /** Price per 1,000 tokens, in tinybars. */
    per1kTokensTinybars: number;
    /** Bounds the token estimate (and the legacy client-declared budget). */
    minTokens: number;
    maxTokens: number;
    /** Prompt scaffolding + market data, independent of candidate count. */
    tokensOverhead: number;
    /** Prompt + evaluation cost per matched candidate. */
    tokensPerCandidate: number;
}

export function getSmartReportPricingConfig(): SmartReportPricingConfig {
    return {
        baseFeeTinybars: parseInt(process.env.SMART_REPORT_BASE_TINYBAR ?? "20000", 10),
        per1kTokensTinybars: parseInt(
            process.env.SMART_REPORT_PER_1K_TOKENS_TINYBAR ?? "10000",
            10,
        ),
        maxTokens: parseInt(process.env.SMART_REPORT_MAX_TOKENS ?? "2048", 10),
        minTokens: 256,
        tokensOverhead: parseInt(process.env.SMART_REPORT_TOKENS_OVERHEAD ?? "2500", 10),
        tokensPerCandidate: parseInt(process.env.SMART_REPORT_TOKENS_PER_CANDIDATE ?? "600", 10),
    };
}

/** Token estimate for a report with `candidateCount` matched proposals. */
export function estimateSmartReportTokens(
    candidateCount: number,
    config: SmartReportPricingConfig = getSmartReportPricingConfig(),
): number {
    const raw = config.tokensOverhead + config.tokensPerCandidate * Math.max(0, candidateCount);
    return Math.min(Math.max(raw, config.minTokens), config.maxTokens);
}

/** price(tinybars) = baseFee + per1k × ⌈tokens / 1000⌉ (at least one thousand). */
export function computeChargeTinybars(
    totalTokens: number,
    config: SmartReportPricingConfig = getSmartReportPricingConfig(),
): string {
    const thousands = Math.max(1, Math.ceil(totalTokens / 1000));
    return String(config.baseFeeTinybars + thousands * config.per1kTokensTinybars);
}

// The 402 challenge and the paid retry are separate requests; pricing must be
// identical for both or verification fails. Cache per criteria for a short TTL.
const ESTIMATE_TTL_MS = 30_000;
const estimateCache = new Map<string, { price: Price; expiresAt: number }>();

/** DynamicPrice for the smart-report route: estimate from the live pool. */
export async function smartReportPrice(context: HTTPRequestContext): Promise<Price> {
    const config = getSmartReportPricingConfig();

    let cacheKey = "{}";
    let criteria: BuyerSearchRequest | null = null;
    try {
        const body = context.adapter.getBody?.() as Record<string, unknown> | undefined;
        cacheKey = JSON.stringify(body ?? {});
        if (body && typeof body === "object") criteria = body as BuyerSearchRequest;
    } catch {
        // No parsed body — price overhead only.
    }

    const cached = estimateCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.price;

    let candidateCount = 0;
    if (criteria) {
        try {
            const all = await getAllProposals();
            candidateCount = filterProposals(all, criteria).length;
        } catch (error) {
            log.warn("Candidate estimate failed — pricing overhead only", error);
        }
    }

    const estimatedTokens = estimateSmartReportTokens(candidateCount, config);
    const amount = computeChargeTinybars(estimatedTokens, config);
    log.info(
        `Smart report estimate: ${candidateCount} candidates → ~${estimatedTokens} tokens → ${amount} tinybars`,
    );

    const price: Price = { asset: HBAR_ASSET, amount };
    estimateCache.set(cacheKey, { price, expiresAt: Date.now() + ESTIMATE_TTL_MS });
    return price;
}