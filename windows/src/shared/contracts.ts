export type CompanionVoiceState = "idle" | "listening" | "processing" | "responding";

export const supportedClaudeModels = ["claude-sonnet-4-6", "claude-opus-4-6"] as const;
export type SupportedClaudeModel = (typeof supportedClaudeModels)[number];

export interface ClickaaUserConfig {
  workerBaseUrl: string;
  selectedModel: SupportedClaudeModel;
  cursorEnabled: boolean;
  launchAtLogin: boolean;
}

export interface ClickaaPublicState {
  voiceState: CompanionVoiceState;
  configured: boolean;
  cursorEnabled: boolean;
  selectedModel: SupportedClaudeModel;
  launchAtLogin: boolean;
  workerBaseUrl: string;
  shortcutAvailable: boolean;
  shortcutLabel: string;
  lastTranscript: string;
  partialTranscript: string;
  responseText: string;
  audioPowerLevel: number;
  errorMessage: string | null;
}

export interface AudioPlaybackPayload {
  interactionId: number;
  audioBase64: string;
  contentType: string;
}

export interface FallbackSpeechPayload {
  interactionId: number;
  text: string;
}

export interface OverlayCursorPayload {
  x: number;
  y: number;
  visible: boolean;
}

export interface OverlayPointPayload {
  interactionId: number;
  x: number;
  y: number;
  label: string;
  responseText: string;
}

export interface WorkerConnectionTestResult {
  ok: boolean;
  message: string;
}

export interface CapturedDisplayImage {
  displayId: number;
  imageBase64: string;
  mediaType: "image/jpeg";
  label: string;
  isCursorDisplay: boolean;
  imageWidth: number;
  imageHeight: number;
  displayBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}
