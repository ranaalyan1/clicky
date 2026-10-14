import { desktopCapturer, screen } from "electron";
import { CapturedDisplayImage, CapturedImageRegion } from "../shared/contracts";

/** Anything thinner than this is a stray click rather than a real region. */
const minimumCaptureRegionSide = 24;

export interface DesktopRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

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

/** The pointer's display, in desktop coordinates. */
export function getPointerDisplayBounds(): DesktopRegion & { displayId: number } {
  const cursorPoint = screen.getCursorScreenPoint();
  const cursorDisplay = screen.getDisplayNearestPoint(cursorPoint);
  return {
    displayId: cursorDisplay.id,
    x: cursorDisplay.bounds.x,
    y: cursorDisplay.bounds.y,
    width: cursorDisplay.bounds.width,
    height: cursorDisplay.bounds.height,
  };
}

/**
 * Captures just the region the user circled and describes it so that pointing
 * coordinates can be mapped back onto the desktop: the descriptor's
 * `displayBounds` is the region itself, not the whole screen.
 */
export async function captureWindowsDesktopRegion(
  desktopRegion: DesktopRegion & { displayId: number },
): Promise<CapturedImageRegion> {
  const regionWidth = Math.max(minimumCaptureRegionSide, Math.round(desktopRegion.width));
  const regionHeight = Math.max(minimumCaptureRegionSide, Math.round(desktopRegion.height));
  const croppedImage = await cropDisplayRegionToImage(desktopRegion);
  const croppedImageSize = croppedImage.getSize();

  return {
    displayId: desktopRegion.displayId,
    imageBase64: croppedImage.toJPEG(88).toString("base64"),
    mediaType: "image/jpeg",
    label: `the region the user circled (image dimensions: ${croppedImageSize.width}x${croppedImageSize.height} pixels)`,
    isCursorDisplay: true,
    imageWidth: croppedImageSize.width,
    imageHeight: croppedImageSize.height,
    // The region itself becomes the coordinate space, so a [POINT:x,y] tag from
    // the model maps back onto the desktop through the normal pointing maths.
    displayBounds: {
      x: desktopRegion.x,
      y: desktopRegion.y,
      width: regionWidth,
      height: regionHeight,
    },
    isRegion: true,
  };
}

/** The snip path wants lossless pixels, ready for the clipboard. */
export async function captureWindowsDesktopRegionPng(
  desktopRegion: DesktopRegion & { displayId: number },
): Promise<{ pngBuffer: Buffer; width: number; height: number }> {
  const croppedImage = await cropDisplayRegionToImage(desktopRegion);
  const croppedImageSize = croppedImage.getSize();
  return {
    pngBuffer: croppedImage.toPNG(),
    width: croppedImageSize.width,
    height: croppedImageSize.height,
  };
}

/**
 * Grabs the pixels behind one desktop region, scaling from the capture
 * thumbnail back into display coordinates.
 */
async function cropDisplayRegionToImage(
  desktopRegion: DesktopRegion & { displayId: number },
): Promise<Electron.NativeImage> {
  const regionWidth = Math.max(minimumCaptureRegionSide, Math.round(desktopRegion.width));
  const regionHeight = Math.max(minimumCaptureRegionSide, Math.round(desktopRegion.height));

  const captureSources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 2_560, height: 1_440 },
    fetchWindowIcons: false,
  });

  const matchingSource = captureSources.find(
    (captureSource) => Number.parseInt(captureSource.display_id, 10) === desktopRegion.displayId,
  ) ?? captureSources[0];

  const electronDisplay = screen.getAllDisplays().find(
    (display) => display.id === desktopRegion.displayId,
  ) ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

  if (!matchingSource || matchingSource.thumbnail.isEmpty()) {
    throw new Error("Clickaa could not capture the screen for that region.");
  }

  const fullImageSize = matchingSource.thumbnail.getSize();
  const horizontalScale = fullImageSize.width / electronDisplay.bounds.width;
  const verticalScale = fullImageSize.height / electronDisplay.bounds.height;

  const cropRectangle = {
    x: Math.round((desktopRegion.x - electronDisplay.bounds.x) * horizontalScale),
    y: Math.round((desktopRegion.y - electronDisplay.bounds.y) * verticalScale),
    width: Math.round(regionWidth * horizontalScale),
    height: Math.round(regionHeight * verticalScale),
  };

  // Clamping keeps nativeImage.crop() from throwing on a lasso that ran off the
  // edge of the monitor.
  const clampedRectangle = {
    x: Math.max(0, Math.min(cropRectangle.x, fullImageSize.width - 1)),
    y: Math.max(0, Math.min(cropRectangle.y, fullImageSize.height - 1)),
    width: Math.max(1, Math.min(cropRectangle.width, fullImageSize.width - cropRectangle.x)),
    height: Math.max(1, Math.min(cropRectangle.height, fullImageSize.height - cropRectangle.y)),
  };

  return matchingSource.thumbnail.crop(clampedRectangle);
}
