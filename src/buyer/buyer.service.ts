import { Proposal } from "../proposal/proposal.model.js";
import { getAllProposals } from "../proposal/proposal.storage.js";
import { getMarketBenchmark } from "../graph/graph-feed.mock.js";
import { evaluateProposalsWithAI } from "../underwriter/underwriter.agent.js";
import {
    BuyerMatchResponse,
    BuyerSearchRequest,
    BuyerSearchResponse,
    MatchmakingResultItem,
} from "./buyer.model.js";

/**
 * Stage 1: In-Memory Hard Filter
 * Excludes proposals that do not match the buyer's deterministic requirements.
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

/**
 * Free matchmaking service. It performs only the deterministic hard filter and
 * intentionally does not read market data or call the LLM.
 */
export async function searchProposals(
    criteria: BuyerSearchRequest,
): Promise<BuyerMatchResponse> {
    const allProposals = await getAllProposals();
    const filteredCandidates = filterProposals(allProposals, criteria);

    return {
        count: filteredCandidates.length,
        proposals: filteredCandidates,
    };
}

/**
 * Paid smart-report service. Payment middleware can be mounted on this route
 * without changing the free matchmaking flow.
 */
export async function generateSmartReport(
    criteria: BuyerSearchRequest,
): Promise<BuyerSearchResponse> {
    const freeMatch = await searchProposals(criteria);
    const filteredCandidates = freeMatch.proposals;
    const marketBenchmark = await getMarketBenchmark();

    if (filteredCandidates.length === 0) {
        return {
            count: 0,
            overallSummary:
                "No pending proposals match the buyer requirements.",
            marketBenchmark,
            results: [],
        };
    }

    // Stage 2: AI Underwriter Evaluation
    const aiAnalysis = await evaluateProposalsWithAI(
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

    return {
        count: results.length,
        overallSummary: aiAnalysis.overallSummary,
        marketBenchmark,
        results,
    };
}
