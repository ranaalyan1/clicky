import assert from "node:assert/strict";
import test from "node:test";
import {
  actionNeedsConfirmation,
  buildActionProtocolInstructions,
  filterActionsByAbilities,
  getActionRequiredAbility,
  getActionRisk,
  parseModelResponse,
} from "../src/main/action-protocol";
import {
  buildPictureNameStem,
  describePictureFailure,
  maximumPictureNameLength,
  pictureExtensionForMimeType,
  readPictureFromGeminiResponse,
  resolvePictureFileName,
} from "../src/main/image-generation";
import { defaultAbilitySettings, sanitizeAbilitySettings } from "../src/main/soul-config";

test("a picture is read out of either shape google answers with, and a refusal is not a picture", () => {
  const geminiAnswer = readPictureFromGeminiResponse({
    candidates: [
      {
        content: {
          parts: [
            { text: "here is your panda" },
            { inlineData: { mimeType: "image/png", data: "cGFuZGE=" } },
          ],
        },
      },
    ],
  });
  assert.deepEqual(geminiAnswer, { base64Data: "cGFuZGE=", mimeType: "image/png" });

  const imagenAnswer = readPictureFromGeminiResponse({
    predictions: [{ bytesBase64Encoded: "aW1hZ2Vu", mimeType: "image/jpeg" }],
  });
  assert.deepEqual(imagenAnswer, { base64Data: "aW1hZ2Vu", mimeType: "image/jpeg" });

  // A missing type is a png rather than a file with no extension it can use.
  assert.deepEqual(
    readPictureFromGeminiResponse({
      candidates: [{ content: { parts: [{ inlineData: { data: "bm8tdHlwZQ==" } }] } }],
    }),
    { base64Data: "bm8tdHlwZQ==", mimeType: "image/png" },
  );

  // Words and nothing else: the model declined, and that is not a picture.
  assert.equal(
    readPictureFromGeminiResponse({
      candidates: [{ content: { parts: [{ text: "I cannot draw that." }] } }],
    }),
    null,
  );
  assert.equal(readPictureFromGeminiResponse(null), null);
  assert.equal(readPictureFromGeminiResponse({ candidates: [] }), null);
  assert.equal(readPictureFromGeminiResponse("not an object"), null);
});

test("the file name comes from the user's own name, and can never be a path", () => {
  assert.equal(pictureExtensionForMimeType("image/jpeg"), "jpg");
  assert.equal(pictureExtensionForMimeType("image/webp"), "webp");
  assert.equal(pictureExtensionForMimeType("image/png"), "png");
  assert.equal(pictureExtensionForMimeType("something/odd"), "png");

  const takenNames = new Set<string>();
  assert.equal(buildPictureNameStem("A Red Panda, skateboarding!"), "a-red-panda-skateboarding");
  assert.equal(buildPictureNameStem("🐼"), "picture");
  assert.equal(
    resolvePictureFileName({ prompt: "red panda", requestedName: null, mimeType: "image/png", takenFileNames: takenNames }),
    "red-panda.png",
  );
  assert.equal(
    resolvePictureFileName({ prompt: "ignored", requestedName: "My Wallpaper", mimeType: "image/jpeg", takenFileNames: takenNames }),
    "my-wallpaper.jpg",
  );

  // A prompt full of separators still lands on a plain file name in the folder.
  const sneakyName = resolvePictureFileName({
    prompt: "../../etc/passwd",
    requestedName: null,
    mimeType: "image/png",
    takenFileNames: takenNames,
  });
  assert.equal(sneakyName, "etc-passwd.png");
  assert.equal(sneakyName.includes("/"), false);
  assert.equal(sneakyName.includes("\\"), false);

  // Long prompts are cut to something Explorer and the file system both like.
  const longName = buildPictureNameStem(`a picture of ${"very ".repeat(30)}detailed clouds`);
  assert.equal(longName.length <= maximumPictureNameLength, true);
  assert.equal(longName.endsWith("-"), false);

  // An existing picture is never overwritten: the new one gets a number.
  const onePanda = new Set(["red-panda.png"]);
  assert.equal(
    resolvePictureFileName({ prompt: "red panda", requestedName: null, mimeType: "image/png", takenFileNames: onePanda }),
    "red-panda-2.png",
  );
  const twoPandas = new Set(["red-panda.png", "red-panda-2.png"]);
  assert.equal(
    resolvePictureFileName({ prompt: "red panda", requestedName: null, mimeType: "image/png", takenFileNames: twoPandas }),
    "red-panda-3.png",
  );
});

