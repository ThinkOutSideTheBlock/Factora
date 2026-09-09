import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { CreateProposalDto, CreateProposalSchema, Proposal } from './proposal.model.js';
import { addProposal, getAllProposals } from './proposal.storage.js';
import { validateBody } from '../common/validate.middleware.js';

export const proposalRouter = Router();

/**
 * Calculates APY percentage based on debt nominal amount, required cash, and duration.
 * APY = ((amount - requiredAmount) / requiredAmount) * (365 / returnDateInDays) * 100
 */
export function calculateApy(amount: number, requiredAmount: number, returnDateInDays: number): number {
  if (requiredAmount <= 0 || returnDateInDays <= 0) {
    return 0;
  }
  const yieldRatio = (amount - requiredAmount) / requiredAmount;
  const annualized = yieldRatio * (365 / returnDateInDays) * 100;
  return Number(annualized.toFixed(2));
}

/**
 * POST /api/proposals
 * Create a new debt proposal.
 */
proposalRouter.post(
  '/',
  validateBody(CreateProposalSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { proposerAddress, amount, requiredAmount, returnDateInDays } = req.body as CreateProposalDto;
      const apy = calculateApy(amount, requiredAmount, returnDateInDays);

      const newProposal: Proposal = {
        id: uuidv4(),
        proposerAddress,
        amount,
        requiredAmount,
        returnDateInDays,
        apy,
        status: 'PENDING',
        createdAt: new Date().toISOString()
      };

      const savedProposal = await addProposal(newProposal);
      res.status(201).json({
        message: 'Proposal created successfully',
        proposal: savedProposal
      });
    } catch (error) {
      console.error('Error creating proposal:', error);
      res.status(500).json({ error: 'Internal server error while creating proposal' });
    }
  }
);

/**
 * GET /api/proposals
 * Fetch list of proposals (optional filter by ?status=PENDING).
 */
proposalRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const statusQuery = req.query.status as string | undefined;
    const proposals = await getAllProposals();

    if (statusQuery) {
      const filtered = proposals.filter((p) => p.status.toUpperCase() === statusQuery.toUpperCase());
      res.status(200).json({ count: filtered.length, proposals: filtered });
      return;
    }

    res.status(200).json({ count: proposals.length, proposals });
  } catch (error) {
    console.error('Error fetching proposals:', error);
    res.status(500).json({ error: 'Internal server error while retrieving proposals' });
  }
});
