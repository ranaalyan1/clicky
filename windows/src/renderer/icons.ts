/**
 * Clickaa's icon set.
 *
 * Drawn as inline SVG instead of text glyphs so every control looks the same on
 * every Windows build, inherits the surrounding colour, and lands on the pixel
 * grid. Each icon is authored on a 24×24 canvas and scaled by CSS.
 */
export type ClickaaIconName =
  | "play"
  | "pause"
  | "next"
  | "previous"
  | "close"
  | "check"
  | "microphone"
  | "copy"
  | "undo";

interface IconGeometry {
  /** One or more path commands, drawn in order. */
  paths: string[];
  /** Solid shapes read better for transport controls; line art for the rest. */
  mode: "fill" | "stroke";
}

const iconGeometries: Record<ClickaaIconName, IconGeometry> = {
  play: {
    paths: ["M8.2 5.1 19 12 8.2 18.9Z"],
    mode: "fill",
  },
  pause: {
    paths: ["M7.4 5h3.1v14H7.4Z", "M13.5 5h3.1v14h-3.1Z"],
    mode: "fill",
  },
  next: {
    paths: ["M6.4 5.4 15.2 12l-8.8 6.6Z", "M16.6 5.4h2.1v13.2h-2.1Z"],
    mode: "fill",
  },
  previous: {
    paths: ["M17.6 5.4 8.8 12l8.8 6.6Z", "M5.3 5.4h2.1v13.2H5.3Z"],
    mode: "fill",
  },
  close: {
    paths: ["M6.2 6.2 17.8 17.8", "M17.8 6.2 6.2 17.8"],
    mode: "stroke",
  },
  check: {
    paths: ["M4.8 12.6 9.6 17.4 19.2 6.8"],
    mode: "stroke",
  },
  microphone: {
    paths: [
      "M12 3.6a2.9 2.9 0 0 1 2.9 2.9v5a2.9 2.9 0 0 1-5.8 0v-5A2.9 2.9 0 0 1 12 3.6Z",
      "M6.4 11.6a5.6 5.6 0 0 0 11.2 0",
      "M12 17.2v3.2",
    ],
    mode: "stroke",
  },
  copy: {
    paths: ["M9.2 9.4h10.4V20H9.2Z", "M5.6 14.6V4h10.4"],
    mode: "stroke",
  },
  undo: {
    paths: ["M9.4 7.8h6.2a4.4 4.4 0 0 1 0 8.8H8.4", "M12.2 4.6 8.6 7.8l3.6 3.2"],
    mode: "stroke",
  },
};

const svgNamespace = "http://www.w3.org/2000/svg";
const iconCanvasSize = 24;

/**
 * Builds one icon. The returned element inherits `currentColor`, so a button
 * only has to change its own colour.
 */
export function createClickaaIcon(
  iconName: ClickaaIconName,
  sizePixels = 16,
  className = "",
): SVGSVGElement {
  const iconGeometry = iconGeometries[iconName];
  const iconElement = document.createElementNS(svgNamespace, "svg");
  iconElement.setAttribute("viewBox", `0 0 ${iconCanvasSize} ${iconCanvasSize}`);
  iconElement.setAttribute("width", String(sizePixels));
  iconElement.setAttribute("height", String(sizePixels));
  iconElement.setAttribute("aria-hidden", "true");
  iconElement.setAttribute("focusable", "false");
  iconElement.classList.add("clickaa-icon");
  if (sizePixels <= 14) {
    iconElement.classList.add("size-sm");
  } else if (sizePixels >= 20) {
    iconElement.classList.add("size-lg");
  }
  if (className) {
    iconElement.classList.add(className);
  }

  for (const pathCommands of iconGeometry.paths) {
    const pathElement = document.createElementNS(svgNamespace, "path");
    pathElement.setAttribute("d", pathCommands);
    if (iconGeometry.mode === "fill") {
      pathElement.setAttribute("fill", "currentColor");
    } else {
      pathElement.setAttribute("fill", "none");
      pathElement.setAttribute("stroke", "currentColor");
      pathElement.setAttribute("stroke-width", "1.7");
      pathElement.setAttribute("stroke-linecap", "round");
      pathElement.setAttribute("stroke-linejoin", "round");
    }
    iconElement.append(pathElement);
  }

  return iconElement;
}

/**
 * Replaces a button's contents with one icon and gives it an accessible name,
 * which is how every icon-only control in Clickaa is built.
 */
export function setIconButton(
  button: HTMLButtonElement,
  iconName: ClickaaIconName,
  accessibleLabel: string,
  sizePixels = 16,
): void {
  button.replaceChildren(createClickaaIcon(iconName, sizePixels));
  button.setAttribute("aria-label", accessibleLabel);
  button.title = accessibleLabel;
}

/** Swaps only the glyph, for controls whose meaning changes (play ↔ pause). */
export function updateIconButton(
  button: HTMLButtonElement,
  iconName: ClickaaIconName,
  accessibleLabel: string,
  sizePixels = 16,
): void {
  setIconButton(button, iconName, accessibleLabel, sizePixels);
}
