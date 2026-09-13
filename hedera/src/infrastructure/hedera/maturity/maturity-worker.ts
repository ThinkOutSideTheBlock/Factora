import { initializeATS } from "../ats/ats.js";
import { getHederaClient } from "../client.js";
import { env } from "../config.js";
import { writeAuditEvent } from "../hcs/audit.js";
import { cancelScheduledRedemption } from "./cancel-scheduled-redemption.js";

export interface MaturityInput {
  receivableId: string;
  securityId: string;
  investorAccountId: string;
  maturityTimestamp: number;
  debtorPaymentConfirmed: boolean;
  debtorPaymentTransactionId?: string;
  /** Scheduled USDC payout created at settlement — cancelled on honest default. */
  payoutScheduleId?: string;
}

export async function processMaturity(input: MaturityInput) {
  await initializeATS();
  const now = Math.floor(Date.now() / 1000);
  if (now < input.maturityTimestamp) {
    throw new Error("Receivable has not reached maturity.");
  }

  const client = getHederaClient();
  await writeAuditEvent(client, env.FACTORED_AUDIT_TOPIC_ID, {
    type: "MATURITY_REACHED",
    timestamp: now,
    receivableId: input.receivableId,
    data: { securityId: input.securityId },
  });

  if (!input.debtorPaymentConfirmed) {
    const audit = await writeAuditEvent(client, env.FACTORED_AUDIT_TOPIC_ID, {
      type: "DEFAULT_DETECTED",
      timestamp: now,
      receivableId: input.receivableId,
      data: {
        securityId: input.securityId,
        payoutScheduleId: input.payoutScheduleId,
      },
    });

    // Honest default: the scheduled USDC payout must not fire for a
    // defaulted note — the schedule self-executes at expiry unless deleted.
    let payoutScheduleCancelled = false;
    let payoutScheduleCancelError: string | undefined;
    if (input.payoutScheduleId) {
      try {
        const cancelled = await cancelScheduledRedemption(
          getHederaClient(),
          input.payoutScheduleId,
        );
        payoutScheduleCancelled = true;
        console.log("[maturity] scheduled payout cancelled", {
          scheduleId: input.payoutScheduleId,
          transactionId: cancelled.transactionId,
        });
      } catch (err) {
        // Most likely the schedule already executed at expiry.
        payoutScheduleCancelError = String(err);
        console.log("[maturity] scheduled payout cancel failed", {
          scheduleId: input.payoutScheduleId,
          error: payoutScheduleCancelError,
        });
      }
    }

    return {
      status: "DEFAULTED" as const,
      auditTransactionId: audit.transactionId,
      payoutScheduleId: input.payoutScheduleId,
      payoutScheduleCancelled,
      payoutScheduleCancelError,
    };
  }

  await writeAuditEvent(client, env.FACTORED_AUDIT_TOPIC_ID, {
    type: "DEBTOR_PAYMENT_CONFIRMED",
    timestamp: now,
    receivableId: input.receivableId,
    data: { securityId: input.securityId, debtorPaymentTransactionId: input.debtorPaymentTransactionId },
  });

  const sdk: any = await import("@hashgraph/asset-tokenization-sdk");
  const result = await sdk.Bond.fullRedeemAtMaturity(
    new sdk.FullRedeemAtMaturityRequest({
      securityId: input.securityId,
      sourceId: input.investorAccountId,
    }),
  );

  const audit = await writeAuditEvent(client, env.FACTORED_AUDIT_TOPIC_ID, {
    type: "REDEMPTION_COMPLETED",
    timestamp: Math.floor(Date.now() / 1000),
    receivableId: input.receivableId,
    data: {
      securityId: input.securityId,
      investorAccountId: input.investorAccountId,
      redemptionTransactionId: result.transactionId,
    },
  });

  return {
    status: "REDEEMED" as const,
    redemptionTransactionId: result.transactionId,
    auditTransactionId: audit.transactionId,
    payoutScheduleId: input.payoutScheduleId,
  };
}
