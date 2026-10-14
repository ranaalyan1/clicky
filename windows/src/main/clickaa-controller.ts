import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, clipboard, ClipboardItem } from "electron";
import {
  ActiveTimer,
  BrainConnectionTestResult,
  CapturedDisplayImage,
  ClickaaAction,
  ClickaaPublicState,
  ClickaaUserConfig,
  InteractionKind,
  IslandState,
  ClipboardTransformOperation,
  IslandToggleKey,
  NowPlayingInfo,
  RegionSelectorSelection,
  WakeWordSurfaceState,
} from "../shared/contracts";
import {
  actionNeedsConfirmation,
  describeActions,
  filterActionsByAbilities,
  parseModelResponse,
} from "./action-protocol";
import { ActivityFeed, MemoryStore } from "./memory-store";
import { AudioRecordingBuffer } from "./audio-recording-buffer";
import { BrainRouter } from "./brain-router";
import {
  ActionExecutionOutcome,
  completedActionOutcome,
  ClickaaActionExecutor,
  failedActionOutcome,
} from "./system-actions";
import { ClipboardHistoryStore } from "./clipboard-history-store";
import { ConfirmationQueue, interpretConfirmationAnswer } from "./confirmation-queue";
import { ClickaaConfigStore } from "./config-store";
import { ClickaaDesktopWindows } from "./desktop-windows";
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
  ClickaaAgentLoop,
  defaultAgentLoopBudget,
  parseAgentLookResponse,
} from "./agent-loop";
import { ShortcutId } from "./shortcut-registry";
import { mapImageCoordinateToWindowsDesktop, parsePointingTag, selectPointingDisplay } from "./pointing";
import { ScheduleStore } from "./schedule-store";
import { SnippetStore } from "./snippet-store";
import { captureAllWindowsDisplays, captureWindowsDesktopRegion } from "./screen-capture";
import { describeScheduledTask } from "./schedule-time";
import { dictationShortcutLabels, shortcutLabels } from "./shortcut-registry";
import { StartMenuAppIndex } from "./start-menu-app-index";
import { buildSystemPrompt } from "./system-prompt";
import { TodoStore } from "./todo-store";
import { AssemblyAITranscriptionSession } from "./transcription-session";
import { ClickaaWindowsBridge } from "./windows-bridge";

const conversationHistoryLimit = 10;
const schedulerTickMilliseconds = 20_000;
const clipboardPollMilliseconds = 900;
const nowPlayingPollMilliseconds = 3_000;
const confirmationTimeoutMilliseconds = 45_000;

/**
 * How long the listening window after the wake word stays open. The first
 * number is generous enough for "Clickaa ..." pauses, and the last two stop
 * Clickaa from holding the microphone open when the name was a false start.
 */
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
 * Clickaa's orchestrator: it owns every interaction the user can have with
 * Clickaa (talking, dictating, circling, and scheduled tasks) and every piece
 * of state the panel and the island render.
 */
export class ClickaaController {
  private readonly brainRouter = new BrainRouter();
  private readonly bridge: ClickaaWindowsBridge;
  private readonly appIndex: StartMenuAppIndex;
  private readonly todoStore: TodoStore;
  private readonly memoryStore: MemoryStore;
  private readonly scheduleStore: ScheduleStore;
  private readonly snippetStore: SnippetStore;
  private readonly clipboardHistoryStore: ClipboardHistoryStore;
  private readonly activityFeed = new ActivityFeed();
  private readonly confirmationQueue = new ConfirmationQueue();
  private readonly actionExecutor: ClickaaActionExecutor;
  private readonly undoableActions = new Map<string, UndoableAction>();
  private readonly conversationHistory: Array<{ userTranscript: string; assistantResponse: string }> = [];

  private publicState: ClickaaPublicState;
  private islandState: IslandState | null = null;
  private isIslandCurrentlyExpanded = false;

