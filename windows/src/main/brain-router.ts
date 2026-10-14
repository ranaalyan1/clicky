import {
  BrainConnectionTestResult,
  UstaadUserConfig,
  GeminiChatModel,
} from "../shared/contracts";
import { BrainStreamRequest, SynthesizedSpeech } from "./brain-types";
import { ClaudeClient } from "./claude-client";
import { buildDictationCleanupUserPrompt, dictationCleanupSystemPrompt } from "./dictation-prompts";
import { GeminiClient } from "./gemini-client";
import { normalizeWorkerBaseUrl } from "./config-store";

export type ResolvedSpeechProvider = "gemini" | "elevenlabs" | "windows";

/**
 * The single place that decides which of the two brains handles a request, and
 * which speech engine reads the answer out loud.
 *
 * - "gemini" uses the user's own Google AI Studio key for everything: chat,
 *   vision, dictation, transcription and speech. No Worker required.
 * - "worker" keeps the original Cloudflare Worker proxy (Claude, AssemblyAI,
 *   ElevenLabs) so the user's PC never holds a shared key.
 */
export class BrainRouter {
  constructor(private readonly claudeClient = new ClaudeClient()) {}

  /**
   * The provider that can actually answer right now. A user who picked Gemini
   * but pasted a Worker URL still gets a working Ustaad instead of an error.
   */
  resolveActiveProvider(config: UstaadUserConfig): "gemini" | "worker" | null {
    if (config.brainProvider === "gemini" && config.geminiApiKey) {
      return "gemini";
    }
    if (config.workerBaseUrl) {
      return "worker";
    }
    if (config.geminiApiKey) {
      return "gemini";
    }
    return null;
  }

  getBrainLabel(config: UstaadUserConfig): string {
    const activeProvider = this.resolveActiveProvider(config);
    if (!activeProvider) {
      return config.brainProvider === "gemini" ? "Gemini (key needed)" : "Worker (url needed)";
    }

    if (activeProvider === "gemini") {
      return config.geminiChatModel === "gemini-2.5-pro" ? "Gemini Pro" : "Gemini Flash";
    }

    return config.selectedClaudeModel === "claude-opus-4-6" ? "Claude Opus" : "Claude Sonnet";
  }

  isConfigured(config: UstaadUserConfig): boolean {
    return this.resolveActiveProvider(config) !== null;
  }

  configurationHint(config: UstaadUserConfig): string {
    if (this.isConfigured(config)) {
      return "";
    }
    return config.brainProvider === "gemini"
      ? "Paste your Gemini API key from Google AI Studio to switch Ustaad on."
      : "Paste your Cloudflare Worker URL to switch Ustaad on.";
  }

  /** Which engine should read this reply aloud. */
  resolveSpeechProvider(config: UstaadUserConfig): ResolvedSpeechProvider {
    const geminiIsAvailable = Boolean(config.geminiApiKey);
    const elevenLabsIsAvailable = Boolean(config.workerBaseUrl);

    switch (config.soul.speechProvider) {
      case "gemini":
        return geminiIsAvailable ? "gemini" : "windows";
      case "elevenlabs":
        return elevenLabsIsAvailable ? "elevenlabs" : "windows";
      case "windows":
        return "windows";
      case "auto":
      default:
        // Whisper-free and self-contained first: a local Gemini key needs no
        // Worker, so prefer it when one is present.
        if (geminiIsAvailable) {
          return "gemini";
        }
        return elevenLabsIsAvailable ? "elevenlabs" : "windows";
    }
  }

  async streamResponse(config: UstaadUserConfig, request: BrainStreamRequest): Promise<string> {
    if (this.resolveActiveProvider(config) === "gemini") {
      return new GeminiClient(config.geminiApiKey).streamChat(request, config.geminiChatModel);
    }

    return this.claudeClient.streamVisionResponse(
      request,
      config.workerBaseUrl,
      config.selectedClaudeModel,
    );
  }

  async synthesizeSpeech(
    config: UstaadUserConfig,
    text: string,
    signal: AbortSignal,
  ): Promise<SynthesizedSpeech> {
    const speechProvider = this.resolveSpeechProvider(config);
    if (speechProvider === "gemini") {
      return new GeminiClient(config.geminiApiKey).synthesizeSpeech(
        text,
        config.soul.geminiVoiceName,
        signal,
      );
    }

    if (speechProvider === "elevenlabs") {
      return this.claudeClient.synthesizeSpeech(config.workerBaseUrl, text, signal);
    }

    throw new Error("The Windows voice is played by the panel renderer, not the brain.");
  }

  /** Used by dictation and circle-to-ask when the brain has no live stream. */
  async transcribeRecordedAudio(
    config: UstaadUserConfig,
    wavAudio: Buffer,
    signal: AbortSignal,
  ): Promise<string> {
    if (!config.geminiApiKey) {
      throw new Error(
        "One-shot transcription needs a Gemini API key. Add one in setup, or deploy the Worker to stream transcription instead.",
      );
    }
    return new GeminiClient(config.geminiApiKey).transcribeAudio(wavAudio, signal);
  }

  /**
   * Cleans dictated speech into sendable text. Falls back to the raw transcript
   * whenever the cleanup request fails, because losing words is worse than
   * pasting a few "ums".
   */
  async cleanDictationTranscript(
    config: UstaadUserConfig,
    rawTranscript: string,
    signal: AbortSignal,
  ): Promise<string> {
    const cleanupPrompt = buildDictationCleanupUserPrompt({
      rawTranscript,
      assistantName: config.soul.assistantName,
      customInstructions: config.soul.customInstructions,
    });

    try {
      if (this.resolveActiveProvider(config) === "gemini") {
        return await new GeminiClient(config.geminiApiKey).completeText(
          dictationCleanupSystemPrompt,
          cleanupPrompt,
          "gemini-2.5-flash" satisfies GeminiChatModel,
          signal,
        );
      }

      return await this.claudeClient.completeText(
        config.workerBaseUrl,
        config.selectedClaudeModel,
        dictationCleanupSystemPrompt,
        cleanupPrompt,
        signal,
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      console.warn("Ustaad could not clean up dictated text; pasting the raw transcript.", error);
      return rawTranscript;
    }
  }

  /** The panel's connection test, for whichever brain is selected. */
  async testConnection(config: UstaadUserConfig): Promise<BrainConnectionTestResult> {
    if (config.brainProvider === "gemini" && config.geminiApiKey) {
      return new GeminiClient(config.geminiApiKey).verifyApiKey();
    }

    let normalizedWorkerBaseUrl: string;
    try {
      normalizedWorkerBaseUrl = normalizeWorkerBaseUrl(config.workerBaseUrl);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }

    if (!normalizedWorkerBaseUrl) {
      return { ok: false, message: "Enter your deployed Worker URL first." };
    }

    try {
      const response = await fetch(`${normalizedWorkerBaseUrl}/transcribe-token`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
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
      return { ok: true, message: "Connected. The Worker's Claude, speech and transcription routes are live." };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
