import { Proposal } from "../proposal/proposal.model.js";
import { GraphMarketData } from "../graph/graph-feed.mock.js";
import { BuyerSearchRequest } from "../buyer/buyer.model.js";
import {
    UnderwriterAnalysisResponse,
    UnderwriterAnalysisResponseSchema,
} from "./underwriter.model.js";
import { callLlmJsonWithUsage, LlmUsage } from "./llm.client.js";
import {
    buildUnderwriterPrompt,
    UNDERWRITER_SYSTEM_PROMPT,
} from "./underwriter.prompt.js";

export interface UnderwriterAiResult {
    analysis: UnderwriterAnalysisResponse;
    usage: LlmUsage | null;
}

/**
 * Runs AI underwriting for candidates that already passed the hard filter.
 * Returns the analysis plus the provider-reported token usage for metering.
 */
export async function evaluateProposalsWithAI(
    candidates: Proposal[],
    buyerRequirements: BuyerSearchRequest,
    marketData: GraphMarketData,
): Promise<UnderwriterAiResult> {
    if (!candidates || candidates.length === 0) {
        return {
            analysis: {
                overallSummary: "No proposals matched the buyer requirements.",
                evaluations: [],
            },
            usage: null,
        };
    }

    const { data: rawResponse, usage } = await callLlmJsonWithUsage({
        systemPrompt: UNDERWRITER_SYSTEM_PROMPT,
        userPrompt: buildUnderwriterPrompt(
            buyerRequirements,
            candidates,
            marketData,
        ),
    });

    try {
        return {
            analysis: parseUnderwriterResponse(rawResponse, candidates),
            usage,
        };
    } catch (error) {
        // The payer already settled — degrade to neutral scores instead of
        // failing a paid request over a malformed LLM response.
        console.error(
            'Underwriter LLM response failed validation, using fallback:',
            error instanceof Error ? error.message : error,
        );
        return {
            analysis: {
                overallSummary:
                    'AI evaluation could not be validated for this pool; showing neutral fallback scores.',
                evaluations: candidates.map((candidate) => ({
                    proposalId: candidate.id,
                    fitScore: 50,
                    riskLevel: "MEDIUM" as const,
                    recommendation:
                        'Candidate passed the hard filters. AI evaluation was unavailable for this report.',
                })),
            },
            usage,
        };
    }
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
