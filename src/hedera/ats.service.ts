/**
 * ATS orchestration — maps Factora proposals onto the factored-hedera
 * receivable lifecycle and keeps a local record of each registration.
 */
import { v4 as uuidv4 } from "uuid";
import { createLogger } from "../common/logger.js";
import { getAllProposals } from "../proposal/proposal.storage.js";
import { Proposal } from "../proposal/proposal.model.js";
import { registerReceivableAts } from "./hedera.js";
import {
    ApproveAllowanceResult,
    approveInvestorAllowanceAts,
    AuthorizeOperatorResult,
    authorizeOperatorAts,
    checkMaturityAts,
    ConfirmPaymentResult,
    confirmDebtorPaymentAts,
    executeTradeAts,
    MaturityCheckResult,
    redeemAts,
    RedeemResult,
} from "./hedera.js";
import { AtsRegistration } from "./ats.model.js";
import {
    addAtsRegistration,
    findAtsRegistrationByProposalId,
    getAtsRegistrations,
    updateAtsRegistration,
} from "./ats.storage.js";

const log = createLogger("ats");

/** Domain error with an HTTP status + machine-readable code. */
export class AtsRegistrationError extends Error {
    constructor(
        message: string,
        public readonly statusCode: number,
        public readonly code: string,
    ) {
        super(message);
        this.name = "AtsRegistrationError";
    }
}

/**
 * A proposal is fully confirmed when the buyer has signed (selfie nullifier)
 * and the seller passed their selfie check — the exact gate the ATS flow
 * requires before anything is tokenized.
 */
function proposalIsFullyConfirmed(proposal: Proposal): boolean {
    return (
        proposal.status === "ACCEPTED" &&
        Boolean(proposal.buyerSignature) &&
        Boolean(proposal.selfieCheck)
    );
}

/** Debt documents store due dates as ISO dates (`YYYY-MM-DD`). */
function dueDateToUnixSeconds(dueDate: string): number {
    const parsed = Date.parse(`${dueDate}T23:59:59Z`);
    if (Number.isNaN(parsed)) {
        throw new AtsRegistrationError(
            `Proposal due date "${dueDate}" is not a valid ISO date`,
            422,
            "INVALID_DUE_DATE",
        );
    }
    return Math.floor(parsed / 1000);
}

export interface RegisterProposalAsReceivableInput {
    proposalId: string;
    supplierAccountId: string;
    minimumProceedsUsd?: number;
    force?: boolean;
}

/**
 * ATS lifecycle step 2 — register a proposal as an on-chain receivable.
 *
 * Guards:
 *  - proposal must exist
 *  - one receivable per proposal (unless `force` re-registers)
 *  - proposal must be fully confirmed (buyer signature + seller selfie check)
 *    unless `force` is set (testnet demo escape hatch)
 *  - minimum proceeds must stay below the face value (positive yield)
 *
 * On success the sidecar returns a `REC-*` receivable (status LISTED) which we
 * link back to the proposal via an AtsRegistration record.
 */
