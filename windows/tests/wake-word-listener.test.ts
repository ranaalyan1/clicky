import assert from "node:assert/strict";
import test from "node:test";
import { parseWakeWordListenerLine } from "../src/main/wake-word-listener";

test("a wake line carries its confidence and the phrase that fired", () => {
  assert.deepEqual(parseWakeWordListenerLine("WAKE 87 clickaa"), {
    kind: "wake",
    detection: { confidence: 87, phrase: "clickaa" },
  });

  // Multi-word phrases survive intact, and confidences are clamped to 0-100.
  assert.deepEqual(parseWakeWordListenerLine("WAKE 143 hey clickaa"), {
    kind: "wake",
    detection: { confidence: 100, phrase: "hey clickaa" },
  });
});

test("malformed wake lines are ignored rather than guessed at", () => {
  assert.equal(parseWakeWordListenerLine("WAKE"), null);
  assert.equal(parseWakeWordListenerLine("WAKE 87"), null);
  assert.equal(parseWakeWordListenerLine("WAKE high clickaa"), null);
  assert.equal(parseWakeWordListenerLine(""), null);
  assert.equal(parseWakeWordListenerLine("   "), null);
});

test("the listener reports readiness, unavailability and errors distinctly", () => {
  assert.deepEqual(parseWakeWordListenerLine("READY"), { kind: "ready" });
  assert.deepEqual(
    parseWakeWordListenerLine("UNAVAILABLE no offline speech recognizer is installed for this windows language"),
    {
      kind: "unavailable",
      message: "no offline speech recognizer is installed for this windows language",
    },
  );
  assert.deepEqual(parseWakeWordListenerLine("ERROR the microphone was unplugged"), {
    kind: "error",
    message: "the microphone was unplugged",
  });
});

test("unrecognised output never looks like the user calling clickaa's name", () => {
  // PowerShell warnings, progress noise and stray text must all be ignored.
  assert.equal(parseWakeWordListenerLine("WARNING: something happened"), null);
  assert.equal(parseWakeWordListenerLine("Recognizing..."), null);
  assert.equal(parseWakeWordListenerLine("WAKEUP 90 clickaa"), null);
  assert.equal(parseWakeWordListenerLine("clickaa"), null);
});

test("readiness with an empty message still reads as a clean start", () => {
  assert.deepEqual(parseWakeWordListenerLine("UNAVAILABLE"), {
    kind: "unavailable",
    message: "the offline listener could not start",
  });
  assert.deepEqual(parseWakeWordListenerLine("ERROR"), {
    kind: "error",
    message: "the offline listener stopped unexpectedly",
  });
});
