/**
 * @module skill-registry
 * @description Stores discovered problem-solving patterns as reusable skills.
 *
 * Differentiation from SkillLearner (existing):
 *   SkillLearner  → learned from ERROR recovery patterns only
 *   SkillRegistry → stores ANY successful tool chain pattern (not just error-driven)
 *
 * Storage: ~/.yuan/skills/skill-registry.json
 * Atomic writes.
 */

import { EventEmitter } from "events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

// ─── Types ───

export interface RegistrySkill {
  id: string;
  name: string;                // e.g. "fix_typescript_missing_type"
  taskType: string;            // e.g. "ts-bugfix"
  pattern: string;             // human-readable description of what the skill does
  toolSequence: string[];      // ordered tool calls in this skill
  triggerKeywords: string[];   // keywords in goal that suggest this skill
  successRate: number;         // 0–1
  usageCount: number;          // track usage
  lastUsed: string | null;
  deprecated: boolean;         // mark if successRate drops below 0.2
  createdAt: string;
  sourceSessionId?: string;    // which session discovered this
}

export interface SkillRegistryConfig {
  storageDir?: string;               // default ~/.yuan/skills/
  minSuccessRateToActivate?: number; // default 0.4
}

// ─── Class ───

export class SkillRegistry extends EventEmitter {
  private readonly storageFile: string;
  private readonly storageDir: string;
  private readonly minSuccessRateToActivate: number;
  private skills: RegistrySkill[];

  constructor(config?: SkillRegistryConfig) {
    super();
    this.storageDir = config?.storageDir ?? join(homedir(), ".yuan", "skills");
    this.storageFile = join(this.storageDir, "skill-registry.json");
    this.minSuccessRateToActivate = config?.minSuccessRateToActivate ?? 0.4;
    this.skills = this._load();
  }

  /**
   * Register a new skill (or update if same name exists).
   * Emits agent:skill_discovered.
   */
  register(
    skill: Omit<RegistrySkill, "id" | "createdAt" | "usageCount" | "deprecated" | "lastUsed">,
  ): RegistrySkill {
    const existing = this.skills.find((s) => s.name === skill.name);
    let isNew: boolean;
    let result: RegistrySkill;

    if (existing) {
      isNew = false;
      // Update fields but preserve identity and stats
      existing.taskType = skill.taskType;
      existing.pattern = skill.pattern;
      existing.toolSequence = skill.toolSequence;
      existing.triggerKeywords = skill.triggerKeywords;
      existing.successRate = skill.successRate;
      if (skill.sourceSessionId !== undefined) {
        existing.sourceSessionId = skill.sourceSessionId;
      }
      result = existing;
    } else {
      isNew = true;
      const now = new Date().toISOString();
      result = {
        id: randomUUID(),
        name: skill.name,
        taskType: skill.taskType,
        pattern: skill.pattern,
        toolSequence: skill.toolSequence,
        triggerKeywords: skill.triggerKeywords,
        successRate: skill.successRate,
        usageCount: 0,
        lastUsed: null,
        deprecated: false,
        createdAt: now,
        sourceSessionId: skill.sourceSessionId,
      };
      this.skills.push(result);
    }

    this._save();

    this.emit("event", {
      kind: "agent:skill_discovered",
      skillId: result.id,
      name: result.name,
      taskType: result.taskType,
      successRate: result.successRate,
      isNew,
      timestamp: Date.now(),
    });

    return result;
  }

  /**
   * Record usage outcome. Updates successRate.
   * Deprecates if successRate < 0.2 AND usageCount >= 5.
   * Emits agent:skill_discovered.
   */
  recordUsage(skillId: string, success: boolean): void {
    const skill = this.skills.find((s) => s.id === skillId);
    if (!skill) return;

    const n = skill.usageCount + 1;
    skill.successRate = (skill.successRate * (n - 1) + (success ? 1 : 0)) / n;
    skill.usageCount = n;
    skill.lastUsed = new Date().toISOString();

    // Deprecate if successRate drops below 0.2 and has enough data
    if (skill.successRate < 0.2 && skill.usageCount >= 5) {
      skill.deprecated = true;
    }

    this._save();

    this.emit("event", {
      kind: "agent:skill_discovered",
      skillId: skill.id,
      name: skill.name,
      taskType: skill.taskType,
      successRate: skill.successRate,
      isNew: false,
      timestamp: Date.now(),
    });
  }

  /**
   * Find relevant skills by goal text and task type.
   * Returns non-deprecated skills sorted by successRate desc.
   */
  findRelevant(goal: string, taskType?: string): RegistrySkill[] {
    const goalLower = goal.toLowerCase();

    return this.skills
      .filter((s) => {
        if (s.deprecated) return false;
        if (taskType && s.taskType !== taskType) return false;
        // Match any trigger keyword in goal (case-insensitive)
        return s.triggerKeywords.some((kw) => goalLower.includes(kw.toLowerCase()));
      })
      .filter((s) => s.successRate >= this.minSuccessRateToActivate)
      .sort((a, b) => b.successRate - a.successRate);
  }

  /** Get all active (non-deprecated) skills. */
  getActive(): RegistrySkill[] {
    return this.skills.filter((s) => !s.deprecated);
  }

  /** Get all skills including deprecated. */
  getAll(): RegistrySkill[] {
    return [...this.skills];
  }

  // ─── Internal ───

  private _load(): RegistrySkill[] {
    try {
      if (!existsSync(this.storageDir)) {
        mkdirSync(this.storageDir, { recursive: true });
      }
      if (!existsSync(this.storageFile)) return [];
      const raw = readFileSync(this.storageFile, "utf-8");
      return JSON.parse(raw) as RegistrySkill[];
    } catch {
      return [];
    }
  }

  private _save(): void {
    const tmpFile = `${this.storageFile}.tmp`;
    try {
      writeFileSync(tmpFile, JSON.stringify(this.skills, null, 2), "utf-8");
      renameSync(tmpFile, this.storageFile);
    } catch {
      // Non-fatal: storage failures should not crash the agent loop
    }
  }
}
