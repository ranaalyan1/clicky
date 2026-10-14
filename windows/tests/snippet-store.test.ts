import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SnippetStore } from "../src/main/snippet-store";

function createSnippetStore(): SnippetStore {
  return new SnippetStore(join(mkdtempSync(join(tmpdir(), "clickaa-snippet-")), "snippets.json"));
}

test("a saved snippet can be looked up by its exact name", () => {
  const snippetStore = createSnippetStore();
  const savedSnippet = snippetStore.save("my address", "22 Baker Street, London");

  const lookupResult = snippetStore.resolveForInsert("my address");
  assert.equal(lookupResult.snippet?.id, savedSnippet.id);
  assert.equal(lookupResult.message, "");
});

test("saving the same name again replaces the text instead of duplicating it", () => {
  const snippetStore = createSnippetStore();
  const originalSnippet = snippetStore.save("sign off", "best, alyan");
  const updatedSnippet = snippetStore.save("Sign Off", "cheers, alyan");

  assert.equal(snippetStore.list().length, 1);
  assert.equal(updatedSnippet.id, originalSnippet.id);
  assert.equal(snippetStore.list()[0]?.text, "cheers, alyan");
});

test("a rough name still finds the snippet, and a missing one explains itself", () => {
  const snippetStore = createSnippetStore();
  snippetStore.save("invoice reply", "Thanks for the invoice, payment is scheduled.");

  assert.equal(snippetStore.resolveForInsert("invoice").snippet?.name, "invoice reply");

  const missingLookup = snippetStore.resolveForInsert("passport number");
  assert.equal(missingLookup.snippet, null);
  assert.equal(missingLookup.message.includes("passport number"), true);
});

test("two equally plausible snippets make Clickaa ask instead of guessing", () => {
  const snippetStore = createSnippetStore();
  snippetStore.save("work address", "Level 4, Tech Park");
  snippetStore.save("work address formal", "Level 4, Tech Park, Islamabad");

  // The longer name wins outright when it is clearly ahead.
  const clearLookup = snippetStore.resolveForInsert("work address formal");
  assert.equal(clearLookup.snippet?.name, "work address formal");
});

test("snippets persist, and removing one by name works", () => {
  const snippetPath = join(mkdtempSync(join(tmpdir(), "clickaa-snippet-")), "snippets.json");
  const firstStore = new SnippetStore(snippetPath);
  firstStore.save("bank details", "IBAN PK00 TEST 0000");

  const reloadedStore = new SnippetStore(snippetPath);
  assert.deepEqual(reloadedStore.summarizeSnippetNames(5), ["bank details"]);

  assert.equal(reloadedStore.removeMatching("bank").length, 1);
  assert.equal(reloadedStore.list().length, 0);
});

test("an empty name or empty text is refused with a usable message", () => {
  const snippetStore = createSnippetStore();
  assert.throws(() => snippetStore.save("   ", "some text"), /needs a name/);
  assert.throws(() => snippetStore.save("blank", "   "), /needs some text/);
});
