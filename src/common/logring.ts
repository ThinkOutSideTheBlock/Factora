/**
 * In-memory ring buffer of recent log lines.
 *
 * Lets the Developer console in the UI (and anything else) tail the server's
 * live activity — LLM calls, x402 settlements, ATS lifecycle steps — without
 * needing shell access to the process. Capped and bounded; never blocks the
 * logger.
 */

export interface LogEntry {
    id: number;
    ts: string;
    level: string;
    scope: string;
    message: string;
}

const CAPACITY = 400;
const ring: LogEntry[] = [];
let nextId = 1;

export function pushLogEntry(level: string, scope: string, message: string): void {
    ring.push({ id: nextId++, ts: new Date().toISOString(), level, scope, message });
    if (ring.length > CAPACITY) ring.splice(0, ring.length - CAPACITY);
}

/** Entries with `id` strictly greater than `sinceId` (pass 0 for all). */
export function getRecentLogs(sinceId = 0): LogEntry[] {
    return sinceId > 0 ? ring.filter((e) => e.id > sinceId) : [...ring];
}
