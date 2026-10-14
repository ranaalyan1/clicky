import { AbilitySettings, RunOutcome, Skill, UstaadAction } from "../shared/contracts";
import {
  buildActionProtocolInstructions,
  describeActions,
  parseUstaadActions,
  splitSpokenTextFromActionBlock,
  splitTaskGoalFromResponse,
} from "./action-protocol";

/** How many runs in a row may fail before Ustaad offers to work out a fix. */
export const runsBeforeRepairOffer = 2;

/** Starting steps a repair may carry, matching what a saved skill may hold. */
export const maximumRepairStartingActions = 12;

const maximumExplanationLength = 200;

/**
 * True when a run went badly enough to count against the skill.
 *
 * A run the user stopped themselves is not a failure: Escape means "not now",
 * not "this is broken", and counting it would offer repairs for skills that
 * work perfectly well.
 */
export function isSkillFailure(outcome: RunOutcome): boolean {
  return outcome !== "completed" && outcome !== "stopped";
}

/**
 * Whether this skill has failed enough times, since the last offer, to be worth
 * asking about. The offered streak is remembered so a "not now" is respected
 * until the skill has failed twice more.
 */
export function shouldOfferSkillRepair(skill: Skill): boolean {
  return skill.failureStreak >= runsBeforeRepairOffer && skill.failureStreak > skill.repairOfferedStreak;
}

/**
 * The prompt that asks for a new way of doing a skill that keeps failing.
 *
 * The rules are part of the prompt and not only of the parser: the model is
 * told, in the same breath, that the fix may not reach for anything the user
 * has not switched on. Nothing here is a permission — a repaired skill is
 * still filtered and confirmed exactly like the spoken version.
 */
export function buildSkillRepairPrompt(skill: Skill, abilities: AbilitySettings): string {
  const recordedSteps = skill.seedActions.length
    ? describeActions(skill.seedActions)
    : "no starting steps were recorded";

  return [
    `A saved routine called "${skill.name}" keeps failing, so it needs a different way of being done.`,
    `What it is meant to reach: ${skill.goal}`,
    `The steps it started with: ${recordedSteps}`,
    skill.lastOutcomeNote ? `How the most recent run ended: ${skill.lastOutcomeNote}` : "",
    "Work out a way to reach the same aim that is more likely to work on this PC.",
    "Rules for the fix: keep the same intent; ask for nothing the user has not already switched on; never propose deleting or moving files, changing Windows settings, running commands, or anything that needs an administrator; prefer reaching the aim by name, address or a saved shortcut instead of guessing screen coordinates; keep it short.",
    "Reply with the new aim inside <task> tags, the first steps inside <actions> tags as a JSON array, and one short line of plain text saying what you changed and why.",
    buildActionProtocolInstructions(abilities),
  ].filter((line) => line.length > 0).join("\n\n");
}

export interface ParsedSkillRepair {
  goal: string;
  actions: UstaadAction[];
  explanation: string;
  /** Anything wrong with the proposed actions, kept so the panel can say so. */
  problems: string[];
}

/**
 * Reads a repair reply. The aim is what makes a repair usable, so a reply
 * without one is not a repair at all — the caller keeps the old skill instead
 * of saving half a fix.
 */
export function parseSkillRepairReply(modelResponseText: string): ParsedSkillRepair | null {
  const { spokenText, serializedActions } = splitSpokenTextFromActionBlock(modelResponseText);
  const { spokenText: remainingText, taskGoal } = splitTaskGoalFromResponse(spokenText);
  const repairedGoal = taskGoal?.trim();
  if (!repairedGoal) {
    return null;
  }

  const parsedActions = serializedActions
    ? parseUstaadActions(serializedActions)
    : { actions: [] as UstaadAction[], problems: [] as string[] };

  return {
    goal: repairedGoal.slice(0, 300),
    actions: parsedActions.actions.slice(0, maximumRepairStartingActions),
    explanation: remainingText.replace(/\s+/gu, " ").trim().slice(0, maximumExplanationLength),
    problems: parsedActions.problems,
  };
}
