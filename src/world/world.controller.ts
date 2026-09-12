import { Router, Request, Response } from "express";
import { validateBody } from "../common/validate.middleware.js";
import { createLogger } from "../common/logger.js";
import {
    RpSignatureRequestSchema,
    SelfieVerifyRequestSchema,
    type RpSignatureRequestDto,
    type SelfieVerifyRequestDto,
} from "./selfie-check.model.js";
import {
    SelfieSignConflictError,
    WorldVerificationError,
    recordBuyerSignature,
    recordSelfieCheck,
    signRpContext,
    verifyProofWithWorld,
} from "./selfie-check.service.js";

const log = createLogger("world");

export const worldRouter = Router();

/**
 * GET /api/world/config
 * Readiness probe for the UI: tells the dashboard whether the backend is
 * configured to run Selfie Check (RP id + signing key present).
 */
worldRouter.get("/config", (req: Request, res: Response): void => {
    const rpId = process.env.WORLD_RP_ID;
    const signingKey = process.env.WORLD_RP_SIGNING_KEY;
    res.status(200).json({
        enabled: Boolean(rpId && signingKey),
        rpId: rpId ?? null,
        action: "mandatory-selfie-check",
        environment: "staging",
        verifyEndpoint: rpId
            ? `https://developer.world.org/api/v4/verify/${rpId}`
            : null,
    });
});

/**
 * POST /api/world/rp-signature
 * Signs a short-lived RP context for one proposal. The frontend passes this
 * to IDKit as `rp_context` when it opens the Selfie Check flow.
 */
worldRouter.post(
    "/rp-signature",
    validateBody(RpSignatureRequestSchema),
    async (req: Request, res: Response): Promise<void> => {
        try {
            const { proposalId, signingKey } = req.body as RpSignatureRequestDto;
            const context = signRpContext(proposalId, signingKey);
            res.status(200).json(context);
        } catch (error) {
            log.error("RP signature failed", error);
            res.status(500).json({
                error:
                    error instanceof Error
                        ? error.message
                        : "Failed to sign RP context",
            });
        }
    },
);

/**
 * POST /api/world/verify
 * Verifies a Selfie Check proof produced by IDKit.
 *
 * - `role: "buyer"`  → the buyer proves they are human to sign (buy) the
 *   proposal: status flips PENDING → ACCEPTED and the buyer's signature
 *   (nullifier + timestamp) is recorded.
 * - `role: "seller"` → the seller confirms they are a real, live human after
 *   a buyer signed; the `selfieCheck` record is persisted on the proposal.
 *
 * The raw proof is forwarded byte-for-byte to World. Replay protection comes
 * from the per-proposal, single-use RP context that World validates
 * server-side; the same person may act on multiple proposals.
 */
worldRouter.post(
    "/verify",
    validateBody(SelfieVerifyRequestSchema),
    async (req: Request, res: Response): Promise<void> => {
        const { proposalId, proof, role } = req.body as SelfieVerifyRequestDto;
        try {
            const { nullifier } = await verifyProofWithWorld(proof);

            if (role === "buyer") {
                const proposal = await recordBuyerSignature(proposalId, nullifier);
                res.status(200).json({
                    message: "Selfie check successful — proposal signed",
                    proposalId,
                    role,
                    buyerSignature: proposal.buyerSignature,
                    status: proposal.status,
                });
                return;
            }

            const proposal = await recordSelfieCheck(proposalId, nullifier);
            res.status(200).json({
                message: "Selfie check successful",
                proposalId,
                role,
                selfieCheck: proposal.selfieCheck,
            });
        } catch (error) {
            if (error instanceof SelfieSignConflictError) {
                res.status(409).json({
                    error: "PROPOSAL_ALREADY_SIGNED",
                    message: error.message,
                });
                return;
            }
            if (error instanceof WorldVerificationError) {
                res.status(403).json({
                    error: error.code,
                    message: error.message,
                    details: error.details,
                });
                return;
            }
            if (error instanceof Error && error.message.startsWith("Proposal not found")) {
                res.status(404).json({ error: "PROPOSAL_NOT_FOUND", message: error.message });
                return;
            }
            log.error("Selfie Check verification failed", error);
            res.status(500).json({
                error: "SELFIE_CHECK_FAILED",
                message:
                    error instanceof Error ? error.message : "Unknown verification error",
            });
        }
    },
);
