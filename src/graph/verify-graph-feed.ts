import 'dotenv/config';
import {
  graphFeedService,
  mcpMarketService,
  graphMcpClient,
  agentTools,
  LENDING_SUBGRAPHS,
  MIN_TVL_USD,
} from './graph-feed/index.js';

function fail(message: string): never {
  throw new Error(`Verification failed: ${message}`);
}

async function main() {
  console.log('--- Starting Graph Feed Verification ---\n');

  // ── 1. Engine A: Standardized Lending Benchmarks (Gateway HTTP, Messari) ─
  console.log('1. Testing Standardized Multi-Asset Lending Benchmarks...');
  const lendingReport = await graphFeedService.getStandardizedLendingBenchmarks();
  console.log('   Source:', lendingReport.source);
  console.log('   USDC:', lendingReport.benchmarks.USDC);
  console.log('   USDT:', lendingReport.benchmarks.USDT);
  console.log('   DAI:', lendingReport.benchmarks.DAI);
  console.log(`   Markets Scanned: ${lendingReport.detailedRates.length}`);
  for (const rate of lendingReport.detailedRates) {
    console.log(
      `     - [${rate.protocol} / ${rate.chain}] ${rate.symbol}  ` +
        `supplyAPY=${(rate.supplyApy * 100).toFixed(2)}%  ` +
        `TVL=$${Math.round(rate.totalValueLockedUSD).toLocaleString('en-US')}`,
    );
  }

  // Hardening assertions (duplicate-market bug + dust filtering):
  const seenMarkets = new Set<string>();
  for (const rate of lendingReport.detailedRates) {
    const key = `${rate.protocol}|${rate.chain}|${rate.symbol}`;
    if (seenMarkets.has(key)) {
      fail(`duplicate market row "${key}" — deduplication broken`);
    }
    seenMarkets.add(key);
    if (rate.totalValueLockedUSD < MIN_TVL_USD) {
      fail(`market "${key}" below the $${MIN_TVL_USD} TVL floor`);
    }
  }

  // The Aave v3 Arbitrum native/bridged duplicate (USDCn vs frozen USDC.e)
  // must surface at most one USDC row.
  const arbUsdcRows = lendingReport.detailedRates.filter(
    (r) => r.protocol === 'Aave v3' && r.chain === 'Arbitrum' && r.symbol === 'USDC',
  );
  if (arbUsdcRows.length > 1) {
    fail(`Aave v3 Arbitrum USDC duplicated ${arbUsdcRows.length}x`);
  }

  console.log(
    `\n   Assertions passed: no duplicate rows, TVL floor >= $${MIN_TVL_USD}, ` +
      `${LENDING_SUBGRAPHS.length} pinned targets scanned with ONE query.\n`,
  );

  // ── 2. Engine B: Dynamic Subgraph MCP (protocol-agnostic discovery) ────
  console.log('2. Testing Dynamic Subgraph MCP (Engine B, fully dynamic)...');

  // 2a. Raw search tool sanity: multi-keyword retry must recover hyphenated
  // deployment names from a spaced keyword.
  const searchKeyword = 'morpho blue';
  console.log(`   2a. Searching subgraphs for "${searchKeyword}" (retry path)...`);
  const searchResult = await agentTools.searchSubgraphs(searchKeyword);
  if (searchResult.isError) {
    throw new Error(`Search failed: ${searchResult.error}`);
  }
  console.log(`   Found ${searchResult.resultsCount} subgraphs`);
  if (searchResult.results.length === 0) {
    fail(`multi-keyword search returned no subgraphs for "${searchKeyword}"`);
  }
  console.log('   Top 3 results:');
  searchResult.results.slice(0, 3).forEach((r, i) => {
    console.log(`     ${i + 1}. ${r.displayName} (${r.subgraphId.slice(0, 12)}…)`);
  });

  // 2b. Fully dynamic yield discovery: generic keywords only — no pinned
  // protocol names, IDs, or queries. low-risk gate = $10M TVL floor.
  console.log('\n   2b. Discovering low-risk yield markets dynamically (riskProfile=low)...');
  const opportunities = await mcpMarketService.getDynamicYieldOpportunities({
    riskProfile: 'low',
  });
  console.log(`   Live opportunities: ${opportunities.length}`);
  for (const opportunity of opportunities) {
    console.log(
      `     - [${opportunity.protocol} / ${opportunity.chain}] ${opportunity.symbol}  ` +
        `supplyAPY=${(opportunity.supplyApy * 100).toFixed(2)}%  ` +
        `TVL=$${Math.round(opportunity.totalValueLockedUSD).toLocaleString('en-US')}  ` +
        `tier=${opportunity.tier}  deployment=${opportunity.deploymentId.slice(0, 12)}…`,
    );
  }
  const emerging = opportunities.filter((o) => o.tier === 'emerging');
  console.log(
    `   Emerging (watchlist) markets: ${emerging.length} — continuously monitored for new opportunities.`,
  );

  // ── Standards Leverage Summary (Track 1: Composable Graph Products) ────
  console.log('\n═══ Standards Leverage Summary ═══');
  console.log(
    `• ${LENDING_SUBGRAPHS.length} Messari-standardized deployments scanned with ONE GraphQL query (MESSARI_MULTI_ASSET_QUERY)`,
  );
  console.log(
    '• Composition: Gateway HTTP (Engine A lending) + Subgraph MCP (Engine B fully dynamic, zero pinned names/IDs)',
  );
  console.log(
    `• Live provenance: ${lendingReport.detailedRates.length} lending markets + ${opportunities.length} dynamic opportunities, ` +
      `all rows carry deploymentId/source/timestamp ("${lendingReport.source}")`,
  );

  // ── Cleanup ──────────────────────────────────────────────────────────
  await graphMcpClient.close();
  console.log('\n--- Verification Completed ---');
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
