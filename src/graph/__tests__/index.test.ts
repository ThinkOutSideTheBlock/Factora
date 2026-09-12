/**
 * ============================================================================
 * TEST SUITE: Barrel Exports & Type Definitions
 * ============================================================================
 *
 * Validates that the graph-feed module correctly re-exports all public
 * interfaces, classes, and functional service exports. This ensures downstream
 * consumers (agents, backends) can import everything from a single path.
 *
 * Author: Factora Team
 * ============================================================================
 */

import { describe, it, expect } from "vitest";

import * as graphFeed from "../index.js";

describe("graph-feed barrel exports", () => {
    it("should export the functional Messari feed", () => {
        expect(graphFeed.getStandardizedLendingBenchmarks).toBeDefined();
        expect(typeof graphFeed.getStandardizedLendingBenchmarks).toBe(
            "function",
        );
    });

    it("should export the GraphMcpClient class", () => {
        expect(graphFeed.GraphMcpClient).toBeDefined();
        expect(typeof graphFeed.GraphMcpClient).toBe("function");
    });

    it("should export the singleton graphMcpClient instance", () => {
        expect(graphFeed.graphMcpClient).toBeDefined();
        expect(graphFeed.graphMcpClient).toBeInstanceOf(
            graphFeed.GraphMcpClient,
        );
    });

    it("should export the McpMarketService class and singleton (Engine B)", () => {
        expect(graphFeed.McpMarketService).toBeDefined();
        expect(typeof graphFeed.McpMarketService).toBe("function");
        expect(graphFeed.mcpMarketService).toBeDefined();
        expect(graphFeed.mcpMarketService).toBeInstanceOf(
            graphFeed.McpMarketService,
        );
    });

    it("should export subgraph configuration constants", () => {
        expect(graphFeed.LENDING_SUBGRAPHS).toBeDefined();
        expect(Array.isArray(graphFeed.LENDING_SUBGRAPHS)).toBe(true);
        expect(graphFeed.MESSARI_MULTI_ASSET_QUERY).toBeDefined();
        expect(typeof graphFeed.MESSARI_MULTI_ASSET_QUERY).toBe("string");
    });

    it("should export the strict error contract types", () => {
        expect(graphFeed.GraphFeedError).toBeDefined();
        expect(typeof graphFeed.GraphFeedError).toBe("function");
        expect(graphFeed.RISK_PROFILE_TVLS).toEqual({
            low: 10_000_000,
            mid: 1_000_000,
        });
    });

    it("should export TypeScript interfaces as type-only (runtime presence check)", () => {
        // TypeScript interfaces are erased at compile time, so they don't exist
        // at runtime. We verify the module loads without errors as a proxy.
        expect(typeof graphFeed).toBe("object");
    });
});
