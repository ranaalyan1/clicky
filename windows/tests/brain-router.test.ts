import assert from "node:assert/strict";
import test from "node:test";
import { BrainRouter } from "../src/main/brain-router";
import { defaultUstaadUserConfig, sanitizeStoredConfig, normalizeGeminiApiKey } from "../src/main/config-store";

const brainRouter = new BrainRouter();

test("a gemini key alone is enough, and a worker url still works on its own", () => {
  assert.equal(brainRouter.resolveActiveProvider(defaultUstaadUserConfig), null);
  assert.equal(brainRouter.isConfigured(defaultUstaadUserConfig), false);
  assert.equal(brainRouter.configurationHint(defaultUstaadUserConfig).length > 0, true);

  const geminiOnlyConfig = sanitizeStoredConfig({
    ...defaultUstaadUserConfig,
    brainProvider: "gemini",
    geminiApiKey: "AIzaSyUstaadTestKey0000000000000000",
  });
  assert.equal(brainRouter.resolveActiveProvider(geminiOnlyConfig), "gemini");
  assert.equal(brainRouter.isConfigured(geminiOnlyConfig), true);
  assert.equal(brainRouter.configurationHint(geminiOnlyConfig), "");
  assert.equal(brainRouter.getBrainLabel(geminiOnlyConfig), "Gemini Flash");

  const workerOnlyConfig = sanitizeStoredConfig({
    ...defaultUstaadUserConfig,
    brainProvider: "gemini",
    workerBaseUrl: "https://ustaad.example.workers.dev",
  });
  assert.equal(brainRouter.resolveActiveProvider(workerOnlyConfig), "worker");
  assert.equal(brainRouter.isConfigured(workerOnlyConfig), true);
});

test("picking gemini uses the key and picking pro changes the label", () => {
  const proConfig = sanitizeStoredConfig({
    ...defaultUstaadUserConfig,
    brainProvider: "gemini",
    geminiApiKey: "AIzaSyUstaadTestKey0000000000000000",
    geminiChatModel: "gemini-2.5-pro",
  });

  assert.equal(brainRouter.getBrainLabel(proConfig), "Gemini Pro");
  assert.equal(brainRouter.resolveActiveProvider(proConfig), "gemini");
});

test("speech falls back to the offline windows voice instead of failing", () => {
  const automaticWithGeminiKey = sanitizeStoredConfig({
    ...defaultUstaadUserConfig,
    geminiApiKey: "AIzaSyUstaadTestKey0000000000000000",
  });
  assert.equal(brainRouter.resolveSpeechProvider(automaticWithGeminiKey), "gemini");

  const elevenLabsWithoutWorker = sanitizeStoredConfig({
    ...defaultUstaadUserConfig,
    soul: { ...defaultUstaadUserConfig.soul, speechProvider: "elevenlabs" },
  });
  assert.equal(brainRouter.resolveSpeechProvider(elevenLabsWithoutWorker), "windows");

  const geminiVoiceWithoutKey = sanitizeStoredConfig({
    ...defaultUstaadUserConfig,
    soul: { ...defaultUstaadUserConfig.soul, speechProvider: "gemini" },
  });
  assert.equal(brainRouter.resolveSpeechProvider(geminiVoiceWithoutKey), "windows");

  const automaticWithWorkerOnly = sanitizeStoredConfig({
    ...defaultUstaadUserConfig,
    workerBaseUrl: "https://ustaad.example.workers.dev",
  });
  assert.equal(brainRouter.resolveSpeechProvider(automaticWithWorkerOnly), "elevenlabs");
});

test("pasted keys are cleaned up and obviously wrong ones are refused", () => {
  assert.equal(
    normalizeGeminiApiKey('  "AIzaSyUstaadTestKey0000000000000000"\n'),
    "AIzaSyUstaadTestKey0000000000000000",
  );
  assert.equal(normalizeGeminiApiKey("   "), "");
  assert.throws(() => normalizeGeminiApiKey("too-short"), /Google AI Studio/);
  assert.throws(() => normalizeGeminiApiKey("AIza key with spaces 0000000000"), /Google AI Studio/);
});
