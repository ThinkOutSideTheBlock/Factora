import { Router, Request, Response } from 'express';
import { generateMarketInsights } from './market-insights.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('graph-api');

export const graphRouter = Router();

/**
 * POST /api/graph/insights
 * Paid-service boundary: x402 middleware protects this route with a fixed
 * price (see GRAPH_INSIGHTS_PRICE in src/x402/pricing.ts). Returns the live
 * DeFi market intelligence payload (benchmarks + MCP opportunities + AI
 * review) as standalone JSON for buyers, sellers, and external agents.
 */
graphRouter.post(
  '/insights',
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const response = await generateMarketInsights();
      res.status(200).json(response);
    } catch (error) {
      // Surface the real cause (The Graph gateway down, MCP offline, LLM
      // failure). x402 settles only after a successful handler, so failing
      // here means the payer is not charged.
      const message = error instanceof Error ? error.message : 'Graph insights failed';
      log.error(`Graph insights failed: ${message}`);
      res.status(502).json({ error: `Graph insights failed: ${message}` });
    }
  }
);
