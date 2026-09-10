import { Proposal } from "../proposal/proposal.model.js";
import { GraphMarketData } from "../graph/graph-feed.mock.js";
import { BuyerSearchRequest } from "../buyer/buyer.model.js";
import {
    UnderwriterAnalysisResponse,
    UnderwriterAnalysisResponseSchema,
} from "./underwriter.model.js";
import { callLlmJson } from "./llm.client.js";
import {
    buildUnderwriterPrompt,
    UNDERWRITER_SYSTEM_PROMPT,
} from "./underwriter.prompt.js";

/**
 * Runs AI underwriting for candidates that have already passed the hard filter.
 */
export async function evaluateProposalsWithAI(
    candidates: Proposal[],
    buyerRequirements: BuyerSearchRequest,
    marketData: GraphMarketData,
): Promise<UnderwriterAnalysisResponse> {
    if (!candidates || candidates.length === 0) {
        return {
            overallSummary: "No proposals matched the buyer requirements.",
            evaluations: [],
        };
    }

    const rawResponse = await callLlmJson({
        systemPrompt: UNDERWRITER_SYSTEM_PROMPT,
        userPrompt: buildUnderwriterPrompt(
            buyerRequirements,
            candidates,
            marketData,
        ),
    });

    return parseUnderwriterResponse(rawResponse, candidates);
}

/** Validates the LLM response and ensures it evaluates exactly the supplied proposals. */
export function parseUnderwriterResponse(
    response: unknown,
    candidates: Proposal[],
): UnderwriterAnalysisResponse {
    const parsed = UnderwriterAnalysisResponseSchema.parse(response);
    const expectedIds = new Set(candidates.map((candidate) => candidate.id));
    const returnedIds = new Set(
        parsed.evaluations.map((evaluation) => evaluation.proposalId),
    );

    if (
        parsed.evaluations.length !== candidates.length ||
        returnedIds.size !== candidates.length ||
        [...returnedIds].some((id) => !expectedIds.has(id))
    ) {
        throw new Error(
            "LLM evaluations must contain exactly one result for every candidate proposal",
        );
    }

    return parsed;
}
