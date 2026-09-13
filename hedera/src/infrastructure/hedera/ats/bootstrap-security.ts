import { createRequire } from "node:module";
import { assertATSInitialized } from "./ats.js";

const require = createRequire(import.meta.url);
const sdk: any = require("@hashgraph/asset-tokenization-sdk");

export const ISSUER_ROLE =
    "0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f";
export const KYC_ROLE =
    "0x754f499f9fdfbb089d12bdec817a6863d593d8a3ea7f546c00a5cafd20957bfc";
export const CLEARING_VALIDATOR_ROLE =
    "0xa24ef577c383d98a9326f932c69c76129dd89a71abcb626993d9f047f4e74abb";
export const SSI_MANAGER_ROLE =
    "0x3120494a82251fe85b0403877539486dbfcf0f94c20741a3229cfad31f625ee1";
export const MATURITY_REDEEMER_ROLE =
    "0x433f48f8aca23480f6ab07666cbc9131d32a0b4672033453f65e18f4dd390523";

/** Once per new security, before KYC / issue / clearing. */
export async function bootstrapSecurityForOperator(
    securityId: string,
    operatorAccountId: string,
): Promise<void> {
    assertATSInitialized();
    if (!securityId) throw new Error("securityId is required");
    if (!operatorAccountId) throw new Error("operatorAccountId is required");

    console.log("[bootstrap] applyRoles", { securityId, operatorAccountId });

    await sdk.Role.applyRoles(
        new sdk.ApplyRolesRequest({
            securityId,
            targetId: operatorAccountId,
            roles: [
                ISSUER_ROLE,
                KYC_ROLE,
                CLEARING_VALIDATOR_ROLE,
                SSI_MANAGER_ROLE,
                MATURITY_REDEEMER_ROLE,
            ],
            actives: [true, true, true, true, true],
        }),
    );

    console.log("[bootstrap] SsiManagement.addIssuer", {
        securityId,
        issuerId: operatorAccountId,
    });

    await sdk.SsiManagement.addIssuer(
        new sdk.AddIssuerRequest({
            securityId,
            issuerId: operatorAccountId,
        }),
    );

    console.log("[bootstrap] complete", { securityId });
}