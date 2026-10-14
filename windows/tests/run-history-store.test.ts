import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunHistoryStore } from "../src/main/run-history-store";

/**
 * The run history is what answers "what did you do yesterday?", so it has to
 * survive a restart, keep the runs that matter when the file grows, and match
 * the way people actually search ("receipts", not the exact sentence they said).
 */

function withTemporaryHistory(run: (store: RunHistoryStore, filePath: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "ustaad-run-history-"));
  const filePath = join(directory, "run-history.json");
  try {
    run(new RunHistoryStore(filePath), filePath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("run history", () => {
  it("keeps runs across a restart, newest first", () => {
    withTemporaryHistory((store, filePath) => {
      store.record({
        request: "open spotify",
        kind: "task",
        outcome: "completed",
        note: "spotify was already running",
        stepsTaken: 2,
        response: "Spotify is up.",
        createdAtIso: "2026-10-14T09:00:00.000Z",
      });
      store.record({
        request: "what is on my screen",
        kind: "reply",
        outcome: "completed",
        note: "",
        stepsTaken: 0,
        response: "A spreadsheet with a receipt in it.",
        createdAtIso: "2026-10-14T10:00:00.000Z",
      });

      const reopened = new RunHistoryStore(filePath);
      assert.deepEqual(reopened.list().map((entry) => entry.request), [
        "what is on my screen",
        "open spotify",
      ]);
    });
  });

  it("finds a run by the words the user would actually search for", () => {
    withTemporaryHistory((store) => {
      store.record({
        request: "find the receipt from the hardware shop",
        kind: "reply",
        outcome: "completed",
        note: "",
        stepsTaken: 1,
        response: "I found a receipt for 4,300 rupees from Al-Noor Hardware on Tuesday.",
      });
      store.record({
        request: "play something calm",
        kind: "task",
        outcome: "completed",
        note: "started a playlist",
        stepsTaken: 3,
        response: "Playing your calm playlist.",
      });

      const matches = store.search("receipts hardware");
      assert.equal(matches.length, 1);
      const [match] = matches;
      assert.ok(match, "expected the receipt run to match");
      assert.equal(match.entry.request, "find the receipt from the hardware shop");
      assert.match(match.snippet, /receipt/i);

      // The snippet shows the matched words rather than the start of the text.
      assert.match(match.snippet, /Al-Noor Hardware/);
      assert.deepEqual(store.search("nothing here at all"), []);
    });
  });

  it("keeps the newest runs when the file fills up", () => {
    withTemporaryHistory((store) => {
      for (let index = 0; index < 320; index += 1) {
        store.record({
          request: `run number ${index}`,
          kind: "reply",
          outcome: "completed",
          note: "",
          stepsTaken: 0,
          response: "",
          createdAtIso: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        });
      }

      const runs = store.list();
      assert.equal(runs.length, 300);
      const [newestRun] = runs;
      assert.equal(newestRun?.request, "run number 319");
      assert.ok(!runs.some((entry) => entry.request === "run number 0"), "the oldest run should have aged out");
    });
  });

  it("writes a plain file the user could read themselves", () => {
    withTemporaryHistory((store, filePath) => {
      store.record({
        request: "summarize this page",
        kind: "reply",
        outcome: "completed",
        note: "",
        stepsTaken: 0,
        response: "It is an invoice for 12,000 rupees.",
      });

      const written = JSON.parse(readFileSync(filePath, "utf8")) as Array<Record<string, unknown>>;
      assert.equal(written.length, 1);
      const [writtenRun] = written;
      assert.equal(writtenRun?.request, "summarize this page");
      assert.equal(writtenRun?.outcome, "completed");
    });
  });

  it("refuses to trust a corrupted file, and can still be cleared", () => {
    withTemporaryHistory((store, filePath) => {
      store.record({
        request: "tidy the desktop",
        kind: "task",
        outcome: "gave_up",
        note: "the desktop shortcut would not move",
        stepsTaken: 4,
        response: "",
      });
      assert.equal(store.clear(), 1);
      assert.deepEqual(new RunHistoryStore(filePath).list(), []);
    });
  });
});
