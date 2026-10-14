import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { PresenceSettings } from "../src/shared/contracts";
import {
  defaultPresenceSettings,
  describeNextPresenceCheckIn,
  findDuePresenceCheckIns,
  formatPresenceTimeLabel,
  localDateKey,
  normalizeClockTime,
  parseClockTimeToMinutes,
  presenceCatchUpWindowMinutes,
  sanitizePresenceSettings,
} from "../src/main/presence-schedule";

/** 14 October 2026, 08:45 local time: fifteen minutes after the morning brief. */
const morningAfterBriefTime = new Date(2026, 9, 14, 8, 45, 0, 0);

function settingsWith(overrides: Partial<PresenceSettings>): PresenceSettings {
  return { ...defaultPresenceSettings, ...overrides };
}

describe("parseClockTimeToMinutes", () => {
  it("reads 24-hour wall-clock times", () => {
    assert.equal(parseClockTimeToMinutes("08:30"), 510);
    assert.equal(parseClockTimeToMinutes("20:30"), 1230);
    assert.equal(parseClockTimeToMinutes("00:00"), 0);
    assert.equal(parseClockTimeToMinutes("8:05"), 485);
  });

  it("rejects anything that is not a real time of day", () => {
    assert.equal(parseClockTimeToMinutes("24:00"), null);
    assert.equal(parseClockTimeToMinutes("08:60"), null);
    assert.equal(parseClockTimeToMinutes("morning"), null);
    assert.equal(parseClockTimeToMinutes(""), null);
  });
});

describe("normalizeClockTime", () => {
  it("pads a time the panel sent, so the file is always HH:MM", () => {
    assert.equal(normalizeClockTime("8:05", "07:00"), "08:05");
  });

  it("falls back rather than writing a time nobody can parse", () => {
    assert.equal(normalizeClockTime("half past eight", "07:00"), "07:00");
    assert.equal(normalizeClockTime(830, "07:00"), "07:00");
  });
});

describe("formatPresenceTimeLabel", () => {
  it("says noon and midnight the way people do", () => {
    assert.equal(formatPresenceTimeLabel("08:30"), "8:30 am");
    assert.equal(formatPresenceTimeLabel("20:30"), "8:30 pm");
    assert.equal(formatPresenceTimeLabel("12:00"), "12:00 pm");
    assert.equal(formatPresenceTimeLabel("00:15"), "12:15 am");
  });
});

describe("sanitizePresenceSettings", () => {
  it("keeps a complete, valid object exactly as it is", () => {
    const settings = sanitizePresenceSettings({
      morningBriefEnabled: false,
      morningBriefTime: "06:15",
      eveningRecapEnabled: true,
      eveningRecapTime: "22:45",
      speakCheckIns: true,
    });

    assert.deepEqual(settings, {
      morningBriefEnabled: false,
      morningBriefTime: "06:15",
      eveningRecapEnabled: true,
      eveningRecapTime: "22:45",
      speakCheckIns: true,
    });
  });

  it("rebuilds a nonsense file into the defaults instead of trusting it", () => {
    const settings = sanitizePresenceSettings({ morningBriefTime: "99:99", eveningRecapEnabled: "yes" });

    assert.equal(settings.morningBriefTime, defaultPresenceSettings.morningBriefTime);
    assert.equal(settings.eveningRecapEnabled, defaultPresenceSettings.eveningRecapEnabled);
    assert.equal(settings.morningBriefEnabled, defaultPresenceSettings.morningBriefEnabled);
  });
});

