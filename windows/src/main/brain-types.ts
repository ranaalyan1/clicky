/** Provider-neutral shapes both Ustaad brains (Gemini and Claude) share. */

export interface BrainImage {
  mediaType: string;
  base64Data: string;
  /** Text sent next to the image describing which screen or region it is. */
  label: string;
}

export interface ConversationExchange {
  userTranscript: string;
  assistantResponse: string;
}

export interface BrainStreamRequest {
  systemPrompt: string;
  userPrompt: string;
  images: BrainImage[];
  conversationHistory: ConversationExchange[];
  signal: AbortSignal;
  onTextUpdate?: (accumulatedText: string) => void;
}

export interface SynthesizedSpeech {
  audioData: Buffer;
  contentType: string;
}
