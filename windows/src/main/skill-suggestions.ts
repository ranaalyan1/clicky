import { UstaadAction } from "../shared/contracts";
import { normalizeForMatch } from "./text-matching";

/**
 * One successful task, remembered so Ustaad can notice repetition. Nothing here
 * is a saved skill: this is just "you have asked for this before".
 */
export interface TaskHistoryEntry {
  id: string;
  /** The goal as the model phrased it, for showing to the user. */
  goal: string;
  /** The normalized goal used for counting repeats. */
  signature: string;
  seedActions: UstaadAction[];
  succeededAtIso: string;
}

export interface SkillSuggestion {
  /** Stable per signature, so the same suggestion is not offered twice. */
  signature: string;
  goal: string;
  proposedName: string;
  seedActions: UstaadAction[];
  /** How many times the user has asked for this. */
  successCount: number;
}

/** How many successful runs of the same task make Ustaad offer to save it. */
export const successfulRunsBeforeSuggesting = 3;

const maximumHistoryEntries = 200;
/** After a "no thanks", leave it alone for a good while. */
const declinedSuggestionsToForget = 5;

/** "play a video on youtube" and "Play a video on YouTube!" are the same task. */
export function taskSignature(goal: string): string {
  return normalizeForMatch(goal.replace(/[.,!?;:]+$/u, ""));
}

/**
 * A short, speakable name for a skill, derived from the goal itself.
 *
 * It is only a starting point: the user can rename the skill in the panel, and
 * the island shows this name before saving anything.
 */
export function proposeSkillName(goal: string): string {
  const words = goal
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);

  const stopWords = new Set([
    "a", "an", "and", "the", "to", "for", "on", "in", "of", "my", "me", "please",
    "go", "get", "open", "then", "it", "that", "this", "with", "at", "is", "are",
  ]);

  const meaningfulWords = words.filter((word) => !stopWords.has(word.toLowerCase()));
  const chosenWords = (meaningfulWords.length ? meaningfulWords : words).slice(0, 4);
  if (!chosenWords.length) {
    return "my task";
  }
  return chosenWords.join(" ").toLowerCase().slice(0, 60);
}

export interface SkillSuggestionContext {
  history: TaskHistoryEntry[];
  /** Signatures that are already saved as skills. */
  savedSignatures: Set<string> | string[];
  /** Signatures the user said no to, with how many more successes have happened since. */
  declinedSignatures?: Record<string, number>;
  minimumSuccesses?: number;
}

/**
 * Decides whether Ustaad should offer to save something as a skill.
 *
 * Rules, in order: the same task has to have succeeded enough times, it must not
 * already be a skill, and a "no thanks" has to be respected for a while rather
 * than asked again the next time the user does the thing.
 */
export function suggestSkill(context: SkillSuggestionContext): SkillSuggestion | null {
  const minimumSuccesses = context.minimumSuccesses ?? successfulRunsBeforeSuggesting;
  const savedSignatures = new Set(
    Array.isArray(context.savedSignatures) ? context.savedSignatures : [...context.savedSignatures],
  );

  const entriesBySignature = new Map<string, TaskHistoryEntry[]>();
  for (const historyEntry of context.history) {
    const signature = historyEntry.signature || taskSignature(historyEntry.goal);
    if (!signature || savedSignatures.has(signature)) {
      continue;
    }
    entriesBySignature.set(signature, [...(entriesBySignature.get(signature) ?? []), historyEntry]);
  }

  let bestSuggestion: SkillSuggestion | null = null;
  for (const [signature, matchingEntries] of entriesBySignature) {
    if (matchingEntries.length < minimumSuccesses) {
      continue;
    }

    const declineCountAtRefusal = context.declinedSignatures?.[signature];
    if (declineCountAtRefusal !== undefined) {
      const successesSinceDecline = matchingEntries.length - declineCountAtRefusal;
      if (successesSinceDecline < declinedSuggestionsToForget) {
        continue;
      }
    }

    if (!bestSuggestion || matchingEntries.length > bestSuggestion.successCount) {
      // The newest run holds the freshest step list, which seeds the skill.
      const newestEntry = matchingEntries[matchingEntries.length - 1]!;
      bestSuggestion = {
        signature,
        goal: newestEntry.goal,
        proposedName: proposeSkillName(newestEntry.goal),
        seedActions: newestEntry.seedActions,
        successCount: matchingEntries.length,
      };
    }
  }

  return bestSuggestion;
}

/** True when the history has grown past what is worth keeping. */
export function trimTaskHistory(history: TaskHistoryEntry[]): TaskHistoryEntry[] {
  return history.slice(-maximumHistoryEntries);
}

export { maximumHistoryEntries, declinedSuggestionsToForget };
