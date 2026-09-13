export interface ApprovedTrade {
  receivableId: string;
  supplierAccountId: string;
  investorAccountId: string;
  faceValueUsd: number;
  purchasePriceUsd: number;
  maturityTimestamp: number;
  riskGrade: string;
  debtorName: string;
}

export interface SettlementResult {
  receivableId: string;
  securityId: string;
  purchasePriceUsd: number;
  tokenizationTxId?: string;
  issuanceTxId?: string;
  clearingTransferTxId?: string;
  clearingApprovalTxId?: string;
  cashTransferTxId?: string;
  auditTxIds: string[];
  status: "EXECUTED" | "FAILED";
  scheduleId?: string;
}
export interface PartyConfirmation {
  /** Offer id this party is confirming — ties it to specific negotiated terms. */
  offerId: string;
  /** This party's own Hedera account id. */
  accountId: string;
  /** Price as this party understood it at confirmation time. */
  priceUsd: number;
  /** Unix ms. */
  confirmedAt: number;
}

export interface ApprovedTrade {
  receivableId: string;
  supplierAccountId: string;
  investorAccountId: string;
  faceValueUsd: number;
  purchasePriceUsd: number;
  maturityTimestamp: number;
  riskGrade: string;
  debtorName: string;
  /** Both required. No token creation without both sides confirming the same deal. */
  supplierConfirmation: PartyConfirmation;
  investorConfirmation: PartyConfirmation;
}

export interface SettlementResult {
  receivableId: string;
  securityId: string;
  purchasePriceUsd: number;
  tokenizationTxId?: string;
  issuanceTxId?: string;
  clearingTransferTxId?: string;
  clearingApprovalTxId?: string;
  cashTransferTxId?: string;
  auditTxIds: string[];
  status: "EXECUTED" | "FAILED";
}