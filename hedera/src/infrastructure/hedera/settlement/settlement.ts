import { getHederaClient } from "../client.js";
import { env } from "../config.js";
import { createReceivableNote } from "../ats/receivable-note.js";
import { ATSKycAdapter, KYC_STATUS_GRANTED } from "../ats/kyc.js";
import {
  ClearingAdapter,
  DEFAULT_PARTITION,
  getSecurityTokenAllowance,
  isOperatorForHolder,
  isOperatorForPartition,
} from "./clearing.js";
import { issueReceivableNote } from "../ats/issue.js";
import { initializeATS } from "../ats/ats.js";
import { bootstrapSecurityForOperator } from "../ats/bootstrap-security.js";
import {
  createInvestorKycVc,
  resolveAccountEvmAddress,
  resolveContractEvmAddress,
} from "../ats/kycCredential.js";
import {
  approveSecurityAllowanceFromEnv,
  authorizeOperatorFromEnv,
  authorizeOperatorForPartitionFromEnv,
} from "../ats/authorize-operator.js";
import { settleUsdcFromAllowance } from "../hts/usdc.js";
import { writeAuditEvent } from "../hcs/audit.js";
import { scheduleInvestorPayout } from "../maturity/schedule-redemption.js";
import type { ApprovedTrade, SettlementResult } from "../types.js";

export class HederaExecutionNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HederaExecutionNotReadyError";
  }
}

/**
 * Anti-fraud gate: both parties must have confirmed the exact same deal
 * (same offer, same price, their own accounts) before anything is created
 * on Hedera. Pure validation — safe to run before any env/chain checks.
 */
export function assertDealConfirmed(trade: ApprovedTrade): void {
  const supplier = trade.supplierConfirmation;
  const investor = trade.investorConfirmation;

  if (!supplier || !investor) {
    throw new Error(
      "Deal is not confirmed: both supplier and investor confirmations are required.",
    );
  }

  if (supplier.offerId !== investor.offerId) {
    throw new Error("offerId mismatch");
  }

  if (supplier.priceUsd !== investor.priceUsd) {
    throw new Error("Price mismatch");
  }

  if (supplier.priceUsd !== trade.purchasePriceUsd) {
    throw new Error("price != purchasePriceUsd");
  }

  if (supplier.accountId !== trade.supplierAccountId) {
    throw new Error("supplier account mismatch");
  }

  if (investor.accountId !== trade.investorAccountId) {
    throw new Error("investor account mismatch");
  }
}

export interface ExecuteTradeOptions {
  /**
   * Stop after the supplier → investor clearing, before the USDC cash leg
   * and the maturity payout schedule. Testnet-only readiness gate for the
   * pre-USDC portion of the flow — no USDC funding/allowance required.
   */
  throughClearingOnly?: boolean;
}

