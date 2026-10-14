import {
  BrainConnectionTestResult,
  UstaadUserConfig,
  GeminiChatModel,
} from "../shared/contracts";
import { BrainStreamRequest, SynthesizedSpeech } from "./brain-types";
import { ClaudeClient } from "./claude-client";
import { buildDictationCleanupUserPrompt, dictationCleanupSystemPrompt } from "./dictation-prompts";
import { GeminiClient } from "./gemini-client";
import { GeneratedPicturePayload } from "./image-generation";
import { LocalBrainClient, normalizeLocalBrainBaseUrl } from "./local-brain-client";
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
  constructor(
    private readonly claudeClient = new ClaudeClient(),
    private readonly localBrainClient = new LocalBrainClient(),
  ) {}

  /**
   * The provider that can actually answer right now. A user who picked Gemini
   * but pasted a Worker URL still gets a working Ustaad instead of an error.
   */
  resolveActiveProvider(config: UstaadUserConfig): "gemini" | "worker" | "local" | null {
    if (config.brainProvider === "local" && config.localBrainBaseUrl) {
      return "local";
    }
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

    if (activeProvider === "local") {
      return `on this pc (${config.localBrainModel})`;
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
    if (config.brainProvider === "local") {
      return "Start your local model server (ollama serve, or LM Studio) and check the address in the setup tab.";
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
    const activeProvider = this.resolveActiveProvider(config);
    if (activeProvider === "local") {
      return this.localBrainClient.streamChat(
        request,
        config.localBrainBaseUrl,
        config.localBrainModel,
        config.localBrainSeesScreen,
      );
    }
    if (activeProvider === "gemini") {
      return new GeminiClient(config.geminiApiKey).streamChat(request, config.geminiChatModel);
    }

    return this.claudeClient.streamVisionResponse(
      request,
      config.workerBaseUrl,
      config.selectedClaudeModel,
    );
  }

  /** Confirms the local server is up and says which models it has loaded. */
  async testLocalConnection(config: UstaadUserConfig): Promise<BrainConnectionTestResult> {
    let baseUrl: string;
    try {
      baseUrl = normalizeLocalBrainBaseUrl(config.localBrainBaseUrl);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (!baseUrl) {
      return { ok: false, message: "paste the address of your local model server first." };
    }

    try {
      const listedModels = await this.localBrainClient.listModels(baseUrl);
      if (!listedModels.length) {
        return { ok: false, message: `${baseUrl} answered but has no models loaded. pull one first, for example: ollama pull ${config.localBrainModel}` };
      }
      const chosenModelIsThere = listedModels.includes(config.localBrainModel);
      return {
        ok: true,
        message: chosenModelIsThere
          ? `your local brain answered. ${config.localBrainModel} is loaded and ready.`
          : `${baseUrl} answered with ${listedModels.slice(0, 5).join(", ")}. ${config.localBrainModel} is not among them — set a model name that is.`,
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Draws one picture on the user's own Google key.
   *
   * Pictures are Gemini-only: the Worker proxy speaks for Claude, and a local
   * text model has no brush, so the missing key is reported here rather than
   * failing somewhere deeper down.
   */
  async drawPicture(config: UstaadUserConfig, prompt: string): Promise<GeneratedPicturePayload> {
    if (!config.geminiApiKey) {
      throw new Error(
        "drawing pictures needs your own Gemini key, because the worker brain cannot draw. paste one in the setup tab and ask again.",
      );
    }
    return new GeminiClient(config.geminiApiKey).generatePicture(prompt);
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
        this.resolveActiveProvider(config) === "local"
          ? "the brain on this pc answers in text but cannot hear. listening needs a Google key: paste one in the setup tab, or switch the brain back."
          : "One-shot transcription needs a Gemini API key. Add one in setup, or deploy the Worker to stream transcription instead.",
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

    const activeProvider = this.resolveActiveProvider(config);

    try {
      if (activeProvider === "local") {
        return await this.localBrainClient.streamChat(
          {
            systemPrompt: dictationCleanupSystemPrompt,
            userPrompt: cleanupPrompt,
            images: [],
            conversationHistory: [],
            signal,
          },
          config.localBrainBaseUrl,
          config.localBrainModel,
          false,
        );
      }

      if (activeProvider === "gemini") {
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
    if (config.brainProvider === "local") {
      return this.testLocalConnection(config);
    }
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
