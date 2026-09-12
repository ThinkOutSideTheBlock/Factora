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
    // ── Aave v3 ──────────────────────────────────────────────────────────
    { protocol: 'Aave v3', chain: 'Ethereum', subgraphId: 'JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk', schema: 'messari-standardized' },
    { protocol: 'Aave v3', chain: 'Arbitrum', subgraphId: '4xyasjQeREe7PxnF6wVdobZvCw5mhoHZq3T7guRpuNPf', schema: 'messari-standardized' },

    // ── Compound v3 ──────────────────────────────────────────────────────
    { protocol: 'Compound v3', chain: 'Ethereum', subgraphId: 'AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9', schema: 'messari-standardized' },
    { protocol: 'Compound v3', chain: 'Arbitrum', subgraphId: '5MjRndNWGhqvNX7chUYLQDnvEgc8DaH8eisEkcJt71SR', schema: 'messari-standardized' },

    // ── Morpho Blue (official deployments, discovered via Subgraph MCP) ──
    // Ethereum: top market USDT/USDT ~$17M TVL; long dust tail filtered by MIN_TVL_USD.
    { protocol: 'Morpho Blue', chain: 'Ethereum', subgraphId: '8Lz789DP5VKLXumTMTgygjU2xtuzx8AhbaacgN5PYCAs', schema: 'messari-standardized' },
    // Arbitrum: healthy deployment; no markets above the TVL floor yet.
    { protocol: 'Morpho Blue', chain: 'Arbitrum', subgraphId: 'XsJn88DNCHJ1kgTqYeTgHMQSK4LuG1LR75339QVeQ26', schema: 'messari-standardized' },
    // Base: query-compatible, but currently returns $0 TVL on all rows — the
    // $1M floor naturally excludes it without breaking execution. Also note:
    // the MCP keyword "morpho blue" returns 0 results (hyphenated names); use
    // the GraphMcpClient multi-keyword retry ("morpho", "morpho-blue").
    { protocol: 'Morpho Blue', chain: 'Base', subgraphId: '71ZTy1veF9twER9CLMnPWeLQ7GZcwKsjmygejrgKirqs', schema: 'messari-standardized' },
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
