import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { LaunchableAppView } from "../shared/contracts";
import { deduplicateLaunchableApps, LaunchableApp, rankAppMatches } from "./app-name-matching";
import { ClickaaWindowsBridge } from "./windows-bridge";

/** Names Windows hides in the Start Menu that are never what someone means. */
const ignoredShortcutFragments = [
  "uninstall",
  "readme",
  "remove ",
  "help",
  "documentation",
  "website",
  "manual",
  "release notes",
  "license",
];

/** The apps people actually ask for, in the order the island shows them. */
const quickLaunchAppNames = [
  "Google Chrome",
  "Microsoft Edge",
  "Firefox",
  "Windows Terminal",
  "Visual Studio Code",
  "Spotify",
  "Discord",
  "Steam",
  "Notepad",
  "Calculator",
  "File Explorer",
  "Outlook",
  "Microsoft Teams",
  "Slack",
  "Zoom",
  "Word",
  "Excel",
  "Photos",
  "Settings",
  "Snipping Tool",
];

/**
 * Everything Clickaa can launch: Start Menu shortcuts plus Windows Store apps.
 * The index is built once at start-up and refreshed when the user asks for it.
 */
export class StartMenuAppIndex {
  private launchableApps: LaunchableApp[] = [];
  private storeAppRecordsAppIdByName = new Map<string, string>();
  private hasLoaded = false;

  constructor(private readonly bridge: ClickaaWindowsBridge) {}

  list(): LaunchableApp[] {
    return [...this.launchableApps];
  }

  get hasIndex(): boolean {
    return this.hasLoaded;
  }

  async refresh(): Promise<number> {
    const startMenuApps = this.readStartMenuShortcuts();
    const storeApps = await this.readStoreApps();

    this.launchableApps = deduplicateLaunchableApps([...startMenuApps, ...storeApps]);
    this.hasLoaded = true;
    return this.launchableApps.length;
  }

  findMatches(spokenAppName: string, limit = 4): LaunchableApp[] {
    return rankAppMatches(spokenAppName, this.launchableApps, limit).map(
      (rankedMatch) => rankedMatch.item,
    );
  }

  /** The pinned grid in the island, falling back to A-Z when nothing matches. */
  quickLaunchApps(limit = 8): LaunchableAppView[] {
    const quickLaunchApps: LaunchableAppView[] = [];

    for (const quickLaunchAppName of quickLaunchAppNames) {
      const matchedApp = rankAppMatches(quickLaunchAppName, this.launchableApps, 1)[0]?.item;
      if (matchedApp && !quickLaunchApps.some((quickLaunchApp) => quickLaunchApp.id === matchedApp.id)) {
        quickLaunchApps.push({
          id: matchedApp.id,
          name: matchedApp.name,
          source: matchedApp.source,
          isPinned: true,
        });
      }
      if (quickLaunchApps.length >= limit) {
        break;
      }
    }

    if (quickLaunchApps.length < limit) {
      for (const launchableApp of this.launchableApps) {
        if (quickLaunchApps.length >= limit) {
          break;
        }
        if (!quickLaunchApps.some((quickLaunchApp) => quickLaunchApp.id === launchableApp.id)) {
          quickLaunchApps.push({
            id: launchableApp.id,
            name: launchableApp.name,
            source: launchableApp.source,
            isPinned: false,
          });
        }
      }
    }

    return quickLaunchApps;
  }

  /** Store apps need their Application User Model ID to launch from Electron. */
  storeAppIdForName(appName: string): string | null {
    return this.storeAppRecordsAppIdByName.get(appName) ?? null;
  }

  private readStartMenuShortcuts(): LaunchableApp[] {
    const startMenuDirectories = [
      process.env.APPDATA ? join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs") : "",
      process.env.ProgramData
        ? join(process.env.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs")
        : "",
    ].filter(Boolean);

    const discoveredApps: LaunchableApp[] = [];
    for (const startMenuDirectory of startMenuDirectories) {
      for (const shortcutPath of this.listShortcutPaths(startMenuDirectory, 4)) {
        const shortcutName = shortcutPath.split(/[\\/]/u).pop()!.replace(/\.lnk$/iu, "").trim();
        if (!shortcutName || this.isIgnoredShortcut(shortcutName)) {
          continue;
        }
        discoveredApps.push({
          id: `start-menu:${shortcutPath.toLowerCase()}`,
          name: shortcutName,
          source: "startMenu",
          launchTarget: shortcutPath,
        });
      }
    }

    return discoveredApps;
  }

  private async readStoreApps(): Promise<LaunchableApp[]> {
    if (!this.bridge.isSupported) {
      return [];
    }

    try {
      const storeApps = await this.bridge.listStartMenuApps();
      const discoveredApps: LaunchableApp[] = [];
      for (const storeApp of storeApps) {
        const appName = (storeApp.name ?? "").trim();
        const appId = (storeApp.appId ?? "").trim();
        // Apps without a "!" in the id are classic desktop entries Windows lists
        // alongside Store apps; their Start Menu shortcut already covers them.
        if (!appName || !appId.includes("!")) {
          continue;
        }
        discoveredApps.push({
          id: `uwp:${appId.toLowerCase()}`,
          name: appName,
          source: "uwp",
          launchTarget: appId,
        });
        this.storeAppRecordsAppIdByName.set(appName, appId);
      }
      return discoveredApps;
    } catch (error) {
      console.warn("Clickaa could not read the Windows Store app list:", error);
      return [];
    }
  }

  private listShortcutPaths(directoryPath: string, maximumDepth: number): string[] {
    if (maximumDepth <= 0) {
      return [];
    }

    let directoryEntries: string[];
    try {
      directoryEntries = readdirSync(directoryPath);
    } catch {
      return [];
    }

    const shortcutPaths: string[] = [];
    for (const directoryEntry of directoryEntries) {
      const entryPath = join(directoryPath, directoryEntry);
      let isDirectory = false;
      try {
        isDirectory = statSync(entryPath).isDirectory();
      } catch {
        continue;
      }

      if (isDirectory) {
        shortcutPaths.push(...this.listShortcutPaths(entryPath, maximumDepth - 1));
      } else if (directoryEntry.toLowerCase().endsWith(".lnk")) {
        shortcutPaths.push(entryPath);
      }
    }

    return shortcutPaths;
  }

  private isIgnoredShortcut(shortcutName: string): boolean {
    const normalizedShortcutName = shortcutName.toLowerCase();
    return ignoredShortcutFragments.some((ignoredFragment) => normalizedShortcutName.includes(ignoredFragment));
  }
}
