import {
    AssetBenchmark,
    GraphFeedError,
    MultiAssetBenchmarkReport,
    ProtocolMarketRate,
} from "./graph-feed.types.js";
import {
    LENDING_SUBGRAPHS,
    MESSARI_MULTI_ASSET_QUERY,
    MIN_TVL_USD,
} from "./subgraphs.config.js";

interface MessariRate {
    rate: string;
    side: string;
    type: string;
}

interface MessariMarket {
    name: string | null;
    isActive?: boolean;
    inputToken?: { id?: string; symbol: string };
    totalValueLockedUSD: string;
    rates: MessariRate[];
}

type LendingTarget = (typeof LENDING_SUBGRAPHS)[number];

const ASSET_SYMBOLS = ["USDC", "USDT", "DAI"] as const;
const ASSET_ALIASES: Record<string, (typeof ASSET_SYMBOLS)[number]> = {
    USDC: "USDC",
    "USDC.E": "USDC",
    USDBC: "USDC",
    USDCN: "USDC",
    USDT: "USDT",
    DAI: "DAI",
};
const TARGET_TIMEOUT_MS = 30_000;
const TARGET_RETRY_BACKOFF_MS = 250;

export async function getStandardizedLendingBenchmarks(
    apiKey = process.env.GRAPH_API_KEY ?? "",
): Promise<MultiAssetBenchmarkReport> {
    const candidateErrors: { target: string; error: string }[] = [];
    const rawRates: ProtocolMarketRate[] = [];
    const fetches = LENDING_SUBGRAPHS.map(async (target) => {
        const markets = await fetchMarketsWithRetry(target, apiKey);
        rawRates.push(
            ...markets.flatMap((market) => collectMarketRate(target, market)),
        );
    });

    const settled = await Promise.allSettled(fetches);
    settled.forEach((outcome, index) => {
        if (outcome.status === "rejected") {
            const target = LENDING_SUBGRAPHS[index];
            candidateErrors.push({
                target: `${target.protocol} on ${target.chain}`,
                error:
                    outcome.reason instanceof Error
                        ? outcome.reason.message
                        : String(outcome.reason),
            });
        }
    });

    if (rawRates.length === 0) {
        throw new GraphFeedError(
            "ALL_TARGETS_FAILED",
            "no Messari lending subgraph returned usable markets above the quality gates — refusing to fabricate benchmarks",
            { candidateErrors },
        );
    }

    const detailedRates = deduplicateByDeepestTvl(rawRates);
    const benchmarks = aggregateBenchmarks(detailedRates);
    const missingAssets = ASSET_SYMBOLS.filter((symbol) => !benchmarks[symbol]);

    if (missingAssets.length > 0) {
        throw new GraphFeedError(
            "NO_LIVE_DATA",
            `live markets returned but canonical assets are missing: ${missingAssets.join(", ")} — refusing to fabricate benchmarks`,
            { missingAssets: [...missingAssets], candidateErrors },
        );
    }

    return {
        timestamp: Date.now(),
        benchmarks,
        detailedRates,
        source: "The Graph Decentralized Network (Messari Standardized)",
    };
}

async function fetchMarketsWithRetry(
    target: LendingTarget,
    apiKey: string,
): Promise<MessariMarket[]> {
    try {
        return await fetchMarkets(target, apiKey);
    } catch (error) {
        console.warn(
            `[GraphFeed] Failed querying ${target.protocol} on ${target.chain} (${formatError(error)}); retrying once`,
        );
    }

    await new Promise((resolve) =>
        setTimeout(resolve, TARGET_RETRY_BACKOFF_MS),
    );
    try {
        return await fetchMarkets(target, apiKey);
    } catch (error) {
        console.warn(
            `[GraphFeed] Retry failed for ${target.protocol} on ${target.chain}:`,
            formatError(error),
        );
        return [];
    }
}

