import assert from "node:assert/strict";
import test from "node:test";
import {
  actionNeedsConfirmation,
  filterActionsByAbilities,
  getActionRequiredAbility,
  getActionRisk,
  parseModelResponse,
} from "../src/main/action-protocol";
import { defaultAbilitySettings } from "../src/main/soul-config";

test("spoken text and actions are separated, one action block per reply", () => {
  const parsedResponse = parseModelResponse(
    'sure, opening unity now. <actions>[{"type":"open_app","name":"unity"}]</actions>',
  );

  assert.equal(parsedResponse.spokenText, "sure, opening unity now.");
  assert.deepEqual(parsedResponse.actions, [{ type: "open_app", name: "unity" }]);
  assert.deepEqual(parsedResponse.problems, []);
});

test("a reply without actions keeps the words and reports no actions", () => {
  const parsedResponse = parseModelResponse("it is 24 degrees and cloudy.");

  assert.equal(parsedResponse.spokenText, "it is 24 degrees and cloudy.");
  assert.deepEqual(parsedResponse.actions, []);
  assert.deepEqual(parsedResponse.problems, []);
});

test("malformed actions become problems instead of running something unexpected", () => {
  const parsedResponse = parseModelResponse(
    'i will do that. <actions>[{"type":"open_app"},{"type":"teleport","where":"mars"}]</actions>',
  );

  assert.deepEqual(parsedResponse.actions, []);
  assert.equal(parsedResponse.problems.length, 2);
  assert.equal(parsedResponse.spokenText, "i will do that.");
});

test("risky desktop work asks first, reminders and memory never do", () => {
  assert.equal(getActionRisk("open_app"), "confirm");
  assert.equal(getActionRisk("type_text"), "confirm");
  assert.equal(getActionRisk("wallpaper"), "confirm");
  assert.equal(getActionRisk("todo_add"), "safe");
  assert.equal(getActionRisk("schedule_add"), "safe");
  assert.equal(getActionRisk("remember"), "safe");
  assert.equal(getActionRisk("timer_start"), "safe");
  assert.equal(getActionRisk("clipboard_transform"), "confirm");
  assert.equal(getActionRisk("snippet_insert"), "confirm");
  assert.equal(getActionRisk("snippet_save"), "safe");

  assert.equal(
    actionNeedsConfirmation({ type: "type_text", text: "hello" }, "risky", []),
    true,
  );
  assert.equal(
    actionNeedsConfirmation({ type: "todo_add", text: "call mom", dueAt: null }, "risky", []),
    false,
  );
  assert.equal(
    actionNeedsConfirmation({ type: "type_text", text: "hello" }, "never", []),
    false,
  );
  assert.equal(
    actionNeedsConfirmation({ type: "todo_add", text: "call mom", dueAt: null }, "all", []),
    true,
  );
  assert.equal(
    actionNeedsConfirmation({ type: "open_app", name: "unity" }, "risky", ["open_app"]),
    false,
  );
});

test("timers parse into a safe action, and nonsense durations are refused", () => {
  const parsedResponse = parseModelResponse(
    'setting it now. <actions>[{"type":"timer_start","durationMinutes":12,"label":"pasta"}]</actions>',
  );
  assert.deepEqual(parsedResponse.actions, [
    { type: "timer_start", durationMinutes: 12, label: "pasta" },
  ]);

  // A missing label still produces a usable timer; a zero duration does not.
  const withoutLabel = parseModelResponse(
    '<actions>[{"type":"timer_start","durationMinutes":5}]</actions>',
  );
  assert.deepEqual(withoutLabel.actions, [
    { type: "timer_start", durationMinutes: 5, label: "timer" },
  ]);

  const invalidDuration = parseModelResponse(
    '<actions>[{"type":"timer_start","durationMinutes":0}]</actions>',
  );
  assert.deepEqual(invalidDuration.actions, []);
  assert.equal(invalidDuration.problems.length, 1);
});

test("timers run freely while typing a snippet asks first", () => {
  assert.equal(actionNeedsConfirmation({ type: "timer_start", durationMinutes: 5, label: "pasta" }, "risky", []), false);
  assert.equal(actionNeedsConfirmation({ type: "timer_cancel", query: null }, "risky", []), false);
  assert.equal(actionNeedsConfirmation({ type: "snippet_save", name: "my address", text: "22 Baker Street" }, "risky", []), false);
  assert.equal(actionNeedsConfirmation({ type: "snippet_insert", name: "my address" }, "risky", []), true);
  assert.equal(
    actionNeedsConfirmation({ type: "clipboard_transform", operation: "summarize", targetLanguage: null }, "risky", []),
    true,
  );
  assert.equal(getActionRisk("snippet_insert"), "confirm");
  assert.equal(getActionRisk("timer_start"), "safe");
});

