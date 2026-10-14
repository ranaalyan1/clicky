import { IslandPresentation } from "../shared/contracts";

/**
 * Ustaad's island is summoned, never pinned. These three states are what the
 * user sees:
 *
 * - `hidden`   nothing on screen at all,
 * - `revealed` a small mark peeking out of the top edge, waiting to be clicked,
 * - `open`     the full island.
 */
export interface DesktopPoint {
  x: number;
  y: number;
}

export interface DesktopRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How close to the top edge the pointer must get before the mark slides in. */
export const islandSummonBandHeightPixels = 3;

/** A revealed mark waits this long for a click before sliding away again. */
const revealIdleMilliseconds = 3_500;

/** Dwell time on the mark that opens the island without a click. */
export const islandHoverOpenMilliseconds = 320;

/** An open island with the pointer elsewhere closes itself after this long. */
const openIdleMilliseconds = 6_000;

/** While Ustaad is listening, thinking or acting the mark is never hidden. */
const interactionRevealGraceMilliseconds = 8_000;

export function isPointInsideRect(point: DesktopPoint, rect: DesktopRect | null): boolean {
  if (!rect) {
    return false;
  }
  return point.x >= rect.x
    && point.x < rect.x + rect.width
    && point.y >= rect.y
    && point.y < rect.y + rect.height;
}

/**
 * The summon strip along the top of a display's work area. The work area is used
 * rather than the raw bounds so a taskbar docked at the top keeps working.
 */
export function buildSummonBand(displayWorkArea: DesktopRect): DesktopRect {
  return {
    x: displayWorkArea.x,
    y: displayWorkArea.y,
    width: displayWorkArea.width,
    height: islandSummonBandHeightPixels,
  };
}

export interface IslandPresentationInput {
  nowMilliseconds: number;
  pointer: DesktopPoint;
  /** The summon strip of the display under the pointer, when there is one. */
  summonBand: DesktopRect | null;
  /** Where the collapsed island window currently sits, when it is on screen. */
  islandBounds: DesktopRect | null;
  /** True while Ustaad is listening, thinking, acting or speaking. */
  hasActiveInteraction: boolean;
  /** The user asked for the island to stay open permanently. */
  isAlwaysVisible: boolean;
}

/**
 * Decides when the island is hidden, peeking or open.
 *
 * Everything is derived from input plus the current time so the whole thing is
 * testable without Electron, a mouse, or a display.
 */
export class IslandPresentationController {
  private currentPresentation: IslandPresentation = "hidden";
  private revealDeadlineMilliseconds: number | null = null;
  private openDeadlineMilliseconds: number | null = null;
  private hoverStartedMilliseconds: number | null = null;

  get presentation(): IslandPresentation {
    return this.currentPresentation;
  }

  /** The pointer entered or left the island's own window. */
  notePointerOverIsland(isPointerOverIsland: boolean, nowMilliseconds: number): void {
    this.hoverStartedMilliseconds = isPointerOverIsland ? nowMilliseconds : null;
  }

  /** A click on the mark, a wake word, or anything else that opens it outright. */
  openIsland(nowMilliseconds: number): void {
    this.setPresentation("open");
    this.openDeadlineMilliseconds = nowMilliseconds + openIdleMilliseconds;
    this.revealDeadlineMilliseconds = nowMilliseconds + openIdleMilliseconds;
  }

  /** The user clicked the open island shut: it becomes a mark, then fades. */
  collapseIsland(nowMilliseconds: number): void {
    if (this.currentPresentation === "hidden") {
      return;
    }
    this.setPresentation("revealed");
    this.revealDeadlineMilliseconds = nowMilliseconds + revealIdleMilliseconds;
    this.openDeadlineMilliseconds = null;
    this.hoverStartedMilliseconds = null;
  }

  /** Escape, or the user clicking the island closed. */
  dismissIsland(): void {
    this.setPresentation("hidden");
    this.revealDeadlineMilliseconds = null;
    this.openDeadlineMilliseconds = null;
    this.hoverStartedMilliseconds = null;
  }

  update(input: IslandPresentationInput): IslandPresentation {
    if (input.isAlwaysVisible) {
      this.setPresentation("open");
      this.revealDeadlineMilliseconds = null;
      this.openDeadlineMilliseconds = null;
      return this.currentPresentation;
    }

    if (input.hasActiveInteraction) {
      // Work in progress: the mark stays, and an open island does not close
      // while Ustaad is still talking.
      if (this.currentPresentation === "hidden") {
        this.setPresentation("revealed");
      }
      this.revealDeadlineMilliseconds = Math.max(
        this.revealDeadlineMilliseconds ?? 0,
        input.nowMilliseconds + interactionRevealGraceMilliseconds,
      );
      if (this.currentPresentation === "open") {
        this.openDeadlineMilliseconds = input.nowMilliseconds + openIdleMilliseconds;
      }
      return this.currentPresentation;
    }

    const pointerIsOverIsland = isPointInsideRect(input.pointer, input.islandBounds);

    if (pointerIsOverIsland) {
      if (this.currentPresentation === "hidden") {
        // The island is only on screen if it was revealed, but treat hovering a
        // stale window as a summon so a resize race can never strand it.
        this.setPresentation("revealed");
      }

      if (this.hoverStartedMilliseconds === null) {
        this.hoverStartedMilliseconds = input.nowMilliseconds;
      }
      const hasHoveredLongEnough = input.nowMilliseconds - this.hoverStartedMilliseconds
        >= islandHoverOpenMilliseconds;
      if (this.currentPresentation === "revealed" && hasHoveredLongEnough) {
        this.openIsland(input.nowMilliseconds);
      }
      if (this.currentPresentation === "open") {
        this.openDeadlineMilliseconds = input.nowMilliseconds + openIdleMilliseconds;
      }
      return this.currentPresentation;
    }

    this.hoverStartedMilliseconds = null;

    if (isPointInsideRect(input.pointer, input.summonBand)) {
      if (this.currentPresentation !== "open") {
        if (this.currentPresentation !== "revealed") {
          this.setPresentation("revealed");
        }
        this.revealDeadlineMilliseconds = input.nowMilliseconds + revealIdleMilliseconds;
        return this.currentPresentation;
      }
      this.openDeadlineMilliseconds = input.nowMilliseconds + openIdleMilliseconds;
      return this.currentPresentation;
    }

    if (this.currentPresentation === "open") {
      const openDeadline = this.openDeadlineMilliseconds ?? input.nowMilliseconds;
      if (input.nowMilliseconds >= openDeadline) {
        // Collapse in two beats: full island to mark, then mark to nothing.
        this.setPresentation("revealed");
        this.revealDeadlineMilliseconds = input.nowMilliseconds + revealIdleMilliseconds;
      }
      return this.currentPresentation;
    }

    if (this.currentPresentation === "revealed") {
      const revealDeadline = this.revealDeadlineMilliseconds ?? input.nowMilliseconds;
      if (input.nowMilliseconds >= revealDeadline) {
        this.setPresentation("hidden");
      }
    }

    return this.currentPresentation;
  }

  private setPresentation(nextPresentation: IslandPresentation): void {
    if (this.currentPresentation === nextPresentation) {
      return;
    }
    this.currentPresentation = nextPresentation;
  }
}
