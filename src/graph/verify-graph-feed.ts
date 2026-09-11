import 'dotenv/config';
import {
  graphFeedService,
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

  // ── 1. Engine A: Standardized Lending Benchmarks (Messari) ──────────
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
  if (lendingReport.source.includes('Fallback')) {
    fail('all lending subgraphs failed — deterministic fallback was returned');
  }

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

  // Morpho Blue must contribute to Engine A (dust tail filtered by the floor).
  const morphoRows = lendingReport.detailedRates.filter((r) => r.protocol === 'Morpho Blue');
  if (morphoRows.length === 0) {
    fail('no Morpho Blue markets in the Engine A report');
  }
  console.log(
    `\n   Assertions passed: no duplicate rows, TVL floor >= $${MIN_TVL_USD}, ` +
      `${morphoRows.length} Morpho Blue row(s) present.\n`,
  );

  // ── 2. Engine B: Dynamic MCP Search (Agent Tools) ───────────────────
  console.log('2. Testing Dynamic MCP Tools (Agent Interface)...');

  // 2a. Search by keyword — "morpho blue" previously returned 0 results
  // because deployments are named "morpho-blue-*"; the multi-keyword retry
  // must recover automatically.
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

  // 2b. Query a specific subgraph dynamically (Aave v3 Ethereum, unified filter)
  console.log('\n   2b. Querying Aave v3 Ethereum for active USDC/USDT/DAI markets...');
  const aaveEthereum = LENDING_SUBGRAPHS.find(
    (t) => t.protocol === 'Aave v3' && t.chain === 'Ethereum',
  );
  if (!aaveEthereum) fail('Aave v3 Ethereum target missing from LENDING_SUBGRAPHS');
  const queryResult = await agentTools.querySubgraph(
    aaveEthereum.subgraphId,
    `{
      markets(
        where: { isActive: true, totalValueLockedUSD_gte: "${MIN_TVL_USD}", inputToken_: { symbol_in: ["USDC", "USDT", "DAI"] } }
        first: 5
        orderBy: totalValueLockedUSD
        orderDirection: desc
      ) {
        name
        isActive
        inputToken { id symbol }
        totalValueLockedUSD
        rates { rate side type }
      }
    }`,
  );
  if (queryResult.isError) {
    throw new Error(`Query failed: ${queryResult.error}`);
  }
  const markets = (queryResult.data as { data?: { markets?: unknown[] } } | null)?.data
    ?.markets;
  if (!Array.isArray(markets) || markets.length === 0) {
    fail('Query returned no Aave USDC markets');
  }
  console.log('   Response time:', queryResult.elapsedMs + 'ms');
  console.log('   Markets returned:', markets.length);
  console.log('   Data:', JSON.stringify(queryResult.data, null, 2).slice(0, 500));

  // ── Cleanup ──────────────────────────────────────────────────────────
  await graphMcpClient.close();
  console.log('\n--- Verification Completed ---');
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});

