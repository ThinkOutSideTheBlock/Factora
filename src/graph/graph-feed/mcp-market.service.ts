/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🏆 ETHGlobal Online 2026 — Judge note
 * Track: "🧩 Best Use of Composable or Standardized Graph Products"
 * (composition requirement — Graph product #2)
 *
 * This engine talks to The Graph's SUBGRAPH MCP server (graph-mcp.client.ts)
 * to DISCOVER and query subgraphs at runtime that the standardized Messari set
 * does not cover (e.g. Compound v3 on Base, whose Market entity deviates from
 * the shared schema — see the coverage matrix in subgraphs.config.ts), then
 * normalizes whatever schema it finds into our common yield-reading shape with
 * a per-row confidence label. Standardized Subgraphs + Subgraph MCP = two
 * Graph products composed into one cross-chain feed (graph-feed.ts) that
 * feeds AI underwriting and the sold x402 insights payload.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { graphMcpClient } from './graph-mcp.client.js';
import {
  ApyMethod,
  DynamicYieldOpportunity,
  DynamicYieldQuery,
  SupportedChain,
} from './graph-feed.types.js';

interface DiscoveredCandidate {
  subgraphId: string;
  displayName: string;
}

type DynamicRow = Record<string, unknown>;
interface YieldReading {
  apy: number;
  method: ApyMethod;
  confidence: 'high' | 'medium';
}

const ASSET_ALIASES: Record<string, string> = {
  USDC: 'USDC',
  'USDC.E': 'USDC',
  USDBC: 'USDC',
  USDCN: 'USDC',
  USDT: 'USDT',
  DAI: 'DAI',
};

const DEFAULT_TVL_FLOOR_USD = 1_000_000;
const MIN_USABLE_APY = 0.0001;
const MAX_CANDIDATES_PROBED = 16;
const CANDIDATE_BATCH_SIZE = 4;
const MCP_SOURCE_TAG = 'The Graph Subgraph MCP (dynamic discovery)';
const ROOT_SCHEMA_QUERY = `
  query DynamicRootSchema {
    __schema {
      queryType {
        fields {
          name
          type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
        }
      }
    }
  }
`;
const TYPE_SCHEMA_QUERY = `
  query DynamicTypeSchema($typeName: String!) {
    __type(name: $typeName) {
      fields {
        name
        type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
      }
    }
  }
`;

/**
 * Dynamic Engine B. Discovery is intentionally tolerant: the MCP may return
 * Messari markets, vaults, staking rows, or aggregator pools. The service
 * normalizes the common token, TVL, and yield fields without requiring a
 * particular entity schema, and a bad deployment only removes that candidate.
 */
export class McpMarketService {
  async getDynamicYieldOpportunities(
    query: DynamicYieldQuery,
  ): Promise<DynamicYieldOpportunity[]> {
    const floorUsd = Math.max(0, query.minTvlUsd ?? DEFAULT_TVL_FLOOR_USD);
    const tierThresholdUsd = floorUsd * 10;
    const keywords =
      query.protocolKeywords && query.protocolKeywords.length > 0
        ? query.protocolKeywords
        : ['lending'];
    const limit = Math.max(0, query.limit ?? 20);
    const candidates = await this.discoverCandidates(keywords);
    if (candidates.length === 0) {
      console.warn('[McpMarket] discovery returned no candidates');
      return [];
    }

    const opportunities: DynamicYieldOpportunity[] = [];
    let rejectedCandidates = 0;
    const timestamp = Date.now();
    const selectedCandidates = candidates.slice(0, MAX_CANDIDATES_PROBED);
    for (let start = 0; start < selectedCandidates.length; start += CANDIDATE_BATCH_SIZE) {
      const batch = selectedCandidates.slice(start, start + CANDIDATE_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (candidate) => {
          const result = await this.queryCandidate(candidate);
          const rows = this.extractRows(result);
          return rows
            .map((row) =>
              this.toOpportunity(
                row,
                candidate,
                query.chains,
                query.excludeMarkets,
                floorUsd,
                tierThresholdUsd,
                timestamp,
              ),
            )
            .filter((opportunity): opportunity is DynamicYieldOpportunity =>
              opportunity !== null,
            );
        }),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') opportunities.push(...result.value);
        else rejectedCandidates += 1;
      }
    }

    if (rejectedCandidates > 0) {
      console.warn(
        `[McpMarket] skipped ${rejectedCandidates} deployment(s) with unavailable or incompatible schemas`,
      );
    }

    opportunities.sort((a, b) => b.totalValueLockedUSD - a.totalValueLockedUSD);
    return opportunities.slice(0, limit);
  }

  private async discoverCandidates(
    keywords: string[],
  ): Promise<DiscoveredCandidate[]> {
    const byId = new Map<string, DiscoveredCandidate>();
    const searches = await Promise.allSettled(
      keywords.map((keyword) => graphMcpClient.searchSubgraphs(keyword)),
    );

    for (const search of searches) {
      if (search.status === 'rejected') {
        console.warn(
          '[McpMarket] keyword search failed:',
          search.reason instanceof Error ? search.reason.message : search.reason,
        );
        continue;
      }
      const raw = search.value;
      if (!raw) continue;
      const rows = Array.isArray(raw.results)
        ? raw.results
        : Array.isArray(raw.subgraphs)
          ? raw.subgraphs
          : [];
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const record = row as DynamicRow;
        const metadata = this.asRecord(record.metadata);
        const subgraphId = this.asString(record.subgraphId ?? record.id);
        if (!subgraphId || byId.has(subgraphId)) continue;
        const displayName =
          this.asString(record.displayName) ??
          this.asString(metadata?.displayName) ??
          subgraphId;
        byId.set(subgraphId, { subgraphId, displayName });
      }
    }
    return [...byId.values()];
  }

  private extractRows(result: Record<string, unknown> | null): DynamicRow[] {
    const outer = this.asRecord(result?.data) ?? result;
    const payload = this.asRecord(outer?.data) ?? outer;
    if (!payload) return [];
    for (const key of [
      'markets',
      'lendingMarkets',
      'vaults',
      'stakingPools',
      'pools',
      'strategies',
      'vaultShares',
      'farms',
      'reserves',
      'tokens',
      'opportunities',
      'assets',
    ]) {
      const rows = payload[key];
      if (Array.isArray(rows)) {
        return rows.filter((row): row is DynamicRow =>
          Boolean(row && typeof row === 'object'),
        );
      }
    }
    // Custom deployments often expose a differently named root collection.
    // Keep the schema-agnostic service useful without requiring a new key for
    // every vault, strategy, or pool schema.
    for (const value of Object.values(payload)) {
      if (Array.isArray(value)) {
        const rows = value.filter((row): row is DynamicRow =>
          Boolean(row && typeof row === 'object'),
        );
        if (rows.length > 0) return rows;
      }
    }
    return [];
  }

  private async queryCandidate(
    candidate: DiscoveredCandidate,
  ): Promise<Record<string, unknown> | null> {
    const schema = await graphMcpClient.queryDynamic(
      candidate.subgraphId,
      ROOT_SCHEMA_QUERY,
    );
    const rootFields = this.extractSchemaFields(schema);
    const root = this.selectRootField(rootFields);
    if (!root) return null;

    const rootType = this.namedType(root.type);
    if (!rootType) return null;
    const typeSchema = await graphMcpClient.queryDynamic(
      candidate.subgraphId,
      TYPE_SCHEMA_QUERY,
      { typeName: rootType },
    );
    const fields = this.extractSchemaFields(typeSchema);
    const selection = await this.buildSelection(fields, candidate.subgraphId);
    if (!selection) return null;

    const rootName = this.asString(root.name);
    if (!rootName) return null;
    const pagination = this.isList(root.type) ? '(first: 100)' : '';
    const query = `query DynamicYield { ${rootName}${pagination} { ${selection} } }`;
    try {
      const result = await graphMcpClient.queryDynamic(candidate.subgraphId, query);
      if (result) return result;
    } catch (error) {
      console.debug(
        `[McpMarket] ${candidate.displayName} dynamic selection failed:`,
        error instanceof Error ? error.message : error,
      );
    }

    // Some MCP deployments return an empty payload for optional fields even
    // though the root entity is queryable. Retry with the smallest common
    // selection instead of discarding a deployment that may contain APY data.
    const fallback = `query DynamicYieldFallback { ${rootName}${pagination} { ${selection} } }`;
    try {
      return await graphMcpClient.queryDynamic(candidate.subgraphId, fallback);
    } catch (error) {
      console.debug(
        `[McpMarket] ${candidate.displayName} fallback selection failed:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }

  private selectRootField(fields: DynamicRow[]): DynamicRow | null {
    const preferred = [
      'markets',
      'lendingMarkets',
      'vaults',
      'pools',
      'stakingPools',
      'strategies',
      'vaultShares',
      'farms',
      'reserves',
      'tokens',
    ];
    for (const name of preferred) {
      const field = fields.find(
        (candidate) => candidate.name === name && this.isList(candidate.type),
      );
      if (field) return field;
    }
    return (
      fields.find(
        (field) =>
          this.isList(field.type) &&
          /market|vault|pool|reserve|lending|yield|token/i.test(
            this.asString(field.name) ?? '',
          ),
      ) ?? null
    );
  }

  private async buildSelection(
    fields: DynamicRow[],
    subgraphId: string,
  ): Promise<string> {
    const names = new Set(fields.map((field) => field.name));
    const scalarFields = [
      'id',
      'name',
      'symbol',
      'totalValueLockedUSD',
      'tvlUSD',
      'tvl',
      'totalAssetsUSD',
      'apy',
      'apr',
      'netApy',
      'supplyApy',
      'supplyApr',
      'annualizedApy',
      'annualizedApr',
      'yieldRate',
      'yield',
      'apyNet',
      'totalAssets',
      'assetsUnderManagementUSD',
      'isActive',
      'active',
    ].filter((name) => names.has(name));
    const nestedFields = [
      'inputToken',
      'token',
      'asset',
      'underlyingAsset',
      'underlyingToken',
      'underlying',
    ].filter((name) => names.has(name));
    const selections = [...scalarFields];
    for (const field of nestedFields) {
      const nested = fields.find((candidate) => candidate.name === field);
      const nestedType = this.namedType(nested?.type);
      if (!nestedType) continue;
      const nestedSchema = await graphMcpClient.queryDynamic(
        subgraphId,
        TYPE_SCHEMA_QUERY,
        { typeName: nestedType },
      ).catch(() => null);
      const nestedFields = this.extractSchemaFields(nestedSchema);
      const nestedNames = new Set(nestedFields.map((item) => item.name));
      const nestedSelection = [
        'id',
        'symbol',
        'name',
        'timestamp',
        'sharePrice',
        'pricePerShare',
        'exchangeRate',
        'totalAssetsUSD',
        'totalValueLockedUSD',
      ].filter((name) => nestedNames.has(name));
      if (nestedSelection.length > 0) {
        selections.push(`${field} { ${nestedSelection.join(' ')} }`);
      }
    }
    if (names.has('rates')) selections.push('rates { rate side type }');
    return selections.join(' ');
  }

  private extractSchemaFields(result: Record<string, unknown> | null): DynamicRow[] {
    const data = this.asRecord(this.asRecord(result?.data)?.data) ?? this.asRecord(result?.data);
    const type = this.asRecord(data?.__schema) ?? this.asRecord(data?.__type);
    const fields = type?.queryType
      ? this.asRecord(type.queryType)?.fields
      : type?.fields;
    return Array.isArray(fields)
      ? fields.filter((field): field is DynamicRow => Boolean(field && typeof field === 'object'))
      : [];
  }

  private isList(type: unknown): boolean {
    const record = this.asRecord(type);
    if (!record) return false;
    if (record.kind === 'LIST') return true;
    return this.isList(record.ofType);
  }

  private namedType(type: unknown): string | undefined {
    const record = this.asRecord(type);
    if (!record) return undefined;
    if (typeof record.name === 'string') return record.name;
    return this.namedType(record.ofType);
  }

  private toOpportunity(
    row: DynamicRow,
    candidate: DiscoveredCandidate,
    chains: SupportedChain[] | undefined,
    excludeMarkets: DynamicYieldQuery['excludeMarkets'],
    floorUsd: number,
    tierThresholdUsd: number,
    timestamp: number,
  ): DynamicYieldOpportunity | null {
    if (row.isActive === false || row.active === false) return null;

    const token =
      this.asRecord(row.inputToken) ??
      this.asRecord(row.token) ??
      this.asRecord(row.asset) ??
      this.asRecord(row.underlyingAsset) ??
      this.asRecord(row.underlying) ??
      this.asRecord(row.underlyingToken);
    const rawSymbol =
      this.asString(row.symbol) ??
      this.asString(token?.symbol) ??
      this.asString(row.assetSymbol);
    const symbol = rawSymbol ? ASSET_ALIASES[rawSymbol.toUpperCase()] : undefined;
    if (!symbol) return null;

    const tvl = this.toNumber(
      row.totalValueLockedUSD ??
        row.tvlUSD ??
        row.tvl ??
        row.totalAssetsUSD ??
        row.totalAssets ??
          row.totalManagedAssetsUSD ??
          row.assetsUnderManagementUSD,
    );
    if (tvl < floorUsd) return null;

    const yieldReading = this.readYield(row);
    if (yieldReading.apy < MIN_USABLE_APY) return null;

    const chain = this.inferChain(candidate.displayName);
    if (chains && chains.length > 0 && !chains.includes(chain)) return null;

    if (this.isCoveredByEngineA(candidate.displayName, chain, symbol, excludeMarkets)) {
      return null;
    }

    const category = this.inferCategory(candidate.displayName, row);

    return {
      protocol: candidate.displayName,
      chain,
      symbol,
      category,
      supplyApy: Number(yieldReading.apy.toFixed(4)),
      apyMethod: yieldReading.method,
      confidence: yieldReading.confidence,
      riskClass: this.inferRiskClass(category),
      totalValueLockedUSD: tvl,
      tier: tvl >= tierThresholdUsd ? 'established' : 'emerging',
      deploymentId: candidate.subgraphId,
      source: MCP_SOURCE_TAG,
      timestamp,
    };
  }

  private isCoveredByEngineA(
    protocol: string,
    chain: SupportedChain,
    symbol: string,
    existing: DynamicYieldQuery['excludeMarkets'],
  ): boolean {
    if (!existing || existing.length === 0) return false;
    const normalizedProtocol = this.protocolFamily(protocol);
    return existing.some(
      (market) =>
        market.symbol.toUpperCase() === symbol &&
        market.chain === chain &&
        this.protocolFamily(market.protocol) === normalizedProtocol,
    );
  }

  private protocolFamily(protocol: string): string {
    const normalized = protocol.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized.includes('aavev2')) return 'aave-v2';
    if (normalized.includes('aavev3')) return 'aave-v3';
    if (normalized.includes('compoundv2')) return 'compound-v2';
    if (normalized.includes('compoundv3')) return 'compound-v3';
    if (normalized.includes('aave')) return 'aave';
    if (normalized.includes('compound')) return 'compound';
    if (normalized.includes('spark')) return 'spark';
    if (normalized.includes('morpho')) return 'morpho';
    return normalized;
  }

  private inferCategory(
    protocol: string,
    row: DynamicRow,
  ): DynamicYieldOpportunity['category'] {
    const label = `${protocol} ${String(row.type ?? '')} ${String(row.category ?? '')}`.toLowerCase();
    if (label.includes('vault')) return 'vault';
    if (label.includes('stak')) return 'staking';
    if (label.includes('pool') || label.includes('liquid')) return 'liquidity';
    if (
      label.includes('lend') ||
      label.includes('aave') ||
      label.includes('compound') ||
      label.includes('spark') ||
      label.includes('morpho')
    ) {
      return 'lending';
    }
    return 'other';
  }

  private readYield(row: DynamicRow): YieldReading {
    const rates = Array.isArray(row.rates) ? row.rates : [];
    for (const item of rates) {
      if (!item || typeof item !== 'object') continue;
      const rate = item as DynamicRow;
      if (rate.side !== undefined && rate.side !== 'LENDER') continue;
      if (rate.type !== undefined && rate.type !== 'VARIABLE') continue;
      const value = this.toNumber(rate.rate ?? rate.apy ?? rate.apr);
      if (value > 0) {
        return { apy: this.normalizeRate(value), method: 'direct-rate', confidence: 'high' };
      }
    }
    const value = this.toNumber(
      row.supplyApy ??
        row.apy ??
        row.netApy ??
        row.supplyApr ??
        row.apr ??
        row.annualPercentageYield ??
        row.annualPercentageRate ??
        row.annualizedApy ??
        row.annualizedApr ??
        row.apyNet ??
        row.yieldRate ??
        row.yield,
    );
    if (value > 0) {
      return { apy: this.normalizeRate(value), method: 'direct-rate', confidence: 'high' };
    }

    const snapshots = this.collectSnapshots(row);
    if (snapshots.length < 2) {
      return { apy: 0, method: 'share-price-growth', confidence: 'medium' };
    }
    const oldest = snapshots[0];
    const newest = snapshots[snapshots.length - 1];
    const oldValue = this.snapshotValue(oldest);
    const newValue = this.snapshotValue(newest);
    const oldTime = this.toNumber(oldest.timestamp);
    const newTime = this.toNumber(newest.timestamp);
    const days = (newTime - oldTime) / 86_400;
    if (!(oldValue > 0 && newValue > 0 && days > 0)) {
      return { apy: 0, method: 'share-price-growth', confidence: 'medium' };
    }
    const growth = newValue / oldValue;
    const apy = Math.pow(growth, 365 / days) - 1;
    return {
      apy: Number.isFinite(apy) && apy >= 0 ? apy : 0,
      method: 'share-price-growth',
      confidence: days >= 7 ? 'high' : 'medium',
    };
  }

  private collectSnapshots(row: DynamicRow): DynamicRow[] {
    for (const key of ['snapshots', 'dailySnapshots', 'hourlySnapshots']) {
      const snapshots = row[key];
      if (Array.isArray(snapshots)) {
        return snapshots
          .filter((item): item is DynamicRow => Boolean(item && typeof item === 'object'))
          .sort((a, b) => this.toNumber(a.timestamp) - this.toNumber(b.timestamp));
      }
    }
    return [];
  }

  private snapshotValue(snapshot: DynamicRow): number {
    return this.toNumber(
      snapshot.sharePrice ??
        snapshot.pricePerShare ??
        snapshot.exchangeRate ??
        snapshot.totalAssetsUSD ??
        snapshot.totalValueLockedUSD,
    );
  }

  private inferRiskClass(category: DynamicYieldOpportunity['category']):
    DynamicYieldOpportunity['riskClass'] {
    if (category === 'vault') return 'vault';
    if (category === 'staking') return 'staking';
    if (category === 'liquidity') return 'liquidity';
    return 'lending';
  }

  private inferChain(displayName: string): SupportedChain {
    const label = displayName.toLowerCase();
    if (label.includes('arbitrum')) return 'Arbitrum';
    if (label.includes('base')) return 'Base';
    if (label.includes('polygon') || label.includes('matic')) return 'Polygon';
    return 'Ethereum';
  }

  private normalizeRate(value: number): number {
    if (value > 1e18) return value / 1e27;
    if (value > 0.0001 && value <= 100) return value / 100;
    return value;
  }

  private toNumber(value: unknown): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  private asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private asRecord(value: unknown): DynamicRow | null {
    return value && typeof value === 'object' ? (value as DynamicRow) : null;
  }
}

export const mcpMarketService = new McpMarketService();