export async function registerProposalAsReceivable(
    input: RegisterProposalAsReceivableInput,
): Promise<AtsRegistration> {
    const proposals = await getAllProposals();
    const proposal = proposals.find((p) => p.id === input.proposalId);
    if (!proposal) {
        throw new AtsRegistrationError(
            `Proposal ${input.proposalId} not found`,
            404,
            "PROPOSAL_NOT_FOUND",
        );
    }

    const existing = await findAtsRegistrationByProposalId(proposal.id);
    if (existing && !input.force) {
        throw new AtsRegistrationError(
            `Proposal ${proposal.id} is already registered on ATS ` +
                `(receivableId=${existing.receivableId})`,
            409,
            "ALREADY_REGISTERED",
        );
    }

    if (!input.force && !proposalIsFullyConfirmed(proposal)) {
        throw new AtsRegistrationError(
            "Proposal is not fully confirmed yet: it needs status ACCEPTED, " +
                "the buyer's signature, and the seller's selfie check",
            409,
            "PROPOSAL_NOT_CONFIRMED",
        );
    }

    const faceValueUsd = proposal.debtDocument.faceValue;
    const minimumProceedsUsd =
        input.minimumProceedsUsd ?? proposal.requiredAmount;
    if (minimumProceedsUsd >= faceValueUsd) {
        throw new AtsRegistrationError(
            `Minimum proceeds ($${minimumProceedsUsd}) must be strictly below ` +
                `the face value ($${faceValueUsd}) to keep a positive yield`,
            422,
            "MINIMUM_PROCEEDS_EXCEEDS_FACE_VALUE",
        );
    }

    const maturityTimestamp = dueDateToUnixSeconds(
        proposal.debtDocument.dueDate,
    );

    const receivable = await registerReceivableAts({
        debtorName: proposal.debtDocument.debtorCompany,
        faceValueUsd,
        maturityTimestamp,
        supplierAccountId: input.supplierAccountId,
        minimumProceedsUsd,
        invoiceHash: `factora-${proposal.id}`,
    });

    const registration: AtsRegistration = {
        id: uuidv4(),
        proposalId: proposal.id,
        receivableId: receivable.id,
        supplierAccountId: input.supplierAccountId,
        debtorName: proposal.debtDocument.debtorCompany,
        invoiceNumber: proposal.debtDocument.invoiceNumber,
        faceValueUsd,
        minimumProceedsUsd,
        maturityTimestamp,
        status: "REGISTERED",
        registeredAt: new Date().toISOString(),
        securityId: receivable.securityId,
    };
    await addAtsRegistration(registration);

    log.info(
        `Proposal registered as ATS receivable: proposal=${proposal.id} ` +
            `receivable=${receivable.id} face=$${faceValueUsd} ` +
            `supplier=${input.supplierAccountId}`,
    );
    return registration;
}

/** List all ATS registrations (buyer panel feed). */
export async function listAtsRegistrations(): Promise<AtsRegistration[]> {
    return getAtsRegistrations();
}

// ── Step 3: supplier authorizes the FACTORED operator ────────────────────────

export interface AuthorizeOperatorInput {
    proposalId: string;
    securityId: string;
}

/**
 * ATS lifecycle step 3 — supplier authorizes the FACTORED operator on a
 * security (custodial testnet: signed with the sidecar's TEST_SUPPLIER_KEY).
 * The execute pipeline self-authorizes when missing, so this explicit step is
 * optional but keeps the lifecycle auditable and surfaces key problems early.
 */
export async function authorizeOperator(
    input: AuthorizeOperatorInput,
): Promise<{ registration: AtsRegistration; result: AuthorizeOperatorResult }> {
    const registration = await requireRegistration(input.proposalId);
    const result = await authorizeOperatorAts(
        registration.supplierAccountId,
        input.securityId,
    );
    log.info(
        `Operator authorized: proposal=${input.proposalId} ` +
            `security=${input.securityId} tx=${result.transactionId ?? "n/a"}`,
    );
    return { registration, result };
}

// ── Step 4: investor USDC allowance ──────────────────────────────────────────

export interface ApproveAllowanceInput {
    proposalId: string;
    investorAccountId: string;
    amountUsd?: number;
}

/**
 * ATS lifecycle step 4 — the investor grants the FACTORED operator a USDC
 * allowance (the money-movement boundary for settlement). With the sidecar's
 * TEST_INVESTOR_PRIVATE_KEY set this executes on testnet (mode "executed");
 * otherwise the sidecar returns mode "unsigned" with wallet instructions.
 */
export async function approveInvestorAllowance(
    input: ApproveAllowanceInput,
): Promise<{ registration: AtsRegistration; result: ApproveAllowanceResult }> {
    const registration = await requireRegistration(input.proposalId);
    const amountUsd = input.amountUsd ?? registration.minimumProceedsUsd;

    const result = await approveInvestorAllowanceAts(
        input.investorAccountId,
        amountUsd,
    );

    const updated = await updateAtsRegistration(registration.id, {
        investorAccountId: input.investorAccountId,
        usdcAllowance: {
            amountUsd,
            mode: String(result.mode ?? "unknown"),
            transactionId: result.transactionId,
            approvedAt: new Date().toISOString(),
        },
    });

    log.info(
        `USDC allowance: proposal=${input.proposalId} investor=${input.investorAccountId} ` +
            `amount=$${amountUsd} mode=${result.mode}`,
    );
    return { registration: updated, result };
}

// ── Shared helpers ───────────────────────────────────────────────────────────

