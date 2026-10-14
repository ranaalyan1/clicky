import assert from "node:assert/strict";
import test from "node:test";
import {
  buildActionProtocolInstructions,
  actionNeedsConfirmation,
  filterActionsByAbilities,
  getActionRequiredAbility,
  getActionRisk,
  parseModelResponse,
} from "../src/main/action-protocol";
import { defaultAbilitySettings } from "../src/main/soul-config";
import {
  buildSpokenSummary,
  describeResearchFailure,
  maximumResearchSources,
  readResearchAnswer,
} from "../src/main/research";

function groundedReply(options: { text?: string; sources?: Array<{ uri?: string; title?: string }> }): unknown {
  return {
    candidates: [
      {
        content: { parts: [{ text: options.text ?? "vat registration is handled by FBR." }] },
        groundingMetadata: { groundingChunks: (options.sources ?? []).map((source) => ({ web: source })) },
      },
    ],
  };
}

test("an answer keeps the pages it came from, once each, and only openable ones", () => {
  const answer = readResearchAnswer(groundedReply({
    text: "registration is free for small software businesses.",
    sources: [
      { uri: "https://fbr.gov.pk/vat", title: "FBR — VAT" },
      { uri: "https://fbr.gov.pk/vat", title: "FBR again" },
      { uri: "http://example.com/guide", title: "" },
      { uri: "ftp://files.example.com/thing", title: "not a page" },
      { uri: "not a url", title: "nonsense" },
    ],
  }));

  assert.equal(answer?.answerText, "registration is free for small software businesses.");
  assert.deepEqual(answer?.sources, [
    { title: "FBR — VAT", url: "https://fbr.gov.pk/vat" },
    // A source with no title is named by where it lives rather than "undefined".
    { title: "example.com", url: "http://example.com/guide" },
  ]);

  // A handful is a citation list; a hundred is a search engine.
  const manySources = readResearchAnswer(groundedReply({
    sources: Array.from({ length: 20 }, (_unused, sourceIndex) => ({
      uri: `https://example.com/page-${sourceIndex}`,
      title: `page ${sourceIndex}`,
    })),
  }));
  assert.equal(manySources?.sources.length, maximumResearchSources);
});

test("a reply with no words, no candidate, or no metadata is not an answer", () => {
  assert.equal(readResearchAnswer(groundedReply({ text: "   " })), null);
  assert.equal(readResearchAnswer({ candidates: [] }), null);
  assert.equal(readResearchAnswer(null), null);
  assert.equal(readResearchAnswer("not an object"), null);

  // Grounding metadata is optional: an answer without sources is still an answer.
  const ungrounded = readResearchAnswer({ candidates: [{ content: { parts: [{ text: "i think so" }] } }] });
  assert.deepEqual(ungrounded, { answerText: "i think so", sources: [] });
});

test("the spoken version drops citation markers and stops at a few sentences", () => {
  assert.equal(
    buildSpokenSummary("VAT is handled by the FBR [1]. Registration is free [2]."),
    "VAT is handled by the FBR . Registration is free .",
  );

  const longAnswer = `${"one two three four five six seven eight nine ten. ".repeat(20)}`;
  const spokenSummary = buildSpokenSummary(longAnswer);
  assert.equal(spokenSummary.length <= 420, true);
  assert.equal(spokenSummary.endsWith("."), true);
});

test("a lookup that fails says what to do rather than what broke", () => {
  assert.equal(describeResearchFailure(429, "").includes("rate-limiting"), true);
  assert.equal(describeResearchFailure(404, "").includes("model"), true);
  assert.equal(
    describeResearchFailure(400, JSON.stringify({ error: { message: "Search grounding is not supported for this model." } }))
      .includes("Search grounding is not supported"),
    true,
  );
  assert.equal(describeResearchFailure(500, "something odd").length > 0, true);
});

test("a lookup parses, runs without a card, and follows the web search switch", () => {
  const parsedResponse = parseModelResponse(
    'let me check. <actions>[{"type":"research","question":"who won the 2026 world cup"}]</actions>',
  );
  assert.deepEqual(parsedResponse.actions, [
    { type: "research", question: "who won the 2026 world cup" },
  ]);
  assert.equal(getActionRisk("research"), "safe");
  assert.equal(getActionRequiredAbility("research"), "webSearch");
  assert.equal(
    actionNeedsConfirmation({ type: "research", question: "anything" }, "risky", []),
    false,
  );

  const withoutQuestion = parseModelResponse('<actions>[{"type":"research"}]</actions>');
  assert.deepEqual(withoutQuestion.actions, []);
  assert.equal(withoutQuestion.problems[0]?.includes("question"), true);

  const { allowedActions, blockedActions } = filterActionsByAbilities(
    [{ type: "research", question: "anything" }],
    { ...defaultAbilitySettings, webSearch: false },
  );
  assert.deepEqual(allowedActions, []);
  assert.deepEqual(blockedActions.map((blockedAction) => blockedAction.ability), ["webSearch"]);

  const instructions = buildActionProtocolInstructions({ ...defaultAbilitySettings, webSearch: true });
  assert.equal(instructions.includes("- research:"), true);
  assert.equal(instructions.includes("the pages it came from"), true);
});
