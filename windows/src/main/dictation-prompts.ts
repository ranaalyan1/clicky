/**
 * Dictation cleanup: the user talks badly on purpose ("uh, meet at nine, no
 * ten") and Ustaad types the sentence they meant.
 */

export const dictationCleanupSystemPrompt = `you clean up dictated speech. the user talked into a microphone and the words landed in a text box.

rewrite their words so the text is ready to send:
- keep their meaning, their voice and their vocabulary. do not add ideas, do not answer questions, do not summarise.
- remove false starts and self-corrections: keep the corrected version, drop the abandoned one.
- remove filler words ("uh", "um", "like" when it is filler, "you know") and repeated words.
- add normal punctuation and capitalisation, and split run-on speech into sentences.
- fix obvious speech-recognition slips in ordinary words. leave names, code, urls and technical terms alone unless they are clearly wrong.
- keep numbers the way they were spoken unless they are clearly a quantity or a time.
- if the text is already clean, return it unchanged.
- return only the finished text. no quotes, no labels, no explanation, no markdown.`;

export interface DictationCleanupRequest {
  rawTranscript: string;
  assistantName: string;
  /** Extra guidance from the user's personality, when they set any. */
  customInstructions: string;
}

export function buildDictationCleanupUserPrompt(request: DictationCleanupRequest): string {
  const instructionLines = [
    `the assistant is called ${request.assistantName}. its name is spelled exactly like that.`,
  ];
  if (request.customInstructions.trim()) {
    instructionLines.push(request.customInstructions.trim());
  }
  instructionLines.push("dictated text:", request.rawTranscript.trim());
  return instructionLines.join("\n\n");
}

/**
 * Very short utterances ("yes", "sounds good") are pasted unchanged: a network
 * round trip would add latency for no benefit.
 */
export function shouldSkipDictationCleanup(rawTranscript: string): boolean {
  const wordCount = rawTranscript.trim().split(/\s+/u).filter(Boolean).length;
  return wordCount < 4;
}

/**
 * Models still occasionally wrap clean text in quotes or announce it. Strip the
 * wrappers so stray punctuation never lands in the user's document.
 */
export function stripDictationCleanupWrappers(cleanedText: string): string {
  let trimmedText = cleanedText.trim();

  trimmedText = trimmedText.replace(/^(?:cleaned|corrected|here(?:'s| is)[^:]*):\s*/iu, "");

  const wrapperPairs: Array<[string, string]> = [["\"", "\""], ["'", "'"], ["“", "”"], ["`", "`"]];
  for (const [openingWrapper, closingWrapper] of wrapperPairs) {
    if (trimmedText.startsWith(openingWrapper) && trimmedText.endsWith(closingWrapper)
      && trimmedText.length > openingWrapper.length + closingWrapper.length) {
      trimmedText = trimmedText.slice(openingWrapper.length, -closingWrapper.length).trim();
    }
  }

  return trimmedText;
}

/** The prompt used when a scheduled task runs without the user present. */
export function buildScheduledTaskPrompt(scheduledTaskName: string, scheduledTaskPrompt: string): string {
  return `scheduled task "${scheduledTaskName}" is running now. do what it asks and tell the user what you did in one or two spoken sentences. task: ${scheduledTaskPrompt}`;
}
