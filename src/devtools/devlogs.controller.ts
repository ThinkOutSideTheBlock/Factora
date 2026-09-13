import { Router, Request, Response } from "express";
import { getRecentLogs } from "../common/logring.js";
import { createLogger } from "../common/logger.js";

const log = createLogger("devtools");

/**
 * GET /api/dev/logs?since=<id>
 * Tails the server's in-memory log ring — the same lines the terminal prints
 * (LLM calls, x402 settlements, ATS lifecycle, HTTP errors). Used by the
 * Developer console's live "Server log" pane.
 */
export const devLogsRouter = Router();

devLogsRouter.get("/logs", (req: Request, res: Response) => {
    const since = Number(req.query.since ?? 0);
    const entries = getRecentLogs(Number.isFinite(since) ? since : 0);
    res.status(200).json({
        count: entries.length,
        lastId: entries.length ? entries[entries.length - 1].id : since,
        entries,
    });
    if (!req.query.since) log.debug("dev log tail opened");
});
