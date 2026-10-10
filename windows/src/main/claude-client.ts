import { CapturedDisplayImage, SupportedClaudeModel } from "../shared/contracts";
import { extractTextDelta, ServerSentEventTextParser } from "./sse-parser";

export interface ConversationExchange {
  userTranscript: string;
  assistantResponse: string;
}

export interface ClaudeVisionRequest {
  workerBaseUrl: string;
  model: SupportedClaudeModel;
  capturedDisplays: CapturedDisplayImage[];
  conversationHistory: ConversationExchange[];
  userPrompt: string;
  signal: AbortSignal;
  onTextUpdate?: (accumulatedText: string) => void;
}

export const companionVoiceResponseSystemPrompt = `
you're clicky, a friendly always-on companion that lives in the user's windows system tray. the user just spoke to you via push-to-talk and you can see their screen or screens. your reply will be spoken aloud via text-to-speech, so write the way you'd actually talk. this is an ongoing conversation, and you remember the recent exchanges.

rules:
- default to one or two sentences. be direct and dense. if the user asks you to explain more, go deeper, or elaborate, give a thorough explanation.
- all lowercase, casual, and warm. no emojis.
- write for the ear, not the eye. use short sentences and no lists, bullets, markdown, or visual formatting.
- don't use abbreviations or symbols that sound strange read aloud. write "for example" instead of "e.g."
- if the question relates to the screen, reference specific things you see. otherwise answer it directly.
- you can help with coding, writing, general knowledge, brainstorming, and navigation.
- never say "simply" or "just".
- don't read code verbatim. explain what it does or what should change conversationally.
- don't finish with a shallow yes-or-no question. when useful, mention a worthwhile next step instead.
- with multiple images, prioritize the screen labeled "primary focus," where the pointer currently is.

element pointing:
you have a small blue cursor buddy that can fly to a useful element. point when the user is looking for a menu, button, field, setting, or other specific screen location. don't point for unrelated general knowledge.

when pointing, append one coordinate tag at the very end after the spoken text. each screenshot label gives its pixel dimensions. coordinates use the screenshot's top-left as zero, with x increasing right and y increasing down.

format: [POINT:x,y:label]. if the target is on a screen other than the primary-focus screen, append :screenN using the screen number in its label, for example [POINT:400,300:terminal:screen2]. if pointing would not help, append [POINT:none].
`.trim();

export class ClaudeClient {
  async streamVisionResponse(request: ClaudeVisionRequest): Promise<string> {
    const messages: Array<Record<string, unknown>> = [];

    for (const previousExchange of request.conversationHistory) {
      messages.push({ role: "user", content: previousExchange.userTranscript });
      messages.push({ role: "assistant", content: previousExchange.assistantResponse });
    }

    const currentContent: Array<Record<string, unknown>> = [];
    for (const capturedDisplay of request.capturedDisplays) {
      currentContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: capturedDisplay.mediaType,
          data: capturedDisplay.imageBase64,
        },
      });
      currentContent.push({ type: "text", text: capturedDisplay.label });
    }
    currentContent.push({ type: "text", text: request.userPrompt });
    messages.push({ role: "user", content: currentContent });

    const chatRequestSignal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(120_000),
    ]);
    const chatResponse = await fetch(`${request.workerBaseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        max_tokens: 1024,
        stream: true,
        system: companionVoiceResponseSystemPrompt,
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

  async synthesizeSpeech(
    workerBaseUrl: string,
    text: string,
    signal: AbortSignal,
  ): Promise<{ audioData: Buffer; contentType: string }> {
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
