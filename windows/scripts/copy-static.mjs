import { cp, mkdir, rm } from "node:fs/promises";

const projectRoot = new URL("../", import.meta.url);
const rendererSource = new URL("src/renderer/", projectRoot);
const compiledRendererSource = new URL(".renderer-build/src/renderer/", projectRoot);
const rendererDestination = new URL("dist/src/renderer/", projectRoot);
const assetSource = new URL("assets/", projectRoot);
const assetDestination = new URL("dist/assets/", projectRoot);

await mkdir(rendererDestination, { recursive: true });
await mkdir(assetDestination, { recursive: true });
await cp(compiledRendererSource, rendererDestination, { recursive: true });

// Every renderer window is plain HTML + CSS referenced by the compiled modules.
const rendererStaticFileNames = [
  "panel.html",
  "panel.css",
  "overlay.html",
  "overlay.css",
  "island.html",
  "island.css",
  "selection.html",
  "selection.css",
];

for (const fileName of rendererStaticFileNames) {
  await cp(new URL(fileName, rendererSource), new URL(fileName, rendererDestination));
}

await cp(assetSource, assetDestination, { recursive: true });
await rm(new URL(".renderer-build/", projectRoot), { recursive: true, force: true });
