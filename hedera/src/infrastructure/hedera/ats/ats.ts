import "reflect-metadata";

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import axios from "axios";
import { FetchRequest, JsonRpcProvider, Wallet } from "ethers";

import {
  env,
  networkConfig,
  requireHederaEnv,
} from "../config.js";

let initialized = false;
let fetchTransportRegistered = false;
let currentAccountId: string | null = null;

const require = createRequire(import.meta.url);

const sdk: any = require("@hashgraph/asset-tokenization-sdk");

const sdkRoot = dirname(
  require.resolve("@hashgraph/asset-tokenization-sdk"),
);

const Injectable = require(
  join(sdkRoot, "core/injectable/Injectable.js"),
).default;

const { RPCTransactionAdapter } = require(
  join(sdkRoot, "port/out/rpc/RPCTransactionAdapter.js"),
);

const { RPCQueryAdapter } = require(
  join(sdkRoot, "port/out/rpc/RPCQueryAdapter.js"),
);

const Account = require(
  join(sdkRoot, "domain/context/account/Account.js"),
).default;

function registerAxiosFetchTransport(): void {
  if (fetchTransportRegistered) return;

  FetchRequest.registerGetUrl(async (req) => {
    const method = (req.method || "GET").toUpperCase();
    const headers: Record<string, string> = {};
    const reqHeaders = req.headers || {};
    for (const key of Object.keys(reqHeaders)) {
      const value = (reqHeaders as Record<string, unknown>)[key];
      if (value == null) continue;
      headers[key] = String(value);
    }

    let data: unknown = undefined;
    const body = req.body;
    if (body != null) {
      if (typeof body === "string") {
        data = body;
      } else if (body instanceof Uint8Array) {
        data = Buffer.from(body);
      } else if (typeof Buffer !== "undefined" && Buffer.isBuffer(body)) {
        data = body;
      } else {
        data = Buffer.from(body as ArrayBufferLike);
      }
    }

    let rpcMethod = "?";
    try {
      const raw =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : data instanceof Uint8Array
              ? Buffer.from(data).toString("utf8")
              : "";
      if (raw) {
        const parsed = JSON.parse(raw);
        rpcMethod = Array.isArray(parsed)
          ? parsed.map((p: { method?: string }) => p.method).join(",")
          : (parsed?.method ?? "?");
      }
    } catch {
      // ignore
    }

    console.log("[rpc] →", method, rpcMethod);

    const response = await axios.request({
      url: req.url,
      method,
      headers,
      data,
      responseType: "arraybuffer",
      timeout: 30_000,
      validateStatus: () => true,
    });

    console.log("[rpc] ←", rpcMethod, "status", response.status);

    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers || {})) {
      if (value == null) continue;
      responseHeaders[key] = Array.isArray(value)
        ? value.join(",")
        : String(value);
    }

    return {
      statusCode: response.status,
      statusMessage: response.statusText || "",
      headers: responseHeaders,
      body: new Uint8Array(response.data as ArrayBuffer),
    };
  });

  fetchTransportRegistered = true;
  console.log("[ats] ethers FetchRequest → axios transport registered");
}

function createProvider(): JsonRpcProvider {
  const chainId = env.HEDERA_NETWORK === "mainnet" ? 295 : 296;
  return new JsonRpcProvider(networkConfig.rpcNode, chainId, {
    staticNetwork: true,
  });
}

export async function initializeATS(): Promise<void> {
  if (initialized) return;

  requireHederaEnv(
    "ATS_RESOLVER_ID",
    "ATS_FACTORY_ID",
    "HEDERA_OPERATOR_ID",
    "HEDERA_OPERATOR_PRIVATE_KEY",
  );

  registerAxiosFetchTransport();

  console.log("[ats] Network.init...");
  const request = new sdk.InitializationRequest({
    network: env.HEDERA_NETWORK,
    mirrorNode: {
      baseUrl: networkConfig.mirrorNode,
      apiKey: "",
      headerName: "",
    },
    rpcNode: {
      baseUrl: networkConfig.rpcNode,
      apiKey: "",
      headerName: "",
    },
    configuration: {
      resolverAddress: env.ATS_RESOLVER_ID,
      factoryAddress: env.ATS_FACTORY_ID,
    },
  });
  await sdk.Network.init(request);
  console.log("[ats] Network.init done");

  try {
    const queryAdapter = Injectable.resolve(RPCQueryAdapter);
    queryAdapter.provider = createProvider();
    console.log("[ats] RPCQueryAdapter.provider replaced");
  } catch {
    // optional
  }

  const provider = createProvider();

  console.log("[ats] probing eth_blockNumber...");
  const blockNumber = await provider.getBlockNumber();
  console.log("[ats] eth_blockNumber =", blockNumber);

  const signer = new Wallet(env.HEDERA_OPERATOR_PRIVATE_KEY, provider);
  const transactionAdapter = Injectable.resolve(RPCTransactionAdapter);

  console.log("[ats] transactionAdapter.init...");
  await transactionAdapter.init(true);
  console.log("[ats] transactionAdapter.init done");

  transactionAdapter.setSignerOrProvider(signer);

  const operatorAccount = new Account({
    id: env.HEDERA_OPERATOR_ID,
  });

  console.log("[ats] transactionAdapter.register...");
  await transactionAdapter.register(operatorAccount, true);
  console.log("[ats] transactionAdapter.register done");

  currentAccountId = env.HEDERA_OPERATOR_ID;
  initialized = true;
  console.log("[ats] initializeATS complete");
}

export function assertATSInitialized(): void {
  if (!initialized) {
    throw new Error(
      "ATS is not initialized. Call initializeATS() first.",
    );
  }
}

/** Switch active ATS signer (e.g. supplier agent for holder clearing). */
export async function registerAtsSigner(
  accountId: string,
  privateKeyHex: string,
): Promise<void> {
  assertATSInitialized();
  if (!accountId) throw new Error("accountId is required");
  if (!privateKeyHex) throw new Error("privateKeyHex is required");

  const provider = createProvider();
  const key = privateKeyHex.startsWith("0x")
    ? privateKeyHex
    : `0x${privateKeyHex}`;
  const signer = new Wallet(key, provider);
  const transactionAdapter = Injectable.resolve(RPCTransactionAdapter);

  transactionAdapter.setSignerOrProvider(signer);
  await transactionAdapter.register(new Account({ id: accountId }), true);

  currentAccountId = accountId;
  console.log("[ats] registerAtsSigner", { accountId });
}

/** Restore FACTORED operator as active signer. */
export async function registerOperatorSigner(): Promise<void> {
  await registerAtsSigner(
    env.HEDERA_OPERATOR_ID,
    env.HEDERA_OPERATOR_PRIVATE_KEY,
  );
}

export function getCurrentAtsAccountId(): string | null {
  return currentAccountId;
}