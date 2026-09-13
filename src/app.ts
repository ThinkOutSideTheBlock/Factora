import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proposalRouter } from './proposal/proposal.controller.js';
import { buyerRouter } from './buyer/buyer.controller.js';
import { agentRouter } from './agent/agent.controller.js';
import { worldRouter } from './world/world.controller.js';
import { graphRouter } from './graph/graph.controller.js';
import { atsRouter } from './hedera/ats.controller.js';
import { devLogsRouter } from './devtools/devlogs.controller.js';
import { paymentMiddleware } from '@x402/express';
import {
  buildX402Routes,
  createX402ResourceServer,
} from './x402/x402.middleware.js';
import { createLogger } from './common/logger.js';

dotenv.config();

const log = createLogger('http');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const FRONTEND_DIR = path.resolve(__dirname, '../frontend');

export const app: Express = express();

// Global Middlewares
app.use(cors());
app.use(express.json());

// Request log: one line per request. Decodes x402 challenge/settlement headers
// so the terminal shows the full payment story without any extra tooling.
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    const line = `${req.method} ${req.originalUrl.split('?')[0]} → ${res.statusCode} (${ms}ms)`;
    if (req.path === '/health') log.debug(line);
    else log.info(line);

    const challenge = res.getHeader('payment-required');
    if (typeof challenge === 'string') {
      try {
        const invoice = JSON.parse(Buffer.from(challenge, 'base64').toString());
        const req0 = invoice.accepts?.[0];
        log.info(`x402 402 challenge issued: ${req0?.amount ?? '?'} tinybars → ${req0?.payTo ?? '?'}`);
      } catch {
        log.warn('x402 challenge header could not be decoded');
      }
    }
    const settle = res.getHeader('payment-response');
    if (typeof settle === 'string') {
      try {
        const receipt = JSON.parse(Buffer.from(settle, 'base64').toString());
        if (receipt.success) {
          log.info(`x402 settled on-chain: tx ${receipt.transaction ?? '?'} · payer ${receipt.payer ?? '?'}`);
        } else {
          log.error(`x402 settlement FAILED: ${receipt.errorReason ?? receipt.errorMessage ?? 'unknown reason'}`);
        }
      } catch {
        log.warn('x402 settlement header could not be decoded');
      }
    }
  });
  next();
});

// Serve the new frontend at the root. The legacy dashboard remains available
// under /legacy (reference / rollback). `no-cache` forces revalidation on
// every load (still 304-efficient), so UI updates land with a normal reload.
app.use('/legacy', express.static(PUBLIC_DIR, {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));
app.use(express.static(FRONTEND_DIR, {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// x402 payment gate — protects POST /api/proposals and /api/buyer/smart-report.
// Fail fast with a clear message when the gate is misconfigured (bad network,
// missing pay-to wallet) instead of crashing with a stack trace mid-request.
let x402Routes: ReturnType<typeof buildX402Routes>;
let x402Server: ReturnType<typeof createX402ResourceServer>;
try {
  x402Routes = buildX402Routes();
  x402Server = createX402ResourceServer();
} catch (error) {
  log.error('x402 configuration error — refusing to start. Fix .env and relaunch.', error);
  process.exit(1);
}
app.use(paymentMiddleware(x402Routes, x402Server));


// Health Check Endpoint
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Mount Domain Routes
app.use('/api/proposals', proposalRouter);
app.use('/api/buyer', buyerRouter);
app.use('/api/matchmaking', buyerRouter); // Alias for compatibility with plan
app.use('/api/agent', agentRouter);
app.use('/api/graph', graphRouter); // Paid standalone graph analytics (x402)
app.use('/api/world', worldRouter); // World ID Selfie Check (Beta) verification
app.use('/api/ats', atsRouter); // ATS (factored-hedera sidecar) lifecycle test space
app.use('/api/dev', devLogsRouter); // Developer console: live server log tail

// Central error handler — logs the cause, returns clean JSON. Also converts
// body-parser's HTML error pages (e.g. malformed JSON) into API errors.
app.use((
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const err = error as { type?: string; message?: string };
  if (err?.type === 'entity.parse.failed') {
    log.warn(`Malformed JSON body on ${req.method} ${req.originalUrl}`);
    res.status(400).json({ error: 'Malformed JSON body' });
    return;
  }
  log.error(`Unhandled error on ${req.method} ${req.originalUrl}`, error);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});
