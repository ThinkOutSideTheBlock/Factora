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
    computeBudgetedAmount,
    getSmartReportPricingConfig,
} from "../x402/pricing.js";
import { createLogger } from "../common/logger.js";

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

    return {
        count: filteredCandidates.length,
        proposals: filteredCandidates,
    };
}

/** Paid smart report: priced from the declared token budget, with a usage receipt. */
export async function generateSmartReport(
    criteria: SmartReportRequest,
): Promise<SmartReportResponse> {
    const pricing = getSmartReportPricingConfig();
    const budgetedTokens = criteria.maxTokens ?? pricing.maxTokens;
    const budgetedAmountTinybars = computeBudgetedAmount(budgetedTokens, pricing);
    log.info(`Smart report: budget ${budgetedTokens} tokens → price ${budgetedAmountTinybars} tinybars (${(Number(budgetedAmountTinybars) / 100_000_000).toFixed(4)} HBAR)`);
    const reportStartedAt = Date.now();

    const pricingInfo = {
        strategy: 'declared-budget-per-token' as const,
        budgetedTokens,
        budgetedAmountTinybars,
        config: pricing,
    };

    const freeMatch = await searchProposals(criteria);
    const filteredCandidates = freeMatch.proposals;
    const marketBenchmark = await getMarketBenchmark();

    if (filteredCandidates.length === 0) {
        log.info('Smart report: no candidates passed the hard filter — returning empty report (no LLM call)');
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
    );
    const evalMap = new Map(
        aiAnalysis.evaluations.map((e) => [e.proposalId, e]),
    );

    const results: MatchmakingResultItem[] = filteredCandidates.map((p) => {
        const evaluation = evalMap.get(p.id) || {
            proposalId: p.id,
            fitScore: 50,
            riskLevel: "MEDIUM",
            recommendation:
                "Candidate passed hard filters. Evaluation pending.",
        };

        return {
            proposal: p,
            evaluation,
        };
    });

    // Sort by fitScore descending
    results.sort((a, b) => b.evaluation.fitScore - a.evaluation.fitScore);
    log.info(
        `Smart report done: ${results.length} results in ${Date.now() - reportStartedAt}ms · usage ${usage ? `${usage.totalTokens} tokens` : 'n/a (fallback)'}`,
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
                  budgetedTokens,
                  chargedTinybars: budgetedAmountTinybars,
              }
            : null,
    };
}
