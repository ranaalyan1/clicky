import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhoneBridgeStore } from "../src/main/phone-bridge-store";
import { PhoneBridgeServer } from "../src/main/phone-bridge-server";
import { buildPhonePage } from "../src/main/phone-bridge-page";
import { PhoneBridgeStatus } from "../src/shared/contracts";

/**
 * The phone window reaches off this machine, so its tests are mostly about what
 * it refuses: no token, the wrong token, a body that is too big, a route that
 * does not exist. The read-only promise is a test too — there is no path that
 * makes the pc do anything, and these tests would notice if one appeared.
 */

const pairingToken = "test-pairing-token-that-is-long-enough";

const status: PhoneBridgeStatus = {
  assistantName: "Ustaad",
  isConfigured: true,
  voiceState: "idle",
  lastTranscript: "what is on my screen",
  responseText: "A spreadsheet with a receipt in it.",
  openTodos: ["call mom at 6pm"],
  nextScheduledTasks: ["morning videos — tomorrow at 09:00"],
  pendingConfirmationCount: 1,
};

describe("phone bridge pairing", () => {
  it("creates a token the first time it is needed, and keeps it", () => {
    const directory = mkdtempSync(join(tmpdir(), "ustaad-phone-pairing-"));
    try {
      const filePath = join(directory, "phone-bridge.json");
      const firstToken = new PhoneBridgeStore(filePath).read().token;
      assert.ok(firstToken.length >= 16, "a pairing token has to be long enough to be a secret");
      assert.equal(new PhoneBridgeStore(filePath).read().token, firstToken, "the token survives a restart");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rotating the token throws the old link away", () => {
    const directory = mkdtempSync(join(tmpdir(), "ustaad-phone-rotate-"));
    try {
      const store = new PhoneBridgeStore(join(directory, "phone-bridge.json"));
      const originalToken = store.read().token;
      const rotatedToken = store.rotateToken().token;
      assert.notEqual(rotatedToken, originalToken);
      assert.equal(new PhoneBridgeStore(join(directory, "phone-bridge.json")).read().token, rotatedToken);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses to trust a corrupted pairing file", () => {
    const directory = mkdtempSync(join(tmpdir(), "ustaad-phone-corrupt-"));
    try {
      const filePath = join(directory, "phone-bridge.json");
      writeFileSync(filePath, "{ this is not json", "utf8");
      const { token, port } = new PhoneBridgeStore(filePath).read();
      assert.ok(token.length >= 16);
      assert.ok(port > 0 && port < 65_536);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("phone bridge server", () => {
  let server: PhoneBridgeServer;
  let baseUrl = "";
  const askedQuestions: string[] = [];

  before(async () => {
    server = new PhoneBridgeServer({
      port: 0,
      token: pairingToken,
      host: "127.0.0.1",
      handlers: {
        getStatus: () => status,
        ask: async (requestText) => {
          askedQuestions.push(requestText);
          return "Two receipts, both from Tuesday.";
        },
      },
    });
    const port = await server.start();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await server.stop();
  });

  it("gives a stranger on the network nothing", async () => {
    const withoutToken = await fetch(`${baseUrl}/api/status`);
    assert.equal(withoutToken.status, 401);

    const wrongToken = await fetch(`${baseUrl}/api/status?token=not-the-token`);
    assert.equal(wrongToken.status, 401);

    const pageWithoutToken = await fetch(`${baseUrl}/`);
    assert.equal(pageWithoutToken.status, 401);
  });

  it("serves the page and the status to a paired phone", async () => {
    const pageResponse = await fetch(`${baseUrl}/?token=${pairingToken}`);
    assert.equal(pageResponse.status, 200);
    assert.match(pageResponse.headers.get("content-type") ?? "", /text\/html/);
    const page = await pageResponse.text();
    assert.match(page, /Ustaad/);
    assert.match(page, /reading only/i);

    const statusResponse = await fetch(`${baseUrl}/api/status?token=${pairingToken}`);
    assert.equal(statusResponse.status, 200);
    const statusPayload = await statusResponse.json() as PhoneBridgeStatus;
    assert.equal(statusPayload.assistantName, "Ustaad");
    assert.deepEqual(statusPayload.openTodos, ["call mom at 6pm"]);
    assert.equal(statusPayload.pendingConfirmationCount, 1);
  });

  it("passes a question to the pc and answers with the reply", async () => {
    const askResponse = await fetch(`${baseUrl}/api/ask?token=${pairingToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "how many receipts did i find" }),
    });
    assert.equal(askResponse.status, 200);
    const askPayload = await askResponse.json() as { reply: string };
    assert.equal(askPayload.reply, "Two receipts, both from Tuesday.");
    assert.deepEqual(askedQuestions, ["how many receipts did i find"]);
  });

  it("accepts the token in a header, so it can stay out of the address bar", async () => {
    const headerResponse = await fetch(`${baseUrl}/api/status`, {
      headers: { Authorization: `Bearer ${pairingToken}` },
    });
    assert.equal(headerResponse.status, 200);
  });

  it("refuses an empty question and an oversized body", async () => {
    const emptyQuestion = await fetch(`${baseUrl}/api/ask?token=${pairingToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    assert.equal(emptyQuestion.status, 400);

    const oversizedBody = await fetch(`${baseUrl}/api/ask?token=${pairingToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(5_000) }),
    });
    assert.equal(oversizedBody.status, 413);
  });

  it("has no route that makes the pc do anything", async () => {
    for (const path of ["/api/action", "/api/run", "/api/confirm", "/api/system-access"]) {
      const response = await fetch(`${baseUrl}${path}?token=${pairingToken}`, { method: "POST", body: "{}" });
      assert.equal(response.status, 404, `${path} should not exist`);
    }
  });
});

describe("phone bridge page", () => {
  it("loads nothing from the network, so it works with the internet down", () => {
    const page = buildPhonePage(pairingToken, "Ustaad");
    assert.doesNotMatch(page, /https?:\/\//, "the page must not fetch anything from anywhere");
    assert.doesNotMatch(page, /<script[^>]+src=/i, "the page must not load a script from a file");
    // It never offers to approve anything: confirmations stay at the pc.
    assert.doesNotMatch(page, /approve/i);
  });

  it("escapes the assistant name rather than trusting it", () => {
    const page = buildPhonePage(pairingToken, "<img src=x onerror=alert(1)>");
    assert.doesNotMatch(page, /<img src=x/);
    assert.match(page, /&lt;img/);
  });
});
