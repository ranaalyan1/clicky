import assert from "node:assert/strict";
import test from "node:test";
import { BrainRouter } from "../src/main/brain-router";
import { defaultClickaaUserConfig, sanitizeStoredConfig, normalizeGeminiApiKey } from "../src/main/config-store";

const brainRouter = new BrainRouter();

test("a gemini key alone is enough, and a worker url still works on its own", () => {
  assert.equal(brainRouter.resolveActiveProvider(defaultClickaaUserConfig), null);
  assert.equal(brainRouter.isConfigured(defaultClickaaUserConfig), false);
  assert.equal(brainRouter.configurationHint(defaultClickaaUserConfig).length > 0, true);

  const geminiOnlyConfig = sanitizeStoredConfig({
    ...defaultClickaaUserConfig,
    brainProvider: "gemini",
    geminiApiKey: "AIzaSyClickaaTestKey0000000000000000",
  });
  assert.equal(brainRouter.resolveActiveProvider(geminiOnlyConfig), "gemini");
  assert.equal(brainRouter.isConfigured(geminiOnlyConfig), true);
  assert.equal(brainRouter.configurationHint(geminiOnlyConfig), "");
  assert.equal(brainRouter.getBrainLabel(geminiOnlyConfig), "Gemini Flash");

  const workerOnlyConfig = sanitizeStoredConfig({
    ...defaultClickaaUserConfig,
    brainProvider: "gemini",
    workerBaseUrl: "https://clickaa.example.workers.dev",
  });
  assert.equal(brainRouter.resolveActiveProvider(workerOnlyConfig), "worker");
  assert.equal(brainRouter.isConfigured(workerOnlyConfig), true);
});

test("picking gemini uses the key and picking pro changes the label", () => {
  const proConfig = sanitizeStoredConfig({
    ...defaultClickaaUserConfig,
    brainProvider: "gemini",
    geminiApiKey: "AIzaSyClickaaTestKey0000000000000000",
    geminiChatModel: "gemini-2.5-pro",
  });

  assert.equal(brainRouter.getBrainLabel(proConfig), "Gemini Pro");
  assert.equal(brainRouter.resolveActiveProvider(proConfig), "gemini");
});

test("speech falls back to the offline windows voice instead of failing", () => {
  const automaticWithGeminiKey = sanitizeStoredConfig({
    ...defaultClickaaUserConfig,
    geminiApiKey: "AIzaSyClickaaTestKey0000000000000000",
  });
  assert.equal(brainRouter.resolveSpeechProvider(automaticWithGeminiKey), "gemini");

  const elevenLabsWithoutWorker = sanitizeStoredConfig({
    ...defaultClickaaUserConfig,
    soul: { ...defaultClickaaUserConfig.soul, speechProvider: "elevenlabs" },
  });
  assert.equal(brainRouter.resolveSpeechProvider(elevenLabsWithoutWorker), "windows");

  const geminiVoiceWithoutKey = sanitizeStoredConfig({
    ...defaultClickaaUserConfig,
    soul: { ...defaultClickaaUserConfig.soul, speechProvider: "gemini" },
  });
  assert.equal(brainRouter.resolveSpeechProvider(geminiVoiceWithoutKey), "windows");

  const automaticWithWorkerOnly = sanitizeStoredConfig({
    ...defaultClickaaUserConfig,
    workerBaseUrl: "https://clickaa.example.workers.dev",
  });
  assert.equal(brainRouter.resolveSpeechProvider(automaticWithWorkerOnly), "elevenlabs");
});

test("pasted keys are cleaned up and obviously wrong ones are refused", () => {
  assert.equal(
    normalizeGeminiApiKey('  "AIzaSyClickaaTestKey0000000000000000"\n'),
    "AIzaSyClickaaTestKey0000000000000000",
  );
  assert.equal(normalizeGeminiApiKey("   "), "");
  assert.throws(() => normalizeGeminiApiKey("too-short"), /Google AI Studio/);
  assert.throws(() => normalizeGeminiApiKey("AIza key with spaces 0000000000"), /Google AI Studio/);
});