async function requireRegistration(
    proposalId: string,
): Promise<AtsRegistration> {
    const registration = await findAtsRegistrationByProposalId(proposalId);
    if (!registration) {
        throw new AtsRegistrationError(
            `Proposal ${proposalId} is not registered on ATS yet (step 2 first)`,
            404,
            "NOT_REGISTERED",
        );
    }
    return registration;
}

// ── Step 5: execute the trade (tokenize → settle → schedule payout) ──────────

export interface ExecuteProposalTradeInput {
    proposalId: string;
    investorAccountId: string;
    purchasePriceUsd?: number;
}

/**
 * ATS lifecycle step 5 — run the full sidecar DvP pipeline for a registered
 * receivable. Builds the dual-confirmation trade payload (both parties must
 * confirm the same offer at the same price — synthesized deterministically
 * from the proposal), generates a stable ISIN, executes, and persists the
 * outcome (securityId, scheduleId, status FUNDED) onto the registration.
 */
export async function executeProposalTrade(
    input: ExecuteProposalTradeInput,
): Promise<{ registration: AtsRegistration; settlement: unknown }> {
    const registration = await requireRegistration(input.proposalId);

    if (registration.status !== "REGISTERED") {
        throw new AtsRegistrationError(
            `Proposal ${input.proposalId} is already past execution ` +
                `(status ${registration.status})`,
            409,
            registration.status === "FUNDED" ||
                registration.status === "TOKENIZED"
                ? "ALREADY_EXECUTED"
                : "TRADE_CLOSED",
        );
    }

    const purchasePriceUsd =
        input.purchasePriceUsd ?? registration.minimumProceedsUsd;
    if (purchasePriceUsd >= registration.faceValueUsd) {
        throw new AtsRegistrationError(
            `Purchase price ($${purchasePriceUsd}) must be strictly below ` +
                `the face value ($${registration.faceValueUsd})`,
            422,
            "PURCHASE_PRICE_EXCEEDS_FACE_VALUE",
        );
    }

    // Stable per-proposal ISIN so re-runs reuse the same identifier.
    const isin = registration.isin ?? generateIsin(registration.proposalId);

    // The anti-fraud gate requires both confirmations to reference the SAME
    // offer at the SAME price with their own accounts — synthesized here from
    // the accepted proposal (the Factora-level confirmation is the selfie +
    // signature gate that has already passed).
    const offerId = `OFFER-${registration.proposalId}`;
    const ts = Date.now();

    const settlement = await executeTradeAts({
        receivableId: registration.receivableId,
        supplierAccountId: registration.supplierAccountId,
        investorAccountId: input.investorAccountId,
        faceValueUsd: registration.faceValueUsd,
        purchasePriceUsd,
        maturityTimestamp: registration.maturityTimestamp,
        riskGrade: await resolveRiskGrade(registration),
        debtorName: registration.debtorName,
        isin,
        supplierConfirmation: {
            offerId,
            accountId: registration.supplierAccountId,
            priceUsd: purchasePriceUsd,
            ts,
        },
        investorConfirmation: {
            offerId,
            accountId: input.investorAccountId,
            priceUsd: purchasePriceUsd,
            ts,
        },
    });

    const updated = await updateAtsRegistration(registration.id, {
        securityId: settlement.securityId,
        investorAccountId: input.investorAccountId,
        payoutScheduleId: settlement.scheduleId,
        isin,
        status: "FUNDED",
    });

    log.info(
        `Trade executed for proposal=${input.proposalId}: ` +
            `security=${settlement.securityId} schedule=${settlement.scheduleId ?? "n/a"} ` +
            `status=FUNDED`,
    );
    return { registration: updated, settlement };
}

/**
 * Risk grade for the note: the AI underwriter's debt quality (A/B/C) when
 * available, "UNRATED" otherwise. "DO_NOT_BUY" proposals are blocked — the
 * underwriter explicitly rejected them.
 */
async function resolveRiskGrade(
    registration: AtsRegistration,
): Promise<string> {
    const proposals = await getAllProposals();
    const proposal = proposals.find((p) => p.id === registration.proposalId);
    const quality = proposal?.underwritingReview?.debtQuality;
    if (quality === "DO_NOT_BUY") {
        throw new AtsRegistrationError(
            `Proposal ${registration.proposalId} was rated DO_NOT_BUY by the ` +
                "underwriter and cannot be executed",
            403,
            "UNDERWRITER_REJECTED",
        );
    }
    return quality === "A" || quality === "B" || quality === "C"
        ? quality
        : "UNRATED";
}

