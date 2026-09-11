import { Router, Request, Response } from 'express';
import { BuyerSearchRequest, BuyerSearchSchema, SmartReportRequest, SmartReportSchema } from './buyer.model.js';
import { generateSmartReport, searchProposals } from './buyer.service.js';
import { validateBody } from '../common/validate.middleware.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('buyer-api');

export const buyerRouter = Router();

/**
 * POST /api/buyer/search
 * Free matchmaking: returns only proposals that meet the buyer's constraints.
 */
buyerRouter.post(
  '/search',
  validateBody(BuyerSearchSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const criteria = req.body as BuyerSearchRequest;
      const response = await searchProposals(criteria);
      res.status(200).json(response);
    } catch (error) {
      log.error('Error during buyer matchmaking search', error);
      res.status(500).json({ error: 'Internal server error during matchmaking search' });
    }
  }
);

/**
 * POST /api/buyer/smart-report
 * Paid-service boundary: x402 middleware protects this route with DYNAMIC
 * per-token pricing (see src/x402/pricing.ts). The optional `maxTokens` field
 * in the body is priced before this handler runs.
 */
buyerRouter.post(
  '/smart-report',
  validateBody(SmartReportSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const criteria = req.body as SmartReportRequest;
      const response = await generateSmartReport(criteria);
      res.status(200).json(response);
    } catch (error) {
      // Surface the real cause to the buyer (LLM down, model missing, etc.)
      // instead of a generic 500 — the x402 settlement only happens after a
      // successful handler, so failing here means the payer is not charged.
      const message = error instanceof Error ? error.message : 'Smart report failed';
      log.error(`Smart report failed: ${message}`);
      res.status(502).json({ error: `Smart report failed: ${message}` });
    }
  }
);
