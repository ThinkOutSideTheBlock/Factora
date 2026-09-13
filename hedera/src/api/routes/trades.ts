import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { InMemoryStore } from "../services/store.js";

const offerSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1).optional(),
  priceUsd: z.number().positive(),
  status: z.enum(["PENDING", "ACCEPTED", "REJECTED", "COUNTERED"]).default("PENDING"),
});

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

export async function registerTradeRoutes(
  app: FastifyInstance,
  store: InMemoryStore,
) {
  app.post("/api/receivables/:id/offers", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = offerSchema.parse(request.body);
    const receivable = store.getReceivable(params.id);
    if (!receivable) return reply.code(404).send({ error: "RECEIVABLE_NOT_FOUND" });

    const offer = {
      id: generateId("OFFER"),
      receivableId: params.id,
      ...body,
      createdAt: Date.now(),
    };

    store.addOffer(offer);
    store.addAudit(params.id, offer);

    return reply.code(201).send(offer);
  });

  app.get("/api/receivables/:id/offers", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    if (!store.getReceivable(params.id)) {
      return reply.code(404).send({ error: "RECEIVABLE_NOT_FOUND" });
    }
    return store.getOffers(params.id);
  });

  app.post("/api/receivables/:id/underwriting", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const receivable = store.getReceivable(params.id);
    if (!receivable) return reply.code(404).send({ error: "RECEIVABLE_NOT_FOUND" });

    const result = {
      receivableId: receivable.id,
      riskGrade: receivable.riskGrade ?? "UNRATED",
      maxPurchasePriceUsd: receivable.maxPurchasePriceUsd ?? receivable.faceValueUsd * 0.968,
      analysisReference: `local:${receivable.id}:${Date.now()}`,
      status: "UNDERWRITING" as const,
    };

    store.updateReceivable(receivable.id, {
      riskGrade: result.riskGrade === "UNRATED" ? undefined : result.riskGrade,
      maxPurchasePriceUsd: result.maxPurchasePriceUsd,
      underwritingReference: result.analysisReference,
      status: "UNDERWRITING",
    });
    store.addAudit(receivable.id, { type: "UNDERWRITING_COMPLETED", ...result });

    return result;
  });
}
