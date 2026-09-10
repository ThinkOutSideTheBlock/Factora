import 'dotenv/config';
import { graphFeedService, graphMcpClient, agentTools } from './graph-feed/index.js';

async function main() {
  console.log('--- Starting Graph Feed Verification ---\n');

  // ── 1. Engine A: Standardized Lending Benchmarks (Messari) ──────────
  console.log('1. Testing Standardized Multi-Asset Lending Benchmarks...');
  const lendingReport = await graphFeedService.getStandardizedLendingBenchmarks();
  console.log('   Source:', lendingReport.source);
  console.log('   USDC:', lendingReport.benchmarks.USDC);
  console.log('   USDT:', lendingReport.benchmarks.USDT);
  console.log('   DAI:', lendingReport.benchmarks.DAI);
  console.log(`   Markets Scanned: ${lendingReport.detailedRates.length}\n`);

  // ── 2. Engine B: Dynamic MCP Search (Agent Tools) ───────────────────
  console.log('2. Testing Dynamic MCP Tools (Agent Interface)...');

  // 2a. Search for subgraphs by keyword
  const searchKeyword = 'uniswap v3';
  console.log(`   2a. Searching subgraphs for "${searchKeyword}"...`);
  const searchResult = await agentTools.searchSubgraphs(searchKeyword);
  if (searchResult.isError) {
    console.log('   ⚠ Search failed:', searchResult.error);
  } else {
    console.log(`   Found ${searchResult.resultsCount} subgraphs`);
    if (searchResult.results.length > 0) {
      console.log('   Top 3 results:');
      searchResult.results.slice(0, 3).forEach((r, i) => {
        console.log(`     ${i + 1}. ${r.displayName} (${r.subgraphId.slice(0, 12)}…)`);
      });
    }
  }

  // 2b. Query a specific subgraph dynamically
  console.log('\n   2b. Querying Aave v3 Ethereum for USDC market...');
  const queryResult = await agentTools.querySubgraph(
    'JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk',
    `{
      markets(
        where: { inputToken_: { symbol: "USDC" } }
        first: 1
        orderBy: totalValueLockedUSD
        orderDirection: desc
      ) {
        name
        inputToken { symbol }
        totalValueLockedUSD
        rates { rate side type }
      }
    }`,
  );
  if (queryResult.isError) {
    console.log('   ⚠ Query failed:', queryResult.error);
  } else {
    console.log('   Response time:', queryResult.elapsedMs + 'ms');
    console.log('   Data:', JSON.stringify(queryResult.data, null, 2).slice(0, 500));
  }

  // ── Cleanup ──────────────────────────────────────────────────────────
  await graphMcpClient.close();
  console.log('\n--- Verification Completed ---');
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
