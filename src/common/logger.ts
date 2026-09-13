/**
 * Minimal structured logger — zero dependencies.
 *
 * Output format (single line, greppable):
 *   2026-09-11T17:45:01.123Z INFO  [llm] LLM response OK in 812ms {promptTokens:1415,...}
 *
 * Scope comes from createLogger('llm'). Level from LOG_LEVEL env
 * (debug | info | warn | error; default info). Colors on TTY only.
 */
import { pushLogEntry } from "./logring.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): number {
    const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
    return LEVELS[raw] ?? LEVELS.info;
}

const COLORS: Record<LogLevel, string> = {
    debug: "\x1b[90m", // gray
    info: "\x1b[36m",  // cyan
    warn: "\x1b[33m",  // yellow
    error: "\x1b[31m", // red
};
const RESET = "\x1b[0m";

function emit(level: LogLevel, scope: string, message: string, meta?: unknown): void {
    if (LEVELS[level] < currentLevel()) return;
    const ts = new Date().toISOString();
    const color = process.stdout.isTTY ? COLORS[level] : "";
    const reset = process.stdout.isTTY ? RESET : "";
    let line = `${ts} ${color}${level.toUpperCase().padEnd(5)}${reset} [${scope}] ${message}`;
    if (meta !== undefined) {
        if (meta instanceof Error) {
            line += ` — ${meta.name}: ${meta.message}`;
            if (currentLevel() <= LEVELS.debug && meta.stack) line += `\n${meta.stack}`;
        } else if (typeof meta === "object") {
            try {
                line += ` ${JSON.stringify(meta)}`;
            } catch {
                line += " [unserializable meta]";
            }
        } else {
            line += ` ${String(meta)}`;
        }
    }
    const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    out(line);
    // Mirror the FULL line (message + meta, ANSI-stripped) into the ring buffer
    // so the Developer console's Server-log pane shows exactly what the
    // terminal prints — error details included.
    let ringMessage = message.replace(/\x1b\[[0-9;]*m/g, "");
    if (meta !== undefined) {
        if (meta instanceof Error) {
            ringMessage += ` — ${meta.name}: ${meta.message}`;
            const stack = meta.stack;
            if (stack) ringMessage += ` ${stack.split("\n").slice(1, 4).join(" | ").trim()}`;
        } else if (typeof meta === "object") {
            try {
                ringMessage += ` ${JSON.stringify(meta)}`;
            } catch {
                ringMessage += " [unserializable meta]";
            }
        } else {
            ringMessage += ` ${String(meta)}`;
        }
    }
    pushLogEntry(level, scope, ringMessage.replace(/\x1b\[[0-9;]*m/g, ""));
}

export interface Logger {
    debug(message: string, meta?: unknown): void;
    info(message: string, meta?: unknown): void;
    warn(message: string, meta?: unknown): void;
    error(message: string, meta?: unknown): void;
    /** Returns a done-callback that logs `label completed in Xms` at info level. */
    timer(label: string): (meta?: unknown) => number;
    child(subScope: string): Logger;
}

export function createLogger(scope: string): Logger {
    return {
        debug: (m, meta) => emit("debug", scope, m, meta),
        info: (m, meta) => emit("info", scope, m, meta),
        warn: (m, meta) => emit("warn", scope, m, meta),
        error: (m, meta) => emit("error", scope, m, meta),
        timer: (label) => {
            const start = Date.now();
            return (meta) => {
                const ms = Date.now() - start;
                emit("info", scope, `${label} completed in ${ms}ms`, meta);
                return ms;
            };
        },
        child: (sub) => createLogger(`${scope}:${sub}`),
    };
}