import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { app, clipboard, ClipboardItem, nativeImage, shell } from "electron";
import {
  ActiveTimer,
  BrainConnectionTestResult,
  CapturedDisplayImage,
  UstaadAction,
  UstaadPublicState,
  UstaadUserConfig,
  InteractionKind,
  IslandState,
  ClipboardTransformOperation,
  IslandToggleKey,
  NowPlayingInfo,
  RegionSelectorSelection,
  PhoneBridgeInfo,
  PhoneBridgeStatus,
  GeneratedPicture,
  QueuedTask,
  RunHistoryEntry,
  RunHistorySearchResult,
  RunOutcome,
  Skill,
  SkillRepairSurface,
  WakeWordSurfaceState,
} from "../shared/contracts";
import {
  actionNeedsConfirmation,
  describeActions,
  filterActionsByAbilities,
  parseModelResponse,
} from "./action-protocol";
import { ActivityFeed, MemoryStore } from "./memory-store";
import { RunHistoryStore } from "./run-history-store";
import { PhoneBridgeStore } from "./phone-bridge-store";
import { PhoneBridgeServer } from "./phone-bridge-server";
import { AudioRecordingBuffer } from "./audio-recording-buffer";
import { BrainRouter } from "./brain-router";
import {
  ActionExecutionOutcome,
  completedActionOutcome,
  completedActionOutcomeWithUndo,
  UstaadActionExecutor,
  failedActionOutcome,
} from "./system-actions";
import { pictureFolderName, picturePreviewWidth, resolvePictureFileName } from "./image-generation";
import { ClipboardHistoryStore } from "./clipboard-history-store";
import { ConfirmationQueue, interpretConfirmationAnswer } from "./confirmation-queue";
import { UstaadConfigStore } from "./config-store";
import { UstaadDesktopWindows } from "./desktop-windows";
import {
  buildScheduledTaskPrompt,
  shouldSkipDictationCleanup,
  stripDictationCleanupWrappers,
} from "./dictation-prompts";
import { formatClockTime, formatFriendlyDateTime, formatLocalIso } from "./local-time";
import { captureWindowsDesktopRegionPng } from "./screen-capture";
import { WakeWordDetection, WakeWordListener, WakeWordListenerState } from "./wake-word-listener";
import {
  AgentLoopLookResult,
  buildAgentLookPrompt,
  UstaadAgentLoop,
  defaultAgentLoopBudget,
  parseAgentLookResponse,
} from "./agent-loop";
import { ShortcutId } from "./shortcut-registry";
import { mapImageCoordinateToWindowsDesktop, parsePointingTag, selectPointingDisplay } from "./pointing";
import { ScheduleStore } from "./schedule-store";
import { PresenceStore } from "./presence-store";
import {
  describeNextPresenceCheckIn,
  findDuePresenceCheckIns,
  type DuePresenceCheckIn,
} from "./presence-schedule";
import { buildBriefingDigest } from "./briefing";
import { AuditLogStore } from "./audit-log-store";
import { JsonFileStore } from "./json-file-store";
import { SkillStore } from "./skill-store";
import { TaskQueueStore } from "./task-queue-store";
import {
  buildSkillRepairPrompt,
  isSkillFailure,
  parseSkillRepairReply,
  shouldOfferSkillRepair,
} from "./skill-repair";
import { SnippetStore } from "./snippet-store";
import {
  SkillSuggestion,
  suggestSkill,
  taskSignature,
  TaskHistoryEntry,
  trimTaskHistory,
} from "./skill-suggestions";
import { SystemAccessRunner } from "./system-access-runner";
import { captureAllWindowsDisplays, captureWindowsDesktopRegion } from "./screen-capture";
import { describeScheduledTask } from "./schedule-time";
import { dictationShortcutLabels, shortcutLabels } from "./shortcut-registry";
import { StartMenuAppIndex } from "./start-menu-app-index";
import { buildSystemPrompt } from "./system-prompt";
import { TodoStore } from "./todo-store";
import { AssemblyAITranscriptionSession } from "./transcription-session";
import { UstaadWindowsBridge } from "./windows-bridge";

const conversationHistoryLimit = 10;
const schedulerTickMilliseconds = 20_000;
const clipboardPollMilliseconds = 900;
const nowPlayingPollMilliseconds = 3_000;
const confirmationTimeoutMilliseconds = 45_000;

/**
 * How long the listening window after the wake word stays open. The first
 * number is generous enough for "Ustaad ..." pauses, and the last two stop
 * Ustaad from holding the microphone open when the name was a false start.
 */
/** What Ustaad remembers between runs in order to offer skills at the right time. */
interface SkillSuggestionMemory {
  history: TaskHistoryEntry[];
  declinedSignatures: Record<string, number>;
}

const wakeFollowUpSilenceWindows = {
  speechLevel: 0.08,
  afterSpeech: 1_800,
  noSpeech: 4_000,
  maximum: 15_000,
};

interface UndoableAction {
  label: string;
  run: () => Promise<void> | void;
}

/**
 * Ustaad's orchestrator: it owns every interaction the user can have with
 * Ustaad (talking, dictating, circling, and scheduled tasks) and every piece
 * of state the panel and the island render.
 */
export class UstaadController {
  private readonly brainRouter = new BrainRouter();
  private readonly bridge: UstaadWindowsBridge;
  private readonly appIndex: StartMenuAppIndex;
  private readonly todoStore: TodoStore;
  private readonly memoryStore: MemoryStore;
  private readonly runHistoryStore: RunHistoryStore;
  private readonly phoneBridgeStore: PhoneBridgeStore;
  private phoneBridgeServer: PhoneBridgeServer | null = null;
  private phoneBridgeErrorMessage: string | null = null;
  private readonly scheduleStore: ScheduleStore;
  private readonly presenceStore: PresenceStore;
  private readonly snippetStore: SnippetStore;
  private readonly auditLogStore: AuditLogStore;
  private readonly skillStore: SkillStore;
  private readonly taskQueueStore: TaskQueueStore;
  /**
   * The last picture drawn, held in memory rather than on disk: it is a
   * result the user is looking at, not something to restore next launch.
   */
  private drawnPicture: GeneratedPicture | null = null;
  /** The queue entry the running task came from, so its outcome can be filed. */
  private currentQueuedTaskId: string | null = null;
  private readonly systemAccessRunner: SystemAccessRunner;
  private readonly clipboardHistoryStore: ClipboardHistoryStore;
  private readonly activityFeed = new ActivityFeed();
  private readonly confirmationQueue = new ConfirmationQueue();
  private readonly actionExecutor: UstaadActionExecutor;
  private readonly undoableActions = new Map<string, UndoableAction>();
  private readonly conversationHistory: Array<{ userTranscript: string; assistantResponse: string }> = [];

  private publicState: UstaadPublicState;
  private islandState: IslandState | null = null;
  private isIslandCurrentlyExpanded = false;

  private activeInteractionId = 0;
  private activeInteractionKind: InteractionKind | null = null;
  private readonly heldShortcutIds = new Set<"talk" | "dictation" | "circle">();
  private activeTranscriptionSession: AssemblyAITranscriptionSession | null = null;
  private interactionAbortController: AbortController | null = null;
  private responseAbortController: AbortController | null = null;
  private recordedAudioBuffer: AudioRecordingBuffer | null = null;
  private activeDictationStage: UstaadPublicState["dictationStage"] = "idle";
  private selectedCircleRegion: RegionSelectorSelection | null = null;
  private lastPointingTargets: CapturedDisplayImage[] = [];

  private audioPlaybackInteractionId: number | null = null;
  private pointingInteractionId: number | null = null;
  private transientOverlayHideTimer: NodeJS.Timeout | null = null;
  private schedulerTimer: NodeJS.Timeout | null = null;
  private clipboardPollTimer: NodeJS.Timeout | null = null;
  private nowPlayingTimer: NodeJS.Timeout | null = null;
  private lastClipboardText = "";
  private activeTimers: ActiveTimer[] = [];
  private isSnipInFlight = false;
  /** Successful tasks, so Ustaad can notice when the user keeps asking for one. */
  private taskHistory: TaskHistoryEntry[] = [];
  /** Signatures the user said no to, and how often the task had succeeded then. */
  private readonly declinedSkillSignatures = new Map<string, number>();
  private currentSkillSuggestion: SkillSuggestion | null = null;
  /** A failed skill waiting on a repair, from the offer to the saved fix. */
  private currentSkillRepair: SkillRepairSurface | null = null;
  private skillSuggestionHistoryStore: JsonFileStore<SkillSuggestionMemory> | null = null;
  private readonly wakeWordListener: WakeWordListener;
  private wakeWordState: WakeWordSurfaceState = "off";
  private wakeWordMessage = "";
  /** Runtime mute: the tray switch that silences the microphone without losing the setting. */
  private wakeWordMuted = false;
  private wakeFollowUpTimer: NodeJS.Timeout | null = null;
  private wakeFollowUpStartedAtMs = 0;
  private wakeFollowUpHeardSpeechAtMs = 0;
  private readonly agentLoop: UstaadAgentLoop;
  /** Task goals waiting on the user's yes, keyed by confirmation id. */
  private readonly pendingTaskGoals = new Map<string, string>();
  private isAgentTaskRunning = false;
  private agentTaskCancelled = true;
  private timerTickTimer: NodeJS.Timeout | null = null;
  private latestNowPlaying: NowPlayingInfo | null = null;
  private readonly runningScheduledTaskIds = new Set<string>();

  constructor(
    private readonly configStore: UstaadConfigStore,
    private readonly desktopWindows: UstaadDesktopWindows,
    userDataDirectory: string,
  ) {
    this.bridge = new UstaadWindowsBridge(userDataDirectory);
    this.appIndex = new StartMenuAppIndex(this.bridge);
    this.todoStore = new TodoStore(`${userDataDirectory}/todos.json`);
    this.memoryStore = new MemoryStore(`${userDataDirectory}/memory.json`);
    this.runHistoryStore = new RunHistoryStore(`${userDataDirectory}/run-history.json`);
    this.phoneBridgeStore = new PhoneBridgeStore(`${userDataDirectory}/phone-bridge.json`);
    this.scheduleStore = new ScheduleStore(`${userDataDirectory}/schedules.json`);
    this.presenceStore = new PresenceStore(`${userDataDirectory}/presence.json`);
    this.snippetStore = new SnippetStore(`${userDataDirectory}/snippets.json`);
    this.auditLogStore = new AuditLogStore(`${userDataDirectory}/audit-log.json`);
    this.skillStore = new SkillStore(`${userDataDirectory}/skills.json`);
    this.taskQueueStore = new TaskQueueStore(`${userDataDirectory}/task-queue.json`);
    this.skillSuggestionHistoryStore = new JsonFileStore<SkillSuggestionMemory>(
      `${userDataDirectory}/skill-suggestions.json`,
      (storedValue) => {
        const source = storedValue && typeof storedValue === "object"
          ? storedValue as Partial<SkillSuggestionMemory>
          : {};
        return {
          history: Array.isArray(source.history) ? source.history.slice(-200) : [],
          declinedSignatures: source.declinedSignatures && typeof source.declinedSignatures === "object"
            ? source.declinedSignatures
            : {},
        };
      },
    );
    this.systemAccessRunner = new SystemAccessRunner();
    this.clipboardHistoryStore = new ClipboardHistoryStore(
      `${userDataDirectory}/clipboard-history.json`,
    );
    this.actionExecutor = new UstaadActionExecutor({
      bridge: this.bridge,
      appIndex: this.appIndex,
      todoStore: this.todoStore,
      memoryStore: this.memoryStore,
      scheduleStore: this.scheduleStore,
      snippetStore: this.snippetStore,
      auditLogStore: this.auditLogStore,
      systemAccessRunner: this.systemAccessRunner,
      readAbilities: () => this.configStore.getConfig().abilities,
      openExternalUrl: async (url) => {
        const { shell } = await import("electron");
        await shell.openExternal(url);
      },
      showNotification: (title, body) => this.desktopWindows.showNotification(title, body),
      showPanel: (page) => this.desktopWindows.showPanel(page),
      now: () => new Date(),
    });

    this.agentLoop = new UstaadAgentLoop({
      runActions: (actions) => this.runAgentStepActions(actions),
      look: (lookRequest) => this.lookAtScreenForTask(lookRequest),
      readNowPlaying: async () => {
        try {
          return await this.bridge.readNowPlaying();
        } catch {
          return null;
        }
      },
      shouldStop: () => this.agentTaskCancelled || this.configStore.getConfig().automationPaused,
      wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      onProgress: (progressEvent) => this.handleAgentProgress(progressEvent),
    }, defaultAgentLoopBudget);

    this.wakeWordListener = new WakeWordListener(userDataDirectory, {
      onStateChanged: (state, message) => this.handleWakeWordListenerState(state, message),
      onWakeWordDetected: (detection) => this.handleWakeWordDetected(detection),
    });

    const config = configStore.getConfig();
    this.publicState = {
      voiceState: "idle",
      interactionKind: null,
      dictationStage: "idle",
      configured: this.brainRouter.isConfigured(config),
      configurationHint: this.brainRouter.configurationHint(config),
      brainLabel: this.brainRouter.getBrainLabel(config),
      shortcutAvailable: true,
      shortcutLabel: "Ctrl + Alt",
      dictationShortcutLabel: dictationShortcutLabels[config.dictationShortcut],
      circleShortcutLabel: shortcutLabels.circle,
      lastTranscript: "",
      partialTranscript: "",
      responseText: "",
      audioPowerLevel: 0,
      errorMessage: null,
      lastActionSummary: "",
      cursorEnabled: config.cursorEnabled,
      automationPaused: config.automationPaused,
      islandEnabled: config.islandEnabled,
      clipboardHistoryEnabled: config.clipboardHistoryEnabled,
      wakeWordState: "off",
      wakeWordMessage: "",
      wakeWordMuted: false,
      auditLog: [],
      auditLogCounts: { allowed: 0, refused: 0, blocked: 0, failed: 0, total: 0 },
      phoneBridge: {
        isRunning: false,
        address: "",
        port: 0,
        isReadOnly: true,
        lastErrorMessage: null,
      },
      config,
    };
  }

  async start(shortcutAvailable: boolean): Promise<void> {
    this.publicState.shortcutAvailable = shortcutAvailable;
    if (!shortcutAvailable) {
      this.publicState.errorMessage =
        "The global shortcuts could not start. Restart Ustaad, or use the hold-to-talk button.";
    }

    this.desktopWindows.setOverlayVisibility(this.publicState.config.cursorEnabled);
    this.applyLaunchAtLogin(this.publicState.config.launchAtLogin);
    this.updateIslandVisibility();
    this.publishState();

    // Startup catch-up: roll tasks missed while Ustaad was closed forward, then
    // warm the Windows helper and the app index in the background.
    const now = new Date();
    this.scheduleStore.refreshNextRuns(now);
    this.scheduleStore.rollForwardOverdueTasks(now);
    this.startScheduler();
    this.startClipboardWatcher();
    this.startNowPlayingWatcher();
    this.publishIslandState();

    void this.syncPhoneBridge();

    void this.bridge.start().catch((error: unknown) => {
      console.warn("Ustaad could not start its Windows helper:", error);
    });
    void this.refreshAppIndex();
    this.synchronizeWakeWordListener();
    this.loadSkillSuggestionMemory();

    // Work left waiting when Ustaad last closed is never started on its own: it
    // is shown, and the user decides whether it still matters.
    const waitingFromLastTime = this.taskQueueStore.waiting();
    if (waitingFromLastTime.length > 0) {
      this.activityFeed.record(
        "system",
        waitingFromLastTime.length === 1
          ? "1 task is still on the list from last time"
          : `${waitingFromLastTime.length} tasks are still on the list from last time`,
        "press run in the island, or ask me for something else",
        false,
      );
      this.publishIslandState();
    }
  }

