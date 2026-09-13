import { Proposal } from "../proposal/proposal.model.js";
import { getAllProposals } from "../proposal/proposal.storage.js";
import { getGraphFeed } from "../graph/graph-feed.js";
import { evaluateProposalsWithAI } from "../underwriter/underwriter.agent.js";
import { generateMarketReview } from "../underwriter/market-review.js";
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

    const marketBenchmark = await getGraphFeed();

    if (filteredCandidates.length === 0) {
        log.info(
            "Smart report: no candidates passed the hard filter — returning empty report (no LLM call)",
        );
        const emptyReview = await generateMarketReview(marketBenchmark);
        if (emptyReview.mediumApyPct != null) {
            marketBenchmark.averageMarketApy = emptyReview.mediumApyPct;
        }
        return {
            count: 0,
            overallSummary:
                "No pending proposals match the buyer requirements.",
            marketReview: emptyReview.review,
            marketBenchmark,
            results: [],
            pricing: pricingInfo,
            usage: null,
        };
    }

    // Stage 2: AI Underwriter Evaluation (metered) + AI market review. Both are
    // LLM calls against the same graph feed; they run in parallel so the
    // review adds no latency to the paid report.
    const [underwriterResult, reviewResult] = await Promise.all([
        evaluateProposalsWithAI(
            filteredCandidates,
            criteria,
            marketBenchmark,
            criteria.userMessage,
        ),
        generateMarketReview(marketBenchmark),
    ]);
    const { analysis: aiAnalysis, usage } = underwriterResult;

    // The AI's "medium" (median-style) hurdle rate replaces the arithmetic
    // average, which low-yield MCP rows drag down — the displayed Market APY
    // must be a realistic capital-cost signal.
    if (reviewResult.mediumApyPct != null) {
        marketBenchmark.averageMarketApy = reviewResult.mediumApyPct;
    }
    const marketReview = reviewResult.review;

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

    // Deterministic ranking: fitScore (which now carries the buyerMessage
    // preferences per the underwriter prompt) descending, with stable
    // tie-breakers so equal scores never fall back to arbitrary storage order.
    const ranked = rankMatchResults(results);
    log.info(
        `Smart report done: ${ranked.length} results in ${Date.now() - reportStartedAt}ms · usage ${usage ? `${usage.totalTokens} tokens` : "n/a (fallback)"}`,
    );

    return {
        count: ranked.length,
        overallSummary: aiAnalysis.overallSummary,
        marketReview,
        marketBenchmark,
        results: ranked,
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

/**
 * Orders smart-report results for presentation: fitScore descending (the
 * underwriter is instructed to fold the buyer's userMessage preferences into
 * fitScore), then APY descending, then nominal amount descending as
 * deterministic tie-breakers. Pure function — trivially unit-testable.
 */
export function rankMatchResults<
    T extends { proposal: { apy: number; amount: number }; evaluation: { fitScore: number } },
>(results: T[]): T[] {
    return [...results].sort(
        (a, b) =>
            b.evaluation.fitScore - a.evaluation.fitScore ||
            b.proposal.apy - a.proposal.apy ||
            b.proposal.amount - a.proposal.amount,
    );
}
