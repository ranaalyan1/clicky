import assert from "node:assert/strict";
import test from "node:test";
import {
  isAmbiguousTopMatch,
  normalizeForMatch,
  rankTextMatches,
  scoreTextMatch,
} from "../src/main/text-matching";
import { isAppChoiceAmbiguous } from "../src/main/app-name-matching";
import { LaunchableApp } from "../src/main/app-name-matching";

function makeLaunchableApp(appName: string): LaunchableApp {
  return {
    id: appName.toLowerCase().replace(/\s+/gu, "-"),
    name: appName,
    source: "startMenu",
    launchTarget: `C:\\Program Files\\${appName}\\${appName}.exe`,
  };
}

test("exact wording scores higher than a partial or reordered match", () => {
  const exactScore = scoreTextMatch("call mom", "call mom at six");
  const partialScore = scoreTextMatch("call mom", "call the plumber");

  assert.equal(exactScore > partialScore, true);
  assert.equal(scoreTextMatch("oat milk", "oat milk") >= 900, true);
  assert.equal(normalizeForMatch("  Call   MOM!! "), "call mom");
});

test("ranked matches keep the best candidate first and respect the limit", () => {
  const items = [
    { id: "1", text: "buy oat milk" },
    { id: "2", text: "buy soy milk" },
    { id: "3", text: "pay the internet bill" },
  ];

  const rankedMatches = rankTextMatches("buy oat milk", items, (item) => item.text, 2);
  assert.equal(rankedMatches.length, 2);
  assert.equal(rankedMatches[0]?.item.id, "1");
  assert.equal(rankedMatches[0]?.score > (rankedMatches[1]?.score ?? 0), true);
});

test("a weak top match with a close runner-up is ambiguous", () => {
  assert.equal(
    isAmbiguousTopMatch([
      { item: { id: "unity" }, score: 700 },
      { item: { id: "unreal" }, score: 690 },
    ]),
    true,
  );
  assert.equal(
    isAmbiguousTopMatch([
      { item: { id: "unity" }, score: 950 },
      { item: { id: "unreal" }, score: 690 },
    ]),
    false,
  );
});

test("app choice is ambiguous only when two different apps are equally plausible", () => {
  assert.equal(
    isAppChoiceAmbiguous([
      { item: makeLaunchableApp("unity"), score: 700 },
      { item: makeLaunchableApp("unreal"), score: 690 },
    ]),
    true,
  );
  assert.equal(
    isAppChoiceAmbiguous([
      { item: makeLaunchableApp("unity hub"), score: 1_000 },
      { item: makeLaunchableApp("unity"), score: 940 },
    ]),
    false,
  );
});
