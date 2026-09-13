<p align="center">
  <img src="./logoType.png" alt="Factora — Invoice Factoring × Blockchain × AI" width="400" />
</p>

<p align="center">
  <strong>Autonomous AI Agents for Invoice Financing &amp; Yield Generation</strong>
</p>

> **AI agents autonomously find, evaluate, negotiate, and finance unpaid business invoices.**

Built for **ETHOnline 2026** 🏛️

---

🎬 **[DEMO VIDEO LINK]** · 🌐 **[LIVE DEMO LINK]**

---

## 🧩 The Problem

Small and medium businesses sit on **$3+ trillion of unpaid invoices** at any moment (global factoring market). A supplier that has delivered goods and issued an invoice can wait **30–90 days** for payment — cash it needs *today* for payroll, inventory, and growth.

Traditional factoring fixes this, but poorly: it is slow, opaque, relationship-driven, and locked behind institutional intermediaries that cherry-pick large, "safe" invoices. The long tail of business receivables is effectively unfinanceable.

## 💡 The Solution — Factora

Factora turns invoice financing into an **autonomous, agent-to-agent marketplace**:

1. **A business lists an unpaid invoice** as a debt proposal (debt document → economics derived automatically).
2. The **AI Underwriter Agent** reviews the debt document, prices the risk, and sets a **hurdle rate from live DeFi market data** (The Graph).
3. The **Buyer / Investor Agent** evaluates listed proposals, negotiates discount terms, and decides whether to finance.
4. Agents pay each other **per API call with zero API keys or subscriptions** via the **x402 protocol on Hedera** (settled through the Blocky402 facilitator).
5. The financed receivable is **tokenized on-chain** with Hedera's **Asset Tokenization Studio (ATS)** — issuance → compliance → trade → settlement — all verifiable on the Hedera Testnet.

No human coordination in the loop: agents find, evaluate, negotiate, and finance — end to end.

### [SCREENSHOT OR GIF OF THE FACTORA FRONTEND — MARKETPLACE / SETTLEMENT VIEW]

---

## 🏗️ Architecture

```text
                ┌─────────────────────────────────────────────────┐
                │        Factora Frontend (port 3000)             │
                │   Raise · Invest · Settlement · Dev Console     │
                └───────────────────────┬─────────────────────────┘
                                        │
┌───────────────────────────────────────▼──────────────────────────────────┐
│              Factora Main App — Express API (port 3000)                  │
│                                                                          │
│  Proposal Service      Buyer / Matchmaking        Underwriter Agent      │
│  (debt documents,      (evaluate, negotiate,      (OpenAI-compatible    │
│   economics)            finance receivables)       LLM, evidence-strict)│
│        │                        │                      │                 │
│        │                        │          ┌───────────▼───────────┐     │
│        │                        │          │  The Graph Data Feed  │     │
│        │                        │          │  Messari-standardized │     │
│        │                        │          │  subgraphs + MCP      │     │
│        │                        │          └───────────────────────┘     │
│        │                        │                                        │
│  ┌─────▼────────────────────────▼──────────────────────────────────┐    │
│  │        x402 Payment Gate (Hedera · Blocky402 facilitator)       │    │
│  │   "exact" scheme · HTS/HBAR settlement · on-chain receipts      │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │        World ID — Selfie Check gate (/api/world)                │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────┬──────────────────────────────────┘
                                        │ HEDERA_SERVICE_URL (HTTP)
┌───────────────────────────────────────▼──────────────────────────────────┐
│         factored-hedera Sidecar — Execution Boundary (port 3001)         │
│                                                                          │
│   ATS (Asset Tokenization Studio) lifecycle:                             │
│   register → LISTED → UNDERWRITING → APPROVED → TOKENIZED →              │
│   trade → party confirmations → settlement/clearing → maturity           │
│                                                                          │
│   @hashgraph/asset-tokenization-sdk · @hashgraph/sdk · HCS audit trail   │
└───────────────────────────────────────┬──────────────────────────────────┘
                                        │
                                  Hedera Testnet 🌐
```

## 🤖 The Agents

| Agent | Role |
|-------|------|
| 🧾 **AI Underwriter Agent** | Reviews the debt document with a strict evidence contract (never invents credit scores, payment history, or financials), prices risk, and grounds pricing in **live DeFi hurdle rates** fetched from The Graph. |
| 🤝 **Buyer / Negotiation Agent** | Evaluates listed proposals, negotiates discount terms, and finances receivables. |
| 💸 **Payer Agent (A2A)** | Pays for every paid endpoint machine-to-machine over x402 — no API keys, no subscriptions. Streams every step (invoice → 402 challenge → on-chain settlement) as NDJSON to the UI. |