  stop(): void {
    this.endWakeFollowUp();
    this.wakeWordListener.stop();
    this.cancelActiveWork();
    this.clearTransientOverlayHideTimer();
    this.stopTimers();
    this.bridge.stop();
    void this.phoneBridgeServer?.stop();
    this.phoneBridgeServer = null;
  }

  getPublicState(): UstaadPublicState {
    return {
      ...this.publicState,
      config: this.configStore.getConfig(),
      auditLog: this.auditLogStore.list(50),
      auditLogCounts: this.auditLogStore.summarizeCounts(),
    };
  }

  /** Wipes the audit log, at the user's request, and says so in the log itself. */
  clearAuditLog(): void {
    this.auditLogStore.clear();
    this.publishState();
    this.activityFeed.record("system", "cleared the activity log", "the record of what ran on this pc is now empty", false);
    this.publishIslandState();
  }

  getIslandState(): IslandState {
    return this.islandState ?? this.buildIslandState();
  }

  /* ---------------------------------------------------------------------- */
  /* Interaction lifecycle                                                  */
  /* ---------------------------------------------------------------------- */

  handleShortcutPressed(shortcutId: ShortcutId): void {
    if (shortcutId === "panic") {
      this.handlePanicHotkey();
      return;
    }
    if (shortcutId === "snip") {
      this.beginSnip();
      return;
    }
    if (this.heldShortcutIds.has(shortcutId)) {
      return;
    }
    void this.beginInteraction(shortcutId);
  }

  handleShortcutReleased(shortcutId: ShortcutId): void {
    if (shortcutId === "panic") {
      // Lifting the Q changes nothing: the panic already did its work.
      return;
    }
    if (shortcutId === "snip") {
      // Lifting the S leaves the overlay up: the drag finishes the snip, and
      // Escape or a bare click walks away from it.
      return;
    }
    if (!this.heldShortcutIds.has(shortcutId)) {
      return;
    }

    this.heldShortcutIds.delete(shortcutId);
    if (this.activeInteractionKind !== shortcutId) {
      return;
    }
    void this.finishListening();
  }

  handlePanelPushToTalkPressed(): void {
    this.handleShortcutPressed("talk");
  }

  handlePanelPushToTalkReleased(): void {
    this.handleShortcutReleased("talk");
  }

  /**
   * The panic hotkey. Whatever is happening — a task clicking through a website,
   * a spoken answer, a pending confirmation, a snip waiting for a drag — it all
   * stops here, and Ustaad says so out loud so the user is not left wondering.
   */
  handlePanicHotkey(): void {
    const wasWorkingOnSomething = this.isAgentTaskRunning
      || this.activeInteractionKind !== null
      || this.confirmationQueue.list().length > 0
      || this.isSnipInFlight;

    this.endWakeFollowUp();
    this.cancelAgentTask();
    this.pendingTaskGoals.clear();
    this.confirmationQueue.clear();
    this.taskQueueStore.cancelWaiting();
    this.isSnipInFlight = false;
    this.cancelActiveWork();
    this.desktopWindows.hideRegionSelector();
    this.desktopWindows.updateOverlayMode({ interactionKind: null, hint: "", typedText: "" });
    this.publicState.voiceState = "idle";
    this.publicState.interactionKind = null;
    this.publicState.errorMessage = null;
    this.publishState();
    this.publishIslandState();

    const panicMessage = wasWorkingOnSomething
      ? "everything stopped. nothing else will run until you ask again."
      : "nothing was running, so there was nothing to stop.";
    this.activityFeed.record("system", "panic hotkey", panicMessage, false);
    this.desktopWindows.showNotification("Ustaad stopped", panicMessage);
    this.desktopWindows.revealIsland();
    this.publishIslandState();
  }

  handleEscapePressed(): void {
    this.cancelAgentTask();
    this.pendingTaskGoals.clear();
    this.confirmationQueue.clear();
    this.isSnipInFlight = false;
    this.desktopWindows.hideRegionSelector();
    this.desktopWindows.closeIsland();
    this.cancelActiveWork();
    this.publicState.voiceState = "idle";
    this.publicState.interactionKind = null;
    this.publicState.partialTranscript = "";
    this.publicState.audioPowerLevel = 0;
    this.desktopWindows.updateOverlayMode({ interactionKind: null, hint: "", typedText: "" });
    this.publishState();
    this.publishIslandState();
  }

  private async beginInteraction(interactionKind: InteractionKind): Promise<void> {
    const config = this.configStore.getConfig();
    if (!this.brainRouter.isConfigured(config)) {
      this.publicState.errorMessage = this.brainRouter.configurationHint(config);
      this.publishState();
      this.desktopWindows.showPanel("setup");
      return;
    }

    const requiredAbility = interactionKind === "talk"
      ? null
      : interactionKind === "dictation"
        ? "dictation" as const
        : interactionKind === "circle"
          ? "circleToAsk" as const
          : "scheduling" as const;
    if (requiredAbility && !config.abilities[requiredAbility]) {
      this.publicState.errorMessage = `That shortcut is switched off. Switch the "${requiredAbility}" ability back on in the soul tab.`;
      this.publishState();
      return;
    }

    this.cancelActiveWork();
    if (interactionKind !== "scheduled") {
      this.heldShortcutIds.add(interactionKind);
    }

    this.clearTransientOverlayHideTimer();
    this.activeInteractionId += 1;
    const interactionId = this.activeInteractionId;
    this.activeInteractionKind = interactionKind;
    this.selectedCircleRegion = null;
    this.lastPointingTargets = [];

    // The tray panel must never hold focus while Ustaad types into another app.
    this.desktopWindows.hidePanel();
    this.desktopWindows.setOverlayVisibility(true);
    this.desktopWindows.updateOverlayResponse("");
    this.desktopWindows.updateOverlayMode({
      interactionKind,
      hint: describeInteractionHint(interactionKind, config),
      typedText: "",
    });

    this.activeDictationStage = interactionKind === "dictation" ? "recording" : "idle";
    this.publicState.voiceState = "processing";
    this.publicState.interactionKind = interactionKind;
    this.publicState.partialTranscript = "";
    this.publicState.responseText = "";
    this.publicState.audioPowerLevel = 0;
    this.publicState.errorMessage = null;
    this.publicState.dictationStage = this.activeDictationStage;
    this.publishState();
    this.publishIslandState();

    const interactionAbortController = new AbortController();
    this.interactionAbortController = interactionAbortController;

    if (interactionKind === "circle") {
      this.desktopWindows.showRegionSelector("circle anything on screen, keep talking, then let go");
    }

    this.startListening(interactionId, interactionAbortController);
  }

  /** Starts whichever transcription pipeline the active brain needs. */
  private startListening(interactionId: number, interactionAbortController: AbortController): void {
    const config = this.configStore.getConfig();
    const usesStreamingTranscription = this.brainRouter.resolveActiveProvider(config) === "worker";

    if (!usesStreamingTranscription) {
      // The Gemini path records first and transcribes on release, so the audio
      // is buffered here in the main process.
      this.recordedAudioBuffer = new AudioRecordingBuffer();
      this.desktopWindows.beginMicrophoneCapture(interactionId);
      return;
    }

    const transcriptionSession = new AssemblyAITranscriptionSession({
      workerBaseUrl: config.workerBaseUrl,
      keyterms: ["Ustaad", "Claude", "Gemini", "Windows", "dictation", "routine"],
      onTranscriptUpdate: (transcriptText) => {
        if (interactionId !== this.activeInteractionId) {
          return;
        }
        this.publicState.partialTranscript = transcriptText;
        this.publishState();
      },
      onFinalTranscript: (transcriptText) => {
        if (interactionId !== this.activeInteractionId) {
          return;
        }
        this.activeTranscriptionSession = null;
        void this.completeInteraction(transcriptText);
      },
      onError: (error) => {
        if (interactionId !== this.activeInteractionId) {
          return;
        }
        this.handleInteractionError(error);
      },
    });
    this.activeTranscriptionSession = transcriptionSession;

    void transcriptionSession.open(interactionAbortController.signal)
      .then(() => {
        if (interactionId !== this.activeInteractionId || !this.heldShortcutIds.size) {
          transcriptionSession.cancel();
          return;
        }
        this.desktopWindows.beginMicrophoneCapture(interactionId);
      })
      .catch((error: unknown) => {
        if (interactionId !== this.activeInteractionId || this.isAbortError(error)) {
          return;
        }
        this.handleInteractionError(error);
      });
  }

  private async finishListening(): Promise<void> {
    const interactionId = this.activeInteractionId;
    this.desktopWindows.endMicrophoneCapture(interactionId);
    this.publicState.audioPowerLevel = 0;

    if (this.activeInteractionKind === "circle") {
      // Hide the lasso before capturing, or Ustaad would photograph its own
      // selection UI instead of what the user circled.
      this.desktopWindows.hideRegionSelector();
    }

    if (this.activeTranscriptionSession) {
      if (!this.activeTranscriptionSession.ready) {
        this.activeTranscriptionSession.cancel();
        this.activeTranscriptionSession = null;
        this.finishWithoutTranscript();
        return;
      }
      this.publicState.voiceState = "processing";
      this.publishState();
      this.activeTranscriptionSession.requestFinalTranscript();
      return;
    }

    const recordedAudioBuffer = this.recordedAudioBuffer;
    if (!recordedAudioBuffer || recordedAudioBuffer.isEmpty) {
      this.finishWithoutTranscript();
      return;
    }

    this.publicState.voiceState = "processing";
    this.publishState();

    try {
      const config = this.configStore.getConfig();
      const transcriptText = await this.brainRouter.transcribeRecordedAudio(
        config,
        recordedAudioBuffer.toWavBuffer(),
        this.interactionAbortController?.signal ?? new AbortController().signal,
      );
      recordedAudioBuffer.clear();
      if (interactionId !== this.activeInteractionId) {
        return;
      }
      await this.completeInteraction(transcriptText);
    } catch (error) {
      if (interactionId !== this.activeInteractionId || this.isAbortError(error)) {
        return;
      }
      this.handleInteractionError(error);
    }
  }

  private finishWithoutTranscript(): void {
    this.activeInteractionKind = null;
    this.activeDictationStage = "idle";
    this.publicState.voiceState = "idle";
    this.publicState.interactionKind = null;
    this.publicState.dictationStage = "idle";
    this.publishState();
    this.publishIslandState();
    this.scheduleTransientOverlayHideIfPossible();
  }

  /** Everything after the words are known: dictating, asking, or acting. */
  private async completeInteraction(rawTranscriptText: string): Promise<void> {
    const interactionId = this.activeInteractionId;
    const interactionKind = this.activeInteractionKind;
    if (!interactionKind) {
      return;
    }
    const transcriptText = rawTranscriptText.trim();
    this.publicState.partialTranscript = "";
    this.publicState.audioPowerLevel = 0;
    this.publicState.lastTranscript = transcriptText;

    if (interactionKind === "dictation") {
      await this.finishDictation(interactionId, transcriptText);
      return;
    }

    // A pending confirmation turns the next words into a yes or a no.
    const pendingConfirmation = this.confirmationQueue.nextPending();
    if (pendingConfirmation) {
      const confirmationAnswer = interpretConfirmationAnswer(transcriptText);
      if (confirmationAnswer !== "unknown") {
        const resultMessage = await this.runConfirmationDecision(pendingConfirmation.id, confirmationAnswer);
        this.publicState.responseText = resultMessage;
        this.desktopWindows.updateOverlayResponse(resultMessage);
        await this.speakResponse(interactionId, resultMessage);
        return;
      }
    }

    if (!transcriptText && interactionKind !== "circle") {
      this.finishWithoutTranscript();
      return;
    }

    this.publicState.voiceState = "processing";
    this.publishState();
    this.publishIslandState();

    const responseAbortController = new AbortController();
    this.responseAbortController = responseAbortController;

    try {
      const config = this.configStore.getConfig();
      const images = await this.captureInteractionImages(interactionKind);
      if (interactionId !== this.activeInteractionId) {
        return;
      }

      const userPrompt = transcriptText || "what am i looking at here?";
      const responseText = await this.brainRouter.streamResponse(config, {
        systemPrompt: this.buildPromptForInteraction(config, interactionKind, images.length > 0),
        userPrompt,
        images: images.map(toBrainImage),
        conversationHistory: [...this.conversationHistory],
        signal: responseAbortController.signal,
        onTextUpdate: (accumulatedText) => {
          if (interactionId !== this.activeInteractionId) {
            return;
          }
          this.publicState.responseText = accumulatedText;
          this.desktopWindows.updateOverlayResponse(accumulatedText);
          this.publishState();
        },
      });
      if (interactionId !== this.activeInteractionId) {
        return;
      }

      const parsedResponse = parseModelResponse(responseText);
      const pointingResult = parsePointingTag(parsedResponse.spokenText);
      const spokenText = pointingResult.spokenText || parsedResponse.spokenText;
      this.publicState.responseText = spokenText;
      this.desktopWindows.updateOverlayResponse(spokenText);
      this.recordRun({
        request: transcriptText,
        kind: interactionKind === "scheduled" ? "routine" : "reply",
        outcome: "completed",
        note: "",
        stepsTaken: 0,
        response: spokenText,
      });

      this.pointAtElement(interactionId, pointingResult, spokenText);
      this.rememberExchange(userPrompt, spokenText);

      if (parsedResponse.problems.length) {
        console.warn("Ustaad skipped some requested actions:", parsedResponse.problems.join("; "));
      }

      if (parsedResponse.taskGoal && interactionKind !== "scheduled") {
        // The model asked Ustaad to keep working until the goal is met, so the
        // loop runs the first step itself instead of running it here.
        this.publicState.lastActionSummary = await this.beginModelTask(
          interactionId,
          parsedResponse.taskGoal,
          parsedResponse.actions,
          this.configStore.getConfig(),
        );
      } else {
        this.publicState.lastActionSummary = await this.runModelActions(
          interactionId,
          parsedResponse.actions,
          interactionKind === "scheduled",
        );
      }
      this.publishState();
      this.publishIslandState();

      await this.speakResponse(interactionId, spokenText);
    } catch (error) {
      if (this.isAbortError(error) || interactionId !== this.activeInteractionId) {
        return;
      }
      this.handleInteractionError(error);
    }
  }

