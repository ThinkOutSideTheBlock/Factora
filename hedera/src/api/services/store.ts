import type { Receivable } from "../../domain/types.js";

export interface Offer {
  id: string;
  receivableId: string;
  from: string;
  to?: string;
  priceUsd: number;
  createdAt: number;
  status: "PENDING" | "ACCEPTED" | "REJECTED" | "COUNTERED";
}

export class InMemoryStore {
  private readonly receivables = new Map<string, Receivable>();
  private readonly offers = new Map<string, Offer[]>();
  private readonly audit = new Map<string, unknown[]>();

  putReceivable(receivable: Receivable): void {
    this.receivables.set(receivable.id, receivable);
  }

  getReceivable(id: string): Receivable | undefined {
    return this.receivables.get(id);
  }

  listReceivables(status?: Receivable["status"]): Receivable[] {
    const values = [...this.receivables.values()];
    return status ? values.filter((item) => item.status === status) : values;
  }

  updateReceivable(id: string, patch: Partial<Receivable>): Receivable {
    const current = this.receivables.get(id);
    if (!current) throw new Error("RECEIVABLE_NOT_FOUND");
    const next = { ...current, ...patch };
    this.receivables.set(id, next);
    return next;
  }

  addOffer(offer: Offer): void {
    const list = this.offers.get(offer.receivableId) ?? [];
    list.push(offer);
    this.offers.set(offer.receivableId, list);
  }

  getOffers(receivableId: string): Offer[] {
    return [...(this.offers.get(receivableId) ?? [])];
  }

  addAudit(receivableId: string, event: unknown): void {
    const list = this.audit.get(receivableId) ?? [];
    list.push(event);
    this.audit.set(receivableId, list);
  }

  getAudit(receivableId: string): unknown[] {
    return [...(this.audit.get(receivableId) ?? [])];
  }
}
