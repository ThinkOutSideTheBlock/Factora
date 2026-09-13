/**
 * JSON file storage for ATS registrations, mirroring proposal.storage.ts
 * conventions (single JSON file under database/, self-healing on first use).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AtsRegistration } from "./ats.model.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE_PATH = path.resolve(
    __dirname,
    "../../database/ats-registrations.json",
);

/**
 * Ensure storage directory and file exist.
 */
async function ensureStorageFile(): Promise<void> {
    try {
        await fs.access(DATA_FILE_PATH);
    } catch {
        const dir = path.dirname(DATA_FILE_PATH);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(DATA_FILE_PATH, JSON.stringify([], null, 2), "utf-8");
    }
}

/**
 * Read all ATS registrations from the JSON storage file.
 */
export async function getAtsRegistrations(): Promise<AtsRegistration[]> {
    await ensureStorageFile();
    try {
        const rawData = await fs.readFile(DATA_FILE_PATH, "utf-8");
        if (!rawData.trim()) {
            return [];
        }
        return JSON.parse(rawData) as AtsRegistration[];
    } catch (error) {
        console.error("Error reading ATS registrations storage:", error);
        return [];
    }
}

/**
 * Persist the full registration list.
 */
async function saveAtsRegistrations(
    registrations: AtsRegistration[],
): Promise<void> {
    await ensureStorageFile();
    await fs.writeFile(
        DATA_FILE_PATH,
        JSON.stringify(registrations, null, 2),
        "utf-8",
    );
}

/**
 * Append a new ATS registration to the storage.
 */
export async function addAtsRegistration(
    registration: AtsRegistration,
): Promise<AtsRegistration> {
    const registrations = await getAtsRegistrations();
    registrations.push(registration);
    await saveAtsRegistrations(registrations);
    return registration;
}

/**
 * Find the registration linked to a proposal, if any. Registrations are
 * append-only; the LATEST one is authoritative (older duplicates can exist
 * from re-registrations).
 */
export async function findAtsRegistrationByProposalId(
    proposalId: string,
): Promise<AtsRegistration | undefined> {
    const registrations = await getAtsRegistrations();
    for (let i = registrations.length - 1; i >= 0; i--) {
        if (registrations[i].proposalId === proposalId) {
            return registrations[i];
        }
    }
    return undefined;
}

/**
 * Patch a registration in place (used by later lifecycle steps).
 */
export async function updateAtsRegistration(
    id: string,
    patch: Partial<AtsRegistration>,
): Promise<AtsRegistration> {
    const registrations = await getAtsRegistrations();
    const index = registrations.findIndex((r) => r.id === id);
    if (index === -1) {
        throw new Error(`ATS registration not found: ${id}`);
    }
    registrations[index] = { ...registrations[index], ...patch };
    await saveAtsRegistrations(registrations);
    return registrations[index];
}
