import { Client, TopicId, TopicMessageSubmitTransaction } from "@hashgraph/sdk";

export type AuditEventType =
  | "RECEIVABLE_REGISTERED"
  | "UNDERWRITING_COMPLETED"
  | "OFFER_PROPOSED"
  | "COUNTER_OFFER"
  | "TRADE_ACCEPTED"
  | "DEAL_CONFIRMED"
  | "WORLD_AUTHORIZED"
  | "NOTE_CREATED"
  | "NOTE_ISSUED"
  | "NOTE_CLEARING_INITIATED"
  | "NOTE_CLEARING_APPROVED"
  | "NOTE_TRANSFERRED"
  | "USDC_ALLOWANCE_APPROVED"
  | "USDC_SETTLED"
  | "REDEMPTION_PAYOUT_SCHEDULED"
  | "MATURITY_REACHED"
  | "DEBTOR_PAYMENT_CONFIRMED"
  | "DEFAULT_DETECTED"
  | "REDEMPTION_COMPLETED";

export interface AuditEvent {
  type: AuditEventType;
  timestamp: number;
  receivableId: string;
  actor?: string;
  data?: Record<string, unknown>;
}

export function serializeAuditEvent(event: AuditEvent): string {
  return JSON.stringify({
    schemaVersion: 1,
    source: "factored",
    ...event,
  });
}

export async function writeAuditEvent(
  client: Client,
  topicId: string,
  event: AuditEvent,
) {
  if (!topicId) throw new Error("FACTORED_AUDIT_TOPIC_ID is required.");

  const response = await new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(topicId))
    .setMessage(serializeAuditEvent(event))
    .execute(client);

  const receipt = await response.getReceipt(client);

  return {
    transactionId: response.transactionId.toString(),
    status: receipt.status.toString(),
  };
}
