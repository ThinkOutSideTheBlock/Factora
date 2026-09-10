export interface SubgraphTarget {
    protocol: string;
    chain: string;
    subgraphId: string;
    schema: "messari-standardized" | "custom";
}

// Messari standardized lending subgraphs verified live against The Graph
// Explorer. All use the unified `markets` entity with identical schema so
// a single GraphQL query works across every entry.
//
// Coverage matrix (Sep 2025):
//   Protocol       Ethereum  Arbitrum  Base
//   ─────────────  ────────  ────────  ────
//   Aave v3        ✅        ✅        ❌ (no allocations on network)
//   Compound v3    ✅        ✅        ❌ (no Messari deployment)
//   Morpho blue    ?           ?         ?
//
// Missing Messari deployments are excluded — the agent falls back to
// baseline rates when fewer sources return data.
export const LENDING_SUBGRAPHS: SubgraphTarget[] = [
    // ── Aave v3 ──────────────────────────────────────────────────────────
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
    // { protocol: 'Aave v3', chain: 'Base',     subgraphId: 'D7mapexM5ZsQckLJai2FawTKXJ7CqYGKM8PErnS3cJi9', schema: 'messari-standardized' }, // stale — no allocations

    // ── Compound v3 ──────────────────────────────────────────────────────
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
    // NOTE: Compound v3 Base subgraph (2hcXhs…yTsijo) uses a custom
    // schema — excluded to keep all queries unified.

    // ── Morpho (Aave V3 market) ──────────────────────────────────────────
    {
        protocol: "Morpho Aave",
        chain: "Ethereum",
        subgraphId: "FKe6ANnWmGPE6hajGLoTgPrVF2jYPHiRu2Jwcg9ZmG9A",
        schema: "messari-standardized",
    },
];

// Unified Messari pattern: rates are percentage APY ("3.63" = 3.63%); ordered
// by TVL so the deepest-liquidity market ranks first. Bridged variants
// (USDC.e, USDbC, USDCn) resolve for protocols that list them.
export const MESSARI_MULTI_ASSET_QUERY = `
  query GetMultiAssetRates {
    markets(
      where: { inputToken_: { symbol_in: ["USDC", "USDC.e", "USDbC", "USDCn", "USDT", "DAI"] } }
      first: 20
      orderBy: totalValueLockedUSD
      orderDirection: desc
    ) {
      name
      inputToken { symbol }
      totalValueLockedUSD
      rates {
        rate
        side
        type
      }
    }
  }
`;

// Uniswap v3 Ethereum (substreams deployment, Messari DEX AMM schema 4.x):
// stable pools for comparative LP yield, with hourly supply-side fee revenue
// snapshots used to annualize an estimated APY.
export const UNISWAP_V3_ETHEREUM_SUBGRAPH_ID =
    "4cKy6QQMc5tpfdx8yxfYeb9TLZmgLQe44ddW1G7NwkA6";

export const UNISWAP_TOP_STABLE_POOLS_QUERY = `
  query TopStablePools {
    liquidityPools(
      first: 6
      orderBy: totalValueLockedUSD
      orderDirection: desc
      where: { inputTokens_: { symbol_in: ["USDC", "USDT", "DAI"] } }
    ) {
      name
      inputTokens { symbol }
      fees { feeType feePercentage }
      totalValueLockedUSD
      hourlySnapshots(first: 24, orderBy: hour, orderDirection: desc) {
        hourlySupplySideRevenueUSD
        totalValueLockedUSD
      }
    }
  }
`;
