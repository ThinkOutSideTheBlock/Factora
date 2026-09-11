/**
 * Payer agent — the UI's wallet proxy.
 *
 * The browser can never hold a private key, so payments are delegated here.
 * The x402 flow is executed explicitly (rather than through the opaque
 * wrapFetchWithPayment helper) so every step can be logged and streamed to
 * the UI: ① invoice → ② sign → ③ settle + resource.
 */
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { getX402Network } from "../x402/x402.middleware.js";
import { createLogger } from "../common/logger.js";

const log = createLogger("agent");

const TINYBARS_PER_HBAR = 100_000_000;

/** Thrown when the UI asks the agent to pay but no agent wallet is configured. */
export class AgentWalletNotConfiguredError extends Error {
    constructor() {
        super(
            "Agent wallet is not configured. Set HEDERA_AGENT_ACCOUNT_ID and " +
                "HEDERA_AGENT_PRIVATE_KEY in .env (create + fund a testnet account at " +
                "https://portal.hedera.com).",
        );
        this.name = "AgentWalletNotConfiguredError";
    }
}

export interface AgentWallet {
    accountId: string;
    privateKey: string;
}

/** Payer wallet for the current network; mainnet credentials are never inherited. */
export function getAgentWallet(): AgentWallet | null {
    const network = getX402Network();
    const accountId =
        network === "hedera:mainnet"
            ? process.env.HEDERA_AGENT_ACCOUNT_ID_MAINNET
            : process.env.HEDERA_AGENT_ACCOUNT_ID;
    const privateKey =
        network === "hedera:mainnet"
            ? process.env.HEDERA_AGENT_PRIVATE_KEY_MAINNET
            : process.env.HEDERA_AGENT_PRIVATE_KEY;

    if (!accountId || !privateKey) return null;
    return { accountId, privateKey };
}

export type AgentStepName = "invoice" | "sign" | "settle";

export interface AgentStepEvent {
    step: AgentStepName;
    status: "running" | "done" | "error";
    detail?: string;
    data?: Record<string, unknown>;
}

export type OnAgentStep = (event: AgentStepEvent) => void;

export interface AgentPaidRequestResult {
    /** HTTP status of the final (post-payment) response. */
    httpStatus: number;
    /** Parsed JSON body of the final response (the paid resource). */
    data: unknown;
    /** Facilitator settlement receipt (Hedera tx id, network, payer), or null. */
    settlement: Record<string, unknown> | null;
    /** Total wall-clock time of the whole flow, in milliseconds. */
    durationMs: number;
}

interface AgentClient {
    client: x402Client;
    httpClient: x402HTTPClient;
}

/** One client per wallet+network; building it is expensive. */
const agentClientCache = new Map<string, AgentClient>();

