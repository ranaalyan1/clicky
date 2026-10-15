import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The identity is a handful of rendered files plus a token vocabulary, and both
 * break in ways no type check notices: an icon can be regenerated with the wrong
 * sizes and still build, a stylesheet can reference a token that was renamed and
 * still compile. These assertions read the real files instead of trusting them.
 *
 * The renders themselves come from assets/ustaad-mark.svg and
 * assets/ustaad-mark-light.svg, so a failure here means either an asset was
 * regenerated wrong or a stylesheet drifted from tokens.css.
 */

const rendererDirectory = join(__dirname, "..", "..", "src", "renderer");
const assetDirectory = join(__dirname, "..", "..", "assets");

const styleSheetNames = [
  "tokens.css",
  "brand.css",
  "panel.css",
  "overlay.css",
  "island.css",
  "selection.css",
] as const;

function readAsset(fileName: string): Buffer {
  return readFileSync(join(assetDirectory, fileName));
}

function readStyleSheet(fileName: string): string {
  return readFileSync(join(rendererDirectory, fileName), "utf8");
}

/** Reads the pixel size out of a PNG's IHDR chunk, which is always first. */
function readPngSize(fileName: string): { width: number; height: number } {
  const bytes = readAsset(fileName);
  assert.equal(
    bytes.subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
    `${fileName} is not a PNG`,
  );
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("identity assets", () => {
  it("ships an installer icon with every size Windows asks for", () => {
    const bytes = readAsset("icon.ico");
    assert.equal(bytes.readUInt16LE(0), 0, "the reserved field should be zero");
    assert.equal(bytes.readUInt16LE(2), 1, "that file is not an icon");
    const imageCount = bytes.readUInt16LE(4);
    const sizes: number[] = [];
    for (let index = 0; index < imageCount; index += 1) {
      // ICO stores 256 as a zero byte, because the field is one byte wide.
      const widthByte = bytes[6 + index * 16] ?? 0;
      sizes.push(widthByte === 0 ? 256 : widthByte);
    }
    assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256]);
  });

  it("keeps each render at the size the app draws it at", () => {
    assert.deepEqual(readPngSize("icon.png"), { width: 512, height: 512 });
    assert.deepEqual(readPngSize("ustaad-mark-64.png"), { width: 64, height: 64 });
    assert.deepEqual(readPngSize("ustaad-mark-transparent.png"), { width: 512, height: 512 });

    const tray = readPngSize("tray.png");
    assert.equal(tray.width, tray.height, "the tray icon has to stay square");
    assert.ok(
      tray.width <= 64,
      `the tray icon is ${tray.width}px, which the shell will only squash`,
    );
  });

  it("inlines the same sixty-four pixel mark the renderer draws", () => {
    const brand = readStyleSheet("brand.css");
    const encoded = /url\("data:image\/png;base64,([A-Za-z0-9+/=]+)"\)/.exec(brand);
    assert.ok(encoded, "brand.css no longer inlines the mark");

    const decoded = Buffer.from(encoded?.[1] ?? "", "base64");
    assert.equal(decoded.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(decoded.readUInt32BE(16), 64);
    assert.equal(decoded.readUInt32BE(20), 64);
  });

  it("keeps Hitodama's four soul slots visible on the home surface", () => {
    const panel = readFileSync(join(rendererDirectory, "panel.html"), "utf8");
    assert.match(panel, /class="soul-flame"/u);
    assert.match(panel, /class="[^"]*\bsoul-card\b/u);
    for (const slot of ["Soul", "Personality", "Voice", "Abilities"]) {
      assert.match(panel, new RegExp(`<small>${slot}</small>`, "u"), `missing ${slot} slot`);
    }
    assert.match(readStyleSheet("panel.css"), /\.soul-card\s*\{/u);
    assert.match(readFileSync(join(assetDirectory, "ustaad-mark.svg"), "utf8"), /Hitodama.*ember/isu);
  });
});

describe("style sheets", () => {
  it("defines every token the interface uses", () => {
    const sheets = new Map(styleSheetNames.map((name) => [name, readStyleSheet(name)]));

    const defined = new Set<string>();
    for (const text of sheets.values()) {
      for (const definition of text.matchAll(/(--[a-z0-9-]+)\s*:/gi)) {
        defined.add(definition[1] ?? "");
      }
    }

    const missing: string[] = [];
    for (const [name, text] of sheets) {
      for (const usage of text.matchAll(/var\((--[a-z0-9-]+)/gi)) {
        const tokenName = usage[1] ?? "";
        if (!defined.has(tokenName)) {
          missing.push(`${name} uses ${tokenName}`);
        }
      }
    }

    assert.deepEqual(missing, [], "tokens used but never defined");
  });

  it("keeps to one accent: nothing still paints with the retired azure", () => {
    const retiredAzure = /#4596ff|#7db8ff|#2f7ae0|#5ea6ff|rgba\(69,\s*150,\s*255|rgba\(90,\s*162,\s*255/i;
    for (const name of styleSheetNames) {
      assert.ok(
        !retiredAzure.test(readStyleSheet(name)),
        `${name} still paints with the retired blue accent`,
      );
    }
  });
});
