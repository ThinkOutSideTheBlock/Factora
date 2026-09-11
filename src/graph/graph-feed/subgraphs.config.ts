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
//   ─────────────  ────────  ────────  ────
//   Aave v3        ✅        ✅        ❌ (no allocations on network)
//   Compound v3    ✅        ✅        ❌ (no Messari deployment)
//   Morpho Aave    ✅        ❌        ❌
//   Morpho Compound❌ (bad indexers)
//
// Missing deployments are excluded — the agent falls back to baseline rates
// when fewer sources return data.
export const LENDING_SUBGRAPHS: SubgraphTarget[] = [
  // ── Aave v3 ──────────────────────────────────────────────────────────
  { protocol: 'Aave v3', chain: 'Ethereum', subgraphId: 'JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk', schema: 'messari-standardized' },
  { protocol: 'Aave v3', chain: 'Arbitrum', subgraphId: '4xyasjQeREe7PxnF6wVdobZvCw5mhoHZq3T7guRpuNPf', schema: 'messari-standardized' },
  // { protocol: 'Aave v3', chain: 'Base',     subgraphId: 'D7mapexM5ZsQckLJai2FawTKXJ7CqYGKM8PErnS3cJi9', schema: 'messari-standardized' }, // stale — no allocations

  // ── Compound v3 ──────────────────────────────────────────────────────
  { protocol: 'Compound v3', chain: 'Ethereum', subgraphId: 'AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9', schema: 'messari-standardized' },
  { protocol: 'Compound v3', chain: 'Arbitrum', subgraphId: '5MjRndNWGhqvNX7chUYLQDnvEgc8DaH8eisEkcJt71SR', schema: 'messari-standardized' },
  // NOTE: Compound v3 Base subgraph (2hcXhs…yTsijo) uses a custom
  // schema — excluded to keep all queries unified.

  // ── Morpho (Aave V3 market) ──────────────────────────────────────────
  { protocol: 'Morpho Aave', chain: 'Ethereum', subgraphId: 'FKe6ANnWmGPE6hajGLoTgPrVF2jYPHiRu2Jwcg9ZmG9A', schema: 'messari-standardized' },
];

// Unified Messari pattern, hardened against the duplicate-market and dust bugs:
//   - `isActive: true` — excludes paused/frozen markets (e.g. Aave Arbitrum
//     bridged USDC.e, which is active=false and previously leaked into
//     benchmarks as a duplicate "Aave v3 Arbitrum USDC" row).
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
        isActive: true
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
