import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonFileStore } from "../src/main/json-file-store";

interface StoredPreferences {
  assistantName: string;
  volume: number;
}

function sanitizePreferences(storedValue: unknown): StoredPreferences {
  const preferences = (storedValue ?? {}) as Partial<StoredPreferences>;
  return {
    assistantName: typeof preferences.assistantName === "string" ? preferences.assistantName : "clickaa",
    volume: typeof preferences.volume === "number" ? preferences.volume : 1,
  };
}

test("values round-trip through the file and leave no temporary file behind", () => {
  const storeDirectory = mkdtempSync(join(tmpdir(), "clickaa-json-"));
  const storePath = join(storeDirectory, "preferences.json");
  const fileStore = new JsonFileStore(storePath, sanitizePreferences);

  assert.deepEqual(fileStore.read(), { assistantName: "clickaa", volume: 1 });

  fileStore.write({ assistantName: "buddy", volume: 0.4 });
  assert.deepEqual(fileStore.read(), { assistantName: "buddy", volume: 0.4 });
  assert.equal(existsSync(`${storePath}.tmp`), false);
});

test("a missing or corrupt file falls back to sanitized defaults", () => {
  const storeDirectory = mkdtempSync(join(tmpdir(), "clickaa-json-"));
  const storePath = join(storeDirectory, "preferences.json");
  const fileStore = new JsonFileStore(storePath, sanitizePreferences);

  writeFileSync(storePath, "{ this is not json", "utf8");
  assert.deepEqual(fileStore.read(), { assistantName: "clickaa", volume: 1 });
});
