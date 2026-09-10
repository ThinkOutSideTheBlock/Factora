# Factora — Graph Feed Module

AI Underwriter Agent's live data layer. Fetches DeFi lending rates, DEX LP yields, and subgraph metadata from The Graph Network in real-time.

## What It Does

- **Engine A** — Queries 5 Messari-standardized subgraphs (Aave v3, Compound v3, Morpho) for live USDC/USDT/DAI supply/borrow APYs
- **Engine B** — Discovers and queries _any_ subgraph on The Graph via MCP (Model Context Protocol) at runtime
- **Agent Tools** — Two composable functions (`searchSubgraphs`, `querySubgraph`) that an LLM agent can call to fetch blockchain data without hardcoded queries

## Quick Start

```bash
# Install
npm install

# Get a Graph API key at https://thegraph.com/studio/
echo "GRAPH_API_KEY=your_key_here" > .env

# Run graph tests (65 tests)
npm run test-graph

# Live verification
npm run verify

# Type check
npm run typecheck
```

## Architecture

```
Agent (LLM)
├── searchSubgraphs("curve usdc")    → finds subgraph IDs
└── querySubgraph(ID, "{ ... }")     → gets live data
      │
      ├── Engine A: graphFeedService.getStandardizedLendingBenchmarks()
      │     └── Direct HTTP → Messari subgraphs → USDC/USDT/DAI benchmarks
      │
      └── Engine B: graphMcpClient.queryDynamic()
            └── npx mcp-remote → subgraphs.mcp.thegraph.com → any subgraph
```

## Agent Integration

Your LLM agent can use these two tools:

```typescript
import { agentTools } from "./src/graph/index.js";

// 1. Search 15,000+ subgraphs by keyword
const search = await agentTools.searchSubgraphs("aave v3");
// search.results → [{ subgraphId, displayName, ... }]

// 2. Query any subgraph with arbitrary GraphQL
const data = await agentTools.querySubgraph(
	search.results[0].subgraphId,
	`{
    markets(first: 5, orderBy: totalValueLockedUSD, orderDirection: desc) {
      name
      inputToken { symbol }
      totalValueLockedUSD
      rates { rate side type }
    }
  }`,
);
// data.data → { markets: [...] }
// data.elapsedMs → 575 (ms)
// data.isError → false
```

**Key design decisions:**

- Tools **never throw** — they return `{ isError: true, error: "..." }` on failure
- `searchSubgraphs` normalizes field names from MCP's raw format to a clean interface
- `querySubgraph` handles connection lifecycle (lazy init on first call)
- Both tools track timing via `elapsedMs` for performance monitoring

**Numeric convention:** all APYs in this module are decimal fractions (`0.0347`
means `3.47%`). Convert to percentage points only at a presentation boundary.
See [GRAPH_INTEGRATION_HANDOFF.md](./GRAPH_INTEGRATION_HANDOFF.md) before
connecting this module to underwriting.

## Available MCP Tools

The Graph's MCP server exposes these tools (accessible via `agentTools`):

| Tool                                | Description                               |
| ----------------------------------- | ----------------------------------------- |
| `search_subgraphs_by_keyword`       | Search subgraphs by keyword               |
| `execute_query_by_subgraph_id`      | Run GraphQL on latest deployment          |
| `execute_query_by_deployment_id`    | Run GraphQL on specific deployment        |
| `get_schema_by_subgraph_id`         | Get GraphQL schema for a subgraph         |
| `get_top_subgraph_deployments`      | Find top subgraphs for a contract address |
| `get_deployment_30day_query_counts` | Verify subgraph activity (30-day volume)  |

## Project Structure

```
src/graph/
├── index.ts                 # Barrel exports
├── graph-feed.mock.ts       # Legacy mock market data
├── verify-graph-feed.ts     # Live verification script
├── graph-feed/
│   ├── index.ts             # Graph feed barrel exports
│   ├── graph-feed.types.ts  # TypeScript interfaces
│   ├── subgraphs.config.ts  # Subgraph IDs + GraphQL queries
│   ├── graph-feed.service.ts # Engine A + Engine B (core service)
│   ├── graph-mcp.client.ts  # MCP subprocess singleton
│   └── agent-tools.ts       # LLM agent tool registry
└── __tests__/               # 65 tests (vitest)
    ├── index.test.ts
    ├── graph-feed.service.test.ts
    ├── graph-mcp.client.test.ts
    └── agent-tools.test.ts
```

## Environment Variables

| Variable        | Required | Description                                                                    |
| --------------- | -------- | ------------------------------------------------------------------------------ |
| `GRAPH_API_KEY` | Yes      | The Graph Gateway API key from [Subgraph Studio](https://thegraph.com/studio/) |

## Scripts

| Command              | Description                         |
| -------------------- | ----------------------------------- |
| `npm test`           | Run all graph tests                 |
| `npm run test:watch` | Watch mode for tests                |
| `npm run verify`     | Live verification against The Graph |
| `npm run typecheck`  | TypeScript type checking            |

## Tech Stack

- TypeScript (ES2022, Node16 modules)
- Vitest 5.x (testing)
- `@modelcontextprotocol/sdk` (MCP client)
- `npx mcp-remote` (remote MCP transport)
- `dotenv` (environment variables)

## License

ISC
