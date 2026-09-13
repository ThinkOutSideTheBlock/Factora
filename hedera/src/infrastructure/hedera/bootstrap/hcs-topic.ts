import { Client, TopicCreateTransaction } from "@hashgraph/sdk";

export async function createFactoredAuditTopic(client: Client) {
  const tx = await new TopicCreateTransaction()
    .setTopicMemo("FACTORED agentic receivables audit trail")
    .execute(client);

  const receipt = await tx.getReceipt(client);
  if (!receipt.topicId) {
    throw new Error("HCS topic was not created.");
  }

  return {
    topicId: receipt.topicId.toString(),
    transactionId: tx.transactionId.toString(),
  };
}
