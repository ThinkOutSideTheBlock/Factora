import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { InMemoryStore } from "../services/store.js";

import { env } from "../../infrastructure/hedera/config.js";
import { processMaturity } from "../../infrastructure/hedera/maturity/maturity-worker.js";

const paymentSchema = z.object({
  transactionId: z.string().min(1),
  amountUsd: z.number().positive(),
});

const redeemSchema = z.object({
  // By default the debtor payment is "confirmed" exactly when the
  // confirm-payment endpoint ran (receivable status MATURED). The override
  // exists for explicit test/ops control.
  debtorPaymentConfirmed: z.boolean().optional(),
  debtorPaymentTransactionId: z.string().min(1).optional(),
});

export async function registerMaturityRoutes(
  app: FastifyInstance,
  store: InMemoryStore,
) {
  app.post("/api/maturity/:receivableId/check", async (request, reply) => {
    const params = z.object({ receivableId: z.string().min(1) }).parse(request.params);
    const receivable = store.getReceivable(params.receivableId);
    if (!receivable) return reply.code(404).send({ error: "RECEIVABLE_NOT_FOUND" });

    const now = Math.floor(Date.now() / 1000);
    const maturityReached = now >= receivable.maturityTimestamp;

    return {
      receivableId: receivable.id,
      maturityReached,
      debtorPayment: {
        confirmed: receivable.status === "MATURED" || receivable.status === "REDEEMED",
      },
      redemptionEligible:
        maturityReached &&
        (receivable.status === "MATURED" || receivable.status === "TRANSFERABLE"),
      status: receivable.status,
    };
  });

  app.post("/api/maturity/:receivableId/confirm-payment", async (request, reply) => {
    const params = z.object({ receivableId: z.string().min(1) }).parse(request.params);
    const body = paymentSchema.parse(request.body);
    const receivable = store.getReceivable(params.receivableId);
    if (!receivable) return reply.code(404).send({ error: "RECEIVABLE_NOT_FOUND" });
    if (body.amountUsd < receivable.faceValueUsd) {
      return reply.code(422).send({ error: "DEBTOR_PAYMENT_BELOW_FACE_VALUE" });
    }

    const updated = store.updateReceivable(receivable.id, { status: "MATURED" });
    store.addAudit(receivable.id, {
      type: "DEBTOR_PAYMENT_CONFIRMED",
      transactionId: body.transactionId,
      amountUsd: body.amountUsd,
      timestamp: Date.now(),
    });
    return updated;
  });

  app.post("/api/maturity/:receivableId/redeem", async (request, reply) => {
    const params = z.object({ receivableId: z.string().min(1) }).parse(request.params);
    const body = redeemSchema.parse(request.body ?? {});
    const receivable = store.getReceivable(params.receivableId);
    if (!receivable) return reply.code(404).send({ error: "RECEIVABLE_NOT_FOUND" });
    if (!receivable.securityId) return reply.code(409).send({ error: "SECURITY_NOT_TOKENIZED" });
    if (!receivable.investorAccountId) {
      return reply.code(409).send({ error: "INVESTOR_ACCOUNT_ID_MISSING" });
    }
    if (!env.RUN_HEDERA_EXECUTION) {
      return reply.code(503).send({
        error: "HederaExecutionNotReadyError",
        message: "Set RUN_HEDERA_EXECUTION=true to execute maturity redemption on Hedera.",
      });
    }

    const now = Math.floor(Date.now() / 1000);
    if (now < receivable.maturityTimestamp) {
      return reply.code(409).send({ error: "MATURITY_NOT_REACHED" });
    }

    const debtorPaymentConfirmed =
      body.debtorPaymentConfirmed ?? receivable.status === "MATURED";

    try {
      const redemption = await processMaturity({
        receivableId: receivable.id,
        securityId: receivable.securityId,
        investorAccountId: receivable.investorAccountId,
        maturityTimestamp: receivable.maturityTimestamp,
        debtorPaymentConfirmed,
        debtorPaymentTransactionId: body.debtorPaymentTransactionId,
        payoutScheduleId: receivable.payoutScheduleId,
      });

      const nextStatus =
        redemption.status === "REDEEMED" ? "REDEEMED" : "DEFAULTED";
      const updated = store.updateReceivable(receivable.id, {
        status: nextStatus,
      });
      store.addAudit(receivable.id, {
        type:
          nextStatus === "REDEEMED" ? "REDEMPTION_COMPLETED" : "DEFAULT_DETECTED",
        ...redemption,
        timestamp: Date.now(),
      });

      return reply.send({
        receivableId: receivable.id,
        securityId: receivable.securityId,
        redemption,
        receivable: updated,
      });
    } catch (err: any) {
      request.log.error(err);
      return reply.code(500).send({
        error: "REDEMPTION_FAILED",
        message: String(err?.message ?? err),
      });
    }
  });
}
