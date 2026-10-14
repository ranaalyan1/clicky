import { randomUUID } from "node:crypto";
import { UstaadAction, ScheduleRepeat, ScheduledTask } from "../shared/contracts";
import { JsonFileStore } from "./json-file-store";
import { formatLocalIso, parseLocalIsoDateTime } from "./local-time";
import {
  computeNextRunAtIso,
  isScheduledTaskDue,
  isScheduledTaskOverdueBeyondGrace,
  normalizeScheduleRepeat,
} from "./schedule-time";
import { RankedTextMatch, rankTextMatches } from "./text-matching";

function sanitizeScheduledTasks(storedValue: unknown): ScheduledTask[] {
  if (!Array.isArray(storedValue)) {
    return [];
  }

  const sanitizedTasks: ScheduledTask[] = [];
  for (const storedTask of storedValue) {
    if (!storedTask || typeof storedTask !== "object") {
      continue;
    }

    const possibleTask = storedTask as Partial<ScheduledTask>;
    if (typeof possibleTask.name !== "string" || !possibleTask.name.trim()) {
      continue;
    }

    sanitizedTasks.push({
      id: typeof possibleTask.id === "string" && possibleTask.id ? possibleTask.id : randomUUID(),
      name: possibleTask.name.trim(),
      kind: possibleTask.kind === "routine" ? "routine" : "reminder",
      prompt: typeof possibleTask.prompt === "string" ? possibleTask.prompt : "",
      actions: Array.isArray(possibleTask.actions) ? possibleTask.actions as UstaadAction[] : [],
      timeOfDay: typeof possibleTask.timeOfDay === "string" ? possibleTask.timeOfDay : null,
      startAtIso: typeof possibleTask.startAtIso === "string" ? possibleTask.startAtIso : null,
      repeat: normalizeScheduleRepeat(possibleTask.repeat),
      isEnabled: possibleTask.isEnabled !== false,
      nextRunAtIso: typeof possibleTask.nextRunAtIso === "string" ? possibleTask.nextRunAtIso : null,
      lastRunAtIso: typeof possibleTask.lastRunAtIso === "string" ? possibleTask.lastRunAtIso : null,
    });
  }

  return sanitizedTasks;
}

export interface NewScheduledTask {
  name: string;
  kind: "reminder" | "routine";
  prompt: string;
  actions: UstaadAction[];
  timeOfDay: string | null;
  startAtIso: string | null;
  repeat: ScheduleRepeat;
}

/** Reminders, scheduled searches, and multi-step routines. */
export class ScheduleStore {
  private readonly fileStore: JsonFileStore<ScheduledTask[]>;
  private scheduledTasks: ScheduledTask[];

  constructor(filePath: string) {
    this.fileStore = new JsonFileStore(filePath, sanitizeScheduledTasks);
    this.scheduledTasks = this.fileStore.read();
  }

  list(): ScheduledTask[] {
    return [...this.scheduledTasks].sort((firstTask, secondTask) => {
      if (firstTask.isEnabled !== secondTask.isEnabled) {
        return firstTask.isEnabled ? -1 : 1;
      }
      return (firstTask.nextRunAtIso ?? "9999").localeCompare(secondTask.nextRunAtIso ?? "9999");
    });
  }

  add(newTask: NewScheduledTask, now: Date): ScheduledTask {
    const trimmedName = newTask.name.trim();
    if (!trimmedName) {
      throw new Error("A reminder or routine needs a name.");
    }

    const createdTask: ScheduledTask = {
      id: randomUUID(),
      name: trimmedName,
      kind: newTask.kind,
      prompt: newTask.prompt.trim(),
      actions: newTask.actions,
      timeOfDay: newTask.timeOfDay,
      startAtIso: newTask.startAtIso,
      repeat: newTask.repeat,
      isEnabled: true,
      nextRunAtIso: computeNextRunAtIso(
        {
          repeat: newTask.repeat,
          timeOfDay: newTask.timeOfDay,
          startAtIso: newTask.startAtIso,
        },
        now,
      ),
      lastRunAtIso: null,
    };

    if (!createdTask.nextRunAtIso) {
      throw new Error("That time is already in the past. Give me a future time for the reminder.");
    }

    this.scheduledTasks.push(createdTask);
    this.persist();
    return createdTask;
  }

  findMatches(query: string, limit = 5): Array<RankedTextMatch<ScheduledTask>> {
    return rankTextMatches(query, this.scheduledTasks, (scheduledTask) => scheduledTask.name, limit);
  }

