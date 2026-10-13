import { SupportedClaudeModel } from "../shared/contracts";
import { BrainStreamRequest, SynthesizedSpeech } from "./brain-types";
import { extractTextDelta, ServerSentEventTextParser } from "./sse-parser";

/**
 * The Cloudflare Worker brain: Claude for chat and vision, ElevenLabs for
 * speech. All long-lived keys stay on the Worker, never on the user's PC.
 */
export class ClaudeClient {
  async streamVisionResponse(
    request: BrainStreamRequest,
    workerBaseUrl: string,
    model: SupportedClaudeModel,
  ): Promise<string> {
    const messages: Array<Record<string, unknown>> = [];

    for (const previousExchange of request.conversationHistory) {
      messages.push({ role: "user", content: previousExchange.userTranscript });
      messages.push({ role: "assistant", content: previousExchange.assistantResponse });
    }

    const currentContent: Array<Record<string, unknown>> = [];
    for (const image of request.images) {
      currentContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: image.mediaType,
          data: image.base64Data,
        },
      });
      currentContent.push({ type: "text", text: image.label });
    }
    currentContent.push({ type: "text", text: request.userPrompt });
    messages.push({ role: "user", content: currentContent });

    const chatRequestSignal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(120_000),
    ]);
    const chatResponse = await fetch(`${workerBaseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        stream: true,
        system: request.systemPrompt,
        messages,
      }),
      signal: chatRequestSignal,
    });

    if (!chatResponse.ok) {
      const errorBody = await chatResponse.text();
      throw new Error(`Claude request failed (${chatResponse.status}): ${errorBody.slice(0, 500)}`);
    }

    if (!chatResponse.body) {
      throw new Error("Claude returned an empty streaming response.");
    }

    const responseReader = chatResponse.body.getReader();
    const textDecoder = new TextDecoder();
    const eventParser = new ServerSentEventTextParser();
    let accumulatedResponseText = "";

    const processEventData = (serializedEvents: string[]): void => {
      for (const serializedEvent of serializedEvents) {
        const textDelta = extractTextDelta(serializedEvent);
        if (!textDelta) {
          continue;
        }
        accumulatedResponseText += textDelta;
        request.onTextUpdate?.(accumulatedResponseText);
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

    if (!accumulatedResponseText.trim()) {
      throw new Error("Claude completed the request without returning text.");
    }

    return accumulatedResponseText;
  }

  /** Runs a small, image-free request through the Worker (dictation cleanup). */
  async completeText(
    workerBaseUrl: string,
    model: SupportedClaudeModel,
    systemInstruction: string,
    userPrompt: string,
    signal: AbortSignal,
  ): Promise<string> {
    const completionResponse = await fetch(`${workerBaseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        stream: false,
        system: systemInstruction,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
    });

    if (!completionResponse.ok) {
      const errorBody = await completionResponse.text();
      throw new Error(`Cleanup request failed (${completionResponse.status}): ${errorBody.slice(0, 300)}`);
    }

    const completionPayload = await completionResponse.json() as {
      content?: Array<{ type?: string; text?: string }>;
    };
    return (completionPayload.content ?? [])
      .map((contentBlock) => (contentBlock.type === "text" ? contentBlock.text ?? "" : ""))
      .join("")
      .trim();
  }

  async synthesizeSpeech(
    workerBaseUrl: string,
    text: string,
    signal: AbortSignal,
  ): Promise<SynthesizedSpeech> {
    const speechRequestSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(60_000),
    ]);
    const speechResponse = await fetch(`${workerBaseUrl}/tts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_flash_v2_5",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
      signal: speechRequestSignal,
    });

    if (!speechResponse.ok) {
      const errorBody = await speechResponse.text();
      throw new Error(`Speech request failed (${speechResponse.status}): ${errorBody.slice(0, 500)}`);
    }

    const contentType = speechResponse.headers.get("content-type") || "audio/mpeg";
    return {
      audioData: Buffer.from(await speechResponse.arrayBuffer()),
      contentType,
    };
  }
}
