import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { InMemoryStore } from "../services/store.js";

export async function registerAuditRoutes(
  app: FastifyInstance,
  store: InMemoryStore,
) {
  app.get("/api/audit/:receivableId", async (request, reply) => {
    const params = z.object({ receivableId: z.string().min(1) }).parse(request.params);
    const receivable = store.getReceivable(params.receivableId);
    if (!receivable) return reply.code(404).send({ error: "RECEIVABLE_NOT_FOUND" });

    return {
      receivableId: receivable.id,
      source: "HCS",
      events: store.getAudit(receivable.id),
    };
  });
}
