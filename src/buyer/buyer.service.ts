import { Proposal } from "../proposal/proposal.model.js";
import { getAllProposals } from "../proposal/proposal.storage.js";
import { getMarketBenchmark } from "../graph/graph-feed.mock.js";
import { evaluateProposalsWithAI } from "../underwriter/underwriter.agent.js";
import {
    BuyerMatchResponse,
    BuyerSearchRequest,
    BuyerSearchResponse,
    MatchmakingResultItem,
    SmartReportRequest,
    SmartReportResponse,
} from "./buyer.model.js";
import {
    computeChargeTinybars,
    estimateSmartReportTokens,
    getSmartReportPricingConfig,
} from "../x402/pricing.js";
import { createLogger } from "../common/logger.js";
import { PublicProposal } from "./buyer.model.js";

const log = createLogger("buyer");

/**
 * Stage 1: in-memory hard filter for buyer constraints.
 */
export function filterProposals(
    proposals: Proposal[],
    criteria: BuyerSearchRequest,
): Proposal[] {
    return proposals.filter((p) => {
        const isPending = p.status === "PENDING";
        const matchesAmount =
            p.amount >= criteria.amountMin && p.amount <= criteria.amountMax;
        const matchesDuration =
            p.returnDateInDays >= criteria.durationInDaysMin &&
            p.returnDateInDays <= criteria.durationInDaysMax;
        const matchesApy = p.apy >= criteria.apyInPercentMin;

        return isPending && matchesAmount && matchesDuration && matchesApy;
    });
}

/** Free matchmaking: deterministic hard filter only — no market data, no LLM. */
export async function searchProposals(
    criteria: BuyerSearchRequest,
): Promise<BuyerMatchResponse> {
    const allProposals = await getAllProposals();
    const filteredCandidates = filterProposals(allProposals, criteria);
    log.info(
        `Stage 1 hard filter: ${allProposals.length} proposals → ${filteredCandidates.length} candidates (amount ${criteria.amountMin}-${criteria.amountMax}, ${criteria.durationInDaysMin}-${criteria.durationInDaysMax}d, APY ≥ ${criteria.apyInPercentMin}%)`,
    );

    const publicProposals: PublicProposal[] = filteredCandidates.map(
        ({ underwritingReview: _review, ...proposal }) => proposal,
    );

    return {
        count: filteredCandidates.length,
        proposals: publicProposals,
    };
}

/** Paid smart report: usage-estimate pricing with a transparent receipt. */
export async function generateSmartReport(
    criteria: SmartReportRequest,
): Promise<SmartReportResponse> {
    const pricing = getSmartReportPricingConfig();
    const reportStartedAt = Date.now();

    const filteredCandidates = filterProposals(
        await getAllProposals(),
        criteria,
    );

    // Usage-estimate pricing: the candidate count drives the LLM cost. This is
    // the same computation as the challenge (smartReportPrice), so the paid
    // retry settles exactly what the buyer was quoted.
    const estimatedTokens = estimateSmartReportTokens(
        filteredCandidates.length,
        pricing,
    );
    const estimatedAmountTinybars = computeChargeTinybars(
        estimatedTokens,
        pricing,
    );
    log.info(
        `Smart report estimate: ${filteredCandidates.length} candidates → ~${estimatedTokens} tokens → ${estimatedAmountTinybars} tinybars (${(Number(estimatedAmountTinybars) / 100_000_000).toFixed(4)} HBAR)`,
    );

    const pricingInfo = {
        strategy: "usage-estimate-per-token" as const,
        estimatedTokens,
        estimatedAmountTinybars,
        config: pricing,
    };

    const marketBenchmark = await getMarketBenchmark();

    if (filteredCandidates.length === 0) {
        log.info(
            "Smart report: no candidates passed the hard filter — returning empty report (no LLM call)",
        );
        return {
            count: 0,
            overallSummary:
                "No pending proposals match the buyer requirements.",
            marketBenchmark,
            results: [],
            pricing: pricingInfo,
            usage: null,
        };
    }

    // Stage 2: AI Underwriter Evaluation (metered)
    const { analysis: aiAnalysis, usage } = await evaluateProposalsWithAI(
        filteredCandidates,
        criteria,
        marketBenchmark,
        criteria.userMessage,
    );
    const evalMap = new Map(
        aiAnalysis.evaluations.map((e) => [e.proposalId, e]),
    );

    const results: MatchmakingResultItem[] = filteredCandidates.map((p) => {
        const persistedReview = p.underwritingReview;
        const baselineRisk =
            persistedReview.riskLevel === "UNKNOWN"
                ? "HIGH"
                : persistedReview.riskLevel;
        const evaluation = evalMap.get(p.id) || {
            proposalId: p.id,
            fitScore: 50,
            riskLevel: baselineRisk,
            recommendation:
                "Candidate passed hard filters. Evaluation pending.",
            debtAnalysis: {
                status: persistedReview.status,
                collectionConfidenceScore:
                    persistedReview.collectionConfidenceScore,
                riskLevel: persistedReview.riskLevel,
                debtQuality: persistedReview.debtQuality,
                underwriterComment: persistedReview.underwriterComment,
                keyRisks: persistedReview.keyRisks,
                missingEvidence: persistedReview.missingEvidence,
            },
        };

        evaluation.riskLevel = baselineRisk;
        evaluation.debtAnalysis = {
            status: persistedReview.status,
            collectionConfidenceScore:
                persistedReview.collectionConfidenceScore,
            riskLevel: persistedReview.riskLevel,
            debtQuality: persistedReview.debtQuality,
            underwriterComment: persistedReview.underwriterComment,
            keyRisks: persistedReview.keyRisks,
            missingEvidence: persistedReview.missingEvidence,
        };

        return {
            proposal: p,
            evaluation,
        };
    });

    // Sort by fitScore descending
    results.sort((a, b) => b.evaluation.fitScore - a.evaluation.fitScore);
    log.info(
        `Smart report done: ${results.length} results in ${Date.now() - reportStartedAt}ms · usage ${usage ? `${usage.totalTokens} tokens` : "n/a (fallback)"}`,
    );

    return {
        count: results.length,
        overallSummary: aiAnalysis.overallSummary,
        marketBenchmark,
        results,
        pricing: pricingInfo,
        usage: usage
            ? {
                  ...usage,
                  estimatedTokens,
                  chargedTinybars: estimatedAmountTinybars,
              }
            : null,
    };
}
