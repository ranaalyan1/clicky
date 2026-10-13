import { randomUUID } from "node:crypto";
import { Snippet } from "../shared/contracts";
import { JsonFileStore } from "./json-file-store";
import { normalizeForMatch, rankTextMatches, RankedTextMatch } from "./text-matching";

const maximumSnippetTextLength = 8_000;

function sanitizeSnippets(storedSnippets: unknown): Snippet[] {
  if (!Array.isArray(storedSnippets)) {
    return [];
  }

  const sanitizedSnippets: Snippet[] = [];
  for (const possibleSnippet of storedSnippets) {
    if (!possibleSnippet || typeof possibleSnippet !== "object") {
      continue;
    }

    const snippetRecord = possibleSnippet as Partial<Snippet>;
    const name = typeof snippetRecord.name === "string" ? snippetRecord.name.trim() : "";
    const text = typeof snippetRecord.text === "string"
      ? snippetRecord.text.slice(0, maximumSnippetTextLength)
      : "";
    if (!name || !text) {
      continue;
    }

    sanitizedSnippets.push({
      id: typeof snippetRecord.id === "string" && snippetRecord.id ? snippetRecord.id : randomUUID(),
      name,
      text,
      createdAtIso: typeof snippetRecord.createdAtIso === "string"
        ? snippetRecord.createdAtIso
        : new Date().toISOString(),
    });
  }

  return sanitizedSnippets;
}

export interface SnippetLookupResult {
  /** The snippet whose name matches best, when there is a clear winner. */
  snippet: Snippet | null;
  matches: Array<RankedTextMatch<Snippet>>;
  message: string;
}

/**
 * Phrases the user saved once: an address, a signature, a reply they send all
 * the time. Inserting one types it into whatever window has focus.
 */
export class SnippetStore {
  private readonly fileStore: JsonFileStore<Snippet[]>;
  private snippets: Snippet[];

  constructor(filePath: string) {
    this.fileStore = new JsonFileStore(filePath, sanitizeSnippets);
    this.snippets = this.fileStore.read();
  }

  list(): Snippet[] {
    return [...this.snippets].sort((firstSnippet, secondSnippet) => (
      firstSnippet.name.localeCompare(secondSnippet.name)
    ));
  }

  /** Saving with a name that already exists replaces that snippet. */
  save(name: string, text: string): Snippet {
    const trimmedName = name.trim().slice(0, 80);
    const trimmedText = text.slice(0, maximumSnippetTextLength);
    if (!trimmedName) {
      throw new Error("A snippet needs a name, for example \"my address\".");
    }
    if (!trimmedText.trim()) {
      throw new Error("A snippet needs some text to insert.");
    }

    const existingSnippet = this.snippets.find(
      (snippet) => normalizeForMatch(snippet.name) === normalizeForMatch(trimmedName),
    );

    if (existingSnippet) {
      const updatedSnippet: Snippet = { ...existingSnippet, name: trimmedName, text: trimmedText };
      this.snippets = this.snippets.map((snippet) => (
        snippet.id === existingSnippet.id ? updatedSnippet : snippet
      ));
      this.persist();
      return updatedSnippet;
    }

    const createdSnippet: Snippet = {
      id: randomUUID(),
      name: trimmedName,
      text: trimmedText,
      createdAtIso: new Date().toISOString(),
    };
    this.snippets.push(createdSnippet);
    this.persist();
    return createdSnippet;
  }

  findMatches(query: string, limit = 5): Array<RankedTextMatch<Snippet>> {
    return rankTextMatches(query, this.snippets, (snippet) => snippet.name, limit);
  }

  /**
   * Resolves what the user asked for. An exact name always wins; anything fuzzier
   * has to be clearly ahead of the runner-up, or Clickaa asks which one.
   */
  resolveForInsert(query: string): SnippetLookupResult {
    const normalizedQuery = normalizeForMatch(query);
    const exactSnippet = this.snippets.find(
      (snippet) => normalizeForMatch(snippet.name) === normalizedQuery,
    );
    if (exactSnippet) {
      return { snippet: exactSnippet, matches: [], message: "" };
    }

    const matches = this.findMatches(query, 4);
    if (!matches.length) {
      return {
        snippet: null,
        matches,
        message: `there is no "${query}" snippet yet. say "save this as the ${query} snippet" first.`,
      };
    }

    const [bestMatch, secondMatch] = matches;
    const runnerUpIsClose = secondMatch !== undefined && secondMatch.score >= bestMatch!.score - 15;
    if (runnerUpIsClose && bestMatch!.score < 900) {
      const candidateNames = matches.slice(0, 3).map((match) => match.item.name).join(", ");
      return {
        snippet: null,
        matches,
        message: `which snippet did you mean: ${candidateNames}?`,
      };
    }

    return { snippet: bestMatch!.item, matches, message: "" };
  }

  remove(id: string): boolean {
    const remainingSnippets = this.snippets.filter((snippet) => snippet.id !== id);
    if (remainingSnippets.length === this.snippets.length) {
      return false;
    }
    this.snippets = remainingSnippets;
    this.persist();
    return true;
  }

  removeMatching(query: string): Snippet[] {
    const matches = this.findMatches(query, 5);
    const removedSnippets: Snippet[] = [];
    for (const match of matches) {
      if (!match) {
        continue;
      }
      if (this.remove(match.item.id)) {
        removedSnippets.push(match.item);
      }
    }
    return removedSnippets;
  }

  /** Compact list for the system prompt, so Clickaa knows what it can insert. */
  summarizeSnippetNames(limit: number): string[] {
    return this.list().slice(0, limit).map((snippet) => snippet.name);
  }

  private persist(): void {
    this.fileStore.write(this.snippets);
  }
}
