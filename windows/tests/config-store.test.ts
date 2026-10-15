import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  UstaadConfigStore,
  defaultUstaadUserConfig,
  normalizeWorkerBaseUrl,
  sanitizeStoredConfig,
} from "../src/main/config-store";

test("normalizeWorkerBaseUrl accepts secure production URLs and local HTTP", () => {
  assert.equal(
    normalizeWorkerBaseUrl("  https://ustaad.example.workers.dev///  "),
    "https://ustaad.example.workers.dev",
  );
  assert.equal(normalizeWorkerBaseUrl("http://localhost:8787/"), "http://localhost:8787");
});

test("normalizeWorkerBaseUrl rejects insecure remote and credentialed URLs", () => {
  assert.throws(() => normalizeWorkerBaseUrl("http://example.com"), /HTTPS/);
  assert.throws(() => normalizeWorkerBaseUrl("https://user:secret@example.com"), /username/);
  assert.throws(() => normalizeWorkerBaseUrl("not a url"), /valid Worker URL/);
});

test("UstaadConfigStore persists updates and sanitizes corrupt files", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ustaad-config-test-"));
  const configPath = join(temporaryDirectory, "settings.json");

  try {
    const configStore = new UstaadConfigStore(configPath);
    assert.deepEqual(configStore.getConfig(), defaultUstaadUserConfig);

    configStore.updateConfig({
      workerBaseUrl: "https://example.workers.dev/",
      cursorEnabled: false,
    });
    const savedPayload = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.equal(savedPayload.workerBaseUrl, "https://example.workers.dev");
    assert.equal(savedPayload.cursorEnabled, false);

    const reloadedStore = new UstaadConfigStore(configPath);
    assert.equal(reloadedStore.getConfig().cursorEnabled, false);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("the local brain keeps an address on this machine and nothing that points at the internet", () => {
  const storedConfig = sanitizeStoredConfig({
    ...defaultUstaadUserConfig,
    brainProvider: "local",
    localBrainBaseUrl: "localhost:1234/v1",
    localBrainModel: "  llama3.2  ",
    localBrainSeesScreen: true,
  });

  assert.equal(storedConfig.brainProvider, "local");
  assert.equal(storedConfig.localBrainBaseUrl, "http://localhost:1234");
  assert.equal(storedConfig.localBrainModel, "llama3.2");
  assert.equal(storedConfig.localBrainSeesScreen, true);

  // A public address is not a local brain, so the default comes back instead
  // of a setting that would quietly send the user's words off the machine.
  const publicAddressConfig = sanitizeStoredConfig({
    ...defaultUstaadUserConfig,
    localBrainBaseUrl: "https://api.example.com",
  });
  assert.equal(publicAddressConfig.localBrainBaseUrl, "http://127.0.0.1:11434");

  const nonsenseModelConfig = sanitizeStoredConfig({
    ...defaultUstaadUserConfig,
    localBrainModel: "   ",
  });
  assert.equal(nonsenseModelConfig.localBrainModel, "llama3.2");
  assert.equal(sanitizeStoredConfig({}).localBrainSeesScreen, false);
});

test("a first launch is quiet and does not schedule autonomous work", () => {
  assert.equal(defaultUstaadUserConfig.launchAtLogin, false);
  assert.equal(defaultUstaadUserConfig.presence.morningBriefEnabled, false);
  assert.equal(defaultUstaadUserConfig.presence.eveningRecapEnabled, false);
});

test("offline mode is off until the user asks, and only a real boolean turns it on", () => {
  assert.equal(defaultUstaadUserConfig.offlineMode, false);
  assert.equal(sanitizeStoredConfig({}).offlineMode, false);
  assert.equal(sanitizeStoredConfig({ offlineMode: true }).offlineMode, true);
  assert.equal(sanitizeStoredConfig({ offlineMode: "yes" }).offlineMode, false);
});