function getAgentClient(): AgentClient {
    const wallet = getAgentWallet();
    if (!wallet) throw new AgentWalletNotConfiguredError();

    const network = getX402Network();
    const cacheKey = `${network}:${wallet.accountId}`;
    const cached = agentClientCache.get(cacheKey);
    if (cached) return cached;

    const signer = createClientHederaSigner(
        wallet.accountId,
        PrivateKey.fromStringECDSA(wallet.privateKey),
        { network },
    );

    // Native HBAR ('0.0.0') is not in the SDK's default-asset table, so the
    // default spend controls would reject every HBAR invoice — allow it explicitly.
    const client = new x402Client()
        .register("hedera:*", new ExactHederaScheme(signer))
        .setSpendControls({
            allowedAssets: [
                {
                    network,
                    asset: "0.0.0",
                    maxAmountPerPayment:
                        process.env.AGENT_MAX_PAYMENT_TINYBAR ?? "1000000000",
                },
            ],
        });

    const agentClient: AgentClient = { client, httpClient: new x402HTTPClient(client) };
    agentClientCache.set(cacheKey, agentClient);
    return agentClient;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function hbar(tinybars: unknown): string {
    const n = Number(tinybars ?? 0);
    return Number.isFinite(n) ? String(parseFloat((n / TINYBARS_PER_HBAR).toFixed(6))) : String(tinybars);
}

/**
 * Pays for a protected resource on behalf of the UI, reporting each step.
 * ① unpaid request → 402 invoice; ② sign the Hedera payment; ③ paid retry
 * where the facilitator settles on-chain and the route produces the resource.
 */
export async function paidRequest(
    path: string,
    payload: unknown,
    onStep?: OnAgentStep,
): Promise<AgentPaidRequestResult> {
    const { httpClient } = getAgentClient();
    const wallet = getAgentWallet();
    const baseUrl = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
    const url = `${baseUrl}${path}`;
    const body = JSON.stringify(payload ?? {});
    const startedAt = Date.now();
    log.info(`Paid flow started → ${path}`);

    // ① Invoice: the unpaid request must come back as a 402 challenge.
    onStep?.({ step: "invoice", status: "running", detail: `POST ${path}` });
    let invoiceRes: Response;
    try {
        invoiceRes = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
        });
    } catch (error) {
        log.error(`Resource server unreachable at ${url}`, error);
        onStep?.({ step: "invoice", status: "error", detail: describeError(error) });
        throw new Error(`Resource server unreachable at ${path}: ${describeError(error)}`);
    }
    if (invoiceRes.status !== 402) {
        const text = await invoiceRes.text().catch(() => "");
        log.error(`Expected 402 from ${path}, got HTTP ${invoiceRes.status}`, {
            body: text.slice(0, 300),
        });
        onStep?.({ step: "invoice", status: "error", detail: `HTTP ${invoiceRes.status}` });
        throw new Error(
            `Expected a payment challenge from ${path} but got HTTP ${invoiceRes.status}. ${text.slice(0, 200)}`,
        );
    }
    let paymentRequired;
    try {
        paymentRequired = httpClient.getPaymentRequiredResponse((name) =>
            invoiceRes.headers.get(name),
        );
    } catch (error) {
        onStep?.({ step: "invoice", status: "error", detail: "undecodable invoice" });
        throw new Error(`Could not decode the x402 invoice from ${path}: ${describeError(error)}`);
    }
    const accept = paymentRequired.accepts?.[0];
    const amountHbar = accept ? hbar(accept.amount) : "?";
    log.info(
        `402 invoice received for ${path}: ${amountHbar} HBAR → ${accept?.payTo ?? "?"} (${accept?.network ?? "?"})`,
    );
    onStep?.({
        step: "invoice",
        status: "done",
        detail: `${amountHbar} HBAR`,
        data: {
            amountTinybars: accept?.amount,
            payTo: accept?.payTo,
            network: accept?.network,
        },
    });

    // ② Sign: build the partially-signed Hedera TransferTransaction.
    onStep?.({
        step: "sign",
        status: "running",
        detail: wallet ? `wallet ${wallet.accountId}` : undefined,
    });
    let paymentPayload;
    try {
        paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
    } catch (error) {
        let message = describeError(error);
        if (message.includes("maxAmountPerPayment")) {
            message += " — raise AGENT_MAX_PAYMENT_TINYBAR in .env";
        }
        log.error(`Payment signing failed for ${path}: ${message}`);
        onStep?.({ step: "sign", status: "error", detail: message });
        throw new Error(`Signing the payment failed: ${message}`);
    }
    log.info(`Payment payload signed by ${wallet?.accountId ?? "agent wallet"}`);
    onStep?.({ step: "sign", status: "done", detail: wallet?.accountId ?? "signed" });

    // ③ Settle: paid retry — the facilitator verifies, co-signs as fee payer and
    // settles on-chain, then our route handler produces the actual resource.
    onStep?.({ step: "settle", status: "running", detail: "settling via Blocky402…" });
    const signatureHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);
    let res: Response;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...signatureHeaders },
            body,
        });
    } catch (error) {
        log.error(`Paid retry failed for ${path}`, error);
        onStep?.({ step: "settle", status: "error", detail: describeError(error) });
        throw new Error(`Paid request to ${path} failed: ${describeError(error)}`);
    }

    let data: unknown = null;
    try {
        data = await res.json();
    } catch {
        // Non-JSON body — keep null; httpStatus still tells the story.
    }

    if (!res.ok) {
        let reason = (data as { error?: string } | null)?.error ?? "";
        if (res.status === 402) {
            try {
                const declined = httpClient.getPaymentRequiredResponse((n) => res.headers.get(n));
                reason = reason || declined.error || "";
            } catch {
                // header missing — keep body error
            }
        }
        log.error(`Paid request failed (HTTP ${res.status}) for ${path}: ${reason || "no detail"}`);
        onStep?.({
            step: "settle",
            status: "error",
            detail: `HTTP ${res.status}: ${reason || "failed"}`.slice(0, 160),
        });
        throw new Error(
            `Payment did not produce the resource (HTTP ${res.status}): ${reason || "unknown error"}`,
        );
    }

    let settlement: Record<string, unknown> | null = null;
    if (res.headers.get("payment-response")) {
        try {
            settlement = JSON.parse(
                JSON.stringify(httpClient.getPaymentSettleResponse((n) => res.headers.get(n))),
            ) as Record<string, unknown>;
        } catch (error) {
            log.warn(`Could not parse settlement receipt for ${path}`, error);
        }
    }
    const tx = settlement?.transaction ?? "";
    log.info(
        `Paid flow finished ${path} → HTTP ${res.status} in ${Date.now() - startedAt}ms (tx ${tx || "n/a"})`,
    );
    onStep?.({
        step: "settle",
        status: "done",
        detail: tx ? `tx ${String(tx).split("@")[0]}@…` : "settled",
    });

    return { httpStatus: res.status, data, settlement, durationMs: Date.now() - startedAt };
}