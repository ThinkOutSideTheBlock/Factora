import { BuyerSearchRequest } from "../buyer/buyer.model.js";
import { GraphMarketData } from "../graph/graph-feed.mock.js";
import { Proposal } from "../proposal/proposal.model.js";

export const UNDERWRITER_SYSTEM_PROMPT = `You are ClaimFlow's debt-underwriting analyst. Assess each candidate proposal for the given buyer requirements and market benchmark. Use only the supplied data; do not invent credit history, collateral, or external facts.

Return only a valid JSON object with this exact shape:
{
  "overallSummary": "short portfolio-level comment for this buyer",
  "evaluations": [
    {
      "proposalId": "proposal id from the input",
      "fitScore": 0,
      "riskLevel": "LOW | MEDIUM | HIGH",
      "recommendation": "concise comment for this proposal"
    }
  ]
}

Include exactly one evaluation for every candidate and no other proposal IDs. fitScore must be an integer from 0 through 100. Base the fit on APY relative to the buyer's minimum and market APY, maturity relative to the buyer's range, amount relative to the buyer's range, benchmark default rate, and liquidity index. Higher risk must not receive a stronger recommendation without a clear yield-based reason.`;

/** Builds the underwriting task payload; it does not call the model. */
export function buildUnderwriterPrompt(
    buyerRequirements: BuyerSearchRequest,
    candidates: Proposal[],
    marketData: GraphMarketData,
): string {
    return JSON.stringify(
        {
            buyerRequirements,
            marketData,
            candidateProposals: candidates,
        },
        null,
        2,
    );
}
