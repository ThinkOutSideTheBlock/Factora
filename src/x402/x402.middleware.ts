/**
 * x402 payment gate: Hedera "exact" scheme settled through the Blocky402 facilitator.
 *
 * Flow: unpaid request → 402 + PAYMENT-REQUIRED invoice → client signs a Hedera
 * TransferTransaction → retry with X-PAYMENT → facilitator verifies, co-signs as
 * fee payer and settles on-chain → handler runs, response carries PAYMENT-RESPONSE.
 */
import { HTTPFacilitatorClient, x402ResourceServer, type RoutesConfig } from '@x402/core/server';
import { ExactHederaScheme } from '@x402/hedera/exact/server';
import type { Network } from '@x402/core/types';
import { PROPOSAL_FIXED_PRICE, smartReportPrice } from './pricing.js';

const SUPPORTED_NETWORKS = ['hedera:testnet', 'hedera:mainnet'] as const;
export type HederaX402Network = (typeof SUPPORTED_NETWORKS)[number];

const DEFAULT_FACILITATOR_URLS: Record<HederaX402Network, string> = {
  'hedera:testnet': 'https://api.testnet.blocky402.com',
  'hedera:mainnet': 'https://api.blocky402.com',
};

interface X402Config {
  network: HederaX402Network;
  facilitatorUrl: string;
}

let cachedConfig: X402Config | null = null;

// Resolved lazily (ESM imports run before dotenv.config() in app.ts).
function resolveX402Config(): X402Config {
  if (cachedConfig) return cachedConfig;

  const rawNetwork = process.env.X402_NETWORK ?? 'hedera:testnet';
  if (!SUPPORTED_NETWORKS.includes(rawNetwork as HederaX402Network)) {
    throw new Error(
      `Unsupported X402_NETWORK "${rawNetwork}". Supported values: ${SUPPORTED_NETWORKS.join(', ')}`,
    );
  }
  const network = rawNetwork as HederaX402Network;

  cachedConfig = {
    network,
    // Derived from the network unless explicitly overridden, so a testnet
    // challenge can never be settled on mainnet or vice versa.
    facilitatorUrl:
      process.env.X402_FACILITATOR_URL ?? DEFAULT_FACILITATOR_URLS[network],
  };
  return cachedConfig;
}

export function getX402Network(): HederaX402Network {
  return resolveX402Config().network;
}

/** Receiving account per network — no private key needed on the server side. */
export function getPayToAddress(): string {
  const { network } = resolveX402Config();

  if (network === 'hedera:mainnet') {
    const payTo = process.env.HEDERA_SERVICE_ACCOUNT_ID_MAINNET;
    if (!payTo) {
      throw new Error(
        'HEDERA_SERVICE_ACCOUNT_ID_MAINNET is required when X402_NETWORK=hedera:mainnet — ' +
          'mainnet settlements transfer REAL HBAR, so the pay-to wallet must be explicit.',
      );
    }
    return payTo;
  }

  const payTo = process.env.HEDERA_SERVICE_ACCOUNT_ID;
  if (!payTo) {
    throw new Error(
      'HEDERA_SERVICE_ACCOUNT_ID is required in .env — create a Hedera testnet ' +
        'account at https://portal.hedera.com and put its account id (0.0.xxxxx) there.',
    );
  }
  return payTo;
}

/** x402 resource server delegating verification/settlement to the facilitator. */
export function createX402ResourceServer(): x402ResourceServer {
  const { facilitatorUrl } = resolveX402Config();
  const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

  return new x402ResourceServer(facilitatorClient)
    .register('hedera:*', new ExactHederaScheme({}));
}

/** Route price map for paymentMiddleware; price may be a static amount or a DynamicPrice. */
export function buildX402Routes(): RoutesConfig {
  const payTo = getPayToAddress();
  const network: Network = getX402Network();

  const fixedHederaAccept = {
    scheme: 'exact' as const,
    price: PROPOSAL_FIXED_PRICE,
    network,
    payTo,
  };

  const meteredHederaAccept = {
    scheme: 'exact' as const,
    price: smartReportPrice,
    network,
    payTo,
  };

  return {
    'POST /api/proposals': {
      accepts: [fixedHederaAccept],
      description: 'Create a debt proposal in the Factora pool',
      mimeType: 'application/json',
    },
    'POST /api/buyer/smart-report': {
      accepts: [meteredHederaAccept],
      description: 'AI Underwriter smart report — priced per declared token budget',
      mimeType: 'application/json',
    },
  };
}

