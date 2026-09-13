import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import axios from "axios";
import { Interface } from "ethers";

import { assertATSInitialized } from "../ats/ats.js";
import { env, networkConfig } from "../config.js";

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

function extractClearingId(result: any): number | undefined {
  const candidates = [
    result?.response?.clearingId,
    result?.response?.response?.clearingId,
    result?.clearingId,
    result?.data?.clearingId,
    result?.payload?.clearingId,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  // Some adapter shapes put numeric fields on response as strings
  const resp = result?.response;
  if (resp && typeof resp === "object") {
    for (const [k, v] of Object.entries(resp)) {
      if (/clearing/i.test(k) && v != null) {
        const n = Number(v as any);
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return undefined;
}

export const DEFAULT_PARTITION =
  "0x0000000000000000000000000000000000000000000000000000000000000001";

export const CLEARING_OPERATION_TRANSFER = 0;

const mirror = axios.create({
  baseURL: networkConfig.mirrorNode,
  timeout: 30_000,
});

const rpc = axios.create({
  baseURL: networkConfig.rpcNode,
  timeout: 30_000,
});

function defaultExpirationUnix(): string {
  return String(Math.floor(Date.now() / 1000) + 48 * 60 * 60);
}

async function resolveContractEvm(securityId: string): Promise<string> {
  const { data } = await mirror.get(`contracts/${securityId}`);
  if (!data?.evm_address) {
    throw new Error(`No evm_address for contract ${securityId}`);
  }
  return data.evm_address.startsWith("0x")
    ? data.evm_address
    : `0x${data.evm_address}`;
}

async function resolveAccountEvm(accountId: string): Promise<string> {
  const { data } = await mirror.get(`accounts/${accountId}`);
  if (!data?.evm_address) {
    throw new Error(`No evm_address for account ${accountId}`);
  }
  return data.evm_address.startsWith("0x")
    ? data.evm_address
    : `0x${data.evm_address}`;
}

export async function isOperatorForHolder(
  securityEvm: string,
  operatorEvm: string,
  holderEvm: string,
): Promise<boolean> {
  const iface = new Interface([
    "function isOperator(address operator, address tokenHolder) view returns (bool)",
  ]);
  const data = iface.encodeFunctionData("isOperator", [
    operatorEvm,
    holderEvm,
  ]);
  const { data: body } = await rpc.post("", {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: securityEvm, data }, "latest"],
  });
  const result = body?.result as string | undefined;
  if (!result || result === "0x") return false;
  return Boolean(iface.decodeFunctionResult("isOperator", result)[0]);
}

/**
 * Whether `operatorEvm` is authorized to act for `holderEvm` in `partitionId`
 * (IOperatorByPartition). The ClearingByPartitionFacet enforces this for
 * operator-from clearing transfers, so it must be true before settlement.
 */
export async function isOperatorForPartition(
  securityEvm: string,
  partitionId: string,
  operatorEvm: string,
  holderEvm: string,
): Promise<boolean> {
  const iface = new Interface([
    "function isOperatorForPartition(bytes32 partition, address operator, address tokenHolder) view returns (bool)",
  ]);
  const data = iface.encodeFunctionData("isOperatorForPartition", [
    partitionId,
    operatorEvm,
    holderEvm,
  ]);
  const { data: body } = await rpc.post("", {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: securityEvm, data }, "latest"],
  });
  const result = body?.result as string | undefined;
  if (!result || result === "0x") return false;
  return Boolean(
    iface.decodeFunctionResult("isOperatorForPartition", result)[0],
  );
}

export interface SecurityClearingInput {
  securityId: string;
  targetId: string;
  partitionId?: string;
  amount?: string;
  clearingId?: number;
  clearingOperationType?: number;
  expirationDate?: string;
  sourceId?: string;
  mode?: "holder" | "operator-from";
}

export interface ClearingTxResult {
  clearingId?: number;
  transactionId?: string;
  raw: unknown;
}

