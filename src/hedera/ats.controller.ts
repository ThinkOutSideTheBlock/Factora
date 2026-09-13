/**
 * ATS routes — the main-app bridge to the factored-hedera sidecar.
 * Mounted at /api/ats.
 */
import { Router, Request, Response } from "express";
import { validateBody } from "../common/validate.middleware.js";
import { createLogger } from "../common/logger.js";
import { RegisterReceivableRequestSchema } from "./ats.model.js";
import {
    ApproveAllowanceRequestSchema,
    AuthorizeOperatorRequestSchema,
    ConfirmPaymentRequestSchema,
    ExecuteTradeRequestSchema,
    RedeemRequestSchema,
} from "./ats.model.js";
import {
    AtsRegistrationError,
    approveInvestorAllowance,
    authorizeOperator,
    confirmDebtorPayment,
    executeProposalTrade,
    getMaturityStatus,
    listAtsRegistrations,
    redeemProposal,
    registerProposalAsReceivable,
} from "./ats.service.js";
import {
    getHederaServiceHealth,
    HEDERA_SERVICE_URL,
    HederaServiceError,
} from "./hedera.js";

const log = createLogger("ats");

export const atsRouter = Router();

/**
 * GET /api/ats/health
 * Readiness probe for the ATS test space: reports whether the sidecar is up.
 * Always 200 — `connected` carries the actual state.
 */
atsRouter.get("/health", async (_req: Request, res: Response): Promise<void> => {
    try {
        const health = await getHederaServiceHealth();
        res.status(200).json({
            connected: true,
            service: health.service ?? "factored-hedera",
            serviceUrl: HEDERA_SERVICE_URL,
        });
    } catch (error) {
        res.status(200).json({
            connected: false,
            serviceUrl: HEDERA_SERVICE_URL,
            error: error instanceof Error ? error.message : "unreachable",
        });
    }
});

/**
 * POST /api/ats/receivables
 * ATS lifecycle step 2 — register a confirmed proposal as an on-chain
 * receivable on the sidecar (POST /api/receivables there).
 */
atsRouter.post(
    "/receivables",
    validateBody(RegisterReceivableRequestSchema),
    async (req: Request, res: Response): Promise<void> => {
        try {
            const registration = await registerProposalAsReceivable(req.body);
            res.status(201).json({
                message: "Receivable registered on ATS",
                registration,
            });
        } catch (error) {
            if (error instanceof AtsRegistrationError) {
                res.status(error.statusCode).json({
                    error: error.code,
                    message: error.message,
                });
                return;
            }
            if (error instanceof HederaServiceError) {
                res
                    .status(error.statusCode >= 500 ? 502 : error.statusCode)
                    .json({
                        error: error.code ?? "HEDERA_SERVICE_ERROR",
                        message: error.message,
                    });
                return;
            }
            log.error("Error registering receivable on ATS", error);
            res.status(500).json({ error: "Internal server error" });
        }
    },
);

/**
 * GET /api/ats/registrations
 * All proposals registered on ATS so far (buyer panel feed).
 */
atsRouter.get(
    "/registrations",
    async (_req: Request, res: Response): Promise<void> => {
        try {
            const registrations = await listAtsRegistrations();
            res.status(200).json({
                count: registrations.length,
                registrations,
            });
        } catch (error) {
            log.error("Error listing ATS registrations", error);
            res.status(500).json({ error: "Internal server error" });
        }
    },
);

// ── Steps 3–6 ────────────────────────────────────────────────────────────────

/** Shared error mapping for the lifecycle endpoints. */
function sendAtsError(res: Response, scope: string, error: unknown): void {
    if (error instanceof AtsRegistrationError) {
        res.status(error.statusCode).json({
            error: error.code,
            message: error.message,
        });
        return;
    }
    if (error instanceof HederaServiceError) {
        res.status(error.statusCode >= 500 ? 502 : error.statusCode).json({
            error: error.code ?? "HEDERA_SERVICE_ERROR",
            message: error.message,
        });
        return;
    }
    log.error(`Error in ${scope}`, error);
    res.status(500).json({ error: "Internal server error" });
}

/**
 * POST /api/ats/suppliers/:accountId/authorize-operator
 * ATS lifecycle step 3 — supplier authorizes the FACTORED operator on a
 * security (custodial testnet signing inside the sidecar).
 */
