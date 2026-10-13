import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ScheduleStore } from "../src/main/schedule-store";
import {
  computeNextRunAtIso,
  describeScheduledTask,
  isScheduledTaskDue,
  isScheduledTaskOverdueBeyondGrace,
} from "../src/main/schedule-time";

test("a daily routine is scheduled for today when its time is still ahead", () => {
  const mondayMorning = new Date(2026, 9, 13, 8, 0, 0);
  assert.equal(
    computeNextRunAtIso({ repeat: "daily", timeOfDay: "09:00", startAtIso: null }, mondayMorning),
    "2026-10-13T09:00:00",
  );
});

test("weekday routines skip the weekend and one-shot times in the past never run", () => {
  const saturday = new Date(2026, 9, 17, 10, 0, 0);
  assert.equal(
    computeNextRunAtIso({ repeat: "weekdays", timeOfDay: "09:00", startAtIso: null }, saturday),
    "2026-10-19T09:00:00",
  );
  assert.equal(
    computeNextRunAtIso({ repeat: "weekends", timeOfDay: "09:00", startAtIso: null }, saturday),
    "2026-10-18T09:00:00",
  );
  assert.equal(
    computeNextRunAtIso({ repeat: "none", timeOfDay: null, startAtIso: "2026-10-01T09:00" }, saturday),
    null,
  );
});

test("a scheduled search keeps its own name and reports when it next runs", () => {
  const now = new Date(2026, 9, 13, 8, 0, 0);
  const scheduleStore = new ScheduleStore(join(mkdtempSync(join(tmpdir(), "clickaa-schedule-")), "schedules.json"));

  const createdTask = scheduleStore.add(
    {
      name: "search amazon for gift wraps",
      kind: "reminder",
      prompt: "search amazon for gift wraps",
      actions: [{ type: "search_web", query: "gift wraps", target: "amazon" }],
      timeOfDay: "11:00",
      startAtIso: "2026-10-13T11:00",
      repeat: "none",
    },
    now,
  );

  assert.equal(createdTask.nextRunAtIso, "2026-10-13T11:00:00");
  assert.equal(describeScheduledTask(createdTask), "once at 11:00 AM");

  assert.equal(isScheduledTaskDue(createdTask, new Date(2026, 9, 13, 10, 50, 0)), true);
  assert.equal(isScheduledTaskDue(createdTask, new Date(2026, 9, 13, 10, 30, 0)), false);
  assert.equal(isScheduledTaskOverdueBeyondGrace(createdTask, new Date(2026, 9, 13, 12, 0, 0)), true);
});

test("recurring tasks roll forward after running and one-shot reminders go quiet", () => {
  const now = new Date(2026, 9, 13, 8, 0, 0);
  const scheduleStore = new ScheduleStore(join(mkdtempSync(join(tmpdir(), "clickaa-schedule-")), "schedules.json"));

  const dailyRoutine = scheduleStore.add(
    {
      name: "open unity and spotify",
      kind: "routine",
      prompt: "open unity and spotify",
      actions: [{ type: "open_app", name: "unity" }],
      timeOfDay: "09:00",
      startAtIso: null,
      repeat: "daily",
    },
    now,
  );

  const afterRun = scheduleStore.recordRun(dailyRoutine.id, new Date(2026, 9, 13, 9, 0, 0));
  assert.equal(afterRun?.nextRunAtIso, "2026-10-14T09:00:00");
  assert.equal(afterRun?.isEnabled, true);

  const pausedRoutine = scheduleStore.setEnabled(dailyRoutine.id, false, now);
  assert.equal(pausedRoutine?.isEnabled, false);
  // Pausing keeps the stamp so resuming puts the routine back where it was.
  assert.equal(pausedRoutine?.nextRunAtIso, "2026-10-14T09:00:00");
  assert.deepEqual(scheduleStore.listDueTasks(new Date(2026, 9, 14, 9, 5, 0)), []);

  scheduleStore.setEnabled(dailyRoutine.id, true, now);
  const dueTasks = scheduleStore.listDueTasks(new Date(2026, 9, 14, 9, 5, 0));
  assert.deepEqual(dueTasks.map((scheduledTask) => scheduledTask.id), [dailyRoutine.id]);

  const nextRuns = scheduleStore.listNextRunsDescription(3);
  assert.equal(nextRuns.length, 1);
  assert.equal(nextRuns[0]?.startsWith("open unity and spotify at "), true);
});

test("overdue tasks started from a cold boot roll forward instead of firing late", () => {
  const now = new Date(2026, 9, 13, 8, 0, 0);
  const scheduleStore = new ScheduleStore(join(mkdtempSync(join(tmpdir(), "clickaa-schedule-")), "schedules.json"));

  const morningRoutine = scheduleStore.add(
    {
      name: "morning briefing",
      kind: "routine",
      prompt: "tell me the weather",
      actions: [],
      timeOfDay: "09:00",
      startAtIso: null,
      repeat: "daily",
    },
    now,
  );

  const rolledForwardTasks = scheduleStore.rollForwardOverdueTasks(new Date(2026, 9, 13, 14, 0, 0));
  assert.deepEqual(rolledForwardTasks.map((scheduledTask) => scheduledTask.id), [morningRoutine.id]);
  assert.equal(scheduleStore.list()[0]?.nextRunAtIso, "2026-10-14T09:00:00");
});
