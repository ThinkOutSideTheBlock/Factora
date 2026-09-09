import { Router, Request, Response } from 'express';
import { BuyerSearchRequest, BuyerSearchSchema } from './buyer.model.js';
import { generateSmartReport, searchProposals } from './buyer.service.js';
import { validateBody } from '../common/validate.middleware.js';

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
      console.error('Error during buyer matchmaking search:', error);
      res.status(500).json({ error: 'Internal server error during matchmaking search' });
    }
  }
);

/**
 * POST /api/buyer/smart-report
 * Paid-service boundary: x402 middleware will protect this route.
 */
buyerRouter.post(
  '/smart-report',
  validateBody(BuyerSearchSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const criteria = req.body as BuyerSearchRequest;
      const response = await generateSmartReport(criteria);
      res.status(200).json(response);
    } catch (error) {
      console.error('Error generating smart report:', error);
      res.status(500).json({ error: 'Unable to generate smart report' });
    }
  }
);
