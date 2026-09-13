import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import axios from "axios";
import { AbiCoder, Interface } from "ethers";

import { networkConfig } from "../config.js";

const require = createRequire(import.meta.url);
const sdk: any = require("@hashgraph/asset-tokenization-sdk");
const sdkRoot = dirname(require.resolve("@hashgraph/asset-tokenization-sdk"));
const { KycStatus } = require(join(sdkRoot, "domain/context/kyc/Kyc.js"));

export const KYC_STATUS_NOT_GRANTED: number = KycStatus.NOT_GRANTED;
export const KYC_STATUS_GRANTED: number = KycStatus.GRANTED;

/*
 * ABI ground truth from the installed ATS contracts package.
 * Calldata and decode types are derived from it — no hand-written
 * selectors or flat type lists. getKycFor returns ONE struct.
 */
function loadKycInterface(): Interface {
  try {
    const artifact = require(
      "@hashgraph/asset-tokenization-contracts/artifacts/contracts/facets/kyc/IKyc.sol/IKyc.json",
    );
    return new Interface(artifact.abi);
  } catch {
    const contracts: any = require("@hashgraph/asset-tokenization-contracts");
    const abi =
      contracts.IKyc__factory?.abi ??
      contracts.IAsset__factory?.abi;
    if (!abi) {
      throw new Error(
        "Could not load KYC ABI from @hashgraph/asset-tokenization-contracts",
      );
    }
    return new Interface(abi);
  }
}

const kycIface = loadKycInterface();

function requireFunction(name: string) {
  const fn = kycIface.getFunction(name);
  if (!fn) {
    throw new Error(`Function ${name} not found in KYC ABI`);
  }
  if (!fn.outputs || fn.outputs.length === 0) {
    throw new Error(`Function ${name} has no outputs in KYC ABI`);
  }
  return fn;
}

const rpc = axios.create({
  baseURL: networkConfig.rpcNode,
  headers: { "Content-Type": "application/json" },
  timeout: 30_000,
});

const mirror = axios.create({
  baseURL: networkConfig.mirrorNode,
  timeout: 30_000,
});

/*
 * Raw JSON-RPC over axios (proxy-safe).
 * Retry empty "0x" results (relay hiccups) instead of crashing in ABI decode.
 */
async function ethCall(to: string, data: string): Promise<string> {
  const attempts = 3;
  let result = "0x";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await rpc.post("", {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    });

    if (response.data?.error) {
      throw new Error(
        `eth_call failed: ${JSON.stringify(response.data.error)}`,
      );
    }

    result = response.data?.result ?? "0x";

    if (result !== "0x") {
      return result;
    }

    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
    }
  }

  throw new Error(
    `eth_call returned an empty result ${attempts}x ` +
    `(relay hiccup or rate limit?): to=${to} selector=${data.slice(0, 10)}`,
  );
}

async function resolveSecurityEvmAddress(securityId: string): Promise<string> {
  const { data } = await mirror.get(`contracts/${securityId}`);
  if (!data?.evm_address) {
    throw new Error(`Mirror node returned no evm_address for ${securityId}`);
  }
  return data.evm_address;
}

export async function resolveAccountEvmAddress(
  accountId: string,
): Promise<string> {
  const { data } = await mirror.get(`accounts/${accountId}`);
  if (!data?.evm_address) {
    throw new Error(`Mirror node returned no evm_address for ${accountId}`);
  }
  return data.evm_address;
}

export async function getInvestorKycStatus(
  securityId: string,
  investorAccountId: string,
): Promise<number> {
  const securityEvmAddress = await resolveSecurityEvmAddress(securityId);
  const investorEvmAddress = await resolveAccountEvmAddress(investorAccountId);

  const fn = requireFunction("getKycStatusFor");
  const data = kycIface.encodeFunctionData(fn, [investorEvmAddress]);
  const result = await ethCall(securityEvmAddress, data);

  const [status] = AbiCoder.defaultAbiCoder().decode(fn.outputs, result);
  return Number(status);
}

export interface InvestorKycRecord {
  status: number;
  validFrom?: string;
  validTo?: string;
  vcId?: string;
  issuer?: string;
}

export async function getInvestorKyc(
  securityId: string,
  investorAccountId: string,
): Promise<InvestorKycRecord> {
  const securityEvmAddress = await resolveSecurityEvmAddress(securityId);
  const investorEvmAddress = await resolveAccountEvmAddress(investorAccountId);

  const fn = requireFunction("getKycFor");
  const data = kycIface.encodeFunctionData(fn, [investorEvmAddress]);
  const result = await ethCall(securityEvmAddress, data);

  /*
   * getKycFor returns a single struct:
   *   KycData(uint256 validFrom, uint256 validTo, string vcId,
   *           address issuer, uint8 status)
   */
  const [kyc] = AbiCoder.defaultAbiCoder().decode(fn.outputs, result);

  return {
    status: Number(kyc[4]),
    validFrom: kyc[0].toString(),
    validTo: kyc[1].toString(),
    vcId: kyc[2],
    issuer: kyc[3],
  };
}

export interface GrantInvestorKycInput {
  securityId: string;
  investorAccountId: string;
  vcBase64: string;
}

export async function grantInvestorKyc(input: GrantInvestorKycInput) {
  if (!input.securityId) throw new Error("securityId is required");
  if (!input.investorAccountId) throw new Error("investorAccountId is required");
  if (!input.vcBase64) throw new Error("vcBase64 is required");

  const request = new sdk.GrantKycRequest({
    securityId: input.securityId,
    targetId: input.investorAccountId,
    vcBase64: input.vcBase64,
  });

  return await sdk.Kyc.grantKyc(request);
}

export class ATSKycAdapter {
  async grantInvestorKyc(input: GrantInvestorKycInput) {
    return await grantInvestorKyc(input);
  }
  async getInvestorKycStatus(securityId: string, investorAccountId: string) {
    return await getInvestorKycStatus(securityId, investorAccountId);
  }
  async getInvestorKyc(securityId: string, investorAccountId: string) {
    return await getInvestorKyc(securityId, investorAccountId);
  }
}