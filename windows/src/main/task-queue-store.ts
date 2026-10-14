import { randomUUID } from "node:crypto";
import { QueuedTask, QueuedTaskStatus, UstaadAction } from "../shared/contracts";
import { JsonFileStore } from "./json-file-store";

const maximumStoredTasks = 20;
const maximumFinishedTasks = 5;
const maximumGoalLength = 300;
const maximumNoteLength = 160;
const maximumSeedActionsPerTask = 12;

const knownStatuses: QueuedTaskStatus[] = ["waiting", "running", "done", "failed", "cancelled"];

function sanitizeStatus(storedStatus: unknown): QueuedTaskStatus {
  return typeof storedStatus === "string" && (knownStatuses as string[]).includes(storedStatus)
    ? storedStatus as QueuedTaskStatus
    : "waiting";
}

function sanitizeTasks(storedTasks: unknown): QueuedTask[] {
  if (!Array.isArray(storedTasks)) {
    return [];
  }

  const sanitizedTasks: QueuedTask[] = [];
  for (const possibleTask of storedTasks) {
    if (!possibleTask || typeof possibleTask !== "object") {
      continue;
    }

    const taskRecord = possibleTask as Partial<QueuedTask>;
    const goal = typeof taskRecord.goal === "string" ? taskRecord.goal.trim() : "";
    if (!goal) {
      continue;
    }

    // A task caught mid-run by a restart is not running any more: nothing on the
    // user's desktop should be retried just because the app came back.
    const storedStatus = sanitizeStatus(taskRecord.status);
    const isInterrupted = storedStatus === "running";

    sanitizedTasks.push({
      id: typeof taskRecord.id === "string" && taskRecord.id ? taskRecord.id : randomUUID(),
      goal: goal.slice(0, maximumGoalLength),
      seedActions: Array.isArray(taskRecord.seedActions)
        ? (taskRecord.seedActions as UstaadAction[]).slice(0, maximumSeedActionsPerTask)
        : [],
      status: isInterrupted ? "cancelled" : storedStatus,
      createdAtIso: typeof taskRecord.createdAtIso === "string"
        ? taskRecord.createdAtIso
        : new Date().toISOString(),
      finishedAtIso: typeof taskRecord.finishedAtIso === "string" ? taskRecord.finishedAtIso : null,
      note: isInterrupted
        ? "ustaad closed before this one started"
        : (typeof taskRecord.note === "string" ? taskRecord.note.slice(0, maximumNoteLength) : ""),
    });
  }

  return trimTasks(sanitizedTasks);
}

/**
 * Keeps the waiting work, and only the last few things that already happened.
 *
 * Order is never reshuffled here: the queue runs oldest first, and a task that
 * started earlier must never be reordered behind one that has not started yet.
 * Finished entries are dropped by id rather than by slicing, because slicing a
 * filtered list is how "the last five" quietly becomes "the first five".
 */
function trimTasks(tasks: QueuedTask[]): QueuedTask[] {
  const finishedTasks = tasks.filter((task) => task.status !== "waiting" && task.status !== "running");
  const droppedTaskIds = new Set(
    finishedTasks
      .slice(0, Math.max(0, finishedTasks.length - maximumFinishedTasks))
      .map((finishedTask) => finishedTask.id),
  );
  return tasks
    .filter((task) => !droppedTaskIds.has(task.id))
    .slice(-maximumStoredTasks);
}

/**
 * The work waiting its turn.
 *
 * Ustaad has one screen, one pointer and one keyboard, so two tasks cannot
 * genuinely run at once — a second one would fight the first for the same
 * window. What the queue buys is that "do this, then that" is not dropped on
 * the floor: the second request waits, is shown while it waits, and starts the
 * moment the first one ends.
 */
export class TaskQueueStore {
  private readonly fileStore: JsonFileStore<QueuedTask[]>;
  private tasks: QueuedTask[];

  constructor(filePath: string) {
    this.fileStore = new JsonFileStore(filePath, sanitizeTasks);
    this.tasks = this.fileStore.read();
  }

  list(): QueuedTask[] {
    return [...this.tasks];
  }

  /** The tasks that have not run yet, oldest first — the order they will run in. */
  waiting(): QueuedTask[] {
    return this.tasks.filter((task) => task.status === "waiting");
  }

  enqueue(draft: { goal: string; seedActions: UstaadAction[] }): QueuedTask {
    const goal = draft.goal.trim().slice(0, maximumGoalLength);
    if (!goal) {
      throw new Error("There is nothing to queue without a goal.");
    }

    const queuedTask: QueuedTask = {
      id: randomUUID(),
      goal,
      seedActions: draft.seedActions.slice(0, maximumSeedActionsPerTask),
      status: "waiting",
      createdAtIso: new Date().toISOString(),
      finishedAtIso: null,
      note: "",
    };

    this.tasks = trimTasks([...this.tasks, queuedTask]);
    this.persist();
    return queuedTask;
  }

  /** Takes the oldest waiting task and marks it as the one running now. */
  takeNext(): QueuedTask | null {
    const nextTask = this.tasks.find((task) => task.status === "waiting") ?? null;
    if (!nextTask) {
      return null;
    }

    const runningTask: QueuedTask = { ...nextTask, status: "running" };
    this.tasks = this.tasks.map((task) => (task.id === nextTask.id ? runningTask : task));
    this.persist();
    return runningTask;
  }

  finish(taskId: string, status: "done" | "failed" | "cancelled", note: string): QueuedTask | null {
    let finishedTask: QueuedTask | null = null;
    this.tasks = trimTasks(this.tasks.map((task) => {
      if (task.id !== taskId) {
        return task;
      }
      finishedTask = {
        ...task,
        status,
        note: note.trim().slice(0, maximumNoteLength),
        finishedAtIso: new Date().toISOString(),
      };
      return finishedTask;
    }));
    if (finishedTask) {
      this.persist();
    }
    return finishedTask;
  }

  /** Drops one waiting task. A running task is stopped, not dropped. */
  cancel(taskId: string): QueuedTask | null {
    const task = this.tasks.find((candidateTask) => candidateTask.id === taskId) ?? null;
    if (!task || task.status === "running") {
      return null;
    }
    return this.finish(taskId, "cancelled", "you took it off the list");
  }

  /** Everything still waiting, for the panic hotkey and the "clear" button. */
  cancelWaiting(): number {
    const waitingTasks = this.waiting();
    for (const waitingTask of waitingTasks) {
      this.finish(waitingTask.id, "cancelled", "you cleared the list");
    }
    return waitingTasks.length;
  }

  private persist(): void {
    this.fileStore.write(this.tasks);
  }
}
