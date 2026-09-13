import { ScheduleDeleteTransaction, ScheduleId, Client } from "@hashgraph/sdk";

export async function cancelScheduledRedemption(client: Client, scheduleId: string) {
    const tx = new ScheduleDeleteTransaction().setScheduleId(ScheduleId.fromString(scheduleId));
    const response = await tx.execute(client);
    const receipt = await response.getReceipt(client);
    return { transactionId: response.transactionId.toString(), status: receipt.status.toString() };
}