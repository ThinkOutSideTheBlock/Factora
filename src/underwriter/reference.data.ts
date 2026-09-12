import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../common/logger.js";

const log = createLogger("underwriter-reference");
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REFERENCE_FILE_PATH = path.resolve(
    __dirname,
    "../../database/underwriter-reference.json",
);

export async function loadUnderwriterReferenceData(): Promise<unknown | null> {
    try {
        const raw = await fs.readFile(REFERENCE_FILE_PATH, "utf-8");
        const data = JSON.parse(raw) as {
            datasetStatus?: string;
            isRealTime?: boolean;
        };
        if (
            data.datasetStatus !== "SAMPLE_MVP_ONLY" ||
            data.isRealTime !== false
        ) {
            log.warn(
                "Reference data does not carry the expected sample-only safeguards",
            );
        }
        return data;
    } catch (error) {
        log.warn(
            "Unable to load sample underwriter reference data; continuing without it",
            error,
        );
        return null;
    }
}
