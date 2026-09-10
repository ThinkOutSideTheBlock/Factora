import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proposalRouter } from './proposal/proposal.controller.js';
import { buyerRouter } from './buyer/buyer.controller.js';
import { agentRouter } from './agent/agent.controller.js';
import { paymentMiddleware } from '@x402/express';
import {
  buildX402Routes,
  createX402ResourceServer,
} from './x402/x402.middleware.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../public');

export const app: Express = express();

// Global Middlewares
app.use(cors());
app.use(express.json());

// Serve static frontend assets
app.use(express.static(PUBLIC_DIR));

// x402 payment gate — protects POST /api/proposals and /api/buyer/smart-report
// with HTTP 402 challenges settled through the Blocky402 facilitator.
app.use(paymentMiddleware(buildX402Routes(), createX402ResourceServer()));


// Health Check Endpoint
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Mount Domain Routes
app.use('/api/proposals', proposalRouter);
app.use('/api/buyer', buyerRouter);
app.use('/api/matchmaking', buyerRouter); // Alias for compatibility with plan
app.use('/api/agent', agentRouter);
