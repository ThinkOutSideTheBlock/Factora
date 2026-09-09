import { z } from "zod";
import { Proposal } from "../proposal/proposal.model.js";
import { AgentMatchResult } from "../underwriter/underwriter.model.js";
import { GraphMarketData } from "../graph/graph-feed.mock.js";

export const BuyerSearchSchema = z
    .object({
        amountMin: z.number().positive("amountMin must be a positive number"),
        amountMax: z.number().positive("amountMax must be a positive number"),
        durationInDaysMin: z
            .number()
            .int()
            .positive("durationInDaysMin must be a positive integer"),
        durationInDaysMax: z
            .number()
            .int()
            .positive("durationInDaysMax must be a positive integer"),
        apyInPercentMin: z
            .number()
            .min(0, "apyInPercentMin cannot be negative"),
    })
    .refine((data) => data.amountMin <= data.amountMax, {
        message: "amountMin cannot be greater than amountMax",
        path: ["amountMin"],
    })
    .refine((data) => data.durationInDaysMin <= data.durationInDaysMax, {
        message: "durationInDaysMin cannot be greater than durationInDaysMax",
        path: ["durationInDaysMin"],
    });

export type BuyerSearchRequest = z.infer<typeof BuyerSearchSchema>;

export interface MatchmakingResultItem {
    proposal: Proposal;
    evaluation: AgentMatchResult;
}

export interface BuyerMatchResponse {
    count: number;
    proposals: Proposal[];
}

export interface BuyerSearchResponse {
    count: number;
    overallSummary: string;
    marketBenchmark: GraphMarketData;
    results: MatchmakingResultItem[];
}