  private activeInteractionId = 0;
  private activeInteractionKind: InteractionKind | null = null;
  private readonly heldShortcutIds = new Set<"talk" | "dictation" | "circle">();
  private activeTranscriptionSession: AssemblyAITranscriptionSession | null = null;
  private interactionAbortController: AbortController | null = null;
  private responseAbortController: AbortController | null = null;
  private recordedAudioBuffer: AudioRecordingBuffer | null = null;
  private activeDictationStage: ClickaaPublicState["dictationStage"] = "idle";
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
  private readonly wakeWordListener: WakeWordListener;
  private wakeWordState: WakeWordSurfaceState = "off";
  private wakeWordMessage = "";
  /** Runtime mute: the tray switch that silences the microphone without losing the setting. */
  private wakeWordMuted = false;
  private wakeFollowUpTimer: NodeJS.Timeout | null = null;
  private wakeFollowUpStartedAtMs = 0;
  private wakeFollowUpHeardSpeechAtMs = 0;
  private readonly agentLoop: ClickaaAgentLoop;
  /** Task goals waiting on the user's yes, keyed by confirmation id. */
  private readonly pendingTaskGoals = new Map<string, string>();
  private isAgentTaskRunning = false;
  private agentTaskCancelled = true;
  private timerTickTimer: NodeJS.Timeout | null = null;
  private latestNowPlaying: NowPlayingInfo | null = null;
  private readonly runningScheduledTaskIds = new Set<string>();

  constructor(
    private readonly configStore: ClickaaConfigStore,
    private readonly desktopWindows: ClickaaDesktopWindows,
    userDataDirectory: string,
  ) {
    this.bridge = new ClickaaWindowsBridge(userDataDirectory);
    this.appIndex = new StartMenuAppIndex(this.bridge);
    this.todoStore = new TodoStore(`${userDataDirectory}/todos.json`);
    this.memoryStore = new MemoryStore(`${userDataDirectory}/memory.json`);
    this.scheduleStore = new ScheduleStore(`${userDataDirectory}/schedules.json`);
    this.snippetStore = new SnippetStore(`${userDataDirectory}/snippets.json`);
    this.clipboardHistoryStore = new ClipboardHistoryStore(
      `${userDataDirectory}/clipboard-history.json`,
    );
    this.actionExecutor = new ClickaaActionExecutor({
      bridge: this.bridge,
      appIndex: this.appIndex,
      todoStore: this.todoStore,
      memoryStore: this.memoryStore,
      scheduleStore: this.scheduleStore,
      snippetStore: this.snippetStore,
      openExternalUrl: async (url) => {
        const { shell } = await import("electron");
        await shell.openExternal(url);
      },
      showNotification: (title, body) => this.desktopWindows.showNotification(title, body),
      showPanel: (page) => this.desktopWindows.showPanel(page),
      now: () => new Date(),
    });

    this.agentLoop = new ClickaaAgentLoop({
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
      config,
    };
  }

  async start(shortcutAvailable: boolean): Promise<void> {
    this.publicState.shortcutAvailable = shortcutAvailable;
    if (!shortcutAvailable) {
      this.publicState.errorMessage =
        "The global shortcuts could not start. Restart Clickaa, or use the hold-to-talk button.";
    }

    this.desktopWindows.setOverlayVisibility(this.publicState.config.cursorEnabled);
    this.applyLaunchAtLogin(this.publicState.config.launchAtLogin);
    this.updateIslandVisibility();
    this.publishState();

    // Startup catch-up: roll tasks missed while Clickaa was closed forward, then
    // warm the Windows helper and the app index in the background.
    const now = new Date();
    this.scheduleStore.refreshNextRuns(now);
    this.scheduleStore.rollForwardOverdueTasks(now);
    this.startScheduler();
    this.startClipboardWatcher();
    this.startNowPlayingWatcher();
    this.publishIslandState();

    void this.bridge.start().catch((error: unknown) => {
      console.warn("Clickaa could not start its Windows helper:", error);
    });
    void this.refreshAppIndex();
    this.synchronizeWakeWordListener();
  }

  stop(): void {
    this.endWakeFollowUp();
    this.wakeWordListener.stop();
    this.cancelActiveWork();
    this.clearTransientOverlayHideTimer();
    this.stopTimers();
    this.bridge.stop();
  }

  getPublicState(): ClickaaPublicState {
    return { ...this.publicState, config: this.configStore.getConfig() };
  }

  getIslandState(): IslandState {
    return this.islandState ?? this.buildIslandState();
  }

  /* ---------------------------------------------------------------------- */
  /* Interaction lifecycle                                                  */
  /* ---------------------------------------------------------------------- */

  handleShortcutPressed(shortcutId: ShortcutId): void {
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

    // The tray panel must never hold focus while Clickaa types into another app.
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
      keyterms: ["Clickaa", "Claude", "Gemini", "Windows", "dictation", "routine"],
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
      // Hide the lasso before capturing, or Clickaa would photograph its own
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

      this.pointAtElement(interactionId, pointingResult, spokenText);
      this.rememberExchange(userPrompt, spokenText);

      if (parsedResponse.problems.length) {
        console.warn("Clickaa skipped some requested actions:", parsedResponse.problems.join("; "));
      }

      if (parsedResponse.taskGoal && interactionKind !== "scheduled") {
        // The model asked Clickaa to keep working until the goal is met, so the
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
    config: ClickaaUserConfig,
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
      hasScreenshots,
      isCircledRegion: interactionKind === "circle",
      isScheduledTask: interactionKind === "scheduled",
    });
  }

