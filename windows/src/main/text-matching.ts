/**
 * Text comparison helpers shared by app launching, to-do lookups, memory
 * lookups, and scheduled task lookups so spoken names match written ones the
 * same way everywhere.
 */

/** Lowercases, strips punctuation, and collapses whitespace for comparison. */
export function normalizeForMatch(rawText: string): string {
  return rawText
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeForMatch(normalizedText: string): string[] {
  return normalizedText ? normalizedText.split(" ").filter(Boolean) : [];
}

/**
 * Scores how well `query` describes `candidateText`.
 *
 * 1000 exact, 800 one contains the other, then word overlap in between so that
 * "call mom" still finds "Call Mom about the trip".
 */
export function scoreTextMatch(query: string, candidateText: string): number {
  const normalizedQuery = normalizeForMatch(query);
  const normalizedCandidate = normalizeForMatch(candidateText);
  if (!normalizedQuery || !normalizedCandidate) {
    return 0;
  }

  if (normalizedQuery === normalizedCandidate) {
    return 1000;
  }

  if (normalizedCandidate.startsWith(normalizedQuery) || normalizedQuery.startsWith(normalizedCandidate)) {
    return 800 - Math.abs(normalizedCandidate.length - normalizedQuery.length);
  }

  if (normalizedCandidate.includes(normalizedQuery) || normalizedQuery.includes(normalizedCandidate)) {
    return 700 - Math.abs(normalizedCandidate.length - normalizedQuery.length);
  }

  const queryTokens = tokenizeForMatch(normalizedQuery);
  const candidateTokens = new Set(tokenizeForMatch(normalizedCandidate));
  const matchedTokenCount = queryTokens.filter((queryToken) => candidateTokens.has(queryToken)).length;
  if (!matchedTokenCount) {
    return 0;
  }

  // A partial word match is weaker than a whole-token match, but still useful
  // when speech recognition splits or joins words ("to do" versus "todo").
  const partialTokenCount = queryTokens
    .filter((queryToken) => queryToken.length > 3)
    .filter((queryToken) => [...candidateTokens].some(
      (candidateToken) => candidateToken.startsWith(queryToken) || queryToken.startsWith(candidateToken),
    ))
    .length;

  return 200 + matchedTokenCount * 60 + Math.min(partialTokenCount, 3) * 20;
}

export interface RankedTextMatch<TItem> {
  item: TItem;
  score: number;
}

/** Ranks items by match score, best first, dropping anything that scores zero. */
export function rankTextMatches<TItem>(
  query: string,
  items: TItem[],
  describeItem: (item: TItem) => string,
  limit: number,
): Array<RankedTextMatch<TItem>> {
  return items
    .map((item) => ({ item, score: scoreTextMatch(query, describeItem(item)) }))
    .filter((rankedMatch) => rankedMatch.score > 0)
    .sort((firstMatch, secondMatch) => secondMatch.score - firstMatch.score)
    .slice(0, limit);
}

/**
 * True when the two best candidates are so close that guessing would be rude.
 * The caller should ask the user to pick instead of launching the wrong thing.
 */
export function isAmbiguousTopMatch<TItem>(rankedMatches: Array<RankedTextMatch<TItem>>): boolean {
  const [bestMatch, secondMatch] = rankedMatches;
  if (!bestMatch || !secondMatch) {
    return false;
  }
  return bestMatch.score < 900 && secondMatch.score >= bestMatch.score - 15;
}
