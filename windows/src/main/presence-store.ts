/**
 * The memory of what Ustaad already said.
 *
 * Without this, a restart at 09:00 would deliver the 08:30 brief a second time.
 * The file is small on purpose: one date key per check-in kind, plus the last
 * thing it said, so the island can show it after a restart too.
 */

import type { PresenceCheckInKind, PresenceCheckInRecord } from "../shared/contracts";
import { JsonFileStore } from "./json-file-store";
import { localDateKey, presenceCheckInKinds } from "./presence-schedule";

export interface StoredPresenceState {
  lastCompletedDateKeys: Partial<Record<PresenceCheckInKind, string>>;
  lastCheckIn: PresenceCheckInRecord | null;
}

function isPresenceCheckInKind(candidate: unknown): candidate is PresenceCheckInKind {
  return typeof candidate === "string" && (presenceCheckInKinds as readonly string[]).includes(candidate);
}

function readString(candidate: unknown): string {
  return typeof candidate === "string" ? candidate : "";
}

function sanitizeLastCheckIn(candidate: unknown): PresenceCheckInRecord | null {
  if (typeof candidate !== "object" || candidate === null) {
    return null;
  }

  const possibleRecord = candidate as Partial<PresenceCheckInRecord>;
  if (!isPresenceCheckInKind(possibleRecord.kind)) {
    return null;
  }

  const ranAtIso = readString(possibleRecord.ranAtIso);
  if (!ranAtIso) {
    return null;
  }

  return {
    kind: possibleRecord.kind,
    title: readString(possibleRecord.title),
    summary: readString(possibleRecord.summary),
    ranAtIso,
  };
}

export function sanitizeStoredPresenceState(candidate: unknown): StoredPresenceState {
  const possibleState = (typeof candidate === "object" && candidate !== null ? candidate : {}) as Partial<StoredPresenceState>;

  const lastCompletedDateKeys: Partial<Record<PresenceCheckInKind, string>> = {};
  const possibleDateKeys = typeof possibleState.lastCompletedDateKeys === "object" && possibleState.lastCompletedDateKeys !== null
    ? possibleState.lastCompletedDateKeys
    : {};
  for (const kind of presenceCheckInKinds) {
    const dateKey = readString((possibleDateKeys as Partial<Record<PresenceCheckInKind, unknown>>)[kind]);
    if (dateKey) {
      lastCompletedDateKeys[kind] = dateKey;
    }
  }

  return {
    lastCompletedDateKeys,
    lastCheckIn: sanitizeLastCheckIn(possibleState.lastCheckIn),
  };
}

export class PresenceStore {
  private readonly jsonFileStore: JsonFileStore<StoredPresenceState>;

  constructor(filePath: string) {
    this.jsonFileStore = new JsonFileStore(filePath, sanitizeStoredPresenceState);
  }

  lastCompletedDateKeys(): Partial<Record<PresenceCheckInKind, string>> {
    return this.jsonFileStore.read().lastCompletedDateKeys;
  }

  lastCheckIn(): PresenceCheckInRecord | null {
    return this.jsonFileStore.read().lastCheckIn;
  }

  markCheckInDelivered(checkInRecord: PresenceCheckInRecord, deliveredOn: Date): void {
    const currentState = this.jsonFileStore.read();
    this.jsonFileStore.write({
      lastCompletedDateKeys: {
        ...currentState.lastCompletedDateKeys,
        [checkInRecord.kind]: localDateKey(deliveredOn),
      },
      lastCheckIn: checkInRecord,
    });
  }
}
