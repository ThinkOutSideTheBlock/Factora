import { z } from "zod";
import { DebtDocument, Proposal } from "../proposal/proposal.model.js";
import { AgentMatchResult } from "../underwriter/underwriter.model.js";
import { GraphMarketData } from "../graph/graph-feed.js";

export const BuyerSearchSchema = z
    .object({
        amountMin: z.number().positive("amountMin must be a positive number"),
        amountMax: z.number().positive("amountMax must be a positive number"),
        durationInDaysMin: z
            .number()
            .int()
            .positive("durationInDaysMin must be a positive integer"),
        durationInDaysMax: z
            .number()
            .int()
            .positive("durationInDaysMax must be a positive integer"),
        apyInPercentMin: z
            .number()
            .min(0, "apyInPercentMin cannot be negative"),
    })
    .refine((data) => data.amountMin <= data.amountMax, {
        message: "amountMin cannot be greater than amountMax",
        path: ["amountMin"],
    })
    .refine((data) => data.durationInDaysMin <= data.durationInDaysMax, {
        message: "durationInDaysMin cannot be greater than durationInDaysMax",
        path: ["durationInDaysMin"],
    });

export type BuyerSearchRequest = z.infer<typeof BuyerSearchSchema>;

/* ── Smart Report (paid, per-token metered) ────────────────────────────────── */

import {
    getSmartReportPricingConfig,
    type SmartReportPricingConfig,
} from "../x402/pricing.js";
import type { LlmUsage } from "../underwriter/llm.client.js";

/** Buyer search constraints + an optional free-form note for the AI underwriter. */
export const SmartReportSchema = BuyerSearchSchema.extend({
    userMessage: z
        .string()
        .trim()
        .min(1, "userMessage cannot be empty")
        .max(2000, "userMessage must be at most 2000 characters")
        .optional(),
});

export type SmartReportRequest = z.infer<typeof SmartReportSchema>;

/** Transparent billing info attached to every paid smart-report response. */
export interface SmartReportPricingInfo {
    strategy: "usage-estimate-per-token";
    /** Server-side token estimate (overhead + per-candidate × matched count). */
    estimatedTokens: number;
    /** Amount the challenge pre-charges, in tinybars. */
    estimatedAmountTinybars: string;
    config: SmartReportPricingConfig;
}

export interface SmartReportUsage extends LlmUsage {
    /** Token estimate the challenge was priced on. */
    estimatedTokens: number;
    /** Amount charged on-chain (the estimate), in tinybars. */
    chargedTinybars: string;
}

export interface SmartReportResponse extends BuyerSearchResponse {
    pricing: SmartReportPricingInfo;
    usage: SmartReportUsage | null;
}

export interface MatchmakingResultItem {
    proposal: Proposal;
    evaluation: AgentMatchResult;
}

export interface BuyerMatchResponse {
    count: number;
    proposals: PublicProposal[];
}

export type PublicProposal = Omit<Proposal, "underwritingReview"> & {
    debtDocument: Pick<
        DebtDocument,
        | "debtType"
        | "industry"
        | "debtorCompany"
        | "invoiceNumber"
        | "invoiceDate"
        | "dueDate"
        | "faceValue"
        | "currency"
        | "paymentTermsDays"
        | "purchaseOrderNumber"
        | "checkNumber"
        | "disputeStatus"
    >;
};

export interface BuyerSearchResponse {
    count: number;
    overallSummary: string;
    marketBenchmark: GraphMarketData;
    results: MatchmakingResultItem[];
}
