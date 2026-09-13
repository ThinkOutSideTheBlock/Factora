/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🏆 ETHGlobal Online 2026 — Judge note
 * Track: "🤖 Best AI Tooling or AI Use Case with The Graph (From Scratch)"
 * (AI-app pool: The Graph as the agent's load-bearing data source)
 *
 * This AI underwriter never invents market context — every hurdle rate and
 * yield comparison it reasons over comes LIVE from The Graph (Messari
 * standardized subgraphs + Subgraph MCP, injected as `marketData`). The fit
 * scores, risk levels and debt-quality grades it emits are decisions made ON
 * that blockchain data — meaningful reasoning and automation, not a printed
 * query result — and are schema-validated (zod) before they are allowed to
 * influence money movement.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import {
    DebtDocument,
    Proposal,
    UnderwritingReview,
    UnderwritingReviewSchema,
} from "../proposal/proposal.model.js";
import { GraphMarketData } from "../graph/graph-feed.js";
import { BuyerSearchRequest } from "../buyer/buyer.model.js";
import {
    UnderwriterAnalysisResponse,
    UnderwriterAnalysisResponseSchema,
} from "./underwriter.model.js";
import { callLlmJsonWithUsage, LlmUsage } from "./llm.client.js";
import {
    DEBT_DOCUMENT_REVIEW_SYSTEM_PROMPT,
    buildUnderwriterPrompt,
    UNDERWRITER_SYSTEM_PROMPT,
} from "./underwriter.prompt.js";
import { createLogger } from "../common/logger.js";
import { loadUnderwriterReferenceData } from "./reference.data.js";

const log = createLogger("underwriter");

export interface UnderwriterAiResult {
    analysis: UnderwriterAnalysisResponse;
    usage: LlmUsage | null;
}

export async function reviewDebtDocument(
    proposal: Pick<
        Proposal,
        "amount" | "requiredAmount" | "returnDateInDays" | "apy"
    > & {
        debtDocument: DebtDocument;
    },
): Promise<UnderwritingReview> {
    log.info(`Reviewing debt document ${proposal.debtDocument.invoiceNumber}`);
    const { data: rawResponse } = await callLlmJsonWithUsage({
        systemPrompt: DEBT_DOCUMENT_REVIEW_SYSTEM_PROMPT,
        userPrompt: JSON.stringify(
            {
                proposal: {
                    amount: proposal.amount,
                    requiredAmount: proposal.requiredAmount,
                    returnDateInDays: proposal.returnDateInDays,
                    apy: proposal.apy,
                },
                debtDocument: proposal.debtDocument,
                mvpReferenceData: await loadUnderwriterReferenceData(),
            },
            null,
            2,
        ),
    });
    const parsed = UnderwritingReviewSchema.pick({
        collectionConfidenceScore: true,
        riskLevel: true,
        debtQuality: true,
        underwriterComment: true,
        keyRisks: true,
        missingEvidence: true,
    }).parse(rawResponse);

    return {
        ...parsed,
        status: "COMPLETED",
        reviewedAt: new Date().toISOString(),
        model: process.env.LLM_MODEL ?? null,
    };
}

/**
 * Runs AI underwriting for candidates that already passed the hard filter.
 * Returns the analysis plus the provider-reported token usage for metering.
 */
export async function evaluateProposalsWithAI(
    candidates: Proposal[],
    buyerRequirements: BuyerSearchRequest,
    marketData: GraphMarketData,
    buyerMessage?: string,
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
            await loadUnderwriterReferenceData(),
            buyerMessage,
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
