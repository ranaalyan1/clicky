import assert from "node:assert/strict";
import test from "node:test";
import { defaultAbilitySettings } from "../src/main/soul-config";
import {
  buildSkillRepairPrompt,
  isSkillFailure,
  parseSkillRepairReply,
  runsBeforeRepairOffer,
  shouldOfferSkillRepair,
} from "../src/main/skill-repair";
import { Skill } from "../src/shared/contracts";

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "skill-1",
    name: "morning videos",
    goal: "play a video on youtube",
    seedActions: [{ type: "open_url", url: "https://youtube.com" }],
    createdAtIso: "2026-10-01T08:00:00.000Z",
    runCount: 3,
    lastRunAtIso: "2026-10-14T08:00:00.000Z",
    lastOutcome: "gave_up",
    lastOutcomeNote: "the video never started",
    failureStreak: 2,
    repairOfferedStreak: 0,
    repairCount: 0,
    repairedAtIso: null,
    ...overrides,
  };
}

test("a run the user stopped is not a failure", () => {
  assert.equal(isSkillFailure("completed"), false);
  assert.equal(isSkillFailure("stopped"), false);
  assert.equal(isSkillFailure("gave_up"), true);
  assert.equal(isSkillFailure("ran_out_of_steps"), true);
  assert.equal(isSkillFailure("ran_out_of_time"), true);
  assert.equal(isSkillFailure("failed"), true);
});

test("a repair is offered after two failures, and not again for the same streak", () => {
  assert.equal(runsBeforeRepairOffer, 2);
  assert.equal(shouldOfferSkillRepair(skill({ failureStreak: 1 })), false);
  assert.equal(shouldOfferSkillRepair(skill({ failureStreak: 2 })), true);

  // Offered at two, declined: the same streak must not ask again.
  assert.equal(shouldOfferSkillRepair(skill({ failureStreak: 2, repairOfferedStreak: 2 })), false);
  // But two more failures are a new question.
  assert.equal(shouldOfferSkillRepair(skill({ failureStreak: 4, repairOfferedStreak: 2 })), true);

  // A skill that has just worked is never offered a repair.
  assert.equal(shouldOfferSkillRepair(skill({ failureStreak: 0, lastOutcome: "completed" })), false);
});

test("the repair prompt carries the failure and the rules a fix must keep", () => {
  const prompt = buildSkillRepairPrompt(skill(), defaultAbilitySettings);

  assert.match(prompt, /"morning videos"/u);
  assert.match(prompt, /play a video on youtube/u);
  assert.match(prompt, /the video never started/u);
  assert.match(prompt, /open_url/u);
  assert.match(prompt, /nothing the user has not already switched on/u);
  assert.match(prompt, /never propose deleting or moving files/u);
  assert.match(prompt, /<task>/u);
  assert.match(prompt, /<actions>/u);
});

test("the repair prompt only teaches the actions the user has switched on", () => {
  const prompt = buildSkillRepairPrompt(skill(), {
    ...defaultAbilitySettings,
    automation: false,
    webSearch: false,
    systemControl: false,
    toDoList: false,
  });

  // No bullet for anything switched off, so a fix cannot be written against an
  // ability the user has not granted. (A switched-on routine example may still
  // *mention* one inside a routine's own steps; that is an example, not a grant.)
  for (const actionBullet of ["- open_app:", "- open_url:", "- search_web:", "- volume:", "- todo_add:"]) {
    assert.equal(prompt.includes(actionBullet), false, actionBullet);
  }
  assert.equal(prompt.includes("- routine_add:"), true);
});

test("a repair reply is read into an aim, steps and a reason", () => {
  const parsedRepair = parseSkillRepairReply(
    "Searching YouTube directly is more reliable than clicking around the home page.\n"
    + "<task>search youtube for a playlist and play the first result</task>\n"
    + "<actions>[{\"type\":\"search_web\",\"query\":\"playlist\",\"target\":\"youtube\"}]</actions>",
  );

  assert.ok(parsedRepair);
  assert.equal(parsedRepair.goal, "search youtube for a playlist and play the first result");
  assert.equal(parsedRepair.actions.length, 1);
  assert.equal(parsedRepair.actions[0]?.type, "search_web");
  assert.match(parsedRepair.explanation, /more reliable than clicking around/u);
  assert.deepEqual(parsedRepair.problems, []);
});

test("a reply without a new aim is not a repair", () => {
  assert.equal(parseSkillRepairReply("I could not think of anything better."), null);
  assert.equal(parseSkillRepairReply("<task>   </task>"), null);
});

test("a broken action block is reported instead of saved as steps", () => {
  const parsedRepair = parseSkillRepairReply(
    "Try the search box instead.\n<task>search for the song</task>\n<actions>[{\"type\":\"teleport\"}]</actions>",
  );

  assert.ok(parsedRepair);
  assert.equal(parsedRepair.goal, "search for the song");
  assert.equal(parsedRepair.actions.length, 0);
  assert.equal(parsedRepair.problems.length > 0, true);
});

test("a repair may not smuggle in more starting steps than a skill may hold", () => {
  const manyActions = JSON.stringify(
    Array.from({ length: 20 }, (_, index) => ({ type: "open_url", url: `https://example.com/${index}` })),
  );
  const parsedRepair = parseSkillRepairReply(`<task>open everything</task><actions>${manyActions}</actions>`);

  assert.ok(parsedRepair);
  assert.equal(parsedRepair.actions.length, 12);
});
