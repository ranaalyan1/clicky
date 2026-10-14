import { contextBridge, ipcRenderer } from "electron";
import {
  AudioPlaybackPayload,
  BrainConnectionTestResult,
  FallbackSpeechPayload,
  IslandPresentation,
  IslandState,
  IslandToggleKey,
  OverlayCursorPayload,
  OverlayModePayload,
  OverlayPointPayload,
  RunHistorySearchResult,
  SelectionBoundsPayload,
  UstaadPublicState,
  UstaadUserConfig,
} from "../shared/contracts";

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrappedListener = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrappedListener);
  return () => ipcRenderer.removeListener(channel, wrappedListener);
}

function subscribeToSignal(channel: string, listener: () => void): () => void {
  const wrappedListener = (): void => listener();
  ipcRenderer.on(channel, wrappedListener);
  return () => ipcRenderer.removeListener(channel, wrappedListener);
}

/**
 * One narrow, context-isolated bridge shared by the panel, the island, the
 * cursor overlay, and the region selector. Each renderer only gets a view it
 * needs, and the main process re-checks the sender of every message.
 */
contextBridge.exposeInMainWorld("ustaad", {
  /* Panel: state and settings -------------------------------------------- */
  getState: (): Promise<UstaadPublicState> => ipcRenderer.invoke("ustaad:get-state"),
  updateSettings: (settingsUpdates: Partial<UstaadUserConfig>): Promise<UstaadPublicState> => {
    return ipcRenderer.invoke("ustaad:update-settings", settingsUpdates);
  },
  testBrain: (settingsUpdates: Partial<UstaadUserConfig>): Promise<BrainConnectionTestResult> => {
    return ipcRenderer.invoke("ustaad:test-brain", settingsUpdates);
  },
  refreshAppIndex: (): Promise<number> => ipcRenderer.invoke("ustaad:refresh-app-index"),
  hidePanel: (): void => ipcRenderer.send("ustaad:panel-hide"),
  openSetupVideo: (): void => ipcRenderer.send("ustaad:open-setup-video"),
  onState: (listener: (state: UstaadPublicState) => void): (() => void) => subscribe("ustaad:state", listener),
  onOpenPanelPage: (listener: (page: string) => void): (() => void) => subscribe("panel:open-page", listener),

  /* Panel: push-to-talk and audio --------------------------------------- */
  pushToTalkPressed: (): void => ipcRenderer.send("push-to-talk:pressed"),
  pushToTalkReleased: (): void => ipcRenderer.send("push-to-talk:released"),
  sendAudioCaptureStarted: (interactionId: number): void => {
    ipcRenderer.send("audio-capture:started", interactionId);
  },
  sendAudioChunk: (interactionId: number, audioBytes: Uint8Array): void => {
    ipcRenderer.send("audio-capture:chunk", interactionId, audioBytes);
  },
  sendAudioPowerLevel: (interactionId: number, audioPowerLevel: number): void => {
    ipcRenderer.send("audio-capture:level", interactionId, audioPowerLevel);
  },
  sendAudioCaptureError: (interactionId: number, errorMessage: string): void => {
    ipcRenderer.send("audio-capture:error", interactionId, errorMessage);
  },
  sendAudioPlaybackStarted: (interactionId: number): void => {
    ipcRenderer.send("audio-playback:started", interactionId);
  },
  sendAudioPlaybackEnded: (interactionId: number): void => {
    ipcRenderer.send("audio-playback:ended", interactionId);
  },
  sendAudioPlaybackError: (interactionId: number, errorMessage: string): void => {
    ipcRenderer.send("audio-playback:error", interactionId, errorMessage);
  },
  onAudioCaptureStart: (listener: (payload: { interactionId: number }) => void): (() => void) => {
    return subscribe("audio-capture:start", listener);
  },
  onAudioCaptureStop: (listener: (payload: { interactionId: number }) => void): (() => void) => {
    return subscribe("audio-capture:stop", listener);
  },
  onAudioPlayback: (listener: (payload: AudioPlaybackPayload) => void): (() => void) => {
    return subscribe("audio-playback:play", listener);
  },
  onFallbackSpeech: (listener: (payload: FallbackSpeechPayload) => void): (() => void) => {
    return subscribe("audio-playback:fallback-speech", listener);
  },
  onStopAudioPlayback: (listener: () => void): (() => void) => {
    return subscribeToSignal("audio-playback:stop", listener);
  },

  addTodo: (todoText: string): void => ipcRenderer.send("panel:add-todo", todoText),
  addMemory: (factText: string): void => ipcRenderer.send("panel:add-memory", factText),
  clearMemory: (): void => ipcRenderer.send("panel:clear-memory"),
  clearAuditLog: (): void => ipcRenderer.send("panel:clear-audit-log"),
  searchRunHistory: (query: string): Promise<RunHistorySearchResult[]> => {
    return ipcRenderer.invoke("panel:search-run-history", query);
  },
  clearRunHistory: (): void => ipcRenderer.send("panel:clear-run-history"),

  /* Cursor overlay ------------------------------------------------------- */
  sendPointingAnimationCompleted: (interactionId: number): void => {
    ipcRenderer.send("overlay:point-complete", interactionId);
  },
  onOverlayState: (
    listener: (payload: Pick<UstaadPublicState, "voiceState" | "audioPowerLevel">) => void,
  ): (() => void) => subscribe("overlay:state", listener),
  onOverlayCursor: (listener: (payload: OverlayCursorPayload) => void): (() => void) => {
    return subscribe("overlay:cursor", listener);
  },
  onOverlayResponse: (listener: (responseText: string) => void): (() => void) => {
    return subscribe("overlay:response", listener);
  },
  onOverlayMode: (listener: (payload: OverlayModePayload) => void): (() => void) => {
    return subscribe("overlay:mode", listener);
  },
  onOverlayCancelPointing: (listener: () => void): (() => void) => {
    return subscribeToSignal("overlay:cancel-pointing", listener);
  },
  onOverlayPoint: (listener: (payload: OverlayPointPayload) => void): (() => void) => {
    return subscribe("overlay:point", listener);
  },

  /* Island --------------------------------------------------------------- */
  getIslandState: (): Promise<IslandState> => ipcRenderer.invoke("island:get-state"),
  onIslandState: (listener: (state: IslandState) => void): (() => void) => subscribe("island:state", listener),
  onIslandExpanded: (listener: (payload: { isExpanded: boolean }) => void): (() => void) => {
    return subscribe("island:expanded", listener);
  },
  onIslandPresentation: (listener: (payload: { presentation: IslandPresentation }) => void): (() => void) => {
    return subscribe("island:presentation", listener);
  },
  closeIsland: (): void => ipcRenderer.send("island:close"),
  setIslandPointerOver: (isPointerOverIsland: boolean): void => {
    ipcRenderer.send("island:pointer-over", isPointerOverIsland);
  },
  setIslandExpanded: (isExpanded: boolean): void => {
    ipcRenderer.send("island:set-expanded", isExpanded);
  },
  resolveConfirmation: (confirmationId: string, decision: "approve" | "reject"): Promise<string> => {
    return ipcRenderer.invoke("island:resolve-confirmation", confirmationId, decision);
  },
  saveSkillSuggestion: (): Promise<string> => ipcRenderer.invoke("island:save-skill-suggestion"),
  dismissSkillSuggestion: (): Promise<void> => ipcRenderer.invoke("island:dismiss-skill-suggestion"),
  renameSkill: (skillId: string, nextName: string): Promise<void> => {
    return ipcRenderer.invoke("panel:rename-skill", skillId, nextName);
  },
  removeSkill: (skillId: string): Promise<void> => ipcRenderer.invoke("panel:remove-skill", skillId),
  runCheckInNow: (): Promise<void> => ipcRenderer.invoke("panel:run-check-in-now"),
  undoActivity: (activityEntryId: string): Promise<boolean> => {
    return ipcRenderer.invoke("island:undo-activity", activityEntryId);
  },
  launchApp: (appName: string): Promise<void> => ipcRenderer.invoke("island:launch-app", appName),
  mediaControl: (operation: "play_pause" | "next" | "previous"): Promise<void> => {
    return ipcRenderer.invoke("island:media-control", operation);
  },
  copyClip: (clipId: string): Promise<boolean> => ipcRenderer.invoke("island:copy-clip", clipId),
  clearClips: (): void => ipcRenderer.send("island:clear-clips"),
  toggleTodo: (todoId: string, isDone: boolean): void => {
    ipcRenderer.send("island:toggle-todo", todoId, isDone);
  },
  removeTodo: (todoId: string): void => ipcRenderer.send("island:remove-todo", todoId),
  toggleSchedule: (scheduleId: string, isEnabled: boolean): void => {
    ipcRenderer.send("island:toggle-schedule", scheduleId, isEnabled);
  },
  removeSchedule: (scheduleId: string): void => ipcRenderer.send("island:remove-schedule", scheduleId),
  removeMemory: (memoryFactId: string): void => ipcRenderer.send("island:remove-memory", memoryFactId),
  setIslandToggle: (toggleKey: IslandToggleKey, isEnabled: boolean): void => {
    ipcRenderer.send("island:set-toggle", toggleKey, isEnabled);
  },
  setWallpaperSolidColor: (wallpaperColor: string): Promise<void> => {
    return ipcRenderer.invoke("island:set-wallpaper-solid", wallpaperColor);
  },
  openPanel: (page: string): void => ipcRenderer.send("island:open-panel", page),
  showPanel: (page: string): void => ipcRenderer.send("panel:open-page", page),

  /* Region selector (circle to ask) -------------------------------------- */
  sendSelectionCompleted: (selectionBounds: SelectionBoundsPayload): void => {
    ipcRenderer.send("selection:completed", selectionBounds);
  },
  sendSelectionCancelled: (): void => ipcRenderer.send("selection:cancelled"),
});