async function fetchMarkets(
    target: LendingTarget,
    apiKey: string,
): Promise<MessariMarket[]> {
    const endpoint = `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${target.subgraphId}`;
    const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: MESSARI_MULTI_ASSET_QUERY }),
        signal: AbortSignal.timeout(TARGET_TIMEOUT_MS),
    });

    if (!response.ok) {
        console.warn(
            `[GraphFeed] HTTP ${response.status} querying ${target.protocol} on ${target.chain}`,
        );
        return [];
    }

    const body = (await response.json()) as {
        data?: { markets?: MessariMarket[] | null };
        errors?: Array<{ message: string }>;
    };
    if (body.errors?.length) {
        console.warn(
            `[GraphFeed] GraphQL error from ${target.protocol} on ${target.chain}: ${body.errors[0].message}`,
        );
        return [];
    }
    return body.data?.markets ?? [];
}

function collectMarketRate(
    target: LendingTarget,
    market: MessariMarket,
): ProtocolMarketRate[] {
    const rawSymbol = market.inputToken?.symbol?.toUpperCase();
    const symbol = rawSymbol ? ASSET_ALIASES[rawSymbol] : undefined;
    if (!symbol) return [];
    if (market.isActive === false && symbol !== "DAI") return [];
    if (!market.rates?.length) return [];

    const totalValueLockedUSD = toFiniteNonNegativeNumber(
        market.totalValueLockedUSD,
    );
    if (totalValueLockedUSD < MIN_TVL_USD) return [];

    const rates = market.rates.reduce(
        (result, rate) => {
            if (rate.type !== "VARIABLE") return result;
            const parsed = Number(rate.rate);
            if (!Number.isFinite(parsed)) return result;
            const normalized = normalizeRate(parsed);
            if (rate.side === "LENDER") result.supplyApy = normalized;
            if (rate.side === "BORROWER") result.borrowApy = normalized;
            return result;
        },
        { supplyApy: 0, borrowApy: 0 },
    );

    return [
        {
            protocol: target.protocol,
            chain: target.chain,
            symbol,
            supplyApy: Number(rates.supplyApy.toFixed(4)),
            borrowApy: Number(rates.borrowApy.toFixed(4)),
            totalValueLockedUSD,
            marketName: market.name ?? undefined,
            ...(market.inputToken?.id
                ? { inputTokenId: market.inputToken.id }
                : {}),
            ...(typeof market.isActive === "boolean"
                ? { isActive: market.isActive }
                : {}),
        },
    ];
}

function normalizeRate(value: number): number {
    if (value > 1e18) return value / 1e27;
    if (value > 0.0001 && value <= 100) return value / 100;
    return value;
}

function deduplicateByDeepestTvl(
    rates: ProtocolMarketRate[],
): ProtocolMarketRate[] {
    const deepest = new Map<string, ProtocolMarketRate>();
    for (const rate of rates) {
        const key = `${rate.protocol}|${rate.chain}|${rate.symbol}`;
        const current = deepest.get(key);
        if (
            !current ||
            rate.totalValueLockedUSD > current.totalValueLockedUSD
        ) {
            deepest.set(key, rate);
        }
    }
    return [...deepest.values()].sort(
        (left, right) => right.totalValueLockedUSD - left.totalValueLockedUSD,
    );
}

function aggregateBenchmarks(
    rates: ProtocolMarketRate[],
): Record<string, AssetBenchmark> {
    return Object.fromEntries(
        ASSET_SYMBOLS.flatMap((symbol) => {
            const markets = rates.filter(
                (rate) => rate.symbol === symbol && rate.supplyApy > 0,
            );
            if (!markets.length) return [];

            const averageSupplyApy =
                markets.reduce((sum, market) => sum + market.supplyApy, 0) /
                markets.length;
            const top = markets.reduce((best, market) =>
                market.supplyApy > best.supplyApy ? market : best,
            );
            return [
                [
                    symbol,
                    {
                        symbol,
                        averageSupplyApy: Number(averageSupplyApy.toFixed(4)),
                        maxSupplyApy: Number(
                            Math.max(
                                ...markets.map((market) => market.supplyApy),
                            ).toFixed(4),
                        ),
                        minSupplyApy: Number(
                            Math.min(
                                ...markets.map((market) => market.supplyApy),
                            ).toFixed(4),
                        ),
                        topMarket: `${top.protocol} (${top.chain})`,
                        marketsCount: markets.length,
                    } satisfies AssetBenchmark,
                ],
            ];
        }),
    ) as Record<string, AssetBenchmark>;
}

function toFiniteNonNegativeNumber(value: string): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
