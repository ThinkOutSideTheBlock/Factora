import { z } from "zod";
import { UnderwritingReviewSchema } from "../proposal/proposal.model.js";

export const RiskLevelEnum = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type RiskLevel = z.infer<typeof RiskLevelEnum>;

/**
 * LLMs (especially small local ones) frequently emit scores as strings
 * ("85") or slightly out-of-range values. Coerce and clamp instead of letting
 * one bad field destroy the whole (already paid-for) report.
 */
const clampedIntScore = z.coerce
    .number()
    .transform((n) => Math.max(0, Math.min(100, Math.round(n))));

export const AgentMatchResultSchema = z.object({
    proposalId: z.string(),
    fitScore: clampedIntScore,
    riskLevel: RiskLevelEnum,
    recommendation: z.string(),
    debtAnalysis: UnderwritingReviewSchema.pick({
        status: true,
        riskLevel: true,
        debtQuality: true,
        underwriterComment: true,
        keyRisks: true,
        missingEvidence: true,
    }).extend({
        collectionConfidenceScore: clampedIntScore,
    }),
});

export type AgentMatchResult = z.infer<typeof AgentMatchResultSchema>;

export const UnderwriterAnalysisResponseSchema = z.object({
    overallSummary: z.string(),
    evaluations: z.array(AgentMatchResultSchema),
});

export type UnderwriterAnalysisResponse = z.infer<
    typeof UnderwriterAnalysisResponseSchema
>;

export interface UnderwriterEvaluationContext {
    averageMarketApy: number;
    benchmarkDefaultRate: number;
    liquidityIndex: number;
}

export const DebtDocumentReviewSchema = UnderwritingReviewSchema.pick({
    collectionConfidenceScore: true,
    riskLevel: true,
    debtQuality: true,
    underwriterComment: true,
    keyRisks: true,
    missingEvidence: true,
});

export type DebtDocumentReview = z.infer<typeof DebtDocumentReviewSchema>;
