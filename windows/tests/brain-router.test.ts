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

test("a brain on this pc is chosen on purpose, and it never pretends to be the cloud", async () => {
  const localConfig = sanitizeStoredConfig({
    ...defaultUstaadUserConfig,
    brainProvider: "local",
    localBrainBaseUrl: "127.0.0.1:11434",
    localBrainModel: "qwen2.5:3b",
  });

  assert.equal(brainRouter.resolveActiveProvider(localConfig), "local");
  assert.equal(brainRouter.isConfigured(localConfig), true);
  assert.equal(brainRouter.configurationHint(localConfig), "");
  assert.equal(brainRouter.getBrainLabel(localConfig), "on this pc (qwen2.5:3b)");

  // Speech still lands on the offline windows voice rather than failing.
  assert.equal(brainRouter.resolveSpeechProvider(localConfig), "windows");

  // A local brain cannot hear, and says so instead of looking for a key.
  await assert.rejects(
    () => brainRouter.transcribeRecordedAudio(localConfig, Buffer.from("wav"), new AbortController().signal),
    /cannot hear/u,
  );

  // The address is still checked when the test button is pressed, including
  // the case the sanitizer would have replaced: an address on the internet.
  const publicAddressConfig = { ...localConfig, localBrainBaseUrl: "https://api.example.com" };
  const testResult = await brainRouter.testConnection(publicAddressConfig);
  assert.equal(testResult.ok, false);
  assert.equal(testResult.message.includes("own network"), true);
});

test("offline mode is a promise: the local brain answers, and the cloud is not asked", async () => {
  const offlineConfig = sanitizeStoredConfig({
    ...defaultUstaadUserConfig,
    brainProvider: "gemini",
    geminiApiKey: "AIzaSyUstaadTestKey0000000000000000",
    offlineMode: true,
  });

  // The gemini key is still on disk, and is not used for anything.
  assert.equal(brainRouter.resolveActiveProvider(offlineConfig), "local");
  assert.equal(brainRouter.getBrainLabel(offlineConfig), `on this pc (${offlineConfig.localBrainModel})`);
  assert.equal(brainRouter.resolveSpeechProvider(offlineConfig), "windows");

  await assert.rejects(
    () => brainRouter.drawPicture(offlineConfig, "a panda"),
    /offline mode is on/u,
  );
  await assert.rejects(
    () => brainRouter.transcribeRecordedAudio(offlineConfig, Buffer.from("wav"), new AbortController().signal),
    /offline mode is on/u,
  );

  // Nothing to tidy dictated words with: they are pasted as they were spoken.
  const untouched = await brainRouter.cleanDictationTranscript(
    { ...offlineConfig, localBrainBaseUrl: "" },
    "so um i think we should ship it",
    new AbortController().signal,
  );
  assert.equal(untouched, "so um i think we should ship it");

  // And with no model on this pc, offline mode says exactly that.
  const withoutAnyBrain = { ...offlineConfig, localBrainBaseUrl: "" };
  assert.equal(brainRouter.resolveActiveProvider(withoutAnyBrain), null);
  assert.equal(brainRouter.isConfigured(withoutAnyBrain), false);
  assert.equal(brainRouter.getBrainLabel(withoutAnyBrain), "offline (no local brain yet)");
  assert.equal(brainRouter.configurationHint(withoutAnyBrain).includes("Offline mode is on"), true);
});
