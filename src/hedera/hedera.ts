/**
 * HTTP client for the factored-hedera execution service (the `hedera/` sidecar).
 *
 * The sidecar owns ALL blockchain knowledge (ATS SDK, HTS, HCS). Factora talks
 * to it exclusively over plain HTTP — no @hashgraph/sdk dependency is added to
 * the main app. Every ATS lifecycle step (register receivable, execute trade,
 * maturity redemption) is a thin function here that maps to one sidecar route.
 */
import { createLogger } from "../common/logger.js";

const log = createLogger("hedera");

/** Base URL of the factored-hedera sidecar (see hedera/.env PORT). */
export const HEDERA_SERVICE_URL = (
    process.env.HEDERA_SERVICE_URL ?? "http://localhost:3001"
).replace(/\/+$/, "");

/** Error raised for any non-2xx sidecar response or transport failure. */
export class HederaServiceError extends Error {
    constructor(
        message: string,
        public readonly statusCode: number,
        public readonly code?: string,
    ) {
        super(message);
        this.name = "HederaServiceError";
    }
}

async function hederaFetch<T>(
    path: string,
    init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(),
        init?.timeoutMs ?? 30_000,
    );

    let res: Response;
    try {
        res = await fetch(`${HEDERA_SERVICE_URL}${path}`, {
            ...init,
            headers: {
                "Content-Type": "application/json",
                ...(init?.headers ?? {}),
            },
            signal: controller.signal,
        });
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new HederaServiceError(
            `Hedera service unreachable at ${HEDERA_SERVICE_URL} ` +
                `(start it with: cd hedera && npm run dev) — ${reason}`,
            502,
            "HEDERA_SERVICE_UNREACHABLE",
        );
    } finally {
        clearTimeout(timeout);
    }

    const text = await res.text();
    let body: unknown = undefined;
    if (text) {
        try {
            body = JSON.parse(text);
        } catch {
            body = text;
        }
    }

    if (!res.ok) {
        const err = body as { error?: string; message?: string } | undefined;
        throw new HederaServiceError(
            err?.message ?? err?.error ?? `Hedera service returned ${res.status}`,
            res.status,
            err?.error,
        );
    }

    return body as T;
}

// ── Health ─────────────────────────────────────────────────────────────────

export interface HederaServiceHealth {
    ok: boolean;
    service?: string;
}

/**
 * GET /health on the sidecar. Throws HederaServiceError when unreachable —
 * or when something ELSE is listening on HEDERA_SERVICE_URL (e.g. a second
 * Factora instance): the factored-hedera sidecar identifies itself with
 * `{ ok: true, service: "factored-hedera" }`, and anything else must not be
 * mistaken for it.
 */
export async function getHederaServiceHealth(): Promise<HederaServiceHealth> {
    const body = await hederaFetch<HederaServiceHealth>("/health", {
        timeoutMs: 5_000,
    });
    if (body?.ok !== true || body?.service !== "factored-hedera") {
        throw new HederaServiceError(
            `Something other than the factored-hedera sidecar is listening on ` +
                `${HEDERA_SERVICE_URL} (got ${JSON.stringify(body)}). ` +
                `Start the sidecar with: cd hedera && PORT=3001 npm run dev`,
            502,
            "HEDERA_SERVICE_MISMATCH",
        );
    }
    return body;
}

// ── Step 2: register a proposal as an on-chain receivable ──────────────────

export interface RegisterReceivableInput {
    debtorName: string;
    faceValueUsd: number;
    /** Unix seconds; must be in the future (sidecar validates). */
    maturityTimestamp: number;
    supplierAccountId: string;
    minimumProceedsUsd: number;
    maximumDiscountBps?: number;
    invoiceHash?: string;
}

export interface HederaReceivable {
    id: string;
    supplierAccountId: string;
    debtorName: string;
    faceValueUsd: number;
    minimumProceedsUsd: number;
    maturityTimestamp: number;
    status: string;
    securityId?: string;
    [key: string]: unknown;
}

