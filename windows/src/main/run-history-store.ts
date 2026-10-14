import { randomUUID } from "node:crypto";
import { RunHistoryEntry, RunHistorySearchResult } from "../shared/contracts";
import { JsonFileStore } from "./json-file-store";
import { scoreTextMatch } from "./text-matching";

/**
 * What Ustaad has actually done, in plain files.
 *
 * Every interaction ends up here: what was asked, how it was answered, whether
 * it finished, and how many steps it took. It is a JSON file the user can open,
 * read, copy or delete like any other, and it is what "what did you do
 * yesterday?" is answered from — the audit log says what was touched, this says
 * what was asked for.
 *
 * Search is deliberately not a database. A run history is a few hundred short
 * entries, so scoring them in memory is instant on the low-spec machines this
 * has to run on, and it keeps the file readable and the app dependency-free.
 */

const maximumStoredRunCount = 300;
const maximumRequestLength = 300;
const maximumNoteLength = 300;
const maximumResponseLength = 800;
const maximumSnippetLength = 220;
const defaultSearchResultLimit = 20;

export interface RunHistoryDraft {
  request: string;
  kind: RunHistoryEntry["kind"];
  outcome: RunHistoryEntry["outcome"];
  note: string;
  stepsTaken: number;
  response: string;
  createdAtIso?: string;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maximumLength: number): string {
  const collapsed = collapseWhitespace(text);
  return collapsed.length > maximumLength ? `${collapsed.slice(0, maximumLength - 1)}…` : collapsed;
}

function sanitizeRunHistoryEntries(storedValue: unknown): RunHistoryEntry[] {
  if (!Array.isArray(storedValue)) {
    return [];
  }

  const sanitizedEntries: RunHistoryEntry[] = [];
  for (const storedEntry of storedValue) {
    if (!storedEntry || typeof storedEntry !== "object") {
      continue;
    }

    const possibleEntry = storedEntry as Partial<RunHistoryEntry>;
    if (typeof possibleEntry.request !== "string" || !possibleEntry.request.trim()) {
      continue;
    }

    sanitizedEntries.push({
      id: typeof possibleEntry.id === "string" && possibleEntry.id ? possibleEntry.id : randomUUID(),
      createdAtIso: typeof possibleEntry.createdAtIso === "string"
        ? possibleEntry.createdAtIso
        : new Date().toISOString(),
      request: truncate(possibleEntry.request, maximumRequestLength),
      kind: possibleEntry.kind === "task" || possibleEntry.kind === "routine" || possibleEntry.kind === "check-in"
        ? possibleEntry.kind
        : "reply",
      outcome: possibleEntry.outcome === "gave_up"
        || possibleEntry.outcome === "ran_out_of_steps"
        || possibleEntry.outcome === "ran_out_of_time"
        || possibleEntry.outcome === "stopped"
        || possibleEntry.outcome === "failed"
        ? possibleEntry.outcome
        : "completed",
      note: typeof possibleEntry.note === "string" ? truncate(possibleEntry.note, maximumNoteLength) : "",
      stepsTaken: Number.isFinite(possibleEntry.stepsTaken) ? Math.max(0, Math.trunc(possibleEntry.stepsTaken as number)) : 0,
      response: typeof possibleEntry.response === "string" ? truncate(possibleEntry.response, maximumResponseLength) : "",
    });
  }

  return sanitizedEntries.slice(0, maximumStoredRunCount);
}

/**
 * A snippet that shows the words that matched, rather than starting at the top
 * of a response and hiding them four lines down.
 */
export function buildMatchSnippet(sourceText: string, query: string): string {
  const collapsedSource = collapseWhitespace(sourceText);
  if (!collapsedSource) {
    return "";
  }

  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery) {
    return truncate(collapsedSource, maximumSnippetLength);
  }

  const loweredSource = collapsedSource.toLowerCase();
  let matchIndex = loweredSource.indexOf(normalizedQuery);
  if (matchIndex === -1) {
    // Fall back to the first word of the query that appears at all, so a
    // multi-word search still shows where it landed.
    const firstMatchingWord = normalizedQuery
      .split(/\s+/)
      .filter(Boolean)
      .find((queryWord) => loweredSource.includes(queryWord));
    matchIndex = firstMatchingWord ? loweredSource.indexOf(firstMatchingWord) : -1;
  }

  if (matchIndex === -1) {
    return truncate(collapsedSource, maximumSnippetLength);
  }

  const leadInLength = 60;
  const startIndex = Math.max(0, matchIndex - leadInLength);
  const snippet = collapsedSource.slice(startIndex, startIndex + maximumSnippetLength);
  const leadingEllipsis = startIndex > 0 ? "…" : "";
  const trailingEllipsis = startIndex + maximumSnippetLength < collapsedSource.length ? "…" : "";
  return `${leadingEllipsis}${snippet.trim()}${trailingEllipsis}`;
}

export class RunHistoryStore {
  private readonly fileStore: JsonFileStore<RunHistoryEntry[]>;
  private entries: RunHistoryEntry[];

  constructor(filePath: string) {
    this.fileStore = new JsonFileStore(filePath, sanitizeRunHistoryEntries);
    this.entries = this.fileStore.read();
  }

  /** Newest first, which is the order the panel shows them in. */
  list(): RunHistoryEntry[] {
    return [...this.entries].sort(
      (firstEntry, secondEntry) => secondEntry.createdAtIso.localeCompare(firstEntry.createdAtIso),
    );
  }

  record(draft: RunHistoryDraft): RunHistoryEntry {
    const entry: RunHistoryEntry = {
      id: randomUUID(),
      createdAtIso: draft.createdAtIso ?? new Date().toISOString(),
      request: truncate(draft.request, maximumRequestLength),
      kind: draft.kind,
      outcome: draft.outcome,
      note: truncate(draft.note, maximumNoteLength),
      stepsTaken: Math.max(0, Math.trunc(draft.stepsTaken)),
      response: truncate(draft.response, maximumResponseLength),
    };

    this.entries = [entry, ...this.entries].slice(0, maximumStoredRunCount);
    this.fileStore.write(this.entries);
    return entry;
  }

  /**
   * Ranks every stored run against the query and returns the ones that match,
   * best first and newest first within a score.
   */
  search(query: string, limit = defaultSearchResultLimit): RunHistorySearchResult[] {
    const trimmedQuery = collapseWhitespace(query);
    const rankedResults: RunHistorySearchResult[] = [];

    for (const entry of this.list()) {
      const searchableText = [entry.request, entry.note, entry.response].filter(Boolean).join(". ");
      const score = trimmedQuery
        ? scoreTextMatch(trimmedQuery, searchableText)
        : 1;
      if (score <= 0) {
        continue;
      }

      rankedResults.push({
        entry,
        score,
        snippet: buildMatchSnippet(entry.response || entry.note || entry.request, trimmedQuery),
      });
    }

    return rankedResults
      .sort((firstResult, secondResult) => secondResult.score - firstResult.score
        || secondResult.entry.createdAtIso.localeCompare(firstResult.entry.createdAtIso))
      .slice(0, Math.max(1, limit));
  }

  clear(): number {
    const removedCount = this.entries.length;
    this.entries = [];
    this.fileStore.write(this.entries);
    return removedCount;
  }
}
