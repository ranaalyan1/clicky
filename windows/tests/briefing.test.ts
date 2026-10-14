import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  ActivityFeedEntry,
  ScheduledTask,
  TodoItem,
} from "../src/shared/contracts";
import { buildBriefingDigest } from "../src/main/briefing";

const morningOfTheFourteenth = new Date(2026, 9, 14, 8, 35, 0, 0);

function localIso(date: Date): string {
  return date.toISOString();
}

function scheduledTaskWith(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: "schedule-1",
    name: "standup",
    kind: "reminder",
    prompt: "standup",
    actions: [],
    timeOfDay: "09:00",
    startAtIso: null,
    repeat: "daily",
    isEnabled: true,
    nextRunAtIso: new Date(2026, 9, 14, 9, 0, 0, 0).toISOString(),
    lastRunAtIso: null,
    ...overrides,
  };
}

function todoWith(overrides: Partial<TodoItem>): TodoItem {
  return {
    id: "todo-1",
    text: "send the invoice",
    dueAt: null,
    isDone: false,
    createdAtIso: localIso(new Date(2026, 9, 13, 10, 0, 0, 0)),
    ...overrides,
  };
}

function activityWith(overrides: Partial<ActivityFeedEntry>): ActivityFeedEntry {
  return {
    id: "activity-1",
    kind: "automation",
    message: "ran the routine morning videos",
    detail: "opened youtube",
    createdAtIso: localIso(new Date(2026, 9, 14, 7, 0, 0, 0)),
    isUndoable: false,
    isUndone: false,
    ...overrides,
  };
}

describe("buildBriefingDigest for the morning", () => {
  it("gathers today's schedule, open to-dos and what ran overnight", () => {
    const digest = buildBriefingDigest({
      kind: "morning",
      now: morningOfTheFourteenth,
      scheduledTasks: [scheduledTaskWith({})],
      todos: [todoWith({})],
      activityFeed: [
        activityWith({ createdAtIso: localIso(new Date(2026, 9, 14, 2, 0, 0, 0)), message: "installed the update" }),
      ],
      isLate: false,
    });

    assert.equal(digest.title, "morning brief");
    assert.ok(digest.lines.some((line) => line.includes("standup")), "today's schedule is missing");
    assert.ok(digest.lines.some((line) => line.includes("send the invoice")), "the open to-do is missing");
    assert.ok(digest.lines.some((line) => line.includes("installed the update")), "overnight activity is missing");
    assert.equal(digest.isEmpty, false);
  });

  it("does not count the previous afternoon as overnight work", () => {
    const digest = buildBriefingDigest({
      kind: "morning",
      now: morningOfTheFourteenth,
      scheduledTasks: [],
      todos: [],
      activityFeed: [
        activityWith({ createdAtIso: localIso(new Date(2026, 9, 13, 15, 0, 0, 0)), message: "an afternoon errand" }),
      ],
      isLate: false,
    });

    assert.ok(digest.lines.some((line) => line === "nothing ran while you were away."));
    assert.equal(digest.isEmpty, true);
  });

  it("says plainly that it is late when the pc slept through the time", () => {
    const digest = buildBriefingDigest({
      kind: "morning",
      now: morningOfTheFourteenth,
      scheduledTasks: [],
      todos: [],
      activityFeed: [],
      isLate: true,
    });

    assert.ok(digest.lines[0]?.startsWith("this check-in is late"), "a late brief must admit it");
  });

  it("counts overdue to-dos so they stop hiding", () => {
    const digest = buildBriefingDigest({
      kind: "morning",
      now: morningOfTheFourteenth,
      scheduledTasks: [],
      todos: [todoWith({ dueAt: localIso(new Date(2026, 9, 12, 9, 0, 0, 0)) })],
      activityFeed: [],
      isLate: false,
    });

    assert.ok(digest.lines.some((line) => line.includes("1 overdue")), "an overdue to-do must be named");
  });
});

describe("buildBriefingDigest for the evening", () => {
  it("recaps what happened today and what is still open", () => {
    const evening = new Date(2026, 9, 14, 20, 35, 0, 0);
    const digest = buildBriefingDigest({
      kind: "evening",
      now: evening,
      scheduledTasks: [
        scheduledTaskWith({ nextRunAtIso: new Date(2026, 9, 15, 9, 0, 0, 0).toISOString() }),
      ],
      todos: [todoWith({})],
      activityFeed: [
        activityWith({ message: "snip saved" }),
        activityWith({ id: "activity-2", message: "clipboard rewritten", createdAtIso: localIso(new Date(2026, 9, 14, 15, 0, 0, 0)) }),
      ],
      isLate: false,
    });

    assert.equal(digest.title, "evening recap");
    assert.ok(digest.lines.some((line) => line.includes("today i did 2 things")), "today's work is missing");
    assert.ok(digest.lines.some((line) => line.includes("still open")), "open to-dos are missing");
    assert.ok(digest.lines.some((line) => line.startsWith("tomorrow:")), "tomorrow's schedule is missing");
    assert.equal(digest.isEmpty, false);
  });

  it("is honest about a day where nothing was asked of it", () => {
    const evening = new Date(2026, 9, 14, 20, 35, 0, 0);
    const digest = buildBriefingDigest({
      kind: "evening",
      now: evening,
      scheduledTasks: [],
      todos: [todoWith({ isDone: true })],
      activityFeed: [],
      isLate: false,
    });

    assert.ok(digest.lines.includes("nothing was asked of me today."));
    assert.ok(digest.lines.includes("everything on the list is done."));
    assert.equal(digest.isEmpty, true);
  });
});
