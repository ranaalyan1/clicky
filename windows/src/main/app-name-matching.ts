import { normalizeForMatch, RankedTextMatch, scoreTextMatch } from "./text-matching";

export type LaunchableAppSource = "startMenu" | "uwp" | "alias";

export interface LaunchableApp {
  id: string;
  /** The name shown to the user, normally the shortcut's file name. */
  name: string;
  source: LaunchableAppSource;
  /** A `.lnk`/`.exe` path, or an Application User Model ID for Store apps. */
  launchTarget: string;
}

/**
 * Everyday words people actually say, mapped to the app names Windows ships.
 * Aliases score just below an exact name match so a real app named "Browser"
 * still wins over the alias.
 */
export const builtInAppAliases: Array<{ spokenNames: string[]; appNames: string[] }> = [
  { spokenNames: ["browser", "the browser", "web", "internet"], appNames: ["Google Chrome", "Microsoft Edge", "Mozilla Firefox", "Brave", "Opera"] },
  { spokenNames: ["chrome", "google chrome"], appNames: ["Google Chrome"] },
  { spokenNames: ["edge"], appNames: ["Microsoft Edge"] },
  { spokenNames: ["firefox"], appNames: ["Mozilla Firefox"] },
  { spokenNames: ["terminal", "console", "command prompt", "cmd", "shell", "powershell"], appNames: ["Windows Terminal", "Windows PowerShell", "Command Prompt", "PowerShell"] },
  { spokenNames: ["files", "file explorer", "explorer", "my files", "this pc"], appNames: ["File Explorer", "Explorer"] },
  { spokenNames: ["calculator", "calc"], appNames: ["Calculator"] },
  { spokenNames: ["code editor", "code", "vs code", "vscode", "visual studio code"], appNames: ["Visual Studio Code"] },
  { spokenNames: ["visual studio"], appNames: ["Visual Studio 2022", "Visual Studio"] },
  { spokenNames: ["settings", "pc settings"], appNames: ["Settings"] },
  { spokenNames: ["music", "spotify", "spotify music"], appNames: ["Spotify"] },
  { spokenNames: ["camera"], appNames: ["Camera"] },
  { spokenNames: ["paint", "ms paint"], appNames: ["Paint"] },
  { spokenNames: ["notepad", "text editor", "notes"], appNames: ["Notepad"] },
  { spokenNames: ["word", "microsoft word"], appNames: ["Word", "Microsoft Word"] },
  { spokenNames: ["excel", "spreadsheet"], appNames: ["Excel", "Microsoft Excel"] },
  { spokenNames: ["powerpoint", "slides"], appNames: ["PowerPoint", "Microsoft PowerPoint"] },
  { spokenNames: ["outlook", "email", "mail"], appNames: ["Outlook", "Microsoft Outlook"] },
  { spokenNames: ["teams", "microsoft teams"], appNames: ["Microsoft Teams"] },
  { spokenNames: ["discord"], appNames: ["Discord"] },
  { spokenNames: ["steam"], appNames: ["Steam"] },
  { spokenNames: ["task manager"], appNames: ["Task Manager"] },
  { spokenNames: ["snipping tool", "screenshot tool", "screen snip"], appNames: ["Snipping Tool"] },
  { spokenNames: ["photos", "photo viewer"], appNames: ["Photos"] },
  { spokenNames: ["store", "app store", "microsoft store"], appNames: ["Microsoft Store"] },
  { spokenNames: ["unity"], appNames: ["Unity Hub", "Unity"] },
];

const aliasAppNamesFor = (normalizedSpokenName: string): string[] => {
  const matchedAliases = builtInAppAliases.filter((aliasDefinition) =>
    aliasDefinition.spokenNames.some(
      (spokenName) => normalizeForMatch(spokenName) === normalizedSpokenName,
    ));
  return matchedAliases.flatMap((aliasDefinition) => aliasDefinition.appNames);
};

const describesAlias = (normalizedSpokenName: string, candidateAppName: string): boolean => {
  return aliasAppNamesFor(normalizedSpokenName).some(
    (aliasAppName) => scoreTextMatch(aliasAppName, candidateAppName) >= 700,
  );
};

/** Higher is better. Exact names win, then aliases, then partial text matches. */
export function scoreAppMatch(spokenAppName: string, launchableApp: LaunchableApp): number {
  const normalizedSpokenName = normalizeForMatch(spokenAppName);
  if (!normalizedSpokenName) {
    return 0;
  }

  const directScore = scoreTextMatch(spokenAppName, launchableApp.name);
  if (directScore >= 1000) {
    return 1_000;
  }

  if (describesAlias(normalizedSpokenName, launchableApp.name)) {
    // An alias hit beats an incidental substring hit, but not the real name.
    return 850 + Math.min(40, directScore / 25);
  }

  // Shortcuts often carry suffixes such as "Google Chrome.lnk" or add "(x64)".
  const withoutFileDecorations = launchableApp.name
    .replace(/\.lnk$/iu, "")
    .replace(/\(x64\)|\(x86\)|\((32|64)-bit\)/giu, "");
  return Math.max(directScore, scoreTextMatch(spokenAppName, withoutFileDecorations));
}

export function rankAppMatches(
  spokenAppName: string,
  launchableApps: LaunchableApp[],
  limit = 5,
): Array<RankedTextMatch<LaunchableApp>> {
  return launchableApps
    .map((launchableApp) => ({
      item: launchableApp,
      score: scoreAppMatch(spokenAppName, launchableApp),
    }))
    .filter((rankedMatch) => rankedMatch.score > 0)
    .sort((firstMatch, secondMatch) => {
      if (secondMatch.score !== firstMatch.score) {
        return secondMatch.score - firstMatch.score;
      }
      // Prefer the shortest, most generic name when scores tie ("Spotify" over
      // "Spotify Installer"), then the most useful source.
      const firstSourcePriority = firstMatch.item.source === "startMenu" ? 0 : 1;
      const secondSourcePriority = secondMatch.item.source === "startMenu" ? 0 : 1;
      return firstMatch.item.name.length - secondMatch.item.name.length
        || firstSourcePriority - secondSourcePriority;
    })
    .slice(0, limit);
}

/** De-duplicates apps that appear as both a Start Menu shortcut and a Store app. */
export function deduplicateLaunchableApps(launchableApps: LaunchableApp[]): LaunchableApp[] {
  const appsByNormalizedId = new Map<string, LaunchableApp>();
  for (const launchableApp of launchableApps) {
    const appKey = `${normalizeForMatch(launchableApp.name)}|${launchableApp.launchTarget.toLowerCase()}`;
    if (!appsByNormalizedId.has(appKey)) {
      appsByNormalizedId.set(appKey, launchableApp);
    }
  }
  return [...appsByNormalizedId.values()];
}

/**
 * True when the top two candidates are close enough that launching the wrong
 * one is likely. Ustaad asks the user instead of guessing.
 */
export function isAppChoiceAmbiguous(rankedMatches: Array<RankedTextMatch<LaunchableApp>>): boolean {
  const [bestMatch, secondMatch] = rankedMatches;
  if (!bestMatch || !secondMatch) {
    return false;
  }
  if (bestMatch.score >= 1_000) {
    return false;
  }
  return secondMatch.score >= bestMatch.score - 20;
}
