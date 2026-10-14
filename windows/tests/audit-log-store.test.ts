import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuditLogStore } from "../src/main/audit-log-store";

function createAuditLogStore(): AuditLogStore {
  return new AuditLogStore(join(mkdtempSync(join(tmpdir(), "clickaa-audit-")), "audit-log.json"));
}

test("entries are newest first and carry what actually ran", () => {
  const auditLogStore = createAuditLogStore();
  auditLogStore.record({
    summary: "finding what is using the cpu",
    detail: "Get-Process | Sort-Object CPU -Descending | Select-Object -First 5",
    tier: "tier1",
    outcome: "allowed",
    resultPreview: "chrome  41.2",
  });
  auditLogStore.record({
    summary: "refused: read the SAM hive",
    detail: "reg query HKLM\\SAM",
    tier: "blocked",
    outcome: "blocked",
    resultPreview: "that is a windows credential store",
  });

  const entries = auditLogStore.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.outcome, "blocked");
  assert.equal(entries[0]?.detail, "reg query HKLM\\SAM");
  assert.equal(entries[1]?.tier, "tier1");
});

test("refusals are logged too, so the log is the whole story", () => {
  const auditLogStore = createAuditLogStore();
  auditLogStore.record({ summary: "a", detail: "", tier: "tier1", outcome: "allowed", resultPreview: "" });
  auditLogStore.record({ summary: "b", detail: "", tier: "tier2", outcome: "refused", resultPreview: "" });
  auditLogStore.record({ summary: "c", detail: "", tier: "blocked", outcome: "blocked", resultPreview: "" });
  auditLogStore.record({ summary: "d", detail: "", tier: "tier1", outcome: "failed", resultPreview: "" });

  assert.deepEqual(auditLogStore.summarizeCounts(), {
    allowed: 1,
    refused: 1,
    blocked: 1,
    failed: 1,
    total: 4,
  });
});

test("the log survives a restart, and a corrupt file never takes clickaa down", () => {
  const logPath = join(mkdtempSync(join(tmpdir(), "clickaa-audit-")), "audit-log.json");
  const firstStore = new AuditLogStore(logPath);
  firstStore.record({ summary: "read a file", detail: "C:\\Users\\aly\\Documents\\a.txt", tier: "tier1", outcome: "allowed", resultPreview: "hello" });

  const reloadedStore = new AuditLogStore(logPath);
  assert.equal(reloadedStore.list()[0]?.summary, "read a file");

  // A file full of nonsense reads as "no entries", and stays writable.
  const brokenPath = join(mkdtempSync(join(tmpdir(), "clickaa-audit-")), "audit-log.json");
  require("node:fs").writeFileSync(brokenPath, "{ this is not json", "utf8");
  const brokenStore = new AuditLogStore(brokenPath);
  assert.deepEqual(brokenStore.list(), []);
  brokenStore.record({ summary: "after the mess", detail: "", tier: "tier1", outcome: "allowed", resultPreview: "" });
  assert.equal(brokenStore.list().length, 1);
});

test("clearing the log really clears it", () => {
  const auditLogStore = createAuditLogStore();
  auditLogStore.record({ summary: "something", detail: "", tier: "tier1", outcome: "allowed", resultPreview: "" });
  auditLogStore.clear();

  assert.deepEqual(auditLogStore.list(), []);
  assert.equal(auditLogStore.summarizeCounts().total, 0);
});

test("a runaway log is capped rather than growing forever", () => {
  const auditLogStore = createAuditLogStore();
  for (let entryIndex = 0; entryIndex < 520; entryIndex += 1) {
    auditLogStore.record({
      summary: `entry ${entryIndex}`,
      detail: "",
      tier: "tier1",
      outcome: "allowed",
      resultPreview: "",
    });
  }

  assert.equal(auditLogStore.summarizeCounts().total, 500);
  assert.equal(auditLogStore.list(1)[0]?.summary, "entry 519");
});
