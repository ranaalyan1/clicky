import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** The files an earlier build of this client kept in its own user-data folder. */
const legacyFileNameList = [
  "settings.json",
  "todos.json",
  "memory.json",
  "schedules.json",
  "clipboard-history.json",
  "clipboard-history-store.json",
  "skills.json",
  "skill-suggestions.json",
  "snippets.json",
  "presence.json",
  "audit-log.json",
];

/**
 * Every name this app has been installed under, newest first. The folder name
 * comes from the product name, so each rename moves where the app looks for its
 * own files; without this list, renaming the app would silently look like
 * wiping every setting the user ever set.
 */
const legacyApplicationFolderNames = ["Clickaa", "Clicky"];

/**
 * Ustaad was called Clickaa, and Clicky before that. Copying (never moving) the
 * old files means an installed client keeps its Worker URL, Gemini key, to-do
 * list, saved skills and memory without the user retyping anything, and the old
 * folder stays untouched as a fallback.
 *
 * An existing file always wins, so this cannot overwrite newer settings with
 * older ones on a second launch.
 */
export function migrateLegacyUserData(appDataDirectory: string, userDataDirectory: string): void {
  try {
    mkdirSync(userDataDirectory, { recursive: true });

    for (const legacyApplicationFolderName of legacyApplicationFolderNames) {
      const legacyDirectory = join(appDataDirectory, legacyApplicationFolderName);
      if (legacyDirectory === userDataDirectory || !existsSync(legacyDirectory)) {
        continue;
      }

      for (const legacyFileName of legacyFileNameList) {
        const legacyFilePath = join(legacyDirectory, legacyFileName);
        const destinationFilePath = join(userDataDirectory, legacyFileName);
        if (existsSync(legacyFilePath) && !existsSync(destinationFilePath)) {
          copyFileSync(legacyFilePath, destinationFilePath);
        }
      }
    }
  } catch (error) {
    console.warn("Ustaad could not import settings from an earlier name:", error);
  }
}