test("a reply can carry a task goal for Clickaa to finish on its own", () => {
  const parsedResponse = parseModelResponse(
    'opening youtube now. <task>play a video on youtube</task><actions>[{"type":"open_url","url":"https://youtube.com"}]</actions>',
  );

  assert.equal(parsedResponse.taskGoal, "play a video on youtube");
  assert.equal(parsedResponse.spokenText, "opening youtube now.");
  assert.deepEqual(parsedResponse.actions, [{ type: "open_url", url: "https://youtube.com" }]);

  // A reply that just answers something carries no goal, so nothing loops.
  const plainReply = parseModelResponse('here is the answer. <actions>[{"type":"notify","title":"hi","body":"there"}]</actions>');
  assert.equal(plainReply.taskGoal, null);

  // The goal never leaks into the spoken text, and stray plan blocks are dropped.
  const planReply = parseModelResponse('<plan>click the video</plan><task>get the video playing</task>done.');
  assert.equal(planReply.taskGoal, "get the video playing");
  assert.equal(planReply.spokenText.trim(), "done.");

  // A runaway goal is capped rather than turned into a paragraph.
  const longGoalReply = parseModelResponse(`<task>${"a".repeat(500)}</task>`);
  assert.equal(longGoalReply.taskGoal?.length, 300);
});

test("click_at and wait parse into safe, well-bound action objects", () => {
  const parsedResponse = parseModelResponse(
    '<actions>[{"type":"click_at","x":420,"y":310,"label":"the first video"},{"type":"wait","seconds":2}]</actions>',
  );
  assert.deepEqual(parsedResponse.actions, [
    { type: "click_at", x: 420, y: 310, screenNumber: null, label: "the first video" },
    { type: "wait", seconds: 2 },
  ]);

  // Coordinates given as words, an unnamed target, and an unbounded wait.
  const forgivingResponse = parseModelResponse(
    '<actions>[{"type":"click_at","x":"88","y":"12","screen":2},{"type":"wait","seconds":900}]</actions>',
  );
  assert.deepEqual(forgivingResponse.actions, [
    { type: "click_at", x: 88, y: 12, screenNumber: 2, label: "that spot" },
    // Waiting is capped so a model cannot park the task for a quarter of an hour.
    { type: "wait", seconds: 20 },
  ]);

  const brokenResponse = parseModelResponse(
    '<actions>[{"type":"click_at","x":-4,"y":10},{"type":"wait","seconds":0}]</actions>',
  );
  assert.deepEqual(brokenResponse.actions, []);
  assert.equal(brokenResponse.problems.length, 2);
});

test("clicking is confirmable and waiting is not", () => {
  assert.equal(getActionRequiredAbility("click_at"), "automation");
  assert.equal(getActionRequiredAbility("wait"), "automation");
  assert.equal(getActionRisk("click_at"), "confirm");
  assert.equal(getActionRisk("wait"), "safe");
  assert.equal(
    actionNeedsConfirmation({ type: "click_at", x: 1, y: 2, screenNumber: null, label: "the play button" }, "risky", []),
    true,
  );
  assert.equal(actionNeedsConfirmation({ type: "wait", seconds: 1 }, "risky", []), false);
});

test("a snip action parses, stays safe, and needs screen vision", () => {
  const parsedResponse = parseModelResponse(
    'sure. <actions>[{"type":"screenshot_region"}]</actions>',
  );
  assert.deepEqual(parsedResponse.actions, [{ type: "screenshot_region" }]);
  assert.equal(getActionRisk("screenshot_region"), "safe");
  assert.equal(getActionRequiredAbility("screenshot_region"), "screenVision");
  assert.equal(
    actionNeedsConfirmation({ type: "screenshot_region" }, "risky", []),
    false,
  );

  // An unrelated field is ignored rather than dropping the action.
  const withExtraField = parseModelResponse(
    '<actions>[{"type":"screenshot_region","note":"this area"}]</actions>',
  );
  assert.deepEqual(withExtraField.actions, [{ type: "screenshot_region" }]);
});

test("clipboard rewrites only accept the four operations clickaa knows", () => {
  const parsedResponse = parseModelResponse(
    '<actions>[{"type":"clipboard_transform","operation":"translate","targetLanguage":"urdu"}]</actions>',
  );
  assert.deepEqual(parsedResponse.actions, [
    { type: "clipboard_transform", operation: "translate", targetLanguage: "urdu" },
  ]);

  const unsupported = parseModelResponse(
    '<actions>[{"type":"clipboard_transform","operation":"make_poem"}]</actions>',
  );
  assert.deepEqual(unsupported.actions, []);
  assert.equal(unsupported.problems[0]?.includes("summarize"), true);
});

test("actions for switched-off abilities are dropped with the ability named", () => {
  const abilities = { ...defaultAbilitySettings, systemControl: false, toDoList: false };
  const { allowedActions, blockedActions } = filterActionsByAbilities(
    [
      { type: "volume", operation: "mute", level: null },
      { type: "todo_add", text: "call mom", dueAt: null },
      { type: "open_app", name: "unity" },
    ],
    abilities,
  );

  assert.deepEqual(allowedActions, [{ type: "open_app", name: "unity" }]);
  assert.deepEqual(
    blockedActions.map((blockedAction) => blockedAction.ability),
    ["systemControl", "toDoList"],
  );
});
