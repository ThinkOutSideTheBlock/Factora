import { createRequire } from "node:module";
import axios from "axios";
import { env, networkConfig } from "../config.js";
import { assertATSInitialized } from "./ats.js";

const require = createRequire(import.meta.url);

/*
 * Terminal3 VC toolchain shipped alongside the ATS SDK (CJS).
 *
 * ATS grantKyc verifies the credential cryptographically before it will
 * grant KYC on-chain: the VC must carry an EcdsaSecp256k1Signature2019
 * proof signed by the issuer's ECDSA key over the exact credential JSON,
 * with issuer/holder DIDs in did:ethr form (the verifier recovers the
 * signer from the VC's own issuer DID — did:ethr:<operator EVM>).
 */
const ecdsaVc: any = require("@terminal3/ecdsa_vc");
const vcCore: any = require("@terminal3/vc_core");

const mirror = axios.create({
  baseURL: networkConfig.mirrorNode,
  timeout: 30_000,
});

export async function resolveAccountEvmAddress(accountId: string): Promise<string> {
  if (accountId.startsWith("0x") && accountId.length === 42) {
    return accountId.toLowerCase();
  }
  const { data } = await mirror.get(`accounts/${accountId}`);
  if (!data?.evm_address) throw new Error(`No evm_address for ${accountId}`);
  return data.evm_address.startsWith("0x")
    ? data.evm_address
    : `0x${data.evm_address}`;
}

export async function resolveContractEvmAddress(securityId: string): Promise<string> {
  const { data } = await mirror.get(`contracts/${securityId}`);
  if (!data?.evm_address) throw new Error(`No evm_address for ${securityId}`);
  return data.evm_address.startsWith("0x")
    ? data.evm_address
    : `0x${data.evm_address}`;
}

export interface InvestorKycVc {
  /** The full signed credential (Terminal3 shape). */
  vc: any;
  vcId: string;
  vcBase64: string;
  issuerDid: string;
  holderDid: string;
}

export async function createInvestorKycVc(input: {
  securityId: string;
  investorAccountId: string;
  receivableId?: string;
}): Promise<InvestorKycVc> {
  assertATSInitialized();

  const subjectEvm = await resolveAccountEvmAddress(input.investorAccountId);

  // Issuer DID derived from the operator's ECDSA key — did:ethr:<operator
  // EVM>. That identity is the one registered as the on-chain SSI issuer
  // by bootstrapSecurityForOperator, so checkIssuer(securityId, issuer)
  // passes.
  const issuer = new ecdsaVc.EthrDID(env.HEDERA_OPERATOR_PRIVATE_KEY);

  // Holder DID — did:ethr:<investor EVM>. grantKyc pops the last DID
  // segment of credentialSubject.id and compares it with the target EVM.
  const holder = new vcCore.DID("ethr", subjectEvm);

  const validFrom = new Date();
  const validUntil = new Date(validFrom.getTime() + 365 * 24 * 60 * 60 * 1000);

  const vc = await ecdsaVc.createEcdsaCredential(
    issuer,
    holder,
    {
      accountId: input.investorAccountId,
      evmAddress: subjectEvm,
      securityId: input.securityId,
      receivableId: input.receivableId ?? "",
      kycStatus: "GRANTED",
    },
    ["FactoredKycCredential"],
    validFrom,
    validUntil,
  );

  return {
    vc,
    vcId: vc.id,
    vcBase64: Buffer.from(JSON.stringify(vc), "utf8").toString("base64"),
    issuerDid: issuer.did,
    holderDid: holder.did,
  };
}