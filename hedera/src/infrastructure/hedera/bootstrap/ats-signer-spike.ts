/**
 * ATS signing spike placeholder.
 *
 * The official ATS SDK documents Network.init() followed by wallet connection,
 * while the SDK's internal RPC adapter ultimately uses an ethers Signer/Provider.
 * This package therefore refuses to claim a backend private-key integration
 * until it is proven against the exact deployed ATS version we target.
 */
export async function runAtsSigningSpike(): Promise<{
  success: boolean;
  transactionId?: string;
  message: string;
}> {
  return {
    success: false,
    message:
      "Backend ATS signer path is not claimed complete. Validate signer injection or verified direct-contract fallback on Hedera Testnet.",
  };
}
