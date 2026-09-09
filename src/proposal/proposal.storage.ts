import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Proposal } from "./proposal.model.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE_PATH = path.resolve(__dirname, "../../database/proposals.json");

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
        return JSON.parse(rawData) as Proposal[];
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
