import { randomUUID } from "node:crypto";
import { ActivityFeedEntry, ActivityKind, MemoryFact } from "../shared/contracts";
import { JsonFileStore } from "./json-file-store";
import { rankTextMatches, RankedTextMatch } from "./text-matching";

function sanitizeMemoryFacts(storedValue: unknown): MemoryFact[] {
  if (!Array.isArray(storedValue)) {
    return [];
  }

  const sanitizedFacts: MemoryFact[] = [];
  for (const storedFact of storedValue) {
    if (!storedFact || typeof storedFact !== "object") {
      continue;
    }
    const possibleFact = storedFact as Partial<MemoryFact>;
    if (typeof possibleFact.text !== "string" || !possibleFact.text.trim()) {
      continue;
    }
    if (possibleFact.text.trim().length > 500) {
      continue;
    }
    sanitizedFacts.push({
      id: typeof possibleFact.id === "string" && possibleFact.id ? possibleFact.id : randomUUID(),
      text: possibleFact.text.trim(),
      createdAtIso: typeof possibleFact.createdAtIso === "string"
        ? possibleFact.createdAtIso
        : new Date().toISOString(),
    });
  }

  return sanitizedFacts;
}

/**
 * Long-lived facts the user asked Ustaad to keep ("my brother's birthday is in
 * March"). Facts are injected into every system prompt, so the list is capped.
 */
export class MemoryStore {
  private readonly maximumFactCount = 200;
  private readonly fileStore: JsonFileStore<MemoryFact[]>;
  private facts: MemoryFact[];

  constructor(filePath: string) {
    this.fileStore = new JsonFileStore(filePath, sanitizeMemoryFacts);
    this.facts = this.fileStore.read();
  }

  list(): MemoryFact[] {
    return [...this.facts].sort(
      (firstFact, secondFact) => secondFact.createdAtIso.localeCompare(firstFact.createdAtIso),
    );
  }

  add(text: string): MemoryFact {
    const trimmedText = text.trim();
    if (!trimmedText) {
      throw new Error("Nothing to remember.");
    }

    const existingFact = this.facts.find(
      (memoryFact) => memoryFact.text.toLowerCase() === trimmedText.toLowerCase(),
    );
    if (existingFact) {
      return existingFact;
    }

    const createdFact: MemoryFact = {
      id: randomUUID(),
      text: trimmedText.slice(0, 500),
      createdAtIso: new Date().toISOString(),
    };
    this.facts = [createdFact, ...this.facts].slice(0, this.maximumFactCount);
    this.persist();
    return createdFact;
  }

  findMatches(query: string, limit = 5): Array<RankedTextMatch<MemoryFact>> {
    return rankTextMatches(query, this.facts, (memoryFact) => memoryFact.text, limit);
  }

  forgetMatching(query: string): MemoryFact[] {
    const matchedFacts = this.findMatches(query).map((rankedMatch) => rankedMatch.item);
    if (!matchedFacts.length) {
      return [];
    }

    this.facts = this.facts.filter((memoryFact) => !matchedFacts.some((matchedFact) => matchedFact.id === memoryFact.id));
    this.persist();
    return matchedFacts;
  }

  remove(id: string): boolean {
    const remainingFacts = this.facts.filter((memoryFact) => memoryFact.id !== id);
    if (remainingFacts.length === this.facts.length) {
      return false;
    }
    this.facts = remainingFacts;
    this.persist();
    return true;
  }

  clear(): number {
    const removedFactCount = this.facts.length;
    this.facts = [];
    this.persist();
    return removedFactCount;
  }

  /** The newest facts, trimmed to keep every request small. */
  summarizeFacts(maximumCharacterCount: number): string[] {
    const summarizedFacts: string[] = [];
    let usedCharacterCount = 0;
    for (const memoryFact of this.list()) {
      if (usedCharacterCount + memoryFact.text.length > maximumCharacterCount) {
        break;
      }
      summarizedFacts.push(memoryFact.text);
      usedCharacterCount += memoryFact.text.length;
    }
    return summarizedFacts;
  }

  private persist(): void {
    this.fileStore.write(this.facts);
  }
}

/**
 * The short "what just happened" list shown in the island. It is intentionally
 * in-memory only: it is a live feed, not a log the user has to curate.
 */
export class ActivityFeed {
  private entries: ActivityFeedEntry[] = [];

  constructor(private readonly maximumEntryCount = 25) {}

  record(kind: ActivityKind, message: string, detail: string, isUndoable: boolean): ActivityFeedEntry {
    const createdEntry: ActivityFeedEntry = {
      id: randomUUID(),
      kind,
      message,
      detail,
      createdAtIso: new Date().toISOString(),
      isUndoable,
      isUndone: false,
    };
    this.entries = [createdEntry, ...this.entries].slice(0, this.maximumEntryCount);
    return createdEntry;
  }

  list(limit = 12): ActivityFeedEntry[] {
    return this.entries.slice(0, limit);
  }

  markUndone(id: string): ActivityFeedEntry | null {
    const existingEntry = this.entries.find((activityEntry) => activityEntry.id === id);
    if (!existingEntry) {
      return null;
    }

    const updatedEntry: ActivityFeedEntry = { ...existingEntry, isUndone: true, isUndoable: false };
    this.entries = this.entries.map((activityEntry) => (activityEntry.id === id ? updatedEntry : activityEntry));
    return updatedEntry;
  }

  clear(): void {
    this.entries = [];
  }
}