---

## 🏆 Bounties & Tracks — ETHOnline 2026

| # | Bounty | How Factora qualifies |
|---|--------|------------------------|
| 1 | **World ID — Selfie Check** | Selfie Check as identity/risk signal + Sybil-resistance on proposals |
| 2 | **Hedera — AI & Agentic Payments on Hedera** | Gated API service with x402 on Hedera, settled via Blocky402 facilitator |
| 3 | **Hedera — Tokenization of Anything** | Receivables/cashflow tokenization with ATS (issuance → compliance → trade → settlement) |
| 4 | **The Graph — Best Use of Composable or Standardized Graph Products** | Live data from Messari Standardized Subgraphs + Subgraph MCP Engine B |
| 5 | **The Graph — Best AI Tooling or AI Use Case with The Graph — Net-New** | The Graph as the live data layer of the AI Underwriter Agent |

### 1️⃣ World ID — Selfie Check 

We use **World ID Selfie Check** as the identity-verification gate for creating proposals on Factora:

- A completed Selfie Check acts as an **anti-abuse / anti-Sybil signal** on debt proposals — a verified proposer is a real, live human, not a scripted bot mass-listing fake invoices.
- It feeds directly into **risk evaluation** — verification status is surfaced to the Underwriter Agent as an eligibility signal on the debt proposal.
- **The full flow was walked end-to-end** (RP-initiated challenge → sandbox selfie verification → World ID proof → verified proposal) during development and in the demo.

📝 **Developer feedback on integrating the Selfie Check API / Sandbox:** [WORLD ID FEEDBACK LINK]

### 2️⃣ Hedera — AI & Agentic Payments on Hedera 

Factora's core APIs are a **gated service** — every meaningful call costs money, and **agents pay autonomously**:

- **x402 protocol on Hedera** with the `exact` scheme: unauthenticated calls get a `402 Payment Required` challenge; the payer agent retries with `X-PAYMENT`; the **Blocky402 facilitator verifies, co-signs as fee payer, and settles on-chain**.
- **Agent-to-agent (A2A)** interaction: the Payer Agent pays for underwriting, smart reports, and market intelligence **per call — no API keys, no subscriptions**.
- Settlement is **HTS/HBAR-based**, and every payment produces an **on-chain receipt** surfaced in the response and streamed to the UI/terminal — fully transparent on the **Hedera Testnet**.

### 3️⃣ Hedera — Tokenization of Anything 

## Architecture

```
Supplier Agent          Investor Agent
      |                       |
      +---------+-------------+
                |
      Off-chain negotiation (not in this section)
                |
   supplierConfirmation + investorConfirmation
   (same offerId, same price, own account ids)
                |
                v
       assertDealConfirmed()  ← stops here on any mismatch, before Hedera
                |
                v
     ══════════ HEDERA SECTION STARTS HERE ══════════
                |
      HCS: DEAL_CONFIRMED (immutable proof of mutual agreement)
                |
                v
        ATS Bond.create()  → new security for this receivable
                |
                v
   bootstrapSecurityForOperator()
   grants ISSUER_ROLE, KYC_ROLE, CLEARING_VALIDATOR_ROLE,
   SSI_MANAGER_ROLE, ROLE_CLEARING, ROLE_MATURITY_REDEEMER
   + registers operator as SSI credential issuer
   (every new security is its own contract; nothing carries
    over from a prior bond — this runs once per security)
                |
                v
      KYC grant → supplier (real Terminal3 VC, required
      before issuance since internalKyc is active)
                |
                v
        Issue 1 unit → SUPPLIER (initial holder)
                |
                v
   Supplier authorizes operator (authorizeOperator +
   authorizeOperatorByPartition) — one-time per security,
   required before the operator can move the supplier's
   tokens on their behalf during clearing
                |
                v
      KYC grant → investor (real Terminal3 VC)
                |
                v
   Clearing INITIATE (operator-from mode, supplier as source)
                |
                v
   Clearing APPROVE (validator role) → note moves to INVESTOR
                |
                v
   USDC settlement: purchase price, investor → supplier
   (HTS allowance-based transfer; investor never hands
    custody to FACTORED, only pre-approves a ceiling)
                |
                v
   Scheduled Transaction: investor's face-value payout,
   pre-signed now, set to execute automatically at the
   maturity timestamp (see "Scheduled Transactions" below)
                |
                v
      HCS: full audit trail across every step above
                |
                v
     ══════════ (LATER, AT MATURITY) ══════════
                |
   Debtor payment confirmed?
     NO  → cancel the scheduled payout before it fires,
           write DEFAULT_DETECTED to HCS
     YES → deactivate clearing (ROLE_CLEARING; required
           precondition for redemption), then
           Bond.fullRedeemAtMaturity() burns the investor's
           note — the scheduled payout above already paid
           them, or is about to, independent of this step
```


