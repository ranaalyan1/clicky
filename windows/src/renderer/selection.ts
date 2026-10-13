import type { SelectionBoundsPayload } from "../shared/contracts";

/** A selection smaller than this reads as a stray click, not a circle. */
const minimumSelectionSizePixels = 12;

const queryParameters = new URLSearchParams(window.location.search);

function requireElement<ElementType extends HTMLElement>(elementId: string): ElementType {
  const element = document.getElementById(elementId);
  if (!element) {
    throw new Error(`Missing required selection element #${elementId}`);
  }
  return element as ElementType;
}

const selectionRect = requireElement<HTMLElement>("selection-rect");
const selectionSizeLabel = requireElement<HTMLElement>("selection-size-label");
const hintText = requireElement<HTMLElement>("hint-text");

hintText.textContent = queryParameters.get("hint") || "drag around anything, then let go";

let dragStartPoint: { x: number; y: number } | null = null;
let hasCompletedSelection = false;

function normalizeSelection(startPoint: { x: number; y: number }, endPoint: { x: number; y: number }): SelectionBoundsPayload {
  return {
    x: Math.min(startPoint.x, endPoint.x),
    y: Math.min(startPoint.y, endPoint.y),
    width: Math.abs(endPoint.x - startPoint.x),
    height: Math.abs(endPoint.y - startPoint.y),
  };
}

function renderSelection(selectionBounds: SelectionBoundsPayload): void {
  selectionRect.hidden = false;
  selectionRect.style.left = `${selectionBounds.x}px`;
  selectionRect.style.top = `${selectionBounds.y}px`;
  selectionRect.style.width = `${selectionBounds.width}px`;
  selectionRect.style.height = `${selectionBounds.height}px`;
  selectionSizeLabel.textContent = `${Math.round(selectionBounds.width)} × ${Math.round(selectionBounds.height)}`;
}

function clearSelection(): void {
  dragStartPoint = null;
  selectionRect.hidden = true;
}

window.addEventListener("pointerdown", (pointerEvent) => {
  if (pointerEvent.button !== 0) {
    return;
  }

  pointerEvent.preventDefault();
  dragStartPoint = { x: pointerEvent.clientX, y: pointerEvent.clientY };
  renderSelection({ x: pointerEvent.clientX, y: pointerEvent.clientY, width: 0, height: 0 });
});

window.addEventListener("pointermove", (pointerEvent) => {
  if (!dragStartPoint) {
    return;
  }

  renderSelection(normalizeSelection(dragStartPoint, { x: pointerEvent.clientX, y: pointerEvent.clientY }));
});

window.addEventListener("pointerup", (pointerEvent) => {
  if (!dragStartPoint || hasCompletedSelection) {
    return;
  }

  const selectionBounds = normalizeSelection(dragStartPoint, { x: pointerEvent.clientX, y: pointerEvent.clientY });
  clearSelection();

  if (selectionBounds.width < minimumSelectionSizePixels || selectionBounds.height < minimumSelectionSizePixels) {
    // A bare click inside the dimmed layer means "never mind".
    hasCompletedSelection = true;
    window.clickaa.sendSelectionCancelled();
    return;
  }

  hasCompletedSelection = true;
  window.clickaa.sendSelectionCompleted(selectionBounds);
});

window.addEventListener("keydown", (keyboardEvent) => {
  if (keyboardEvent.key === "Escape") {
    cancelSelection();
  }
});

window.addEventListener("blur", () => {
  // The selector is not focusable, so losing focus means the user moved on.
  if (!hasCompletedSelection && dragStartPoint) {
    clearSelection();
  }
});

function cancelSelection(): void {
  if (hasCompletedSelection) {
    return;
  }
  hasCompletedSelection = true;
  clearSelection();
  window.clickaa.sendSelectionCancelled();
}

document.addEventListener("contextmenu", (contextMenuEvent) => contextMenuEvent.preventDefault());
