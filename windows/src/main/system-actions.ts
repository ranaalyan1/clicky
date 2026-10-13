import { spawn } from "node:child_process";
import { clipboard, shell } from "electron";
import { ClickaaAction } from "../shared/contracts";
import { isAppChoiceAmbiguous, LaunchableApp } from "./app-name-matching";
import { buildSearchUrl } from "./web-search";
import { MemoryStore } from "./memory-store";
import { ScheduleStore } from "./schedule-store";
import { describeScheduledTask } from "./schedule-time";
import { StartMenuAppIndex } from "./start-menu-app-index";
import { SnippetStore } from "./snippet-store";
import { TodoStore } from "./todo-store";
import { ClickaaWindowsBridge } from "./windows-bridge";

export interface ActionChoice {
  label: string;
  action: ClickaaAction;
}

export interface ActionExecutionOutcome {
  status: "completed" | "failed" | "needs_choice";
  message: string;
  undoLabel: string | null;
  undo: (() => Promise<void> | void) | null;
  /** Extra detail for the activity feed, such as the text that was typed. */
  detail: string;
  choices: ActionChoice[];
}

export interface ActionExecutorDependencies {
  bridge: ClickaaWindowsBridge;
  appIndex: StartMenuAppIndex;
  todoStore: TodoStore;
  memoryStore: MemoryStore;
  scheduleStore: ScheduleStore;
  snippetStore: SnippetStore;
  openExternalUrl: (url: string) => Promise<void>;
  showNotification: (title: string, body: string) => void;
  showPanel: (page: string) => void;
  now: () => Date;
}

export function completedActionOutcome(message: string, detail = ""): ActionExecutionOutcome {
  return completedOutcome(message, detail);
}

export function failedActionOutcome(message: string): ActionExecutionOutcome {
  return failedOutcome(message);
}

function completedOutcome(message: string, detail = ""): ActionExecutionOutcome {
  return { status: "completed", message, detail, undoLabel: null, undo: null, choices: [] };
}

function failedOutcome(message: string): ActionExecutionOutcome {
  return { status: "failed", message, detail: "", undoLabel: null, undo: null, choices: [] };
}

/** Long text is pasted instead of typed, which is far quicker. */
const pasteInsteadOfTypingThreshold = 400;

/**
 * Executes one validated, already-approved action.
 *
 * Every Windows-specific step goes through the PowerShell helper, so a failure
 * always comes back as a readable sentence instead of an exception that could
 * interrupt a spoken reply.
 */
export class ClickaaActionExecutor {
  constructor(private readonly dependencies: ActionExecutorDependencies) {}