/**
 * POST /api/receivables on the sidecar — registers the receivable so the ATS
 * lifecycle (tokenize → settle → redeem) can be driven against it later.
 */
export async function registerReceivableAts(
    input: RegisterReceivableInput,
): Promise<HederaReceivable> {
    log.info(
        `Registering receivable on ATS: debtor="${input.debtorName}" ` +
            `face=$${input.faceValueUsd} supplier=${input.supplierAccountId}`,
    );

    const receivable = await hederaFetch<HederaReceivable>(
        "/api/receivables",
        {
            method: "POST",
            body: JSON.stringify({
                debtor: { name: input.debtorName },
                faceValueUsd: input.faceValueUsd,
                maturityTimestamp: input.maturityTimestamp,
                supplierAccountId: input.supplierAccountId,
                minimumProceedsUsd: input.minimumProceedsUsd,
                ...(input.maximumDiscountBps !== undefined
                    ? { maximumDiscountBps: input.maximumDiscountBps }
                    : {}),
                ...(input.invoiceHash
                    ? { documents: { invoiceHash: input.invoiceHash } }
                    : {}),
            }),
        },
    );

    log.info(
        `Receivable registered on ATS: id=${receivable.id} status=${receivable.status}`,
    );
    return receivable;
}

// ── Step 3: supplier authorizes the FACTORED operator (once per security) ────

export interface AuthorizeOperatorResult {
    authorized: boolean;
    transactionId?: string;
    [key: string]: unknown;
}

/**
 * POST /api/suppliers/:accountId/authorize-operator on the sidecar.
 * Custodial testnet mode — the supplier key comes from the sidecar env
 * (TEST_SUPPLIER_PRIVATE_KEY). The execute pipeline also self-authorizes when
 * missing; this is the explicit pre-authorization / readiness check.
 */
export async function authorizeOperatorAts(
    supplierAccountId: string,
    securityId: string,
): Promise<AuthorizeOperatorResult> {
    log.info(
        `Authorizing FACTORED operator for supplier=${supplierAccountId} security=${securityId}`,
    );
    return hederaFetch<AuthorizeOperatorResult>(
        `/api/suppliers/${encodeURIComponent(supplierAccountId)}/authorize-operator`,
        { method: "POST", body: JSON.stringify({ securityId }) },
    );
}

// ── Step 4: investor USDC allowance to the operator ──────────────────────────

export interface ApproveAllowanceResult {
    ok: boolean;
    mode: string;
    transactionId?: string;
    status?: string;
    spenderAccountId?: string;
    tokenId?: string;
    amountUsd?: number;
    message?: string;
    [key: string]: unknown;
}

/**
 * POST /api/investors/:accountId/approve-usdc-allowance on the sidecar.
 * With TEST_INVESTOR_PRIVATE_KEY set on the sidecar this signs and executes
 * the AccountAllowanceApproveTransaction on testnet (mode "executed");
 * otherwise it returns mode "unsigned" with instructions.
 */
export async function approveInvestorAllowanceAts(
    investorAccountId: string,
    amountUsd: number,
): Promise<ApproveAllowanceResult> {
    log.info(
        `Approving USDC allowance: investor=${investorAccountId} amount=$${amountUsd}`,
    );
    return hederaFetch<ApproveAllowanceResult>(
        `/api/investors/${encodeURIComponent(investorAccountId)}/approve-usdc-allowance`,
        { method: "POST", body: JSON.stringify({ amountUsd }) },
    );
}

// ── Step 5: execute the trade (tokenize → issue → KYC → clear → USDC) ────────

export interface TradeConfirmation {
    offerId: string;
    accountId: string;
    priceUsd: number;
    ts?: number;
}

export interface ExecuteTradeInput {
    receivableId: string;
    supplierAccountId: string;
    investorAccountId: string;
    faceValueUsd: number;
    purchasePriceUsd: number;
    maturityTimestamp: number;
    riskGrade: string;
    debtorName: string;
    isin: string;
    supplierConfirmation: TradeConfirmation;
    investorConfirmation: TradeConfirmation;
}

