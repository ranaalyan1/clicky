import { randomUUID } from "node:crypto";
import { ClickaaAction, Skill } from "../shared/contracts";
import { JsonFileStore } from "./json-file-store";
import { normalizeForMatch } from "./text-matching";

const maximumStoredSkills = 60;
const maximumSeedActionsPerSkill = 12;

function sanitizeSkills(storedSkills: unknown): Skill[] {
  if (!Array.isArray(storedSkills)) {
    return [];
  }

  const sanitizedSkills: Skill[] = [];
  for (const possibleSkill of storedSkills) {
    if (!possibleSkill || typeof possibleSkill !== "object") {
      continue;
    }

    const skillRecord = possibleSkill as Partial<Skill>;
    const name = typeof skillRecord.name === "string" ? skillRecord.name.trim() : "";
    const goal = typeof skillRecord.goal === "string" ? skillRecord.goal.trim() : "";
    if (!name || !goal) {
      continue;
    }

    sanitizedSkills.push({
      id: typeof skillRecord.id === "string" && skillRecord.id ? skillRecord.id : randomUUID(),
      name: name.slice(0, 60),
      goal: goal.slice(0, 300),
      // Seed actions are a memory aid, never a permission: every run is filtered
      // and confirmed again, exactly like a freshly spoken task.
      seedActions: Array.isArray(skillRecord.seedActions)
        ? (skillRecord.seedActions as ClickaaAction[]).slice(0, maximumSeedActionsPerSkill)
        : [],
      createdAtIso: typeof skillRecord.createdAtIso === "string"
        ? skillRecord.createdAtIso
        : new Date().toISOString(),
      runCount: typeof skillRecord.runCount === "number" && Number.isFinite(skillRecord.runCount)
        ? Math.max(0, Math.round(skillRecord.runCount))
        : 0,
      lastRunAtIso: typeof skillRecord.lastRunAtIso === "string" ? skillRecord.lastRunAtIso : null,
    });
  }

  return sanitizedSkills;
}

/**
 * A task the user asked for once, saved by name so they can ask for it again
 * without spelling out the steps. Skills are a convenience layer over the agent
 * loop, never a permission layer: running one goes through the same ability
 * checks and the same confirmation the spoken version would.
 */
export class SkillStore {
  private readonly fileStore: JsonFileStore<Skill[]>;
  private skills: Skill[];

  constructor(filePath: string) {
    this.fileStore = new JsonFileStore(filePath, sanitizeSkills);
    this.skills = this.fileStore.read();
  }

  list(): Skill[] {
    return [...this.skills].sort((firstSkill, secondSkill) => (
      secondSkill.runCount - firstSkill.runCount || firstSkill.name.localeCompare(secondSkill.name)
    ));
  }

  findById(skillId: string): Skill | null {
    return this.skills.find((skill) => skill.id === skillId) ?? null;
  }

  findByName(rawName: string): Skill | null {
    const normalizedName = normalizeForMatch(rawName);
    if (!normalizedName) {
      return null;
    }
    return this.skills.find((skill) => normalizeForMatch(skill.name) === normalizedName) ?? null;
  }

  /** True when this exact goal is already saved, however it got named. */
  hasGoal(goal: string): boolean {
    const normalizedGoal = normalizeForMatch(goal);
    return this.skills.some((skill) => normalizeForMatch(skill.goal) === normalizedGoal);
  }

  save(skillDraft: { name: string; goal: string; seedActions: ClickaaAction[] }): Skill {
    const skillName = skillDraft.name.trim().slice(0, 60);
    const skillGoal = skillDraft.goal.trim().slice(0, 300);
    if (!skillName) {
      throw new Error("A skill needs a name, for example \"my morning videos\".");
    }
    if (!skillGoal) {
      throw new Error("A skill needs the goal it should reach.");
    }

    const existingSkill = this.findByName(skillName);
    const savedSkill: Skill = {
      id: existingSkill?.id ?? randomUUID(),
      name: skillName,
      goal: skillGoal,
      seedActions: skillDraft.seedActions.slice(0, maximumSeedActionsPerSkill),
      createdAtIso: existingSkill?.createdAtIso ?? new Date().toISOString(),
      runCount: existingSkill?.runCount ?? 0,
      lastRunAtIso: existingSkill?.lastRunAtIso ?? null,
    };

    this.skills = existingSkill
      ? this.skills.map((skill) => (skill.id === existingSkill.id ? savedSkill : skill))
      : [...this.skills, savedSkill].slice(-maximumStoredSkills);
    this.persist();
    return savedSkill;
  }

  rename(skillId: string, nextName: string): Skill | null {
    const skill = this.findById(skillId);
    if (!skill) {
      return null;
    }

    const trimmedName = nextName.trim().slice(0, 60);
    if (!trimmedName) {
      throw new Error("A skill needs a name.");
    }

    const renamedSkill: Skill = { ...skill, name: trimmedName };
    this.skills = this.skills.map((candidateSkill) => (
      candidateSkill.id === skillId ? renamedSkill : candidateSkill
    ));
    this.persist();
    return renamedSkill;
  }

  remove(skillId: string): boolean {
    const remainingSkills = this.skills.filter((skill) => skill.id !== skillId);
    if (remainingSkills.length === this.skills.length) {
      return false;
    }
    this.skills = remainingSkills;
    this.persist();
    return true;
  }

  /** Called after a skill runs, so the list can lead with what the user uses. */
  noteRun(skillId: string): void {
    this.skills = this.skills.map((skill) => (
      skill.id === skillId
        ? { ...skill, runCount: skill.runCount + 1, lastRunAtIso: new Date().toISOString() }
        : skill
    ));
    this.persist();
  }

  /** Compact list for the system prompt. */
  summarizeNames(limit: number): Array<{ name: string; goal: string }> {
    return this.list().slice(0, limit).map((skill) => ({ name: skill.name, goal: skill.goal }));
  }

  private persist(): void {
    this.fileStore.write(this.skills);
  }
}