  async execute(action: ClickaaAction): Promise<ActionExecutionOutcome> {
    switch (action.type) {
      case "open_app":
        return this.openApp(action.name);
      case "open_url":
        return this.openUrl(action.url);
      case "search_web":
        return this.openUrl(buildSearchUrl(action.target, action.query), `searching ${action.target === "default" ? "the web" : action.target} for ${action.query}`);
      case "type_text":
        return this.typeText(action.text);
      case "press_keys":
        return this.pressKeys(action.keys);
      case "clipboard_write":
        return this.writeClipboard(action.text);
      case "volume":
        return this.controlVolume(action.operation, action.level);
      case "media":
        return this.controlMedia(action.operation);
      case "window":
        return this.controlWindow(action.operation, action.app);
      case "notify":
        this.dependencies.showNotification(action.title, action.body);
        return completedOutcome(`showed "${action.title}"`);
      case "scroll":
        await this.dependencies.bridge.send({
          command: "scroll",
          direction: action.direction,
          amount: action.amount,
        });
        return completedOutcome(`scrolled ${action.direction}`);
      case "todo_add": {
        const createdItem = this.dependencies.todoStore.add(action.text, action.dueAt);
        return completedOutcome(
          createdItem.dueAt ? `added "${createdItem.text}" due ${createdItem.dueAt}` : `added "${createdItem.text}" to your list`,
        );
      }
      case "todo_complete": {
        const completedItems = this.dependencies.todoStore.completeMatching(action.text);
        return completedItems.length
          ? completedOutcome(`ticked off ${completedItems.map((todoItem) => `"${todoItem.text}"`).join(", ")}`)
          : failedOutcome(`I could not find "${action.text}" on your list`);
      }
      case "todo_remove": {
        const removedItems = this.dependencies.todoStore.removeMatching(action.text);
        return removedItems.length
          ? completedOutcome(`removed ${removedItems.map((todoItem) => `"${todoItem.text}"`).join(", ")}`)
          : failedOutcome(`I could not find "${action.text}" on your list`);
      }
      case "schedule_add":
        return this.addSchedule(action.name, action.prompt, action.startAt, action.repeat);
      case "routine_add":
        return this.addRoutine(action.name, action.timeOfDay, action.repeat, action.actions);
      case "remember": {
        const rememberedFact = this.dependencies.memoryStore.add(action.fact);
        return completedOutcome(`remembered: ${rememberedFact.text}`);
      }
      case "forget": {
        const forgottenFacts = this.dependencies.memoryStore.forgetMatching(action.query);
        return forgottenFacts.length
          ? completedOutcome(`forgot ${forgottenFacts.length} ${forgottenFacts.length === 1 ? "note" : "notes"} about ${action.query}`)
          : failedOutcome(`I had nothing stored about ${action.query}`);
      }
      case "wallpaper":
        return this.changeWallpaper(action.operation, action.path, action.color);
      case "snippet_save":
        return this.saveSnippet(action.name, action.text);
      case "snippet_insert":
        return this.insertSnippet(action.name);
      case "open_panel":
        this.dependencies.showPanel(action.page);
        return completedOutcome("opened the Clickaa panel");
      /* Timers and clipboard rewrites need state the controller owns; it runs
         them before the executor is ever reached. */
      case "timer_start":
      case "timer_cancel":
      case "screenshot_region":
      case "clipboard_transform":
        return failedOutcome("that action is handled by Clickaa itself");
      default:
        return failedOutcome("that action is not supported yet");
    }
  }

  private saveSnippet(snippetName: string, snippetText: string): ActionExecutionOutcome {
    const savedSnippet = this.dependencies.snippetStore.save(snippetName, snippetText);
    const preview = savedSnippet.text.replace(/\s+/gu, " ").slice(0, 120);
    return {
      status: "completed",
      message: `saved the "${savedSnippet.name}" snippet`,
      detail: preview,
      undoLabel: `delete the "${savedSnippet.name}" snippet`,
      undo: () => {
        this.dependencies.snippetStore.remove(savedSnippet.id);
      },
      choices: [],
    };
  }

  private async insertSnippet(snippetName: string): Promise<ActionExecutionOutcome> {
    const lookupResult = this.dependencies.snippetStore.resolveForInsert(snippetName);
    if (!lookupResult.snippet) {
      return failedOutcome(lookupResult.message || `I could not find a snippet called "${snippetName}".`);
    }

    // Inserting is typing: it goes through exactly the same path, so it lands in
    // the focused window and offers the same undo.
    const typingOutcome = await this.typeText(lookupResult.snippet.text);
    if (typingOutcome.status !== "completed") {
      return typingOutcome;
    }
    return {
      ...typingOutcome,
      message: `typed the "${lookupResult.snippet.name}" snippet`,
    };
  }

  private async openApp(spokenAppName: string): Promise<ActionExecutionOutcome> {
    const matchedApps = this.dependencies.appIndex.findMatches(spokenAppName, 4);
    if (!matchedApps.length) {
      return failedOutcome(`I could not find an app called "${spokenAppName}". check the island's app grid to see what I can launch.`);
    }

    if (isAppChoiceAmbiguous(matchedApps.map((matchedApp, matchIndex) => ({
      item: matchedApp,
      // The index already ranked by score; keep that ranking for the ambiguity test.
      score: 900 - matchIndex * 10,
    })))) {
      return {
        status: "needs_choice",
        message: `which one did you mean by "${spokenAppName}"?`,
        detail: "",
        undoLabel: null,
        undo: null,
        choices: matchedApps.map((matchedApp) => ({
          label: matchedApp.name,
          action: { type: "open_app", name: matchedApp.name },
        })),
      };
    }

    const launchedApp = matchedApps[0]!;
    await this.launchApp(launchedApp);
    return completedOutcome(`opened ${launchedApp.name}`);
  }

