interface GeminiStreamingEvent {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: { mimeType?: string; data?: string };
        inline_data?: { mime_type?: string; data?: string };
      }>;
    };
  }>;
}

/** Pulls streamed answer text out of one Gemini `streamGenerateContent` event. */
export function extractGeminiTextDelta(serializedEventData: string): string {
  if (!serializedEventData || serializedEventData === "[DONE]") {
    return "";
  }

  try {
    const eventPayload = JSON.parse(serializedEventData) as GeminiStreamingEvent;
    const candidateParts = eventPayload.candidates?.[0]?.content?.parts ?? [];
    return candidateParts
      .map((candidatePart) => (typeof candidatePart.text === "string" ? candidatePart.text : ""))
      .join("");
  } catch {
    // A malformed optional event must never discard text that already arrived.
    return "";
  }
}

/**
 * Reads the base64 audio Gemini text-to-speech returns. The REST API answers
 * with `inlineData`, but some responses use the snake_case form.
 */
export function extractGeminiInlineAudioBase64(serializedResponseBody: string): string {
  try {
    const responsePayload = JSON.parse(serializedResponseBody) as GeminiStreamingEvent;
    const candidateParts = responsePayload.candidates?.[0]?.content?.parts ?? [];
    for (const candidatePart of candidateParts) {
      const base64Audio = candidatePart.inlineData?.data ?? candidatePart.inline_data?.data;
      if (typeof base64Audio === "string" && base64Audio) {
        return base64Audio;
      }
    }
  } catch {
    return "";
  }

  return "";
}
