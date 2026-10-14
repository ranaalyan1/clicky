import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SkillStore } from "../src/main/skill-store";
import {
  proposeSkillName,
  suggestSkill,
  taskSignature,
  TaskHistoryEntry,
  trimTaskHistory,
} from "../src/main/skill-suggestions";

function createSkillStore(): SkillStore {
  return new SkillStore(join(mkdtempSync(join(tmpdir(), "ustaad-skill-")), "skills.json"));
}

function historyEntry(goal: string, succeededAtIso = new Date().toISOString()): TaskHistoryEntry {
  return {
    id: `${goal}-${succeededAtIso}`,
    goal,
    signature: taskSignature(goal),
    seedActions: [{ type: "open_url", url: "https://youtube.com" }],
    succeededAtIso,
  };
}

test("skills are saved by name, found by name, and renamed in place", () => {
  const skillStore = createSkillStore();
  const savedSkill = skillStore.save({
    name: "morning videos",
    goal: "play a video on youtube",
    seedActions: [{ type: "open_url", url: "https://youtube.com" }],
  });

  assert.equal(skillStore.findByName("Morning Videos")?.id, savedSkill.id);
  assert.equal(skillStore.findByName("  morning videos ")?.id, savedSkill.id);
  assert.equal(skillStore.findByName("something else"), null);
  assert.equal(skillStore.hasGoal("Play a video on YouTube."), true);

  const renamedSkill = skillStore.rename(savedSkill.id, "my morning videos");
  assert.equal(renamedSkill?.name, "my morning videos");
  assert.equal(skillStore.list()[0]?.runCount, 0);
  assert.throws(() => skillStore.rename(savedSkill.id, "   "), /needs a name/);
});

test("saving the same name again replaces it rather than duplicating", () => {
  const skillStore = createSkillStore();
  const firstSkill = skillStore.save({ name: "work", goal: "open my work apps", seedActions: [] });
  const secondSkill = skillStore.save({ name: "work", goal: "open slack and mail", seedActions: [] });

  assert.equal(skillStore.list().length, 1);
  assert.equal(secondSkill.id, firstSkill.id);
  assert.equal(secondSkill.goal, "open slack and mail");
});

test("running a skill counts, so the list can lead with what gets used", () => {
  const skillStore = createSkillStore();
  const quietSkill = skillStore.save({ name: "quiet", goal: "do the quiet thing", seedActions: [] });
  const usedSkill = skillStore.save({ name: "used", goal: "do the used thing", seedActions: [] });

  skillStore.noteRun(usedSkill.id, { outcome: "completed", note: "finished", countsAsFailure: false });
  skillStore.noteRun(usedSkill.id, { outcome: "completed", note: "finished", countsAsFailure: false });

  const [firstSkill] = skillStore.list();
  assert.equal(firstSkill?.id, usedSkill.id);
  assert.equal(firstSkill?.runCount, 2);
  assert.equal(skillStore.findById(quietSkill.id)?.lastRunAtIso, null);

  assert.equal(skillStore.remove(quietSkill.id), true);
  assert.equal(skillStore.remove(quietSkill.id), false);
  assert.equal(skillStore.list().length, 1);
});

test("a failing skill builds a streak, and the run that works clears it", () => {
  const skillStore = createSkillStore();
  const skill = skillStore.save({ name: "orders", goal: "check the last order", seedActions: [] });

  skillStore.noteRun(skill.id, { outcome: "gave_up", note: "the page never loaded", countsAsFailure: true });
  skillStore.noteRun(skill.id, { outcome: "ran_out_of_steps", note: "8 steps used", countsAsFailure: true });
  const strugglingSkill = skillStore.findById(skill.id);
  assert.equal(strugglingSkill?.failureStreak, 2);
  assert.equal(strugglingSkill?.lastOutcome, "ran_out_of_steps");
  assert.equal(strugglingSkill?.lastOutcomeNote, "8 steps used");

  // A run the user stopped is recorded, but it is not the skill's fault.
  skillStore.noteRun(skill.id, { outcome: "stopped", note: "you stopped it", countsAsFailure: false });
  assert.equal(skillStore.findById(skill.id)?.failureStreak, 2);

  skillStore.noteRun(skill.id, { outcome: "completed", note: "found the order", countsAsFailure: false });
  assert.equal(skillStore.findById(skill.id)?.failureStreak, 0);
  assert.equal(skillStore.findById(skill.id)?.runCount, 4);
});

