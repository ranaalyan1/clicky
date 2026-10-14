/**
 * Looking something up, with the sources kept.
 *
 * Ustaad asks Google for an answer with search grounding, which means the
 * answer arrives with the pages it came from. Those pages are the point: an
 * answer someone can check is worth more than a confident paragraph, so they
 * are parsed, cleaned, deduplicated and shown next to it. Everything here is
 * pure, because the parsing is where the bugs would live.
 */

export const maximumResearchSources = 6;
export const maximumResearchQuestionLength = 300;
export const maximumSpokenSummaryLength = 420;

export interface ResearchSource {
  title: string;
  url: string;
}

export interface ResearchAnswer {
  answerText: string;
  sources: ResearchSource[];
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A source has to be a link somebody can actually open. */
function isOpenableSourceUrl(rawUrl: string): boolean {
  try {
    const parsedUrl = new URL(rawUrl);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    return false;
  }
}

function describeSourceTitle(title: string, url: string): string {
  if (title) {
    return title;
  }
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return url;
  }
}

/**
 * Reads the answer and its sources out of a grounded Gemini reply.
 *
 * The sources live in `groundingMetadata`, next to the candidate rather than
 * in it, and Google may repeat a page it leaned on twice — so this keeps the
 * first mention of each and stops at a handful, because a list nobody reads
 * is not a citation.
 */
export function readResearchAnswer(responsePayload: unknown): ResearchAnswer | null {
  if (!responsePayload || typeof responsePayload !== "object") {
    return null;
  }

  const candidate = (responsePayload as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: unknown }> };
      groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: unknown; title?: unknown } }> };
    }>;
  }).candidates?.[0];

  const answerText = (candidate?.content?.parts ?? [])
    .map((part) => readText(part.text))
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (!answerText) {
    return null;
  }

  const sources: ResearchSource[] = [];
  const seenUrls = new Set<string>();
  for (const chunk of candidate?.groundingMetadata?.groundingChunks ?? []) {
    const url = readText(chunk.web?.uri);
    if (!url || seenUrls.has(url) || !isOpenableSourceUrl(url)) {
      continue;
    }
    seenUrls.add(url);
    sources.push({ title: describeSourceTitle(readText(chunk.web?.title), url), url });
    if (sources.length >= maximumResearchSources) {
      break;
    }
  }

  return { answerText, sources };
}

/** Turns Google's refusal into a sentence about what to do next. */
export function describeResearchFailure(statusCode: number, errorBodyText: string): string {
  if (statusCode === 429) {
    return "google is rate-limiting lookups on your key right now. give it a minute and ask again.";
  }
  if (statusCode === 404) {
    return "your key cannot reach the model that looks things up. check the model in the setup tab.";
  }

  try {
    const errorPayload = JSON.parse(errorBodyText) as { error?: { message?: unknown } };
    const googleMessage = readText(errorPayload.error?.message);
    if (googleMessage) {
      return `google would not look that up: ${googleMessage}`;
    }
  } catch {
    // Not JSON; fall through to the generic sentence.
  }
  return "google would not look that up just now. try asking again.";
}

/**
 * The part of an answer worth saying out loud.
 *
 * A grounded answer is written to be read: it has citation markers, headings
 * and lists that sound like punctuation read aloud. Speaking the first few
 * sentences and leaving the rest on screen is the polite version.
 */
export function buildSpokenSummary(answerText: string): string {
  const withoutMarkers = answerText
    .replace(/\[\d+\]/gu, "")
    .replace(/[*_`#>]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

  if (withoutMarkers.length <= maximumSpokenSummaryLength) {
    return withoutMarkers;
  }

  const sentences = withoutMarkers.match(/[^.!?]+[.!?]?/gu) ?? [withoutMarkers];
  let summary = "";
  for (const sentence of sentences) {
    if (summary && summary.length + sentence.length > maximumSpokenSummaryLength) {
      break;
    }
    summary += sentence;
  }

  const trimmedSummary = summary.trim();
  if (trimmedSummary) {
    return trimmedSummary;
  }
  return `${withoutMarkers.slice(0, maximumSpokenSummaryLength).trim()}…`;
}
