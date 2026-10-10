import assert from "node:assert/strict";
import test from "node:test";
import { ModifierPushToTalkStateMachine } from "../src/main/shortcut-state";

const keys = {
  leftControl: 29,
  rightControl: 3613,
  leftAlt: 56,
  rightAlt: 3640,
};

test("modifier state machine emits one press and one release", () => {
  const shortcut = new ModifierPushToTalkStateMachine(keys);
  assert.equal(shortcut.handleKeyDown(keys.leftControl), null);
  assert.equal(shortcut.handleKeyDown(keys.leftAlt), "pressed");
  assert.equal(shortcut.handleKeyDown(keys.leftAlt), null);
  assert.equal(shortcut.handleKeyUp(keys.leftControl), "released");
  assert.equal(shortcut.handleKeyUp(keys.leftAlt), null);
});

test("right control works but AltGr does not trigger push-to-talk", () => {
  const shortcut = new ModifierPushToTalkStateMachine(keys);
  assert.equal(shortcut.handleKeyDown(keys.rightControl), null);
  assert.equal(shortcut.handleKeyDown(keys.leftAlt), "pressed");
  assert.equal(shortcut.reset(), "released");

  assert.equal(shortcut.handleKeyDown(keys.leftControl), null);
  assert.equal(shortcut.handleKeyDown(keys.rightAlt), null);
});