  private async captureInteractionImages(interactionKind: InteractionKind): Promise<CapturedDisplayImage[]> {
    const config = this.configStore.getConfig();
    if (!config.abilities.screenVision) {
      return [];
    }

    if (interactionKind === "circle" && this.selectedCircleRegion) {
      const circleRegion = this.selectedCircleRegion;
      this.selectedCircleRegion = null;
      const capturedRegion = await captureWindowsDesktopRegion({
        displayId: circleRegion.displayId,
        x: circleRegion.x,
        y: circleRegion.y,
        width: circleRegion.width,
        height: circleRegion.height,
      });
      this.lastPointingTargets = [capturedRegion];
      this.actionExecutor.setClickCoordinateSpace([capturedRegion]);
      return [capturedRegion];
    }

    const capturedDisplays = await captureAllWindowsDisplays();
    this.lastPointingTargets = capturedDisplays;
    this.actionExecutor.setClickCoordinateSpace(capturedDisplays);
    return capturedDisplays;
  }

  private buildPromptForInteraction(
    config: UstaadUserConfig,
    interactionKind: InteractionKind,
    hasScreenshots: boolean,
  ): string {
    return buildSystemPrompt({
      now: new Date(),
      soul: config.soul,
      abilities: config.abilities,
      interactionKind,
      rememberedFacts: config.abilities.memory ? this.memoryStore.summarizeFacts(1_200) : [],
      openTodoItems: config.abilities.toDoList ? this.todoStore.summarizeOpenItems(8) : [],
      upcomingSchedules: config.abilities.scheduling ? this.scheduleStore.listNextRunsDescription(5) : [],
      clipboardPreview: this.buildClipboardPreview(config),
      savedSnippetNames: config.abilities.automation ? this.snippetStore.summarizeSnippetNames(12) : [],
      savedSkills: config.abilities.automation ? this.skillStore.summarizeNames(12) : [],
      hasScreenshots,
      isCircledRegion: interactionKind === "circle",
      isScheduledTask: interactionKind === "scheduled",
    });
  }

  private buildClipboardPreview(config: UstaadUserConfig): string {
    if (!config.clipboardHistoryEnabled) {
      return "";
    }
    return this.clipboardHistoryStore.latestText().replace(/\s+/gu, " ").slice(0, 240);
  }

  /* ---------------------------------------------------------------------- */
  /* Dictation                                                              */
  /* ---------------------------------------------------------------------- */

  private async finishDictation(interactionId: number, rawTranscriptText: string): Promise<void> {
    if (!rawTranscriptText) {
      this.activeDictationStage = "idle";
      this.publicState.dictationStage = "idle";
      this.finishWithoutTranscript();
      return;
    }

    const config = this.configStore.getConfig();
    this.activeDictationStage = "cleaning";
    this.publicState.dictationStage = "cleaning";
    this.publicState.voiceState = "processing";
    this.publishState();
    this.publishIslandState();

    let dictationText = rawTranscriptText;
    if (config.dictationCleanupEnabled && !shouldSkipDictationCleanup(rawTranscriptText)) {
      try {
        const cleanedText = await this.brainRouter.cleanDictationTranscript(
          config,
          rawTranscriptText,
          this.interactionAbortController?.signal ?? new AbortController().signal,
        );
        if (cleanedText.trim()) {
          dictationText = stripDictationCleanupWrappers(cleanedText);
        }
      } catch (error) {
        if (this.isAbortError(error)) {
          return;
        }
        console.warn("Ustaad pasted the raw transcript:", error);
      }
    }

    if (interactionId !== this.activeInteractionId) {
      return;
    }

    this.activeDictationStage = "typing";
    this.publicState.dictationStage = "typing";
    this.desktopWindows.updateOverlayMode({
      interactionKind: "dictation",
      hint: "typing it in",
      typedText: dictationText,
    });
    this.publishState();

    const typeResult = await this.actionExecutor.execute({ type: "type_text", text: dictationText });
    const activityEntry = this.activityFeed.record(
      "action",
      typeResult.status === "completed" ? "dictated text" : "could not dictate that",
      dictationText.slice(0, 200),
      Boolean(typeResult.undo),
    );
    if (typeResult.undo) {
      this.undoableActions.set(activityEntry.id, {
        label: typeResult.undoLabel ?? "undo",
        run: typeResult.undo,
      });
    }

    this.publicState.lastActionSummary = typeResult.message;
    this.activeDictationStage = "idle";
    this.publicState.dictationStage = "idle";
    this.publicState.voiceState = "idle";
    this.publicState.interactionKind = null;
    this.activeInteractionKind = null;
    this.desktopWindows.updateOverlayMode({ interactionKind: null, hint: "", typedText: "" });
    this.publishState();
    this.publishIslandState();
    this.scheduleTransientOverlayHideIfPossible();
  }

  /* ---------------------------------------------------------------------- */
  /* Actions                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Runs what the model asked for: bookkeeping immediately, and anything that
   * touches the desktop through the island's confirmation card.
   */
  private async runModelActions(
    interactionId: number,
    requestedActions: UstaadAction[],
    isScheduledTask: boolean,
  ): Promise<string> {
    if (!requestedActions.length) {
      return "";
    }

    const config = this.configStore.getConfig();
    const { allowedActions, blockedActions } = filterActionsByAbilities(
      requestedActions,
      config.abilities,
    );

    for (const blockedAction of blockedActions) {
      this.activityFeed.record(
        "system",
        "skipped an action",
        `${blockedAction.action.type.replace(/_/gu, " ")} needs the "${blockedAction.ability}" ability, which is switched off`,
        false,
      );
    }

    if (config.automationPaused) {
      this.activityFeed.record(
        "system",
        "actions are paused",
        `Ustaad would have: ${describeActions(allowedActions)}`,
        false,
      );
      this.publishIslandState();
      return "actions are paused";
    }

    const actionsToConfirm = allowedActions.filter((action) =>
      actionNeedsConfirmation(action, config.confirmationMode, config.autoApprovedActionTypes));
    const actionsToRunNow = allowedActions.filter((action) => !actionsToConfirm.includes(action));

    const completedMessages: string[] = [];
    for (const action of actionsToRunNow) {
      const completedMessage = await this.executeAndRecordAction(action);
      if (completedMessage) {
        completedMessages.push(completedMessage);
      }
    }

    if (actionsToConfirm.length) {
      this.confirmationQueue.enqueue(interactionId, actionsToConfirm, describeActions(actionsToConfirm));
      this.activityFeed.record(
        "confirmation",
        isScheduledTask ? "a scheduled task needs a yes" : "waiting for your yes",
        `${describeActions(actionsToConfirm)} — say yes, or press run in the island`,
        false,
      );
      this.desktopWindows.openIsland();
      if (isScheduledTask) {
        this.desktopWindows.showNotification(
          "Ustaad needs a yes",
          `A scheduled task wants to ${describeActions(actionsToConfirm)}`,
        );
      }
      this.publishIslandState();
    }

    return completedMessages.join("; ");
  }

