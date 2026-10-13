import assert from "node:assert/strict";
import test from "node:test";
import {
  abilityDefinitions,
  defaultAbilitySettings,
  defaultSoulSettings,
  personalityPresets,
  resolvePersonalityInstructions,
  sanitizeAbilitySettings,
  sanitizeAutoApprovedActionTypes,
  sanitizeConfirmationMode,
  sanitizeSoulSettings,
} from "../src/main/soul-config";

test("every ability is enabled by default and unknown stored values are ignored", () => {
  assert.equal(abilityDefinitions.length, 12);
  for (const abilityDefinition of abilityDefinitions) {
    assert.equal(defaultAbilitySettings[abilityDefinition.id], true, abilityDefinition.id);
  }

  const sanitizedAbilities = sanitizeAbilitySettings({ memory: false, teleportation: false });
  assert.equal(sanitizedAbilities.memory, false);
  assert.equal(sanitizedAbilities.screenVision, true);
  assert.equal("teleportation" in sanitizedAbilities, false);
});

test("soul settings keep the companion defaults and reject nonsense", () => {
  assert.equal(defaultSoulSettings.assistantName, "clickaa");
  assert.equal(defaultSoulSettings.personalityPreset, "companion");
  assert.equal(defaultSoulSettings.speechProvider, "auto");
  assert.equal(personalityPresets.some((personalityPreset) => personalityPreset.id === "focused"), true);

  const sanitizedSoul = sanitizeSoulSettings({
    assistantName: "   ",
    personalityPreset: "wizard",
    speechProvider: "nonsense",
    geminiVoiceName: "kore",
    windowsSpeechRate: 12,
    responseLength: "huge",
  });

  assert.equal(sanitizedSoul.assistantName, defaultSoulSettings.assistantName);
  assert.equal(sanitizedSoul.personalityPreset, defaultSoulSettings.personalityPreset);
  assert.equal(sanitizedSoul.speechProvider, "auto");
  assert.equal(sanitizedSoul.geminiVoiceName, "Kore");
  assert.equal(sanitizedSoul.windowsSpeechRate, 2);
  assert.equal(sanitizedSoul.responseLength, defaultSoulSettings.responseLength);
});

test("confirmation mode and pre-approved actions are sanitized to known values", () => {
  assert.equal(sanitizeConfirmationMode(undefined), "risky");
  assert.equal(sanitizeConfirmationMode("never"), "never");
  assert.equal(sanitizeConfirmationMode("sometimes"), "risky");

  assert.deepEqual(sanitizeAutoApprovedActionTypes(["open_app", "teleport", "open_app"]), ["open_app"]);
  assert.deepEqual(sanitizeAutoApprovedActionTypes("open_app"), []);
});

test("a custom personality falls back to the user's own instructions", () => {
  const instructions = resolvePersonalityInstructions({
    ...defaultSoulSettings,
    personalityPreset: "custom",
    customInstructions: "always answer in one sentence",
  });

  assert.equal(instructions.includes("always answer in one sentence"), true);
});