export async function executeApprovedTrade(
  trade: ApprovedTrade,
  isin: string,
  options: ExecuteTradeOptions = {},
): Promise<SettlementResult> {
  assertDealConfirmed(trade);
  if (env.RUN_HEDERA_EXECUTION !== true) {
    throw new HederaExecutionNotReadyError(
      "Set RUN_HEDERA_EXECUTION=true only after ATS signing, clearing, and HTS allowance spikes are green.",
    );
  }

  await initializeATS();
  const client = getHederaClient();
  const auditTxIds: string[] = [];

  // 1. Create note
  const note = await createReceivableNote({
    id: trade.receivableId,
    faceValueUsd: trade.faceValueUsd,
    purchasePriceUsd: trade.purchasePriceUsd,
    maturityTimestamp: trade.maturityTimestamp,
    riskGrade: trade.riskGrade,
    debtorName: trade.debtorName,
    isin,
  });

  const noteAudit = await writeAuditEvent(client, env.FACTORED_AUDIT_TOPIC_ID, {
    type: "NOTE_CREATED",
    timestamp: Math.floor(Date.now() / 1000),
    receivableId: trade.receivableId,
    data: { securityId: note.securityId },
  });
  auditTxIds.push(noteAudit.transactionId);

  // 1b. Bootstrap THIS security (roles + SSI issuer → operator)
  await bootstrapSecurityForOperator(note.securityId, env.HEDERA_OPERATOR_ID);

  const operatorEvm = await resolveAccountEvmAddress(env.HEDERA_OPERATOR_ID);
  const securityEvm = await resolveContractEvmAddress(note.securityId);
  console.log("[settlement] bootstrap done", {
    securityId: note.securityId,
    securityEvm,
    operatorEvm,
  });

  const kyc = new ATSKycAdapter();

  // 2. KYC supplier (real VC) — ATS requires NOT_GRANTED before a grant,
  //    so an already-granted supplier is verified instead (idempotent re-runs).
  const supplierKycStatus = await kyc.getInvestorKycStatus(
    note.securityId,
    trade.supplierAccountId,
  );
  if (supplierKycStatus !== KYC_STATUS_GRANTED) {
    const supplierVc = await createInvestorKycVc({
      securityId: note.securityId,
      investorAccountId: trade.supplierAccountId,
      receivableId: trade.receivableId,
    });
    await kyc.grantInvestorKyc({
      securityId: note.securityId,
      investorAccountId: trade.supplierAccountId,
      vcBase64: supplierVc.vcBase64,
    });
  }

  // 3. Issue → supplier
  const issued = await issueReceivableNote(
    note.securityId,
    trade.supplierAccountId,
  );
  const issuedAudit = await writeAuditEvent(client, env.FACTORED_AUDIT_TOPIC_ID, {
    type: "NOTE_ISSUED",
    timestamp: Math.floor(Date.now() / 1000),
    receivableId: trade.receivableId,
    data: { securityId: note.securityId, transactionId: issued.transactionId },
  });
  auditTxIds.push(issuedAudit.transactionId);

  // 3b. Supplier authorizes the operator for this security — both GLOBAL
  //     (IOperator.isOperator) and PER-PARTITION (IOperatorByPartition
  //     isOperatorForPartition). Operator authorization passes the facet's
  //     permission gate, but the operator-from clearing ALSO consumes the
  //     supplier → operator ERC-20 allowance on the security token (step 3c).
  //     Custodial mode A; each step is idempotent and one-time per security.
  const supplierEvm = await resolveAccountEvmAddress(trade.supplierAccountId);
  const authorizedGlobal = await isOperatorForHolder(
    securityEvm,
    operatorEvm,
    supplierEvm,
  );
  const authorizedForPartition = await isOperatorForPartition(
    securityEvm,
    DEFAULT_PARTITION,
    operatorEvm,
    supplierEvm,
  );

  if (!authorizedGlobal) {
    console.log("[settlement] supplier authorizeOperator (global) required");
    await authorizeOperatorFromEnv({
      securityEvm,
      operatorEvm,
      supplierAccountId: trade.supplierAccountId,
    });
  }
  if (!authorizedForPartition) {
    console.log(
      "[settlement] supplier authorizeOperator (partition) required",
    );
    await authorizeOperatorForPartitionFromEnv({
      securityEvm,
      operatorEvm,
      partitionId: DEFAULT_PARTITION,
      supplierAccountId: trade.supplierAccountId,
    });
  }

  // 3c. Security-token ERC-20 allowance — clearedTransferFromByPartition
  //     consumes the supplier → operator allowance on the security diamond
  //     (ClearingOps.decreaseAllowedBalanceForClearing reverts with
  //     InsufficientAllowance when it is below the clearing amount). It is
  //     decremented by each clearing, so top it up whenever it falls short.
  const CLEARING_AMOUNT = 1n;
  const securityAllowance = await getSecurityTokenAllowance(
    securityEvm,
    supplierEvm,
    operatorEvm,
  );
  if (securityAllowance < CLEARING_AMOUNT) {
    console.log("[settlement] supplier security-token approve (clearing allowance) required", {
      currentAllowance: securityAllowance.toString(),
      required: CLEARING_AMOUNT.toString(),
    });
    const approvedAllowance = await approveSecurityAllowanceFromEnv({
      securityEvm,
      operatorEvm,
      amount: CLEARING_AMOUNT,
      supplierAccountId: trade.supplierAccountId,
    });
    console.log("[settlement] security-token approve done", {
      transactionId: approvedAllowance.transactionId,
    });
  }

  // 4. KYC investor (real VC) — same NOT_GRANTED gate as the supplier.
  const investorKycStatus = await kyc.getInvestorKycStatus(
    note.securityId,
    trade.investorAccountId,
  );
  if (investorKycStatus !== KYC_STATUS_GRANTED) {
    const investorVc = await createInvestorKycVc({
      securityId: note.securityId,
      investorAccountId: trade.investorAccountId,
      receivableId: trade.receivableId,
    });
    await kyc.grantInvestorKyc({
      securityId: note.securityId,
      investorAccountId: trade.investorAccountId,
      vcBase64: investorVc.vcBase64,
    });
  }

  // 5. Clearing initiate — operator-from (needs prior authorizeOperator)
  const clearing = new ClearingAdapter();
  const clearingResult = await clearing.initiateSecurityTransfer({
    securityId: note.securityId,
    partitionId: DEFAULT_PARTITION,
    sourceId: trade.supplierAccountId,
    targetId: trade.investorAccountId,
    mode: "operator-from",
    amount: "1",
  });

  await writeAuditEvent(client, env.FACTORED_AUDIT_TOPIC_ID, {
    type: "NOTE_CLEARING_INITIATED",
    timestamp: Math.floor(Date.now() / 1000),
    receivableId: trade.receivableId,
    data: {
      securityId: note.securityId,
      clearingId: clearingResult.clearingId,
    },
  });

  if (clearingResult.clearingId == null) {
    throw new Error("clearingId missing after initiate");
  }

  // 6. Approve — holder arg = SUPPLIER
  const clearingApproval = await clearing.approveSecurityTransfer({
    securityId: note.securityId,
    partitionId: DEFAULT_PARTITION,
    targetId: trade.supplierAccountId,
    clearingId: clearingResult.clearingId,
    clearingOperationType: 0,
  });

  if (options.throughClearingOnly) {
    console.log(
      "[settlement] throughClearingOnly — stopping before the USDC cash leg and payout schedule",
    );
    return {
      receivableId: trade.receivableId,
      securityId: note.securityId,
      purchasePriceUsd: trade.purchasePriceUsd,
      tokenizationTxId: note.transactionId,
      issuanceTxId: issued.transactionId,
      clearingTransferTxId:
        clearingApproval.transactionId ?? clearingResult.transactionId ?? "",
      clearingApprovalTxId: clearingApproval.transactionId,
      auditTxIds,
      status: "EXECUTED",
    };
  }

  // 7. USDC
  const cashTx = await settleUsdcFromAllowance(client, {
    tokenId: env.USDC_TOKEN_ID,
    investorAccountId: trade.investorAccountId,
    supplierAccountId: trade.supplierAccountId,
    amountSmallestUnit: BigInt(
      Math.round(trade.purchasePriceUsd * 1_000_000),
    ),
  });

  // 8. Schedule investor payout at maturity (USDC face value)
  const scheduled = await scheduleInvestorPayout(client, {
    investorAccountId: trade.investorAccountId,
    faceValueUsd: trade.faceValueUsd,
    maturityTimestamp: trade.maturityTimestamp,
  });

  const scheduleAudit = await writeAuditEvent(client, env.FACTORED_AUDIT_TOPIC_ID, {
    type: "REDEMPTION_PAYOUT_SCHEDULED",
    timestamp: Math.floor(Date.now() / 1000),
    receivableId: trade.receivableId,
    data: {
      scheduleId: scheduled.scheduleId,
      faceValueUsd: trade.faceValueUsd,
      maturityTimestamp: trade.maturityTimestamp,
    },
  });
  auditTxIds.push(scheduleAudit.transactionId);

  return {
    receivableId: trade.receivableId,
    securityId: note.securityId,
    purchasePriceUsd: trade.purchasePriceUsd,
    tokenizationTxId: note.transactionId,
    issuanceTxId: issued.transactionId,
    clearingTransferTxId:
      clearingApproval.transactionId ?? clearingResult.transactionId ?? "",
    clearingApprovalTxId: clearingApproval.transactionId,
    cashTransferTxId: cashTx.transactionId?.toString?.() ?? String(cashTx),
    auditTxIds,
    status: "EXECUTED",
    scheduleId: scheduled.scheduleId,
  };
}