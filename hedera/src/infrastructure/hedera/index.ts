export * from "./config.js";
export * from "./client.js";
export * from "./types.js";
export * from "./ats/ats.js";
export * from "./ats/receivable-note.js";
export * from "./ats/issue.js";
export * from "./ats/kyc.js";
export * from "./hcs/audit.js";
export * from "./hts/usdc.js";
export * from "./settlement/clearing.js";
export * from "./settlement/settlement.js";
export * from "./maturity/maturity-worker.js";
export * from "./bootstrap/hcs-topic.js";
export * from "./bootstrap/ats-signer-spike.js";

import type { ApprovedTrade, SettlementResult } from "./types.js";
import { executeApprovedTrade, assertDealConfirmed } from "./settlement/settlement.js";
import { processMaturity, type MaturityInput } from "./maturity/maturity-worker.js";

export class HederaExecutionService {
  async initialize(): Promise<void> {
    const { initializeATS } = await import("./ats/ats.js");
    await initializeATS();
  }

  async executeTrade(trade: ApprovedTrade, isin: string): Promise<SettlementResult> {
    assertDealConfirmed(trade);
    return executeApprovedTrade(trade, isin);
  }

  async processMaturity(input: MaturityInput) {
    return processMaturity(input);
  }
}