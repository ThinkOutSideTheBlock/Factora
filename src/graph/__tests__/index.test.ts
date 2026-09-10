/**
 * ============================================================================
 * TEST SUITE: Barrel Exports & Type Definitions
 * ============================================================================
 *
 * Validates that the graph-feed module correctly re-exports all public
 * interfaces, classes, and singleton instances. This ensures downstream
 * consumers (agents, backends) can import everything from a single path.
 *
 * Author: Factora Team
 * ============================================================================
 */

import { describe, it, expect } from 'vitest';

import * as graphFeed from '../index.js';

describe('graph-feed barrel exports', () => {
  it('should export the GraphFeedService class', () => {
    expect(graphFeed.GraphFeedService).toBeDefined();
    expect(typeof graphFeed.GraphFeedService).toBe('function');
  });

  it('should export the singleton graphFeedService instance', () => {
    expect(graphFeed.graphFeedService).toBeDefined();
    expect(graphFeed.graphFeedService).toBeInstanceOf(graphFeed.GraphFeedService);
  });

  it('should export the GraphMcpClient class', () => {
    expect(graphFeed.GraphMcpClient).toBeDefined();
    expect(typeof graphFeed.GraphMcpClient).toBe('function');
  });

  it('should export the singleton graphMcpClient instance', () => {
    expect(graphFeed.graphMcpClient).toBeDefined();
    expect(graphFeed.graphMcpClient).toBeInstanceOf(graphFeed.GraphMcpClient);
  });

  it('should export subgraph configuration constants', () => {
    expect(graphFeed.LENDING_SUBGRAPHS).toBeDefined();
    expect(Array.isArray(graphFeed.LENDING_SUBGRAPHS)).toBe(true);
    expect(graphFeed.MESSARI_MULTI_ASSET_QUERY).toBeDefined();
    expect(typeof graphFeed.MESSARI_MULTI_ASSET_QUERY).toBe('string');
    expect(graphFeed.UNISWAP_V3_ETHEREUM_SUBGRAPH_ID).toBeDefined();
    expect(graphFeed.UNISWAP_TOP_STABLE_POOLS_QUERY).toBeDefined();
  });

  it('should export TypeScript interfaces as type-only (runtime presence check)', () => {
    // TypeScript interfaces are erased at compile time, so they don't exist
    // at runtime. We verify the module loads without errors as a proxy.
    expect(typeof graphFeed).toBe('object');
  });
});
