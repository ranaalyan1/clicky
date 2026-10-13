import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDictationCleanupUserPrompt,
  buildScheduledTaskPrompt,
  shouldSkipDictationCleanup,
  stripDictationCleanupWrappers,
} from "../src/main/dictation-prompts";

test("very short dictation is typed as spoken instead of sent for cleanup", () => {
  assert.equal(shouldSkipDictationCleanup("yes"), true);
  assert.equal(shouldSkipDictationCleanup("sounds good"), true);
  assert.equal(shouldSkipDictationCleanup("send the file to ahmed please"), false);
});

test("the cleanup prompt names the assistant and keeps the user's own guidance", () => {
  const cleanupPrompt = buildDictationCleanupUserPrompt({
    rawTranscript: "um so i think we should uh ship it friday",
    assistantName: "buddy",
    customInstructions: "never add exclamation marks",
  });

  assert.equal(cleanupPrompt.includes("the assistant is called buddy"), true);
  assert.equal(cleanupPrompt.includes("never add exclamation marks"), true);
  assert.equal(cleanupPrompt.includes("um so i think we should uh ship it friday"), true);
});

test("quotes, smart quotes and announcements are stripped from cleaned text", () => {
  assert.equal(stripDictationCleanupWrappers('"ship it friday."'), "ship it friday.");
  assert.equal(stripDictationCleanupWrappers("“ship it friday.”"), "ship it friday.");
  assert.equal(stripDictationCleanupWrappers("here is the cleaned text: ship it friday."), "ship it friday.");
  assert.equal(stripDictationCleanupWrappers("ship it friday."), "ship it friday.");
});

test("scheduled task prompts tell the model it is running unattended", () => {
  const scheduledPrompt = buildScheduledTaskPrompt("morning briefing", "open unity and spotify");
  assert.equal(scheduledPrompt.includes("morning briefing"), true);
  assert.equal(scheduledPrompt.includes("open unity and spotify"), true);
  assert.equal(scheduledPrompt.includes("unattended") || scheduledPrompt.includes("scheduled task"), true);
});
