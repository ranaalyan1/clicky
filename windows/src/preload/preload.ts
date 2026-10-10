import { contextBridge, ipcRenderer } from "electron";
import {
  AudioPlaybackPayload,
  ClickyPublicState,
  FallbackSpeechPayload,
  OverlayCursorPayload,
  OverlayPointPayload,
  SupportedClaudeModel,
  WorkerConnectionTestResult,
} from "../shared/contracts";

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrappedListener = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrappedListener);
  return () => ipcRenderer.removeListener(channel, wrappedListener);
}

contextBridge.exposeInMainWorld("clicky", {
  getState: (): Promise<ClickyPublicState> => ipcRenderer.invoke("clicky:get-state"),
  setWorkerUrl: (workerBaseUrl: string): Promise<ClickyPublicState> => {
    return ipcRenderer.invoke("clicky:set-worker-url", workerBaseUrl);
  },
  testWorker: (workerBaseUrl: string): Promise<WorkerConnectionTestResult> => {
    return ipcRenderer.invoke("clicky:test-worker", workerBaseUrl);
  },
  setModel: (selectedModel: SupportedClaudeModel): Promise<ClickyPublicState> => {
    return ipcRenderer.invoke("clicky:set-model", selectedModel);
  },
  setCursorEnabled: (cursorEnabled: boolean): Promise<ClickyPublicState> => {
    return ipcRenderer.invoke("clicky:set-cursor-enabled", cursorEnabled);
  },
  setLaunchAtLogin: (launchAtLogin: boolean): Promise<ClickyPublicState> => {
    return ipcRenderer.invoke("clicky:set-launch-at-login", launchAtLogin);
  },
  hidePanel: (): void => ipcRenderer.send("clicky:panel-hide"),
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
  sendPointingAnimationCompleted: (interactionId: number): void => {
    ipcRenderer.send("overlay:point-complete", interactionId);
  },
  onState: (listener: (state: ClickyPublicState) => void): (() => void) => {
    return subscribe("clicky:state", listener);
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
    const wrappedListener = (): void => listener();
    ipcRenderer.on("audio-playback:stop", wrappedListener);
    return () => ipcRenderer.removeListener("audio-playback:stop", wrappedListener);
  },
  onOverlayState: (
    listener: (payload: Pick<ClickyPublicState, "voiceState" | "audioPowerLevel">) => void,
  ): (() => void) => subscribe("overlay:state", listener),
  onOverlayCursor: (listener: (payload: OverlayCursorPayload) => void): (() => void) => {
    return subscribe("overlay:cursor", listener);
  },
  onOverlayResponse: (listener: (responseText: string) => void): (() => void) => {
    return subscribe("overlay:response", listener);
  },
  onOverlayCancelPointing: (listener: () => void): (() => void) => {
    const wrappedListener = (): void => listener();
    ipcRenderer.on("overlay:cancel-pointing", wrappedListener);
    return () => ipcRenderer.removeListener("overlay:cancel-pointing", wrappedListener);
  },
  onOverlayPoint: (listener: (payload: OverlayPointPayload) => void): (() => void) => {
    return subscribe("overlay:point", listener);
  },
});
