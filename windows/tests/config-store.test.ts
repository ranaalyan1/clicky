import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ClickaaConfigStore,
  defaultClickaaUserConfig,
  normalizeWorkerBaseUrl,
} from "../src/main/config-store";

test("normalizeWorkerBaseUrl accepts secure production URLs and local HTTP", () => {
  assert.equal(
    normalizeWorkerBaseUrl("  https://clickaa.example.workers.dev///  "),
    "https://clickaa.example.workers.dev",
  );
  assert.equal(normalizeWorkerBaseUrl("http://localhost:8787/"), "http://localhost:8787");
});

test("normalizeWorkerBaseUrl rejects insecure remote and credentialed URLs", () => {
  assert.throws(() => normalizeWorkerBaseUrl("http://example.com"), /HTTPS/);
  assert.throws(() => normalizeWorkerBaseUrl("https://user:secret@example.com"), /username/);
  assert.throws(() => normalizeWorkerBaseUrl("not a url"), /valid Worker URL/);
});

test("ClickaaConfigStore persists updates and sanitizes corrupt files", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "clickaa-config-test-"));
  const configPath = join(temporaryDirectory, "settings.json");

  try {
    const configStore = new ClickaaConfigStore(configPath);
    assert.deepEqual(configStore.getConfig(), defaultClickaaUserConfig);

    configStore.updateConfig({
      workerBaseUrl: "https://example.workers.dev/",
      cursorEnabled: false,
    });
    const savedPayload = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.equal(savedPayload.workerBaseUrl, "https://example.workers.dev");
    assert.equal(savedPayload.cursorEnabled, false);

    const reloadedStore = new ClickaaConfigStore(configPath);
    assert.equal(reloadedStore.getConfig().cursorEnabled, false);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
