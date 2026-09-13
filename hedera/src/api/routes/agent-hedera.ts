import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AccountId, Client, PrivateKey } from "@hashgraph/sdk";

import { env } from "../../infrastructure/hedera/config.js";
import { initializeATS } from "../../infrastructure/hedera/ats/ats.js";
import {
    resolveAccountEvmAddress,
    resolveContractEvmAddress,
} from "../../infrastructure/hedera/ats/kycCredential.js";
import {
    authorizeOperatorFromEnv,
    SupplierNotAuthorizedError,
} from "../../infrastructure/hedera/ats/authorize-operator.js";
import {
    executeApprovedTrade,
    HederaExecutionNotReadyError,
} from "../../infrastructure/hedera/settlement/settlement.js";
import { buildInvestorUsdcAllowance } from "../../infrastructure/hedera/hts/usdc.js";
import { InMemoryStore } from "../services/store.js";
import type { ApprovedTrade } from "../../infrastructure/hedera/types.js";

const confirmSchema = z.object({
    offerId: z.string().min(1),
    priceUsd: z.number().positive(),
    accountId: z.string().min(1),
    ts: z.number().optional(),
});

const executeBodySchema = z.object({
    receivableId: z.string().min(1),
    supplierAccountId: z.string().min(1),
    investorAccountId: z.string().min(1),
    faceValueUsd: z.number().positive(),
    purchasePriceUsd: z.number().positive(),
    maturityTimestamp: z.number().int().positive(),
    riskGrade: z.string().min(1),
    debtorName: z.string().min(1),
    isin: z.string().min(1),
    supplierConfirmation: confirmSchema,
    investorConfirmation: confirmSchema,
    throughClearingOnly: z.boolean().optional(),
});

function assertDealConfirmed(
    supplier: z.infer<typeof confirmSchema>,
    investor: z.infer<typeof confirmSchema>,
    body: z.infer<typeof executeBodySchema>,
): void {
    if (supplier.offerId !== investor.offerId) {
        throw Object.assign(new Error("offerId mismatch"), { statusCode: 409 });
    }
    if (supplier.priceUsd !== investor.priceUsd) {
        throw Object.assign(new Error("price mismatch"), { statusCode: 409 });
    }
    if (supplier.priceUsd !== body.purchasePriceUsd) {
        throw Object.assign(new Error("price != purchasePriceUsd"), {
            statusCode: 409,
        });
    }
    if (supplier.accountId !== body.supplierAccountId) {
        throw Object.assign(new Error("supplier account mismatch"), {
            statusCode: 409,
        });
    }
    if (investor.accountId !== body.investorAccountId) {
        throw Object.assign(new Error("investor account mismatch"), {
            statusCode: 409,
        });
    }
}

