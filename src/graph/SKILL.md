# SKILL.md — `factora-defi-yield-intelligence`

> **Skill for autonomous AI underwriting agents.** Provides live, multi-chain
> DeFi lending hurdle rates and DEX liquidity opportunity-cost benchmarks,
> powered by The Graph Network. All data is fetched live from Graph providers
> (Messari-standardized subgraphs via the Gateway + the Subgraph MCP server)
> — no mocked or static values.
>
> **Tooling track:** this skill composes **two Graph products** —
> (1) Gateway HTTP over the Messari standardized lending schema and
> (2) the Subgraph MCP server for dynamic discovery and ad-hoc GraphQL.

---

## Skill Overview

`factora-defi-yield-intelligence` gives an autonomous underwriting agent:

1. **Lending hurdle rates** — live supply APY benchmarks for `USDC`, `USDT`,
   and `DAI` across **Aave v3, Compound v3, and Morpho Blue** on **Ethereum,
   Arbitrum, and Base** (7 pinned Messari-standardized deployments).
2. **DEX opportunity cost** — what idle stablecoin capital could alternatively
   earn in Uniswap v3 stablecoin pools (annualized supply-side fee revenue).
3. **Dynamic discovery** — keyword search across ~15,000 subgraphs and ad-hoc
   GraphQL execution against *any* deployment, for anything outside the
   pinned matrix.

---

## Architectural Dual Engine

```
Agent (LLM)
├── Engine A: Standardized Messari Lending Gateway (deterministic)
│     getStandardizedLendingBenchmarks()
│     └── ONE GraphQL query → 7 deployments → normalized decimal APYs
│
└── Engine B: Dynamic Subgraph MCP (exploratory)
      getDEXLiquidityYield()          → Uniswap v3 pool depth + fee APY
      search_subgraphs(keyword)       → discover any deployment
      query_subgraph(id, graphql)     → ad-hoc data beyond the matrix
```

**Standards leverage:** Engine A runs `MESSARI_MULTI_ASSET_QUERY` — a single
query pattern spanning 3 protocols × 3 chains — because every pinned
deployment implements the Messari standardized lending schema (`markets`
entity with `inputToken`, `rates`, `totalValueLockedUSD`, `isActive`).
Adding a protocol that speaks Messari requires **one config line and zero
query changes** (Morpho Blue was integrated exactly this way).

**Resilience:** every Engine A target has a 30s timeout + one retry; failed
targets are skipped with warnings; per-asset fallbacks keep partial reports
live; total failure returns a tagged deterministic baseline. Engine B tools
**never throw** — they return `{ isError: true, error }`.

---

## Tool Catalog (OpenAI / MCP function-calling schemas)

All tools are exported from `src/graph/index.ts` as TypeScript functions and
as a JSON-Schema catalog (`AGENT_TOOL_DEFINITIONS`) for out-of-the-box
registration by any LLM host.

### 1. `get_lending_hurdle_rate`

Live multi-protocol lending supply-APY benchmark for a stablecoin asset.
Backed by `graphFeedService.getStandardizedLendingBenchmarks()` (Engine A).

```json
{
  "name": "get_lending_hurdle_rate",
  "description": "Fetch live stablecoin lending supply APY benchmarks (Aave v3, Compound v3, Morpho Blue on Ethereum/Arbitrum/Base) via the Messari standardized subgraphs. Returns the average/max/min decimal APY plus the deepest live market. All APYs are DECIMAL FRACTIONS: 0.0335 = 3.35%.",
  "parameters": {
    "type": "object",
    "properties": {
      "asset": {
        "type": "string",
        "enum": ["USDC", "USDT", "DAI"],
        "description": "Canonical stablecoin symbol to benchmark. Defaults to USDC (the primary underwriting asset)."
      }
    },
    "required": []
  }
}
```

Returns:

```json
{
  "asset": "USDC",
  "averageSupplyApy": 0.0335,
  "maxSupplyApy": 0.0423,
  "minSupplyApy": 0.0277,
  "topMarket": "Compound v3 (Ethereum)",
  "marketsCount": 4,
  "source": "The Graph Decentralized Network (Messari Standardized)",
  "isFallback": false,
  "timestamp": 1765432109876,
  "detailedRates": [
    {
      "protocol": "Aave v3", "chain": "Arbitrum", "symbol": "USDC",
      "supplyApy": 0.0277, "borrowApy": 0.0512, "totalValueLockedUSD": 172086573,
      "marketName": "Aave Arbitrum USDCn",
      "inputTokenId": "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      "isActive": true
    }
  ]
}
```

<!-- SKILL-CATALOG-MARKER -->
