import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLocalBrainUrl,
  buildLocalChatRequest,
  isLocalBrainHost,
  normalizeLocalBrainBaseUrl,
  readLocalTextDelta,
} from "../src/main/local-brain-client";
import { BrainStreamRequest } from "../src/main/brain-types";

test("the address people paste gets cleaned up, and public ones are refused", () => {
  // Every shape someone actually types means the same server.
  assert.equal(normalizeLocalBrainBaseUrl("127.0.0.1:11434"), "http://127.0.0.1:11434");
  assert.equal(normalizeLocalBrainBaseUrl("http://127.0.0.1:11434/"), "http://127.0.0.1:11434");
  assert.equal(normalizeLocalBrainBaseUrl("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434");
  assert.equal(normalizeLocalBrainBaseUrl("localhost:1234"), "http://localhost:1234");
  assert.equal(normalizeLocalBrainBaseUrl("  192.168.1.20:11434  "), "http://192.168.1.20:11434");
  assert.equal(normalizeLocalBrainBaseUrl(""), "");

  // The promise is that the words stay on the user's own hardware.
  assert.throws(() => normalizeLocalBrainBaseUrl("https://api.example.com"), /own network/u);
  assert.throws(() => normalizeLocalBrainBaseUrl("8.8.8.8:11434"), /own network/u);
  assert.throws(() => normalizeLocalBrainBaseUrl("not an address"), /address/u);
});

test("this machine and a private network are local, the internet is not", () => {
  for (const localHost of ["localhost", "127.0.0.1", "127.5.5.5", "10.0.0.4", "192.168.0.9", "172.16.3.1", "172.31.9.9", "::1", "desk.local"]) {
    assert.equal(isLocalBrainHost(localHost), true, localHost);
  }

  for (const remoteHost of ["api.example.com", "8.8.8.8", "172.32.0.1", "172.15.0.1", "169.254.1.1", "192.169.0.1", ""]) {
    assert.equal(isLocalBrainHost(remoteHost), false, remoteHost);
  }
});

test("streamed chunks are read the way every local server sends them", () => {
  assert.equal(readLocalTextDelta(JSON.stringify({ choices: [{ delta: { content: "hello" } }] })), "hello");
  assert.equal(readLocalTextDelta(JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })), "");
  assert.equal(readLocalTextDelta(JSON.stringify({ choices: [] })), "");
  assert.equal(readLocalTextDelta("[DONE]"), "");
  assert.equal(readLocalTextDelta(""), "");
  assert.equal(readLocalTextDelta("{not json"), "");
});

test("a model that cannot see gets told so, and screenshots are left out", () => {
  const request: BrainStreamRequest = {
    systemPrompt: "you are ustaad",
    userPrompt: "what is on my screen?",
    images: [{ mediaType: "image/png", base64Data: "c2NyZWVu", label: "screen 1, 1920x1080" }],
    conversationHistory: [{ userTranscript: "hi", assistantResponse: "hello" }],
    signal: new AbortController().signal,
  };

  const blindRequest = buildLocalChatRequest("llama3.2", request, false) as {
    model: string;
    messages: Array<{ role: string; content: unknown }>;
  };
  assert.equal(blindRequest.model, "llama3.2");
  assert.equal(blindRequest.messages[0]?.role, "system");
  assert.equal(String(blindRequest.messages[0]?.content).includes("cannot see the screen"), true);

  const blindMessages = JSON.stringify(blindRequest.messages);
  assert.equal(blindMessages.includes("c2NyZWVu"), false);
  assert.deepEqual(blindRequest.messages.slice(1, 3), [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);
  assert.equal(blindRequest.messages.at(-1)?.content, "what is on my screen?");

  const seeingRequest = buildLocalChatRequest("qwen2.5-vl", request, true) as {
    messages: Array<{ role: string; content: unknown }>;
  };
  const seeingMessages = JSON.stringify(seeingRequest.messages);
  assert.equal(seeingMessages.includes("data:image/png;base64,c2NyZWVu"), true);
  assert.equal(seeingMessages.includes("screen 1, 1920x1080"), true);
  assert.equal(seeingMessages.includes("cannot see the screen"), false);
});

test("the two local urls are the openai-shaped ones every server serves", () => {
  assert.equal(buildLocalBrainUrl("http://127.0.0.1:11434", "/v1/chat/completions"), "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(buildLocalBrainUrl("http://127.0.0.1:11434/", "/v1/models"), "http://127.0.0.1:11434/v1/models");
});
