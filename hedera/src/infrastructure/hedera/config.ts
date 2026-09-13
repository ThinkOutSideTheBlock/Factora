import "dotenv/config";

export type HederaNetwork = "testnet" | "mainnet";

function read(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const env = {
  HEDERA_NETWORK: (read("HEDERA_NETWORK", "testnet") === "mainnet" ? "mainnet" : "testnet") as HederaNetwork,
  HEDERA_OPERATOR_ID: read("HEDERA_OPERATOR_ID"),
  HEDERA_OPERATOR_PRIVATE_KEY: read("HEDERA_OPERATOR_PRIVATE_KEY"),
  ATS_RESOLVER_ID: read("ATS_RESOLVER_ID"),
  ATS_FACTORY_ID: read("ATS_FACTORY_ID"),
  ATS_CONFIG_ID: read("ATS_CONFIG_ID"),
  ATS_CONFIG_VERSION: Number(read("ATS_CONFIG_VERSION", "0")),
  ATS_SDK_VERSION: read("ATS_SDK_VERSION", "8.0.0"),
  ATS_DEPLOYMENT_VERSION: read("ATS_DEPLOYMENT_VERSION"),
  RUN_HEDERA_EXECUTION: read("RUN_HEDERA_EXECUTION", "false") === "true",
  FACTORED_AUDIT_TOPIC_ID: read("FACTORED_AUDIT_TOPIC_ID"),
  USDC_TOKEN_ID: read("USDC_TOKEN_ID"),
  ATS_ISSUER_ACCOUNT_ID: read("ATS_ISSUER_ACCOUNT_ID"),
  ATS_COMPLIANCE_ACCOUNT_ID: read("ATS_COMPLIANCE_ACCOUNT_ID"),
  ATS_CLEARING_VALIDATOR_ACCOUNT_ID: read("ATS_CLEARING_VALIDATOR_ACCOUNT_ID"),
  FACTORED_REDEMPTION_ACCOUNT_ID: read("FACTORED_REDEMPTION_ACCOUNT_ID"),
};

export const networkConfig = {
  mirrorNode:
    env.HEDERA_NETWORK === "mainnet"
      ? "https://mainnet-public.mirrornode.hedera.com/api/v1/"
      : "https://testnet.mirrornode.hedera.com/api/v1/",
  rpcNode:
    env.HEDERA_NETWORK === "mainnet"
      ? "https://mainnet.hashio.io/api"
      : "https://testnet.hashio.io/api",
};

export function requireHederaEnv(...keys: (keyof typeof env)[]): void {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing Hedera environment variables: ${missing.join(", ")}`);
  }
}

export function requireIntegrationEnv(): void {
  requireHederaEnv(
    "HEDERA_OPERATOR_ID",
    "HEDERA_OPERATOR_PRIVATE_KEY",
    "ATS_RESOLVER_ID",
    "ATS_FACTORY_ID",
    "ATS_CONFIG_ID",
    "FACTORED_AUDIT_TOPIC_ID",
    "USDC_TOKEN_ID",
  );
}
