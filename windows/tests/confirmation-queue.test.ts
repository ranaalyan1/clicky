import assert from "node:assert/strict";
import test from "node:test";
import { ConfirmationQueue, interpretConfirmationAnswer } from "../src/main/confirmation-queue";

test("queued confirmations are answered in order and can be taken once", () => {
  const confirmationQueue = new ConfirmationQueue();
  const firstConfirmation = confirmationQueue.enqueue(1, [{ type: "open_app", name: "unity" }], 'open "unity"?');
  const secondConfirmation = confirmationQueue.enqueue(2, [{ type: "type_text", text: "hi" }], "type that text?");

  assert.equal(confirmationQueue.list().length, 2);
  assert.equal(confirmationQueue.nextPending()?.id, firstConfirmation.id);

  assert.equal(confirmationQueue.take(firstConfirmation.id)?.id, firstConfirmation.id);
  assert.equal(confirmationQueue.take(firstConfirmation.id), null);
  assert.equal(confirmationQueue.nextPending()?.id, secondConfirmation.id);

  assert.equal(confirmationQueue.remove(secondConfirmation.id), true);
  assert.equal(confirmationQueue.list().length, 0);
});

test("stale confirmations expire so an old question never runs minutes later", () => {
  const confirmationQueue = new ConfirmationQueue();
  const queuedConfirmation = confirmationQueue.enqueue(
    1,
    [{ type: "volume", operation: "mute", level: null }],
    "mute the sound?",
  );
  const createdAt = Date.parse(queuedConfirmation.createdAtIso);

  assert.deepEqual(
    confirmationQueue.expireOlderThan(new Date(createdAt + 10_000), 30_000),
    [],
  );
  assert.equal(confirmationQueue.list().length, 1);

  const expiredConfirmations = confirmationQueue.expireOlderThan(new Date(createdAt + 60_000), 30_000);
  assert.deepEqual(expiredConfirmations.map((confirmation) => confirmation.id), [queuedConfirmation.id]);
  assert.equal(confirmationQueue.list().length, 0);
});

test("spoken yes and no are understood, and rejection wins over approval", () => {
  assert.equal(interpretConfirmationAnswer("yes please do it"), "approve");
  assert.equal(interpretConfirmationAnswer("go ahead"), "approve");
  assert.equal(interpretConfirmationAnswer("no"), "reject");
  assert.equal(interpretConfirmationAnswer("no, don't do it"), "reject");
  assert.equal(interpretConfirmationAnswer("never mind"), "reject");
  assert.equal(interpretConfirmationAnswer("what is the weather"), "unknown");
  assert.equal(interpretConfirmationAnswer(""), "unknown");
});
