import assert from "node:assert/strict";
import test from "node:test";
import { CapturedDisplayImage } from "../src/shared/contracts";
import {
  mapImageCoordinateToWindowsDesktop,
  parsePointingTag,
  selectPointingDisplay,
} from "../src/main/pointing";

function makeCapturedDisplay(
  displayId: number,
  isCursorDisplay: boolean,
  x: number,
): CapturedDisplayImage {
  return {
    displayId,
    imageBase64: "image",
    mediaType: "image/jpeg",
    label: `screen ${displayId}`,
    isCursorDisplay,
    imageWidth: 1280,
    imageHeight: 720,
    displayBounds: { x, y: 0, width: 1920, height: 1080 },
  };
}

test("parsePointingTag removes a coordinate tag from spoken text", () => {
  assert.deepEqual(
    parsePointingTag("open the settings here. [POINT:1040,82:settings button]"),
    {
      spokenText: "open the settings here.",
      coordinate: { x: 1040, y: 82 },
      elementLabel: "settings button",
      screenNumber: null,
    },
  );
});

test("parsePointingTag handles another monitor and POINT:none", () => {
  assert.equal(
    parsePointingTag("it's on the other display. [POINT:400,300:terminal:screen2]").screenNumber,
    2,
  );
  assert.deepEqual(parsePointingTag("here's the answer. [POINT:none]"), {
    spokenText: "here's the answer.",
    coordinate: null,
    elementLabel: "none",
    screenNumber: null,
  });
});

test("selectPointingDisplay defaults to the display containing the pointer", () => {
  const secondaryDisplay = makeCapturedDisplay(2, false, -1920);
  const cursorDisplay = makeCapturedDisplay(1, true, 0);
  const capturedDisplays = [cursorDisplay, secondaryDisplay];

  assert.equal(selectPointingDisplay(capturedDisplays, null)?.displayId, 1);
  assert.equal(selectPointingDisplay(capturedDisplays, 2)?.displayId, 2);
});

test("mapImageCoordinateToWindowsDesktop supports negative multi-monitor origins", () => {
  const leftDisplay = makeCapturedDisplay(2, false, -1920);
  assert.deepEqual(
    mapImageCoordinateToWindowsDesktop({ x: 640, y: 360 }, leftDisplay),
    { x: -960, y: 540 },
  );
  assert.deepEqual(
    mapImageCoordinateToWindowsDesktop({ x: 9000, y: -20 }, leftDisplay),
    { x: 0, y: 0 },
  );
});