export async function initiateClearingTransfer(
  input: SecurityClearingInput,
): Promise<ClearingTxResult> {
  assertATSInitialized();

  if (!input.securityId) throw new Error("securityId is required");
  if (!input.targetId) throw new Error("targetId is required");

  const mode = input.mode ?? (input.sourceId ? "operator-from" : "holder");

  if (input.sourceId && input.sourceId === input.targetId) {
    throw new Error(
      `sourceId and targetId are the same (${input.sourceId}). ` +
      `Clearing must move supplier → investor.`,
    );
  }

  const partitionId = input.partitionId || DEFAULT_PARTITION;
  const amount = BigDecimal.fromString(String(input.amount ?? "1"), 0);
  const expirationUnix = input.expirationDate || defaultExpirationUnix();
  const expirationDate = BigDecimal.fromString(
    expirationUnix.substring(0, 10),
    0,
  );

  const securityEvm = await resolveContractEvm(input.securityId);
  const targetEvm = await resolveAccountEvm(input.targetId);
  const adapter = Injectable.resolve(RPCTransactionAdapter);

  console.log("[clearing] initiate", {
    mode,
    securityId: input.securityId,
    securityEvm,
    targetId: input.targetId,
    targetEvm,
    sourceId: input.sourceId,
    partitionId,
    amount: amount.toString(),
    expirationUnix,
  });

  let result: any;

  if (mode === "holder") {
    console.log(
      "[clearing] clearingTransferByPartition (holder = current ATS account)",
    );
    result = await adapter.clearingTransferByPartition(
      securityEvm,
      partitionId,
      amount,
      targetEvm,
      expirationDate,
    );
  } else {
    if (!input.sourceId) {
      throw new Error('mode "operator-from" requires sourceId');
    }
    const sourceEvm = await resolveAccountEvm(input.sourceId);
    const operatorEvm = await resolveAccountEvm(env.HEDERA_OPERATOR_ID);

    const authorizedGlobal = await isOperatorForHolder(
      securityEvm,
      operatorEvm,
      sourceEvm,
    );
    const authorizedForPartition = await isOperatorForPartition(
      securityEvm,
      partitionId,
      operatorEvm,
      sourceEvm,
    );
    if (!authorizedGlobal && !authorizedForPartition) {
      throw new Error(
        `isOperator(${operatorEvm}, ${sourceEvm}) and isOperatorForPartition(${partitionId}, ${operatorEvm}, ${sourceEvm}) are both false. ` +
        `Authorize the operator (global and per-partition) with the supplier signer first.`,
      );
    }

    result = await adapter.clearingTransferFromByPartition(
      securityEvm,
      partitionId,
      amount,
      sourceEvm,
      targetEvm,
      expirationDate,
    );
  }

  console.log(
    "[clearing] initiate raw keys",
    result && typeof result === "object" ? Object.keys(result) : typeof result,
  );
  console.log(
    "[clearing] initiate raw.response",
    result?.response != null
      ? JSON.stringify(result.response, (_, v) =>
          typeof v === "bigint" ? v.toString() : v,
        )
      : null,
  );

  const clearingId = extractClearingId(result);

  console.log("[clearing] initiate done", {
    clearingId,
    transactionId: result?.id ?? result?.transactionId,
  });

  return {
    clearingId,
    transactionId: result?.id ?? result?.transactionId,
    raw: result,
  };
}

