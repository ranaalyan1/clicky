import type {
  AudioPlaybackPayload,
  ClickyPublicState,
  FallbackSpeechPayload,
  OverlayCursorPayload,
  OverlayPointPayload,
  SupportedClaudeModel,
  WorkerConnectionTestResult,
} from "../shared/contracts";

declare global {
  interface Window {
    clicky: {
      getState(): Promise<ClickyPublicState>;
      setWorkerUrl(workerBaseUrl: string): Promise<ClickyPublicState>;
      testWorker(workerBaseUrl: string): Promise<WorkerConnectionTestResult>;
      setModel(selectedModel: SupportedClaudeModel): Promise<ClickyPublicState>;
      setCursorEnabled(cursorEnabled: boolean): Promise<ClickyPublicState>;
      setLaunchAtLogin(launchAtLogin: boolean): Promise<ClickyPublicState>;
      hidePanel(): void;
      pushToTalkPressed(): void;
      pushToTalkReleased(): void;
      sendAudioCaptureStarted(interactionId: number): void;
      sendAudioChunk(interactionId: number, audioBytes: Uint8Array): void;
      sendAudioPowerLevel(interactionId: number, audioPowerLevel: number): void;
      sendAudioCaptureError(interactionId: number, errorMessage: string): void;
      sendAudioPlaybackStarted(interactionId: number): void;
      sendAudioPlaybackEnded(interactionId: number): void;
      sendAudioPlaybackError(interactionId: number, errorMessage: string): void;
      sendPointingAnimationCompleted(interactionId: number): void;
      onState(listener: (state: ClickyPublicState) => void): () => void;
      onAudioCaptureStart(listener: (payload: { interactionId: number }) => void): () => void;
      onAudioCaptureStop(listener: (payload: { interactionId: number }) => void): () => void;
      onAudioPlayback(listener: (payload: AudioPlaybackPayload) => void): () => void;
      onFallbackSpeech(listener: (payload: FallbackSpeechPayload) => void): () => void;
      onStopAudioPlayback(listener: () => void): () => void;
      onOverlayState(
        listener: (payload: Pick<ClickyPublicState, "voiceState" | "audioPowerLevel">) => void,
      ): () => void;
      onOverlayCursor(listener: (payload: OverlayCursorPayload) => void): () => void;
      onOverlayResponse(listener: (responseText: string) => void): () => void;
      onOverlayCancelPointing(listener: () => void): () => void;
      onOverlayPoint(listener: (payload: OverlayPointPayload) => void): () => void;
    };
  }
}

export {};