atsRouter.post(
    "/suppliers/:accountId/authorize-operator",
    validateBody(AuthorizeOperatorRequestSchema),
    async (req: Request, res: Response): Promise<void> => {
        try {
            const { registration, result } = await authorizeOperator(
                req.body as { proposalId: string; securityId: string },
            );
            res.status(200).json({
                message: "Operator authorized",
                supplierAccountId: registration.supplierAccountId,
                ...result,
            });
        } catch (error) {
            sendAtsError(res, "authorize-operator", error);
        }
    },
);

/**
 * POST /api/ats/investors/:accountId/approve-usdc-allowance
 * ATS lifecycle step 4 — investor grants the operator a USDC allowance
 * (defaults to the registration's minimum proceeds / purchase price).
 */
atsRouter.post(
    "/investors/:accountId/approve-usdc-allowance",
    validateBody(ApproveAllowanceRequestSchema),
    async (req: Request, res: Response): Promise<void> => {
        try {
            const { registration, result } = await approveInvestorAllowance(
                req.body as {
                    proposalId: string;
                    investorAccountId: string;
                    amountUsd?: number;
                },
            );
            res.status(200).json({
                message:
                    result.mode === "executed"
                        ? "USDC allowance executed on Hedera"
                        : "USDC allowance built but not signed (see mode/message)",
                registration,
                ...result,
            });
        } catch (error) {
            sendAtsError(res, "approve-usdc-allowance", error);
        }
    },
);

/**
 * POST /api/ats/trades/execute
 * ATS lifecycle step 5 — full pipeline: tokenize → issue → KYC → clear note
 * to investor → USDC to supplier → schedule the maturity payout. Returns the
 * settlement result (securityId, scheduleId, transaction ids).
 */
atsRouter.post(
    "/trades/execute",
    validateBody(ExecuteTradeRequestSchema),
    async (req: Request, res: Response): Promise<void> => {
        try {
            const { registration, settlement } =
                await executeProposalTrade(req.body as {
                    proposalId: string;
                    investorAccountId: string;
                    purchasePriceUsd?: number;
                });
            res.status(200).json({
                message: "Trade executed — receivable FUNDED",
                registration,
                settlement,
            });
        } catch (error) {
            sendAtsError(res, "trades/execute", error);
        }
    },
);

/**
 * GET /api/ats/maturity/:proposalId/check
 * ATS lifecycle step 6 — read-only maturity status (proxied from the sidecar).
 */
atsRouter.get(
    "/maturity/:proposalId/check",
    async (req: Request, res: Response): Promise<void> => {
        try {
            const { registration, maturity } = await getMaturityStatus(
                String(req.params.proposalId),
            );
            res.status(200).json({
                ...maturity,
                proposalId: registration.proposalId,
                receivableId: registration.receivableId,
                registrationStatus: registration.status,
            });
        } catch (error) {
            sendAtsError(res, "maturity/check", error);
        }
    },
);

/**
 * POST /api/ats/maturity/:proposalId/confirm-payment
 * ATS lifecycle step 6a — record the debtor's payment (>= face value) and
 * mark the receivable MATURED.
 */
atsRouter.post(
    "/maturity/:proposalId/confirm-payment",
    validateBody(ConfirmPaymentRequestSchema),
    async (req: Request, res: Response): Promise<void> => {
        try {
            const { registration, result } = await confirmDebtorPayment({
                proposalId: String(req.params.proposalId),
                transactionId: req.body.transactionId,
                amountUsd: req.body.amountUsd,
            });
            res.status(200).json({
                message: "Debtor payment confirmed — receivable MATURED",
                proposalId: registration.proposalId,
                receivableId: registration.receivableId,
                result,
            });
        } catch (error) {
            sendAtsError(res, "maturity/confirm-payment", error);
        }
    },
);

/**
 * POST /api/ats/maturity/:proposalId/redeem
 * ATS lifecycle step 6b — redeem at maturity: REDEEMED (investor receives
 * face value on-chain) or DEFAULTED (scheduled payout cancelled).
 */
atsRouter.post(
    "/maturity/:proposalId/redeem",
    validateBody(RedeemRequestSchema),
    async (req: Request, res: Response): Promise<void> => {
        try {
            const { registration, result } = await redeemProposal({
                proposalId: String(req.params.proposalId),
                debtorPaymentConfirmed: req.body.debtorPaymentConfirmed,
                debtorPaymentTransactionId:
                    req.body.debtorPaymentTransactionId,
            });
            res.status(200).json({
                message: `Redemption complete — ${result.redemption.status}`,
                proposalId: registration.proposalId,
                registrationStatus: registration.status,
                result,
            });
        } catch (error) {
            sendAtsError(res, "maturity/redeem", error);
        }
    },
);