  private buildClipboardPreview(config: ClickaaUserConfig): string {
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
        console.warn("Clickaa pasted the raw transcript:", error);
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
    requestedActions: ClickaaAction[],
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
        `Clickaa would have: ${describeActions(allowedActions)}`,
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
          "Clickaa needs a yes",
          `A scheduled task wants to ${describeActions(actionsToConfirm)}`,
        );
      }
      this.publishIslandState();
    }

    return completedMessages.join("; ");
  }

  /** Executes one action and records it in the island's activity feed. */
  private async executeAndRecordAction(action: ClickaaAction): Promise<string> {
    let outcome;
    try {
      // Timers and clipboard rewrites need controller state (the clock and the
      // user's brain), so they are answered here rather than in the executor.
      if (action.type === "timer_start" || action.type === "timer_cancel") {
        outcome = await this.runTimerAction(action);
      } else if (action.type === "clipboard_transform") {
        outcome = await this.runClipboardTransform(action.operation, action.targetLanguage);
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
    action: Extract<ClickaaAction, { type: "timer_start" | "timer_cancel" }>,
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
    this.desktopWindows.showNotification("Clickaa timer", announcement);
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
      console.warn("Clickaa could not undo that action:", error);
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
      // Chromium's speechSynthesis uses the installed Windows voices, so Clickaa
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
  /* Settings                                                               */
  /* ---------------------------------------------------------------------- */

  updateSettings(settingsUpdates: Partial<ClickaaUserConfig>): ClickaaPublicState {
    const previousConfig = this.configStore.getConfig();
    const updatedConfig = this.configStore.updateConfig(settingsUpdates);

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

  async testBrainConnection(settingsUpdates: Partial<ClickaaUserConfig>): Promise<BrainConnectionTestResult> {
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
        ? "Clickaa will describe what it would do instead of doing it"
        : "Clickaa can act on this pc again",
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
      console.warn("Clickaa could not index your apps:", error);
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
    initialActions: ClickaaAction[],
    config: ClickaaUserConfig,
  ): Promise<string> {
    if (config.automationPaused) {
      this.activityFeed.record(
        "system",
        "actions are paused",
        `Clickaa would have worked on: ${goal}`,
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
        `${goal} — Clickaa will click and type on this pc until that is done, or press Esc to stop`,
        false,
      );
      this.desktopWindows.openIsland();
      this.publishIslandState();
      return `waiting for your yes to work on: ${goal}`;
    }

    void this.runAgentTask(goal, allowedActions);
    return `working on: ${goal}`;
  }

  /** Runs the loop and reports where it ended up. */
  private async runAgentTask(goal: string, initialActions: ClickaaAction[]): Promise<void> {
    if (this.isAgentTaskRunning) {
      return;
    }

    this.isAgentTaskRunning = true;
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
      if (taskResult.outcome !== "completed") {
        this.desktopWindows.showNotification("Clickaa", `${goal}: ${taskResult.note}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.activityFeed.record("system", "that task did not finish", errorMessage, false);
    } finally {
      this.isAgentTaskRunning = false;
      this.agentTaskCancelled = true;
      this.publishState();
      this.publishIslandState();
    }
  }

  /** One step of a task: the ordinary action path, minus the per-step prompts. */
  private async runAgentStepActions(actions: ClickaaAction[]): Promise<string> {
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
   * Looks at the screen and asks the model whether the goal is met. Clickaa
   * sends the same multi-monitor screenshots it uses for answering, so clicks
   * the model proposes are expressed in a space Clickaa can map back.
   */
  private async lookAtScreenForTask(lookRequest: {
    goal: string;
    stepNumber: number;
    previousSummary: string;
    previousActions: ClickaaAction[];
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
        ? "Clickaa is not listening for its name until you unmute it"
        : "say \"clickaa\" to summon the island",
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
   * "Clickaa" on its own summons the island and opens the microphone for one
   * follow-up: the user can keep talking, and Clickaa submits by itself once
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

    // The user called Clickaa's name and stopped there. Close the microphone
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
      this.publicState.errorMessage = "screen vision is switched off, so Clickaa cannot take a snip. turn it back on in the soul tab.";
      this.desktopWindows.showPanel("soul");
      this.publishState();
      return;
    }
    if (config.automationPaused) {
      this.publicState.errorMessage = "actions are paused, so Clickaa did not start a snip.";
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
      this.desktopWindows.showNotification("Clickaa snip", "I could not capture that region.");
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
    this.desktopWindows.showNotification("Clickaa snip", copiedToClipboard
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
      const snipDirectory = join(app.getPath("pictures"), "Clickaa Snips");
      await mkdir(snipDirectory, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);
      const snipFilePath = join(snipDirectory, `Clickaa snip ${timestamp}.png`);
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

  private startScheduler(): void {
    if (this.schedulerTimer) {
      return;
    }

    this.schedulerTimer = setInterval(() => {
      void this.runDueScheduledTasks();
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
    // the request needs and Clickaa executes it with the usual safety rules.
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
        this.desktopWindows.showNotification("Clickaa", `Could not run ${scheduledTask.name}`);
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
      clipboardClips: config.clipboardHistoryEnabled ? this.clipboardHistoryStore.list().slice(0, 20) : [],
      quickLaunchApps: config.abilities.automation ? this.appIndex.quickLaunchApps(8) : [],
      brainLabel: this.brainRouter.getBrainLabel(config),
      shortcuts: [
        { label: this.publicState.shortcutLabel, description: "hold to talk about your screen", hint: "hold" },
        { label: this.publicState.dictationShortcutLabel, description: "hold to dictate clean text anywhere", hint: "hold" },
        { label: this.publicState.circleShortcutLabel, description: "hold, circle anything, ask about it", hint: "hold" },
        { label: shortcutLabels.snip, description: "drag over any part of the screen to copy it", hint: "press" },
      ],
    };
  }

  private describeIslandDetail(config: ClickaaUserConfig, now: Date): string {
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

function describeInteractionHint(interactionKind: InteractionKind, config: ClickaaUserConfig): string {
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

function describeIslandStatus(
  voiceState: ClickaaPublicState["voiceState"],
  interactionKind: InteractionKind | null,
  dictationStage: ClickaaPublicState["dictationStage"],
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