  /** Executes one action and records it in the island's activity feed. */
  private async executeAndRecordAction(action: UstaadAction): Promise<string> {
    let outcome;
    try {
      // Timers and clipboard rewrites need controller state (the clock and the
      // user's brain), so they are answered here rather than in the executor.
      if (action.type === "timer_start" || action.type === "timer_cancel") {
        outcome = await this.runTimerAction(action);
      } else if (action.type === "clipboard_transform") {
        outcome = await this.runClipboardTransform(action.operation, action.targetLanguage);
      } else if (action.type === "create_image") {
        outcome = await this.drawPicture(action.prompt, action.name);
      } else if (action.type === "run_skill") {
        outcome = await this.runSavedSkill(action.name);
      } else if (action.type === "screenshot_region") {
        this.beginSnip();
        outcome = completedActionOutcome(
          "ready to snip",
          "drag over the part of the screen you want and it lands on your clipboard",
        );
      } else {
        outcome = await this.actionExecutor.execute(action);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.activityFeed.record(
        "action",
        `could not ${action.type.replace(/_/gu, " ")}`,
        errorMessage,
        false,
      );
      this.publishIslandState();
      return "";
    }

    if (outcome.status === "needs_choice") {
      this.confirmationQueue.enqueue(
        this.activeInteractionId,
        outcome.choices.map((actionChoice) => actionChoice.action),
        outcome.message,
      );
      this.activityFeed.record("confirmation", "which one?", outcome.message, false);
      this.desktopWindows.openIsland();
      this.publishIslandState();
      return "";
    }

    const activityEntry = this.activityFeed.record(
      outcome.status === "completed" ? "action" : "system",
      outcome.status === "completed" ? outcome.message : "that action did not work",
      outcome.status === "completed" ? outcome.detail : outcome.message,
      Boolean(outcome.undo),
    );
    if (outcome.undo) {
      this.undoableActions.set(activityEntry.id, {
        label: outcome.undoLabel ?? "undo",
        run: outcome.undo,
      });
    }

    this.publishIslandState();
    return outcome.status === "completed" ? outcome.message : "";
  }

  /* ---------------------------------------------------------------------- */
  /* Timers                                                                 */
  /* ---------------------------------------------------------------------- */

  private async runTimerAction(
    action: Extract<UstaadAction, { type: "timer_start" | "timer_cancel" }>,
  ): Promise<ActionExecutionOutcome> {
    if (action.type === "timer_start") {
      const timerId = randomUUID();
      const durationMilliseconds = action.durationMinutes * 60_000;
      const endsAt = new Date(Date.now() + durationMilliseconds);
      const createdTimer: ActiveTimer = {
        id: timerId,
        label: action.label,
        endsAtIso: formatLocalIso(endsAt),
        remainingSeconds: action.durationMinutes * 60,
      };

      this.activeTimers.push(createdTimer);
      this.startTimerTicking();
      this.publishIslandState();

      const durationDescription = action.durationMinutes >= 60
        ? `${Math.floor(action.durationMinutes / 60)} hour${action.durationMinutes >= 120 ? "s" : ""}${action.durationMinutes % 60 ? ` and ${action.durationMinutes % 60} minutes` : ""}`
        : `${action.durationMinutes} minute${action.durationMinutes === 1 ? "" : "s"}`;

      return {
        status: "completed",
        message: `started a ${durationDescription} ${action.label} timer`,
        detail: `ends at ${formatClockTime(endsAt)}`,
        undoLabel: "stop the timer",
        undo: () => {
          this.removeTimer(timerId);
          this.publishIslandState();
        },
        choices: [],
      };
    }

    const normalizedQuery = (action.query ?? "").trim().toLowerCase();
    const timersToStop = normalizedQuery
      ? this.activeTimers.filter((timer) => timer.label.toLowerCase().includes(normalizedQuery))
      : [...this.activeTimers];

    if (!timersToStop.length) {
      return failedActionOutcome(
        normalizedQuery
          ? `there is no "${action.query}" timer running.`
          : "no timers are running.",
      );
    }

    for (const timerToStop of timersToStop) {
      this.removeTimer(timerToStop.id);
    }
    this.publishIslandState();

    return completedActionOutcome(
      timersToStop.length === 1
        ? `stopped the ${timersToStop[0]!.label} timer`
        : `stopped ${timersToStop.length} timers`,
    );
  }

  private removeTimer(timerId: string): void {
    this.activeTimers = this.activeTimers.filter((timer) => timer.id !== timerId);
    if (!this.activeTimers.length && this.timerTickTimer) {
      clearInterval(this.timerTickTimer);
      this.timerTickTimer = null;
    }
  }

  /** One tick per second only while a timer is running. */
  private startTimerTicking(): void {
    if (this.timerTickTimer) {
      return;
    }

    this.timerTickTimer = setInterval(() => {
      const now = Date.now();
      const finishedTimers: ActiveTimer[] = [];
      const runningTimers: ActiveTimer[] = [];

      for (const timer of this.activeTimers) {
        const remainingSeconds = Math.max(
          0,
          Math.round((Date.parse(timer.endsAtIso) - now) / 1_000),
        );
        if (remainingSeconds <= 0) {
          finishedTimers.push({ ...timer, remainingSeconds: 0 });
        } else {
          runningTimers.push({ ...timer, remainingSeconds });
        }
      }

      this.activeTimers = runningTimers;
      if (!this.activeTimers.length && this.timerTickTimer) {
        clearInterval(this.timerTickTimer);
        this.timerTickTimer = null;
      }

      for (const finishedTimer of finishedTimers) {
        void this.finishTimer(finishedTimer);
      }

      this.publishIslandState();
    }, 1_000);
  }

  private async finishTimer(finishedTimer: ActiveTimer): Promise<void> {
    const announcement = `your ${finishedTimer.label} timer is done.`;
    this.activityFeed.record("system", announcement, `started at ${finishedTimer.endsAtIso}`, false);
    this.desktopWindows.showNotification("Ustaad timer", announcement);
    this.desktopWindows.revealIsland();
    this.publishIslandState();
    await this.speakResponse(this.activeInteractionId, announcement);
  }

  /* ---------------------------------------------------------------------- */
  /* Clipboard intelligence                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Rewrites whatever is on the clipboard and puts the result back, so the user
   * can paste it straight away. The previous text is kept for undo.
   */
  /**
   * Draws one picture on the user's own key and saves it in their Pictures
   * folder, then shows it in the island.
   *
   * Nothing here is overwritten — a name that is already used gets a number —
   * and the undo chip deletes exactly the file this call wrote.
   */
  private async drawPicture(prompt: string, requestedName: string | null): Promise<ActionExecutionOutcome> {
    const picturesFolder = join(app.getPath("pictures"), pictureFolderName);
    await mkdir(picturesFolder, { recursive: true });

    const drawnPicture = await this.brainRouter.drawPicture(this.configStore.getConfig(), prompt);
    const fileName = resolvePictureFileName({
      prompt,
      requestedName,
      mimeType: drawnPicture.mimeType,
      takenFileNames: new Set(await readdir(picturesFolder)),
    });
    const filePath = join(picturesFolder, fileName);
    await writeFile(filePath, Buffer.from(drawnPicture.base64Data, "base64"));

    this.drawnPicture = {
      id: randomUUID(),
      prompt,
      filePath,
      previewDataUrl: buildPicturePreviewDataUrl(drawnPicture.base64Data),
      drawnAtIso: new Date().toISOString(),
    };
    this.publishIslandState();
    this.desktopWindows.showNotification("your picture is ready", `${fileName} is in your Pictures folder.`);

    return completedActionOutcomeWithUndo(
      `drew "${prompt}"`,
      filePath,
      "delete the picture",
      async () => {
        await rm(filePath, { force: true });
        if (this.drawnPicture?.filePath === filePath) {
          this.drawnPicture = null;
          this.publishIslandState();
        }
      },
    );
  }

  /** Opens the last drawn picture in the user's picture viewer. */
  async openDrawnPicture(): Promise<string> {
    const openablePath = this.readOpenablePicturePath();
    if (!openablePath) {
      return "there is no picture to open.";
    }
    const openFailure = await shell.openPath(openablePath);
    return openFailure || "opened it.";
  }

  /** Shows the last drawn picture in Explorer, so it can be dragged anywhere. */
  revealDrawnPicture(): string {
    const openablePath = this.readOpenablePicturePath();
    if (!openablePath) {
      return "there is no picture to show.";
    }
    shell.showItemInFolder(openablePath);
    return "showed it in your folder.";
  }

  /** Hides the picture card. The file itself stays in Pictures. */
  dismissDrawnPicture(): void {
    this.drawnPicture = null;
    this.publishIslandState();
  }

  /**
   * The path the picture buttons are allowed to touch.
   *
   * Both buttons open something, so the path is re-checked against the folder
   * Ustaad writes pictures into rather than trusted for being in memory.
   */
  private readOpenablePicturePath(): string | null {
    const filePath = this.drawnPicture?.filePath ?? "";
    if (!filePath) {
      return null;
    }
    const picturesFolder = join(app.getPath("pictures"), pictureFolderName);
    const pathInsidePictures = relative(picturesFolder, filePath);
    return pathInsidePictures && !pathInsidePictures.startsWith("..") && !isAbsolute(pathInsidePictures)
      ? filePath
      : null;
  }

  private async runClipboardTransform(
    operation: ClipboardTransformOperation,
    targetLanguage: string | null,
  ): Promise<ActionExecutionOutcome> {
    const config = this.configStore.getConfig();
    if (!this.brainRouter.isConfigured(config)) {
      return failedActionOutcome(this.brainRouter.configurationHint(config));
    }
    if (config.automationPaused) {
      return failedActionOutcome("actions are paused, so I did not rewrite the clipboard.");
    }

    const originalText = (await clipboard.readText()).trim();
    if (!originalText) {
      return failedActionOutcome("there is nothing on the clipboard to work with.");
    }

    const instructionLines: Record<ClipboardTransformOperation, string> = {
      summarize: "Summarise the text the user gives you. Keep every fact, drop the padding. Reply with the summary only.",
      fix_grammar: "Fix the spelling, grammar and punctuation of the text the user gives you. Keep the wording, tone and line breaks. Reply with the corrected text only.",
      shorten: "Rewrite the text the user gives you so it says the same thing in noticeably fewer words. Reply with the rewritten text only.",
      translate: `Translate the text the user gives you into ${targetLanguage ?? "English"}. Keep the tone and formatting. Reply with the translation only.`,
    };

    const responseText = await this.brainRouter.streamResponse(config, {
      systemPrompt: `${instructionLines[operation]} never add a preamble, never explain what you did, never wrap the answer in quotes or a code block.`,
      userPrompt: originalText,
      images: [],
      conversationHistory: [],
      signal: new AbortController().signal,
      onTextUpdate: () => undefined,
    });

    const transformedText = responseText.trim();
    if (!transformedText) {
      return failedActionOutcome("the model came back empty, so I left your clipboard alone.");
    }

    await clipboard.writeText(transformedText);
    this.clipboardHistoryStore.pushText(transformedText);
    this.lastClipboardText = transformedText;

    const operationMessages: Record<ClipboardTransformOperation, string> = {
      summarize: "summarised your clipboard",
      fix_grammar: "fixed the grammar on your clipboard",
      shorten: "shortened your clipboard",
      translate: `translated your clipboard into ${targetLanguage ?? "English"}`,
    };

    return {
      status: "completed",
      message: operationMessages[operation],
      detail: transformedText.replace(/\s+/gu, " ").slice(0, 160),
      undoLabel: "put the old text back",
      undo: async () => {
        await clipboard.writeText(originalText);
        this.lastClipboardText = originalText;
      },
      choices: [],
    };
  }

  /** Applies a yes/no, either from the island's buttons or from the user's voice. */
  async runConfirmationDecision(
    confirmationId: string,
    decision: "approve" | "reject",
  ): Promise<string> {
    const pendingConfirmation = this.confirmationQueue.take(confirmationId);
    if (!pendingConfirmation) {
      return "that one has already been answered.";
    }

    if (decision === "reject") {
      const rejectedTaskGoal = this.pendingTaskGoals.get(confirmationId);
      if (rejectedTaskGoal) {
        this.pendingTaskGoals.delete(confirmationId);
        this.activityFeed.record("confirmation", "skipped it", rejectedTaskGoal, false);
        this.desktopWindows.setIslandExpanded(false);
        this.publishIslandState();
        return "skipped that.";
      }
      this.activityFeed.record("confirmation", "skipped it", describeActions(pendingConfirmation.actions), false);
      this.desktopWindows.setIslandExpanded(false);
      this.publishIslandState();
      return "skipped that.";
    }

    const approvedTaskGoal = this.pendingTaskGoals.get(confirmationId) ?? null;
    if (approvedTaskGoal) {
      // A task approval runs nothing here: the loop runs the first step, which
      // keeps one code path for stepping, looking and reporting.
      this.pendingTaskGoals.delete(confirmationId);
      this.desktopWindows.setIslandExpanded(false);
      this.publishIslandState();
      void this.runAgentTask(approvedTaskGoal, pendingConfirmation.actions);
      return `working on: ${approvedTaskGoal}`;
    }

    const completedMessages: string[] = [];
    for (const action of pendingConfirmation.actions) {
      const completedMessage = await this.executeAndRecordAction(action);
      if (completedMessage) {
        completedMessages.push(completedMessage);
      }
    }

    this.desktopWindows.setIslandExpanded(false);
    this.publishIslandState();
    return completedMessages.join(", ") || "done.";
  }

  async undoActivity(activityEntryId: string): Promise<boolean> {
    const undoableAction = this.undoableActions.get(activityEntryId);
    if (!undoableAction) {
      return false;
    }

    try {
      await undoableAction.run();
    } catch (error) {
      console.warn("Ustaad could not undo that action:", error);
      return false;
    }

    this.undoableActions.delete(activityEntryId);
    const undoneEntry = this.activityFeed.markUndone(activityEntryId);
    if (undoneEntry) {
      this.activityFeed.record("system", "undone", undoneEntry.message, false);
    }
    this.publishIslandState();
    return true;
  }

  /* ---------------------------------------------------------------------- */
  /* Pointing and speech                                                    */
  /* ---------------------------------------------------------------------- */

  private pointAtElement(
    interactionId: number,
    pointingResult: { coordinate: { x: number; y: number } | null; elementLabel: string | null; screenNumber: number | null },
    spokenText: string,
  ): void {
    const config = this.configStore.getConfig();
    if (!config.abilities.elementPointing || !pointingResult.coordinate) {
      return;
    }

    const targetDisplay = selectPointingDisplay(
      this.lastPointingTargets,
      pointingResult.screenNumber,
    );
    if (!targetDisplay) {
      return;
    }

    const globalPoint = mapImageCoordinateToWindowsDesktop(pointingResult.coordinate, targetDisplay);
    const animationStarted = this.desktopWindows.pointOverlayAt(
      interactionId,
      targetDisplay.displayId,
      globalPoint,
      pointingResult.elementLabel || "element",
      spokenText,
    );
    if (animationStarted) {
      this.pointingInteractionId = interactionId;
    }
  }

  private async speakResponse(interactionId: number, spokenText: string): Promise<void> {
    const config = this.configStore.getConfig();
    if (!spokenText) {
      this.finishWithoutTranscript();
      return;
    }

    const speechProvider = this.brainRouter.resolveSpeechProvider(config);
    this.publicState.voiceState = "responding";
    this.publishState();

    if (speechProvider === "windows") {
      this.audioPlaybackInteractionId = interactionId;
      this.desktopWindows.speakWithWindowsVoice({ interactionId, text: spokenText });
      return;
    }

    try {
      const synthesizedSpeech = await this.brainRouter.synthesizeSpeech(
        config,
        spokenText,
        this.responseAbortController?.signal ?? new AbortController().signal,
      );
      if (interactionId !== this.activeInteractionId) {
        return;
      }

      this.audioPlaybackInteractionId = interactionId;
      this.desktopWindows.playAudio({
        interactionId,
        audioBase64: synthesizedSpeech.audioData.toString("base64"),
        contentType: synthesizedSpeech.contentType,
      });
    } catch (speechError) {
      if (this.isAbortError(speechError) || interactionId !== this.activeInteractionId) {
        return;
      }
      // Chromium's speechSynthesis uses the installed Windows voices, so Ustaad
      // still speaks when a cloud voice is unavailable.
      this.publicState.errorMessage = `Speech engine unavailable, using a Windows voice. ${this.describeError(speechError)}`;
      this.audioPlaybackInteractionId = interactionId;
      this.desktopWindows.speakWithWindowsVoice({ interactionId, text: spokenText });
      this.publishState();
    }
  }

  private rememberExchange(userTranscript: string, assistantResponse: string): void {
    this.conversationHistory.push({ userTranscript, assistantResponse });
    if (this.conversationHistory.length > conversationHistoryLimit) {
      this.conversationHistory.splice(0, this.conversationHistory.length - conversationHistoryLimit);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Microphone and playback callbacks from the renderers                   */
  /* ---------------------------------------------------------------------- */

  appendMicrophoneAudio(interactionId: number, audioBytes: Uint8Array): void {
    if (interactionId !== this.activeInteractionId) {
      return;
    }

    if (this.activeTranscriptionSession) {
      this.activeTranscriptionSession.appendAudio(Buffer.from(audioBytes));
      return;
    }

    this.recordedAudioBuffer?.append(Buffer.from(audioBytes));
  }

  handleMicrophoneCaptureStarted(interactionId: number): void {
    if (interactionId !== this.activeInteractionId) {
      this.desktopWindows.endMicrophoneCapture(interactionId);
      return;
    }
    this.publicState.voiceState = "listening";
    this.publicState.errorMessage = null;
    this.publishState();
    this.publishIslandState();
  }

  handleMicrophoneCaptureError(interactionId: number, errorMessage: string): void {
    if (interactionId !== this.activeInteractionId) {
      return;
    }

    this.activeTranscriptionSession?.cancel();
    this.activeTranscriptionSession = null;
    this.activeInteractionKind = null;
    this.publicState.voiceState = "idle";
    this.publicState.audioPowerLevel = 0;
    this.publicState.errorMessage = `Microphone unavailable: ${errorMessage}`;
    this.publishState();
    this.scheduleTransientOverlayHideIfPossible();
  }

  handleAudioPowerLevel(interactionId: number, audioPowerLevel: number): void {
    if (interactionId !== this.activeInteractionId || this.publicState.voiceState !== "listening") {
      return;
    }
    this.publicState.audioPowerLevel = Math.max(0, Math.min(audioPowerLevel, 1));

    if (
      this.isWakeFollowUpActive()
      && this.publicState.audioPowerLevel >= wakeFollowUpSilenceWindows.speechLevel
    ) {
      this.wakeFollowUpHeardSpeechAtMs = Date.now();
    }

    this.publishState();
    this.desktopWindows.publishIslandState(this.buildIslandState());
  }

  handleAudioPlaybackStarted(interactionId: number): void {
    if (interactionId !== this.activeInteractionId) {
      return;
    }
    this.audioPlaybackInteractionId = interactionId;
    this.publicState.voiceState = "responding";
    this.publishState();
  }

  handleAudioPlaybackEnded(interactionId: number): void {
    if (interactionId !== this.activeInteractionId) {
      return;
    }
    this.audioPlaybackInteractionId = null;
    this.activeInteractionKind = null;
    this.publicState.voiceState = "idle";
    this.publicState.interactionKind = null;
    this.publishState();
    this.publishIslandState();
    this.scheduleTransientOverlayHideIfPossible();
  }

  handleAudioPlaybackError(interactionId: number, errorMessage: string): void {
    if (interactionId !== this.activeInteractionId) {
      return;
    }
    this.audioPlaybackInteractionId = null;
    this.publicState.voiceState = "idle";
    this.publicState.errorMessage = `Audio playback failed: ${errorMessage}`;
    this.publishState();
    this.scheduleTransientOverlayHideIfPossible();
  }

  handlePointingAnimationCompleted(interactionId: number): void {
    if (this.pointingInteractionId !== interactionId) {
      return;
    }
    this.pointingInteractionId = null;
    this.scheduleTransientOverlayHideIfPossible();
  }

  /* ---------------------------------------------------------------------- */
  /* The phone window                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Opens or closes the phone window to match the switch in the panel.
   *
   * It is the same rule as the wake word: a listener that reaches beyond this
   * machine is the user's decision, so switching the ability off really does
   * close the socket rather than hiding a running server.
   */
  private async syncPhoneBridge(): Promise<void> {
    const shouldRun = this.configStore.getConfig().abilities.phoneWindow;

    if (!shouldRun) {
      if (this.phoneBridgeServer) {
        await this.phoneBridgeServer.stop();
        this.phoneBridgeServer = null;
      }
      this.publishPhoneBridgeState();
      return;
    }

    if (this.phoneBridgeServer?.isRunning) {
      return;
    }

    const record = this.phoneBridgeStore.read();
    const server = new PhoneBridgeServer({
      port: record.port,
      token: record.token,
      onError: (errorMessage) => {
        this.phoneBridgeErrorMessage = errorMessage;
        this.publishPhoneBridgeState();
      },
      handlers: {
        getStatus: () => this.buildPhoneBridgeStatus(),
        ask: (requestText) => this.answerPhoneRequest(requestText),
      },
    });

    try {
      const boundPort = await server.start();
      this.phoneBridgeServer = server;
      this.phoneBridgeErrorMessage = null;
      if (boundPort !== record.port) {
        this.phoneBridgeStore.setPort(boundPort);
      }
    } catch (error) {
      this.phoneBridgeErrorMessage = error instanceof Error ? error.message : String(error);
      this.phoneBridgeServer = null;
    }
    this.publishPhoneBridgeState();
  }

  private publishPhoneBridgeState(): void {
    this.publicState.phoneBridge = this.describePhoneBridge();
    this.publishState();
  }

  private describePhoneBridge(): PhoneBridgeInfo {
    const record = this.phoneBridgeStore.read();
    const isRunning = this.phoneBridgeServer?.isRunning ?? false;
    const port = this.phoneBridgeServer?.port ?? record.port;
    return {
      isRunning,
      address: isRunning ? this.buildPhoneBridgeAddress(port, record.token) : "",
      port,
      isReadOnly: true,
      lastErrorMessage: this.phoneBridgeErrorMessage,
    };
  }

  /**
   * The phone opens this over the local network, so the address has to be the
   * machine's address on that network rather than localhost.
   */
  private buildPhoneBridgeAddress(port: number, token: string): string {
    for (const interfaceAddresses of Object.values(networkInterfaces())) {
      for (const address of interfaceAddresses ?? []) {
        if (address.family === "IPv4" && !address.internal) {
          return `http://${address.address}:${port}/?token=${token}`;
        }
      }
    }
    return `http://localhost:${port}/?token=${token}`;
  }

  /** Throws away the old link: any phone still holding it stops working. */
  rotatePhoneBridgeToken(): void {
    if (!this.configStore.getConfig().abilities.phoneWindow) {
      return;
    }
    this.phoneBridgeStore.rotateToken();
    if (this.phoneBridgeServer) {
      void this.phoneBridgeServer.stop().then(() => {
        this.phoneBridgeServer = null;
        return this.syncPhoneBridge();
      });
      return;
    }
    this.publishPhoneBridgeState();
  }

  private buildPhoneBridgeStatus(): PhoneBridgeStatus {
    const config = this.configStore.getConfig();
    return {
      assistantName: config.soul.assistantName,
      isConfigured: this.brainRouter.isConfigured(config),
      voiceState: this.publicState.voiceState,
      lastTranscript: this.publicState.lastTranscript,
      responseText: this.publicState.responseText,
      openTodos: config.abilities.toDoList ? this.todoStore.summarizeOpenItems(8) : [],
      nextScheduledTasks: config.abilities.scheduling
        ? this.scheduleStore.listNextRunsDescription(5)
        : [],
      pendingConfirmationCount: this.confirmationQueue.list().length,
    };
  }

  /**
   * A question asked from the phone.
   *
   * It reads exactly like a spoken question — same soul, same memory, same
   * screen if the user lets Ustaad see it — and then stops. The reply is text
   * and nothing else: no actions, no confirmations answered, no system access.
   * A phone that can ask is a window; a phone that can act is a liability.
   */
  private async answerPhoneRequest(requestText: string): Promise<string> {
    const config = this.configStore.getConfig();
    if (!this.brainRouter.isConfigured(config)) {
      return "the pc has no brain connected yet. open ustaad here and paste a gemini key, then ask again.";
    }

    const images = await this.captureInteractionImages("talk");
    const responseText = await this.brainRouter.streamResponse(config, {
      systemPrompt: this.buildPromptForInteraction(config, "talk", images.length > 0),
      userPrompt: requestText,
      images: images.map(toBrainImage),
      conversationHistory: [...this.conversationHistory],
      signal: new AbortController().signal,
    });

    const parsedResponse = parseModelResponse(responseText);
    const spokenText = parsePointingTag(parsedResponse.spokenText).spokenText || parsedResponse.spokenText;
    const replyText = spokenText.trim() || "I did not get an answer back from the model.";

    this.recordRun({
      request: requestText,
      kind: "reply",
      outcome: "completed",
      note: "asked from the phone window",
      stepsTaken: 0,
      response: replyText,
    });

    if (parsedResponse.taskGoal || parsedResponse.actions?.length) {
      return `${replyText}\n\n(that would need the pc: this came from your phone, so nothing was run.)`;
    }
    return replyText;
  }

  /* ---------------------------------------------------------------------- */
  /* Settings                                                               */
  /* ---------------------------------------------------------------------- */

  updateSettings(settingsUpdates: Partial<UstaadUserConfig>): UstaadPublicState {
    const previousConfig = this.configStore.getConfig();
    const updatedConfig = this.configStore.updateConfig(settingsUpdates);

    if (previousConfig.abilities.phoneWindow !== updatedConfig.abilities.phoneWindow) {
      void this.syncPhoneBridge();
    }

    this.publicState.configured = this.brainRouter.isConfigured(updatedConfig);
    this.publicState.configurationHint = this.brainRouter.configurationHint(updatedConfig);
    this.publicState.brainLabel = this.brainRouter.getBrainLabel(updatedConfig);
    this.publicState.cursorEnabled = updatedConfig.cursorEnabled;
    this.publicState.islandEnabled = updatedConfig.islandEnabled;
    this.publicState.clipboardHistoryEnabled = updatedConfig.clipboardHistoryEnabled;
    this.publicState.automationPaused = updatedConfig.automationPaused;
    this.publicState.dictationShortcutLabel = dictationShortcutLabels[updatedConfig.dictationShortcut];
    this.publicState.errorMessage = null;

    if (previousConfig.cursorEnabled !== updatedConfig.cursorEnabled) {
      this.desktopWindows.setOverlayVisibility(
        updatedConfig.cursorEnabled || this.isInteractionInProgress(),
      );
    }

    if (
      previousConfig.islandEnabled !== updatedConfig.islandEnabled
      || previousConfig.abilities.island !== updatedConfig.abilities.island
    ) {
      this.updateIslandVisibility();
    }

    if (previousConfig.launchAtLogin !== updatedConfig.launchAtLogin) {
      this.applyLaunchAtLogin(updatedConfig.launchAtLogin);
    }

    if (previousConfig.clipboardHistoryEnabled !== updatedConfig.clipboardHistoryEnabled) {
      if (updatedConfig.clipboardHistoryEnabled) {
        this.startClipboardWatcher();
      } else {
        this.stopClipboardWatcher();
      }
    }

    if (previousConfig.islandShowNowPlaying !== updatedConfig.islandShowNowPlaying) {
      if (updatedConfig.islandShowNowPlaying) {
        this.startNowPlayingWatcher();
      }
    }

    if (
      previousConfig.abilities.wakeWord !== updatedConfig.abilities.wakeWord
      || previousConfig.automationPaused !== updatedConfig.automationPaused
      || previousConfig.wakeWordProvider !== updatedConfig.wakeWordProvider
    ) {
      this.synchronizeWakeWordListener();
    }

    this.publishState();
    this.publishIslandState();
    return this.getPublicState();
  }

  async testBrainConnection(settingsUpdates: Partial<UstaadUserConfig>): Promise<BrainConnectionTestResult> {
    try {
      this.updateSettings(settingsUpdates);
    } catch (error) {
      return { ok: false, message: this.describeError(error) };
    }

    try {
      return await Promise.race([
        this.brainRouter.testConnection(this.configStore.getConfig()),
        new Promise<BrainConnectionTestResult>((_resolve, reject) => {
          setTimeout(() => reject(new Error("That check took too long.")), 15_000);
        }),
      ]);
    } catch (error) {
      return { ok: false, message: this.describeError(error) };
    }
  }

  toggleCursorEnabled(): void {
    this.updateSettings({ cursorEnabled: !this.publicState.cursorEnabled });
  }

  toggleIslandEnabled(): void {
    this.updateSettings({ islandEnabled: !this.publicState.islandEnabled });
  }

  toggleAutomationPaused(): void {
    this.updateSettings({ automationPaused: !this.publicState.automationPaused });
    this.activityFeed.record(
      "system",
      this.publicState.automationPaused ? "actions paused" : "actions resumed",
      this.publicState.automationPaused
        ? "Ustaad will describe what it would do instead of doing it"
        : "Ustaad can act on this pc again",
      false,
    );
    this.publishIslandState();
  }

  async refreshAppIndex(): Promise<number> {
    try {
      const indexedAppCount = await this.appIndex.refresh();
      this.publishIslandState();
      return indexedAppCount;
    } catch (error) {
      console.warn("Ustaad could not index your apps:", error);
      return 0;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Island commands                                                        */
  /* ---------------------------------------------------------------------- */

  async handleIslandLaunchApp(appName: string): Promise<void> {
    await this.executeAndRecordAction({ type: "open_app", name: appName });
  }

  async handleIslandMediaControl(operation: "play_pause" | "next" | "previous"): Promise<void> {
    await this.executeAndRecordAction({ type: "media", operation });
  }

  async handleIslandClipboardCopy(clipId: string): Promise<boolean> {
    const clipToCopy = this.clipboardHistoryStore.list().find(
      (clipboardClip) => clipboardClip.id === clipId,
    );
    if (!clipToCopy) {
      return false;
    }

    await clipboard.writeText(clipToCopy.text);
    this.lastClipboardText = clipToCopy.text;
    this.activityFeed.record("action", "copied an earlier clip", clipToCopy.text.slice(0, 120), false);
    this.publishIslandState();
    return true;
  }

  handleIslandTodoToggle(todoId: string, isDone: boolean): void {
    this.todoStore.setDone(todoId, isDone);
    this.publishIslandState();
  }

  handleIslandTodoRemove(todoId: string): void {
    this.todoStore.remove(todoId);
    this.publishIslandState();
  }

  handleIslandScheduleToggle(scheduleId: string, isEnabled: boolean): void {
    this.scheduleStore.setEnabled(scheduleId, isEnabled, new Date());
    this.publishIslandState();
  }

  handleIslandScheduleRemove(scheduleId: string): void {
    this.scheduleStore.remove(scheduleId);
    this.publishIslandState();
  }

  handleIslandMemoryRemove(memoryFactId: string): void {
    this.memoryStore.remove(memoryFactId);
    this.publishIslandState();
  }

  /** Typed straight into the panel's to-do page, without going through the model. */
  handlePanelTodoAdd(todoText: string): void {
    const trimmedText = todoText.trim();
    if (!trimmedText) {
      return;
    }

    const addedTodoItem = this.todoStore.add(trimmedText, null);
    this.activityFeed.record("action", `added "${addedTodoItem.text}" to your list`, "", true);
    this.publishIslandState();
  }

  /** Typed straight into the panel's memory page. */
  handlePanelMemoryAdd(factText: string): void {
    const trimmedText = factText.trim();
    if (!trimmedText) {
      return;
    }

    const addedFact = this.memoryStore.add(trimmedText);
    this.activityFeed.record("action", "saved to memory", addedFact.text.slice(0, 120), true);
    this.publishIslandState();
  }

  /**
   * The run history is a memory of what Ustaad has done, so it follows the same
   * switch as what it remembers: with memory off, nothing about the user's own
   * words is written to disk beyond the audit log.
   */
  private recordRun(draft: Omit<RunHistoryEntry, "id" | "createdAtIso">): void {
    if (!this.publicState.config.abilities.memory) {
      return;
    }
    this.runHistoryStore.record(draft);
  }

  searchRunHistory(query: string): RunHistorySearchResult[] {
    if (!this.publicState.config.abilities.memory) {
      return [];
    }
    return this.runHistoryStore.search(query);
  }

  clearRunHistory(): number {
    return this.runHistoryStore.clear();
  }

  handlePanelMemoryClear(): void {
    const removedFactCount = this.memoryStore.clear();
    if (removedFactCount > 0) {
      this.activityFeed.record("action", `forgot ${removedFactCount} remembered things`, "", true);
    }
    this.publishIslandState();
  }

  handleIslandClipboardClear(): void {
    this.clipboardHistoryStore.clear();
    this.publishIslandState();
  }

  /** Flips one of the island's quick switches, in the same store the panel uses. */
  handleIslandToggle(toggleKey: IslandToggleKey, isEnabled: boolean): void {
    switch (toggleKey) {
      case "cursor":
        this.updateSettings({ cursorEnabled: isEnabled });
        return;
      case "island":
        this.updateSettings({ islandEnabled: isEnabled });
        return;
      case "clipboard":
        this.updateSettings({ clipboardHistoryEnabled: isEnabled });
        return;
      case "paused":
        this.updateSettings({ automationPaused: isEnabled });
        return;
    }
  }

  /**
   * Wallpaper swatches in the island are clicked on purpose, so they run
   * straight away; asking again in a confirmation card would be noise.
   */
  async handleIslandWallpaperSolidColor(wallpaperColor: string): Promise<void> {
    await this.executeAndRecordAction({
      type: "wallpaper",
      operation: "solid",
      path: null,
      color: wallpaperColor,
    });
  }

  handleIslandOpenPanel(pageName: string): void {
    this.desktopWindows.showPanel(pageName || "home");
  }

  /** The island's own close button, or Escape sent by the renderer. */
  handleIslandClosedByUser(): void {
    this.isIslandCurrentlyExpanded = false;
    this.desktopWindows.closeIsland();
    this.publishIslandState();
  }

  handleIslandExpandedChanged(isExpanded: boolean): void {
    this.isIslandCurrentlyExpanded = isExpanded;
    this.desktopWindows.setIslandExpanded(isExpanded);
    this.publishIslandState();
  }

  /* ---------------------------------------------------------------------- */
  /* Multi-step tasks                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Enters the agent loop for a reply that described a goal instead of a single
   * action. One approval covers the whole task — the user sees the goal, not a
   * click-by-click script — and every step is still logged and undoable, with
   * Escape stopping everything immediately.
   */
  private async beginModelTask(
    interactionId: number,
    goal: string,
    initialActions: UstaadAction[],
    config: UstaadUserConfig,
  ): Promise<string> {
    if (config.automationPaused) {
      this.activityFeed.record(
        "system",
        "actions are paused",
        `Ustaad would have worked on: ${goal}`,
        false,
      );
      this.publishIslandState();
      return "actions are paused";
    }

    if (!config.abilities.screenVision) {
      // Without eyes, a task cannot be checked and must not be attempted blind.
      this.activityFeed.record(
        "system",
        "I need to see the screen for that",
        "switch screen vision back on in the soul tab and ask me again",
        false,
      );
      this.publishIslandState();
      return "I need screen vision for that";
    }

    const { allowedActions, blockedActions } = filterActionsByAbilities(initialActions, config.abilities);
    for (const blockedAction of blockedActions) {
      this.activityFeed.record(
        "system",
        "skipped an action",
        `${blockedAction.action.type.replace(/_/gu, " ")} needs the "${blockedAction.ability}" ability, which is switched off`,
        false,
      );
    }

    const actionsNeedingApproval = allowedActions.filter((action) =>
      actionNeedsConfirmation(action, config.confirmationMode, config.autoApprovedActionTypes));

    if (actionsNeedingApproval.length) {
      const pendingConfirmation = this.confirmationQueue.enqueue(
        interactionId,
        allowedActions,
        `work on: ${goal}`,
      );
      this.pendingTaskGoals.set(pendingConfirmation.id, goal);
      this.activityFeed.record(
        "confirmation",
        "waiting for your yes",
        `${goal} — Ustaad will click and type on this pc until that is done, or press Esc to stop`,
        false,
      );
      this.desktopWindows.openIsland();
      this.publishIslandState();
      return `waiting for your yes to work on: ${goal}`;
    }

    void this.runAgentTask(goal, allowedActions);
    return `working on: ${goal}`;
  }

  /* ---------------------------------------------------------------------- */
  /* Task queue: one screen and one pointer, so one task at a time          */
  /* ---------------------------------------------------------------------- */

  /**
   * Adds a task to the end of the list instead of refusing it. Nothing here
   * approves anything: when the queued task starts it walks the same ability
   * filter and the same confirmation as if it had been asked for out loud.
   */
  private enqueueTask(goal: string, seedActions: UstaadAction[]): void {
    let queuedTask: QueuedTask;
    try {
      queuedTask = this.taskQueueStore.enqueue({ goal, seedActions });
    } catch {
      return;
    }

    const waitingCount = this.taskQueueStore.waiting().length;
    this.activityFeed.record(
      "system",
      `added to the list: ${queuedTask.goal}`,
      waitingCount > 1
        ? `${waitingCount} waiting their turn`
        : "it runs as soon as the one before it ends",
      false,
    );
    this.desktopWindows.openIsland();
    this.publishIslandState();
  }

  /** Starts the oldest waiting task. Also the island's "run the list" button. */
  async runTaskQueue(): Promise<string> {
    if (this.isAgentTaskRunning) {
      return "I am still working on something.";
    }

    const nextTask = this.taskQueueStore.takeNext();
    if (!nextTask) {
      return "there is nothing waiting.";
    }

    void this.runAgentTask(nextTask.goal, nextTask.seedActions, null, nextTask.id);
    return `starting: ${nextTask.goal}`;
  }

  /** Takes one task off the list. The task being worked on is stopped, not dropped. */
  cancelQueuedTask(taskId: string): string {
    const cancelledTask = this.taskQueueStore.cancel(taskId);
    if (!cancelledTask) {
      return "that one is already running.";
    }

    this.activityFeed.record(
      "system",
      `off the list: ${cancelledTask.goal}`,
      "everything behind it moves up",
      false,
    );
    this.publishIslandState();
    return "taken off the list.";
  }

  clearTaskQueue(): string {
    const clearedCount = this.taskQueueStore.cancelWaiting();
    if (clearedCount === 0) {
      return "there is nothing waiting.";
    }

    this.activityFeed.record(
      "system",
      clearedCount === 1 ? "cleared 1 waiting task" : `cleared ${clearedCount} waiting tasks`,
      "",
      false,
    );
    this.publishIslandState();
    return clearedCount === 1 ? "cleared 1 waiting task." : `cleared ${clearedCount} waiting tasks.`;
  }

  /* ---------------------------------------------------------------------- */
  /* Skills: tasks the user saved by name                                   */
  /* ---------------------------------------------------------------------- */

  private loadSkillSuggestionMemory(): void {
    const memory = this.skillSuggestionHistoryStore?.read();
    if (!memory) {
      return;
    }
    this.taskHistory = trimTaskHistory(memory.history);
    for (const [signature, declineCount] of Object.entries(memory.declinedSignatures)) {
      this.declinedSkillSignatures.set(signature, declineCount);
    }
  }

  private persistSkillSuggestionMemory(): void {
    this.skillSuggestionHistoryStore?.write({
      history: trimTaskHistory(this.taskHistory),
      declinedSignatures: Object.fromEntries(this.declinedSkillSignatures),
    });
  }

  /**
   * Called after a task finishes well. Ustaad counts repeats in the background
   * and, once the same task has worked a few times, offers to save it — it never
   * saves anything by itself.
   */
  private noteSuccessfulTask(goal: string, seedActions: UstaadAction[]): void {
    if (!this.configStore.getConfig().abilities.automation) {
      return;
    }

    const signature = taskSignature(goal);
    if (!signature) {
      return;
    }

    this.taskHistory = trimTaskHistory([
      ...this.taskHistory,
      {
        id: randomUUID(),
        goal,
        signature,
        seedActions: seedActions.slice(0, 12),
        succeededAtIso: new Date().toISOString(),
      },
    ]);
    this.persistSkillSuggestionMemory();

    const savedSignatures = new Set(this.skillStore.list().map((skill) => taskSignature(skill.goal)));
    const suggestion = suggestSkill({
      history: this.taskHistory,
      savedSignatures,
      declinedSignatures: Object.fromEntries(this.declinedSkillSignatures),
    });

    if (!suggestion) {
      return;
    }
    if (this.currentSkillSuggestion?.signature === suggestion.signature) {
      return;
    }

    this.currentSkillSuggestion = suggestion;
    this.activityFeed.record(
      "system",
      `that worked ${suggestion.successCount} times`,
      `save it as "${suggestion.proposedName}" so you can just ask for it?`,
      false,
    );
    this.desktopWindows.openIsland();
    this.publishIslandState();
  }

  /** The island's "save it" button. Only ever runs because the user pressed it. */
  saveSuggestedSkill(): Skill | null {
    const suggestion = this.currentSkillSuggestion;
    if (!suggestion) {
      return null;
    }

    const savedSkill = this.skillStore.save({
      name: suggestion.proposedName,
      goal: suggestion.goal,
      seedActions: suggestion.seedActions,
    });

    this.currentSkillSuggestion = null;
    this.declinedSkillSignatures.delete(suggestion.signature);
    this.persistSkillSuggestionMemory();

    this.activityFeed.record(
      "system",
      `saved the "${savedSkill.name}" skill`,
      `say "do ${savedSkill.name}" any time, or rename it in the plans tab`,
      false,
    );
    this.publishState();
    this.publishIslandState();
    return savedSkill;
  }

  dismissSuggestedSkill(): void {
    const suggestion = this.currentSkillSuggestion;
    if (!suggestion) {
      return;
    }

    // Remembering the count at refusal is what makes "no" stick for a while,
    // instead of asking again the very next time the user does the thing.
    this.declinedSkillSignatures.set(suggestion.signature, suggestion.successCount);
    this.currentSkillSuggestion = null;
    this.persistSkillSuggestionMemory();

    this.activityFeed.record("system", "no skill saved", "I will not ask again for a while", false);
    this.publishIslandState();
  }

  /**
   * Called after a saved skill runs. Records how it went and, once the same
   * skill has failed twice in a row, offers to work out a different way. The
   * offer is only ever an offer: nothing about the skill changes yet.
   */
  private noteSavedSkillOutcome(skillId: string, outcome: RunOutcome, note: string): void {
    const updatedSkill = this.skillStore.noteRun(skillId, {
      outcome,
      note,
      countsAsFailure: isSkillFailure(outcome),
    });
    if (!updatedSkill) {
      return;
    }

    // Working again is the end of the matter, however the repair was going.
    if (outcome === "completed") {
      if (this.currentSkillRepair?.skillId === skillId) {
        this.currentSkillRepair = null;
        this.activityFeed.record("system", `the "${updatedSkill.name}" skill worked this time`, "nothing to fix", false);
        this.publishIslandState();
      }
      return;
    }

    if (this.currentSkillRepair?.skillId === skillId) {
      return;
    }
    if (!shouldOfferSkillRepair(updatedSkill)) {
      return;
    }

    this.skillStore.noteRepairOffered(updatedSkill.id, updatedSkill.failureStreak);
    this.currentSkillRepair = {
      stage: "offered",
      skillId: updatedSkill.id,
      skillName: updatedSkill.name,
      failureStreak: updatedSkill.failureStreak,
      lastOutcomeNote: updatedSkill.lastOutcomeNote,
      proposedGoal: null,
      proposedActions: [],
      explanation: "",
    };
    this.activityFeed.record(
      "system",
      `the "${updatedSkill.name}" skill has not worked ${updatedSkill.failureStreak} times in a row`,
      "want me to work out a different way?",
      false,
    );
    this.desktopWindows.openIsland();
    this.publishIslandState();
  }

  /** The island's "work out a fix" button. One model call, and still no action. */
  async workOutSkillRepair(): Promise<string> {
    const repair = this.currentSkillRepair;
    if (!repair || repair.stage !== "offered") {
      return "there is nothing to fix right now.";
    }

    const skill = this.skillStore.findById(repair.skillId);
    if (!skill) {
      this.currentSkillRepair = null;
      this.publishIslandState();
      return "that skill is not saved any more.";
    }

    const config = this.configStore.getConfig();
    if (!this.brainRouter.isConfigured(config)) {
      return this.brainRouter.configurationHint(config);
    }

    this.currentSkillRepair = { ...repair, stage: "working" };
    this.publishIslandState();

    try {
      const modelResponseText = await this.brainRouter.streamResponse(config, {
        systemPrompt: buildSkillRepairPrompt(skill, config.abilities),
        userPrompt: `Work out a better way to do "${skill.name}".`,
        images: [],
        conversationHistory: [],
        signal: new AbortController().signal,
      });
      const parsedRepair = parseSkillRepairReply(modelResponseText);
      if (!parsedRepair) {
        this.currentSkillRepair = { ...repair, stage: "offered" };
        this.activityFeed.record("system", `could not work out a fix for "${skill.name}"`, "the old steps still stand", false);
        this.publishIslandState();
        return "I could not work out a fix for that one.";
      }

      this.currentSkillRepair = {
        stage: "proposed",
        skillId: skill.id,
        skillName: skill.name,
        failureStreak: skill.failureStreak,
        lastOutcomeNote: skill.lastOutcomeNote,
        proposedGoal: parsedRepair.goal,
        proposedActions: parsedRepair.actions,
        explanation: parsedRepair.explanation,
      };
      this.publishIslandState();
      return `I worked out a different way to do "${skill.name}" — press "save the fix" to keep it.`;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.currentSkillRepair = { ...repair, stage: "offered" };
      this.activityFeed.record("system", `could not work out a fix for "${skill.name}"`, errorMessage, false);
      this.publishIslandState();
      return `I could not work that one out: ${errorMessage}`;
    }
  }

  /**
   * The island's "save the fix" button. This is the only path that changes a
   * saved skill, it keeps the name and the id, and it resets the health rather
   * than granting anything: the repaired skill is confirmed per run like any
   * other.
   */
  saveSkillRepair(): string {
    const repair = this.currentSkillRepair;
    if (!repair || repair.stage !== "proposed" || !repair.proposedGoal) {
      return "there is no fix to save.";
    }

    const repairedSkill = this.skillStore.applyRepair(repair.skillId, {
      goal: repair.proposedGoal,
      seedActions: repair.proposedActions,
    });
    if (!repairedSkill) {
      return "that skill is not saved any more.";
    }

    this.currentSkillRepair = null;
    this.activityFeed.record(
      "system",
      `"${repairedSkill.name}" now works a different way`,
      repairedSkill.goal,
      false,
    );
    this.publishState();
    this.publishIslandState();
    return `saved the new way to do "${repairedSkill.name}".`;
  }

  /** "keep the old one": nothing changes, and the offer is not repeated yet. */
  dismissSkillRepair(): void {
    const repair = this.currentSkillRepair;
    if (!repair) {
      return;
    }

    this.currentSkillRepair = null;
    if (repair.stage === "proposed") {
      this.activityFeed.record("system", `kept the old "${repair.skillName}" skill`, "I will not ask again for a while", false);
    } else {
      this.activityFeed.record("system", `kept the old "${repair.skillName}" skill`, "", false);
    }
    this.publishIslandState();
  }

  renameSkill(skillId: string, nextName: string): UstaadPublicState | void {
    const renamedSkill = this.skillStore.rename(skillId, nextName);
    if (!renamedSkill) {
      return;
    }
    this.publishIslandState();
    this.publishState();
  }

  removeSkill(skillId: string): void {
    const skill = this.skillStore.findById(skillId);
    if (!this.skillStore.remove(skillId)) {
      return;
    }
    this.activityFeed.record("system", `removed the "${skill?.name ?? "saved"}" skill`, "", false);
    this.publishIslandState();
    this.publishState();
  }

  /**
   * Runs a saved skill. It goes through beginModelTask like any other task, so
   * the ability checks, the task approval and the agent loop all still apply —
   * a skill can never do something the user would not have agreed to out loud.
   */
  private async runSavedSkill(skillName: string): Promise<ActionExecutionOutcome> {
    const skill = this.skillStore.findByName(skillName);
    if (!skill) {
      const availableNames = this.skillStore.summarizeNames(3).map((candidate) => `"${candidate.name}"`);
      return failedActionOutcome(
        availableNames.length
          ? `I do not have a "${skillName}" skill. I do have ${availableNames.join(", ")}.`
          : `I do not have a "${skillName}" skill yet.`,
      );
    }

    void this.runAgentTask(skill.goal, skill.seedActions, skill.id);
    return completedActionOutcome(`starting ${skill.name}`, skill.goal);
  }

  /** Runs the loop and reports where it ended up. */
  private async runAgentTask(
    goal: string,
    initialActions: UstaadAction[],
    skillId: string | null = null,
    queuedTaskId: string | null = null,
  ): Promise<void> {
    if (this.isAgentTaskRunning) {
      // One desktop, one pointer: the second request waits its turn rather
      // than being lost. A skill is the exception — its health is filed
      // against the run, so it is better to hear "say it again" than to lose
      // the outcome of the run.
      if (skillId) {
        this.activityFeed.record(
          "system",
          "still working on the last one",
          `say "${goal}" again when I am free`,
          false,
        );
        this.publishIslandState();
        return;
      }
      this.enqueueTask(goal, initialActions);
      return;
    }

    this.isAgentTaskRunning = true;
    this.currentQueuedTaskId = queuedTaskId;
    this.agentTaskCancelled = false;
    this.activityFeed.record("system", `working on: ${goal}`, "step by step, checking the screen as it goes", false);
    this.desktopWindows.openIsland();
    this.publishIslandState();

    try {
      const taskResult = await this.agentLoop.run(goal, initialActions);
      this.activityFeed.record(
        taskResult.outcome === "completed" ? "system" : "system",
        taskResult.outcome === "completed" ? "finished" : "stopped",
        `${goal} — ${taskResult.note}`,
        false,
      );
      this.publicState.lastActionSummary = taskResult.note;
      this.recordRun({
        request: goal,
        kind: "task",
        outcome: taskResult.outcome,
        note: taskResult.note,
        stepsTaken: taskResult.stepsTaken,
        response: this.publicState.responseText,
      });
      if (this.currentQueuedTaskId) {
        this.taskQueueStore.finish(
          this.currentQueuedTaskId,
          taskResult.outcome === "completed"
            ? "done"
            : (taskResult.outcome === "stopped" ? "cancelled" : "failed"),
          taskResult.note,
        );
        this.currentQueuedTaskId = null;
      }
      if (skillId) {
        this.noteSavedSkillOutcome(skillId, taskResult.outcome, taskResult.note);
      }
      if (taskResult.outcome === "completed") {
        this.noteSuccessfulTask(goal, initialActions);
      } else {
        this.desktopWindows.showNotification("Ustaad", `${goal}: ${taskResult.note}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.activityFeed.record("system", "that task did not finish", errorMessage, false);
      this.recordRun({
        request: goal,
        kind: "task",
        outcome: "failed",
        note: errorMessage,
        stepsTaken: 0,
        response: "",
      });
      if (this.currentQueuedTaskId) {
        this.taskQueueStore.finish(this.currentQueuedTaskId, "failed", errorMessage);
        this.currentQueuedTaskId = null;
      }
      if (skillId) {
        this.noteSavedSkillOutcome(skillId, "failed", errorMessage);
      }
    } finally {
      this.isAgentTaskRunning = false;
      this.currentQueuedTaskId = null;
      this.agentTaskCancelled = true;
      this.publishState();
      this.publishIslandState();

      // The list moves on by itself: whatever was waiting starts now.
      if (this.taskQueueStore.waiting().length > 0 && !this.configStore.getConfig().automationPaused) {
        void this.runTaskQueue();
      }
    }
  }

  /** One step of a task: the ordinary action path, minus the per-step prompts. */
  private async runAgentStepActions(actions: UstaadAction[]): Promise<string> {
    const stepMessages: string[] = [];
    for (const action of actions) {
      if (this.agentTaskCancelled) {
        break;
      }
      const completedMessage = await this.executeAndRecordAction(action);
      if (completedMessage) {
        stepMessages.push(completedMessage);
      }
    }
    this.publishIslandState();
    return stepMessages.join("; ");
  }

  /**
   * Looks at the screen and asks the model whether the goal is met. Ustaad
   * sends the same multi-monitor screenshots it uses for answering, so clicks
   * the model proposes are expressed in a space Ustaad can map back.
   */
  private async lookAtScreenForTask(lookRequest: {
    goal: string;
    stepNumber: number;
    previousSummary: string;
    previousActions: UstaadAction[];
  }): Promise<AgentLoopLookResult> {
    const config = this.configStore.getConfig();
    if (this.agentTaskCancelled || config.automationPaused) {
      return { kind: "give_up", note: "I stopped because you asked me to" };
    }
    if (!this.brainRouter.isConfigured(config)) {
      return { kind: "unavailable", note: this.brainRouter.configurationHint(config) };
    }

    let capturedDisplays: CapturedDisplayImage[] = [];
    try {
      capturedDisplays = await captureAllWindowsDisplays();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { kind: "unavailable", note: `I could not take a screenshot: ${errorMessage}` };
    }

    // Clicks in the model's next step are in this screenshot's pixel space.
    this.actionExecutor.setClickCoordinateSpace(capturedDisplays);
    this.lastPointingTargets = capturedDisplays;

    const abortController = new AbortController();
    let responseText = "";
    try {
      responseText = await this.brainRouter.streamResponse(config, {
        systemPrompt: buildAgentLookPrompt({
          goal: lookRequest.goal,
          stepNumber: lookRequest.stepNumber,
          previousSummary: lookRequest.previousSummary,
          hasScreenshots: capturedDisplays.length > 0,
        }),
        userPrompt: `step ${lookRequest.stepNumber} just finished. check the goal and answer with DONE, NEXT or GIVE_UP.`,
        images: capturedDisplays.map(toBrainImage),
        conversationHistory: [],
        signal: abortController.signal,
        onTextUpdate: () => undefined,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { kind: "unavailable", note: `I could not check the screen: ${errorMessage}` };
    }

    return parseAgentLookResponse(responseText);
  }

  private handleAgentProgress(progressEvent: {
    kind: string;
    stepNumber: number;
    note: string;
    actionSummary: string;
  }): void {
    if (progressEvent.kind === "step_started") {
      this.desktopWindows.updateOverlayResponse(`step ${progressEvent.stepNumber}: ${progressEvent.note}`);
    } else if (progressEvent.kind === "step_finished") {
      this.activityFeed.record("action", `step ${progressEvent.stepNumber}`, progressEvent.note, false);
      this.publishIslandState();
    }
  }

  /** Escape, a new request, quitting: everything the task loop must obey. */
  private cancelAgentTask(): void {
    this.agentTaskCancelled = true;
  }

  /* ---------------------------------------------------------------------- */
  /* Wake word                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Runs the offline listener exactly when the user has asked for it: switched
   * on, not muted, and not paused. Every other combination leaves the
   * microphone closed.
   */
  synchronizeWakeWordListener(): void {
    const config = this.configStore.getConfig();
    const shouldListen = config.abilities.wakeWord
      && !this.wakeWordMuted
      && !config.automationPaused
      && config.wakeWordProvider === "offline";

    if (!shouldListen) {
      this.wakeWordListener.stop();
      this.wakeWordState = "off";
      this.wakeWordMessage = config.abilities.wakeWord
        ? this.wakeWordMuted
          ? "the microphone is muted from the tray"
          : config.automationPaused
            ? "listening stops while actions are paused"
            : config.wakeWordProvider === "cloud"
              ? "the cloud wake word is not switched on in this build yet"
              : ""
        : "";
      this.publishState();
      this.publishIslandState();
      return;
    }

    this.wakeWordListener.start();
  }

  /** The tray switch: silence the microphone without changing the setting. */
  toggleWakeWordMuted(): void {
    this.wakeWordMuted = !this.wakeWordMuted;
    this.publicState.wakeWordMuted = this.wakeWordMuted;
    this.activityFeed.record(
      "system",
      this.wakeWordMuted ? "wake word muted" : "wake word listening again",
      this.wakeWordMuted
        ? "Ustaad is not listening for its name until you unmute it"
        : "say \"ustaad\" to summon the island",
      false,
    );
    this.synchronizeWakeWordListener();
    this.publishState();
    this.publishIslandState();
  }

  isWakeWordMuted(): boolean {
    return this.wakeWordMuted;
  }

  private handleWakeWordListenerState(state: WakeWordListenerState, message: string): void {
    this.wakeWordState = state === "stopped" ? "off" : state;
    this.wakeWordMessage = message;
    this.publicState.wakeWordState = this.wakeWordState;
    this.publicState.wakeWordMessage = message;
    this.publishState();
    this.publishIslandState();
  }

  /**
   * "Ustaad" on its own summons the island and opens the microphone for one
   * follow-up: the user can keep talking, and Ustaad submits by itself once
   * they stop.
   */
  private handleWakeWordDetected(detection: WakeWordDetection): void {
    if (this.wakeWordMuted || this.activeInteractionKind !== null || this.isSnipInFlight) {
      return;
    }
    if (this.publicState.voiceState !== "idle") {
      return;
    }

    this.activityFeed.record(
      "system",
      `heard "${detection.phrase}"`,
      `${detection.confidence}% confidence, on this pc`,
      false,
    );
    this.desktopWindows.revealIsland();
    this.desktopWindows.openIsland();
    this.publishIslandState();
    void this.beginWakeFollowUp();
  }

  /**
   * One listening window after the wake word. It ends on silence, and it ends
   * quietly when the user said the wake word and then said nothing else.
   */
  private async beginWakeFollowUp(): Promise<void> {
    await this.beginInteraction("talk");
    if (this.activeInteractionKind !== "talk") {
      return;
    }

    this.wakeFollowUpStartedAtMs = Date.now();
    this.wakeFollowUpHeardSpeechAtMs = 0;
    this.startWakeFollowUpWatchdog();
  }

  private startWakeFollowUpWatchdog(): void {
    this.clearWakeFollowUpWatchdog();
    this.wakeFollowUpTimer = setInterval(() => {
      const now = Date.now();
      const elapsedMilliseconds = now - this.wakeFollowUpStartedAtMs;

      if (!this.wakeFollowUpHeardSpeechAtMs) {
        if (elapsedMilliseconds > wakeFollowUpSilenceWindows.noSpeech) {
          this.endWakeFollowUp({ submit: false });
        }
        return;
      }

      if (now - this.wakeFollowUpHeardSpeechAtMs > wakeFollowUpSilenceWindows.afterSpeech) {
        this.endWakeFollowUp({ submit: true });
        return;
      }

      if (elapsedMilliseconds > wakeFollowUpSilenceWindows.maximum) {
        this.endWakeFollowUp({ submit: true });
      }
    }, 150);
  }

  private clearWakeFollowUpWatchdog(): void {
    if (this.wakeFollowUpTimer) {
      clearInterval(this.wakeFollowUpTimer);
      this.wakeFollowUpTimer = null;
    }
  }

  private endWakeFollowUp(options: { submit: boolean } = { submit: false }): void {
    const wasActive = this.wakeFollowUpStartedAtMs > 0;
    this.clearWakeFollowUpWatchdog();
    this.wakeFollowUpStartedAtMs = 0;
    this.wakeFollowUpHeardSpeechAtMs = 0;

    if (!wasActive || this.activeInteractionKind !== "talk") {
      return;
    }

    if (options.submit) {
      void this.finishListening();
      return;
    }

    // The user called Ustaad's name and stopped there. Close the microphone
    // without sending anything anywhere, and leave the island open.
    this.cancelActiveWork();
    this.publicState.voiceState = "idle";
    this.publicState.interactionKind = null;
    this.desktopWindows.updateOverlayMode({ interactionKind: null, hint: "", typedText: "" });
    this.publishState();
    this.publishIslandState();
  }

  private isWakeFollowUpActive(): boolean {
    return this.wakeFollowUpStartedAtMs > 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Circle selection                                                       */
  /* ---------------------------------------------------------------------- */

  /* ---------------------------------------------------------------------- */
  /* Snips: drag a region, land it on the clipboard                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Starts a snip. Not a conversation: nothing is recorded and nothing is sent
   * anywhere, the overlay just waits for a drag.
   */
  beginSnip(): void {
    const config = this.configStore.getConfig();
    if (!config.abilities.screenVision) {
      this.publicState.errorMessage = "screen vision is switched off, so Ustaad cannot take a snip. turn it back on in the soul tab.";
      this.desktopWindows.showPanel("soul");
      this.publishState();
      return;
    }
    if (config.automationPaused) {
      this.publicState.errorMessage = "actions are paused, so Ustaad did not start a snip.";
      this.publishState();
      return;
    }

    // The Ctrl+Alt half of the chord may already have started talking.
    this.cancelActiveWork();
    this.publicState.errorMessage = null;
    this.publicState.voiceState = "idle";
    this.publicState.interactionKind = null;
    this.isSnipInFlight = true;
    this.desktopWindows.updateOverlayMode({ interactionKind: null, hint: "", typedText: "" });
    this.desktopWindows.updateOverlayResponse("");
    this.desktopWindows.closeIsland();
    this.desktopWindows.showRegionSelector(
      "drag over the part you want, then let go to copy it",
      "snip",
    );
    this.publishState();
    this.publishIslandState();
  }

  isSnipActive(): boolean {
    return this.isSnipInFlight;
  }

  async handleSnipRegionSelected(selection: RegionSelectorSelection): Promise<void> {
    if (!this.isSnipInFlight) {
      return;
    }
    this.isSnipInFlight = false;

    let capturedSnip: { pngBuffer: Buffer; width: number; height: number };
    try {
      capturedSnip = await captureWindowsDesktopRegionPng(selection);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.activityFeed.record("action", "could not take that snip", errorMessage, false);
      this.desktopWindows.showNotification("Ustaad snip", "I could not capture that region.");
      this.publishIslandState();
      return;
    }

    const savedFilePath = await this.saveSnipFile(capturedSnip.pngBuffer);

    let copiedToClipboard = true;
    try {
      await clipboard.write([
        new ClipboardItem({
          "image/png": new Blob([new Uint8Array(capturedSnip.pngBuffer)], { type: "image/png" }),
        }),
      ]);
    } catch {
      // The pixels still exist on disk, so the path is the next best thing.
      copiedToClipboard = false;
      if (savedFilePath) {
        await clipboard.writeText(savedFilePath);
      }
    }

    const sizeDescription = `${capturedSnip.width} × ${capturedSnip.height}`;
    const destinationDescription = savedFilePath
      ? `saved to ${savedFilePath}`
      : "not saved to disk";
    const message = copiedToClipboard
      ? `copied a ${sizeDescription} snip to your clipboard`
      : `saved a ${sizeDescription} snip but could not reach the clipboard`;

    this.activityFeed.record("action", message, destinationDescription, false);
    this.desktopWindows.showNotification("Ustaad snip", copiedToClipboard
      ? `${sizeDescription} pixels are on your clipboard. Paste anywhere.`
      : `${sizeDescription} pixels are saved in Pictures.`);
    this.desktopWindows.revealIsland();
    this.publishIslandState();
  }

  handleSnipCancelled(): void {
    if (!this.isSnipInFlight) {
      return;
    }
    this.isSnipInFlight = false;
    this.publishIslandState();
  }

  /** Saves every snip so a copy that gets overwritten is never lost. */
  private async saveSnipFile(pngBuffer: Buffer): Promise<string | null> {
    try {
      const snipDirectory = join(app.getPath("pictures"), "Ustaad Snips");
      await mkdir(snipDirectory, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);
      const snipFilePath = join(snipDirectory, `Ustaad snip ${timestamp}.png`);
      await writeFile(snipFilePath, pngBuffer);
      return snipFilePath;
    } catch {
      return null;
    }
  }

  handleCircleRegionSelected(selection: RegionSelectorSelection): void {
    if (this.activeInteractionKind !== "circle") {
      return;
    }
    this.selectedCircleRegion = selection;
  }

  handleCircleSelectionCancelled(): void {
    this.selectedCircleRegion = null;
  }

  /* ---------------------------------------------------------------------- */
  /* Scheduled tasks                                                        */
  /* ---------------------------------------------------------------------- */

  /* ---------------------------------------------------------------------- */
  /* Presence: the check-ins Ustaad starts by itself                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Runs any check-in that is owed right now.
   *
   * This is called from the same twenty-second timer as the scheduler and costs
   * nothing when there is nothing to say: no model call, no file read, just a
   * comparison against the clock and the date the last check-in ran. An idle
   * Ustaad therefore stays idle.
   */
  private async runDuePresenceCheckIns(): Promise<void> {
    const config = this.configStore.getConfig();
    if (!config.abilities.presence || config.automationPaused) {
      return;
    }

    const now = new Date();
    const dueCheckIns = findDuePresenceCheckIns(config.presence, now, this.presenceStore.lastCompletedDateKeys());
    for (const dueCheckIn of dueCheckIns) {
      await this.deliverPresenceCheckIn(dueCheckIn, now);
    }
  }

  /**
   * The panel's "check in now" button.
   *
   * A manual run deliberately does not count as the day's scheduled check-in:
   * asking to see one early is not the same as asking to skip it.
   */
  async runCheckInNow(): Promise<void> {
    const now = new Date();
    const kind = now.getHours() < 12 ? "morning" : "evening";
    await this.deliverPresenceCheckIn({ kind, scheduledAt: now, minutesLate: 0, isLate: false }, now);
  }

  private async deliverPresenceCheckIn(dueCheckIn: DuePresenceCheckIn, now: Date): Promise<void> {
    const config = this.configStore.getConfig();
    const digest = buildBriefingDigest({
      kind: dueCheckIn.kind,
      now,
      scheduledTasks: this.scheduleStore.list(),
      todos: this.todoStore.list(),
      activityFeed: this.activityFeed.list(40),
      isLate: dueCheckIn.isLate,
    });

    const detailText = digest.lines.join(" ");
    const notificationTitle = `Ustaad ${digest.title}`;

    // Recorded first: if speaking or a notification throws, the check-in still
    // counts as delivered rather than firing again every twenty seconds.
    this.presenceStore.markCheckInDelivered(
      {
        kind: dueCheckIn.kind,
        title: digest.title,
        summary: digest.summary,
        ranAtIso: now.toISOString(),
      },
      now,
    );

    this.activityFeed.record("automation", `check-in: ${digest.title}`, detailText, false);
    this.desktopWindows.revealIsland();
    this.desktopWindows.showNotification(notificationTitle, detailText);

    if (config.presence.speakCheckIns) {
      await this.speakResponse(this.activeInteractionId, `${digest.title}. ${detailText}`);
    }

    this.publishIslandState();
  }

  private startScheduler(): void {
    if (this.schedulerTimer) {
      return;
    }

    this.schedulerTimer = setInterval(() => {
      void this.runDueScheduledTasks();
      void this.runDuePresenceCheckIns();
    }, schedulerTickMilliseconds);
  }

  private async runDueScheduledTasks(): Promise<void> {
    const config = this.configStore.getConfig();
    if (!config.abilities.scheduling || config.automationPaused || !this.brainRouter.isConfigured(config)) {
      return;
    }

    for (const scheduledTask of this.scheduleStore.listDueTasks(new Date())) {
      if (this.runningScheduledTaskIds.has(scheduledTask.id)) {
        continue;
      }

      this.runningScheduledTaskIds.add(scheduledTask.id);
      try {
        await this.runScheduledTask(scheduledTask.id);
      } finally {
        this.runningScheduledTaskIds.delete(scheduledTask.id);
      }
    }
  }

  private async runScheduledTask(scheduledTaskId: string): Promise<void> {
    const scheduledTask = this.scheduleStore.list().find((task) => task.id === scheduledTaskId);
    if (!scheduledTask) {
      return;
    }

    this.scheduleStore.recordRun(scheduledTask.id, new Date());
    // A routine that fires while the user is doing something else has to be
    // visible, so the mark slides in even though nobody touched the top edge.
    this.desktopWindows.revealIsland();
    this.publishIslandState();

    if (scheduledTask.kind === "routine") {
      const completedMessages: string[] = [];
      for (const routineAction of scheduledTask.actions) {
        const completedMessage = await this.executeAndRecordAction(routineAction);
        if (completedMessage) {
          completedMessages.push(completedMessage);
        }
      }

      const routineSummary = completedMessages.join(", ") || "nothing needed doing";
      this.activityFeed.record("automation", `ran the routine ${scheduledTask.name}`, routineSummary, false);
      this.desktopWindows.showNotification(scheduledTask.name, routineSummary);
      if (this.configStore.getConfig().speakScheduledResults) {
        await this.speakResponse(this.activeInteractionId, `${scheduledTask.name} is done. ${routineSummary}.`);
      }
      this.publishIslandState();
      return;
    }

    // Reminders run as a normal turn, minus the human: the model decides what
    // the request needs and Ustaad executes it with the usual safety rules.
    this.activeInteractionId += 1;
    const interactionId = this.activeInteractionId;
    this.activeInteractionKind = "scheduled";
    this.publicState.interactionKind = "scheduled";
    this.publicState.voiceState = "processing";
    this.publishState();
    this.desktopWindows.setOverlayVisibility(true);
    this.desktopWindows.updateOverlayMode({
      interactionKind: "scheduled",
      hint: `running "${scheduledTask.name}"`,
      typedText: "",
    });

    const responseAbortController = new AbortController();
    this.responseAbortController = responseAbortController;

    try {
      const config = this.configStore.getConfig();
      const images = config.abilities.screenVision
        ? (await captureAllWindowsDisplays()).map((capturedDisplay) => toBrainImage(capturedDisplay))
        : [];
      const scheduledPrompt = buildScheduledTaskPrompt(scheduledTask.name, scheduledTask.prompt);

      const responseText = await this.brainRouter.streamResponse(config, {
        systemPrompt: this.buildPromptForInteraction(config, "scheduled", images.length > 0),
        userPrompt: scheduledPrompt,
        images,
        conversationHistory: [...this.conversationHistory],
        signal: responseAbortController.signal,
        onTextUpdate: (accumulatedText) => {
          this.publicState.responseText = accumulatedText;
          this.publishState();
        },
      });

      const parsedResponse = parseModelResponse(responseText);
      const pointingResult = parsePointingTag(parsedResponse.spokenText);
      const spokenText = pointingResult.spokenText || parsedResponse.spokenText;
      this.publicState.responseText = spokenText;
      this.desktopWindows.updateOverlayResponse(spokenText);
      this.rememberExchange(scheduledPrompt, spokenText);

      await this.runModelActions(interactionId, parsedResponse.actions, true);
      this.activityFeed.record("automation", `ran ${scheduledTask.name}`, spokenText.slice(0, 200), false);
      this.desktopWindows.showNotification(scheduledTask.name, spokenText.slice(0, 200));

      if (this.configStore.getConfig().speakScheduledResults) {
        await this.speakResponse(interactionId, spokenText);
      } else {
        this.finishWithoutTranscript();
      }
    } catch (error) {
      if (!this.isAbortError(error)) {
        this.activityFeed.record(
          "automation",
          `could not run ${scheduledTask.name}`,
          this.describeError(error),
          false,
        );
        this.desktopWindows.showNotification("Ustaad", `Could not run ${scheduledTask.name}`);
      }
      this.finishWithoutTranscript();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Watchers                                                               */
  /* ---------------------------------------------------------------------- */

  private startClipboardWatcher(): void {
    if (this.clipboardPollTimer || !this.configStore.getConfig().clipboardHistoryEnabled) {
      return;
    }

    this.clipboardPollTimer = setInterval(() => {
      void this.recordClipboardChange();
    }, clipboardPollMilliseconds);
  }

  private stopClipboardWatcher(): void {
    if (this.clipboardPollTimer) {
      clearInterval(this.clipboardPollTimer);
      this.clipboardPollTimer = null;
    }
  }

  private async recordClipboardChange(): Promise<void> {
    try {
      const clipboardText = await clipboard.readText();
      if (!clipboardText || clipboardText === this.lastClipboardText) {
        return;
      }

      this.lastClipboardText = clipboardText;
      const storedClip = this.clipboardHistoryStore.pushText(clipboardText);
      if (storedClip) {
        this.publishIslandState();
      }
    } catch {
      // The clipboard can be locked briefly by another process; the next tick
      // picks the change up instead.
    }
  }

  private startNowPlayingWatcher(): void {
    if (this.nowPlayingTimer || !this.bridge.isSupported) {
      return;
    }

    this.nowPlayingTimer = setInterval(() => {
      void this.refreshNowPlaying();
    }, nowPlayingPollMilliseconds);
  }

  private async refreshNowPlaying(): Promise<void> {
    const config = this.configStore.getConfig();
    if (!config.islandShowNowPlaying || !config.abilities.island) {
      return;
    }

    try {
      const nowPlaying = await this.bridge.readNowPlaying();
      const hasChanged = JSON.stringify(nowPlaying) !== JSON.stringify(this.latestNowPlaying);
      this.latestNowPlaying = nowPlaying;
      if (hasChanged) {
        this.publishIslandState();
      }
    } catch {
      // Media info is a nicety: a closed media app simply reports nothing.
    }
  }

  private stopTimers(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    this.stopClipboardWatcher();
    if (this.nowPlayingTimer) {
      clearInterval(this.nowPlayingTimer);
      this.nowPlayingTimer = null;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* State publishing                                                       */
  /* ---------------------------------------------------------------------- */

  private publishState(): void {
    this.desktopWindows.publishState(this.getPublicState());
  }

  private publishIslandState(): void {
    this.islandState = this.buildIslandState();
    this.desktopWindows.publishIslandState(this.islandState);
  }

  private updateIslandVisibility(): void {
    const config = this.configStore.getConfig();
    this.desktopWindows.setIslandEnabled(config.islandEnabled && config.abilities.island);
    this.desktopWindows.setIslandSummonEnabled(config.islandSummonEnabled);
    this.desktopWindows.setIslandAlwaysVisible(config.islandAlwaysVisible);
  }

  private buildIslandState(): IslandState {
    const config = this.configStore.getConfig();
    const now = new Date();

    const expiredConfirmations = this.confirmationQueue.expireOlderThan(now, confirmationTimeoutMilliseconds);
    for (const expiredConfirmation of expiredConfirmations) {
      this.activityFeed.record(
        "confirmation",
        "that request timed out",
        describeActions(expiredConfirmation.actions),
        false,
      );
    }

    return {
      isExpanded: this.isIslandCurrentlyExpanded,
      isEnabled: config.islandEnabled && config.abilities.island,
      presentation: this.desktopWindows.getIslandPresentation(),
      activeTimers: this.activeTimers,
      snippets: this.snippetStore.list().slice(0, 20),
      wakeWordState: this.wakeWordState,
      wakeWordMuted: this.wakeWordMuted,
      wakeWordMessage: this.wakeWordMessage,
      skills: this.skillStore.list(),
      skillSuggestion: this.currentSkillSuggestion,
      skillRepair: this.currentSkillRepair,
      taskQueue: this.taskQueueStore.waiting(),
      drawnPicture: this.drawnPicture,
      cursorEnabled: config.cursorEnabled,
      automationPaused: config.automationPaused,
      status: {
        voiceState: this.publicState.voiceState,
        label: describeIslandStatus(
          this.publicState.voiceState,
          this.activeInteractionKind,
          this.activeDictationStage,
        ),
        detail: this.describeIslandDetail(config, now),
        interactionKind: this.activeInteractionKind,
        dictationStage: this.activeDictationStage,
        audioPowerLevel: this.publicState.audioPowerLevel,
      },
      nowPlaying: config.islandShowNowPlaying ? this.latestNowPlaying : null,
      showNowPlaying: config.islandShowNowPlaying,
      showClipboard: config.islandShowClipboard && config.clipboardHistoryEnabled,
      activityFeed: this.activityFeed.list(10),
      pendingConfirmations: this.confirmationQueue.list(),
      todos: config.abilities.toDoList ? this.todoStore.list().slice(0, 30) : [],
      scheduledTasks: config.abilities.scheduling ? this.scheduleStore.list().slice(0, 20) : [],
      memoryFacts: config.abilities.memory ? this.memoryStore.list().slice(0, 20) : [],
      presence: {
        nextCheckInLabel: config.abilities.presence ? describeNextPresenceCheckIn(config.presence, now) : null,
        lastCheckIn: this.presenceStore.lastCheckIn(),
      },
      clipboardClips: config.clipboardHistoryEnabled ? this.clipboardHistoryStore.list().slice(0, 20) : [],
      quickLaunchApps: config.abilities.automation ? this.appIndex.quickLaunchApps(8) : [],
      brainLabel: this.brainRouter.getBrainLabel(config),
      shortcuts: [
        { label: this.publicState.shortcutLabel, description: "hold to talk about your screen", hint: "hold" },
        { label: this.publicState.dictationShortcutLabel, description: "hold to dictate clean text anywhere", hint: "hold" },
        { label: this.publicState.circleShortcutLabel, description: "hold, circle anything, ask about it", hint: "hold" },
        { label: shortcutLabels.snip, description: "drag over any part of the screen to copy it", hint: "press" },
        { label: shortcutLabels.panic, description: "stop everything ustaad is doing, instantly", hint: "press" },
      ],
    };
  }

  private describeIslandDetail(config: UstaadUserConfig, now: Date): string {
    if (!this.publicState.configured) {
      return "add a brain in the panel to get started";
    }
    if (config.automationPaused) {
      return "actions are paused";
    }

    const nextScheduledTask = this.scheduleStore.list()
      .find((scheduledTask) => scheduledTask.isEnabled && scheduledTask.nextRunAtIso);
    if (nextScheduledTask?.nextRunAtIso) {
      const nextRunDescription = formatFriendlyDateTime(nextScheduledTask.nextRunAtIso, now);
      const scheduleSummary = describeScheduledTask(nextScheduledTask);
      return `next up: ${nextScheduledTask.name} ${nextRunDescription ? `at ${nextRunDescription}` : scheduleSummary}`;
    }

    const openTodoItemCount = this.todoStore.list().filter((todoItem) => !todoItem.isDone).length;
    if (openTodoItemCount) {
      return `${openTodoItemCount} ${openTodoItemCount === 1 ? "thing" : "things"} on your list`;
    }

    return `hold ${this.publicState.shortcutLabel} to talk`;
  }

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                */
  /* ---------------------------------------------------------------------- */

  private cancelActiveWork(): void {
    // Escape, a new request and quitting all have to stop a running task too.
    this.cancelAgentTask();
    this.interactionAbortController?.abort();
    this.interactionAbortController = null;
    this.responseAbortController?.abort();
    this.responseAbortController = null;
    this.activeTranscriptionSession?.cancel();
    this.activeTranscriptionSession = null;
    this.recordedAudioBuffer?.clear();
    this.recordedAudioBuffer = null;
    this.desktopWindows.endMicrophoneCapture(this.activeInteractionId);
    this.desktopWindows.stopAudioPlayback();
    this.desktopWindows.cancelPointingAnimation();
    this.desktopWindows.hideRegionSelector();
    this.heldShortcutIds.clear();
    this.audioPlaybackInteractionId = null;
    this.pointingInteractionId = null;
    this.activeInteractionKind = null;
  }

  private handleInteractionError(error: unknown): void {
    this.heldShortcutIds.clear();
    this.activeTranscriptionSession?.cancel();
    this.activeTranscriptionSession = null;
    this.recordedAudioBuffer?.clear();
    this.recordedAudioBuffer = null;
    this.desktopWindows.endMicrophoneCapture(this.activeInteractionId);
    this.desktopWindows.hideRegionSelector();
    this.activeInteractionKind = null;
    this.publicState.voiceState = "idle";
    this.publicState.interactionKind = null;
    this.publicState.audioPowerLevel = 0;
    this.publicState.errorMessage = this.describeError(error);
    this.publishState();
    this.publishIslandState();
    this.scheduleTransientOverlayHideIfPossible();
  }

  private applyLaunchAtLogin(launchAtLogin: boolean): void {
    // Register only the packaged executable. In development process.execPath is
    // electron.exe without this project's app path, which would create a broken
    // login item on the developer's machine.
    if (process.platform !== "win32" || !app.isPackaged) {
      return;
    }

    app.setLoginItemSettings({
      openAtLogin: launchAtLogin,
      path: process.execPath,
    });
  }

  private isInteractionInProgress(): boolean {
    return this.heldShortcutIds.size > 0
      || this.publicState.voiceState !== "idle"
      || this.audioPlaybackInteractionId !== null
      || this.pointingInteractionId !== null;
  }

  private scheduleTransientOverlayHideIfPossible(): void {
    if (this.publicState.cursorEnabled || this.isInteractionInProgress()) {
      return;
    }

    this.clearTransientOverlayHideTimer();
    this.transientOverlayHideTimer = setTimeout(() => {
      if (!this.publicState.cursorEnabled && !this.isInteractionInProgress()) {
        this.desktopWindows.setOverlayVisibility(false);
      }
    }, 1_000);
  }

  private clearTransientOverlayHideTimer(): void {
    if (this.transientOverlayHideTimer) {
      clearTimeout(this.transientOverlayHideTimer);
      this.transientOverlayHideTimer = null;
    }
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        return "That request timed out. Check your connection and try again.";
      }
      return error.message;
    }
    return String(error);
  }
}

function toBrainImage(capturedImage: {
  mediaType: string;
  imageBase64: string;
  label: string;
}): { mediaType: string; base64Data: string; label: string } {
  return {
    mediaType: capturedImage.mediaType,
    base64Data: capturedImage.imageBase64,
    label: capturedImage.label,
  };
}

function describeInteractionHint(interactionKind: InteractionKind, config: UstaadUserConfig): string {
  switch (interactionKind) {
    case "dictation":
      return "dictating — talk normally, release when you're done";
    case "circle":
      return "circle anything on screen while you talk, then let go";
    case "scheduled":
      return "running a scheduled task";
    case "talk":
    default:
      return config.abilities.screenVision ? "listening — I can see your screen" : "listening";
  }
}

/**
 * A small jpeg the island can show without reading the file back.
 *
 * The picture Google returns is around a megabyte; this keeps what the island
 * sends on every state update to a few tens of kilobytes, which matters on the
 * low-spec machines Ustaad is built for.
 */
function buildPicturePreviewDataUrl(base64Data: string): string {
  const drawnImage = nativeImage.createFromBuffer(Buffer.from(base64Data, "base64"));
  if (drawnImage.isEmpty()) {
    return "";
  }
  const previewImage = drawnImage.getSize().width > picturePreviewWidth
    ? drawnImage.resize({ width: picturePreviewWidth })
    : drawnImage;
  return `data:image/jpeg;base64,${previewImage.toJPEG(82).toString("base64")}`;
}

function describeIslandStatus(
  voiceState: UstaadPublicState["voiceState"],
  interactionKind: InteractionKind | null,
  dictationStage: UstaadPublicState["dictationStage"],
): string {
  if (interactionKind === "dictation") {
    switch (dictationStage) {
      case "recording":
        return "dictating";
      case "cleaning":
        return "polishing the words";
      case "typing":
        return "typing it in";
      case "idle":
      default:
        return "dictation";
    }
  }

  switch (voiceState) {
    case "listening":
      return interactionKind === "circle" ? "circle and ask" : "listening";
    case "processing":
      return "thinking";
    case "responding":
      return "answering";
    case "idle":
    default:
      return "ready";
  }
}
