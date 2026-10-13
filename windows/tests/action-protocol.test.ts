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
