# Factora Graph Feed — Integration & Architecture Guide

> **Status:** Live & hardened (`npm run verify` exits 0; 77/77 tests pass).
> **Objective:** Connect live data feed (`src/graph/`) to Underwriter Agent (`src/underwriter/`), replacing the legacy mock.

---

## 1. Quick Reference & Breaking Differences

| Aspect | Legacy Mock (`graph-feed.mock.ts`) | Live Graph Feed (`src/graph/`) |
|---|---|---|
| **Unit Convention** | Percentage points (`14.5` = 14.5%) | **Decimal fractions (`0.0335` = 3.35%)** ⚠️ |
| **USDC Hurdle Rate** | Stale static `14.5%` | Real-time DeFi average: **~2.8% – 4.2%** |
| **Lending Benchmarks** | Hardcoded object | `graphFeedService.getStandardizedLendingBenchmarks()` |
| **DEX LP Opportunity** | Not available | `graphFeedService.getDEXLiquidityYield()` (MCP) |
| **Data Source** | Mock memory | The Graph Gateway (Messari) + Subgraph MCP |

> ⚠️ **CRITICAL RULE:** Do all internal financial math in decimals. Only convert (`* 100`) at the presentation/prompt layer for the LLM.

---

## 2. Architecture & Data Contracts


Underwriting Agent (Pricing Engine)
├── Engine A (Lending Baseline): graphFeedService.getStandardizedLendingBenchmarks()
│    └── Direct HTTP → The Graph Gateway → Messari Schema (Aave v3, Compound v3, Morpho Blue)
└── Engine B (DEX Opportunity Cost): graphFeedService.getDEXLiquidityYield()
└── Subgraph MCP → Uniswap v3 24h LP fee yield & dynamic discovery


### Exported Signatures (`src/graph/index.ts`)

```typescript
// 1. Core Lending Benchmarks (Deterministic Hurdle)
const report = await graphFeedService.getStandardizedLendingBenchmarks();
// report.benchmarks.USDC -> { averageSupplyApy: 0.0335, maxSupplyApy: 0.0423, topMarket: 'Compound v3 (Ethereum)', marketsCount: 4 }
// report.detailedRates -> Array of validated markets (deduped, TVL >= $1M)

// 2. DEX LP Opportunity Cost (Enrichment via Subgraph MCP)
const lpPools = await graphFeedService.getDEXLiquidityYield();
// lpPools[0] -> { protocol: 'Uniswap v3', pair: 'USDC/USDT (0.01%)', estimatedApy: 0.0412, tvlUSD: 18200000 }

```

---

## 3. Data Hardening & Edge Cases Solved

* **Arbitrum USDC Duplication:** Excluded frozen bridged `USDC.e` (`0xff97...`, TVL $1.1M, stale 3.9% APY) by enforcing `isActive: true` and deduplicating by `(protocol, chain, symbol)` to keep native Circle USDC (`0xaf88...`, TVL $172M, 2.76% APY).
* **Morpho Blue Integration:** Official Morpho Blue subgraphs implement the Messari lending schema natively. It is queried directly in Engine A alongside Aave/Compound.
* **$1M TVL Floor (`MIN_TVL_USD = 1_000_000`):** Automatically drops dust/isolated pools.
* **Unit Normalization:** Converts Ray values (`>1e18` via `/1e27`) and percentage values (`(0.0001, 100]` via `/100`) into clean 4-decimal floats (`0.0335`).
* **Zero-Crash Resilience:** All targets use `Promise.allSettled` with retries. Complete network failures gracefully fallback to deterministic baselines tagged `source: 'Deterministic Baseline Fallback'`.

---

## 4. Teammate Integration Blueprint (3 Steps)

### Step 1: Create Adapter (`src/underwriter/market.context.ts`)

```typescript
import { graphFeedService } from '../graph/index.js';

export interface UnderwritingMarketContext {
  baseLendingApyDecimal: number;       // e.g. 0.0335 (3.35%)
  lendingSource: string;
  lendingIsFallback: boolean;
  alternativeLpApyDecimal?: number;    // e.g. 0.0410 (4.10% LP opportunity cost)
  alternativeLpPool?: string;
  timestamp: number;
}

export async function buildUnderwritingMarketContext(
  asset: string = 'USDC'
): Promise<UnderwritingMarketContext> {
  const lending = await graphFeedService.getStandardizedLendingBenchmarks();
  let lp = [];
  try { lp = await graphFeedService.getDEXLiquidityYield(); } catch {}

  const targetAsset = lending.benchmarks[asset] ?? lending.benchmarks.USDC;
  const topLp = lp.sort((a, b) => b.estimatedApy - a.estimatedApy)[0];

  return {
    baseLendingApyDecimal: targetAsset.averageSupplyApy,
    lendingSource: lending.source,
    lendingIsFallback: lending.source.includes('Fallback'),
    alternativeLpApyDecimal: topLp?.estimatedApy,
    alternativeLpPool: topLp?.pair,
    timestamp: lending.timestamp,
  };
}

```

### Step 2: Update Agent & Prompt Formatting

In `src/underwriter/underwriter.agent.ts`:

* Replace `GraphMarketData` imports with `UnderwritingMarketContext`.
* Pass the context into `buildUnderwriterPrompt()`.

In `src/underwriter/underwriter.prompt.ts`:

```typescript
// Explicit unit conversion ONLY at the prompt presentation boundary:
marketBenchmarks: {
  baseLendingApyPercent: Number((market.baseLendingApyDecimal * 100).toFixed(2)), // 0.0335 -> 3.35
  lendingSource: market.lendingSource,
  alternativeLpApyPercent: market.alternativeLpApyDecimal != null 
    ? Number((market.alternativeLpApyDecimal * 100).toFixed(2)) 
    : undefined,
}

```

### Step 3: Wire into Buyer Service (`src/buyer/buyer.service.ts`)

```typescript
// Replace getMarketBenchmark() mock call with:
const marketContext = await buildUnderwritingMarketContext(invoiceAsset);
const aiAnalysis = await evaluateProposalsWithAI(candidates, buyerRequirements, marketContext);

```

---

## 5. Verification & Common Questions

### Commands

```bash
npm run test-graph   # 77/77 unit tests passing (parsers, dedupe, normalizer)
npm run typecheck    # tsc compilation check
npm run verify       # Live verification against The Graph Gateway + MCP

```

### Meeting Q&A Cheatsheet

* **Why did APYs drop from 14.5% to ~3.3%?**
The mock used unrealistic hardcoded percentages. Real-world DeFi lending yields on USDC/USDT currently sit between 2.8% and 4.2%.
* **Does MCP slow down pricing?**
No. Engine A (direct HTTP) finishes in <2s and is the critical path. Engine B (MCP) is wrapped asynchronously for enrichment.
* **Why do we need both Messari and MCP?**
Messari provides standardized, deterministic multi-protocol lending rates ("Composable Graph Products" track). MCP enables dynamic discovery and DEX pool analytics that standard lending schemas do not contain ("Best AI Use Case" track).

```

```