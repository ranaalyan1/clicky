import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** The files the pre-rename Clicky client kept in its own user-data folder. */
const legacyFileNameList = [
  "settings.json",
  "todos.json",
  "memory.json",
  "schedules.json",
  "clipboard-history.json",
];

const legacyApplicationFolderName = "Clicky";

/**
 * Clickaa was called Clicky until the rename. Copying (never moving) the old
 * files means an installed client keeps its Worker URL, to-do list and settings
 * without the user retyping anything.
 */
export function migrateLegacyClickyUserData(appDataDirectory: string, userDataDirectory: string): void {
  const legacyDirectory = join(appDataDirectory, legacyApplicationFolderName);
  if (legacyDirectory === userDataDirectory || !existsSync(legacyDirectory)) {
    return;
  }

  try {
    mkdirSync(userDataDirectory, { recursive: true });
    for (const legacyFileName of legacyFileNameList) {
      const legacyFilePath = join(legacyDirectory, legacyFileName);
      const destinationFilePath = join(userDataDirectory, legacyFileName);
      if (existsSync(legacyFilePath) && !existsSync(destinationFilePath)) {
        copyFileSync(legacyFilePath, destinationFilePath);
      }
    }
  } catch (error) {
    console.warn("Clickaa could not import the old Clicky settings:", error);
  }
}
