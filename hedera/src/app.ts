import Fastify from "fastify";
import { InMemoryStore } from "./api/services/store.js";
import { registerRoutes } from "./api/routes/index.js";

export function buildApp() {
  const app = Fastify({ logger: false });
  const store = new InMemoryStore();

  app.get("/health", async () => ({
    ok: true,
    service: "factored-hedera",
  }));

  app.register(async (instance) => {
    await registerRoutes(instance, store);
  });

  return app;
}
