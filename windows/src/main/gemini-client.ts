import { GeminiChatModel, GeminiVoiceName } from "../shared/contracts";
import {
  describePictureFailure,
  GeneratedPicturePayload,
  readPictureFromGeminiResponse,
} from "./image-generation";
import { BrainStreamRequest, SynthesizedSpeech } from "./brain-types";
import { extractGeminiInlineAudioBase64, extractGeminiTextDelta } from "./gemini-sse";
import { ServerSentEventTextParser } from "./sse-parser";
import { wrapGeminiSpeechAudio } from "./wav-encoder";

const geminiApiBaseUrl = "https://generativelanguage.googleapis.com/v1beta";

/** Pictures take longer than words, so they get their own, longer allowance. */
const pictureRequestTimeoutMilliseconds = 120_000;

/** Transcription always uses flash: it is the fastest model that hears well. */
const geminiTranscriptionModel: GeminiChatModel = "gemini-2.5-flash";
const geminiSpeechModel = "gemini-2.5-flash-preview-tts";
/** Gemini text-to-speech always answers with 24 kHz mono 16-bit PCM. */
const geminiSpeechSampleRate = 24_000;

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiErrorPayload {
  error?: { message?: string; status?: string; code?: number };
}

/** One HTTP round trip, with the error body kept for a readable message. */
interface GeminiCallResult {
  response: Response;
  errorBodyText: string;
}

/** A direct Gemini connection using the user's own Google AI Studio key. */
export class GeminiClient {
  constructor(private readonly apiKey: string) {}

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async streamChat(request: BrainStreamRequest, chatModel: GeminiChatModel): Promise<string> {
    const contents: GeminiContent[] = request.conversationHistory.flatMap((exchange) => [
      { role: "user" as const, parts: [{ text: exchange.userTranscript }] },
      { role: "model" as const, parts: [{ text: exchange.assistantResponse }] },
    ]);

    const currentParts: GeminiPart[] = request.images.map((image) => ({
      inline_data: { mime_type: image.mediaType, data: image.base64Data },
    }));
    currentParts.push(...request.images.map((image) => ({ text: image.label })));
    currentParts.push({ text: request.userPrompt });
    contents.push({ role: "user", parts: currentParts });

    const callResult = await this.callGemini(
      `models/${chatModel}:streamGenerateContent?alt=sse`,
      {
        system_instruction: { parts: [{ text: request.systemPrompt }] },
        contents,
        generationConfig: {
          temperature: 0.85,
          maxOutputTokens: 1_024,
        },
      },
      request.signal,
      120_000,
    );

    if (!callResult.response.ok || !callResult.response.body) {
      throw new Error(describeGeminiFailure(callResult));
    }

    const responseReader = callResult.response.body.getReader();
    const textDecoder = new TextDecoder();
    const eventParser = new ServerSentEventTextParser();
    let accumulatedText = "";

    const processEventData = (serializedEvents: string[]): void => {
      for (const serializedEvent of serializedEvents) {
        const textDelta = extractGeminiTextDelta(serializedEvent);
        if (!textDelta) {
          continue;
        }
        accumulatedText += textDelta;
        request.onTextUpdate?.(accumulatedText);
      }
    };

    while (true) {
      const { done, value } = await responseReader.read();
      if (done) {
        break;
      }
      processEventData(eventParser.appendChunk(textDecoder.decode(value, { stream: true })));
    }
    processEventData(eventParser.appendChunk(textDecoder.decode()));
    processEventData(eventParser.finish());

    if (!accumulatedText.trim()) {
      throw new Error("Gemini finished the request without returning any text.");
    }

    return accumulatedText;
  }

