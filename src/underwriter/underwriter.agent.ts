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
import { createLogger } from "../common/logger.js";

const log = createLogger("underwriter");

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

    log.info(`AI underwriting ${candidates.length} candidates`);

    // No silent degradation: if the LLM is unavailable or returns garbage, the
    // error propagates so the caller (and the buyer) sees the real cause.
    // In the x402 flow the handler fails BEFORE settlement, so the payer is
    // not charged for a report that never materialized.
    const { data: rawResponse, usage } = await callLlmJsonWithUsage({
        systemPrompt: UNDERWRITER_SYSTEM_PROMPT,
        userPrompt: buildUnderwriterPrompt(
            buyerRequirements,
            candidates,
            marketData,
        ),
    });
    const analysis = parseUnderwriterResponse(rawResponse, candidates);
    log.info(`AI underwriting OK: ${analysis.evaluations.length} evaluations`);
    return {
        analysis,
        usage,
    };
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
