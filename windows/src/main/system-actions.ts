import { spawn } from "node:child_process";
import { clipboard, shell } from "electron";
import { AbilitySettings, CapturedDisplayImage, UstaadAction } from "../shared/contracts";
import { isAppChoiceAmbiguous, LaunchableApp } from "./app-name-matching";
import { buildSearchUrl } from "./web-search";
import { MemoryStore } from "./memory-store";
import { ScheduleStore } from "./schedule-store";
import { describeScheduledTask } from "./schedule-time";
import { StartMenuAppIndex } from "./start-menu-app-index";
import { AuditLogStore } from "./audit-log-store";
import { SnippetStore } from "./snippet-store";
import { decideSystemAccess } from "./system-access";
import { SystemAccessRunner } from "./system-access-runner";
import { TodoStore } from "./todo-store";
import { mapImageCoordinateToWindowsDesktop, selectPointingDisplay } from "./pointing";
import { UstaadWindowsBridge } from "./windows-bridge";

export interface ActionChoice {
  label: string;
  action: UstaadAction;
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
  bridge: UstaadWindowsBridge;
  appIndex: StartMenuAppIndex;
  todoStore: TodoStore;
  memoryStore: MemoryStore;
  scheduleStore: ScheduleStore;
  snippetStore: SnippetStore;
  auditLogStore: AuditLogStore;
  systemAccessRunner: SystemAccessRunner;
  /** The user's ability switches, read fresh for every system-access decision. */
  readAbilities: () => AbilitySettings;
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
export class UstaadActionExecutor {
  /**
   * The screenshots the model was shown for the current request. Clicks are
   * expressed in that pixel space, so this is what makes them land correctly.
   */
  private clickCoordinateSpace: CapturedDisplayImage[] = [];
  constructor(private readonly dependencies: ActionExecutorDependencies) {}

  /**
   * Tells the executor which screenshots a click's coordinates came from. The
   * controller calls this for every request that carries screenshots.
   */
  setClickCoordinateSpace(capturedDisplays: CapturedDisplayImage[]): void {
    this.clickCoordinateSpace = capturedDisplays;
  }

  async execute(action: UstaadAction): Promise<ActionExecutionOutcome> {
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
      case "click_at":
        return this.clickAt(action);
      case "run_command":
        return this.runCommand(action.command, action.reason);
      case "manage_file":
        return this.manageFile(action);
      case "read_registry":
        return this.readRegistry(action.path, action.valueName);
      case "wait":
        await new Promise((resolve) => setTimeout(resolve, action.seconds * 1_000));
        return completedOutcome(`waited ${action.seconds} seconds`);
      case "snippet_save":
        return this.saveSnippet(action.name, action.text);
      case "snippet_insert":
        return this.insertSnippet(action.name);
      case "open_panel":
        this.dependencies.showPanel(action.page);
        return completedOutcome("opened the Ustaad panel");
      /* Timers and clipboard rewrites need state the controller owns; it runs
         them before the executor is ever reached. */
      case "timer_start":
      case "timer_cancel":
      case "screenshot_region":
      case "clipboard_transform":
        return failedOutcome("that action is handled by Ustaad itself");
      default:
        return failedOutcome("that action is not supported yet");
    }
  }

  /**
   * Clicks a point the model picked out of a screenshot. Ustaad hands the very
   * captures the model saw to setClickCoordinateSpace, so those pixels map back
   * onto the right monitor at the right scale.
   */
  private async clickAt(action: Extract<UstaadAction, { type: "click_at" }>): Promise<ActionExecutionOutcome> {
    const capturedDisplays = this.clickCoordinateSpace;
    if (!capturedDisplays.length) {
      return failedOutcome("I do not have a screenshot to place that click on.");
    }

    const targetDisplay = selectPointingDisplay(capturedDisplays, action.screenNumber);
    if (!targetDisplay) {
      return failedOutcome("I could not work out which screen that click belongs to.");
    }

    const screenPoint = mapImageCoordinateToWindowsDesktop({ x: action.x, y: action.y }, targetDisplay);
    try {
      await this.dependencies.bridge.clickAtScreenPoint(screenPoint);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return failedOutcome(`I could not click there: ${errorMessage}`);
    }

    return completedOutcome(`clicked ${action.label}`);
  }

  /* ---------------------------------------------------------------------- */
  /* System access                                                          */
  /* ---------------------------------------------------------------------- */

  private currentAbilities(): AbilitySettings {
    return this.dependencies.readAbilities();
  }

  private async runCommand(rawCommand: string, reason: string): Promise<ActionExecutionOutcome> {
    const decision = decideSystemAccess({
      request: { kind: "command", command: rawCommand },
      abilities: this.currentAbilities(),
    });

    if (!decision.allowed) {
      this.dependencies.auditLogStore.record({
        summary: `refused: ${reason}`,
        detail: rawCommand,
        tier: decision.tier,
        outcome: decision.tier === "blocked" ? "blocked" : "refused",
        resultPreview: decision.message,
      });
      return failedOutcome(decision.message);
    }

    let runResult;
    try {
      runResult = await this.dependencies.systemAccessRunner.runPowerShell(rawCommand);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.dependencies.auditLogStore.record({
        summary: `failed: ${reason}`,
        detail: rawCommand,
        tier: decision.tier,
        outcome: "failed",
        resultPreview: errorMessage,
      });
      return failedOutcome(`that command did not run: ${errorMessage}`);
    }

    const outputPreview = [runResult.standardOutput, runResult.standardError]
      .filter(Boolean)
      .join("\n")
      .trim();

    this.dependencies.auditLogStore.record({
      summary: reason,
      detail: rawCommand,
      tier: decision.tier,
      outcome: "allowed",
      resultPreview: outputPreview,
    });

    if (runResult.timedOut) {
      return failedOutcome("that command was still running after twenty seconds, so I stopped it.");
    }
    if (runResult.exitCode !== 0 && !outputPreview) {
      return failedOutcome(`that command finished with code ${runResult.exitCode}.`);
    }
    return {
      status: "completed",
      message: reason,
      detail: outputPreview || "the command produced no output",
      undoLabel: null,
      undo: null,
      choices: [],
    };
  }

