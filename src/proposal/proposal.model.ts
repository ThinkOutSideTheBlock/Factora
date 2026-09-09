import { z } from "zod";

export const ProposalStatusEnum = z.enum(["PENDING", "ACCEPTED"]);
export type ProposalStatus = z.infer<typeof ProposalStatusEnum>;

export const CreateProposalSchema = z
    .object({
        proposerAddress: z
            .string()
            .trim()
            .min(1, "Proposer address is required"),
        amount: z.number().positive("Nominal amount must be greater than 0"),
        requiredAmount: z
            .number()
            .positive("Required amount must be greater than 0"),
        returnDateInDays: z
            .number()
            .int()
            .positive("Return date in days must be a positive integer"),
    })
    .refine((data) => data.requiredAmount < data.amount, {
        message:
            "Required amount must be strictly less than nominal amount to provide a positive yield",
        path: ["requiredAmount"],
    });

export type CreateProposalDto = z.infer<typeof CreateProposalSchema>;

export interface Proposal {
    id: string;
    proposerAddress: string;
    amount: number;
    requiredAmount: number;
    returnDateInDays: number;
    apy: number;
    status: ProposalStatus;
    createdAt: string;
}
