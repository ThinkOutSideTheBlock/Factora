import { createRequire } from "node:module";

import { assertATSInitialized } from "./ats.js";
import { env } from "../config.js";

const require = createRequire(import.meta.url);

/*
 * IMPORTANT:
 * Load ATS through CommonJS.
 *
 * The v8 ESM build contains extensionless internal imports that
 * are problematic under Node 22, and mixing CJS Network.init()
 * with ESM Bond.create() creates separate SDK/DI containers.
 *
 * Both ATS initialization and Bond operations therefore use the
 * same CJS SDK graph.
 */
const sdk: any = require(
  "@hashgraph/asset-tokenization-sdk",
);

function currencyToBytes3(currency: string): string {
  const normalized = currency.toUpperCase();

  if (normalized === "USD") {
    return "0x555344";
  }

  throw new Error(
    `Unsupported ATS currency: ${currency}`,
  );
}

export interface CreateReceivableNoteInput {
  id: string;
  faceValueUsd: number;
  purchasePriceUsd: number;
  maturityTimestamp: number;
  riskGrade: string;
  debtorName: string;
  isin: string;
}

export async function createReceivableNote(
  input: CreateReceivableNoteInput,
): Promise<{
  securityId: string;
  transactionId: string;
}> {
  assertATSInitialized();

  const now = Math.floor(Date.now() / 1000);

  if (!input.id) {
    throw new Error("Receivable ID is required.");
  }

  if (
    !Number.isFinite(input.faceValueUsd) ||
    input.faceValueUsd <= 0
  ) {
    throw new Error(
      "Face value must be positive.",
    );
  }

  if (
    !Number.isFinite(input.purchasePriceUsd) ||
    input.purchasePriceUsd <= 0
  ) {
    throw new Error(
      "Purchase price must be positive.",
    );
  }

  if (
    input.purchasePriceUsd >=
    input.faceValueUsd
  ) {
    throw new Error(
      "Purchase price must be below face value.",
    );
  }

  if (input.maturityTimestamp <= now) {
    throw new Error(
      "Maturity must be in the future.",
    );
  }

  if (
    !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(
      input.isin,
    )
  ) {
    throw new Error(
      "ISIN must be a 12-character ATS-compatible identifier.",
    );
  }

  if (!env.ATS_CONFIG_ID) {
    throw new Error(
      "ATS_CONFIG_ID is required for bond creation.",
    );
  }

  if (
    !env.ATS_CONFIG_VERSION ||
    env.ATS_CONFIG_VERSION < 1
  ) {
    throw new Error(
      "ATS_CONFIG_VERSION must be at least 1.",
    );
  }

  /*
   * Create the actual ATS Bond request.
   *
   * This is a real ATS Bond, not a generic HTS token.
   */
  const request =
    new sdk.CreateBondRequest({
      name:
        `Factored Receivable ${input.id}`,

      symbol:
        `FR${input.id
          .replace(/[^A-Za-z0-9]/g, "")
          .slice(-8)
          .toUpperCase()}`,

      /*
       * One bond unit represents the receivable note.
       */
      decimals: 0,
      numberOfUnits: "1",

      isin: input.isin,

      /*
       * Core ATS security configuration.
       */
      isWhiteList: false,
      erc20VotesActivated: false,
      isControllable: true,
      arePartitionsProtected: false,
      isMultiPartition: false,

      clearingActive: true,
      internalKycActivated: true,

      /*
       * No external compliance contracts for this
       * initial FACTORED deployment.
       */
      externalPausesIds: [],
      externalControlListsIds: [],
      externalKycListsIds: [],

      /*
       * The operator owns/administers the deployed
       * ATS Bond Diamond.
       */
      diamondOwnerAccount:
        env.HEDERA_OPERATOR_ID,

      currency:
        currencyToBytes3("USD"),

      /*
       * Face value per bond unit.
       */
      nominalValue:
        input.faceValueUsd.toString(),

      nominalValueDecimals: 2,

      /*
       * ATS requires a future starting date.
       */
      startingDate:
        (now + 120).toString(),

      maturityDate:
        input.maturityTimestamp.toString(),

      /*
       * Reg S / no subtype.
       */
      regulationType: 1,
      regulationSubType: 0,

      isCountryControlListWhiteList:
        true,

      countries:
        "US,GB,CH",

      info: JSON.stringify({
        platform: "FACTORED",
        receivableId: input.id,
        debtor: input.debtorName,
        faceValueUsd:
          input.faceValueUsd,
        purchasePriceUsd:
          input.purchasePriceUsd,
        riskGrade: input.riskGrade,
        instrumentType:
          "ZERO_COUPON_DISCOUNT_RECEIVABLE_NOTE",
      }),

      /*
       * Current deployed ATS v8 configuration.
       */
      configId: env.ATS_CONFIG_ID,
      configVersion:
        env.ATS_CONFIG_VERSION,

      /*
       * No proceeds recipient at creation.
       */
      proceedRecipientsIds: [],
      proceedRecipientsData: [],
    });

  /*
   * IMPORTANT:
   * Bond.create() must come from the SAME CJS SDK instance
   * whose Network.init() was called by initializeATS().
   */
  const response =
    await sdk.Bond.create(request);

  const securityId =
    response?.security?.diamondAddress?.value;

  const transactionId =
    response?.transactionId;

  if (!securityId) {
    throw new Error(
      "ATS Bond.create() succeeded but response.security.diamondAddress.value is missing: " +
      JSON.stringify(response),
    );
  }

  if (!transactionId) {
    throw new Error(
      "ATS Bond.create() returned no transactionId: " +
      JSON.stringify(response),
    );
  }

  return {
    securityId,
    transactionId,
  };
}