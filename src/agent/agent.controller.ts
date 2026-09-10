import { Router, Request, Response } from 'express';
import {
  AgentWalletNotConfiguredError,
  getAgentWallet,
  paidRequest,
} from './payer.agent.js';
import { getX402Network } from '../x402/x402.middleware.js';

export const agentRouter = Router();

// The agent may only pay for our own paid endpoints.
const PAID_PATHS: readonly string[] = ['/api/proposals', '/api/buyer/smart-report'];

/** Whether the "Pay" buttons in the UI can be enabled. Exposes no secrets. */
agentRouter.get('/status', (_req: Request, res: Response): void => {
  const wallet = getAgentWallet();
  res.status(200).json({
    configured: wallet !== null,
    accountId: wallet?.accountId ?? null,
    network: getX402Network(),
    paidEndpoints: PAID_PATHS,
  });
});

/**
 * POST /api/agent/paid-request — { path, payload }
 * Pays through the agent wallet and returns { httpStatus, data, settlement }.
 */
agentRouter.post('/paid-request', async (req: Request, res: Response): Promise<void> => {
  try {
    const { path, payload } = (req.body ?? {}) as { path?: unknown; payload?: unknown };

    if (typeof path !== 'string' || !PAID_PATHS.includes(path)) {
      res.status(400).json({
        error: `Invalid path. The agent may only pay for: ${PAID_PATHS.join(', ')}`,
      });
      return;
    }

    const result = await paidRequest(path, payload);
    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof AgentWalletNotConfiguredError) {
      res.status(503).json({ error: error.message, code: 'AGENT_NOT_CONFIGURED' });
      return;
    }
    console.error('Agent paid request failed:', error);
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Agent paid request failed',
      code: 'AGENT_PAYMENT_FAILED',
    });
  }
});
