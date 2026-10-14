/**
 * Drawing pictures, and the small decisions around it.
 *
 * Everything here is pure on purpose: naming, parsing and the sentences that
 * come back when Google says no are the parts worth testing, and none of them
 * needs the network or an Electron window to be exercised.
 */

export const maximumPicturePromptLength = 400;
export const maximumPictureNameLength = 48;
export const pictureFolderName = "Ustaad";
export const picturePreviewWidth = 512;

/** One picture, in whichever of Google's two shapes the answer arrived in. */
export interface GeneratedPicturePayload {
  base64Data: string;
  mimeType: string;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Finds the picture in a Gemini or Imagen answer.
 *
 * The Gemini image models put it in an inline part next to a sentence of
 * commentary; Imagen puts it under `predictions`. Either shape may be absent
 * when the model decided not to draw, which is a null rather than a throw so
 * the caller can say something useful.
 */
export function readPictureFromGeminiResponse(responsePayload: unknown): GeneratedPicturePayload | null {
  if (!responsePayload || typeof responsePayload !== "object") {
    return null;
  }

  const geminiParts = (responsePayload as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: unknown; mimeType?: unknown } }> } }>;
  }).candidates?.[0]?.content?.parts ?? [];
  for (const part of geminiParts) {
    const base64Data = readText(part.inlineData?.data);
    if (base64Data) {
      return { base64Data, mimeType: readText(part.inlineData?.mimeType) || "image/png" };
    }
  }

  const predictions = (responsePayload as {
    predictions?: Array<{ bytesBase64Encoded?: unknown; mimeType?: unknown }>;
  }).predictions ?? [];
  for (const prediction of predictions) {
    const base64Data = readText(prediction.bytesBase64Encoded);
    if (base64Data) {
      return { base64Data, mimeType: readText(prediction.mimeType) || "image/png" };
    }
  }

  return null;
}

/** Keeps the extension honest about what is inside the file. */
export function pictureExtensionForMimeType(mimeType: string): string {
  const normalizedMimeType = mimeType.toLowerCase();
  if (normalizedMimeType.includes("jpeg") || normalizedMimeType.includes("jpg")) {
    return "jpg";
  }
  if (normalizedMimeType.includes("webp")) {
    return "webp";
  }
  return "png";
}

/** Everything Windows dislikes in a file name, gone, with the rest kept short. */
export function buildPictureNameStem(rawName: string): string {
  const stem = rawName
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, maximumPictureNameLength)
    .replace(/-+$/gu, "")
    .toLowerCase();
  return stem || "picture";
}

export interface PictureFileNameInput {
  prompt: string;
  requestedName: string | null;
  mimeType: string;
  /** Names already in the folder, so nothing is ever overwritten. */
  takenFileNames: ReadonlySet<string>;
}

/**
 * Picks the file name for a fresh picture.
 *
 * The user's own name for it wins over the prompt, and a name that is already
 * taken gets a number instead of replacing somebody's earlier picture.
 */
export function resolvePictureFileName(input: PictureFileNameInput): string {
  const stem = buildPictureNameStem(input.requestedName?.trim() || input.prompt);
  const extension = pictureExtensionForMimeType(input.mimeType);

  let candidate = `${stem}.${extension}`;
  let suffix = 2;
  while (input.takenFileNames.has(candidate) && suffix <= 999) {
    candidate = `${stem}-${suffix}.${extension}`;
    suffix += 1;
  }
  return candidate;
}

function readGoogleMessage(errorBodyText: string): string {
  try {
    const errorPayload = JSON.parse(errorBodyText) as { error?: { message?: unknown } };
    const googleMessage = readText(errorPayload.error?.message);
    if (googleMessage) {
      return googleMessage;
    }
  } catch {
    // Not JSON; the raw body is the best sentence available.
  }
  return errorBodyText.trim().slice(0, 300);
}

/**
 * Turns Google's refusal into something the user can act on.
 *
 * The common case by far is a key without image access, and that has a fix the
 * user can carry out, so it gets its own sentence and its own hint.
 */
export function describePictureFailure(statusCode: number, errorBodyText: string): string {
  const googleMessage = readGoogleMessage(errorBodyText);

  if (statusCode === 404 || /not found|not supported|unsupported/iu.test(googleMessage)) {
    return "your google key cannot reach the picture models. drawing needs a key with image access; everything else keeps working.";
  }
  if (statusCode === 429) {
    return "google is rate-limiting pictures on your key right now. give it a minute and ask again.";
  }
  if (statusCode === 400 && /safety|blocked|policy/iu.test(googleMessage)) {
    return "google refused that description. try describing the picture without the part it objected to.";
  }
  return googleMessage
    ? `google would not draw that: ${googleMessage}`
    : "google would not draw that, and did not say why. try once more.";
}
