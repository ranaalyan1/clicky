import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskQueueStore } from "../src/main/task-queue-store";

function createQueueStore(): TaskQueueStore {
  return new TaskQueueStore(join(mkdtempSync(join(tmpdir(), "ustaad-queue-")), "task-queue.json"));
}

function queuePath(): string {
  return join(mkdtempSync(join(tmpdir(), "ustaad-queue-")), "task-queue.json");
}

test("a queued task waits its turn and is taken oldest first", () => {
  const queueStore = createQueueStore();

  queueStore.enqueue({ goal: "play my morning videos", seedActions: [] });
  queueStore.enqueue({ goal: "check the last order", seedActions: [{ type: "open_url", url: "https://example.com" }] });

  assert.deepEqual(queueStore.waiting().map((task) => task.goal), [
    "play my morning videos",
    "check the last order",
  ]);

  const runningTask = queueStore.takeNext();
  assert.equal(runningTask?.goal, "play my morning videos");
  assert.equal(runningTask?.status, "running");
  // Taken off the waiting list the moment it starts.
  assert.deepEqual(queueStore.waiting().map((task) => task.goal), ["check the last order"]);
});

test("finishing a task files its outcome, and an empty list has nothing to take", () => {
  const queueStore = createQueueStore();
  assert.equal(queueStore.takeNext(), null);

  const queuedTask = queueStore.enqueue({ goal: "open my orders", seedActions: [] });
  queueStore.takeNext();
  const finishedTask = queueStore.finish(queuedTask.id, "done", "found the last order");

  assert.equal(finishedTask?.status, "done");
  assert.equal(finishedTask?.note, "found the last order");
  assert.ok(finishedTask?.finishedAtIso);
  assert.equal(queueStore.waiting().length, 0);
  assert.equal(queueStore.takeNext(), null);
});

test("a waiting task can be dropped, but the running one cannot be silently lost", () => {
  const queueStore = createQueueStore();
  const firstTask = queueStore.enqueue({ goal: "first thing", seedActions: [] });
  const secondTask = queueStore.enqueue({ goal: "second thing", seedActions: [] });

  queueStore.takeNext();
  // The running task is not droppable: stopping it is a different decision.
  assert.equal(queueStore.cancel(firstTask.id), null);
  assert.equal(queueStore.cancel(secondTask.id)?.status, "cancelled");
  assert.deepEqual(queueStore.waiting(), []);
});

test("clearing the list drops everything waiting and says how much", () => {
  const queueStore = createQueueStore();
  queueStore.enqueue({ goal: "one", seedActions: [] });
  queueStore.enqueue({ goal: "two", seedActions: [] });
  queueStore.takeNext();

  assert.equal(queueStore.cancelWaiting(), 1);
  assert.equal(queueStore.cancelWaiting(), 0);
});

test("the queue survives a restart, and anything caught mid-run is cancelled", () => {
  const filePath = queuePath();
  const firstStore = new TaskQueueStore(filePath);
  firstStore.enqueue({ goal: "running when it closed", seedActions: [] });
  firstStore.takeNext();
  firstStore.enqueue({ goal: "waiting when it closed", seedActions: [] });

  const reloadedStore = new TaskQueueStore(filePath);
  const reloadedTasks = reloadedStore.list();
  const cancelledTask = reloadedTasks.find((task) => task.goal === "running when it closed");
  const waitingTask = reloadedTasks.find((task) => task.goal === "waiting when it closed");

  assert.equal(cancelledTask?.status, "cancelled");
  assert.equal(cancelledTask?.note, "ustaad closed before this one started");
  assert.equal(waitingTask?.status, "waiting");
  assert.equal(reloadedStore.waiting().length, 1);
});

test("stored queue entries are sanitized rather than trusted", () => {
  const filePath = queuePath();
  writeFileSync(filePath, JSON.stringify([
    { goal: "", status: "waiting" },
    { goal: "kept", status: "teleported", createdAtIso: 7, seedActions: "none" },
    { goal: "x".repeat(400), status: "waiting", seedActions: Array.from({ length: 20 }, () => ({ type: "notify", title: "a", body: "b" })) },
  ]));

  const queueStore = new TaskQueueStore(filePath);
  const keptTask = queueStore.list().find((task) => task.goal === "kept");
  const longTask = queueStore.list().find((task) => task.goal.startsWith("xxxx"));

  assert.equal(queueStore.list().length, 2);
  assert.equal(keptTask?.status, "waiting");
  assert.deepEqual(keptTask?.seedActions, []);
  assert.equal(keptTask?.note, "");
  assert.equal(longTask?.goal.length, 300);
  assert.equal(longTask?.seedActions.length, 12);
});

test("the file never grows without bound", () => {
  const queueStore = createQueueStore();
  for (let index = 0; index < 30; index += 1) {
    const queuedTask = queueStore.enqueue({ goal: `task ${index}`, seedActions: [] });
    queueStore.takeNext();
    queueStore.finish(queuedTask.id, "done", "finished");
  }

  // Five finished entries are kept for context; the rest are dropped.
  assert.equal(queueStore.list().length, 5);
  assert.deepEqual(queueStore.list().map((task) => task.goal), [
    "task 25", "task 26", "task 27", "task 28", "task 29",
  ]);
});