test("a saved repair replaces the aim and the steps but keeps the skill", () => {
  const skillStore = createSkillStore();
  const skill = skillStore.save({ name: "videos", goal: "play a video on youtube", seedActions: [] });
  skillStore.noteRun(skill.id, { outcome: "gave_up", note: "no video found", countsAsFailure: true });
  skillStore.noteRepairOffered(skill.id, 2);

  const repairedSkill = skillStore.applyRepair(skill.id, {
    goal: "search youtube for tonight's playlist and play the first result",
    seedActions: [{ type: "search_web", query: "tonight playlist", target: "youtube" }],
  });

  assert.equal(repairedSkill?.id, skill.id);
  assert.equal(repairedSkill?.name, "videos");
  assert.equal(repairedSkill?.failureStreak, 0);
  assert.equal(repairedSkill?.repairOfferedStreak, 0);
  assert.equal(repairedSkill?.repairCount, 1);
  assert.equal(repairedSkill?.seedActions.length, 1);
  assert.ok(repairedSkill?.repairedAtIso);
  assert.equal(skillStore.findById(skill.id)?.goal, "search youtube for tonight's playlist and play the first result");

  // Nonsense repairs are refused rather than half-applied.
  assert.equal(skillStore.applyRepair(skill.id, { goal: "   ", seedActions: [] }), null);
  assert.equal(skillStore.findById(skill.id)?.repairCount, 1);
});

test("stored health is sanitized rather than trusted", () => {
  const skillPath = join(mkdtempSync(join(tmpdir(), "ustaad-skill-")), "skills.json");
  writeFileSync(skillPath, JSON.stringify([{
    id: "kept",
    name: "kept skill",
    goal: "do the kept thing",
    seedActions: [],
    createdAtIso: "2026-01-01T00:00:00.000Z",
    runCount: 3,
    lastRunAtIso: "2026-01-02T00:00:00.000Z",
    lastOutcome: "exploded",
    lastOutcomeNote: 42,
    failureStreak: -7,
    repairOfferedStreak: 2.6,
    repairCount: "lots",
    repairedAtIso: 5,
  }]));

  const skillStore = new SkillStore(skillPath);
  const storedSkill = skillStore.findById("kept");
  assert.equal(storedSkill?.lastOutcome, null);
  assert.equal(storedSkill?.lastOutcomeNote, "");
  assert.equal(storedSkill?.failureStreak, 0);
  assert.equal(storedSkill?.repairOfferedStreak, 3);
  assert.equal(storedSkill?.repairCount, 0);
  assert.equal(storedSkill?.repairedAtIso, null);
});

test("skills persist across a restart", () => {
  const skillPath = join(mkdtempSync(join(tmpdir(), "ustaad-skill-")), "skills.json");
  const firstStore = new SkillStore(skillPath);
  firstStore.save({
    name: "my videos",
    goal: "play a video on youtube",
    seedActions: [{ type: "open_url", url: "https://youtube.com" }],
  });

  const reloadedStore = new SkillStore(skillPath);
  assert.deepEqual(reloadedStore.summarizeNames(5), [
    { name: "my videos", goal: "play a video on youtube" },
  ]);
});

test("the same task said two ways counts once", () => {
  assert.equal(taskSignature("Play a video on YouTube!"), taskSignature("play a video on youtube"));
  assert.equal(taskSignature("open my orders."), taskSignature("Open my orders"));

  const suggestion = suggestSkill({
    history: [
      historyEntry("play a video on youtube", "2026-10-01T09:00:00.000Z"),
      historyEntry("Play a video on YouTube!", "2026-10-02T09:00:00.000Z"),
      historyEntry("play a video on youtube.", "2026-10-03T09:00:00.000Z"),
    ],
    savedSignatures: [],
  });

  assert.ok(suggestion);
  assert.equal(suggestion.goal, "play a video on youtube.");
  assert.equal(suggestion.successCount, 3);
  assert.equal(suggestion.proposedName, "play video youtube");
});

