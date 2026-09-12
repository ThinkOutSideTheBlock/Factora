import { signRequest } from "@worldcoin/idkit/signing";
import { createLogger } from "../common/logger.js";
import { getAllProposals, saveProposals } from "../proposal/proposal.storage.js";
import type { Proposal } from "../proposal/proposal.model.js";
import {
    RP_CONTEXT_TTL_SECONDS,
    SELFIE_CHECK_ACTION,
    type RpContextSignature,
    type SelfieCheckRecord,
    type WorldVerifyResponse,
} from "./selfie-check.model.js";

const log = createLogger("selfie-check");

export class WorldVerificationError extends Error {
    constructor(
        public readonly code: string,
        message: string,
        public readonly details?: unknown,
    ) {
        super(message);
        this.name = "WorldVerificationError";
    }
}

/**
 * World relying-party configuration. In this hackathon build the values come
 * from `.env`; the frontend only needs the app id,
 * which the user pastes into the Selfie Check modal.
 */
export function getRpId(): string {
    const rpId = process.env.WORLD_RP_ID;
    if (!rpId) {
        throw new Error(
            "WORLD_RP_ID is not configured. Set it in .env (e.g. WORLD_RP_ID=rp_...) to enable Selfie Check.",
        );
    }
    return rpId;
}

function getRpSigningKey(): string {
    const signingKey = process.env.WORLD_RP_SIGNING_KEY;
    if (!signingKey) {
        throw new Error(
            "WORLD_RP_SIGNING_KEY is not configured. Set it in .env to enable Selfie Check.",
        );
    }
    return signingKey;
}

/**
 * Signs a short-lived RP context for one proposal. The signature proves to
 * World ID that *this* backend (the relying party) initiated the Selfie Check
 * request for *this* proposal — it cannot be replayed for another proposal
 * or after expiry.
 *
 * `signingKeyOverride` lets the UI supply the RP private key directly (the
 * user pastes it into the Selfie Check modal); when omitted the key from
 * `.env` is used.
 */
export function signRpContext(
    proposalId: string,
    signingKeyOverride?: string,
): RpContextSignature {
    const { sig, nonce, createdAt, expiresAt } = signRequest({
        signingKeyHex: signingKeyOverride ?? getRpSigningKey(),
        action: SELFIE_CHECK_ACTION,
        ttl: RP_CONTEXT_TTL_SECONDS,
    });

    log.info(`Signed RP context for proposal=${proposalId} nonce=${nonce}`);
    return {
        rp_id: getRpId(),
        nonce,
        created_at: createdAt,
        expires_at: expiresAt,
        signature: sig,
        signal: proposalId,
    };
}

/** Extracts the nullifier from a World verify response (selfie or orb). */
function extractNullifier(result: WorldVerifyResponse): string | undefined {
    return (
        result.nullifier ||
        result.results?.find((r) => r.identifier === "selfie")?.nullifier ||
        result.results?.find((r) => r.identifier === "orb")?.nullifier ||
        result.responses?.find((r) => r.identifier === "selfie")?.nullifier ||
        result.responses?.find((r) => r.identifier === "orb")?.nullifier
    );
}

/**
 * Forwards the raw IDKit proof byte-for-byte to the World verify API for the
 * configured relying party. Throws `WorldVerificationError` on failure.
 */
export async function verifyProofWithWorld(
    proof: Record<string, unknown>,
): Promise<{ nullifier: string; result: WorldVerifyResponse }> {
    const rpId = getRpId();
    const response = await fetch(
        `https://developer.world.org/api/v4/verify/${rpId}`,
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(proof),
        },
    );

    let result: WorldVerifyResponse;
    try {
        result = (await response.json()) as WorldVerifyResponse;
    } catch {
        throw new WorldVerificationError(
            "WORLD_VERIFY_UNPARSEABLE",
            `World verify API returned HTTP ${response.status} with a non-JSON body.`,
        );
    }

    if (!result.success) {
        log.warn(
            `World verification failed: code=${result.code ?? "unknown"} detail=${result.detail ?? "n/a"}`,
        );
        throw new WorldVerificationError(
            "WORLD_VERIFICATION_FAILED",
            result.detail || result.code || "World rejected the Selfie Check proof.",
            result,
        );
    }

    const nullifier = extractNullifier(result);
    if (!nullifier) {
        throw new WorldVerificationError(
            "NO_NULLIFIER_FOUND",
            "World accepted the proof but no nullifier was returned.",
            result,
        );
    }

    return { nullifier, result };
}

/**
 * A person may verify (buy) multiple proposals, so there is no global
 * nullifier-uniqueness gate. Replay protection instead comes from the
 * per-proposal RP context: every request is signed with a fresh, single-use
 * nonce bound to one proposal (`signal: proposalId`), and World's verify API
 * rejects proofs whose RP context does not match — a captured proof cannot be
 * replayed for a different proposal.
 */

/**
 * Returns the persisted Selfie Check record for a proposal (or null).
 */
export async function getProposalSelfieCheck(
    proposalId: string,
): Promise<SelfieCheckRecord | null> {
    const proposals = await getAllProposals();
    const proposal = proposals.find((p) => p.id === proposalId);
    return proposal?.selfieCheck ?? null;
}

/**
 * Records the buyer's Selfie Check signature: the buyer proves they are a
 * real, live human to sign (buy) the proposal. Flips the proposal from
 * PENDING to ACCEPTED and stores the nullifier (the buyer's pseudonymous
 * identity) + timestamp — this is the "signed" signal the seller sees.
 */
export async function recordBuyerSignature(
    proposalId: string,
    nullifier: string,
): Promise<Proposal> {
    const proposals = await getAllProposals();
    const index = proposals.findIndex((p) => p.id === proposalId);
    if (index === -1) {
        throw new Error(`Proposal not found: ${proposalId}`);
    }
    const proposal = proposals[index];

    if (proposal.status !== "PENDING") {
        throw new SelfieSignConflictError(
            `Proposal ${proposalId.slice(0, 8)}… has already been signed by another buyer.`,
        );
    }

    const updated: Proposal = {
        ...proposal,
        status: "ACCEPTED",
        buyerSignature: { nullifier, signedAt: new Date().toISOString() },
    };
    proposals[index] = updated;
    await saveProposals(proposals);

    log.info(
        `Proposal signed via Selfie Check: proposal=${proposalId} buyerNullifier=${nullifier.slice(0, 12)}…`,
    );
    return updated;
}

export class SelfieSignConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SelfieSignConflictError";
    }
}

/**
 * Records a successful Selfie Check on a proposal and persists it. The
 * verification is an eligibility / abuse-prevention signal: proposals carry a
 * "human-verified proposer" marker that buyers and the underwriter can weigh.
 */
export async function recordSelfieCheck(
    proposalId: string,
    nullifier: string,
): Promise<Proposal> {
    const proposals = await getAllProposals();
    const index = proposals.findIndex((p) => p.id === proposalId);
    if (index === -1) {
        throw new Error(`Proposal not found: ${proposalId}`);
    }

    const record: SelfieCheckRecord = {
        status: "VERIFIED",
        nullifier,
        action: SELFIE_CHECK_ACTION,
        rpId: getRpId(),
        authorizationId: `WORLD-${nullifier}`,
        verifiedAt: new Date().toISOString(),
    };

    const updated: Proposal = { ...proposals[index], selfieCheck: record };
    proposals[index] = updated;
    await saveProposals(proposals);

    log.info(
        `Selfie Check verified: proposal=${proposalId} nullifier=${nullifier.slice(0, 12)}…`,
    );
    return updated;
}