## Scheduled Transactions 

The investor's face-value payout at maturity is a real Hedera **Scheduled Transaction**, not a
cron job hitting a plain transfer. It's created and fully signed at the moment the primary sale
settles — with `waitForExpiry(true)` and `expirationTime` set to the receivable's maturity
timestamp — which means Hedera's own consensus nodes execute the payout automatically, with no
live process required, if the debtor pays on time. If the debtor defaults, the schedule is
cancelled (`ScheduleDeleteTransaction`) before its expiration, using an admin key set at
creation for exactly that purpose. This also produces a complete, timestamped, on-chain audit
trail (HCS + the schedule's own execution record) of exactly when a payment obligation was
created and exactly when — or whether — it was honored.

## Agent integration surface

Agents (supplier-side and investor-side) never touch Hedera directly — this is the entire
contract between the negotiation layer and this section:

```
POST /api/trades/execute
  Body: ApprovedTrade — receivable terms + supplierConfirmation + investorConfirmation
  → 200 SettlementResult (securityId, every transaction id, scheduleId, audit trail)
  → 409 deal confirmations don't match — negotiation bug, not a Hedera issue
  → 424 supplier hasn't authorized the operator on this security yet
  → 503 Hedera execution not enabled / not ready

POST /api/suppliers/:accountId/authorize-operator
  Body: { securityId }
  → one-time per new security

POST /api/investors/:accountId/approve-usdc-allowance
  Body: { amountUsd }
  → one-time (or refreshed) per investor
```

No agent ever constructs an ATS request, signs a Hedera transaction, or knows a role hash
exists. That boundary is deliberate: it's what lets "AI proposes and negotiates, Hedera
executes" hold as a real guarantee rather than a slogan.

```

## What ATS gave us for free vs. what we built

ATS provides the regulated-security primitives: bond issuance, partition-based clearing,
on-chain KYC enforcement, SSI-based credential verification, and maturity redemption. What
FACTORED's Hedera section adds on top: the deal-confirmation gate before any token exists, the
per-security bootstrap that makes a brand-new bond usable without manual setup, the
non-custodial operator-authorization model for suppliers, the HTS allowance-based cash leg, the
Scheduled Transaction payout mechanism, and the full HCS audit taxonomy tying every step back
to the human-confirmed deal that authorized it.


### 4️⃣ The Graph — Best Use of Composable or Standardized Graph Products

Factora's risk engine runs on **live** The Graph data, in two composed engines:

- **Engine A — Standardized:** ONE shared GraphQL query pattern against **Messari-standardized lending subgraphs** (Aave v3, Compound v3, Morpho Blue, Spark) for live USDC/USDT/DAI supply APYs — the shared schema means a new protocol is a **one-line config entry** (proved when Morpho Blue was added with **zero query changes**).
- **Engine B — Composable (MCP):** the **Subgraph MCP server** discovers and queries *any* of ~15,000 subgraphs at runtime, returning **additive yield opportunities** beyond the standardized baseline, and powering Uniswap v3 DEX liquidity yields the lending schema can't express.

These engines set the **hurdle rate** the Underwriter Agent uses to price invoices: financing capital has a real, live alternative yield cost.

### 5️⃣ The Graph — Best AI Tooling or AI Use Case with The Graph — Net-New

Factora is a **net-new agentic use case** for The Graph: it is the **primary live blockchain data source for the AI Underwriter Agent's autonomous pricing decisions**:

- The agent queries standardized benchmarks + MCP-discovered opportunities **as tool calls** (`searchSubgraphs`, `querySubgraph`, `getDynamicYieldOpportunities`) with OpenAI-compatible JSON Schema tool definitions — pluggable into any LLM host.
- The Graph data is **layered** into underwriting: market data grounds the hurdle rate, while the LLM applies it to the specific debt document — under a strict "never invent external facts" evidence contract.

---

## 🛠️ Tech Stack

| Layer | Tech |
|-------|------|
| Backend | TypeScript (ES2022, Node ≥ 20), Express 5, Zod |
| AI Agents | OpenAI-compatible LLM client (function-calling tool schemas) |
| Live market data | The Graph — Gateway (Messari-standardized subgraphs) + Subgraph MCP (`@modelcontextprotocol/sdk`) |
| Agentic payments | x402 protocol on Hedera (`@x402/core`, `@x402/express`, `@x402/fetch`, `@x402/hedera`) settled via the Blocky402 facilitator |
| On-chain tokenization | Hedera ATS (`@hashgraph/asset-tokenization-sdk`, `@hashgraph/sdk`), HTS tokens, HCS audit |
| Identity | World ID — Selfie Check (medium-assurance biometric credential) |
| Frontend | Vanilla TS/JS + custom CSS |
| Testing | Vitest (unit / component / integration / e2e suites on the sidecar) |

---

## 🚀 Quick Start — Run It Locally

Factora runs as **two services**: the main app (API + frontend) and the ATS execution sidecar.

```bash
# ── ① ATS sidecar (factored-hedera, port 3001) ─────────────────
cd hedera
npm install
PORT=3001 npm run dev          # Fastify execution boundary
# optional one-time on-chain bootstrap:
npm run bootstrap:hedera

# ── ② Main app (repo root, port 3000) — in a second terminal ──
npm install
cp .env.example .env           # then fill in the values below
npm run dev                    # → http://localhost:3000
```

### Environment variables (main app — `.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | — | Main app port (default `3000`) |
| `LOG_LEVEL` | — | `debug` \| `info` \| `warn` \| `error` |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | ✅ | OpenAI-compatible LLM powering the Underwriter Agent |
| `HEDERA_SERVICE_ACCOUNT_ID` | ✅ | Resource-server wallet that **receives** x402 payments |
| `HEDERA_AGENT_ACCOUNT_ID` / `HEDERA_AGENT_PRIVATE_KEY` | ✅ | Payer-agent wallet (must hold testnet HBAR) |
| `X402_NETWORK` | — | `hedera:testnet` (default) \| `hedera:mainnet` |
| `X402_FACILITATOR_URL` | — | Blocky402 facilitator override (auto-derived from network) |
| `PROPOSAL_PRICE_TINYBAR` | — | Price for `POST /api/proposals` (default `100000` = 0.001 HBAR) |
| `SMART_REPORT_*` | — | Per-token metered pricing for the AI smart report |
| `HEDERA_SERVICE_URL` | ✅ | ATS sidecar base URL (`http://localhost:3001`) |
| `GRAPH_API_KEY` | ✅ | The Graph Gateway key ([Subgraph Studio](https://thegraph.com/studio/)) |
| `WORLD_RP_ID` / `WORLD_RP_SIGNING_KEY` | ✅ | World ID relying-party credentials for Selfie Check |

The sidecar keeps its own config in `hedera/.env` (operator account and network settings).

---

## 💸 Paid API Surface (A2A · x402)

| Endpoint | Pricing | Purpose |
|----------|---------|---------|
| `POST /api/proposals` | Fixed (`PROPOSAL_PRICE_TINYBAR`) | Create a debt proposal in the Factora pool |
| `POST /api/buyer/smart-report` | Metered (base + per 1k tokens) | AI Underwriter smart report on a proposal |
| `POST /api/graph/insights` | Fixed | Live on-chain market intelligence (standalone JSON for any agent) |
| `POST /api/agent/paid-request` / `.../stream` | — | The Payer Agent's own A2A proxy — pays through the x402 gate and streams each step (invoice → 402 challenge → on-chain settlement) as NDJSON |

---

## ✅ Tests & Checks

```bash
# Main app
npm run test-graph             # vitest — The Graph feed module
npm run typecheck              # tsc --noEmit
npm run verify                 # live verification against The Graph

# ATS sidecar
cd hedera
npm run test:all-offline       # unit + component suites
npm run test:e2e               # full end-to-end lifecycle
```

---

## 🔮 What's Next

- **Mainnet** — flip `X402_NETWORK=hedera:mainnet` and move operator wallets to production keys.
- **Richer underwriting signals** — payment history, debtor registry checks, and multi-source credit evidence.
- **Secondary market** — trading of tokenized receivables post-issuance.
- **More chains for market data** — expand the Engine A matrix via the shared Messari query pattern (already a one-line config per protocol).
- **Agent SDK** — publish the x402 tool schemas so third-party agents can join the marketplace.

## 👥 Team

**FACTORA Team** — ETHOnline 2026

| Name | Role | Contact |
|------|------|---------|
| emtothed | AI Agent/Backend/Frontend | https://github.com/emtothed |
| ThinkOutSideTheBlock | Hedera/Backend | https://github.com/ThinkOutSideTheBlock |
| 0xDecentralizer | The Graph/Backend | https://github.com/0xDecentralizer |

## 📄 License

ISC