export async function approveClearingTransfer(
  input: SecurityClearingInput,
): Promise<ClearingTxResult> {
  assertATSInitialized();

  if (!input.securityId) throw new Error("securityId is required");
  if (!input.targetId) throw new Error("targetId is required");
  if (input.clearingId === undefined || input.clearingId === null) {
    throw new Error("clearingId is required for approval");
  }
  if (!Number.isFinite(input.clearingId) || input.clearingId < 0) {
    throw new Error(`invalid clearingId: ${input.clearingId}`);
  }
  if (
    input.clearingId === 0 &&
    process.env.ALLOW_CLEARING_ID_ZERO !== "true"
  ) {
    throw new Error(
      "clearingId 0 is not a valid pending operation; pass the id from initiateClearingTransfer",
    );
  }

  const partitionId = input.partitionId || DEFAULT_PARTITION;
  const clearingOperationType =
    input.clearingOperationType ?? CLEARING_OPERATION_TRANSFER;

  const securityEvm = await resolveContractEvm(input.securityId);
  const targetEvm = await resolveAccountEvm(input.targetId);
  const adapter = Injectable.resolve(RPCTransactionAdapter);

  console.log("[clearing] approve (validator)", {
    securityEvm,
    targetEvm,
    partitionId,
    clearingId: input.clearingId,
    clearingOperationType,
  });

  const result = await adapter.approveClearingOperationByPartition(
    securityEvm,
    partitionId,
    targetEvm,
    input.clearingId,
    clearingOperationType,
  );

  return {
    transactionId: result?.id ?? result?.transactionId,
    raw: result,
  };
}

export async function cancelClearingTransfer(
  input: SecurityClearingInput,
): Promise<ClearingTxResult> {
  assertATSInitialized();
  if (!input.securityId) throw new Error("securityId is required");
  if (!input.targetId) throw new Error("targetId is required");
  if (input.clearingId === undefined || input.clearingId === null) {
    throw new Error("clearingId is required to cancel");
  }

  const partitionId = input.partitionId || DEFAULT_PARTITION;
  const clearingOperationType =
    input.clearingOperationType ?? CLEARING_OPERATION_TRANSFER;
  const securityEvm = await resolveContractEvm(input.securityId);
  const targetEvm = await resolveAccountEvm(input.targetId);
  const adapter = Injectable.resolve(RPCTransactionAdapter);

  const result = await adapter.cancelClearingOperationByPartition(
    securityEvm,
    partitionId,
    targetEvm,
    input.clearingId,
    clearingOperationType,
  );

  return {
    transactionId: result?.id ?? result?.transactionId,
    raw: result,
  };
}

export async function reclaimClearingTransfer(
  input: SecurityClearingInput,
): Promise<ClearingTxResult> {
  assertATSInitialized();
  if (!input.securityId) throw new Error("securityId is required");
  if (!input.targetId) throw new Error("targetId is required");
  if (input.clearingId === undefined || input.clearingId === null) {
    throw new Error("clearingId is required to reclaim");
  }

  const partitionId = input.partitionId || DEFAULT_PARTITION;
  const clearingOperationType =
    input.clearingOperationType ?? CLEARING_OPERATION_TRANSFER;
  const securityEvm = await resolveContractEvm(input.securityId);
  const targetEvm = await resolveAccountEvm(input.targetId);
  const adapter = Injectable.resolve(RPCTransactionAdapter);

  const result = await adapter.reclaimClearingOperationByPartition(
    securityEvm,
    partitionId,
    targetEvm,
    input.clearingId,
    clearingOperationType,
  );

  return {
    transactionId: result?.id ?? result?.transactionId,
    raw: result,
  };
}

export class ClearingAdapter {
  constructor(_clearingService?: unknown) { }

  async initiateSecurityTransfer(input: SecurityClearingInput) {
    return initiateClearingTransfer({
      ...input,
      mode: input.mode ?? "holder",
      partitionId: input.partitionId || DEFAULT_PARTITION,
    });
  }

  async approveSecurityTransfer(input: SecurityClearingInput) {
    return approveClearingTransfer({
      ...input,
      partitionId: input.partitionId || DEFAULT_PARTITION,
    });
  }

  async cancelSecurityTransfer(input: SecurityClearingInput) {
    return cancelClearingTransfer(input);
  }

  async reclaimSecurityTransfer(input: SecurityClearingInput) {
    return reclaimClearingTransfer(input);
  }
}