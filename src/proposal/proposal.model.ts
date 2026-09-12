import { z } from "zod";
import type { SelfieCheckRecord } from "../world/selfie-check.model.js";

export const ProposalStatusEnum = z.enum(["PENDING", "ACCEPTED"]);
export type ProposalStatus = z.infer<typeof ProposalStatusEnum>;

export const DebtTypeEnum = z.enum([
    "INVOICE",
    "PURCHASE_ORDER",
    "ACCOUNT_RECEIVABLE",
    "CHECK",
    "OTHER",
]);
export type DebtType = z.infer<typeof DebtTypeEnum>;

export const DebtDocumentSchema = z.object({
    debtType: DebtTypeEnum,
    industry: z.string().trim().min(1, "Industry is required"),
    debtorCompany: z.string().trim().min(1, "Debtor company is required"),
    invoiceNumber: z.string().trim().min(1, "Invoice number is required"),
    invoiceDate: z.string().date("Invoice date must be a valid date"),
    dueDate: z.string().date("Due date must be a valid date"),
    faceValue: z.number().positive("Face value must be greater than 0"),
    currency: z.string().trim().min(1).default("USD"),
    purchaseOrderNumber: z.string().trim().min(1).optional(),
    checkNumber: z.string().trim().min(1).optional(),
    jurisdiction: z.string().trim().min(1).optional(),
    disputeStatus: z
        .enum(["NONE_REPORTED", "DISPUTED", "UNKNOWN"])
        .default("UNKNOWN"),
    recourse: z.boolean().optional(),
    collateralDescription: z.string().trim().min(1).optional(),
});
export type DebtDocumentInput = z.infer<typeof DebtDocumentSchema>;

/** Days between two ISO dates (invoice → due). */
export function daysBetween(from: string, to: string): number {
    return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/** Stored debt document = client input + server-derived payment terms. */
export type DebtDocument = DebtDocumentInput & { paymentTermsDays: number };

export const UnderwritingReviewStatusEnum = z.enum(["COMPLETED", "PENDING"]);
export const DebtQualityEnum = z.enum(["A", "B", "C", "DO_NOT_BUY", "UNKNOWN"]);
export const RiskLevelEnum = z.enum(["LOW", "MEDIUM", "HIGH", "UNKNOWN"]);
export type UnderwritingReviewStatus = z.infer<
    typeof UnderwritingReviewStatusEnum
>;
export type DebtQuality = z.infer<typeof DebtQualityEnum>;
export type RiskLevel = z.infer<typeof RiskLevelEnum>;

export const UnderwritingReviewSchema = z.object({
    status: UnderwritingReviewStatusEnum,
    collectionConfidenceScore: z.number().int().min(0).max(100),
    riskLevel: RiskLevelEnum,
    debtQuality: DebtQualityEnum,
    underwriterComment: z.string().trim().min(1),
    keyRisks: z.array(z.string().trim().min(1)).default([]),
    missingEvidence: z.array(z.string().trim().min(1)).default([]),
    reviewedAt: z.string().datetime().nullable(),
    model: z.string().trim().min(1).nullable(),
});
export type UnderwritingReview = z.infer<typeof UnderwritingReviewSchema>;

export const CreateProposalSchema = z
    .object({
        proposerAddress: z
            .string()
            .trim()
            .min(1, "Proposer address is required"),
        requiredAmount: z
            .number()
            .positive("Required amount must be greater than 0"),
        debtDocument: DebtDocumentSchema,
    })
    .refine((data) => data.requiredAmount < data.debtDocument.faceValue, {
        message:
            "Required amount must be strictly less than the document face value to provide a positive yield",
        path: ["requiredAmount"],
    })
    .refine(
        (data) =>
            daysBetween(data.debtDocument.invoiceDate, data.debtDocument.dueDate) > 0,
        {
            message: "Due date must be after the invoice date",
            path: ["debtDocument", "dueDate"],
        },
    );

export type CreateProposalDto = z.infer<typeof CreateProposalSchema>;

/**
 * Proposal economics derive from the debt document — the nominal amount IS the
 * document's face value and the maturity IS the payment terms (invoice → due),
 * so neither can be entered (or mismatched) twice.
 */
export function deriveProposalEconomics(debtDocument: DebtDocumentInput): {
    amount: number;
    returnDateInDays: number;
    paymentTermsDays: number;
    debtDocument: DebtDocument;
} {
    const paymentTermsDays = daysBetween(
        debtDocument.invoiceDate,
        debtDocument.dueDate,
    );
    return {
        amount: debtDocument.faceValue,
        returnDateInDays: paymentTermsDays,
        paymentTermsDays,
        debtDocument: { ...debtDocument, paymentTermsDays },
    };
}

export interface Proposal {
    id: string;
    proposerAddress: string;
    amount: number;
    requiredAmount: number;
    returnDateInDays: number;
    debtDocument: DebtDocument;
    underwritingReview: UnderwritingReview;
    apy: number;
    status: ProposalStatus;
    createdAt: string;
    /**
     * World ID Selfie Check (Beta) verification — abuse-prevention /
     * eligibility signal proving the proposer is a real, live human.
     * Present only after the seller's successful check.
     */
    selfieCheck?: SelfieCheckRecord;
    /** Buyer's Selfie Check signature: the nullifier acts as the buyer's
     *  pseudonymous identity; presence of this record means "signed". */
    buyerSignature?: {
        nullifier: string;
        signedAt: string;
    };
}
