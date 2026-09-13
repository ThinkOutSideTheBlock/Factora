import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import axios from "axios";

import { assertATSInitialized } from "./ats.js";
import { networkConfig } from "../config.js";

const require = createRequire(import.meta.url);

const sdkRoot = dirname(require.resolve("@hashgraph/asset-tokenization-sdk"));

const Injectable = require(
  join(sdkRoot, "core/injectable/Injectable.js"),
).default;

const { RPCTransactionAdapter } = require(
  join(sdkRoot, "port/out/rpc/RPCTransactionAdapter.js"),
);

const BigDecimal = require(
  join(sdkRoot, "domain/context/shared/BigDecimal.js"),
).default;

const mirror = axios.create({
  baseURL: networkConfig.mirrorNode,
  timeout: 30_000,
});

async function resolveContractEvmAddress(securityId: string): Promise<string> {
  const { data } = await mirror.get(`contracts/${securityId}`);
  if (!data?.evm_address) {
    throw new Error(`Mirror node returned no evm_address for ${securityId}`);
  }
  return data.evm_address.startsWith("0x")
    ? data.evm_address
    : `0x${data.evm_address}`;
}

async function resolveAccountEvmAddress(accountId: string): Promise<string> {
  const { data } = await mirror.get(`accounts/${accountId}`);
  if (!data?.evm_address) {
    throw new Error(`Mirror node returned no evm_address for ${accountId}`);
  }
  return data.evm_address.startsWith("0x")
    ? data.evm_address
    : `0x${data.evm_address}`;
}

export async function issueReceivableNote(
  securityId: string,
  supplierAccountId: string,
) {
  assertATSInitialized();

  if (!securityId) {
    throw new Error("securityId is required");
  }
  if (!supplierAccountId) {
    throw new Error("supplierAccountId is required");
  }

  console.log("[issue] start", { securityId, supplierAccountId });

  const securityEvm = await resolveContractEvmAddress(securityId);
  const supplierEvm = await resolveAccountEvmAddress(supplierAccountId);

  console.log("[issue] resolved", { securityEvm, supplierEvm });

  const amount = BigDecimal.fromString("1", 0);
  const transactionAdapter = Injectable.resolve(RPCTransactionAdapter);

  console.log("[issue] calling transactionAdapter.issue...");
  const result = await transactionAdapter.issue(
    securityEvm,
    supplierEvm,
    amount,
  );

  console.log("[issue] done", result);
  return result;
}