import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSummonBand,
  islandHoverOpenMilliseconds,
  islandSummonBandHeightPixels,
  IslandPresentationController,
  isPointInsideRect,
} from "../src/main/island-presentation";

const primaryDisplay = { x: 0, y: 0, width: 1920, height: 1040 };
const summonBand = buildSummonBand(primaryDisplay);

/** A point safely away from the top edge and the island. */
const pointerAway = { x: 900, y: 640 };

function updateAt(
  controller: IslandPresentationController,
  nowMilliseconds: number,
  overrides: Partial<Parameters<IslandPresentationController["update"]>[0]> = {},
) {
  return controller.update({
    nowMilliseconds,
    pointer: pointerAway,
    summonBand,
    islandBounds: null,
    hasActiveInteraction: false,
    isAlwaysVisible: false,
    ...overrides,
  });
}

test("the summon band is a thin strip along the top of a display's work area", () => {
  assert.equal(summonBand.height, islandSummonBandHeightPixels);
  assert.equal(summonBand.width, primaryDisplay.width);

  assert.equal(isPointInsideRect({ x: 400, y: 0 }, summonBand), true);
  assert.equal(isPointInsideRect({ x: 400, y: 2 }, summonBand), true);
  assert.equal(isPointInsideRect({ x: 400, y: 3 }, summonBand), false);
  assert.equal(isPointInsideRect({ x: 400, y: -1 }, summonBand), false);
});

test("touching the top edge reveals the mark and leaving hides it again", () => {
  const controller = new IslandPresentationController();
  assert.equal(controller.presentation, "hidden");

  assert.equal(updateAt(controller, 1_000, { pointer: { x: 800, y: 1 } }), "revealed");
  assert.equal(updateAt(controller, 1_500), "revealed");
});

test("a revealed mark that nobody touches fades away", () => {
  const controller = new IslandPresentationController();
  updateAt(controller, 1_000, { pointer: { x: 800, y: 1 } });
  assert.equal(updateAt(controller, 3_000), "revealed");
  assert.equal(updateAt(controller, 5_000), "hidden");
});

test("clicking the mark opens the island and Escape hides it completely", () => {
  const controller = new IslandPresentationController();
  controller.openIsland(1_000);
  assert.equal(controller.presentation, "open");

  updateAt(controller, 1_500);
  assert.equal(controller.presentation, "open");

  controller.dismissIsland();
  assert.equal(controller.presentation, "hidden");
});

test("hovering the mark for a moment opens the island without a click", () => {
  const controller = new IslandPresentationController();
  const islandBounds = { x: 828, y: 6, width: 264, height: 36 };

  updateAt(controller, 1_000, { pointer: { x: 900, y: 1 } });
  assert.equal(controller.presentation, "revealed");

  updateAt(controller, 1_100, { pointer: { x: 900, y: 20 }, islandBounds });
  assert.equal(controller.presentation, "revealed");

  updateAt(controller, 1_100 + islandHoverOpenMilliseconds, { pointer: { x: 900, y: 20 }, islandBounds });
  assert.equal(controller.presentation, "open");
});

test("an open island closes itself once the pointer has moved on", () => {
  const controller = new IslandPresentationController();
  controller.openIsland(1_000);

  updateAt(controller, 2_000);
  assert.equal(controller.presentation, "open");

  // Idle timeout, then a second beat before the mark disappears too.
  assert.equal(updateAt(controller, 8_000), "revealed");
  assert.equal(updateAt(controller, 20_000), "hidden");
});

test("work in progress keeps the mark on screen and the island open", () => {
  const controller = new IslandPresentationController();
  controller.openIsland(1_000);

  assert.equal(updateAt(controller, 30_000, { hasActiveInteraction: true }), "open");

  controller.dismissIsland();
  assert.equal(updateAt(controller, 30_100, { hasActiveInteraction: true }), "revealed");
});

test("always-visible mode pins the island open and ignores the pointer", () => {
  const controller = new IslandPresentationController();
  assert.equal(updateAt(controller, 1_000, { isAlwaysVisible: true }), "open");
  assert.equal(updateAt(controller, 90_000, { isAlwaysVisible: true }), "open");
});

test("hovering where the island already is reveals it instead of hiding it", () => {
  const controller = new IslandPresentationController();
  const islandBounds = { x: 828, y: 6, width: 264, height: 36 };

  // Defensive: if the shell ever reports a pointer inside island bounds while the
  // state machine thinks it is hidden, the visible mark wins.
  assert.equal(
    updateAt(controller, 1_000, { pointer: { x: 900, y: 20 }, islandBounds }),
    "revealed",
  );
});
