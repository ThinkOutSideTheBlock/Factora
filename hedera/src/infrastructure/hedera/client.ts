import { AccountId, Client, PrivateKey } from "@hashgraph/sdk";
import { env, requireHederaEnv } from "./config.js";

let client: Client | undefined;

export function getHederaClient(): Client {
  if (client) return client;

  requireHederaEnv("HEDERA_OPERATOR_ID", "HEDERA_OPERATOR_PRIVATE_KEY");

  const operatorId = AccountId.fromString(env.HEDERA_OPERATOR_ID);
  const privateKey = PrivateKey.fromStringECDSA(
    env.HEDERA_OPERATOR_PRIVATE_KEY,
  );

  client = env.HEDERA_NETWORK === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(operatorId, privateKey);
  return client;
}

export function closeHederaClient(): void {
  client?.close();
  client = undefined;
}