describe("findDuePresenceCheckIns", () => {
  it("stays quiet before its time", () => {
    const earlyMorning = new Date(2026, 9, 14, 7, 0, 0, 0);
    assert.deepEqual(findDuePresenceCheckIns(defaultPresenceSettings, earlyMorning, {}), []);
  });

  it("fires once the time has passed", () => {
    const dueCheckIns = findDuePresenceCheckIns(defaultPresenceSettings, morningAfterBriefTime, {});

    assert.equal(dueCheckIns.length, 1);
    assert.equal(dueCheckIns[0]?.kind, "morning");
    assert.equal(dueCheckIns[0]?.minutesLate, 15);
    assert.equal(dueCheckIns[0]?.isLate, false);
  });

  it("never delivers the same check-in twice in one day", () => {
    const completedToday = { morning: localDateKey(morningAfterBriefTime) };
    const dueCheckIns = findDuePresenceCheckIns(defaultPresenceSettings, morningAfterBriefTime, completedToday);

    assert.deepEqual(dueCheckIns, []);
  });

  it("delivers again the next day", () => {
    const completedToday = { morning: localDateKey(morningAfterBriefTime) };
    const tomorrow = new Date(2026, 9, 15, 8, 45, 0, 0);
    const dueCheckIns = findDuePresenceCheckIns(defaultPresenceSettings, tomorrow, completedToday);

    assert.equal(dueCheckIns.length, 1);
    assert.equal(dueCheckIns[0]?.kind, "morning");
  });

  it("admits it is late when the pc was asleep through the scheduled time", () => {
    const lateMorning = new Date(2026, 9, 14, 9, 30, 0, 0);
    const dueCheckIns = findDuePresenceCheckIns(defaultPresenceSettings, lateMorning, {});

    assert.equal(dueCheckIns[0]?.isLate, true);
  });

  it("skips a check-in whose moment is long gone rather than nagging at night", () => {
    const justPastTheWindow = new Date(2026, 9, 14, 8, 30 + presenceCatchUpWindowMinutes + 1, 0, 0);
    assert.deepEqual(findDuePresenceCheckIns(defaultPresenceSettings, justPastTheWindow, {}), []);
  });

  it("does not fire a kind the user switched off", () => {
    const onlyEvening = settingsWith({ morningBriefEnabled: false });
    assert.deepEqual(findDuePresenceCheckIns(onlyEvening, morningAfterBriefTime, {}), []);
  });

  it("leaves a morning brief behind rather than delivering it at night", () => {
    const lateEvening = new Date(2026, 9, 14, 20, 45, 0, 0);
    const dueCheckIns = findDuePresenceCheckIns(defaultPresenceSettings, lateEvening, {});

    // Only the evening recap: a morning brief twelve hours late is not a brief.
    assert.deepEqual(dueCheckIns.map((dueCheckIn) => dueCheckIn.kind), ["evening"]);
  });

  it("can owe both kinds at once when their times are close together", () => {
    const closeTogether = settingsWith({ morningBriefTime: "08:30", eveningRecapTime: "09:00" });
    const dueCheckIns = findDuePresenceCheckIns(closeTogether, new Date(2026, 9, 14, 9, 5, 0, 0), {});

    assert.deepEqual(dueCheckIns.map((dueCheckIn) => dueCheckIn.kind), ["morning", "evening"]);
  });
});

describe("describeNextPresenceCheckIn", () => {
  it("names today's check-in when it is still ahead", () => {
    const earlyMorning = new Date(2026, 9, 14, 7, 0, 0, 0);
    assert.equal(describeNextPresenceCheckIn(defaultPresenceSettings, earlyMorning), "morning brief at 8:30 am");
  });

  it("rolls to tomorrow once today's is gone", () => {
    const afterBoth = new Date(2026, 9, 14, 22, 0, 0, 0);
    assert.equal(describeNextPresenceCheckIn(defaultPresenceSettings, afterBoth), "morning brief tomorrow at 8:30 am");
  });

  it("says nothing at all when both check-ins are off", () => {
    const bothOff = settingsWith({ morningBriefEnabled: false, eveningRecapEnabled: false });
    assert.equal(describeNextPresenceCheckIn(bothOff, morningAfterBriefTime), null);
  });
});
