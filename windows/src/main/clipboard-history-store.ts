import { randomUUID } from "node:crypto";
import { ClipboardClip } from "../shared/contracts";
import { JsonFileStore } from "./json-file-store";

function sanitizeClipboardClips(storedValue: unknown): ClipboardClip[] {
  if (!Array.isArray(storedValue)) {
    return [];
  }

  const sanitizedClips: ClipboardClip[] = [];
  for (const storedClip of storedValue) {
    if (!storedClip || typeof storedClip !== "object") {
      continue;
    }
    const possibleClip = storedClip as Partial<ClipboardClip>;
    if (typeof possibleClip.text !== "string" || !possibleClip.text.trim()) {
      continue;
    }
    sanitizedClips.push({
      id: typeof possibleClip.id === "string" && possibleClip.id ? possibleClip.id : randomUUID(),
      text: possibleClip.text.slice(0, 4_000),
      createdAtIso: typeof possibleClip.createdAtIso === "string"
        ? possibleClip.createdAtIso
        : new Date().toISOString(),
    });
  }

  return sanitizedClips;
}

/**
 * Clipboard history for the island. Ustaad only records text the user copied
 * while the feature is switched on, and it never sends the history anywhere.
 */
export class ClipboardHistoryStore {
  private readonly maximumClipCount = 60;
  private readonly fileStore: JsonFileStore<ClipboardClip[]>;
  private clips: ClipboardClip[];

  constructor(filePath: string) {
    this.fileStore = new JsonFileStore(filePath, sanitizeClipboardClips);
    this.clips = this.fileStore.read();
  }

  list(): ClipboardClip[] {
    return [...this.clips];
  }

  latestText(): string {
    return this.clips[0]?.text ?? "";
  }

  /** Returns the stored clip, or null when this text is already the newest clip. */
  pushText(rawText: string): ClipboardClip | null {
    const trimmedText = rawText.replace(/\r\n/g, "\n").trim();
    if (!trimmedText || trimmedText.length > 4_000) {
      return null;
    }
    if (this.clips[0]?.text === trimmedText) {
      return null;
    }
    if (this.clips.some((clipboardClip) => clipboardClip.text === trimmedText)) {
      // Re-copying an older clip promotes it to the top instead of duplicating it.
      this.clips = this.clips.filter((clipboardClip) => clipboardClip.text !== trimmedText);
    }

    const createdClip: ClipboardClip = {
      id: randomUUID(),
      text: trimmedText,
      createdAtIso: new Date().toISOString(),
    };
    this.clips = [createdClip, ...this.clips].slice(0, this.maximumClipCount);
    this.persist();
    return createdClip;
  }

  remove(id: string): boolean {
    const remainingClips = this.clips.filter((clipboardClip) => clipboardClip.id !== id);
    if (remainingClips.length === this.clips.length) {
      return false;
    }
    this.clips = remainingClips;
    this.persist();
    return true;
  }

  clear(): void {
    this.clips = [];
    this.persist();
  }

  private persist(): void {
    this.fileStore.write(this.clips);
  }
}
