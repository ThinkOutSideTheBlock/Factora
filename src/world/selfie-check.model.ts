import { z } from "zod";

/**
 * Selfie Check (Beta) — World ID medium-assurance biometric credential.
 *
 * Factora treats a completed Selfie Check as an abuse-prevention /
 * eligibility signal on a debt proposal: a verified proposer is a real,
 * live human (not a scripted sybil), which lowers the fraud risk of the
 * listing. The verification is persisted on the proposal itself.
 */

/** Fixed action string, mirrored by the frontend IDKit request. */
export const SELFIE_CHECK_ACTION = "mandatory-selfie-check";

/** RP context signatures are short-lived (seconds). */
export const RP_CONTEXT_TTL_SECONDS = 300;

export const RpSignatureRequestSchema = z.object({
    proposalId: z.string().trim().min(1, "proposalId is required"),
    /**
     * Optional RP signing key override, pasted by the user in the Selfie Check
     * modal (hackathon demo flow). When omitted, the backend falls back to
     * WORLD_RP_SIGNING_KEY from .env. Must be a 0x-prefixed 32-byte hex key.
     */
    signingKey: z
        .string()
        .trim()
        .regex(
            /^0x[0-9a-fA-F]{64}$/,
            "signingKey must be a 0x-prefixed 32-byte hex string (64 hex chars)",
        )
        .optional(),
});
export type RpSignatureRequestDto = z.infer<typeof RpSignatureRequestSchema>;

/** Signed RP context handed to IDKit on the frontend (`rp_context`). */
export interface RpContextSignature {
    rp_id: string;
    nonce: string;
    created_at: number;
    expires_at: number;
    signature: string;
    signal: string;
}

export const SelfieVerifyRequestSchema = z.object({
    proposalId: z.string().trim().min(1, "proposalId is required"),
    /** Raw IDKit proof — forwarded byte-for-byte to the World verify API. */
    proof: z.record(z.string(), z.unknown()),
    /**
     * Who is verifying: the `buyer` performs Selfie Check to sign (buy) the
     * proposal (PENDING → ACCEPTED); the `seller` performs it afterwards to
     * confirm they are a real, live human before the deal proceeds.
     */
    role: z.enum(["buyer", "seller"]).default("seller"),
});
export type SelfieVerifyRequestDto = z.infer<typeof SelfieVerifyRequestSchema>;

/** Verification record persisted on a proposal. */
export const SelfieCheckRecordSchema = z.object({
    status: z.literal("VERIFIED"),
    nullifier: z.string().min(1),
    action: z.string().min(1),
    rpId: z.string().min(1),
    authorizationId: z.string().min(1),
    verifiedAt: z.string().datetime(),
});
export type SelfieCheckRecord = z.infer<typeof SelfieCheckRecordSchema>;

/** Subset of the World `/api/v2/verify/<rp_id>` response we rely on. */
export interface WorldVerifyResponse {
    success: boolean;
    nullifier?: string;
    results?: Array<{ identifier?: string; nullifier?: string }>;
    responses?: Array<{ identifier?: string; nullifier?: string }>;
    detail?: string;
    code?: string;
}
