import assert from "node:assert/strict";
import test from "node:test";
import {
  buildShortcutDefinitions,
  dictationShortcutLabels,
  ModifierKeyCodes,
  ModifierShortcutStateMachine,
} from "../src/main/shortcut-registry";

const modifierKeyCodes: ModifierKeyCodes = {
  leftControl: 29,
  rightControl: 3613,
  leftAlt: 56,
  rightAlt: 3640,
  leftWindows: 3675,
  rightWindows: 3676,
  leftShift: 42,
  rightShift: 54,
};

const spaceKeyCode = 57;
const capsLockKeyCode = 58;

function createStateMachine(dictationShortcut: "ctrl+windows" | "ctrl+shift+space" | "capslock" = "ctrl+windows") {
  return new ModifierShortcutStateMachine(
    buildShortcutDefinitions(dictationShortcut),
    modifierKeyCodes,
  );
}

test("holding left control and left alt starts and stops the talk shortcut", () => {
  const stateMachine = createStateMachine();

  assert.deepEqual(stateMachine.handleKeyDown(modifierKeyCodes.leftControl), []);
  assert.deepEqual(stateMachine.handleKeyDown(modifierKeyCodes.leftAlt), [
    { shortcutId: "talk", phase: "pressed" },
  ]);
  assert.equal(stateMachine.isShortcutActive("talk"), true);

  assert.deepEqual(stateMachine.handleKeyUp(modifierKeyCodes.leftAlt), [
    { shortcutId: "talk", phase: "released" },
  ]);
  assert.equal(stateMachine.isShortcutActive("talk"), false);
});

test("AltGr (right alt with control) never triggers push-to-talk", () => {
  const stateMachine = createStateMachine();

  stateMachine.handleKeyDown(modifierKeyCodes.leftControl);
  assert.deepEqual(stateMachine.handleKeyDown(modifierKeyCodes.rightAlt), []);

  // Typing an accented character also presses an extra key such as "s".
  assert.deepEqual(stateMachine.handleKeyDown(31), []);
  assert.equal(stateMachine.isShortcutActive("talk"), false);
});

test("control plus shift starts circling without a fourth key", () => {
  const stateMachine = createStateMachine();

  stateMachine.handleKeyDown(modifierKeyCodes.rightControl);
  assert.deepEqual(stateMachine.handleKeyDown(modifierKeyCodes.leftShift), [
    { shortcutId: "circle", phase: "pressed" },
  ]);
});

test("control plus windows starts dictation and the shortcut is configurable", () => {
  const windowsDictationMachine = createStateMachine("ctrl+windows");
  windowsDictationMachine.handleKeyDown(modifierKeyCodes.leftControl);
  assert.deepEqual(windowsDictationMachine.handleKeyDown(modifierKeyCodes.leftWindows), [
    { shortcutId: "dictation", phase: "pressed" },
  ]);

  const spaceDictationMachine = createStateMachine("ctrl+shift+space");
  spaceDictationMachine.handleKeyDown(modifierKeyCodes.leftControl);
  spaceDictationMachine.handleKeyDown(modifierKeyCodes.leftShift);
  assert.deepEqual(spaceDictationMachine.handleKeyDown(spaceKeyCode), [
    { shortcutId: "dictation", phase: "pressed" },
  ]);

  const capsLockDictationMachine = createStateMachine("capslock");
  assert.deepEqual(capsLockDictationMachine.handleKeyDown(capsLockKeyCode), [
    { shortcutId: "dictation", phase: "pressed" },
  ]);

  assert.equal(dictationShortcutLabels["ctrl+windows"], "Ctrl + Windows");
  assert.equal(dictationShortcutLabels.capslock, "Caps Lock");
});

test("shortcuts are mutually exclusive and reset releases whatever is held", () => {
  const stateMachine = createStateMachine();

  stateMachine.handleKeyDown(modifierKeyCodes.leftControl);
  stateMachine.handleKeyDown(modifierKeyCodes.leftAlt);

  // Shift with Alt still down cannot start circling; it only cancels talking.
  assert.deepEqual(stateMachine.handleKeyDown(modifierKeyCodes.leftShift), [
    { shortcutId: "talk", phase: "released" },
  ]);

  assert.deepEqual(stateMachine.handleKeyUp(modifierKeyCodes.leftAlt), [
    { shortcutId: "circle", phase: "pressed" },
  ]);
  assert.equal(stateMachine.isShortcutActive("circle"), true);

  assert.deepEqual(stateMachine.reset(), [{ shortcutId: "circle", phase: "released" }]);
  assert.equal(stateMachine.isShortcutActive("circle"), false);
});
