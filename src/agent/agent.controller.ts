import { Router, Request, Response } from "express";
import {
    AgentWalletNotConfiguredError,
    getAgentWallet,
    paidRequest,
    type OnAgentStep,
} from "./payer.agent.js";
import { getX402Network } from "../x402/x402.middleware.js";
import { createLogger } from "../common/logger.js";

const log = createLogger("agent-api");

export const agentRouter = Router();

// The agent may only pay for our own paid endpoints.
const PAID_PATHS: readonly string[] = ["/api/proposals", "/api/buyer/smart-report"];

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function errorStatus(error: unknown): { status: number; code: string } {
    if (error instanceof AgentWalletNotConfiguredError) {
        return { status: 503, code: "AGENT_NOT_CONFIGURED" };
    }
    return { status: 502, code: "AGENT_PAYMENT_FAILED" };
}

/** Whether the "Pay" buttons in the UI can be enabled. Exposes no secrets. */
agentRouter.get("/status", (_req: Request, res: Response): void => {
    const wallet = getAgentWallet();
    log.debug("Agent status queried", {
        configured: wallet !== null,
        network: getX402Network(),
    });
    res.status(200).json({
        configured: wallet !== null,
        accountId: wallet?.accountId ?? null,
        network: getX402Network(),
        paidEndpoints: PAID_PATHS,
    });
});

/**
 * POST /api/agent/paid-request — { path, payload }
 * Pays through the agent wallet and returns { httpStatus, data, settlement }.
 */
agentRouter.post("/paid-request", async (req: Request, res: Response): Promise<void> => {
    const { path, payload } = (req.body ?? {}) as { path?: unknown; payload?: unknown };

    if (typeof path !== "string" || !PAID_PATHS.includes(path)) {
        log.warn(`Rejected paid-request proxy for non-whitelisted path: ${String(path)}`);
        res.status(400).json({
            error: `Invalid path. The agent may only pay for: ${PAID_PATHS.join(", ")}`,
        });
        return;
    }

    try {
        log.info(`Paid-request proxy → ${path}`);
        const result = await paidRequest(path, payload);
        res.status(200).json({ ok: true, ...result });
    } catch (error) {
        const { status, code } = errorStatus(error);
        log.error(`Paid-request proxy failed → ${path}: ${describeError(error)}`);
        res.status(status).json({ error: describeError(error), code });
    }
});

/**
 * POST /api/agent/paid-request/stream — { path, payload }
 * Same flow as /paid-request but streams progress as NDJSON lines:
 *   {"type":"step","step":"invoice","status":"running",...}
 *   {"type":"final","ok":true,"httpStatus":201,...}
 */
agentRouter.post("/paid-request/stream", async (req: Request, res: Response): Promise<void> => {
    const { path, payload } = (req.body ?? {}) as { path?: unknown; payload?: unknown };

    if (typeof path !== "string" || !PAID_PATHS.includes(path)) {
        log.warn(`Rejected streamed paid request for non-whitelisted path: ${String(path)}`);
        res.status(400).json({
            error: `Invalid path. The agent may only pay for: ${PAID_PATHS.join(", ")}`,
        });
        return;
    }

    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    const send = (obj: unknown): void => {
        res.write(JSON.stringify(obj) + "\n");
    };

    log.info(`Streamed paid request → ${path}`);
    const onStep: OnAgentStep = (event) => send({ type: "step", ...event });
    try {
        const result = await paidRequest(path, payload, onStep);
        send({ type: "final", ok: true, ...result });
        log.info(
            `Streamed paid request finished → ${path} (HTTP ${result.httpStatus}, ${result.durationMs}ms)`,
        );
    } catch (error) {
        const { code } = errorStatus(error);
        send({ type: "final", ok: false, error: describeError(error), code });
        log.error(`Streamed paid request failed → ${path}: ${describeError(error)}`);
    } finally {
        res.end();
    }
});