import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    daysBetween,
    DebtDocument,
    DebtDocumentInput,
    Proposal,
    UnderwritingReview,
} from "./proposal.model.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE_PATH = path.resolve(__dirname, "../../database/proposals.json");

function legacyDebtDocument(proposal: Record<string, unknown>): DebtDocument {
    const createdAt =
        typeof proposal.createdAt === "string"
            ? proposal.createdAt
            : new Date().toISOString();
    const duration =
        typeof proposal.returnDateInDays === "number"
            ? proposal.returnDateInDays
            : 30;
    const dueDate = new Date(
        new Date(createdAt).getTime() + duration * 86_400_000,
    )
        .toISOString()
        .slice(0, 10);

    return {
        debtType: "OTHER",
        industry: "UNKNOWN",
        debtorCompany: "Unknown debtor",
        invoiceNumber: `LEGACY-${String(proposal.id ?? "unknown").slice(0, 8)}`,
        invoiceDate: createdAt.slice(0, 10),
        dueDate,
        faceValue: typeof proposal.amount === "number" ? proposal.amount : 1,
        currency: "USD",
        disputeStatus: "UNKNOWN",
        paymentTermsDays: duration,
    };
}

function pendingReview(): UnderwritingReview {
    return {
        status: "PENDING",
        collectionConfidenceScore: 0,
        riskLevel: "UNKNOWN",
        debtQuality: "UNKNOWN",
        underwriterComment:
            "Debt document review is pending; no positive credit conclusion has been made.",
        keyRisks: ["No completed AI underwriting review is stored."],
        missingEvidence: [
            "Original debt document and verified debtor evidence.",
        ],
        reviewedAt: null,
        model: null,
    };
}

export function normalizeProposal(raw: Record<string, unknown>): Proposal {
    const rawDocument = raw.debtDocument as
        | (DebtDocumentInput & { paymentTermsDays?: number })
        | undefined;
    const debtDocument = rawDocument ?? legacyDebtDocument(raw);

    // Payment terms are server-derived (invoice → due); backfill for records
    // written before the unified model, falling back to the proposal duration.
    let paymentTermsDays = rawDocument?.paymentTermsDays;
    if (typeof paymentTermsDays !== "number" || paymentTermsDays <= 0) {
        const fromDates =
            debtDocument.invoiceDate && debtDocument.dueDate
                ? daysBetween(debtDocument.invoiceDate, debtDocument.dueDate)
                : 0;
        paymentTermsDays =
            fromDates > 0
                ? fromDates
                : typeof raw.returnDateInDays === "number"
                  ? raw.returnDateInDays
                  : 30;
    }

    return {
        ...(raw as Omit<Proposal, "debtDocument" | "underwritingReview">),
        debtDocument: { ...debtDocument, paymentTermsDays },
        underwritingReview:
            (raw.underwritingReview as UnderwritingReview | undefined) ??
            pendingReview(),
    } as Proposal;
}

/**
 * Ensure storage directory and file exist.
 */
async function ensureStorageFile(): Promise<void> {
    try {
        await fs.access(DATA_FILE_PATH);
    } catch {
        const dir = path.dirname(DATA_FILE_PATH);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
            DATA_FILE_PATH,
            JSON.stringify([], null, 2),
            "utf-8",
        );
    }
}

/**
 * Read all proposals from the JSON storage file.
 */
export async function getAllProposals(): Promise<Proposal[]> {
    await ensureStorageFile();
    try {
        const rawData = await fs.readFile(DATA_FILE_PATH, "utf-8");
        if (!rawData.trim()) {
            return [];
        }
        const parsed = JSON.parse(rawData) as Record<string, unknown>[];
        return parsed.map(normalizeProposal);
    } catch (error) {
        console.error("Error reading proposals storage:", error);
        return [];
    }
}

/**
 * Save all proposals to the JSON storage file.
 */
export async function saveProposals(proposals: Proposal[]): Promise<void> {
    await ensureStorageFile();
    const serialized = JSON.stringify(proposals, null, 2);
    await fs.writeFile(DATA_FILE_PATH, serialized, "utf-8");
}

/**
 * Append a new proposal to the storage.
 */
export async function addProposal(proposal: Proposal): Promise<Proposal> {
    const proposals = await getAllProposals();
    proposals.push(proposal);
    await saveProposals(proposals);
    return proposal;
}
