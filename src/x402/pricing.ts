/**
 * x402 pricing strategies.
 *
 * - Fixed: every proposal creation costs the same flat tinybar amount.
 * - Per-token: the smart report is priced from the client-declared `maxTokens`
 *   budget: price = baseFee + per1kTokensRate × ⌈maxTokens / 1000⌉.
 *
 * Pricing functions must be deterministic — the middleware re-runs them on the
 * paid retry, and both calls must produce the same amount. Actual usage-based
 * settlement (partial settlement of the real token count) needs the `upto`
 * scheme, which the Blocky402 facilitator does not yet advertise for Hedera;
 * once it does, this is the single file to change.
 */
import type { AssetAmount, Price } from '@x402/core/types';
import type { HTTPRequestContext } from '@x402/core/server';

/** Native HBAR, expressed as its HTS token id inside Hedera's x402 scheme. */
export const HBAR_ASSET = '0.0.0';

export const TINYBARS_PER_HBAR = 100_000_000;

export const PROPOSAL_FIXED_PRICE: AssetAmount = {
  asset: HBAR_ASSET,
  amount: process.env.PROPOSAL_PRICE_TINYBAR ?? '100000',
};

export interface SmartReportPricingConfig {
  /** Flat fee charged regardless of usage, in tinybars. */
  baseFeeTinybars: number;
  /** Price per 1,000 budgeted LLM tokens, in tinybars. */
  per1kTokensTinybars: number;
  /** Bounds a client may declare for `maxTokens`. */
  minTokens: number;
  maxTokens: number;
}

export function getSmartReportPricingConfig(): SmartReportPricingConfig {
  return {
    baseFeeTinybars: parseInt(process.env.SMART_REPORT_BASE_TINYBAR ?? '20000', 10),
    per1kTokensTinybars: parseInt(
      process.env.SMART_REPORT_PER_1K_TOKENS_TINYBAR ?? '10000',
      10,
    ),
    maxTokens: parseInt(process.env.SMART_REPORT_MAX_TOKENS ?? '2048', 10),
    minTokens: 256,
  };
}

export function computeBudgetedAmount(
  maxTokens: number,
  config: SmartReportPricingConfig = getSmartReportPricingConfig(),
): string {
  const tokens = Math.min(Math.max(maxTokens, config.minTokens), config.maxTokens);
  const thousands = Math.ceil(tokens / 1000);
  return String(config.baseFeeTinybars + thousands * config.per1kTokensTinybars);
}

/** DynamicPrice for the smart-report route; must return the same price for the same body. */
export function smartReportPrice(context: HTTPRequestContext): Price {
  const config = getSmartReportPricingConfig();
  let maxTokens = config.maxTokens;

  try {
    // The pricing middleware runs before zod validation, so clamp defensively.
    const body = context.adapter.getBody?.() as { maxTokens?: unknown } | undefined;
    if (body && typeof body.maxTokens === 'number' && Number.isFinite(body.maxTokens)) {
      maxTokens = Math.min(Math.max(Math.floor(body.maxTokens), config.minTokens), config.maxTokens);
    }
  } catch {
    // No parsed body → fall back to the default budget.
  }

  return { asset: HBAR_ASSET, amount: computeBudgetedAmount(maxTokens, config) };
}

