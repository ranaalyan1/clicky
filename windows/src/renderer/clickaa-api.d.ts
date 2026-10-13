import type {
  AudioPlaybackPayload,
  BrainConnectionTestResult,
  ClickaaPublicState,
  ClickaaUserConfig,
  FallbackSpeechPayload,
  IslandState,
  IslandToggleKey,
  OverlayCursorPayload,
  OverlayModePayload,
  OverlayPointPayload,
  SelectionBoundsPayload,
} from "../shared/contracts";

declare global {
  interface Window {
    clickaa: {
      /* Panel */
      getState(): Promise<ClickaaPublicState>;
      updateSettings(settingsUpdates: Partial<ClickaaUserConfig>): Promise<ClickaaPublicState>;
      testBrain(settingsUpdates: Partial<ClickaaUserConfig>): Promise<BrainConnectionTestResult>;
      refreshAppIndex(): Promise<number>;
      hidePanel(): void;
      openSetupVideo(): void;
      onState(listener: (state: ClickaaPublicState) => void): () => void;
      onOpenPanelPage(listener: (page: string) => void): () => void;

      pushToTalkPressed(): void;
      pushToTalkReleased(): void;
      sendAudioCaptureStarted(interactionId: number): void;
      sendAudioChunk(interactionId: number, audioBytes: Uint8Array): void;
      sendAudioPowerLevel(interactionId: number, audioPowerLevel: number): void;
      sendAudioCaptureError(interactionId: number, errorMessage: string): void;
      sendAudioPlaybackStarted(interactionId: number): void;
      sendAudioPlaybackEnded(interactionId: number): void;
      sendAudioPlaybackError(interactionId: number, errorMessage: string): void;
      onAudioCaptureStart(listener: (payload: { interactionId: number }) => void): () => void;
      onAudioCaptureStop(listener: (payload: { interactionId: number }) => void): () => void;
      onAudioPlayback(listener: (payload: AudioPlaybackPayload) => void): () => void;
      onFallbackSpeech(listener: (payload: FallbackSpeechPayload) => void): () => void;
      onStopAudioPlayback(listener: () => void): () => void;

      addTodo(todoText: string): void;
      addMemory(factText: string): void;
      clearMemory(): void;

      /* Cursor overlay */
      sendPointingAnimationCompleted(interactionId: number): void;
      onOverlayState(
        listener: (payload: Pick<ClickaaPublicState, "voiceState" | "audioPowerLevel">) => void,
      ): () => void;
      onOverlayCursor(listener: (payload: OverlayCursorPayload) => void): () => void;
      onOverlayResponse(listener: (responseText: string) => void): () => void;
      onOverlayMode(listener: (payload: OverlayModePayload) => void): () => void;
      onOverlayCancelPointing(listener: () => void): () => void;
      onOverlayPoint(listener: (payload: OverlayPointPayload) => void): () => void;

      /* Island */
      getIslandState(): Promise<IslandState>;
      onIslandState(listener: (state: IslandState) => void): () => void;
      onIslandExpanded(listener: (payload: { isExpanded: boolean }) => void): () => void;
      setIslandPointerOver(isPointerOverIsland: boolean): void;
      setIslandExpanded(isExpanded: boolean): void;
      resolveConfirmation(confirmationId: string, decision: "approve" | "reject"): Promise<string>;
      undoActivity(activityEntryId: string): Promise<boolean>;
      launchApp(appName: string): Promise<void>;
      mediaControl(operation: "play_pause" | "next" | "previous"): Promise<void>;
      copyClip(clipId: string): Promise<boolean>;
      clearClips(): void;
      toggleTodo(todoId: string, isDone: boolean): void;
      removeTodo(todoId: string): void;
      toggleSchedule(scheduleId: string, isEnabled: boolean): void;
      removeSchedule(scheduleId: string): void;
      removeMemory(memoryFactId: string): void;
      setIslandToggle(toggleKey: IslandToggleKey, isEnabled: boolean): void;
      setWallpaperSolidColor(wallpaperColor: string): Promise<void>;
      openPanel(page: string): void;
      showPanel(page: string): void;

      /* Region selector */
      sendSelectionCompleted(selectionBounds: SelectionBoundsPayload): void;
      sendSelectionCancelled(): void;
    };
  }
}

export {};
