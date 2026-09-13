import type { FastifyInstance } from "fastify";
import { InMemoryStore } from "../services/store.js";
import { registerReceivableRoutes } from "./receivables.js";
import { registerTradeRoutes } from "./trades.js";
import { registerMaturityRoutes } from "./maturity.js";
import { registerAuditRoutes } from "./audit.js";
import { registerAgentHederaRoutes } from "./agent-hedera.js";

export async function registerRoutes(app: FastifyInstance, store: InMemoryStore) {
  await registerReceivableRoutes(app, store);
  await registerTradeRoutes(app, store);
  await registerMaturityRoutes(app, store);
  await registerAuditRoutes(app, store);
  await registerAgentHederaRoutes(app, store);
}