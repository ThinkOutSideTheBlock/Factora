import {
  AccountAllowanceApproveTransaction,
  AccountId,
  Client,
  TokenId,
  TransferTransaction,
} from "@hashgraph/sdk";


function safeNumber(value: bigint): number {

  if (value <= 0n) {
    throw new Error("Amount must be positive.");
  }

  const result = Number(value);

  if (!Number.isSafeInteger(result)) {
    throw new Error(
      "Amount exceeds JavaScript safe integer range."
    );
  }

  return result;
}



export function buildInvestorUsdcAllowance(input: {
  tokenId: string;
  investorAccountId: string;
  spenderAccountId: string;
  amountSmallestUnit: bigint;
}) {

  const amount =
    safeNumber(
      input.amountSmallestUnit
    );


  return new AccountAllowanceApproveTransaction()
    .approveTokenAllowance(
      TokenId.fromString(
        input.tokenId
      ),

      AccountId.fromString(
        input.investorAccountId
      ),

      AccountId.fromString(
        input.spenderAccountId
      ),

      amount
    );
}





export async function settleUsdcFromAllowance(
  client: Client,

  input: {

    tokenId: string;

    investorAccountId: string;

    supplierAccountId: string;

    amountSmallestUnit: bigint;

  }

) {


  const amount =
    safeNumber(
      input.amountSmallestUnit
    );



  const token =
    TokenId.fromString(
      input.tokenId
    );


  const investor =
    AccountId.fromString(
      input.investorAccountId
    );


  const supplier =
    AccountId.fromString(
      input.supplierAccountId
    );



  const tx =
    new TransferTransaction()

      .addApprovedTokenTransfer(
        token,
        investor,
        -amount
      )

      .addTokenTransfer(
        token,
        supplier,
        amount
      );



  return await tx.execute(client);

}