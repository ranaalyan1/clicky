import assert from "node:assert/strict";
import test from "node:test";
import { extractTextDelta, ServerSentEventTextParser } from "../src/main/sse-parser";

test("ServerSentEventTextParser preserves lines split across network chunks", () => {
  const parser = new ServerSentEventTextParser();
  assert.deepEqual(parser.appendChunk("event: content\ndata: {\"type\":\"content_block_"), []);
  assert.deepEqual(
    parser.appendChunk("delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\n"),
    ["{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}"],
  );
});

test("extractTextDelta returns only Anthropic text delta events", () => {
  assert.equal(
    extractTextDelta(JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "clicky" },
    })),
    "clicky",
  );
  assert.equal(extractTextDelta("[DONE]"), "");
  assert.equal(extractTextDelta("not-json"), "");
});
