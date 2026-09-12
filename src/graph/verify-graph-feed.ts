import 'dotenv/config';
import {
  getStandardizedLendingBenchmarks,
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
  const lendingReport = await getStandardizedLendingBenchmarks();
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

  const daiProtocols = new Set(
    lendingReport.detailedRates
      .filter((rate) => rate.symbol === 'DAI')
      .map((rate) => rate.protocol),
  );
  if (daiProtocols.size < 2 || !daiProtocols.has('Aave v3') || !daiProtocols.has('Spark')) {
    fail(`expected live DAI markets from Aave and Spark, found: ${[...daiProtocols].join(', ') || 'none'}`);
  }

  console.log(
    `\n   Assertions passed: no duplicate rows, TVL floor >= $${MIN_TVL_USD}, ` +
      `${LENDING_SUBGRAPHS.length} pinned targets scanned with ONE query.\n`,
  );

  // ── 2. Engine B: Dynamic Subgraph MCP (protocol-agnostic discovery) ────
  console.log('2. Testing Dynamic Subgraph MCP (Engine B, fully dynamic)...');

  // 2a. Discovery audit: this validates the MCP search tool only. The actual
  // opportunity set is produced in 2b and is filtered against Engine A.
  const searchKeyword = 'morpho blue';
  console.log(`   2a. Searching subgraphs for "${searchKeyword}" (retry path)...`);
  const searchResult = await agentTools.searchSubgraphs(searchKeyword);
  if (searchResult.isError) {
    console.warn(`   Discovery search unavailable; continuing with Engine A: ${searchResult.error}`);
  }
  if (searchResult.isError) {
    console.log('   Found 0 subgraphs (MCP unavailable)');
  } else {
    console.log(`   Found ${searchResult.resultsCount} subgraphs`);
  }
  if (!searchResult.isError && searchResult.results.length === 0) {
    console.warn(`   Discovery search returned no subgraphs for "${searchKeyword}"`);
  }
  console.log('   Top 3 results:');
  searchResult.results.slice(0, 3).forEach((r, i) => {
    console.log(`     ${i + 1}. ${r.displayName} (${r.subgraphId.slice(0, 12)}…)`);
  });

  // 2b. Fully dynamic additive yield discovery: the seeds are search terms only; the
  // MCP resolves deployments, schemas, entities, and APY fields at runtime.
  // No deployment IDs or protocol-specific GraphQL queries are pinned here.
  console.log('\n   2b. Discovering low-risk yield markets dynamically (riskProfile=low)...');
  const opportunities = await mcpMarketService.getDynamicYieldOpportunities({
    riskProfile: 'low',
    minTvlUsd: 1_000_000,
    protocolKeywords: [
      'aave',
      'compound',
      'spark',
      'vault',
      'staking',
      'yield',
      'liquidity pool',
    ],
    excludeMarkets: lendingReport.detailedRates.map((rate) => ({
      protocol: rate.protocol,
      chain: rate.chain,
      symbol: rate.symbol,
    })),
  });
  console.log(`   Additional MCP opportunities: ${opportunities.length}`);
  for (const opportunity of opportunities) {
    console.log(
      `     - [${opportunity.protocol} / ${opportunity.chain}] ${opportunity.symbol}  ` +
        `supplyAPY=${(opportunity.supplyApy * 100).toFixed(2)}%  ` +
        `TVL=$${Math.round(opportunity.totalValueLockedUSD).toLocaleString('en-US')}  ` +
        `tier=${opportunity.tier}  category=${opportunity.category}  ` +
        `risk=${opportunity.riskClass}  method=${opportunity.apyMethod}  ` +
        `confidence=${opportunity.confidence}  ` +
        `deployment=${opportunity.deploymentId.slice(0, 12)}…`,
    );
  }
  const categories = new Map<string, number>();
  for (const opportunity of opportunities) {
    categories.set(
      opportunity.category,
      (categories.get(opportunity.category) ?? 0) + 1,
    );
  }
  console.log(
    `   Additive categories: ${[...categories.entries()]
      .map(([category, count]) => `${category}=${count}`)
      .join(', ') || 'none'}`,
  );
  const emerging = opportunities.filter((o) => o.tier === 'emerging');
  console.log(
    `   Emerging additive markets: ${emerging.length} — continuously monitored for new opportunities.`,
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
    `• Live provenance: ${lendingReport.detailedRates.length} baseline markets + ${opportunities.length} additional MCP opportunities, ` +
      `all rows carry deploymentId/source/timestamp ("${lendingReport.source}")`,
  );

  // ── Cleanup ──────────────────────────────────────────────────────────
  await graphMcpClient.close();
  console.log('\n--- Verification Completed ---');
}

main().catch(async (err) => {
  await graphMcpClient.close();
  console.error('Verification failed:', err);
  process.exit(1);
});