  /** Speaks one reply with a Gemini prebuilt voice. */
  async synthesizeSpeech(
    text: string,
    voiceName: GeminiVoiceName,
    signal: AbortSignal,
  ): Promise<SynthesizedSpeech> {
    const callResult = await this.callGemini(
      `models/${geminiSpeechModel}:generateContent`,
      {
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName } },
          },
        },
      },
      signal,
      60_000,
    );

    if (!callResult.response.ok) {
      throw new Error(describeGeminiFailure(callResult));
    }

    const serializedResponseBody = await callResult.response.text();
    const base64Audio = extractGeminiInlineAudioBase64(serializedResponseBody);
    if (!base64Audio) {
      throw new Error("Gemini returned no speech audio for that reply.");
    }

    return wrapGeminiSpeechAudio(base64Audio, geminiSpeechSampleRate);
  }

  /** Transcribes one recorded snippet of speech (talk, circle-to-ask, dictation). */
  async transcribeAudio(wavAudio: Buffer, signal: AbortSignal): Promise<string> {
    const callResult = await this.callGemini(
      `models/${geminiTranscriptionModel}:generateContent`,
      {
        system_instruction: {
          parts: [{
            text: "you transcribe speech. return only the words that were spoken, with normal punctuation and no commentary. if there is no speech, return an empty string.",
          }],
        },
        contents: [{
          role: "user",
          parts: [
            { inline_data: { mime_type: "audio/wav", data: wavAudio.toString("base64") } },
            { text: "transcribe this." },
          ],
        }],
        generationConfig: { temperature: 0 },
      },
      signal,
      90_000,
    );

    if (!callResult.response.ok) {
      throw new Error(describeGeminiFailure(callResult));
    }

    const responsePayload = await callResult.response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return (responsePayload.candidates?.[0]?.content?.parts ?? [])
      .map((responsePart) => responsePart.text ?? "")
      .join("")
      .trim();
  }

  /**
   * Runs a small, image-free request. Used by the dictation cleanup pass, which
   * must be fast and must never be tempted to answer the user's text.
   */
  async completeText(
    systemInstruction: string,
    userPrompt: string,
    chatModel: GeminiChatModel,
    signal: AbortSignal,
  ): Promise<string> {
    const callResult = await this.callGemini(
      `models/${chatModel}:generateContent`,
      {
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1_024 },
      },
      signal,
      45_000,
    );

    if (!callResult.response.ok) {
      throw new Error(describeGeminiFailure(callResult));
    }

    const responsePayload = await callResult.response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return (responsePayload.candidates?.[0]?.content?.parts ?? [])
      .map((responsePart) => responsePart.text ?? "")
      .join("")
      .trim();
  }

  /**
   * Draws one picture from a description, on the user's own key.
   *
   * Two families of model can do this and a key rarely reaches both, so the
   * image model goes first and Imagen second. The second attempt only happens
   * when the first one did not draw, so the usual case costs one call.
   */
  async generatePicture(prompt: string): Promise<GeneratedPicturePayload> {
    const pictureAttempts: Array<{ path: string; requestBody: Record<string, unknown> }> = [
      {
        path: "models/gemini-2.5-flash-image:generateContent",
        requestBody: {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        },
      },
      {
        path: "models/imagen-4.0-generate-001:predict",
        requestBody: { instances: [{ prompt }], parameters: { sampleCount: 1 } },
      },
    ];

    let lastFailure = "";
    for (const attempt of pictureAttempts) {
      const callResult = await this.callGemini(
        attempt.path,
        attempt.requestBody,
        AbortSignal.timeout(pictureRequestTimeoutMilliseconds),
        pictureRequestTimeoutMilliseconds,
      );

      if (!callResult.response.ok) {
        lastFailure = describePictureFailure(callResult.response.status, callResult.errorBodyText);
        continue;
      }

      const drawnPicture = readPictureFromGeminiResponse(await callResult.response.json());
      if (drawnPicture) {
        return drawnPicture;
      }
      lastFailure = "google answered without a picture. describe it differently and ask again.";
    }

    throw new Error(lastFailure || "google would not draw that.");
  }

  /** Cheap round trip used by the panel's "check my key" button. */
  async verifyApiKey(): Promise<{ ok: boolean; message: string }> {
    if (!this.apiKey) {
      return { ok: false, message: "Paste a Gemini API key first." };
    }

    try {
      const callResult = await this.callGemini(
        "models?pageSize=1",
        null,
        AbortSignal.timeout(12_000),
        12_000,
        "GET",
      );
      if (callResult.response.ok) {
        return {
          ok: true,
          message: "Your Gemini key works. Talk, screen vision, dictation and actions all run on it.",
        };
      }
      return { ok: false, message: describeGeminiFailure(callResult) };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `Could not reach Google: ${errorMessage}` };
    }
  }

  private async callGemini(
    path: string,
    requestBody: Record<string, unknown> | null,
    signal: AbortSignal,
    timeoutMilliseconds: number,
    method: "GET" | "POST" = "POST",
  ): Promise<GeminiCallResult> {
    const response = await fetch(`${geminiApiBaseUrl}/${path}`, {
      method,
      headers: {
        "x-goog-api-key": this.apiKey,
        "content-type": "application/json",
      },
      body: requestBody ? JSON.stringify(requestBody) : undefined,
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMilliseconds)]),
    });

    return {
      response,
      errorBodyText: response.ok ? "" : await response.text(),
    };
  }
}

/** Turns Google's error payloads into something a person can act on. */
export function describeGeminiFailure(callResult: GeminiCallResult): string {
  const failureStatus = callResult.response.status;
  const statusHints: Record<number, string> = {
    400: "Google rejected the request",
    401: "that Gemini API key was refused",
    403: "that Gemini API key is not allowed to use this model",
    404: "that Gemini model is not available for this key",
    429: "the free Gemini tier is rate limited right now, try again in a moment",
    500: "Google had a server error",
    503: "Gemini is busy right now",
  };
  const statusHint = statusHints[failureStatus] ?? `Gemini request failed (${failureStatus})`;
  const errorSummary = readGeminiErrorSummary(callResult.errorBodyText);
  return errorSummary ? `${statusHint}: ${errorSummary}` : statusHint;
}

function readGeminiErrorSummary(responseBodyText: string): string {
  if (!responseBodyText) {
    return "";
  }

  try {
    const errorPayload = JSON.parse(responseBodyText) as GeminiErrorPayload;
    return (errorPayload.error?.message ?? "").slice(0, 300);
  } catch {
    return responseBodyText.slice(0, 200);
  }
}
