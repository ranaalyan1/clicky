import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActivityFeed, MemoryStore } from "../src/main/memory-store";

function createMemoryStore(): MemoryStore {
  return new MemoryStore(join(mkdtempSync(join(tmpdir(), "clickaa-memory-")), "memory.json"));
}

test("facts are remembered once and duplicate wording is not stored twice", () => {
  const memoryStore = createMemoryStore();
  memoryStore.add("my brother's birthday is 4 march");
  memoryStore.add("my brother's birthday is 4 march");

  assert.equal(memoryStore.list().length, 1);

  const matchedFacts = memoryStore.findMatches("birthday");
  assert.equal(matchedFacts.length, 1);
  assert.equal(memoryStore.summarizeFacts(1_000).length, 1);
});

test("facts can be forgotten by wording, by id, or all at once", () => {
  const memoryStore = createMemoryStore();
  memoryStore.add("the wifi password is hunter2");
  const temporaryFact = memoryStore.add("i parked on level three");

  assert.equal(memoryStore.forgetMatching("wifi").length, 1);
  assert.equal(memoryStore.remove(temporaryFact.id), true);
  assert.equal(memoryStore.list().length, 0);

  memoryStore.add("i prefer dark mode");
  assert.equal(memoryStore.clear(), 1);
  assert.equal(memoryStore.list().length, 0);
});

test("the activity feed keeps the newest entries first and supports undo state", () => {
  const activityFeed = new ActivityFeed(4);
  const firstEntry = activityFeed.record("action", "opened unity", "", true);
  activityFeed.record("system", "routine ran", "morning briefing", false);
  activityFeed.record("confirmation", "waiting for your yes", "open spotify", false);

  const listedEntries = activityFeed.list(10);
  assert.equal(listedEntries.length, 3);
  assert.equal(listedEntries[0]?.message, "waiting for your yes");

  const undoneEntry = activityFeed.markUndone(firstEntry.id);
  assert.equal(undoneEntry?.isUndone, true);
  assert.equal(activityFeed.markUndone("not-a-real-id"), null);

  activityFeed.record("action", "one", "", false);
  activityFeed.record("action", "two", "", false);
  assert.equal(activityFeed.list(10).length, 4);
});