  private async manageFile(action: Extract<UstaadAction, { type: "manage_file" }>): Promise<ActionExecutionOutcome> {
    const decision = decideSystemAccess({
      request: { kind: "file", path: action.path, operation: action.operation },
      abilities: this.currentAbilities(),
    });

    if (!decision.allowed) {
      this.dependencies.auditLogStore.record({
        summary: `refused: ${action.operation} ${action.path}`,
        detail: action.path,
        tier: decision.tier,
        outcome: decision.tier === "blocked" ? "blocked" : "refused",
        resultPreview: decision.message,
      });
      return failedOutcome(decision.message);
    }

    try {
      if (action.operation === "read") {
        const fileContents = await this.dependencies.systemAccessRunner.readTextFile(action.path);
        this.dependencies.auditLogStore.record({
          summary: `read ${action.path}`,
          detail: action.path,
          tier: decision.tier,
          outcome: "allowed",
          resultPreview: fileContents.slice(0, 600),
        });
        return {
          status: "completed",
          message: `read ${action.path}`,
          detail: fileContents.slice(0, 600),
          undoLabel: null,
          undo: null,
          choices: [],
        };
      }

      if (action.operation === "list") {
        const listOutput = await this.dependencies.systemAccessRunner.runPowerShell(
          `Get-ChildItem -LiteralPath '${action.path.replace(/'/gu, "''")}' | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize`,
        );
        this.dependencies.auditLogStore.record({
          summary: `listed ${action.path}`,
          detail: action.path,
          tier: decision.tier,
          outcome: "allowed",
          resultPreview: listOutput.standardOutput.slice(0, 600),
        });
        return {
          status: "completed",
          message: `listed ${action.path}`,
          detail: listOutput.standardOutput.slice(0, 600) || "that folder is empty",
          undoLabel: null,
          undo: null,
          choices: [],
        };
      }

      await this.dependencies.systemAccessRunner.writeTextFile(action.path, action.content);
      this.dependencies.auditLogStore.record({
        summary: `wrote ${action.path}`,
        detail: `${action.path}\n\n${action.content.slice(0, 1_000)}`,
        tier: decision.tier,
        outcome: "allowed",
        resultPreview: `${action.content.length} characters written`,
      });
      return completedOutcome(`wrote ${action.path}`, `${action.content.length} characters`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.dependencies.auditLogStore.record({
        summary: `failed: ${action.operation} ${action.path}`,
        detail: action.path,
        tier: decision.tier,
        outcome: "failed",
        resultPreview: errorMessage,
      });
      return failedOutcome(`I could not ${action.operation} that file: ${errorMessage}`);
    }
  }

  private async readRegistry(
    registryPath: string,
    valueName: string | null,
  ): Promise<ActionExecutionOutcome> {
    const decision = decideSystemAccess({
      request: { kind: "registry", path: registryPath },
      abilities: this.currentAbilities(),
    });

    if (!decision.allowed) {
      this.dependencies.auditLogStore.record({
        summary: `refused: read ${registryPath}`,
        detail: registryPath,
        tier: decision.tier,
        outcome: decision.tier === "blocked" ? "blocked" : "refused",
        resultPreview: decision.message,
      });
      return failedOutcome(decision.message);
    }

    const escapedPath = registryPath.replace(/'/gu, "''");
    const registryQuery = valueName
      ? `Get-ItemProperty -LiteralPath '${escapedPath}' -Name '${valueName.replace(/'/gu, "''")}' | Format-List`
      : `Get-ItemProperty -LiteralPath '${escapedPath}' | Format-List`;

    try {
      const queryResult = await this.dependencies.systemAccessRunner.runPowerShell(registryQuery);
      const registryOutput = queryResult.standardOutput.trim();
      this.dependencies.auditLogStore.record({
        summary: `read ${registryPath}${valueName ? ` (${valueName})` : ""}`,
        detail: registryPath,
        tier: decision.tier,
        outcome: "allowed",
        resultPreview: registryOutput.slice(0, 600),
      });
      return {
        status: "completed",
        message: `read ${registryPath}`,
        detail: registryOutput.slice(0, 600) || "that key has no values to show",
        undoLabel: null,
        undo: null,
        choices: [],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return failedOutcome(`I could not read that key: ${errorMessage}`);
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
    routineActions: UstaadAction[],
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
      console.warn("Ustaad could not check which window has focus:", error);
    }
  }
}

function completedOutput(message: string): ActionExecutionOutcome {
  return completedOutcome(message);
}
