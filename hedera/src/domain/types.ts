export type ReceivableStatus =
  | "LISTED"
  | "UNDERWRITING"
  | "NEGOTIATING"
  | "APPROVED"
  | "TOKENIZED"
  | "FUNDED"
  | "TRANSFERABLE"
  | "MATURED"
  | "DEFAULTED"
  | "REDEEMED";

export interface Receivable {
  id: string;
  supplierAccountId: string;
  debtorName: string;
  faceValueUsd: number;
  minimumProceedsUsd: number;
  maximumDiscountBps?: number;
  maturityTimestamp: number;
  invoiceHash?: string;
  riskGrade?: string;
  maxPurchasePriceUsd?: number;
  underwritingReference?: string;
  securityId?: string;
  investorAccountId?: string;
  payoutScheduleId?: string;
  status: ReceivableStatus;
}
