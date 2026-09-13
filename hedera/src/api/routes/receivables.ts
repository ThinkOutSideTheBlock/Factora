import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { InMemoryStore } from "../services/store.js";

const createSchema = z.object({
  debtor: z.object({ name: z.string().min(1) }),
  faceValueUsd: z.number().positive(),
  maturityTimestamp: z.number().int().positive(),
  supplierAccountId: z.string().min(1),
  minimumProceedsUsd: z.number().positive(),
  maximumDiscountBps: z.number().int().min(0).max(10_000).optional(),
  documents: z.object({ invoiceHash: z.string().min(1) }).optional(),
});

export async function registerReceivableRoutes(
  app: FastifyInstance,
  store: InMemoryStore,
) {
  app.post("/api/receivables", async (request, reply) => {
    const body = createSchema.parse(request.body);
    const id = `REC-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    if (body.maturityTimestamp <= Math.floor(Date.now() / 1000)) {
      return reply.code(422).send({ error: "MATURITY_MUST_BE_IN_FUTURE" });
    }
    if (body.minimumProceedsUsd > body.faceValueUsd) {
      return reply.code(422).send({ error: "MINIMUM_PROCEEDS_EXCEEDS_FACE_VALUE" });
    }

    const receivable = {
      id,
      supplierAccountId: body.supplierAccountId,
      debtorName: body.debtor.name,
      faceValueUsd: body.faceValueUsd,
      minimumProceedsUsd: body.minimumProceedsUsd,
      maximumDiscountBps: body.maximumDiscountBps,
      maturityTimestamp: body.maturityTimestamp,
      invoiceHash: body.documents?.invoiceHash,
      status: "LISTED" as const,
    };

    store.putReceivable(receivable);
    store.addAudit(id, { type: "RECEIVABLE_REGISTERED", timestamp: Date.now() });

    return reply.code(201).send(receivable);
  });

  app.get("/api/receivables", async (request) => {
    const query = z.object({
      status: z.enum([
        "LISTED",
        "UNDERWRITING",
        "NEGOTIATING",
        "APPROVED",
        "TOKENIZED",
        "FUNDED",
        "TRANSFERABLE",
        "MATURED",
        "DEFAULTED",
        "REDEEMED",
      ]).optional(),
    }).parse(request.query);

    return store.listReceivables(query.status);
  });

  app.get("/api/receivables/:id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const receivable = store.getReceivable(params.id);
    if (!receivable) return reply.code(404).send({ error: "RECEIVABLE_NOT_FOUND" });
    return receivable;
  });
}
