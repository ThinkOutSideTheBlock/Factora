import {
    ScheduleCreateTransaction,
    TransferTransaction,
    TokenId,
    AccountId,
    Timestamp,
    Client,
} from "@hashgraph/sdk";
import { env } from "../config.js";

export interface ScheduleRedemptionInput {
    investorAccountId: string;
    faceValueUsd: number;
    maturityTimestamp: number; // unix seconds
}

export async function scheduleInvestorPayout(client: Client, input: ScheduleRedemptionInput) {
    const amountSmallestUnit = Math.round(input.faceValueUsd * 1_000_000);
    const tokenId = TokenId.fromString(env.USDC_TOKEN_ID);
    const redemptionAccount = AccountId.fromString(env.FACTORED_REDEMPTION_ACCOUNT_ID);
    const investorAccount = AccountId.fromString(input.investorAccountId);

    // The payout schedule uses the maturity as its expirationTime
    // (waitForExpiry → the schedule fires AT maturity). Hedera requires
    // expirationTime > consensus time at schedule creation, so a maturity
    // that has already passed (or lands within the pipeline slack) cannot
    // be scheduled — fail with an actionable message instead of the raw
    // SCHEDULE_EXPIRATION_TIME_MUST_BE_HIGHER_THAN_CONSENSUS_TIME error.
    const minExpirationSeconds = Math.floor(Date.now() / 1000) + 60;
    if (input.maturityTimestamp <= minExpirationSeconds) {
        throw new Error(
            `maturityTimestamp ${input.maturityTimestamp} (${new Date(input.maturityTimestamp * 1000).toISOString()}) is not in the future — ` +
            `the payout schedule must expire AFTER consensus time. Increase the maturity offset ` +
            `(e.g. TEST_E2E_MATURITY_OFFSET_SECONDS) so the pipeline can still create the schedule before maturity.`,
        );
    }

    const payout = new TransferTransaction()
        .addTokenTransfer(tokenId, redemptionAccount, -amountSmallestUnit)
        .addTokenTransfer(tokenId, investorAccount, amountSmallestUnit);

    const scheduleTx = new ScheduleCreateTransaction()
        .setScheduledTransaction(payout)
        .setScheduleMemo(`factored-redemption-${input.investorAccountId}`)
        .setAdminKey(client.operatorPublicKey!) // required so it can be cancelled on default
        .setExpirationTime(Timestamp.fromDate(new Date(input.maturityTimestamp * 1000)))
        .setWaitForExpiry(true); // do not fire early just because it's fully signed

    const response = await scheduleTx.execute(client);
    const receipt = await response.getReceipt(client);
    if (!receipt.scheduleId) throw new Error("Schedule was not created.");

    return { scheduleId: receipt.scheduleId.toString(), transactionId: response.transactionId.toString() };
}