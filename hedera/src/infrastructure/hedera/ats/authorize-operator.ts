import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import {
    assertATSInitialized,
    registerAtsSigner,
    registerOperatorSigner,
} from "./ats.js";

const require = createRequire(import.meta.url);
const sdkRoot = dirname(require.resolve("@hashgraph/asset-tokenization-sdk"));
const Injectable = require(join(sdkRoot, "core/injectable/Injectable.js")).default;
const { RPCTransactionAdapter } = require(
    join(sdkRoot, "port/out/rpc/RPCTransactionAdapter.js"),
);

/** Low-level: ATS signer must already be the supplier. */
export async function authorizeOperatorAsSupplier(
    securityEvm: string,
    operatorEvm: string,
): Promise<unknown> {
    assertATSInitialized();
    const adapter = Injectable.resolve(RPCTransactionAdapter);
    return adapter.authorizeOperator(securityEvm, operatorEvm);
}

/**
 * Low-level, partition-scoped variant (IOperatorByPartition). The ATS
 * ClearingByPartitionFacet enforces this for operator-from transfers, so the
 * global authorizeOperator alone is NOT sufficient for settlement clearing.
 * ATS signer must already be the supplier.
 */
export async function authorizeOperatorByPartitionAsSupplier(
    securityEvm: string,
    operatorEvm: string,
    partitionId: string,
): Promise<unknown> {
    assertATSInitialized();
    const adapter = Injectable.resolve(RPCTransactionAdapter);
    return adapter.authorizeOperatorByPartition(
        securityEvm,
        operatorEvm,
        partitionId,
    );
}

export class SupplierNotAuthorizedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SupplierNotAuthorizedError";
    }
}

/** Custodial (A): supplier key in env/agent — once per (supplier, security). */
export async function authorizeOperatorForSecurity(input: {
    securityEvm: string;
    operatorEvm: string;
    supplierAccountId: string;
    supplierPrivateKey: string;
}): Promise<{ transactionId?: string; raw: unknown }> {
    assertATSInitialized();
    if (!input.supplierPrivateKey) {
        throw new SupplierNotAuthorizedError(
            "supplierPrivateKey is required to sign authorizeOperator",
        );
    }

    await registerAtsSigner(input.supplierAccountId, input.supplierPrivateKey);
    try {
        const raw = await authorizeOperatorAsSupplier(
            input.securityEvm,
            input.operatorEvm,
        );
        const transactionId =
            (raw as any)?.id ?? (raw as any)?.transactionId;
        return { transactionId, raw };
    } finally {
        await registerOperatorSigner();
    }
}

export async function authorizeOperatorFromEnv(input: {
    securityEvm: string;
    operatorEvm: string;
    supplierAccountId: string;
}) {
    const key =
        process.env.TEST_SUPPLIER_PRIVATE_KEY ||
        process.env.SUPPLIER_PRIVATE_KEY ||
        "";
    if (!key) {
        throw new SupplierNotAuthorizedError(
            "Set TEST_SUPPLIER_PRIVATE_KEY for custodial authorizeOperator",
        );
    }
    return authorizeOperatorForSecurity({ ...input, supplierPrivateKey: key });
}

/**
 * Partition-scoped variant: the supplier authorizes the operator to act for
 * them within `partitionId` (needed by operator-from clearing).
 */
export async function authorizeOperatorForPartition(input: {
    securityEvm: string;
    operatorEvm: string;
    partitionId: string;
    supplierAccountId: string;
    supplierPrivateKey: string;
}): Promise<{ transactionId?: string; raw: unknown }> {
    assertATSInitialized();
    if (!input.supplierPrivateKey) {
        throw new SupplierNotAuthorizedError(
            "supplierPrivateKey is required to sign authorizeOperatorByPartition",
        );
    }

    await registerAtsSigner(input.supplierAccountId, input.supplierPrivateKey);
    try {
        const raw = await authorizeOperatorByPartitionAsSupplier(
            input.securityEvm,
            input.operatorEvm,
            input.partitionId,
        );
        const transactionId =
            (raw as any)?.id ?? (raw as any)?.transactionId;
        return { transactionId, raw };
    } finally {
        await registerOperatorSigner();
    }
}

export async function authorizeOperatorForPartitionFromEnv(input: {
    securityEvm: string;
    operatorEvm: string;
    partitionId: string;
    supplierAccountId: string;
}) {
    const key =
        process.env.TEST_SUPPLIER_PRIVATE_KEY ||
        process.env.SUPPLIER_PRIVATE_KEY ||
        "";
    if (!key) {
        throw new SupplierNotAuthorizedError(
            "Set TEST_SUPPLIER_PRIVATE_KEY for custodial authorizeOperatorByPartition",
        );
    }
    return authorizeOperatorForPartition({
        ...input,
        supplierPrivateKey: key,
    });
}