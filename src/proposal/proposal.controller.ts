import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import {
    CreateProposalDto,
    CreateProposalSchema,
    Proposal,
} from "./proposal.model.js";
import { deriveProposalEconomics } from "./proposal.model.js";
import { addProposal, getAllProposals } from "./proposal.storage.js";
import { validateBody } from "../common/validate.middleware.js";
import { createLogger } from "../common/logger.js";
import { reviewDebtDocument } from "../underwriter/underwriter.agent.js";

const log = createLogger("proposal");

export const proposalRouter = Router();

/**
 * Calculates APY percentage based on debt nominal amount, required cash, and duration.
 * APY = ((amount - requiredAmount) / requiredAmount) * (365 / returnDateInDays) * 100
 */
export function calculateApy(
    amount: number,
    requiredAmount: number,
    returnDateInDays: number,
): number {
    if (requiredAmount <= 0 || returnDateInDays <= 0) {
        return 0;
    }
    const yieldRatio = (amount - requiredAmount) / requiredAmount;
    const annualized = yieldRatio * (365 / returnDateInDays) * 100;
    return Number(annualized.toFixed(2));
}

/**
 * POST /api/proposals
 * Create a new debt proposal.
 */
proposalRouter.post(
    "/",
    validateBody(CreateProposalSchema),
    async (req: Request, res: Response): Promise<void> => {
        try {
            const { proposerAddress, requiredAmount, debtDocument } =
                req.body as CreateProposalDto;

            // Proposal economics derive from the debt document — single source
            // of truth (nominal = face value; maturity = invoice → due terms).
            const { amount, returnDateInDays, debtDocument: normalizedDocument } =
                deriveProposalEconomics(debtDocument);
            const apy = calculateApy(amount, requiredAmount, returnDateInDays);

            const newProposal: Proposal = {
                id: uuidv4(),
                proposerAddress,
                amount,
                requiredAmount,
                returnDateInDays,
                debtDocument: normalizedDocument,
                underwritingReview: {
                    status: "PENDING",
                    collectionConfidenceScore: 0,
                    riskLevel: "UNKNOWN",
                    debtQuality: "UNKNOWN",
                    underwriterComment: "Debt document review is pending.",
                    keyRisks: [],
                    missingEvidence: [],
                    reviewedAt: null,
                    model: null,
                },
                apy,
                status: "PENDING",
                createdAt: new Date().toISOString(),
            };

            try {
                newProposal.underwritingReview =
                    await reviewDebtDocument(newProposal);
                log.info(
                    `Debt document review completed: id=${newProposal.id} risk=${newProposal.underwritingReview.riskLevel} quality=${newProposal.underwritingReview.debtQuality}`,
                );
            } catch (error) {
                log.warn(
                    `Debt document review pending: id=${newProposal.id}`,
                    error,
                );
                newProposal.underwritingReview.underwriterComment =
                    "AI review could not be completed. Treat this debt as unreviewed until evidence is assessed.";
                newProposal.underwritingReview.keyRisks = [
                    "AI review unavailable or invalid.",
                ];
                newProposal.underwritingReview.missingEvidence = [
                    "Completed underwriting review.",
                ];
            }

            const savedProposal = await addProposal(newProposal);
            log.info(
                `Proposal created: id=${savedProposal.id} apy=${apy}% faceValue=${amount} advance=${requiredAmount} terms=${returnDateInDays}d proposer=${proposerAddress}`,
            );
            res.status(201).json({
                message: "Proposal created successfully",
                proposal: savedProposal,
            });
        } catch (error) {
            log.error("Error creating proposal", error);
            res.status(500).json({
                error: "Internal server error while creating proposal",
            });
        }
    },
);

/**
 * GET /api/proposals
 * Fetch list of proposals (optional filter by ?status=PENDING).
 */
proposalRouter.get("/", async (req: Request, res: Response): Promise<void> => {
    try {
        const statusQuery = req.query.status as string | undefined;
        const proposals = await getAllProposals();

        if (statusQuery) {
            const filtered = proposals.filter(
                (p) => p.status.toUpperCase() === statusQuery.toUpperCase(),
            );
            res.status(200).json({
                count: filtered.length,
                proposals: filtered,
            });
            return;
        }

        res.status(200).json({ count: proposals.length, proposals });
    } catch (error) {
        log.error("Error fetching proposals", error);
        res.status(500).json({
            error: "Internal server error while retrieving proposals",
        });
    }
});