test("a task that has only worked twice is not offered yet", () => {
  const suggestion = suggestSkill({
    history: [historyEntry("play a video on youtube"), historyEntry("play a video on youtube")],
    savedSignatures: [],
  });

  assert.equal(suggestion, null);
});

test("a task that is already a skill is never offered again", () => {
  const history = [
    historyEntry("play a video on youtube"),
    historyEntry("play a video on youtube"),
    historyEntry("play a video on youtube"),
  ];

  assert.equal(suggestSkill({ history, savedSignatures: [taskSignature("play a video on youtube")] }), null);
  assert.equal(suggestSkill({ history, savedSignatures: new Set([taskSignature("play a video on youtube")]) }), null);
});

test("a no thanks is respected for a while, then ustaad may ask once more", () => {
  const threeRuns = [
    historyEntry("play a video on youtube"),
    historyEntry("play a video on youtube"),
    historyEntry("play a video on youtube"),
  ];
  const signature = taskSignature("play a video on youtube");

  // Refused when the count stood at three, and nothing has happened since.
  assert.equal(
    suggestSkill({ history: threeRuns, savedSignatures: [], declinedSignatures: { [signature]: 3 } }),
    null,
  );

  // Two more successes later it is still quiet; five later it speaks up again.
  const fiveRuns = [...threeRuns, historyEntry("play a video on youtube"), historyEntry("play a video on youtube")];
  assert.equal(
    suggestSkill({ history: fiveRuns, savedSignatures: [], declinedSignatures: { [signature]: 3 } }),
    null,
  );

  const eightRuns = Array.from({ length: 8 }, () => historyEntry("play a video on youtube"));
  const offeredAgain = suggestSkill({
    history: eightRuns,
    savedSignatures: [],
    declinedSignatures: { [signature]: 3 },
  });
  assert.equal(offeredAgain?.successCount, 8);
});

test("the most repeated task wins when several are eligible", () => {
  const suggestion = suggestSkill({
    history: [
      historyEntry("check my orders"),
      historyEntry("check my orders"),
      historyEntry("check my orders"),
      historyEntry("play a video on youtube"),
      historyEntry("play a video on youtube"),
      historyEntry("play a video on youtube"),
      historyEntry("play a video on youtube"),
      historyEntry("play a video on youtube"),
    ],
    savedSignatures: [],
  });

  assert.equal(suggestion?.successCount, 5);
  assert.equal(suggestion?.goal, "play a video on youtube");
});

test("the newest run seeds the skill, because it is the one that just worked", () => {
  const suggestion = suggestSkill({
    history: [
      { ...historyEntry("open my orders"), seedActions: [{ type: "open_url", url: "https://old.example" }] },
      { ...historyEntry("open my orders"), seedActions: [{ type: "open_url", url: "https://new.example" }] },
      { ...historyEntry("open my orders"), seedActions: [{ type: "open_url", url: "https://newest.example" }] },
    ],
    savedSignatures: [],
  });

  assert.deepEqual(suggestion?.seedActions, [{ type: "open_url", url: "https://newest.example" }]);
});

test("suggested names are short, speakable and free of punctuation", () => {
  assert.equal(proposeSkillName("go to youtube and play anything"), "youtube play anything");
  assert.equal(proposeSkillName("Open my email and check the last order."), "email check last order");
  assert.equal(proposeSkillName("!!!"), "my task");
  assert.equal(proposeSkillName("play the music").length <= 60, true);
});

test("history is trimmed rather than growing without limit", () => {
  const longHistory = Array.from({ length: 260 }, () => historyEntry("play a video on youtube"));
  const trimmedHistory = trimTaskHistory(longHistory);

  assert.equal(trimmedHistory.length, 200);
  // The newest entries are the ones kept.
  assert.equal(trimmedHistory[trimmedHistory.length - 1]?.goal, "play a video on youtube");
});

test("an empty or nonsense goal never becomes a skill suggestion", () => {
  assert.equal(suggestSkill({ history: [], savedSignatures: [] }), null);
  assert.equal(suggestSkill({ history: [historyEntry("   ")], savedSignatures: [] }), null);
});
