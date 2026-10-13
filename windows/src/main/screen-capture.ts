import { desktopCapturer, screen } from "electron";
import { CapturedDisplayImage } from "../shared/contracts";

/** Captures every monitor at a vision-friendly size and puts the pointer's display first. */
export async function captureAllWindowsDisplays(): Promise<CapturedDisplayImage[]> {
  const electronDisplays = screen.getAllDisplays();
  if (!electronDisplays.length) {
    throw new Error("Windows did not report any available displays.");
  }

  const cursorPoint = screen.getCursorScreenPoint();
  const cursorDisplay = screen.getDisplayNearestPoint(cursorPoint);
  const orderedDisplays = [...electronDisplays].sort((firstDisplay, secondDisplay) => {
    if (firstDisplay.id === cursorDisplay.id) {
      return -1;
    }
    if (secondDisplay.id === cursorDisplay.id) {
      return 1;
    }
    return firstDisplay.bounds.x - secondDisplay.bounds.x
      || firstDisplay.bounds.y - secondDisplay.bounds.y;
  });

  const captureSources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 1280 },
    fetchWindowIcons: false,
  });

  const sourceByDisplayId = new Map(
    captureSources
      .filter((source) => source.display_id)
      .map((source) => [Number.parseInt(source.display_id, 10), source]),
  );

  const capturedDisplays: CapturedDisplayImage[] = [];
  for (const [orderedDisplayIndex, electronDisplay] of orderedDisplays.entries()) {
    const captureSource = sourceByDisplayId.get(electronDisplay.id)
      ?? captureSources[orderedDisplayIndex];
    if (!captureSource || captureSource.thumbnail.isEmpty()) {
      continue;
    }

    const thumbnailSize = captureSource.thumbnail.getSize();
    const isCursorDisplay = electronDisplay.id === cursorDisplay.id;
    let displayLabel: string;
    if (orderedDisplays.length === 1) {
      displayLabel = "user's screen (pointer is here)";
    } else if (isCursorDisplay) {
      displayLabel = `screen ${orderedDisplayIndex + 1} of ${orderedDisplays.length} — pointer is on this screen (primary focus)`;
    } else {
      displayLabel = `screen ${orderedDisplayIndex + 1} of ${orderedDisplays.length} — secondary screen`;
    }

    displayLabel += ` (image dimensions: ${thumbnailSize.width}x${thumbnailSize.height} pixels)`;

    capturedDisplays.push({
      displayId: electronDisplay.id,
      imageBase64: captureSource.thumbnail.toJPEG(80).toString("base64"),
      mediaType: "image/jpeg",
      label: displayLabel,
      isCursorDisplay,
      imageWidth: thumbnailSize.width,
      imageHeight: thumbnailSize.height,
      displayBounds: {
        x: electronDisplay.bounds.x,
        y: electronDisplay.bounds.y,
        width: electronDisplay.bounds.width,
        height: electronDisplay.bounds.height,
      },
    });
  }

  if (!capturedDisplays.length) {
    throw new Error("Clickaa could not capture a usable image from any display.");
  }

  return capturedDisplays;
}
