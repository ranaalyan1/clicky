import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const windowsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(
  readFileSync(resolve(windowsDirectory, "package.json"), "utf8"),
);
const expectedReleaseTag = `windows-v${packageManifest.version}`;
const expectedInstallers = [
  `Clickaa-Setup-${packageManifest.version}-arm64.exe`,
  `Clickaa-Setup-${packageManifest.version}-x64.exe`,
];
const actualInstallers = readdirSync(resolve(windowsDirectory, "release"))
  .filter((fileName) => /^Clickaa-Setup-.*\.exe$/u.test(fileName))
  .sort();

const problems = [];
if (
  actualInstallers.length !== expectedInstallers.length ||
  actualInstallers.some(
    (fileName, index) => fileName !== expectedInstallers[index],
  )
) {
  problems.push(
    `expected ${expectedInstallers.join(", ")}; found ${actualInstallers.join(", ") || "none"}`,
  );
}

const releaseTag = process.env.RELEASE_TAG?.trim();
if (releaseTag && releaseTag !== expectedReleaseTag) {
  problems.push(
    `release tag ${releaseTag} does not match package tag ${expectedReleaseTag}`,
  );
}

if (problems.length > 0) {
  const message = problems.join("; ");
  if (process.env.GITHUB_ACTIONS === "true") {
    console.error(`::error title=Invalid Windows release outputs::${message}`);
  }
  throw new Error(message);
}

console.log(`Validated Windows installers: ${actualInstallers.join(", ")}`);
