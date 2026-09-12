import { z } from "zod";
import { UnderwritingReviewSchema } from "../proposal/proposal.model.js";

export const RiskLevelEnum = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type RiskLevel = z.infer<typeof RiskLevelEnum>;

export const AgentMatchResultSchema = z.object({
    proposalId: z.string(),
    fitScore: z.number().min(0).max(100),
    riskLevel: RiskLevelEnum,
    recommendation: z.string(),
    debtAnalysis: UnderwritingReviewSchema.pick({
        status: true,
        collectionConfidenceScore: true,
        riskLevel: true,
        debtQuality: true,
        underwriterComment: true,
        keyRisks: true,
        missingEvidence: true,
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
