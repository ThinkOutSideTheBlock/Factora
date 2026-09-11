import { app } from './app.js';
import { createLogger } from './common/logger.js';
import { getX402Network } from './x402/x402.middleware.js';
import { getAgentWallet } from './agent/payer.agent.js';

const log = createLogger('server');

const PORT = process.env.PORT || 3000;

export const server = app.listen(PORT, () => {
  const wallet = getAgentWallet();
  log.info(`Factora listening on http://localhost:${PORT}`);
  log.info(
    `x402: network=${getX402Network()} · agent wallet=${wallet ? wallet.accountId : 'NOT CONFIGURED (set HEDERA_AGENT_*)'}`,
  );
  log.info(`Underwriter LLM: model=${process.env.LLM_MODEL ?? 'not set'} · log level=${process.env.LOG_LEVEL ?? 'info'}`);
});

// Surface async failures that would otherwise die silently.
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection', reason);
});
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception — server state may be inconsistent', error);
});