  private async launchApp(launchableApp: LaunchableApp): Promise<void> {
    if (launchableApp.source === "uwp") {
      // Store apps can only be started through their Application User Model ID.
      spawn("explorer.exe", [`shell:AppsFolder\\${launchableApp.launchTarget}`], {
        windowsHide: true,
        detached: true,
        stdio: "ignore",
      }).unref();
      return;
    }

    const launchError = await shell.openPath(launchableApp.launchTarget);
    if (launchError) {
      throw new Error(launchError);
    }
  }

  private async openUrl(url: string, successMessage?: string): Promise<ActionExecutionOutcome> {
    await this.dependencies.openExternalUrl(url);
    return completedOutcome(successMessage ?? `opened ${url}`);
  }

  private async typeText(text: string): Promise<ActionExecutionOutcome> {
    await this.moveFocusAwayFromSystemSurfaces();

    if (text.length > pasteInsteadOfTypingThreshold) {
      const previousClipboardText = await clipboard.readText();
      await clipboard.writeText(text);
      await this.dependencies.bridge.send({ command: "send_keys", keys: "ctrl+v" });
      return {
        status: "completed",
        message: `pasted ${text.length} characters`,
        detail: text.slice(0, 200),
        undoLabel: "put my clipboard back",
        undo: () => clipboard.writeText(previousClipboardText),
        choices: [],
      };
    }

    await this.dependencies.bridge.send({ command: "type_unicode", text });
    return {
      ...completedOutcome(`typed ${text.length} characters`),
      detail: text.slice(0, 200),
    };
  }

  private async pressKeys(keys: string): Promise<ActionExecutionOutcome> {
    await this.moveFocusAwayFromSystemSurfaces();
    await this.dependencies.bridge.send({ command: "send_keys", keys });
    return completedOutcome(`pressed ${keys}`);
  }

  private async writeClipboard(text: string): Promise<ActionExecutionOutcome> {
    const previousClipboardText = await clipboard.readText();
    await clipboard.writeText(text);
    return {
      status: "completed",
      message: "copied that to your clipboard",
      detail: text.slice(0, 200),
      undoLabel: "put my clipboard back",
      undo: () => clipboard.writeText(previousClipboardText),
      choices: [],
    };
  }

  private async controlVolume(
    operation: "up" | "down" | "mute" | "unmute" | "set",
    level: number | null,
  ): Promise<ActionExecutionOutcome> {
    if (operation === "set") {
      const appliedLevel = await this.dependencies.bridge.send<{ level: number }>({
        command: "volume",
        operation: "set",
        level: level ?? 50,
      });
      return completedOutcome(`set the volume to ${appliedLevel.level ?? level ?? 50} percent`);
    }

    await this.dependencies.bridge.send({ command: "volume", operation });
    const volumeDescription: Record<"up" | "down" | "mute" | "unmute", string> = {
      up: "turned the volume up",
      down: "turned the volume down",
      mute: "muted the sound",
      unmute: "unmuted the sound",
    };
    return completedOutcome(volumeDescription[operation]);
  }

  private async controlMedia(
    operation: "play_pause" | "next" | "previous" | "stop",
  ): Promise<ActionExecutionOutcome> {
    await this.dependencies.bridge.send({ command: "media", operation });
    const mediaDescription: Record<"play_pause" | "next" | "previous" | "stop", string> = {
      play_pause: "toggled playback",
      next: "skipped to the next track",
      previous: "went back a track",
      stop: "stopped the music",
    };
    return completedOutcome(mediaDescription[operation]);
  }

