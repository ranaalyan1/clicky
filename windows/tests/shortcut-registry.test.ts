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

const sKeyCode = 31;

test("adding S to the talk chord hands the keys to the snip shortcut", () => {
  const stateMachine = createStateMachine();

  stateMachine.handleKeyDown(modifierKeyCodes.leftControl);
  assert.deepEqual(stateMachine.handleKeyDown(modifierKeyCodes.leftAlt), [
    { shortcutId: "talk", phase: "pressed" },
  ]);

  // The chord resolves on the S key: talk steps aside, snip takes over.
  assert.deepEqual(stateMachine.handleKeyDown(sKeyCode), [
    { shortcutId: "snip", phase: "pressed" },
    { shortcutId: "talk", phase: "released" },
  ]);
  assert.equal(stateMachine.isShortcutActive("snip"), true);
  assert.equal(stateMachine.isShortcutActive("talk"), false);
});

test("letting go of S does not restart the talk shortcut underneath", () => {
  const stateMachine = createStateMachine();

  stateMachine.handleKeyDown(modifierKeyCodes.leftControl);
  stateMachine.handleKeyDown(modifierKeyCodes.leftAlt);
  stateMachine.handleKeyDown(sKeyCode);

  assert.deepEqual(stateMachine.handleKeyUp(sKeyCode), [
    { shortcutId: "snip", phase: "released" },
  ]);
  // Ctrl+Alt is still held, and talk must stay quiet until the user starts over.
  assert.equal(stateMachine.isShortcutActive("talk"), false);

  stateMachine.handleKeyUp(modifierKeyCodes.leftAlt);
  stateMachine.handleKeyUp(modifierKeyCodes.leftControl);

  assert.deepEqual(stateMachine.handleKeyDown(modifierKeyCodes.leftControl), []);
  assert.deepEqual(stateMachine.handleKeyDown(modifierKeyCodes.leftAlt), [
    { shortcutId: "talk", phase: "pressed" },
  ]);
});

test("a snip chord never blocks the circle shortcut or dictation", () => {
  const stateMachine = createStateMachine("ctrl+shift+space");

  // Ctrl+Shift alone still means circle.
  stateMachine.handleKeyDown(modifierKeyCodes.leftControl);
  assert.deepEqual(stateMachine.handleKeyDown(modifierKeyCodes.leftShift), [
    { shortcutId: "circle", phase: "pressed" },
  ]);

  stateMachine.handleKeyUp(modifierKeyCodes.leftShift);
  stateMachine.handleKeyUp(modifierKeyCodes.leftControl);

  // Ctrl+Shift+Space is still dictation, untouched by the snip chord.
  stateMachine.handleKeyDown(modifierKeyCodes.leftControl);
  stateMachine.handleKeyDown(modifierKeyCodes.leftShift);
  assert.deepEqual(stateMachine.handleKeyDown(spaceKeyCode), [
    { shortcutId: "dictation", phase: "pressed" },
  ]);
});

test("reset clears a superseded shortcut so the next chord behaves", () => {
  const stateMachine = createStateMachine();

  stateMachine.handleKeyDown(modifierKeyCodes.leftControl);
  stateMachine.handleKeyDown(modifierKeyCodes.leftAlt);
  stateMachine.handleKeyDown(sKeyCode);

  assert.deepEqual(stateMachine.reset(), [
    { shortcutId: "snip", phase: "released" },
  ]);

  assert.deepEqual(stateMachine.handleKeyDown(modifierKeyCodes.leftControl), []);
  assert.deepEqual(stateMachine.handleKeyDown(modifierKeyCodes.leftAlt), [
    { shortcutId: "talk", phase: "pressed" },
  ]);
});

test("only the shortcuts a chord declares are ever taken from it", () => {
  const definitions = buildShortcutDefinitions("ctrl+windows");
  const snipShortcut = definitions.find((definition) => definition.id === "snip")!;

  // The snip chord borrows the talk keys and nothing else: holding Ctrl+Shift to
  // circle must never be cancelled by an accidental keypress.
  assert.deepEqual(snipShortcut.supersedes, ["talk"]);
  assert.deepEqual(
    definitions.filter((definition) => definition.supersedes).map((definition) => definition.id),
    ["snip"],
  );

  // Every declared id has to be a real shortcut.
  const shortcutIds = definitions.map((definition) => definition.id);
  for (const definition of definitions) {
    for (const supersededShortcutId of definition.supersedes ?? []) {
      assert.equal(shortcutIds.includes(supersededShortcutId), true);
    }
  }
});
