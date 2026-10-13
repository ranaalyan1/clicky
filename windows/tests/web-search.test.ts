import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchUrl, isKnownSearchTarget, searchTargetDefinitions } from "../src/main/web-search";

test("every search target builds an https url with the query encoded", () => {
  for (const searchTargetDefinition of searchTargetDefinitions) {
    const searchUrl = buildSearchUrl(searchTargetDefinition.id, "gift wraps & ribbons");
    assert.equal(searchUrl.startsWith("https://"), true, searchTargetDefinition.id);
    assert.equal(searchUrl.includes("gift"), true, searchTargetDefinition.id);
    assert.equal(searchUrl.includes("wraps"), true, searchTargetDefinition.id);
    assert.equal(decodeURIComponent(searchUrl).includes("gift wraps"), true, searchTargetDefinition.id);
  }
});

test("known targets resolve to the sites people actually ask for", () => {
  assert.equal(buildSearchUrl("youtube", "how to cook spaghetti").startsWith("https://www.youtube.com/results?search_query="), true);
  assert.equal(buildSearchUrl("amazon", "gift wraps"), "https://www.amazon.in/s?k=gift%20wraps");
  assert.equal(buildSearchUrl("default", "gift wraps").startsWith("https://www.google.com/search?q="), true);
  assert.equal(buildSearchUrl("wikipedia", "ada lovelace").startsWith("https://en.wikipedia.org/w/index.php?search="), true);
});

test("an unknown target is rejected so the caller can fall back to google", () => {
  assert.equal(isKnownSearchTarget("youtube"), true);
  assert.equal(isKnownSearchTarget("askjeeves"), false);
  assert.equal(searchTargetDefinitions.some((searchTargetDefinition) => searchTargetDefinition.id === "google"), true);
});
