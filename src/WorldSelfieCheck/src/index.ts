import Fastify from "fastify";
import cors from "@fastify/cors";
import dotenv from "dotenv";
import { signRequest } from "@worldcoin/idkit/signing";
import { store } from "./store.js";

dotenv.config();

const app = Fastify({ logger: true });

// Allow frontend to call us
await app.register(cors, { origin: true });

// ============================================================
// ENDPOINT 1 — Sign RP context
// ============================================================
app.post("/api/world/rp-signature", async (req, reply) => {
    const body = req.body as { tradeId?: string };
    const tradeId = body.tradeId || "unknown";

    const { sig, nonce, createdAt, expiresAt } = signRequest({
        signingKeyHex: process.env.WORLD_RP_SIGNING_KEY!,
        action: "factored-mandate-escalation",
        ttl: 300,
    });

    return {
        rp_id: process.env.WORLD_RP_ID,
        nonce,
        created_at: createdAt,
        expires_at: expiresAt,
        signature: sig,
        signal: tradeId,
    };
});

// ============================================================
// ENDPOINT 2 — Verify proof + unlock trade
// ============================================================
app.post("/api/trades/:id/authorize", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { proof } = req.body as { proof: any };

    // 1. Check trade exists and needs escalation
    const trade = store.getTrade(id);
    if (!trade) {
        return reply.code(404).send({ error: "TRADE_NOT_FOUND" });
    }
    if (trade.mandateDecision !== "ESCALATE") {
        return reply.code(409).send({ error: "TRADE_DOES_NOT_REQUIRE_ESCALATION" });
    }

    // === DEBUG LOGGING ===
    console.log("=== PROOF BEING SENT TO WORLD ===");
    console.log(JSON.stringify(proof, null, 2));

    // 2. Forward the proof BYTE-FOR-BYTE to World
    const verifyRes = await fetch(
        `https://developer.world.org/api/v4/verify/${process.env.WORLD_RP_ID}`,
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(proof),
        }
    );

    const result = await verifyRes.json();

    console.log("=== WORLD RESPONSE ===");
    console.log(JSON.stringify(result, null, 2));

    if (!result.success) {
        return reply.code(403).send({
            error: "WORLD_VERIFICATION_FAILED",
            details: result,
        });
    }

    // 3. Extract nullifier (World returns it in different places)
    const nullifier =
        result.nullifier ||
        result.results?.find((r: any) => r.identifier === "orb")?.nullifier ||
        result.results?.find((r: any) => r.identifier === "selfie")?.nullifier ||
        result.responses?.find((r: any) => r.identifier === "orb")?.nullifier ||
        result.responses?.find((r: any) => r.identifier === "selfie")?.nullifier;

    if (!nullifier) {
        return reply.code(403).send({ error: "NO_NULLIFIER_FOUND", details: result });
    }

    // 4. Replay protection
    if (store.hasNullifier(nullifier)) {
        return reply.code(409).send({ error: "PROOF_ALREADY_USED" });
    }
    store.recordNullifier(nullifier);

    // 5. Unlock the trade
    const authorizationId = `WORLD-${nullifier}`;
    const updated = store.updateTrade(id, {
        authorizationId,
        status: "AUTHORIZED",
    });

    // 6. Audit log
    store.addAudit(trade.receivableId, {
        type: "WORLD_AUTHORIZED",
        tradeId: id,
        authorizationId,
        nullifier,
        timestamp: Date.now(),
    });

    return updated;
});

// ============================================================
// Helper – create a test trade
// ============================================================
app.post("/api/trades/create-test", async (req, reply) => {
    const body = req.body as { id?: string };
    const id = body.id || `trade-${Date.now()}`;
    const trade = store.createEscalationTrade(id);
    return trade;
});

// Start the server
const port = Number(process.env.PORT) || 3000;
app.listen({ port, host: "0.0.0.0" }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Backend running on http://localhost:${port}`);
});
