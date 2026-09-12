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

### 2. `get_dex_liquidity_yield`

DEX LP opportunity cost: annualized supply-side fee APY for top Uniswap v3
stablecoin pools. Backed by `graphFeedService.getDEXLiquidityYield()`
(Engine B, Subgraph MCP). If the Uniswap deployment's indexers are degraded,
this returns clearly-tagged reference pools (`protocol: 'Uniswap v3 (Fallback)'`)
— treat those as reference data, never as a live executable opportunity.

```json
{
  "name": "get_dex_liquidity_yield",
  "description": "Fetch DEX liquidity opportunity cost: the top Uniswap v3 stablecoin pools (USDC/USDT/DAI) with pool depth (TVL) and an annualized supply-side fee APY estimate. Returns DECIMAL APY fractions (0.0750 = 7.50%). Fallback pools are tagged protocol='Uniswap v3 (Fallback)' when the network is degraded.",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

Returns:

```json
[
  {
    "protocol": "Uniswap v3",
    "pair": "USDC/USDT (0.01%)",
    "estimatedApy": 0.075,
    "tvlUSD": 50000000
  }
]
```

Annualization: `(24h supply-side fee revenue / 24) * 24 * 365 / avg TVL` over
hourly snapshots. This estimate excludes impermanent loss, volatility, and
withdrawal risk — use it as opportunity-cost context with its **own risk
spread**, never summed into lending APY.

### 3. `search_subgraphs`

Dynamic keyword discovery across ~15,000 subgraphs on The Graph's
decentralized network. Backed by `agentTools.searchSubgraphs(keyword)` (Subgraph
MCP, with automatic keyword-variant retry — `"morpho blue"` is auto-probed as
`"morpho-blue"`, `"morpho"`, … — because deployment names are hyphenated).

```json
{
  "name": "search_subgraphs",
  "description": "Search ~15,000 subgraphs on The Graph's decentralized network by keyword to discover deployment IDs for any protocol or chain. Multi-keyword retry is built in (spaces/hyphens). Returns clean { subgraphId, displayName, currentDeploymentIpfsHash } rows. Never throws.",
  "parameters": {
    "type": "object",
    "properties": {
      "keyword": {
        "type": "string",
        "description": "Search keyword, e.g. 'uniswap v3', 'aave', 'morpho blue'. Separation-insensitive: hyphenated variants are probed automatically."
      }
    },
    "required": ["keyword"]
  }
}
```

Returns:

```json
{
  "keyword": "uniswap v3",
  "resultsCount": 82,
  "results": [
    { "subgraphId": "FQ6JYszEKApsBpAmiHesRsd9Ygc6mzmpNRANeVQFYoVX", "displayName": "Uniswap V3 Arbitrum", "currentDeploymentIpfsHash": "Qm…" }
  ],
  "isError": false
}
```

### 4. `query_subgraph`

Ad-hoc GraphQL execution against the latest deployment of any subgraph.
Backed by `agentTools.querySubgraph(subgraphId, query, variables?)` (Subgraph
MCP, `execute_query_by_subgraph_id`).

```json
{
  "name": "query_subgraph",
  "description": "Execute arbitrary GraphQL against the latest deployment of any subgraph on The Graph's decentralized network. Validate the schema first (e.g. via a small __type introspection query) — deployments do not all share the Messari markets schema. Never throws.",
  "parameters": {
    "type": "object",
    "properties": {
      "subgraphId": {
        "type": "string",
        "description": "Subgraph deployment ID from search_subgraphs (e.g. 'FQ6JYszEKApsBpAmiHesRsd9Ygc6mzmpNRANeVQFYoVX')."
      },
      "query": {
        "type": "string",
        "description": "GraphQL query string. Engine A's reference pattern: markets(where: { isActive: true, inputToken_: { symbol_in: [\"USDC\"] } }, first: 10) { name inputToken { id symbol } totalValueLockedUSD rates { rate side type } }"
      },
      "variables": {
        "type": "object",
        "description": "Optional GraphQL variables."
      }
    },
    "required": ["subgraphId", "query"]
  }
}
```

Returns:

```json
{
  "subgraphId": "…",
  "data": { "data": { "markets": [ { "name": "Aave Ethereum USDC" } ] } },
  "errors": [],
  "elapsedMs": 575,
  "isError": false
}
```

**Agent workflow for unknown territory:** `search_subgraphs` →
`query_subgraph` with `{ __type(name: "Market") { fields { name } } }`
introspection → only then query data fields. Never assume the Messari
`markets` schema on a freshly discovered deployment.

---

## Data Contracts & Conventions

### ⚠️ Decimal APY convention (critical)

All APY values produced by this skill are **decimal fractions**:

```
0.0335 = 3.35%      0.12 = 12%      0.0018 = 0.18%
```

Do all financial math in decimals (e.g. annual opportunity cost for a 60-day
invoice = `apyDecimal * (60 / 365)`). Convert `* 100` only at a
human/LLM-presentation boundary — exactly once.

### Data hygiene rules baked into every response

| Rule | Constant / mechanism |
|---|---|
| **$1M TVL floor** — dust and isolated micro-markets are excluded (server-side `totalValueLockedUSD_gte` + client-side guard) | `MIN_TVL_USD = 1_000_000` (`subgraphs.config.ts:16`) |
| **Active markets only** — paused/frozen markets never enter benchmarks (e.g. Aave Arbitrum's frozen bridged USDC.e) | `where: { isActive: true }` |
| **Deepest-TVL deduplication** — one row per `(protocol, chain, symbol)`; native Circle USDC supersedes bridged variants | `deduplicateByDeepestTvl()` |
| **Provenance** — `source` (live vs `'Deterministic Baseline Fallback'`), `timestamp` (Unix ms), `marketsCount`, per-row `inputTokenId` / `marketName` / `isActive` | every report |

### Fallback & degradation contract

- Engine A partial failure → live data kept; failed assets get their own
  baseline values; `source` still identifies the report.
- Engine A total failure → `source: 'Deterministic Baseline Fallback'`,
  empty `detailedRates`. **Never present fallback as live market data.**
- Engine B degraded (e.g. Uniswap deployment indexers unhealthy) →
  reference pools tagged `protocol: 'Uniswap v3 (Fallback)'`.
- `querySubgraph` / `searchSubgraphs` **never throw**; check `isError`.

---

## Integration Quickstart (3 lines)

```typescript
import { graphFeedService, agentTools, AGENT_TOOL_DEFINITIONS } from "./src/graph/index.js";
const { benchmarks, detailedRates, source } = await graphFeedService.getStandardizedLendingBenchmarks();
const usdcHurdle = benchmarks.USDC; // decimal APY: usdcHurdle.averageSupplyApy = 0.0335 → 3.35%
```

Register `AGENT_TOOL_DEFINITIONS` with any OpenAI-compatible function-calling
host to expose all four tools to an LLM agent.

---

## Verification

```bash
npm run test-graph   # 77/77 unit tests
npm run verify       # live: lending benchmarks + DEX metrics + MCP discovery
```

`GRAPH_API_KEY` (from [Subgraph Studio](https://thegraph.com/studio/)) is
required in `.env` for live calls.

