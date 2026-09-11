import OpenAI from "openai";
import { createLogger } from "../common/logger.js";

const log = createLogger("llm");

export interface LlmJsonRequest {
    systemPrompt: string;
    userPrompt: string;
}

/** Token accounting reported by the OpenAI-compatible provider. */
export interface LlmUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

export interface LlmJsonResult {
    data: unknown;
    usage: LlmUsage | null;
}

const TIMEOUT_MS = 90_000;

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

/** Walks the nested `cause` chain (SDK → undici → OS error) for an errno code. */
function findCauseCode(error: unknown, depth = 0): string | undefined {
    if (depth > 5 || !error || typeof error !== "object") return undefined;
    const code = (error as { code?: string }).code;
    if (typeof code === "string") return code;
    return findCauseCode((error as { cause?: unknown }).cause, depth + 1);
}

/**
 * Turns SDK/network failures into actionable messages instead of raw stack
 * noise — the operator should know *which* knob to turn.
 */
function classifyLlmError(error: unknown, baseURL: string, model: string): Error {
    const err = error as {
        status?: number;
        message?: string;
        code?: string;
        cause?: { code?: string };
    };
    const host = hostOf(baseURL);
    const detail = err.message ? ` — ${err.message}` : "";

    if (typeof err.status === "number") {
        switch (err.status) {
            case 401:
                return new Error(
                    `LLM authentication failed (HTTP 401 from ${host}) — check LLM_API_KEY.${detail}`,
                );
            case 403:
                return new Error(
                    `LLM access denied (HTTP 403 from ${host}) — the API key lacks access to "${model}".${detail}`,
                );
            case 404:
                return new Error(
                    `LLM model "${model}" is not available at ${host} (HTTP 404) — set LLM_MODEL to a supported model.${detail}`,
                );
            case 429:
                return new Error(
                    `LLM rate limited (HTTP 429 from ${host}) — slow down or switch provider/model.${detail}`,
                );
            default:
                if (err.status >= 500) {
                    return new Error(
                        `LLM provider error (HTTP ${err.status} from ${host}) — provider outage? Retry or switch LLM_BASE_URL.${detail}`,
                    );
                }
                return new Error(`LLM request rejected (HTTP ${err.status} from ${host}).${detail}`);
        }
    }

    const causeCode = findCauseCode(error);
    const code = causeCode ?? err.code;
    if (code === "ECONNREFUSED") {
        return new Error(`LLM unreachable at ${baseURL} (ECONNREFUSED) — is the service running?`);
    }
    if (code === "ENOTFOUND") {
        return new Error(`LLM host not found (DNS) — check LLM_BASE_URL "${baseURL}"`);
    }
    if (code === "ECONNRESET") {
        return new Error(`LLM connection reset by ${host} — provider dropped the connection; retry.`);
    }
    if (err.message?.toLowerCase().includes("timeout")) {
        return new Error(
            `LLM request timed out after ${TIMEOUT_MS}ms — model too slow or provider overloaded.`,
        );
    }
    return new Error(`LLM request failed: ${err.message ?? String(error)}`);
}

/**
 * Sends a prompt to the configured OpenAI-compatible model and returns its
 * JSON response plus the provider-reported token usage. Deliberately free of
 * any domain logic so it can be reused by other agents.
 */
export async function callLlmJsonWithUsage({
    systemPrompt,
    userPrompt,
}: LlmJsonRequest): Promise<LlmJsonResult> {
    const baseURL = process.env.LLM_BASE_URL;
    const apiKey = process.env.LLM_API_KEY;
    const model = process.env.LLM_MODEL;

    if (!baseURL || !apiKey || !model) {
        throw new Error("LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL must be configured");
    }

    const client = new OpenAI({ baseURL, apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
    log.info(`LLM request → ${hostOf(baseURL)} · model=${model} · ${userPrompt.length} chars prompt`);
    const startedAt = Date.now();

    let completion;
    try {
        completion = await client.chat.completions.create({
            model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
            ],
            response_format: { type: "json_object" },
            temperature: 0.2,
        });
    } catch (error) {
        const classified = classifyLlmError(error, baseURL, model);
        log.error(classified.message);
        throw classified;
    }

    const ms = Date.now() - startedAt;
    const usage = completion.usage
        ? {
              promptTokens: completion.usage.prompt_tokens ?? 0,
              completionTokens: completion.usage.completion_tokens ?? 0,
              totalTokens: completion.usage.total_tokens ?? 0,
          }
        : null;
    log.info(
        `LLM response OK in ${ms}ms · tokens ${usage ? `${usage.promptTokens} prompt + ${usage.completionTokens} completion` : "not reported"}`,
    );

    const content = completion.choices[0]?.message?.content;
    if (!content) {
        log.error("LLM returned an empty response");
        throw new Error("LLM returned an empty response");
    }

    try {
        return { data: JSON.parse(content), usage };
    } catch {
        log.error(`LLM returned invalid JSON (${content.length} chars)`);
        throw new Error("LLM returned invalid JSON");
    }
}

/**
 * Convenience wrapper for callers that do not care about token metering.
 */
export async function callLlmJson(request: LlmJsonRequest): Promise<unknown> {
    return (await callLlmJsonWithUsage(request)).data;
}
