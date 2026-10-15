import assert from "node:assert/strict";
import test from "node:test";
import { ustaadWakeWordScript } from "../src/main/wake-word-script";
import { ustaadWindowsBridgeScript } from "../src/main/windows-bridge-script";

/**
 * Both helper scripts are written to disk as UTF-8 with a BOM, but Windows
 * PowerShell 5.1 falls back to ANSI when it does not like what it finds. A
 * stray smart quote or non-breaking space would silently break a user's
 * install, so the scripts stay ASCII-only on purpose and this test holds that.
 */
test("the helper scripts stay ASCII-only", () => {
  for (const [scriptName, scriptSource] of [
    ["the Windows bridge", ustaadWindowsBridgeScript],
    ["the wake word listener", ustaadWakeWordScript],
  ] as const) {
    for (const [index, character] of [...scriptSource].entries()) {
      assert.equal(
        character.charCodeAt(0) <= 127,
        true,
        `${scriptName} has a non-ASCII character at position ${index}: ${JSON.stringify(character)}`,
      );
    }
  }
});

test("the wake word listener keeps its four event kinds", () => {
  // These exact literals are what the parser in wake-word-listener.ts keys on,
  // so the two files have to agree on all four of them.
  for (const eventMarker of ["'READY'", "'WAKE '", "'UNAVAILABLE '", "'ERROR '"]) {
    assert.equal(
      ustaadWakeWordScript.includes(eventMarker),
      true,
      `the wake word listener no longer emits ${eventMarker}`,
    );
  }
});

test("the wake grammar only ever hears the wake phrases", () => {
  // The phrases the recognizer is allowed to hear at all.
  for (const wakePhrase of ["'hitodama'", "'hey hitodama'", "'ok hitodama'"]) {
    assert.equal(ustaadWakeWordScript.includes(wakePhrase), true, `missing grammar phrase ${wakePhrase}`);
  }

  // Easily confused phrases need a higher confidence than the wake word itself.
  const defaultThresholdMatch = /\$defaultThreshold = ([\d.]+)/u.exec(ustaadWakeWordScript);
  const strictThresholdMatch = /\$strictThreshold = ([\d.]+)/u.exec(ustaadWakeWordScript);
  assert.ok(defaultThresholdMatch, "the listener has lost its default confidence threshold");
  assert.ok(strictThresholdMatch, "the listener has lost its strict confidence threshold");

  const defaultThreshold = Number.parseFloat(defaultThresholdMatch[1]!);
  const strictThreshold = Number.parseFloat(strictThresholdMatch[1]!);
  assert.equal(defaultThreshold > 0 && defaultThreshold < 1, true);
  assert.equal(strictThreshold > defaultThreshold && strictThreshold < 1, true);

  // And the reason the strict list exists: those phrases hide inside typing.
  assert.equal(ustaadWakeWordScript.includes("$strictPhrases = @('click a', 'click ah')"), true);
});