test("a refusal from google is explained in words the user can act on", () => {
  const noImageAccess = describePictureFailure(404, JSON.stringify({ error: { message: "model not found" } }));
  assert.equal(noImageAccess.includes("key"), true);
  assert.equal(noImageAccess.includes("image access"), true);

  const rateLimited = describePictureFailure(429, "quota");
  assert.equal(rateLimited.includes("rate-limiting"), true);

  const blocked = describePictureFailure(
    400,
    JSON.stringify({ error: { message: "The prompt was blocked by safety filters." } }),
  );
  assert.equal(blocked.includes("refused that description"), true);

  const unexplained = describePictureFailure(500, "internal error at Google");
  assert.equal(unexplained.includes("internal error at Google"), true);
  assert.equal(describePictureFailure(503, "").length > 0, true);
});

test("a picture request parses, is safe, and needs the picture switch", () => {
  const parsedResponse = parseModelResponse(
    'here you go. <actions>[{"type":"create_image","prompt":"a red panda skateboarding"}]</actions>',
  );
  assert.deepEqual(parsedResponse.actions, [
    { type: "create_image", prompt: "a red panda skateboarding", name: null },
  ]);
  assert.equal(getActionRisk("create_image"), "safe");
  assert.equal(getActionRequiredAbility("create_image"), "imageGeneration");
  assert.equal(
    actionNeedsConfirmation({ type: "create_image", prompt: "a panda", name: null }, "risky", []),
    false,
  );

  // A name is optional, and an oversized prompt is trimmed rather than refused.
  const named = parseModelResponse(
    '<actions>[{"type":"create_image","prompt":"a panda","name":"wallpaper"}]</actions>',
  );
  assert.deepEqual(named.actions, [{ type: "create_image", prompt: "a panda", name: "wallpaper" }]);

  const withoutPrompt = parseModelResponse('<actions>[{"type":"create_image","name":"wallpaper"}]</actions>');
  assert.deepEqual(withoutPrompt.actions, []);
  assert.equal(withoutPrompt.problems[0]?.includes("prompt"), true);

  const tooLong = parseModelResponse(
    `<actions>[{"type":"create_image","prompt":"${"cloud ".repeat(120)}"}]</actions>`,
  );
  const longPromptAction = tooLong.actions[0];
  assert.equal(longPromptAction?.type, "create_image");
  assert.equal(longPromptAction?.type === "create_image" ? longPromptAction.prompt.length : 0, 400);
});

test("drawing is off by default, and the switch is named when it is off", () => {
  assert.equal(defaultAbilitySettings.imageGeneration, false);
  assert.equal(sanitizeAbilitySettings({}).imageGeneration, false);
  assert.equal(sanitizeAbilitySettings({ imageGeneration: true }).imageGeneration, true);

  const withPictures = buildActionProtocolInstructions({ ...defaultAbilitySettings, imageGeneration: true });
  assert.equal(withPictures.includes("- create_image:"), true);
  assert.equal(withPictures.includes("switched off"), false);

  const withoutPictures = buildActionProtocolInstructions({ ...defaultAbilitySettings, imageGeneration: false });
  assert.equal(withoutPictures.includes("- create_image:"), false);
  assert.equal(withoutPictures.includes("draw pictures"), true);

  const { allowedActions, blockedActions } = filterActionsByAbilities(
    [{ type: "create_image", prompt: "a panda", name: null }],
    { ...defaultAbilitySettings, imageGeneration: false },
  );
  assert.deepEqual(allowedActions, []);
  assert.deepEqual(blockedActions.map((blockedAction) => blockedAction.ability), ["imageGeneration"]);
});
