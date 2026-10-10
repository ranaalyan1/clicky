import { app } from "electron";
import {
  ClickyPublicState,
  ClickyUserConfig,
  SupportedClaudeModel,
  WorkerConnectionTestResult,
} from "../shared/contracts";
import { ClaudeClient, ConversationExchange } from "./claude-client";
import { ClickyConfigStore } from "./config-store";
import { ClickyDesktopWindows } from "./desktop-windows";
import {
  mapImageCoordinateToWindowsDesktop,
  parsePointingTag,
  selectPointingDisplay,
} from "./pointing";
import { captureAllWindowsDisplays } from "./screen-capture";
import { AssemblyAITranscriptionSession } from "./transcription-session";

export class ClickyController {
  private readonly claudeClient = new ClaudeClient();
  private readonly conversationHistory: ConversationExchange[] = [];
  private publicState: ClickyPublicState;
  private shortcutIsPressed = false;
  private pushToTalkSource: "globalShortcut" | "panelButton" = "globalShortcut";
  private activeInteractionId = 0;
  private activeTranscriptionSession: AssemblyAITranscriptionSession | null = null;
  private transcriptionOpenAbortController: AbortController | null = null;
  private responseAbortController: AbortController | null = null;
  private audioPlaybackInteractionId: number | null = null;
  private pointingInteractionId: number | null = null;
  private transientOverlayHideTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly configStore: ClickyConfigStore,
    private readonly desktopWindows: ClickyDesktopWindows,
  ) {
    const config = configStore.getConfig();
    this.publicState = {
      voiceState: "idle",
      configured: Boolean(config.workerBaseUrl),
      cursorEnabled: config.cursorEnabled,
      selectedModel: config.selectedModel,
      launchAtLogin: config.launchAtLogin,
      workerBaseUrl: config.workerBaseUrl,
      shortcutAvailable: true,
      shortcutLabel: "Ctrl + Alt",
      lastTranscript: "",
      partialTranscript: "",
      responseText: "",
      audioPowerLevel: 0,
      errorMessage: null,
    };
  }

  start(shortcutAvailable: boolean): void {
    this.publicState.shortcutAvailable = shortcutAvailable;
    if (!shortcutAvailable) {
      this.publicState.errorMessage = "The global Ctrl + Alt shortcut could not start. Restart Clicky, or use the hold-to-talk button.";
    }
    this.desktopWindows.setOverlayVisibility(this.publicState.cursorEnabled);
    this.applyLaunchAtLogin(this.publicState.launchAtLogin);
    this.publishState();
  }

  stop(): void {
    this.shortcutIsPressed = false;
    this.cancelActiveWork();
    this.clearTransientOverlayHideTimer();
  }

  getPublicState(): ClickyPublicState {
    return { ...this.publicState };
  }

  handlePushToTalkPressed(
    pushToTalkSource: "globalShortcut" | "panelButton" = "globalShortcut",
  ): void {
    if (this.shortcutIsPressed) {
      return;
    }

    if (!this.publicState.configured) {
      this.publicState.errorMessage = "Add your Cloudflare Worker URL before using push-to-talk.";
      this.publishState();
      this.desktopWindows.showPanel();
      return;
    }

    this.shortcutIsPressed = true;
    this.pushToTalkSource = pushToTalkSource;
    void this.beginPushToTalkInteraction();
  }

  handlePushToTalkReleased(): void {
    if (!this.shortcutIsPressed) {
      return;
    }

    this.shortcutIsPressed = false;
    const interactionId = this.activeInteractionId;
    this.desktopWindows.endMicrophoneCapture(interactionId);
    this.publicState.audioPowerLevel = 0;

    if (!this.activeTranscriptionSession?.ready) {
      this.transcriptionOpenAbortController?.abort();
      this.activeTranscriptionSession?.cancel();
      this.activeTranscriptionSession = null;
      this.publicState.voiceState = "idle";
      this.publishState();
      this.scheduleTransientOverlayHideIfPossible();
      return;
    }

    this.publicState.voiceState = "processing";
    this.publishState();
    this.activeTranscriptionSession.requestFinalTranscript();
  }

  appendMicrophoneAudio(interactionId: number, audioBytes: Uint8Array): void {
    if (interactionId !== this.activeInteractionId || !this.shortcutIsPressed) {
      return;
    }
    this.activeTranscriptionSession?.appendAudio(Buffer.from(audioBytes));
  }

  handleMicrophoneCaptureStarted(interactionId: number): void {
    if (interactionId !== this.activeInteractionId || !this.shortcutIsPressed) {
      this.desktopWindows.endMicrophoneCapture(interactionId);
      return;
    }
    this.publicState.voiceState = "listening";
    this.publicState.errorMessage = null;
    this.publishState();
  }

  handleMicrophoneCaptureError(interactionId: number, errorMessage: string): void {
    if (interactionId !== this.activeInteractionId) {
      return;
    }

    this.shortcutIsPressed = false;
    this.activeTranscriptionSession?.cancel();
    this.activeTranscriptionSession = null;
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
    this.publishState();
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
    this.publicState.voiceState = "idle";
    this.publishState();
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

  updateWorkerBaseUrl(workerBaseUrl: string): ClickyPublicState {
    const updatedConfig = this.configStore.updateConfig({ workerBaseUrl });
    this.applyConfigToPublicState(updatedConfig);
    this.publicState.errorMessage = null;
    this.publishState();
    return this.getPublicState();
  }

  updateSelectedModel(selectedModel: SupportedClaudeModel): ClickyPublicState {
    const updatedConfig = this.configStore.updateConfig({ selectedModel });
    this.applyConfigToPublicState(updatedConfig);
    this.publishState();
    return this.getPublicState();
  }

  updateCursorEnabled(cursorEnabled: boolean): ClickyPublicState {
    const updatedConfig = this.configStore.updateConfig({ cursorEnabled });
    this.applyConfigToPublicState(updatedConfig);
    this.clearTransientOverlayHideTimer();
    this.desktopWindows.setOverlayVisibility(cursorEnabled || this.isInteractionInProgress());
    this.publishState();
    return this.getPublicState();
  }

  toggleCursorEnabled(): void {
    this.updateCursorEnabled(!this.publicState.cursorEnabled);
  }

  updateLaunchAtLogin(launchAtLogin: boolean): ClickyPublicState {
    const updatedConfig = this.configStore.updateConfig({ launchAtLogin });
    this.applyConfigToPublicState(updatedConfig);
    this.applyLaunchAtLogin(launchAtLogin);
    this.publishState();
    return this.getPublicState();
  }

  async testWorkerConnection(workerBaseUrl: string): Promise<WorkerConnectionTestResult> {
    let normalizedWorkerBaseUrl: string;
    try {
      normalizedWorkerBaseUrl = this.configStore.updateConfig({ workerBaseUrl }).workerBaseUrl;
      this.applyConfigToPublicState(this.configStore.getConfig());
      this.publishState();
    } catch (error) {
      return { ok: false, message: this.describeError(error) };
    }

    if (!normalizedWorkerBaseUrl) {
      return { ok: false, message: "Enter your deployed Worker URL first." };
    }

    const timeoutAbortController = new AbortController();
    const timeout = setTimeout(() => timeoutAbortController.abort(), 10_000);
    try {
      const response = await fetch(`${normalizedWorkerBaseUrl}/transcribe-token`, {
        method: "POST",
        signal: timeoutAbortController.signal,
      });
      if (!response.ok) {
        const responseBody = await response.text();
        return {
          ok: false,
          message: `Worker returned ${response.status}: ${responseBody.slice(0, 180)}`,
        };
      }
      const responsePayload = await response.json() as { token?: unknown };
      if (typeof responsePayload.token !== "string") {
        return { ok: false, message: "Worker connected, but its transcription route returned invalid data." };
      }
      return { ok: true, message: "Connected. The Worker's transcription route is ready." };
    } catch (error) {
      return { ok: false, message: this.describeError(error) };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async beginPushToTalkInteraction(): Promise<void> {
    this.cancelActiveWork();
    this.clearTransientOverlayHideTimer();
    this.activeInteractionId += 1;
    const interactionId = this.activeInteractionId;
    const config = this.configStore.getConfig();

    // A global shortcut should dismiss the tray panel before screen capture.
    // The hold-to-talk button must keep its window visible so it can receive
    // pointer-up and reliably end the recording.
    if (this.pushToTalkSource === "globalShortcut") {
      this.desktopWindows.hidePanel();
    }
    this.desktopWindows.setOverlayVisibility(true);
    this.desktopWindows.updateOverlayResponse("");
    this.publicState.voiceState = "processing";
    this.publicState.partialTranscript = "";
    this.publicState.responseText = "";
    this.publicState.audioPowerLevel = 0;
    this.publicState.errorMessage = null;
    this.publishState();

    const transcriptionOpenAbortController = new AbortController();
    this.transcriptionOpenAbortController = transcriptionOpenAbortController;
    const transcriptionSession = new AssemblyAITranscriptionSession({
      workerBaseUrl: config.workerBaseUrl,
      keyterms: ["Clicky", "Claude", "Windows"],
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
        void this.processFinalTranscript(interactionId, transcriptText);
      },
      onError: (error) => {
        if (interactionId !== this.activeInteractionId) {
          return;
        }
        this.handleInteractionError(error);
      },
    });
    this.activeTranscriptionSession = transcriptionSession;

    try {
      await transcriptionSession.open(transcriptionOpenAbortController.signal);
      if (interactionId !== this.activeInteractionId || !this.shortcutIsPressed) {
        transcriptionSession.cancel();
        return;
      }
      this.desktopWindows.beginMicrophoneCapture(interactionId);
    } catch (error) {
      if (interactionId !== this.activeInteractionId || this.isAbortError(error)) {
        return;
      }
      this.handleInteractionError(error);
    }
  }

  private async processFinalTranscript(interactionId: number, rawTranscriptText: string): Promise<void> {
    const transcriptText = rawTranscriptText.trim();
    this.publicState.partialTranscript = "";
    this.publicState.audioPowerLevel = 0;

    if (!transcriptText) {
      this.publicState.voiceState = "idle";
      this.publishState();
      this.scheduleTransientOverlayHideIfPossible();
      return;
    }

    this.publicState.lastTranscript = transcriptText;
    this.publicState.voiceState = "processing";
    this.publishState();

    const config = this.configStore.getConfig();
    const responseAbortController = new AbortController();
    this.responseAbortController = responseAbortController;

    try {
      const capturedDisplays = await captureAllWindowsDisplays();
      if (interactionId !== this.activeInteractionId) {
        return;
      }

      const fullResponseText = await this.claudeClient.streamVisionResponse({
        workerBaseUrl: config.workerBaseUrl,
        model: config.selectedModel,
        capturedDisplays,
        conversationHistory: [...this.conversationHistory],
        userPrompt: transcriptText,
        signal: responseAbortController.signal,
      });
      if (interactionId !== this.activeInteractionId) {
        return;
      }

      const pointingResult = parsePointingTag(fullResponseText);
      const spokenText = pointingResult.spokenText.trim();
      this.publicState.responseText = spokenText;
      this.desktopWindows.updateOverlayResponse(spokenText);

      if (pointingResult.coordinate) {
        const pointingDisplay = selectPointingDisplay(
          capturedDisplays,
          pointingResult.screenNumber,
        );
        if (pointingDisplay) {
          const globalPoint = mapImageCoordinateToWindowsDesktop(
            pointingResult.coordinate,
            pointingDisplay,
          );
          const animationStarted = this.desktopWindows.pointOverlayAt(
            interactionId,
            pointingDisplay.displayId,
            globalPoint,
            pointingResult.elementLabel || "element",
            spokenText,
          );
          if (animationStarted) {
            this.pointingInteractionId = interactionId;
          }
        }
      }

      this.conversationHistory.push({
        userTranscript: transcriptText,
        assistantResponse: spokenText,
      });
      if (this.conversationHistory.length > 10) {
        this.conversationHistory.splice(0, this.conversationHistory.length - 10);
      }
      this.publishState();

      if (!spokenText) {
        this.publicState.voiceState = "idle";
        this.publishState();
        this.scheduleTransientOverlayHideIfPossible();
        return;
      }

      try {
        const speechResult = await this.claudeClient.synthesizeSpeech(
          config.workerBaseUrl,
          spokenText,
          responseAbortController.signal,
        );
        if (interactionId !== this.activeInteractionId) {
          return;
        }
        this.audioPlaybackInteractionId = interactionId;
        this.desktopWindows.playAudio({
          interactionId,
          audioBase64: speechResult.audioData.toString("base64"),
          contentType: speechResult.contentType,
        });
      } catch (speechError) {
        if (this.isAbortError(speechError) || interactionId !== this.activeInteractionId) {
          return;
        }
        // Chromium's speechSynthesis uses the installed Windows voices and gives
        // Clicky a functional offline fallback if ElevenLabs is unavailable.
        this.publicState.errorMessage = `ElevenLabs unavailable; using a Windows voice. ${this.describeError(speechError)}`;
        this.audioPlaybackInteractionId = interactionId;
        this.desktopWindows.speakWithWindowsVoice({ interactionId, text: spokenText });
        this.publishState();
      }
    } catch (error) {
      if (this.isAbortError(error) || interactionId !== this.activeInteractionId) {
        return;
      }
      this.handleInteractionError(error);
    }
  }

  private cancelActiveWork(): void {
    this.transcriptionOpenAbortController?.abort();
    this.transcriptionOpenAbortController = null;
    this.responseAbortController?.abort();
    this.responseAbortController = null;
    this.activeTranscriptionSession?.cancel();
    this.activeTranscriptionSession = null;
    this.desktopWindows.endMicrophoneCapture(this.activeInteractionId);
    this.desktopWindows.stopAudioPlayback();
    this.desktopWindows.cancelPointingAnimation();
    this.audioPlaybackInteractionId = null;
    this.pointingInteractionId = null;
  }

  private handleInteractionError(error: unknown): void {
    this.shortcutIsPressed = false;
    this.activeTranscriptionSession?.cancel();
    this.activeTranscriptionSession = null;
    this.desktopWindows.endMicrophoneCapture(this.activeInteractionId);
    this.publicState.voiceState = "idle";
    this.publicState.audioPowerLevel = 0;
    this.publicState.errorMessage = this.describeError(error);
    this.publishState();
    this.scheduleTransientOverlayHideIfPossible();
  }

  private applyConfigToPublicState(config: ClickyUserConfig): void {
    this.publicState.workerBaseUrl = config.workerBaseUrl;
    this.publicState.configured = Boolean(config.workerBaseUrl);
    this.publicState.selectedModel = config.selectedModel;
    this.publicState.cursorEnabled = config.cursorEnabled;
    this.publicState.launchAtLogin = config.launchAtLogin;
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
    return this.shortcutIsPressed
      || this.publicState.voiceState !== "idle"
      || this.audioPlaybackInteractionId !== null
      || this.pointingInteractionId !== null;
  }

  private scheduleTransientOverlayHideIfPossible(): void {
    if (
      this.publicState.cursorEnabled
      || this.shortcutIsPressed
      || this.publicState.voiceState !== "idle"
      || this.audioPlaybackInteractionId !== null
      || this.pointingInteractionId !== null
    ) {
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

  private publishState(): void {
    this.desktopWindows.publishState(this.getPublicState());
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        return "The request timed out. Check your Worker URL and internet connection.";
      }
      return error.message;
    }
    return String(error);
  }
}
