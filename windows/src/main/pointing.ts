import { CapturedDisplayImage } from "../shared/contracts";

export interface PointingParseResult {
  spokenText: string;
  coordinate: { x: number; y: number } | null;
  elementLabel: string | null;
  screenNumber: number | null;
}

const pointingTagPattern = /\[POINT:(?:none|(\d+)\s*,\s*(\d+)(?::([^\]:\s][^\]:]*?))?(?::screen(\d+))?)\]\s*$/i;

export function parsePointingTag(responseText: string): PointingParseResult {
  const pointingTagMatch = pointingTagPattern.exec(responseText);
  if (!pointingTagMatch) {
    return {
      spokenText: responseText.trim(),
      coordinate: null,
      elementLabel: null,
      screenNumber: null,
    };
  }

  const spokenText = responseText.slice(0, pointingTagMatch.index).trim();
  const xCoordinateText = pointingTagMatch[1];
  const yCoordinateText = pointingTagMatch[2];

  if (!xCoordinateText || !yCoordinateText) {
    return {
      spokenText,
      coordinate: null,
      elementLabel: "none",
      screenNumber: null,
    };
  }

  const parsedScreenNumber = pointingTagMatch[4]
    ? Number.parseInt(pointingTagMatch[4], 10)
    : null;

  return {
    spokenText,
    coordinate: {
      x: Number.parseInt(xCoordinateText, 10),
      y: Number.parseInt(yCoordinateText, 10),
    },
    elementLabel: pointingTagMatch[3]?.trim() || "element",
    screenNumber: parsedScreenNumber,
  };
}

export function selectPointingDisplay(
  capturedDisplays: CapturedDisplayImage[],
  requestedScreenNumber: number | null,
): CapturedDisplayImage | null {
  if (
    requestedScreenNumber !== null
    && requestedScreenNumber >= 1
    && requestedScreenNumber <= capturedDisplays.length
  ) {
    return capturedDisplays[requestedScreenNumber - 1] ?? null;
  }

  return capturedDisplays.find((capturedDisplay) => capturedDisplay.isCursorDisplay)
    ?? capturedDisplays[0]
    ?? null;
}

export function mapImageCoordinateToWindowsDesktop(
  imageCoordinate: { x: number; y: number },
  capturedDisplay: CapturedDisplayImage,
): { x: number; y: number } {
  const clampedImageX = Math.max(0, Math.min(imageCoordinate.x, capturedDisplay.imageWidth));
  const clampedImageY = Math.max(0, Math.min(imageCoordinate.y, capturedDisplay.imageHeight));

  return {
    x: capturedDisplay.displayBounds.x
      + (clampedImageX / capturedDisplay.imageWidth) * capturedDisplay.displayBounds.width,
    y: capturedDisplay.displayBounds.y
      + (clampedImageY / capturedDisplay.imageHeight) * capturedDisplay.displayBounds.height,
  };
}
