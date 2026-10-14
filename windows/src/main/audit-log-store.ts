import { randomUUID } from "node:crypto";
import { AuditLogEntry } from "../shared/contracts";
import { JsonFileStore } from "./json-file-store";

/**
 * Every command, file operation and registry read Clickaa attempts is recorded
 * here — whether the user approved it, refused it, or Clickaa itself blocked it.
 * The log is the answer to "what did that thing actually do on my pc?", so it is
 * written to disk and the panel shows it in full.
 */

const maximumStoredEntries = 500;
const maximumDetailLength = 4_000;
const maximumResultPreviewLength = 600;

function sanitizeAuditLogEntries(storedEntries: unknown): AuditLogEntry[] {
  if (!Array.isArray(storedEntries)) {
    return [];
  }

  const sanitizedEntries: AuditLogEntry[] = [];
  for (const possibleEntry of storedEntries) {
    if (!possibleEntry || typeof possibleEntry !== "object") {
      continue;
    }

    const entryRecord = possibleEntry as Partial<AuditLogEntry>;
    if (typeof entryRecord.summary !== "string" || !entryRecord.summary.trim()) {
      continue;
    }

    sanitizedEntries.push({
      id: typeof entryRecord.id === "string" && entryRecord.id ? entryRecord.id : randomUUID(),
      createdAtIso: typeof entryRecord.createdAtIso === "string"
        ? entryRecord.createdAtIso
        : new Date().toISOString(),
      summary: entryRecord.summary.slice(0, 200),
      detail: typeof entryRecord.detail === "string" ? entryRecord.detail.slice(0, maximumDetailLength) : "",
      tier: entryRecord.tier === "tier2" || entryRecord.tier === "blocked" ? entryRecord.tier : "tier1",
      outcome: entryRecord.outcome === "refused" || entryRecord.outcome === "blocked" || entryRecord.outcome === "failed"
        ? entryRecord.outcome
        : "allowed",
      resultPreview: typeof entryRecord.resultPreview === "string"
        ? entryRecord.resultPreview.slice(0, maximumResultPreviewLength)
        : "",
    });
  }

  return sanitizedEntries;
}

export class AuditLogStore {
  private readonly fileStore: JsonFileStore<AuditLogEntry[]>;
  private entries: AuditLogEntry[];

  constructor(filePath: string) {
    this.fileStore = new JsonFileStore(filePath, sanitizeAuditLogEntries);
    this.entries = this.fileStore.read();
  }

  /** Newest first, which is the order the panel shows them in. */
  list(limit = 50): AuditLogEntry[] {
    return this.entries.slice(0, Math.max(0, limit));
  }

  record(entry: Omit<AuditLogEntry, "id" | "createdAtIso">): AuditLogEntry {
    const createdEntry: AuditLogEntry = {
      ...entry,
      id: randomUUID(),
      createdAtIso: new Date().toISOString(),
    };
    this.entries = [createdEntry, ...this.entries].slice(0, maximumStoredEntries);
    this.persist();
    return createdEntry;
  }

  /** A compact count for the panel's heading, so the log is not a wall of text. */
  summarizeCounts(): { allowed: number; refused: number; blocked: number; failed: number; total: number } {
    const counts = { allowed: 0, refused: 0, blocked: 0, failed: 0, total: this.entries.length };
    for (const entry of this.entries) {
      counts[entry.outcome] += 1;
    }
    return counts;
  }

  clear(): void {
    this.entries = [];
    this.persist();
  }

  private persist(): void {
    this.fileStore.write(this.entries);
  }
}
