import assert from "node:assert/strict";
import test from "node:test";
import {
  actionNeedsConfirmation,
  filterActionsByAbilities,
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
