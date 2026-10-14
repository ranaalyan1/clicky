import { randomBytes } from "node:crypto";
import { JsonFileStore } from "./json-file-store";

/**
 * The pairing state for the phone window: the secret that proves a request came
 * from a phone the user paired, and the port the window is reachable on.
 *
 * The token lives in its own file rather than in the settings so it is never
 * exported with them, and rotating it is one button rather than a settings
 * migration.
 */

const defaultPhoneBridgePort = 47_821;

export interface PhoneBridgeRecord {
  token: string;
  port: number;
}

function createPairingToken(): string {
  // 24 random bytes, url-safe. Long enough that guessing is not a strategy, and
  // short enough that the address stays pasteable.
  return randomBytes(24).toString("base64url");
}

function sanitizePhoneBridgeRecord(storedValue: unknown): PhoneBridgeRecord | null {
  if (!storedValue || typeof storedValue !== "object") {
    return null;
  }

  const possibleRecord = storedValue as Partial<PhoneBridgeRecord>;
  if (typeof possibleRecord.token !== "string" || possibleRecord.token.length < 16) {
    return null;
  }

  const port = Number.isInteger(possibleRecord.port) && (possibleRecord.port as number) > 0 && (possibleRecord.port as number) < 65_536
    ? (possibleRecord.port as number)
    : defaultPhoneBridgePort;

  return { token: possibleRecord.token, port };
}

export class PhoneBridgeStore {
  private readonly fileStore: JsonFileStore<PhoneBridgeRecord | null>;
  private record: PhoneBridgeRecord | null;

  constructor(filePath: string) {
    this.fileStore = new JsonFileStore(filePath, sanitizePhoneBridgeRecord);
    this.record = this.fileStore.read();
  }

  /** The pairing details, creating a token the first time they are asked for. */
  read(): PhoneBridgeRecord {
    if (!this.record) {
      this.record = { token: createPairingToken(), port: defaultPhoneBridgePort };
      this.fileStore.write(this.record);
    }
    return { ...this.record };
  }

  /** Throws the old link away: any phone still holding it stops working. */
  rotateToken(): PhoneBridgeRecord {
    const currentRecord = this.read();
    this.record = { ...currentRecord, token: createPairingToken() };
    this.fileStore.write(this.record);
    return { ...this.record };
  }

  setPort(port: number): void {
    const currentRecord = this.read();
    this.record = { ...currentRecord, port };
    this.fileStore.write(this.record);
  }

  clear(): void {
    this.record = null;
    this.fileStore.write(null);
  }
}

export { defaultPhoneBridgePort };
