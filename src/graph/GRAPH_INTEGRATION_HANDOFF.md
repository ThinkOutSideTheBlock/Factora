# Graph Feed Integration Handoff

This document defines the contract between the Graph Feed module and the
underwriter/agent layer. The Graph Feed implementation is intentionally kept
independent from the application integration until the agent team is ready to
consume it.

## Ownership Boundary

The Graph Feed team owns:

- Direct Messari-standardized lending queries.
- APY normalization and per-asset aggregation.
- Uniswap v3 LP yield discovery through The Graph MCP.
- MCP response normalization and error-safe agent tools.
- Deterministic fallbacks when external data is unavailable.
- Unit and live verification of the Graph Feed module.

The agent/application team owns:

- Calling `graphFeedService` from the underwriting flow.
- Converting the Graph Feed report into the underwriting context DTO.
- Choosing how lending and LP yields affect the risk premium or discount rate.
- Passing the converted context to the LLM prompt.
- Route-level and end-to-end tests proving that live Graph data reaches the
  smart-report response.
- Deciding how fallback data should be communicated to users or investors.

There is currently no live Graph-to-underwriter integration. Do not replace
the legacy mock import blindly: the mock and live contracts use different
fields and numeric units.

## Numeric Contract

All APY values produced by the Graph Feed are **decimal fractions**:

```text
0.0347 = 3.47%
0.12   = 12%
```

This applies to:

- `AssetBenchmark.averageSupplyApy`
- `AssetBenchmark.maxSupplyApy`
- `AssetBenchmark.minSupplyApy`
- `ProtocolMarketRate.supplyApy`
- `ProtocolMarketRate.borrowApy`
- `LpPoolBenchmark.estimatedApy`

The agent/application layer must convert to percentage points only at a
presentation boundary:

```ts
const displayPercent = apyDecimal * 100;
```

Do not multiply by 100 before doing financial calculations. For example, the
annual opportunity cost for a 60-day invoice is:

```ts
const annualRate = lendingBenchmark.averageSupplyApy;
const opportunityCost = annualRate * (durationDays / 365);
```

Buyer proposal APY currently uses percentage points in the existing
application (`8.5` means `8.5%`). The agent adapter must explicitly convert
between these two conventions instead of passing one type into the other.

Recommended adapter convention:

```ts
interface UnderwritingMarketContext {
	baseLendingApyDecimal: number;
	alternativeLpApyDecimal?: number;
	source: string;
	isFallback: boolean;
	timestamp: number;
}
```

Keep this context in decimal form. Convert only when rendering a response for
humans.

## Lending Report Contract

Call:

```ts
const report = await graphFeedService.getStandardizedLendingBenchmarks();
```

The primary underwriting asset is normally USDC:

```ts
const usdc = report.benchmarks.USDC;
const baseLendingApyDecimal = usdc.averageSupplyApy;
```

`report.detailedRates` contains one normalized record per usable market. The
canonical symbols are `USDC`, `USDT`, and `DAI`. Bridged USDC symbols such as
`USDC.e`, `USDbC`, and `USDCn` are normalized to canonical `USDC`.

Important fields:

- `averageSupplyApy`: arithmetic mean of positive supply APYs for the asset.
- `maxSupplyApy` / `minSupplyApy`: range across positive live markets.
- `topMarket`: protocol and chain with the highest positive supply APY.
- `marketsCount`: number of positive live markets included.
- `source`: identifies live standardized data versus deterministic fallback.
- `timestamp`: Unix milliseconds.

If all lending sources fail, the report is a deterministic fallback report. If
only some sources fail, live data is retained and missing assets receive their
own asset-specific fallback baseline. Consumers should inspect `source` and
should not represent fallback data as live market data.

## LP Yield Contract

Call:

```ts
const pools = await graphFeedService.getDEXLiquidityYield();
```

Each returned pool has:

- `protocol`
- `pair`
- `estimatedApy` as a decimal fraction
- `tvlUSD` as a non-negative USD number

`estimatedApy` is an annualized estimate from the available hourly
supply-side fee revenue and snapshot TVL. It is not a guaranteed yield and
does not include impermanent loss, volatility, liquidity withdrawal risk, or
smart-contract risk.

The current Graph module returns fallback reference pools when MCP is offline
or no usable pool remains. The agent must treat fallback LP values as
reference data, not as a live executable opportunity.

The LP data is currently not used by underwriting. The agent team must decide
whether it belongs in the discount-rate formula. If used, document the weight
and risk treatment explicitly; do not silently add LP APY to lending APY.

## Agent Tools Contract

The agent-facing facade is exported from `src/graph/index.ts`:

```ts
import { agentTools } from "../graph/index.js";
```

`agentTools.searchSubgraphs(keyword)` returns a non-throwing result with:

- `isError`
- `error` when failed
- `keyword`
- `resultsCount`
- `results[]` with `subgraphId`, `displayName`, and optional deployment hash

`agentTools.querySubgraph(subgraphId, query, variables?)` returns a non-throwing
result with:

- `isError`
- `error` when failed
- `data`
- `subgraphId`
- `elapsedMs`

These tools are for dynamic discovery and ad-hoc GraphQL. The agent should
validate a discovered schema before issuing a query and must not assume that
all subgraphs share the Messari `markets` schema.

## Verification and Tests

The Graph-specific test suite is:

```bash
npm run test-graph
```

It covers normalization, aggregation, fallback behavior, LP annualization,
MCP lifecycle basics, structured MCP payloads, and agent-tool mapping.

The live smoke verification is:

```bash
npm run verify
```

It now fails with a non-zero exit code when search returns no subgraphs or the
Aave USDC query returns no markets. A successful exit means the configured
live calls returned the minimum expected shape; it does not prove economic
correctness or guarantee that every deployment is healthy.

Before agent integration, add an application-level test that proves this
flow:

```text
smart-report route
  -> Graph Feed provider
  -> UnderwritingMarketContext adapter
  -> underwriter prompt
  -> validated LLM response
```

That test must also assert the APY unit conversion and fallback/source flag.

## Required Agent-Side Decisions

Before replacing the legacy mock, the agent team should:

1. Define and own the `UnderwritingMarketContext` adapter boundary.
2. Decide whether USDC is always the base asset or whether the invoice asset
   is selected dynamically.
3. Use decimal APYs for all calculations and convert proposal percentage APYs
   explicitly when comparing yields.
4. Decide whether LP yield affects pricing, and assign a separate risk spread
   rather than treating it as risk-free lending yield.
5. Expose or log `source`, `timestamp`, and fallback status for auditability.
6. Add route-level tests before declaring the live Graph feed integrated.
