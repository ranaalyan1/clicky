/**
 * What Ustaad says when it wakes up on its own.
 *
 * The digest is assembled from what is already on this PC — schedules, to-dos
 * and the activity feed — so a check-in costs nothing, works with no network,
 * and cannot hallucinate: every line is something Ustaad can prove it knows.
 * The model is not asked to write this, which is also why it still works when
 * the brain is unreachable.
 */

import type {
  ActivityFeedEntry,
  PresenceCheckInKind,
  ScheduledTask,
  TodoItem,
} from "../shared/contracts";
import { describeScheduledTask } from "./schedule-time";
import { localDateKey } from "./presence-schedule";

export interface BriefingInputs {
  kind: PresenceCheckInKind;
  now: Date;
  scheduledTasks: ScheduledTask[];
  todos: TodoItem[];
  activityFeed: ActivityFeedEntry[];
  /** True when the scheduled moment passed while the PC was asleep or off. */
  isLate: boolean;
}

interface BriefingSections {
  lines: string[];
  isEmpty: boolean;
}

export interface BriefingDigest {
  title: string;
  summary: string;
  lines: string[];
  isEmpty: boolean;
}

const overnightWindowStartHour = 18;

function openTodos(todos: TodoItem[]): TodoItem[] {
  return todos.filter((todo) => !todo.isDone);
}

function formatNameList(names: string[], maximumNames = 3): string {
  const shownNames = names.slice(0, maximumNames);
  const remainingCount = names.length - shownNames.length;
  const joinedNames = shownNames.join(", ");
  return remainingCount > 0 ? `${joinedNames} and ${remainingCount} more` : joinedNames;
}

function schedulesLandingOn(scheduledTasks: ScheduledTask[], date: Date): ScheduledTask[] {
  const wantedDateKey = localDateKey(date);
  return scheduledTasks.filter((scheduledTask) => {
    if (!scheduledTask.isEnabled || !scheduledTask.nextRunAtIso) {
      return false;
    }
    const nextRunDate = new Date(scheduledTask.nextRunAtIso);
    if (Number.isNaN(nextRunDate.getTime())) {
      return false;
    }
    return localDateKey(nextRunDate) === wantedDateKey;
  });
}

function formatSchedulesLine(scheduledTasks: ScheduledTask[], prefix: string): string | null {
  if (scheduledTasks.length === 0) {
    return null;
  }

  const descriptions = scheduledTasks.map(
    (scheduledTask) => `${scheduledTask.name} (${describeScheduledTask(scheduledTask)})`,
  );
  return `${prefix}: ${formatNameList(descriptions)}`;
}

function todosLine(todos: TodoItem[], now: Date): string | null {
  const open = openTodos(todos);
  if (open.length === 0) {
    return null;
  }

  // A to-do with a due date in the past is worth naming, because the whole
  // point of the brief is to surface what the user would otherwise not notice.
  const overdueCount = open.filter((todo) => {
    if (todo.dueAt === null) {
      return false;
    }
    const dueAt = new Date(todo.dueAt);
    return !Number.isNaN(dueAt.getTime()) && dueAt.getTime() < now.getTime();
  }).length;

  const baseLine = `still open: ${formatNameList(open.map((todo) => todo.text))}`;
  return overdueCount > 0 ? `${baseLine} (${overdueCount} overdue)` : baseLine;
}

function activityMessages(entries: ActivityFeedEntry[]): string[] {
  return entries
    .filter((entry) => entry.message.trim().length > 0)
    .map((entry) => entry.message.trim());
}

function overnightActivity(entries: ActivityFeedEntry[], now: Date): ActivityFeedEntry[] {
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() - 1);
  windowStart.setHours(overnightWindowStartHour, 0, 0, 0);

  return entries.filter((entry) => {
    const createdAt = new Date(entry.createdAtIso);
    if (Number.isNaN(createdAt.getTime())) {
      return false;
    }
    return createdAt.getTime() >= windowStart.getTime() && createdAt.getTime() <= now.getTime();
  });
}

function activityToday(entries: ActivityFeedEntry[], now: Date): ActivityFeedEntry[] {
  const todayKey = localDateKey(now);
  return entries.filter((entry) => {
    const createdAt = new Date(entry.createdAtIso);
    if (Number.isNaN(createdAt.getTime())) {
      return false;
    }
    return localDateKey(createdAt) === todayKey;
  });
}

function buildMorningLines(inputs: BriefingInputs): BriefingSections {
  const lines: string[] = [];

  if (inputs.isLate) {
    lines.push("this check-in is late: the pc was busy or asleep when it was due.");
  }

  const todaySchedules = schedulesLandingOn(inputs.scheduledTasks, inputs.now);
  const schedulesLine = formatSchedulesLine(todaySchedules, "today");
  if (schedulesLine) {
    lines.push(schedulesLine);
  }

  const openTodoLine = todosLine(inputs.todos, inputs.now);
  if (openTodoLine) {
    lines.push(openTodoLine);
  }

  const overnightEntries = overnightActivity(inputs.activityFeed, inputs.now);
  const overnightMessages = activityMessages(overnightEntries);
  lines.push(
    overnightMessages.length > 0
      ? `while you were away: ${formatNameList(overnightMessages, 3)}`
      : "nothing ran while you were away.",
  );

  return {
    lines,
    isEmpty: todaySchedules.length === 0 && openTodos(inputs.todos).length === 0 && overnightMessages.length === 0,
  };
}

function buildEveningLines(inputs: BriefingInputs): BriefingSections {
  const lines: string[] = [];

  if (inputs.isLate) {
    lines.push("this check-in is late: the pc was busy or asleep when it was due.");
  }

  const todayEntries = activityToday(inputs.activityFeed, inputs.now);
  const todayMessages = activityMessages(todayEntries);
  if (todayMessages.length > 0) {
    lines.push(`today i did ${todayMessages.length} things: ${formatNameList(todayMessages, 3)}`);
  } else {
    lines.push("nothing was asked of me today.");
  }

  const open = openTodos(inputs.todos);
  lines.push(
    open.length > 0
      ? `still open: ${formatNameList(open.map((todo) => todo.text))}`
      : "everything on the list is done.",
  );

  const tomorrow = new Date(inputs.now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowSchedules = schedulesLandingOn(inputs.scheduledTasks, tomorrow);
  const tomorrowSchedulesLine = formatSchedulesLine(tomorrowSchedules, "tomorrow");
  if (tomorrowSchedulesLine) {
    lines.push(tomorrowSchedulesLine);
  }

  return {
    lines,
    isEmpty: todayMessages.length === 0 && open.length === 0 && tomorrowSchedules.length === 0,
  };
}

export function buildBriefingDigest(inputs: BriefingInputs): BriefingDigest {
  const isMorning = inputs.kind === "morning";
  const sections = isMorning ? buildMorningLines(inputs) : buildEveningLines(inputs);
  const summary = sections.lines[0] ?? "nothing to report.";

  return {
    title: isMorning ? "morning brief" : "evening recap",
    summary,
    lines: sections.lines,
    isEmpty: sections.isEmpty,
  };
}
