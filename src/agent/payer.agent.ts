/**
 * Payer agent — the UI's wallet proxy.
 *
 * Browsers can never pay for x402 resources directly (that requires a private
 * key). The UI delegates to this module, which performs the full flow against
 * our own protected endpoints: unpaid request → 402 invoice → sign Hedera
 * TransferTransaction → paid retry → settlement receipt.
 */
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { getX402Network } from "../x402/x402.middleware.js";

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

export interface AgentPaidRequestResult {
    /** HTTP status of the final (post-payment) response. */
    httpStatus: number;
    /** Parsed JSON body of the final response (the paid resource). */
    data: unknown;
    /** Facilitator settlement receipt (Hedera tx id, network, payer), or null. */
    settlement: Record<string, unknown> | null;
}

interface AgentClient {
    fetchWithPayment: (
        input: RequestInfo | URL,
        init?: RequestInit,
    ) => Promise<Response>;
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

    const agentClient: AgentClient = {
        fetchWithPayment: wrapFetchWithPayment(fetch, client),
        httpClient: new x402HTTPClient(client),
    };
    agentClientCache.set(cacheKey, agentClient);
    return agentClient;
}

export async function paidRequest(
    path: string,
    payload: unknown,
): Promise<AgentPaidRequestResult> {
    const { fetchWithPayment, httpClient } = getAgentClient();
    const baseUrl = `http://127.0.0.1:${process.env.PORT ?? 3000}`;

    const response = await fetchWithPayment(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? {}),
    });

    let data: unknown = null;
    try {
        data = await response.json();
    } catch {
        // Non-JSON body — keep null; httpStatus still tells the story.
    }

    // The settlement header only exists on successful responses.
    const settlementHeader = response.headers.get("payment-response");
    const settlement = settlementHeader
        ? (JSON.parse(
              JSON.stringify(
                  httpClient.getPaymentSettleResponse((name) =>
                      response.headers.get(name),
                  ),
              ),
          ) as Record<string, unknown>)
        : null;

    return {
        httpStatus: response.status,
        data,
        settlement,
    };
}
