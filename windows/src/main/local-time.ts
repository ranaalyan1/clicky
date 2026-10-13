/**
 * Local wall-clock helpers.
 *
 * Every timestamp Clickaa stores or shows is a local-time ISO string without a
 * timezone suffix (`2026-11-10T11:00:00`). The user speaks in wall-clock terms
 * ("tomorrow at eleven"), so keeping the wall clock intact avoids daylight
 * saving surprises when a reminder fires.
 */

export function formatLocalIso(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  const seconds = `${date.getSeconds()}`.padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

const localIsoDateTimePattern =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/u;

/** Parses a local ISO string; returns null for anything a model got wrong. */
export function parseLocalIsoDateTime(rawValue: string | null | undefined): Date | null {
  if (typeof rawValue !== "string") {
    return null;
  }

  const parsedMatch = localIsoDateTimePattern.exec(rawValue.trim());
  if (!parsedMatch) {
    return null;
  }

  const year = Number.parseInt(parsedMatch[1]!, 10);
  const month = Number.parseInt(parsedMatch[2]!, 10);
  const day = Number.parseInt(parsedMatch[3]!, 10);
  const hours = parsedMatch[4] ? Number.parseInt(parsedMatch[4], 10) : 0;
  const minutes = parsedMatch[5] ? Number.parseInt(parsedMatch[5], 10) : 0;
  const seconds = parsedMatch[6] ? Number.parseInt(parsedMatch[6], 10) : 0;

  if (month < 1 || month > 12 || day < 1 || day > 31 || hours > 23 || minutes > 59 || seconds > 59) {
    return null;
  }

  const parsedDate = new Date(year, month - 1, day, hours, minutes, seconds, 0);
  if (
    parsedDate.getFullYear() !== year
    || parsedDate.getMonth() !== month - 1
    || parsedDate.getDate() !== day
  ) {
    return null;
  }

  return parsedDate;
}

/** `15:42` for today, `Nov 10 11:00` for any other day. */
export function formatFriendlyDateTime(localIso: string | null, now: Date): string {
  const parsedDate = parseLocalIsoDateTime(localIso);
  if (!parsedDate) {
    return "";
  }

  const clockTime = formatClockTime(parsedDate);
  const isToday = parsedDate.toDateString() === now.toDateString();
  if (isToday) {
    return clockTime;
  }

  const monthNames = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${monthNames[parsedDate.getMonth()]} ${parsedDate.getDate()} ${clockTime}`;
}

/** `09:00` / `18:30` from a `HH:MM` string, or "" when the string is invalid. */
export function formatClockTimeFromTimeOfDay(timeOfDay: string | null): string {
  const parsedTimeOfDay = parseTimeOfDay(timeOfDay);
  if (!parsedTimeOfDay) {
    return "";
  }

  const isMorning = parsedTimeOfDay.hours < 12;
  const twelveHour = parsedTimeOfDay.hours % 12 === 0 ? 12 : parsedTimeOfDay.hours % 12;
  return `${twelveHour}:${`${parsedTimeOfDay.minutes}`.padStart(2, "0")} ${isMorning ? "AM" : "PM"}`;
}

export function parseTimeOfDay(
  timeOfDay: string | null | undefined,
): { hours: number; minutes: number } | null {
  if (typeof timeOfDay !== "string") {
    return null;
  }

  const parsedMatch = /^(\d{1,2}):(\d{2})$/u.exec(timeOfDay.trim());
  if (!parsedMatch) {
    return null;
  }

  const hours = Number.parseInt(parsedMatch[1]!, 10);
  const minutes = Number.parseInt(parsedMatch[2]!, 10);
  if (hours > 23 || minutes > 59) {
    return null;
  }

  return { hours, minutes };
}

export function formatClockTime(date: Date): string {
  const isMorning = date.getHours() < 12;
  const twelveHour = date.getHours() % 12 === 0 ? 12 : date.getHours() % 12;
  return `${twelveHour}:${`${date.getMinutes()}`.padStart(2, "0")} ${isMorning ? "AM" : "PM"}`;
}

/** `in 12 minutes`, `in 3 hours`, `tomorrow`, or `in 4 days`. */
export function formatRelativeToNow(localIso: string | null, now: Date): string {
  const parsedDate = parseLocalIsoDateTime(localIso);
  if (!parsedDate) {
    return "";
  }

  const differenceInMinutes = Math.round((parsedDate.getTime() - now.getTime()) / 60_000);
  if (differenceInMinutes < -1) {
    return "overdue";
  }
  if (differenceInMinutes <= 1) {
    return "now";
  }
  if (differenceInMinutes < 60) {
    return `in ${differenceInMinutes} min`;
  }

  const differenceInHours = Math.round(differenceInMinutes / 60);
  if (differenceInHours < 24 && parsedDate.getDate() === now.getDate()) {
    return `in ${differenceInHours} ${differenceInHours === 1 ? "hour" : "hours"}`;
  }

  const differenceInDays = Math.round(differenceInMinutes / (60 * 24));
  if (differenceInDays <= 1) {
    return "tomorrow";
  }
  return `in ${differenceInDays} days`;
}