  setEnabled(id: string, isEnabled: boolean, now: Date): ScheduledTask | null {
    return this.updateTask(id, (scheduledTask) => ({
      ...scheduledTask,
      isEnabled,
      nextRunAtIso: isEnabled
        ? computeNextRunAtIso(scheduledTask, now)
        : scheduledTask.nextRunAtIso,
    }));
  }

  remove(id: string): boolean {
    const remainingTasks = this.scheduledTasks.filter((scheduledTask) => scheduledTask.id !== id);
    if (remainingTasks.length === this.scheduledTasks.length) {
      return false;
    }
    this.scheduledTasks = remainingTasks;
    this.persist();
    return true;
  }

  removeMatching(query: string): ScheduledTask[] {
    const matchedTasks = this.findMatches(query).map((rankedMatch) => rankedMatch.item);
    if (!matchedTasks.length) {
      return [];
    }
    this.scheduledTasks = this.scheduledTasks.filter(
      (scheduledTask) => !matchedTasks.some((matchedTask) => matchedTask.id === scheduledTask.id),
    );
    this.persist();
    return matchedTasks;
  }

  /** Tasks whose next run has arrived, including ones missed during a shutdown. */
  listDueTasks(now: Date): ScheduledTask[] {
    return this.scheduledTasks.filter((scheduledTask) => isScheduledTaskDue(scheduledTask, now));
  }

  /** Rolls forward everything missed while Ustaad was not running. */
  rollForwardOverdueTasks(now: Date): ScheduledTask[] {
    const rolledForwardTasks: ScheduledTask[] = [];
    for (const scheduledTask of this.scheduledTasks) {
      if (scheduledTask.isEnabled && isScheduledTaskOverdueBeyondGrace(scheduledTask, now)) {
        const updatedTask = this.updateTask(scheduledTask.id, (currentTask) => ({
          ...currentTask,
          nextRunAtIso: computeNextRunAtIso(currentTask, now),
          isEnabled: currentTask.repeat !== "none",
        }));
        if (updatedTask) {
          rolledForwardTasks.push(updatedTask);
        }
      }
    }
    return rolledForwardTasks;
  }

  recordRun(id: string, now: Date): ScheduledTask | null {
    return this.updateTask(id, (scheduledTask) => {
      const nextRunAtIso = scheduledTask.repeat === "none"
        ? null
        : computeNextRunAtIso(scheduledTask, now);

      return {
        ...scheduledTask,
        nextRunAtIso,
        lastRunAtIso: formatLocalIso(now),
        // A one-shot reminder has done its job; keep it in the list, switched off.
        isEnabled: scheduledTask.repeat === "none" ? false : scheduledTask.isEnabled,
      };
    });
  }

  listNextRunsDescription(limit: number): string[] {
    return this.list()
      .filter((scheduledTask) => scheduledTask.isEnabled && scheduledTask.nextRunAtIso)
      .slice(0, limit)
      .map((scheduledTask) => `${scheduledTask.name} at ${scheduledTask.nextRunAtIso}`);
  }

  /** Recomputes every next-run stamp; used at startup after a timezone change. */
  refreshNextRuns(now: Date): void {
    let hasChanged = false;
    this.scheduledTasks = this.scheduledTasks.map((scheduledTask) => {
      if (!scheduledTask.isEnabled) {
        return scheduledTask;
      }

      const currentNextRunIsValid = scheduledTask.nextRunAtIso
        && parseLocalIsoDateTime(scheduledTask.nextRunAtIso) !== null;
      if (currentNextRunIsValid) {
        return scheduledTask;
      }

      hasChanged = true;
      return { ...scheduledTask, nextRunAtIso: computeNextRunAtIso(scheduledTask, now) };
    });

    if (hasChanged) {
      this.persist();
    }
  }

  private updateTask(
    id: string,
    updateScheduledTask: (scheduledTask: ScheduledTask) => ScheduledTask,
  ): ScheduledTask | null {
    const taskIndex = this.scheduledTasks.findIndex((scheduledTask) => scheduledTask.id === id);
    if (taskIndex === -1) {
      return null;
    }

    const updatedTask = updateScheduledTask(this.scheduledTasks[taskIndex]!);
    this.scheduledTasks = this.scheduledTasks.map(
      (scheduledTask, currentIndex) => (currentIndex === taskIndex ? updatedTask : scheduledTask),
    );
    this.persist();
    return updatedTask;
  }

  private persist(): void {
    this.fileStore.write(this.scheduledTasks);
  }
}
