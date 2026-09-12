/**
 * ============================================================================
 * TEST SUITE: GraphMcpClient
 * ============================================================================
 *
 * Tests for the singleton MCP (Model Context Protocol) client that connects
 * to the @graphprotocol/subgraph-mcp subprocess via stdio. This client is
 * used by the graph feed to execute ad-hoc queries against 15,000+
 * subgraphs on The Graph Decentralized Network.
 *
 * Key behaviors tested:
 * - Lazy initialization (no subprocess spawn until first tool call)
 * - Graceful failure handling (initialization errors don't crash the host)
 * - Close/cleanup lifecycle
 * - Error propagation from MCP tool calls
 *
 * Author: Factora Team
 * ============================================================================
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// MOCK: Client and StdioClientTransport as proper constructors
// The MCP SDK classes are used with `new`, so our mocks must also be
// constructable. We use vi.fn() with `function` syntax so it works as a
// constructor.
// ---------------------------------------------------------------------------
const mockConnect = vi.fn();
const mockCallTool = vi.fn();
const mockListTools = vi.fn();
const mockClientClose = vi.fn();
const mockTransportClose = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
    Client: vi.fn().mockImplementation(function MockClient() {
        return {
            connect: mockConnect,
            callTool: mockCallTool,
            listTools: mockListTools,
            close: mockClientClose,
        };
    }),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
    StdioClientTransport: vi.fn().mockImplementation(function MockTransport() {
        return {
            close: mockTransportClose,
            stderr: { on: vi.fn() },
        };
    }),
}));

// Import AFTER mocks so the dynamic import inside the class picks up our mocks.
import { GraphMcpClient } from "../graph-feed/graph-mcp.client.js";

describe("GraphMcpClient — Lifecycle", () => {
    let client: GraphMcpClient;

    beforeEach(() => {
        vi.clearAllMocks();
        mockConnect.mockReset();
        mockCallTool.mockReset();
        mockListTools.mockReset();
        mockClientClose.mockReset();
        mockTransportClose.mockReset();
        client = new GraphMcpClient("test-key");
    });

    afterEach(async () => {
        await client.close();
    });

    it("should initialize MCP connection on first tool call (lazy init)", async () => {
        mockConnect.mockResolvedValueOnce(undefined);
        mockCallTool.mockResolvedValueOnce({
            content: [{ type: "text", text: '{"data": "test"}' }],
        });

        await client.queryDynamic("test-subgraph-id", "{ test }");

        // Verify: connect was called (initialization happened)
        expect(mockConnect).toHaveBeenCalledOnce();
        // Verify: the tool was called with correct arguments
        expect(mockCallTool).toHaveBeenCalledWith({
            name: "execute_query_by_subgraph_id",
            arguments: {
                subgraph_id: "test-subgraph-id",
                query: "{ test }",
            },
        });
    });

    it("should not re-initialize on subsequent calls (reuse connection)", async () => {
        mockConnect.mockResolvedValue(undefined);
        mockCallTool.mockResolvedValue({
            content: [{ type: "text", text: '{"ok": true}' }],
        });

        await client.queryDynamic("id1", "{ q1 }");
        await client.queryDynamic("id2", "{ q2 }");

        // connect should only be called once (lazy singleton)
        expect(mockConnect).toHaveBeenCalledOnce();
        expect(mockCallTool).toHaveBeenCalledTimes(2);
    });

    it("should return false and not throw when initialization fails", async () => {
        mockConnect.mockRejectedValueOnce(new Error("ENOENT"));

        const result = await client.initialize();

        expect(result).toBe(false);
    });

    it('should throw "MCP Client offline" when calling queryDynamic before init succeeds', async () => {
        // Make ALL future initialization attempts fail permanently
        mockConnect.mockRejectedValue(new Error("ENOENT"));
        await client.initialize();

        // Next call should throw since client is still null
        await expect(client.queryDynamic("id", "{ test }")).rejects.toThrow(
            "MCP Client offline",
        );
    });
});

describe("GraphMcpClient — Tool Call Results", () => {
    let client: GraphMcpClient;

    beforeEach(() => {
        vi.clearAllMocks();
        client = new GraphMcpClient("test-key");
        mockConnect.mockResolvedValue(undefined);
    });

    afterEach(async () => {
        await client.close();
    });

    it("should parse structured JSON content from tool response", async () => {
        const expectedData = { markets: [{ name: "Aave v3" }] };
        mockCallTool.mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify(expectedData) }],
        });

        const result = await client.queryDynamic("test-id", "{ test }");
        expect(result).toEqual(expectedData);
    });

    it("should return structuredContent when available (preferred over text)", async () => {
        const structured = { data: { nested: true } };
        mockCallTool.mockResolvedValueOnce({
            content: [{ type: "text", text: '{"fallback": true}' }],
            structuredContent: structured,
        });

        const result = await client.queryDynamic("test-id", "{ test }");
        expect(result).toEqual(structured);
    });

    it("should throw when MCP tool returns isError = true", async () => {
        mockCallTool.mockResolvedValueOnce({
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded" }],
        });

        await expect(
            client.queryDynamic("test-id", "{ test }"),
        ).rejects.toThrow("MCP tool error: Rate limit exceeded");
    });

    it("should return null when tool response has no content", async () => {
        mockCallTool.mockResolvedValueOnce({
            content: [],
        });

        const result = await client.queryDynamic("test-id", "{ test }");
        expect(result).toBeNull();
    });

    it("should wrap unparseable text in a { raw: text } object", async () => {
        mockCallTool.mockResolvedValueOnce({
            content: [{ type: "text", text: "this is not json" }],
        });

        const result = await client.queryDynamic("test-id", "{ test }");
        expect(result).toEqual({ raw: "this is not json" });
    });
});

describe("GraphMcpClient — listTools", () => {
    let client: GraphMcpClient;

    beforeEach(() => {
        vi.clearAllMocks();
        client = new GraphMcpClient("test-key");
        mockConnect.mockResolvedValue(undefined);
    });

    afterEach(async () => {
        await client.close();
    });

    it("should return array of tool names on success", async () => {
        mockListTools.mockResolvedValueOnce({
            tools: [
                { name: "execute_query_by_subgraph_id" },
                { name: "search_subgraphs_by_keyword" },
            ],
        });

        const tools = await client.listTools();
        expect(tools).toEqual([
            "execute_query_by_subgraph_id",
            "search_subgraphs_by_keyword",
        ]);
    });

    it("should return empty array when MCP is offline", async () => {
        mockConnect.mockRejectedValueOnce(new Error("ENOENT"));
        await client.initialize();

        const tools = await client.listTools();
        expect(tools).toEqual([]);
    });
});

describe("GraphMcpClient — Close / Cleanup", () => {
    it("should reset all internal state on close", async () => {
        const client = new GraphMcpClient("test-key");
        mockConnect.mockResolvedValue(undefined);
        mockCallTool.mockResolvedValueOnce({
            content: [{ type: "text", text: "{}" }],
        });

        await client.queryDynamic("id", "{ q }");
        await client.close();

        // After close, calling initialize should trigger a fresh connection
        mockConnect.mockResolvedValueOnce(undefined);
        mockCallTool.mockResolvedValueOnce({
            content: [{ type: "text", text: "{}" }],
        });

        await client.queryDynamic("id", "{ q }");
        // connect was called again (fresh connection)
        expect(mockConnect).toHaveBeenCalledTimes(2);
    });

    it("should not throw when close is called multiple times", async () => {
        const client = new GraphMcpClient("test-key");

        await expect(client.close()).resolves.not.toThrow();
        await expect(client.close()).resolves.not.toThrow();
    });

    it("should not throw when close is called without prior initialization", async () => {
        const client = new GraphMcpClient("test-key");
        await expect(client.close()).resolves.not.toThrow();
    });
});

describe("GraphMcpClient — searchSubgraphs", () => {
    let client: GraphMcpClient;

    beforeEach(() => {
        vi.clearAllMocks();
        client = new GraphMcpClient("test-key");
        mockConnect.mockResolvedValue(undefined);
    });

    afterEach(async () => {
        await client.close();
    });

    it("should call the search tool with keyword and parse JSON response", async () => {
        const mockResult = { resultsCount: 3, results: [] };
        mockCallTool.mockResolvedValueOnce({
            content: [{ type: "text", text: JSON.stringify(mockResult) }],
        });

        const result = await client.searchSubgraphs("aave");
        expect(mockCallTool).toHaveBeenCalledWith({
            name: "search_subgraphs_by_keyword",
            arguments: { keyword: "aave" },
        });
        expect(result).toEqual(mockResult);
    });

    it("should return structuredContent from the search tool", async () => {
        const mockResult = { total: 1, subgraphs: [{ id: "abc123" }] };
        mockCallTool.mockResolvedValueOnce({ structuredContent: mockResult });

        const result = await client.searchSubgraphs("uniswap v3");

        expect(result).toEqual(mockResult);
    });

    it("should reconnect and retry once after a transient fetch failure", async () => {
        mockCallTool
            .mockRejectedValueOnce(
                new Error("MCP error -32001: mcp-remote: fetch failed"),
            )
            .mockResolvedValueOnce({
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            resultsCount: 1,
                            results: [{ id: "recovered" }],
                        }),
                    },
                ],
            });

        const result = await client.searchSubgraphs("aave");

        expect(result).toEqual({
            resultsCount: 1,
            results: [{ id: "recovered" }],
        });
        expect(mockCallTool).toHaveBeenCalledTimes(2);
        expect(mockConnect).toHaveBeenCalledTimes(2);
    });

    it("should throw when search tool returns isError", async () => {
        mockCallTool.mockResolvedValueOnce({
            isError: true,
            content: [{ type: "text", text: "Invalid keyword" }],
        });

        await expect(client.searchSubgraphs("")).rejects.toThrow(
            "MCP tool error",
        );
    });
});

// ===========================================================================
// TEST SUITE: searchSubgraphs — multi-keyword retry (Q9)
// ===========================================================================
describe("GraphMcpClient — searchSubgraphs multi-keyword retry", () => {
    let client: GraphMcpClient;

    beforeEach(() => {
        vi.clearAllMocks();
        client = new GraphMcpClient("test-key");
        mockConnect.mockResolvedValue(undefined);
    });

    afterEach(async () => {
        await client.close();
    });

    it("should probe keyword variants when the raw keyword returns no results", async () => {
        // "morpho blue" returns 0 (deployments are named "morpho-blue-*");
        // the hyphenated variant must recover.
        mockCallTool
            .mockResolvedValueOnce({
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ resultsCount: 0, results: [] }),
                    },
                ],
            })
            .mockResolvedValueOnce({
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            resultsCount: 5,
                            results: [{ id: "morpho-blue-eth" }],
                        }),
                    },
                ],
            });

        const result = await client.searchSubgraphs("morpho blue");

        expect(mockCallTool).toHaveBeenCalledTimes(2);
        expect(mockCallTool.mock.calls[1][0].arguments.keyword).toBe(
            "morpho-blue",
        );
        expect(result).toEqual({
            resultsCount: 5,
            results: [{ id: "morpho-blue-eth" }],
        });
    });

    it("should not retry when the first variant already returns results", async () => {
        mockCallTool.mockResolvedValueOnce({
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ resultsCount: 3, results: [] }),
                },
            ],
        });

        const result = await client.searchSubgraphs("uniswap v3");

        expect(mockCallTool).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ resultsCount: 3, results: [] });
    });

    it("should return an empty payload without throwing when all variants miss", async () => {
        // "morpho blue" expands to 4 distinct variants; all return 0 results.
        mockCallTool.mockResolvedValue({
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ resultsCount: 0, results: [] }),
                },
            ],
        });

        const result = await client.searchSubgraphs("morpho blue");

        expect(mockCallTool).toHaveBeenCalledTimes(4);
        expect(result).toEqual({ resultsCount: 0, results: [] });
    });
});