  private async controlWindow(
    operation: "minimize" | "maximize" | "restore" | "close" | "focus",
    appName: string,
  ): Promise<ActionExecutionOutcome> {
    const windowResult = await this.dependencies.bridge.send<{ window: string }>({
      command: "window_control",
      operation,
      app: appName,
    });
    const windowLabel = windowResult.window ? `"${windowResult.window}"` : appName;
    const windowDescription: Record<"minimize" | "maximize" | "restore" | "close" | "focus", string> = {
      minimize: `minimised ${windowLabel}`,
      maximize: `maximised ${windowLabel}`,
      restore: `restored ${windowLabel}`,
      close: `closed ${windowLabel}`,
      focus: `switched to ${windowLabel}`,
    };
    return completedOutcome(windowDescription[operation]);
  }

  private addSchedule(
    name: string,
    prompt: string,
    startAtIso: string,
    repeat: "none" | "daily" | "weekdays" | "weekends",
  ): ActionExecutionOutcome {
    const now = this.dependencies.now();
    const createdTask = this.dependencies.scheduleStore.add({
      name,
      kind: "reminder",
      prompt,
      actions: [],
      timeOfDay: repeat === "none" ? null : startAtIso.slice(11, 16),
      startAtIso,
      repeat,
    }, now);
    return completedOutcome(
      `scheduled ${createdTask.name} for ${createdTask.nextRunAtIso?.replace("T", " at ")} (${describeScheduledTask(createdTask)})`,
    );
  }

  private addRoutine(
    name: string,
    timeOfDay: string,
    repeat: "none" | "daily" | "weekdays" | "weekends",
    routineActions: ClickaaAction[],
  ): ActionExecutionOutcome {
    const createdTask = this.dependencies.scheduleStore.add({
      name,
      kind: "routine",
      prompt: name,
      actions: routineActions,
      timeOfDay,
      startAtIso: null,
      repeat: repeat === "none" ? "daily" : repeat,
    }, this.dependencies.now());

    return completedOutcome(
      `created the routine ${createdTask.name} at ${timeOfDay} (${routineActions.length} steps)`,
    );
  }

  private async changeWallpaper(
    operation: "set" | "solid" | "refresh",
    path: string | null,
    color: string | null,
  ): Promise<ActionExecutionOutcome> {
    if (operation === "set" && path) {
      await this.dependencies.bridge.send({ command: "wallpaper", path, style: 10 });
      return completedOutput("changed your wallpaper");
    }

    if (operation === "solid" && color) {
      await this.dependencies.bridge.send({ command: "wallpaper_solid", color });
      return completedOutput(`set a ${color} wallpaper`);
    }

    // Windows has no supported "shuffle" hook, so the honest answer is to open
    // the personalisation page instead of pretending we changed something.
    await this.dependencies.openExternalUrl("ms-settings:personalization-background");
    return completedOutput("opened the Windows wallpaper settings");
  }

  /**
   * The Start menu and Windows search steal typed characters. When one of them
   * is in front, dismiss it first so the user's text lands where they expect.
   */
  private async moveFocusAwayFromSystemSurfaces(): Promise<void> {
    if (!this.dependencies.bridge.isSupported) {
      return;
    }

    try {
      const foregroundWindow = await this.dependencies.bridge.readForegroundWindow();
      const foregroundProcessName = foregroundWindow.processName.toLowerCase();
      const isSystemSurface = ["startmenuexperiencehost", "shellexperiencehost", "searchapp", "searchui", "textinputhost"]
        .some((systemProcessName) => foregroundProcessName.includes(systemProcessName));
      if (isSystemSurface) {
        await this.dependencies.bridge.send({ command: "send_keys", keys: "escape" });
      }
    } catch (error) {
      console.warn("Clickaa could not check which window has focus:", error);
    }
  }
}

function completedOutput(message: string): ActionExecutionOutcome {
  return completedOutcome(message);
}
