import { z } from "zod";

/**
 * Hedera account id, e.g. `0.0.10446661`. Used for ATS parties (supplier /
 * investor) — distinct from the EVM addresses used by the x402 gate.
 */
export const HederaAccountIdSchema = z
    .string()
    .trim()
    .regex(/^0\.0\.\d{1,19}$/, "Must be a Hedera account id in the form 0.0.12345");

/**
 * POST /api/ats/receivables — register a Factora proposal as an on-chain
 * receivable on the factored-hedera sidecar (ATS lifecycle step 2).
 */
export const RegisterReceivableRequestSchema = z.object({
    proposalId: z.string().trim().min(1, "proposalId is required"),
    supplierAccountId: HederaAccountIdSchema,
    minimumProceedsUsd: z.number().positive().optional(),
    /**
     * Testnet escape hatch: register a proposal that has not completed the
     * buyer signature + seller selfie check yet. Never enable in production.
     */
    force: z.boolean().optional(),
});

export type RegisterReceivableRequestDto = z.infer<
    typeof RegisterReceivableRequestSchema
>;

/**
 * Lifecycle of an ATS registration. `REGISTERED` is created by step 2; the
 * later steps (tokenize/execute, maturity) upgrade the status in place.
 */
export type AtsRegistrationStatus =
    | "REGISTERED"
    | "TOKENIZED"
    | "FUNDED"
    | "REDEEMED"
    | "DEFAULTED";

/** Local record linking a Factora proposal to its sidecar receivable. */
export interface AtsRegistration {
    id: string;
    proposalId: string;
    /** `REC-<ts>-<rand>` id inside the factored-hedera service. */
    receivableId: string;
    supplierAccountId: string;
    debtorName: string;
    invoiceNumber: string;
    faceValueUsd: number;
    minimumProceedsUsd: number;
    /** Unix seconds — derived from the proposal's debt document due date. */
    maturityTimestamp: number;
    status: AtsRegistrationStatus;
    registeredAt: string;
    /** Filled by later lifecycle steps (tokenization / execution). */
    securityId?: string;
    investorAccountId?: string;
    payoutScheduleId?: string;
    /** Deterministic ISIN generated for the trade; reused across re-runs. */
    isin?: string;
    /** Result of the step-4 investor USDC allowance approval. */
    usdcAllowance?: {
        amountUsd: number;
        mode: string;
        transactionId?: string;
        approvedAt: string;
    };
}

// ── Step 3: operator authorization ───────────────────────────────────────────

export const AuthorizeOperatorRequestSchema = z.object({
    proposalId: z.string().trim().min(1, "proposalId is required"),
    /**
     * The security to authorize against. Execution creates its own security
     * and self-authorizes; this explicit step is for pre-existing securities
     * (e.g. the sidecar testnet fixture 0.0.10446844).
     */
    securityId: z.string().trim().min(1, "securityId is required"),
});

export type AuthorizeOperatorRequestDto = z.infer<
    typeof AuthorizeOperatorRequestSchema
>;

// ── Step 4: investor USDC allowance ──────────────────────────────────────────

export const ApproveAllowanceRequestSchema = z.object({
    proposalId: z.string().trim().min(1, "proposalId is required"),
    investorAccountId: HederaAccountIdSchema,
    /** Defaults to the registration's minimum proceeds (the purchase price). */
    amountUsd: z.number().positive().optional(),
});

export type ApproveAllowanceRequestDto = z.infer<
    typeof ApproveAllowanceRequestSchema
>;

// ── Step 5: trade execution ──────────────────────────────────────────────────

export const ExecuteTradeRequestSchema = z.object({
    proposalId: z.string().trim().min(1, "proposalId is required"),
    investorAccountId: HederaAccountIdSchema,
    /** Defaults to the registration's minimum proceeds (the purchase price). */
    purchasePriceUsd: z.number().positive().optional(),
});

export type ExecuteTradeRequestDto = z.infer<typeof ExecuteTradeRequestSchema>;

// ── Step 6: maturity ─────────────────────────────────────────────────────────

export const ConfirmPaymentRequestSchema = z.object({
    transactionId: z.string().trim().min(1, "transactionId is required"),
    amountUsd: z.number().positive("amountUsd must be positive"),
});

export type ConfirmPaymentRequestDto = z.infer<
    typeof ConfirmPaymentRequestSchema
>;

export const RedeemRequestSchema = z.object({
    debtorPaymentConfirmed: z.boolean().optional(),
    debtorPaymentTransactionId: z.string().trim().min(1).optional(),
});

export type RedeemRequestDto = z.infer<typeof RedeemRequestSchema>;
