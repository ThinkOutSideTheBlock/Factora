/**
 * Simple in-memory store for hackathon development and testing.
 *
 * 
 * 
 */

type Trade = {
    id: string;
    mandateDecision: "ALLOW" | "ESCALATE" | "DENY";
    status: "PENDING" | "AUTHORIZED" | "EXECUTED";
    authorizationId?: string;
    receivableId: string;
};

const trades = new Map<string, Trade>();

// Tracks nullifiers that have already been used.
const nullifiers = new Set<string>();

export const store = {
    /**
     * Creates a dummy trade requiring escalation.
     * Intended for testing the authorization flow.
     */
    createEscalationTrade(id: string) {
        const trade: Trade = {
            id,
            mandateDecision: "ESCALATE",
            status: "PENDING",
            receivableId: `recv-${id}`,
        };

        trades.set(id, trade);
        return trade;
    },

    /**
     * Retrieves a trade by its ID.
     */
    getTrade(id: string) {
        return trades.get(id);
    },

    /**
     * Updates an existing trade with the provided fields.
     * Returns null if the trade does not exist.
     */
    updateTrade(id: string, data: Partial<Trade>) {
        const trade = trades.get(id);

        if (!trade) return null;

        const updated = { ...trade, ...data };
        trades.set(id, updated);

        return updated;
    },

    /**
     * Checks whether a nullifier has already been recorded.
     */
    hasNullifier(nullifier: string) {
        return nullifiers.has(nullifier);
    },

    /**
     * Records a nullifier as used.
     */
    recordNullifier(nullifier: string) {
        nullifiers.add(nullifier);
    },

    /**
     * Adds an audit event.
     * Currently, events are only logged to the console.
     */
    addAudit(_receivableId: string, _event: any) {
        console.log("AUDIT:", _event);
    },
};