export interface SettlementResult {
    receivableId: string;
    securityId: string;
    purchasePriceUsd: number;
    tokenizationTxId: string;
    issuanceTxId: string;
    clearingTransferTxId?: string;
    clearingApprovalTxId?: string;
    cashTransferTxId?: string;
    auditTxIds: string[];
    status: string;
    scheduleId?: string;
    [key: string]: unknown;
}

/**
 * POST /api/trades/execute on the sidecar — the full DvP pipeline:
 * tokenize → issue to supplier → bootstrap security → operator auth →
 * KYC both parties → clear note to investor → USDC to supplier →
 * schedule the maturity payout.
 */
export async function executeTradeAts(
    input: ExecuteTradeInput,
): Promise<SettlementResult> {
    log.info(
        `Executing ATS trade: receivable=${input.receivableId} ` +
            `supplier=${input.supplierAccountId} investor=${input.investorAccountId} ` +
            `price=$${input.purchasePriceUsd}`,
    );
    const result = await hederaFetch<SettlementResult>("/api/trades/execute", {
        method: "POST",
        body: JSON.stringify(input),
        timeoutMs: 120_000, // full on-chain pipeline — allow time
    });
    log.info(
        `ATS trade executed: receivable=${result.receivableId} ` +
            `security=${result.securityId} schedule=${result.scheduleId ?? "n/a"}`,
    );
    return result;
}

// ── Step 6: maturity lifecycle ───────────────────────────────────────────────

export interface MaturityCheckResult {
    receivableId: string;
    maturityReached: boolean;
    debtorPayment: { confirmed: boolean };
    redemptionEligible: boolean;
    status: string;
    [key: string]: unknown;
}

/** POST /api/maturity/:receivableId/check on the sidecar (read-only). */
export async function checkMaturityAts(
    receivableId: string,
): Promise<MaturityCheckResult> {
    return hederaFetch<MaturityCheckResult>(
        `/api/maturity/${encodeURIComponent(receivableId)}/check`,
        { method: "POST" },
    );
}

export interface ConfirmPaymentResult {
    [key: string]: unknown;
}

/**
 * POST /api/maturity/:receivableId/confirm-payment on the sidecar.
 * Marks the receivable MATURED once the debtor's payment (>= face value) is
 * confirmed with an off-chain transaction reference.
 */
export async function confirmDebtorPaymentAts(
    receivableId: string,
    input: { transactionId: string; amountUsd: number },
): Promise<ConfirmPaymentResult> {
    log.info(
        `Confirming debtor payment for ${receivableId}: tx=${input.transactionId} amount=$${input.amountUsd}`,
    );
    return hederaFetch<ConfirmPaymentResult>(
        `/api/maturity/${encodeURIComponent(receivableId)}/confirm-payment`,
        { method: "POST", body: JSON.stringify(input) },
    );
}

export interface RedeemResult {
    receivableId: string;
    securityId: string;
    redemption: {
        status: "REDEEMED" | "DEFAULTED";
        redemptionTransactionId?: string;
        auditTransactionId?: string;
        cancelledScheduleId?: string;
        [key: string]: unknown;
    };
    receivable: { status: string; [key: string]: unknown };
    [key: string]: unknown;
}

/**
 * POST /api/maturity/:receivableId/redeem on the sidecar.
 * Debtor paid → Bond.fullRedeemAtMaturity (investor receives face value).
 * Debtor unpaid → DEFAULTED and the scheduled payout is cancelled.
 */
export async function redeemAts(
    receivableId: string,
    input: {
        debtorPaymentConfirmed?: boolean;
        debtorPaymentTransactionId?: string;
    } = {},
): Promise<RedeemResult> {
    log.info(`Redeeming receivable ${receivableId} at maturity`);
    return hederaFetch<RedeemResult>(
        `/api/maturity/${encodeURIComponent(receivableId)}/redeem`,
        { method: "POST", body: JSON.stringify(input), timeoutMs: 120_000 },
    );
}
