import { randomUUID } from "node:crypto";
import { TodoItem } from "../shared/contracts";
import { JsonFileStore } from "./json-file-store";
import { parseLocalIsoDateTime } from "./local-time";
import { isAmbiguousTopMatch, rankTextMatches, RankedTextMatch } from "./text-matching";

function sanitizeTodoItems(storedValue: unknown): TodoItem[] {
  if (!Array.isArray(storedValue)) {
    return [];
  }

  const sanitizedItems: TodoItem[] = [];
  for (const storedItem of storedValue) {
    if (!storedItem || typeof storedItem !== "object") {
      continue;
    }
    const possibleItem = storedItem as Partial<TodoItem>;
    if (typeof possibleItem.text !== "string" || !possibleItem.text.trim()) {
      continue;
    }
    sanitizedItems.push({
      id: typeof possibleItem.id === "string" && possibleItem.id ? possibleItem.id : randomUUID(),
      text: possibleItem.text.trim(),
      dueAt: typeof possibleItem.dueAt === "string" ? possibleItem.dueAt : null,
      isDone: possibleItem.isDone === true,
      createdAtIso: typeof possibleItem.createdAtIso === "string"
        ? possibleItem.createdAtIso
        : new Date().toISOString(),
    });
  }

  return sanitizedItems;
}

export interface TodoLookupResult {
  isAmbiguous: boolean;
  matches: Array<RankedTextMatch<TodoItem>>;
}

/** Ustaad's to-do list, as spoken by the user and shown in the island. */
export class TodoStore {
  private readonly fileStore: JsonFileStore<TodoItem[]>;
  private items: TodoItem[];

  constructor(filePath: string) {
    this.fileStore = new JsonFileStore(filePath, sanitizeTodoItems);
    this.items = this.fileStore.read();
  }

  /** Open items first (soonest due date first), finished items last. */
  list(): TodoItem[] {
    return [...this.items].sort((firstItem, secondItem) => {
      if (firstItem.isDone !== secondItem.isDone) {
        return firstItem.isDone ? 1 : -1;
      }

      if (firstItem.dueAt && secondItem.dueAt && firstItem.dueAt !== secondItem.dueAt) {
        return firstItem.dueAt.localeCompare(secondItem.dueAt);
      }
      if (firstItem.dueAt && !secondItem.dueAt) {
        return -1;
      }
      if (!firstItem.dueAt && secondItem.dueAt) {
        return 1;
      }

      return firstItem.createdAtIso.localeCompare(secondItem.createdAtIso);
    });
  }

  add(text: string, dueAt: string | null): TodoItem {
    const trimmedText = text.trim();
    if (!trimmedText) {
      throw new Error("A to-do needs some text.");
    }

    const createdItem: TodoItem = {
      id: randomUUID(),
      text: trimmedText,
      dueAt: parseLocalIsoDateTime(dueAt) ? dueAt : null,
      isDone: false,
      createdAtIso: new Date().toISOString(),
    };
    this.items.push(createdItem);
    this.persist();
    return createdItem;
  }

  /** Finds items by spoken text so the model never has to know an id. */
  findMatches(query: string, limit = 5): TodoLookupResult {
    const matches = rankTextMatches(query, this.list(), (todoItem) => todoItem.text, limit);
    return { isAmbiguous: isAmbiguousTopMatch(matches), matches };
  }

  completeMatching(query: string): TodoItem[] {
    return this.markMatchingItems(query, true);
  }

  reopenMatching(query: string): TodoItem[] {
    return this.markMatchingItems(query, false);
  }

  removeMatching(query: string): TodoItem[] {
    const matchedItems = this.listMatchingItems(query);
    this.items = this.items.filter((todoItem) => !matchedItems.some((matchedItem) => matchedItem.id === todoItem.id));
    this.persist();
    return matchedItems;
  }

  setDone(id: string, isDone: boolean): TodoItem | null {
    return this.updateItem(id, (todoItem) => ({ ...todoItem, isDone }));
  }

  remove(id: string): boolean {
    const remainingItems = this.items.filter((todoItem) => todoItem.id !== id);
    if (remainingItems.length === this.items.length) {
      return false;
    }
    this.items = remainingItems;
    this.persist();
    return true;
  }

  clearDone(): number {
    const doneItemCount = this.items.filter((todoItem) => todoItem.isDone).length;
    this.items = this.items.filter((todoItem) => !todoItem.isDone);
    this.persist();
    return doneItemCount;
  }

  /** Compact open-item list for the system prompt and the island. */
  summarizeOpenItems(limit: number): string[] {
    return this.list()
      .filter((todoItem) => !todoItem.isDone)
      .slice(0, limit)
      .map((todoItem) => (todoItem.dueAt ? `${todoItem.text} (due ${todoItem.dueAt})` : todoItem.text));
  }

  private markMatchingItems(query: string, isDone: boolean): TodoItem[] {
    const matchedItems = this.listMatchingItems(query);
    for (const matchedItem of matchedItems) {
      this.updateItem(matchedItem.id, (todoItem) => ({ ...todoItem, isDone }));
    }
    return matchedItems;
  }

  private listMatchingItems(query: string, limit = 5): TodoItem[] {
    return this.findMatches(query, limit).matches.map((rankedMatch) => rankedMatch.item);
  }

  private updateItem(id: string, updateItem: (todoItem: TodoItem) => TodoItem): TodoItem | null {
    const itemIndex = this.items.findIndex((todoItem) => todoItem.id === id);
    if (itemIndex === -1) {
      return null;
    }

    const updatedItem = updateItem(this.items[itemIndex]!);
    this.items = this.items.map((todoItem, currentIndex) => (currentIndex === itemIndex ? updatedItem : todoItem));
    this.persist();
    return updatedItem;
  }

  private persist(): void {
    this.fileStore.write(this.items);
  }
}