/**
 * Deterministic, regex-valid ISIN (`^[A-Z]{2}[A-Z0-9]{9}[0-9]$`) derived from
 * the proposal id, with a correct Luhn check digit.
 */
export function generateIsin(seed: string): string {
    const clean = seed.replace(/[^a-zA-Z0-9]/g, "").toUpperCase() || "FACTORA";
    const alphabet = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O
    let nsin = "";
    for (let i = 0; i < 9; i++) {
        nsin += alphabet[clean.charCodeAt(i % clean.length) % alphabet.length];
    }
    const partial = `US${nsin}`;
    return partial + isinCheckDigit(partial);
}

/** Standard ISIN check digit (Luhn over the letter-expanded partial). */
function isinCheckDigit(partial: string): string {
    let digits = "";
    for (const ch of partial) {
        digits +=
            ch >= "0" && ch <= "9"
                ? ch
                : String(ch.toUpperCase().charCodeAt(0) - 55); // A=10 … Z=35
    }
    let sum = 0;
    let double = true; // double every digit starting from the rightmost
    for (let i = digits.length - 1; i >= 0; i--) {
        let d = Number(digits[i]);
        if (double) {
            d *= 2;
            if (d > 9) d -= 9;
        }
        sum += d;
        double = !double;
    }
    return String((10 - (sum % 10)) % 10);
}

// ── Step 6: maturity lifecycle ───────────────────────────────────────────────

/** Read-only maturity status for a registered proposal. */
export async function getMaturityStatus(proposalId: string): Promise<{
    registration: AtsRegistration;
    maturity: MaturityCheckResult;
}> {
    const registration = await requireRegistration(proposalId);
    const maturity = await checkMaturityAts(registration.receivableId);
    return { registration, maturity };
}

export interface ConfirmDebtorPaymentInput {
    proposalId: string;
    transactionId: string;
    amountUsd: number;
}

/**
 * ATS lifecycle step 6a — record the debtor's payment (must be >= face value).
 * Marks the sidecar receivable MATURED, unlocking redemption.
 */
export async function confirmDebtorPayment(
    input: ConfirmDebtorPaymentInput,
): Promise<{ registration: AtsRegistration; result: ConfirmPaymentResult }> {
    const registration = await requireRegistration(input.proposalId);
    const result = await confirmDebtorPaymentAts(registration.receivableId, {
        transactionId: input.transactionId,
        amountUsd: input.amountUsd,
    });
    log.info(
        `Debtor payment confirmed: proposal=${input.proposalId} ` +
            `tx=${input.transactionId} amount=$${input.amountUsd}`,
    );
    return { registration, result };
}

export interface RedeemProposalInput {
    proposalId: string;
    debtorPaymentConfirmed?: boolean;
    debtorPaymentTransactionId?: string;
}

/**
 * ATS lifecycle step 6b — redeem at maturity. Debtor paid → the investor
 * receives face value on-chain (REDEEMED). Debtor unpaid → DEFAULTED and the
 * scheduled payout is cancelled. The registration status is updated to match.
 */
export async function redeemProposal(
    input: RedeemProposalInput,
): Promise<{ registration: AtsRegistration; result: RedeemResult }> {
    const registration = await requireRegistration(input.proposalId);
    const result = await redeemAts(registration.receivableId, {
        ...(input.debtorPaymentConfirmed !== undefined
            ? { debtorPaymentConfirmed: input.debtorPaymentConfirmed }
            : {}),
        ...(input.debtorPaymentTransactionId
            ? { debtorPaymentTransactionId: input.debtorPaymentTransactionId }
            : {}),
    });

    const nextStatus =
        result.redemption?.status === "REDEEMED" ? "REDEEMED" : "DEFAULTED";
    const updated = await updateAtsRegistration(registration.id, {
        status: nextStatus,
    });

    log.info(
        `Redemption complete: proposal=${input.proposalId} status=${nextStatus} ` +
            `tx=${result.redemption?.redemptionTransactionId ?? "n/a"}`,
    );
    return { registration: updated, result };
}
