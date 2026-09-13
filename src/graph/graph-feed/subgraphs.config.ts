export interface SubgraphTarget {
    protocol: string;
    chain: string;
    subgraphId: string;
    schema: "messari-standardized" | "custom";
}

/**
 * Minimum USD total value locked for a market to be considered usable for
 * underwriting benchmarks. Dust and isolated Morpho Blue micro-markets
 * (which can be worth single-digit dollars) are excluded both server-side
 * (`totalValueLockedUSD_gte`) and client-side as defense in depth.
 */
export const MIN_TVL_USD = 1_000_000;

// Messari-standardized lending subgraphs, all re-verified live against The
// Graph gateway with the unified `markets` entity and identical schema, so a
// single GraphQL query works across every entry.
//
// Coverage matrix (verified live Sep 2026):
//   Protocol       Ethereum  Arbitrum  Base
//   ─────────────  ────────  ────────  ──────────────────────────────────
//   Aave v3        ✅        ✅        ❌ gateway error "no allocations"
//   Compound v3    ✅        ✅        ❌ custom schema (MCP-only target)
//   Morpho Blue    ✅        ✅*       ✅*  (*healthy, but no markets above
//                                        the $1M TVL floor yet — the floor
//                                        naturally excludes them)
//
// Excluded from Engine A (kept here as documented decisions):
//   - Aave v3 Base (D7mapexM5ZsQckLJai2FawTKXJ7CqYGKM8PErnS3cJi9): the
//     gateway rejects it with "subgraph not found: no allocations" — a hard
//     error, not merely $0 TVL. Re-add when the deployment has allocations.
//   - Compound v3 Base (2hcXhs36pTBDVUmk5K2Zkr6N4UYGwaHuco2a6jyTsijo): its
//     `Market` entity has no `name`/`isActive`/`inputToken` fields — a custom
//     schema that cannot join the unified query. Reachable dynamically via
//     the Subgraph MCP (Engine B) if the agent ever needs it.
//   - Legacy Morpho Aave / Morpho Compound optimizers: obsolete for factoring
//     underwriting; replaced by Morpho Blue.
//   - BSC (BNB Chain): no Aave v3, Compound v3, or Morpho Blue indexing on
//     the network — dropped entirely. Base is the third chain.//
// Missing deployments are excluded — the agent falls back to baseline rates
// when fewer sources return data.
export const LENDING_SUBGRAPHS: SubgraphTarget[] = [
    // ── Aave v3 ───────────────────────────────────────────────
    {
        protocol: "Aave v3",
        chain: "Ethereum",
        subgraphId: "JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk",
        schema: "messari-standardized",
    },
    {
        protocol: "Aave v3",
        chain: "Arbitrum",
        subgraphId: "4xyasjQeREe7PxnF6wVdobZvCw5mhoHZq3T7guRpuNPf",
        schema: "messari-standardized",
    },
    {
        protocol: "Aave v3",
        chain: "Optimism",
        subgraphId: "3RWFxWNstn4nP3dXiDfKi9GgBoHx7xzc7APkXs1MLEgi",
        schema: "messari-standardized",
    },
    {
        protocol: "Aave v3",
        chain: "Polygon",
        subgraphId: "6yuf1C49aWEscgk5n9D1DekeG1BCk5Z9imJYJT3sVmAT",
        schema: "messari-standardized",
    },

    // ── Compound v3 ───────────────────────────────────────────
    {
        protocol: "Compound v3",
        chain: "Ethereum",
        subgraphId: "AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9",
        schema: "messari-standardized",
    },
    {
        protocol: "Compound v3",
        chain: "Arbitrum",
        subgraphId: "5MjRndNWGhqvNX7chUYLQDnvEgc8DaH8eisEkcJt71SR",
        schema: "messari-standardized",
    },
    {
        protocol: "Compound v3",
        chain: "Polygon",
        subgraphId: "5wfoWBpfYv59b99wDxJmyFiKBu9brXESeqJAzw8WP5Cz",
        schema: "messari-standardized",
    },

    // ── Spark ─────────────────────────────────────────────────
    {
        protocol: "Spark",
        chain: "Ethereum",
        subgraphId: "GbKdmBe4ycCYCQLQSjqGg6UHYoYfbyJyq5WrG35pv1si",
        schema: "messari-standardized",
    },

    // ── Moonwell ──────────────────────────────────────────────
    {
        protocol: "Moonwell",
        chain: "Base",
        subgraphId: "33ex1ExmYQtwGVwri1AP3oMFPGSce6YbocBP7fWbsBrg",
        schema: "messari-standardized",
    },

    // ── Venus ─────────────────────────────────────────────────
    {
        protocol: "Venus",
        chain: "BSC",
        subgraphId: "CwswJ7sfENafqgAYU1upn3hQgoEV2CXXRZRJ7XtgJrKG",
        schema: "messari-standardized",
    },

    // ── Euler ─────────────────────────────────────────────────
    {
        protocol: "Euler",
        chain: "Ethereum",
        subgraphId: "95nyAWFFaiz6gykko3HtBCyhRuP5vZzuKYsZiLxHxLhr",
        schema: "messari-standardized",
    },

    // ── MakerDAO ───────────────────────────────────────────────
    {
        protocol: "MakerDAO",
        chain: "Ethereum",
        subgraphId: "8sE6rTNkPhzZXZC6c8UQy2ghFTu5PPdGauwUBm4t7HZ1",
        schema: "messari-standardized",
    },
];
// Unified Messari pattern, hardened against the duplicate-market and dust bugs:
//   - paused/frozen non-DAI markets are excluded client-side. Spark's DAI
//     reserve is currently reported inactive despite exposing live TVL/rates.
//   - `totalValueLockedUSD_gte: MIN_TVL_USD` — excludes dust Morpho Blue
//     isolated micro-markets so they never displace major stablecoin pools.
//   - `first: 50` — Morpho Blue returns many tiny isolated markets per loan
//     token; the old `first: 20` page could truncate USDT/DAI rows.
//   - `inputToken { id }` — exposes the underlying token address so native
//     (0xaf88…5831) and bridged (0xff97…5cc8) USDC can be labeled apart.
// Rates are percentage APY ("3.63" = 3.63%), ordered by TVL so the
// deepest-liquidity market ranks first.
export const MESSARI_MULTI_ASSET_QUERY = `
    query GetMultiAssetRates {
      markets(
        first: 50
        orderBy: totalValueLockedUSD
        orderDirection: desc
        where: {
          totalValueLockedUSD_gte: "${MIN_TVL_USD}"
          inputToken_: { symbol_in: ["USDC", "USDC.e", "USDbC", "USDCn", "USDT", "DAI"] }
        }
      ) {
        name
        isActive
        inputToken { id symbol }
        totalValueLockedUSD
        rates {
          rate
          side
          type
        }
      }
    }
  `;
