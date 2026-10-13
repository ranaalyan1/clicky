import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Small atomic JSON persistence helper shared by Clickaa's stores.
 *
 * Windows will not reliably replace an existing file with `renameSync`, so the
 * complete temporary file is written first and the destination is removed only
 * afterwards. A crash therefore never leaves a half-written store behind.
 */
export class JsonFileStore<TValue> {
  constructor(
    private readonly filePath: string,
    private readonly sanitizeStoredValue: (storedValue: unknown) => TValue,
  ) {}

  read(): TValue {
    try {
      const serializedValue = readFileSync(this.filePath, "utf8");
      return this.sanitizeStoredValue(JSON.parse(serializedValue) as unknown);
    } catch {
      return this.sanitizeStoredValue(null);
    }
  }

  write(value: TValue): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryFilePath = `${this.filePath}.tmp`;
    writeFileSync(temporaryFilePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    rmSync(this.filePath, { force: true });
    renameSync(temporaryFilePath, this.filePath);
  }
}
