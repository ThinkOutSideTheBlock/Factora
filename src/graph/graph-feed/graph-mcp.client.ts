interface McpToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface McpListToolsResult {
  tools?: Array<{ name: string }>;
}

interface McpClientLike {
  callTool(params: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<unknown>;
  listTools(): Promise<unknown>;
  close(): Promise<void>;
}

interface McpTransportLike {
  close(): Promise<void>;
}

/**
 * Singleton lifecycle manager for the Subgraph MCP server.
 *
 * Connects to The Graph's remote hosted MCP service via `npx mcp-remote`
 * (SSE transport to https://subgraphs.mcp.thegraph.com/sse).  The SDK is
 * imported dynamically so CommonJS/ts-node hosts never hit ERR_REQUIRE_ESM
 * at module load time; the first tool call pays the import.
 *
 * Initialization failures resolve to `false` and surface as thrown errors on
 * use — callers wrap calls in their own fallback path, so the Express host
 * never crashes.
 */
export class GraphMcpClient {
  private client: McpClientLike | null = null;
  private transport: McpTransportLike | null = null;
  private isConnected = false;
  private initPromise: Promise<boolean> | null = null;
  private readonly apiKey: string;
  private readonly command: string;
  private readonly commandArgs: string[];

  constructor(
    apiKey?: string,
    command = 'npx',
    commandArgs?: string[],
  ) {
    this.apiKey = apiKey ?? (process.env.GRAPH_API_KEY || '');
    this.command = command;
    this.commandArgs = commandArgs ?? [
      'mcp-remote',
      '--header',
      `Authorization:Bearer ${this.apiKey}`,
      'https://subgraphs.mcp.thegraph.com/sse',
    ];
  }

  async initialize(): Promise<boolean> {
    if (this.isConnected) return true;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInitialize().catch((error) => {
      console.warn(
        '[GraphMcpClient] MCP initialization failed, using fallback:',
        error instanceof Error ? error.message : error,
      );
      this.isConnected = false;
      this.initPromise = null;
      return false;
    });
    return this.initPromise;
  }

  private async doInitialize(): Promise<boolean> {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/stdio.js'
    );

    const transport = new StdioClientTransport({
      command: this.command,
      args: this.commandArgs,
      stderr: 'pipe',
    });
    // Subprocess diagnostics; swallowed so they never crash the host.
    transport.stderr?.on('data', () => {});

    const client = new Client(
      { name: 'claimflow-graph-feed', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);

    this.client = client as unknown as McpClientLike;
    this.transport = transport as unknown as McpTransportLike;
    this.isConnected = true;
    return true;
  }

  private async ensureConnected(): Promise<McpClientLike> {
    if (!this.isConnected || !this.client) {
      const ready = await this.initialize();
      if (!ready || !this.client) {
        throw new Error('MCP Client offline');
      }
    }
    return this.client;
  }

  async listTools(): Promise<string[]> {
    try {
      const client = await this.ensureConnected();
      const result = (await client.listTools()) as McpListToolsResult;
      return (result.tools ?? []).map((t) => t.name);
    } catch (error) {
      console.warn(
        '[GraphMcpClient] listTools failed:',
        error instanceof Error ? error.message : error,
      );
      return [];
    }
  }

  async queryDynamic(
    subgraphId: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const client = await this.ensureConnected();
    const result = (await client.callTool({
      name: 'execute_query_by_subgraph_id',
      arguments: {
        subgraph_id: subgraphId,
        query,
        ...(variables ? { variables } : {}),
      },
    })) as McpToolCallResult;

    if (result.isError) {
      const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
      throw new Error(`MCP tool error: ${text}`);
    }

    return this.parseToolPayload(result);
  }

  /**
   * Keyword search with multi-token retry.
   *
   * The MCP keyword index is inconsistent about token separation: names like
   * "morpho-blue-base" only match when the keyword is hyphenated ("morpho"
   * works, "morpho blue" returns 0), while names like "Compound V3 Base"
   * only match when it is spaced. A single failed probe therefore retries
   * automatically with de-spaced/hyphenated/token variants before giving up,
   * and a clean "no results" answer never throws.
   */
  async searchSubgraphs(
    keyword: string,
  ): Promise<Record<string, unknown> | null> {
    const client = await this.ensureConnected();
    const variants = GraphMcpClient.buildKeywordVariants(keyword);

    let lastFailure: unknown = null;
    let lastEmpty: Record<string, unknown> | null = null;

    for (const variant of variants) {
      let result: McpToolCallResult;
      try {
        result = (await client.callTool({
          name: 'search_subgraphs_by_keyword',
          arguments: { keyword: variant },
        })) as McpToolCallResult;
      } catch (error) {
        lastFailure = error;
        continue;
      }

      if (result.isError) {
        const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
        lastFailure = new Error(`MCP tool error: ${text}`);
        continue;
      }

      const payload = this.parseToolPayload(result);
      if (payload && GraphMcpClient.countSearchResults(payload) > 0) {
        return payload;
      }
      lastEmpty = payload;
    }

    // Every variant probed cleanly but none matched — surface the last
    // (empty) payload instead of throwing.
    if (lastEmpty !== null || lastFailure === null) {
      return lastEmpty;
    }
    throw lastFailure instanceof Error
      ? lastFailure
      : new Error('MCP subgraph search failed');
  }

  /**
   * Expand a raw search keyword into probe variants: the keyword as provided,
   * then hyphenated/spaced re-joins, then the individual tokens. Order keeps
   * the caller's original intent first.
   */
  static buildKeywordVariants(keyword: string): string[] {
    const trimmed = keyword.trim();
    if (!trimmed) return [trimmed];
    const tokens = trimmed.split(/[\s\-_]+/).filter((token) => token.length > 0);
    if (tokens.length <= 1) return [trimmed];
    const variants = [
      trimmed,
      tokens.join('-'),
      tokens.join(' '),
      tokens[0],
      tokens[tokens.length - 1],
    ];
    return [...new Set(variants)];
  }

  /** Count result rows across the payload shapes the MCP service emits. */
  private static countSearchResults(
    payload: Record<string, unknown>,
  ): number {
    if (typeof payload.resultsCount === 'number') return payload.resultsCount;
    if (typeof payload.total === 'number') return payload.total;
    if (Array.isArray(payload.results)) return payload.results.length;
    if (Array.isArray(payload.subgraphs)) return payload.subgraphs.length;
    return 0;
  }

  async close(): Promise<void> {
    const { client, transport } = this;
    this.client = null;
    this.transport = null;
    this.isConnected = false;
    this.initPromise = null;
    try {
      if (client) await client.close();
    } catch {
      // already gone
    }
    try {
      if (transport) await transport.close();
    } catch {
      // already gone
    }
  }

  private parseToolPayload(
    result: McpToolCallResult,
  ): Record<string, unknown> | null {
    if (result.structuredContent != null) {
      return result.structuredContent as Record<string, unknown>;
    }
    const text = result.content?.find((c) => c.type === 'text')?.text;
    if (!text) return null;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { raw: text };
    }
  }
}

export const graphMcpClient = new GraphMcpClient();
