import { describe, expect, it } from "vitest";
import { rankMatchResults } from "../buyer.service.js";
import {
    AgentMatchResultSchema,
    UnderwriterAnalysisResponseSchema,
} from "../../underwriter/underwriter.model.js";

function item(id: string, apy: number, amount: number, fitScore: number) {
    return {
        proposal: { id, apy, amount },
        evaluation: { fitScore },
    };
}

describe("rankMatchResults", () => {
    it("orders by fitScore descending", () => {
        const ranked = rankMatchResults([
            item("a", 10, 1000, 40),
            item("b", 12, 1000, 90),
            item("c", 11, 1000, 65),
        ]);
        expect(ranked.map((r) => r.proposal.id)).toEqual(["b", "c", "a"]);
    });

    it("breaks fitScore ties by APY, then by nominal amount", () => {
        const ranked = rankMatchResults([
            item("low-apy-small", 10, 1000, 70),
            item("high-apy", 20, 1000, 70),
            item("high-apy-big", 20, 5000, 70),
            item("mid", 15, 3000, 70),
        ]);
        expect(ranked.map((r) => r.proposal.id)).toEqual([
            "high-apy-big",
            "high-apy",
            "mid",
            "low-apy-small",
        ]);
    });

    it("does not mutate the input array", () => {
        const input = [item("a", 10, 1000, 40), item("b", 12, 1000, 90)];
        rankMatchResults(input);
        expect(input.map((r) => r.proposal.id)).toEqual(["a", "b"]);
    });
});

describe("AgentMatchResultSchema score robustness", () => {
    const debtAnalysis = {
        status: "COMPLETED",
        collectionConfidenceScore: "72",
        riskLevel: "MEDIUM",
        debtQuality: "B",
        underwriterComment: "ok",
        keyRisks: [],
        missingEvidence: [],
    };

    it("coerces string fitScores and clamps out-of-range values", () => {
        const parsed = AgentMatchResultSchema.parse({
            proposalId: "p1",
            fitScore: "85",
            riskLevel: "LOW",
            recommendation: "fine",
            debtAnalysis,
        });
        expect(parsed.fitScore).toBe(85);
        expect(parsed.debtAnalysis.collectionConfidenceScore).toBe(72);

        const clamped = AgentMatchResultSchema.parse({
            proposalId: "p2",
            fitScore: "250",
            riskLevel: "HIGH",
            recommendation: "over",
            debtAnalysis: { ...debtAnalysis, collectionConfidenceScore: -5 },
        });
        expect(clamped.fitScore).toBe(100);
        expect(clamped.debtAnalysis.collectionConfidenceScore).toBe(0);
    });

    it("keeps the parsed evaluation set intact for the response schema", () => {
        const response = UnderwriterAnalysisResponseSchema.parse({
            overallSummary: "ok",
            evaluations: [
                {
                    proposalId: "p1",
                    fitScore: "60",
                    riskLevel: "MEDIUM",
                    recommendation: "r",
                    debtAnalysis,
                },
            ],
        });
        expect(response.evaluations[0].fitScore).toBe(60);
    });
});