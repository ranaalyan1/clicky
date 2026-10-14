/**
 * When Ustaad wakes up on its own.
 *
 * Everything here is pure: the controller says what time it is and which
 * check-ins already ran, and this module decides what is due. That keeps the
 * behaviour testable without a clock, a window, or a model, and it means a
 * missed check-in cannot be double-delivered by a restart.
 */

import type { PresenceCheckInKind, PresenceSettings } from "../shared/contracts";

/** How late a check-in may fire before it is skipped for the day. */
export const presenceCatchUpWindowMinutes = 240;

/** Past this delay the check-in admits it is late instead of pretending. */
export const presenceLateThresholdMinutes = 30;

export const presenceCheckInKinds = ["morning", "evening"] as const;

export const defaultPresenceSettings: PresenceSettings = {
  morningBriefEnabled: true,
  morningBriefTime: "08:30",
  eveningRecapEnabled: true,
  eveningRecapTime: "20:30",
  speakCheckIns: false,
};

function readBoolean(candidate: unknown, fallbackValue: boolean): boolean {
  return typeof candidate === "boolean" ? candidate : fallbackValue;
}

/**
 * The local calendar day, never UTC: a brief that fires at 08:30 belongs to the
 * day the user is living in, not to whatever day Greenwich is on.
 */
export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseClockTimeToMinutes(clockTime: string): number | null {
  const matchedTime = /^(\d{1,2}):(\d{2})$/.exec(clockTime.trim());
  if (!matchedTime) {
    return null;
  }

  const hours = Number(matchedTime[1]);
  const minutes = Number(matchedTime[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return null;
  }
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes;
}

export function normalizeClockTime(candidate: unknown, fallbackClockTime: string): string {
  if (typeof candidate !== "string") {
    return fallbackClockTime;
  }

  const minutesSinceMidnight = parseClockTimeToMinutes(candidate);
  if (minutesSinceMidnight === null) {
    return fallbackClockTime;
  }

  const hours = Math.floor(minutesSinceMidnight / 60);
  const minutes = minutesSinceMidnight % 60;
  return `${`${hours}`.padStart(2, "0")}:${`${minutes}`.padStart(2, "0")}`;
}

/** "20:30" reads as "8:30 pm" for anyone who does not think in 24-hour time. */
export function formatPresenceTimeLabel(clockTime: string): string {
  const minutesSinceMidnight = parseClockTimeToMinutes(clockTime);
  if (minutesSinceMidnight === null) {
    return clockTime;
  }

  const hours = Math.floor(minutesSinceMidnight / 60);
  const displayHour = hours % 12 === 0 ? 12 : hours % 12;
  const displayMinute = `${minutesSinceMidnight % 60}`.padStart(2, "0");
  return `${displayHour}:${displayMinute} ${hours < 12 ? "am" : "pm"}`;
}

export function sanitizePresenceSettings(candidate: unknown): PresenceSettings {
  const possibleSettings = (typeof candidate === "object" && candidate !== null ? candidate : {}) as Partial<PresenceSettings>;

  return {
    morningBriefEnabled: readBoolean(possibleSettings.morningBriefEnabled, defaultPresenceSettings.morningBriefEnabled),
    morningBriefTime: normalizeClockTime(possibleSettings.morningBriefTime, defaultPresenceSettings.morningBriefTime),
    eveningRecapEnabled: readBoolean(possibleSettings.eveningRecapEnabled, defaultPresenceSettings.eveningRecapEnabled),
    eveningRecapTime: normalizeClockTime(possibleSettings.eveningRecapTime, defaultPresenceSettings.eveningRecapTime),
    speakCheckIns: readBoolean(possibleSettings.speakCheckIns, defaultPresenceSettings.speakCheckIns),
  };
}

export interface DuePresenceCheckIn {
  kind: PresenceCheckInKind;
  scheduledAt: Date;
  minutesLate: number;
  isLate: boolean;
}

function clockTimeForKind(settings: PresenceSettings, kind: PresenceCheckInKind): string {
  return kind === "morning" ? settings.morningBriefTime : settings.eveningRecapTime;
}

function isKindEnabled(settings: PresenceSettings, kind: PresenceCheckInKind): boolean {
  return kind === "morning" ? settings.morningBriefEnabled : settings.eveningRecapEnabled;
}

/**
 * Check-ins that should fire right now. A check-in that already ran today never
 * comes back, and one whose time passed while the PC was off is delivered late
 * only inside the catch-up window, so an evening wake-up does not get a morning
 * brief that is hours stale.
 */
export function findDuePresenceCheckIns(
  settings: PresenceSettings,
  now: Date,
  lastCompletedDateKeys: Partial<Record<PresenceCheckInKind, string>>,
): DuePresenceCheckIn[] {
  const todayKey = localDateKey(now);
  const dueCheckIns: DuePresenceCheckIn[] = [];

  for (const kind of presenceCheckInKinds) {
    if (!isKindEnabled(settings, kind)) {
      continue;
    }
    if (lastCompletedDateKeys[kind] === todayKey) {
      continue;
    }

    const minutesSinceMidnight = parseClockTimeToMinutes(clockTimeForKind(settings, kind));
    if (minutesSinceMidnight === null) {
      continue;
    }

    const scheduledAt = new Date(now);
    scheduledAt.setHours(Math.floor(minutesSinceMidnight / 60), minutesSinceMidnight % 60, 0, 0);

    const minutesLate = Math.floor((now.getTime() - scheduledAt.getTime()) / 60_000);
    if (minutesLate < 0 || minutesLate > presenceCatchUpWindowMinutes) {
      continue;
    }

    dueCheckIns.push({
      kind,
      scheduledAt,
      minutesLate,
      isLate: minutesLate > presenceLateThresholdMinutes,
    });
  }

  return dueCheckIns;
}

function presenceCheckInName(kind: PresenceCheckInKind): string {
  return kind === "morning" ? "morning brief" : "evening recap";
}

/** What the island shows about the next time Ustaad will speak up unprompted. */
export function describeNextPresenceCheckIn(settings: PresenceSettings, now: Date): string | null {
  const upcoming: Array<{ kind: PresenceCheckInKind; scheduledAt: Date; label: string }> = [];

  for (const kind of presenceCheckInKinds) {
    if (!isKindEnabled(settings, kind)) {
      continue;
    }

    const clockTime = clockTimeForKind(settings, kind);
    const minutesSinceMidnight = parseClockTimeToMinutes(clockTime);
    if (minutesSinceMidnight === null) {
      continue;
    }

    const scheduledAt = new Date(now);
    scheduledAt.setHours(Math.floor(minutesSinceMidnight / 60), minutesSinceMidnight % 60, 0, 0);
    if (scheduledAt.getTime() <= now.getTime()) {
      scheduledAt.setDate(scheduledAt.getDate() + 1);
    }

    upcoming.push({ kind, scheduledAt, label: formatPresenceTimeLabel(clockTime) });
  }

  if (upcoming.length === 0) {
    return null;
  }

  upcoming.sort((firstCheckIn, secondCheckIn) => firstCheckIn.scheduledAt.getTime() - secondCheckIn.scheduledAt.getTime());
  const nextCheckIn = upcoming[0];
  if (!nextCheckIn) {
    return null;
  }

  const isTomorrow = localDateKey(nextCheckIn.scheduledAt) !== localDateKey(now);
  return isTomorrow
    ? `${presenceCheckInName(nextCheckIn.kind)} tomorrow at ${nextCheckIn.label}`
    : `${presenceCheckInName(nextCheckIn.kind)} at ${nextCheckIn.label}`;
}