export async function registerAgentHederaRoutes(
    app: FastifyInstance,
    store: InMemoryStore,
) {
    /**
     * After dual confirm — runs full Hedera primary sale.
     */
    app.post("/api/trades/execute", async (request, reply) => {
        try {
            const body = executeBodySchema.parse(request.body);
            assertDealConfirmed(
                body.supplierConfirmation,
                body.investorConfirmation,
                body,
            );

            // The payout schedule (settlement step 8) uses the maturity as its
            // schedule expirationTime, which Hedera requires to still be in the
            // future when the pipeline reaches it. The pipeline takes ~6-7
            // minutes end-to-end, so a short-dated maturity would burn the
            // whole on-chain flow before failing at the last step — reject it
            // up front.
            const minMaturitySeconds = Math.floor(Date.now() / 1000) + 600;
            if (body.maturityTimestamp <= minMaturitySeconds) {
                return reply.code(422).send({
                    error: "MATURITY_TOO_SOON",
                    message:
                        "maturityTimestamp must be at least 600s in the future — the payout " +
                        "schedule created during settlement expires AT maturity (Hedera requires " +
                        "expirationTime > consensus time at creation), and the pipeline takes " +
                        "several minutes before it gets there.",
                });
            }

            const trade: ApprovedTrade = {
                receivableId: body.receivableId,
                supplierAccountId: body.supplierAccountId,
                investorAccountId: body.investorAccountId,
                faceValueUsd: body.faceValueUsd,
                purchasePriceUsd: body.purchasePriceUsd,
                maturityTimestamp: body.maturityTimestamp,
                riskGrade: body.riskGrade,
                debtorName: body.debtorName,
                supplierConfirmation: {
                    offerId: body.supplierConfirmation.offerId,
                    accountId: body.supplierConfirmation.accountId,
                    priceUsd: body.supplierConfirmation.priceUsd,
                    confirmedAt: body.supplierConfirmation.ts ?? Date.now(),
                },
                investorConfirmation: {
                    offerId: body.investorConfirmation.offerId,
                    accountId: body.investorConfirmation.accountId,
                    priceUsd: body.investorConfirmation.priceUsd,
                    confirmedAt: body.investorConfirmation.ts ?? Date.now(),
                },
            };

            const result = await executeApprovedTrade(trade, body.isin, {
                throughClearingOnly: body.throughClearingOnly ?? false,
            });

            // Persist the execution outcome so the maturity API (and other
            // consumers) can drive the lifecycle without re-deriving state.
            if (store.getReceivable(body.receivableId)) {
                store.updateReceivable(body.receivableId, {
                    securityId: result.securityId,
                    investorAccountId: body.investorAccountId,
                    payoutScheduleId: result.scheduleId,
                    status: "FUNDED",
                });
            }

            store.addAudit(body.receivableId, {
                type: "TRADE_EXECUTED",
                ...result,
            });

            return reply.code(200).send(result);
        } catch (err: any) {
            if (err?.statusCode === 409) {
                return reply.code(409).send({
                    error: "DealNotConfirmedError",
                    message: err.message,
                });
            }
            if (err instanceof SupplierNotAuthorizedError) {
                return reply.code(424).send({
                    error: "SupplierNotAuthorizedError",
                    message: err.message,
                });
            }
            if (
                err instanceof HederaExecutionNotReadyError ||
                /isOperator|allowance on the security token/i.test(
                    String(err?.message ?? err),
                )
            ) {
                const isAuth = /isOperator|allowance on the security token/i.test(
                    String(err?.message ?? err),
                );
                return reply.code(isAuth ? 424 : 503).send({
                    error: isAuth
                        ? "SupplierNotAuthorizedError"
                        : "HederaExecutionNotReadyError",
                    message: String(err?.message ?? err),
                });
            }
            request.log.error(err);
            return reply.code(500).send({
                error: "EXECUTE_FAILED",
                message: String(err?.message ?? err),
            });
        }
    });

    /**
     * Once per new security — supplier authorizes FACTORED operator (custodial Testnet).
     */
    app.post(
        "/api/suppliers/:accountId/authorize-operator",
        async (request, reply) => {
            try {
                const params = z
                    .object({ accountId: z.string().min(1) })
                    .parse(request.params);
                const body = z
                    .object({ securityId: z.string().min(1) })
                    .parse(request.body);

                await initializeATS();
                const securityEvm = await resolveContractEvmAddress(body.securityId);
                const operatorEvm = await resolveAccountEvmAddress(
                    env.HEDERA_OPERATOR_ID,
                );

                const result = await authorizeOperatorFromEnv({
                    securityEvm,
                    operatorEvm,
                    supplierAccountId: params.accountId,
                });

                return reply.code(200).send({
                    authorized: true,
                    transactionId: result.transactionId,
                });
            } catch (err: any) {
                if (err instanceof SupplierNotAuthorizedError) {
                    return reply.code(424).send({
                        error: "SupplierNotAuthorizedError",
                        message: err.message,
                    });
                }
                request.log.error(err);
                return reply.code(500).send({
                    error: "AUTHORIZE_FAILED",
                    message: String(err?.message ?? err),
                });
            }
        },
    );

    /**
     * Investor USDC allowance to operator (custodial: needs investor key in env for demo).
     * Non-custodial later: return transaction bytes for wallet sign.
     */
    app.post(
        "/api/investors/:accountId/approve-usdc-allowance",
        async (request, reply) => {
            try {
                const params = z
                    .object({ accountId: z.string().min(1) })
                    .parse(request.params);
                const body = z
                    .object({
                        amountUsd: z.number().positive(),
                    })
                    .parse(request.body);

                if (!env.USDC_TOKEN_ID) {
                    return reply.code(503).send({
                        error: "HederaExecutionNotReadyError",
                        message: "USDC_TOKEN_ID not set",
                    });
                }

                const amountSmallestUnit = BigInt(
                    Math.round(body.amountUsd * 1_000_000),
                );

                const tx = buildInvestorUsdcAllowance({
                    tokenId: env.USDC_TOKEN_ID,
                    investorAccountId: params.accountId,
                    spenderAccountId: env.HEDERA_OPERATOR_ID,
                    amountSmallestUnit,
                });

                // Custodial demo: only if you hold investor key (optional).
                // Prefer agent team documents this as "investor wallet signs" in prod.
                const investorKey =
                    process.env.TEST_INVESTOR_PRIVATE_KEY ||
                    process.env.INVESTOR_PRIVATE_KEY;

                if (!investorKey) {
                    return reply.code(200).send({
                        ok: false,
                        mode: "unsigned",
                        message:
                            "Build allowance tx ready conceptually; set TEST_INVESTOR_PRIVATE_KEY to auto-sign on Testnet, or sign in wallet.",
                        spenderAccountId: env.HEDERA_OPERATOR_ID,
                        tokenId: env.USDC_TOKEN_ID,
                        amountUsd: body.amountUsd,
                    });
                }

                // Custodial test mode: the investor key is available, so the
                // allowance approval is signed by its owner and executed here.
                // In production the investor wallet signs; the operator can
                // then spend only up to the ceiling (Hedera enforces it).
                const investorClient =
                    env.HEDERA_NETWORK === "mainnet"
                        ? Client.forMainnet()
                        : Client.forTestnet();
                investorClient.setOperator(
                    AccountId.fromString(params.accountId),
                    PrivateKey.fromStringECDSA(investorKey),
                );

                try {
                    const response = await tx.execute(investorClient);
                    const receipt = await response.getReceipt(investorClient);
                    return reply.code(200).send({
                        ok: true,
                        mode: "executed",
                        transactionId: response.transactionId.toString(),
                        status: receipt.status.toString(),
                        spenderAccountId: env.HEDERA_OPERATOR_ID,
                        tokenId: env.USDC_TOKEN_ID,
                        amountUsd: body.amountUsd,
                    });
                } finally {
                    investorClient.close();
                }
            } catch (err: any) {
                request.log.error(err);
                return reply.code(500).send({
                    error: "ALLOWANCE_FAILED",
                    message: String(err?.message ?? err),
                });
            }
        },
    );
}