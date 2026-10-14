import { ScheduleRepeat, ScheduledTask, scheduleRepeats } from "../shared/contracts";
import {
  formatClockTimeFromTimeOfDay,
  formatFriendlyDateTime,
  formatLocalIso,
  parseLocalIsoDateTime,
  parseTimeOfDay,
} from "./local-time";

export function normalizeScheduleRepeat(candidateRepeat: unknown): ScheduleRepeat {
  return typeof candidateRepeat === "string"
    && (scheduleRepeats as readonly string[]).includes(candidateRepeat)
    ? candidateRepeat as ScheduleRepeat
    : "none";
}

/** A time-of-day schedule only runs on days the repeat rule allows. */
export function repeatAllowsDate(repeat: ScheduleRepeat, date: Date): boolean {
  const dayOfWeek = date.getDay();
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  switch (repeat) {
    case "daily":
      return true;
    case "weekdays":
      return isWeekday;
    case "weekends":
      return !isWeekday;
    case "none":
    default:
      return true;
  }
}

/**
 * The next moment a schedule should fire, or null when it will never fire again
 * (a one-shot whose time has passed).
 */
export function computeNextRunAtIso(
  schedule: Pick<ScheduledTask, "repeat" | "timeOfDay" | "startAtIso">,
  fromDate: Date,
): string | null {
  if (schedule.repeat === "none") {
    const oneShotDate = parseLocalIsoDateTime(schedule.startAtIso);
    if (!oneShotDate) {
      return null;
    }
    return oneShotDate.getTime() > fromDate.getTime() ? formatLocalIso(oneShotDate) : null;
  }

  const parsedTimeOfDay = parseTimeOfDay(schedule.timeOfDay);
  if (!parsedTimeOfDay) {
    return null;
  }

  // Walk forward one day at a time until the repeat rule allows a date and the
  // wall-clock time is still ahead of us. Fourteen attempts covers weekdays and
  // weekend rules with room to spare.
  const candidateDate = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
  for (let dayOffset = 0; dayOffset < 14; dayOffset += 1) {
    const dayToCheck = new Date(
      candidateDate.getFullYear(),
      candidateDate.getMonth(),
      candidateDate.getDate() + dayOffset,
      parsedTimeOfDay.hours,
      parsedTimeOfDay.minutes,
      0,
      0,
    );
    if (dayToCheck.getTime() <= fromDate.getTime() || !repeatAllowsDate(schedule.repeat, dayToCheck)) {
      continue;
    }
    return formatLocalIso(dayToCheck);
  }

  return null;
}

/**
 * Schedules are persisted with the next run they already computed. On startup,
 * a run missed by less than the grace window still fires so that starting the
 * app a couple of minutes late does not silently drop a routine.
 */
export function isScheduledTaskDue(
  scheduledTask: ScheduledTask,
  now: Date,
  graceWindowMinutes = 15,
): boolean {
  if (!scheduledTask.isEnabled || !scheduledTask.nextRunAtIso) {
    return false;
  }

  const nextRunDate = parseLocalIsoDateTime(scheduledTask.nextRunAtIso);
  if (!nextRunDate) {
    return false;
  }

  return nextRunDate.getTime() <= now.getTime() + graceWindowMinutes * 60_000;
}

/**
 * A task missed while Ustaad was closed should not fire hours later, so
 * overdue tasks older than the grace window are rolled forward instead.
 */
export function isScheduledTaskOverdueBeyondGrace(
  scheduledTask: ScheduledTask,
  now: Date,
  graceWindowMinutes = 15,
): boolean {
  const nextRunDate = parseLocalIsoDateTime(scheduledTask.nextRunAtIso);
  if (!nextRunDate) {
    return false;
  }
  return nextRunDate.getTime() < now.getTime() - graceWindowMinutes * 60_000;
}

export function describeScheduledTask(scheduledTask: ScheduledTask): string {
  if (scheduledTask.kind === "routine") {
    const repeatLabel = scheduledTask.repeat === "none" ? "once" : scheduledTask.repeat;
    return `every ${repeatLabel} at ${formatClockTimeFromTimeOfDay(scheduledTask.timeOfDay) || "its time"}`;
  }

  const repeatLabel = scheduledTask.repeat === "none"
    ? "once"
    : scheduledTask.repeat === "daily"
      ? "every day"
      : scheduledTask.repeat;
  return `${repeatLabel} at ${formatClockTimeFromTimeOfDay(scheduledTask.timeOfDay) || "its time"}`;
}

/** The schedules and to-dos worth putting in a system prompt, compactly. */
export function summarizeUpcomingSchedules(
  scheduledTasks: ScheduledTask[],
  now: Date,
  limit: number,
): string[] {
  return scheduledTasks
    .filter((scheduledTask) => scheduledTask.isEnabled && scheduledTask.nextRunAtIso)
    .sort((firstTask, secondTask) => (firstTask.nextRunAtIso ?? "").localeCompare(secondTask.nextRunAtIso ?? ""))
    .slice(0, limit)
    .map((scheduledTask) => {
      const nextRunDescription = formatFriendlyDateTime(scheduledTask.nextRunAtIso, now)
        || scheduledTask.nextRunAtIso
        || "";
      return `${scheduledTask.name} (${describeScheduledTask(scheduledTask)}, next ${nextRunDescription})`;
    });
}
