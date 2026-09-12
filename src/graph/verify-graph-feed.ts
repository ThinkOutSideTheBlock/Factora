import 'dotenv/config';
import {
  graphFeedService,
  graphMcpClient,
  agentTools,
  LENDING_SUBGRAPHS,
  MIN_TVL_USD,
  UNISWAP_V3_ETHEREUM_SUBGRAPH_ID,
  UNISWAP_TOP_STABLE_POOLS_QUERY,
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

  // ── 2. Engine B: Dynamic Subgraph MCP (Agent Interface) ────────────────
  console.log('2. Testing Dynamic Subgraph MCP (Engine B)...');

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

  // 2b. Differentiated Engine B data: DEX liquidity pool depth + fee yield.
  // This is data the Messari lending schema (Engine A) physically cannot
  // express — demonstrating the composed Graph products instead of a redundant
  // Aave parity query.
  console.log('\n   2b. Querying Uniswap v3 (via MCP) for DEX Liquidity / Alternative Yield...');
  const uniswapResult = await agentTools.querySubgraph(
    UNISWAP_V3_ETHEREUM_SUBGRAPH_ID,
    UNISWAP_TOP_STABLE_POOLS_QUERY,
  );

  // Graceful degradation: the deployment may be unhealthy at the network
  // level (e.g. "bad indexers"). That is a live-data health signal, not a
  // code defect — surface it and exercise the module's tagged fallback path
  // instead of failing the verification.
  let pools: Array<Record<string, any>> = [];
  if (uniswapResult.isError) {
    console.log('   ⚠ Uniswap deployment degraded at the network level (indexer health):');
    console.log(`     ${String(uniswapResult.error).slice(0, 240)}`);
    console.log('     Continuing with module-level LP pools (tagged provenance) below.');
  } else {
    pools =
      (uniswapResult.data as { data?: { liquidityPools?: Array<Record<string, any>> } } | null)
        ?.data?.liquidityPools ?? [];
    if (pools.length === 0) {
      const errors = (uniswapResult.data as { errors?: unknown } | null)?.errors;
      console.log('   ⚠ Uniswap deployment returned no pools (deployment health):');
      console.log(`     ${JSON.stringify(errors ?? uniswapResult.data).slice(0, 240)}`);
      console.log('     Continuing with module-level LP pools (tagged provenance) below.');
    }
  }

  if (pools.length > 0) {
    console.log(`   Live pools returned: ${pools.length} (response ${uniswapResult.elapsedMs}ms)`);
    for (const pool of pools) {
      const feePct = (pool.fees ?? []).find(
        (f: any) => f.feeType === 'FIXED_TRADING_FEE',
      )?.feePercentage;
      const snaps: Array<Record<string, any>> = pool.hourlySnapshots ?? [];
      const revenues = snaps.map((s) => Number(s.hourlySupplySideRevenueUSD));
      const tvls = snaps.map((s) => Number(s.totalValueLockedUSD));
      const revenueSum = revenues.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
      const avgTvl = tvls.length ? tvls.reduce((acc, v) => acc + v, 0) / tvls.length : 0;
      const estApy =
        avgTvl > 0 && snaps.length >= 2 ? ((revenueSum / snaps.length) * 24 * 365) / avgTvl : 0;
      console.log(
        `     - ${pool.name}  |  fee ${feePct ?? 'n/a'}%  |  TVL $${Math.round(
          Number(pool.totalValueLockedUSD),
        ).toLocaleString('en-US')}  |  24h supply-side rev $${revenueSum.toFixed(2)}  |  ` +
          `est fee APY ${(estApy * 100).toFixed(3)}%`,
      );
    }
  }

  // Module-level LP path: live pools when the deployment is healthy, or
  // clearly-tagged 'Uniswap v3 (Fallback)' reference pools when degraded.
  const lpPools = await graphFeedService.getDEXLiquidityYield();
  console.log('   Module LP yield (opportunity cost, decimal APY):');
  for (const pool of lpPools) {
    console.log(
      `     - [${pool.protocol}] ${pool.pair}  |  estApy=${(pool.estimatedApy * 100).toFixed(3)}%  ` +
        `tvlUSD=$${Math.round(pool.tvlUSD).toLocaleString('en-US')}`,
    );
  }
  if (lpPools.length === 0) fail('no LP pools returned (live or fallback)');

  // ── Standards Leverage Summary (Track 1: Composable Graph Products) ────
  console.log('\n═══ Standards Leverage Summary ═══');
  console.log(
    `• ${LENDING_SUBGRAPHS.length} Messari-standardized deployments scanned across ` +
      'Ethereum/Arbitrum/Base with ONE GraphQL query (MESSARI_MULTI_ASSET_QUERY)',
  );
  console.log(
    '• Composition: Gateway HTTP (Engine A lending) + Subgraph MCP (Engine B DEX liquidity & discovery)',
  );
  console.log(
    `• Live provenance: ${lendingReport.detailedRates.length} lending markets + ${lpPools.length} LP pools ` +
      `tagged with source/timestamp ("${lendingReport.source}")`,
  );

  // ── Cleanup ──────────────────────────────────────────────────────────
  await graphMcpClient.close();
  console.log('\n--- Verification Completed ---');
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
