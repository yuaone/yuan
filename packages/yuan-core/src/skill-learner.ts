/**
 * @module skill-learner
 * @description Skill Learner — Self-improving agent that generates skills from experience.
 *
 * Flow:
 * 1. Error pattern discovered during agent run
 * 2. Agent successfully fixes it
 * 3. SkillLearner extracts: pattern → diagnosis → fix strategy → validation
 * 4. New skill stored in .yuan/learned-skills/
 * 5. Next time → learned skill auto-activates
 *
 * Confidence evolution:
 * - New skill: 0.5
 * - Success: +0.1 (max 0.95)
 * - Failure: -0.2
 * - Below 0.2: deprecated
 */

import { readFile, writeFile, readdir, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { RunAnalysis } from "./memory-updater.js";
import type { SkillDefinition, SkillTrigger } from "./plugin-types.js";

// ─── Types ───

/** A skill learned from agent experience */
export interface LearnedSkill {
  /** Unique skill ID */
  id: string;
  /** Error pattern that triggers this skill (regex string) */
  errorPattern: string;
  /** Human-readable diagnosis */
  diagnosis: string;
  /** Fix strategy description */
  strategy: string;
  /** Tool sequence that worked */
  toolSequence: string[];
  /** Validation command/check */
  validation: string;
  /** Current confidence (0-1) */
  confidence: number;
  /** Times used */
  usageCount: number;
  /** Times succeeded */
  successCount: number;
  /** Last used timestamp */
  lastUsed: number;
  /** Created from which run */
  createdFrom: {
    sessionId: string;
    errorMessage: string;
    fixSummary: string;
    timestamp: number;
  };
  /** Language/framework scope */
  scope?: {
    language?: string;
    framework?: string;
    filePattern?: string;
  };
}

/** Events that drive skill learning */
export interface LearningEvent {
  type: "error_fixed" | "user_correction" | "test_pattern" | "review_feedback";
  errorPattern?: string;
  fixApplied: string;
  success: boolean;
  context: Record<string, unknown>;
}

// ─── Constants ───

const INITIAL_CONFIDENCE = 0.5;
const SUCCESS_INCREMENT = 0.1;
const FAILURE_DECREMENT = 0.2;
const MAX_CONFIDENCE = 0.95;
const DEPRECATION_THRESHOLD = 0.2;
const SKILLS_DIR = "learned-skills";

// ─── SkillLearner ───

/**
 * SkillLearner — extracts reusable skills from agent runs.
 *
 * When the agent resolves an error, SkillLearner distills the
 * error pattern + fix strategy into a LearnedSkill that can be
 * reused in future runs. Skills evolve through a confidence system:
 * successful reuse increases confidence, failure decreases it,
 * and low-confidence skills are eventually pruned.
 */
export class SkillLearner {
  private storagePath: string;
  private skills: Map<string, LearnedSkill> = new Map();

  constructor(projectRoot: string) {
    this.storagePath = join(projectRoot, ".yuan", SKILLS_DIR);
  }

  /**
   * Load all skills from disk. Must be called before using the learner.
   */
  async init(): Promise<void> {
    await this.loadSkills();
  }

  /**
   * Extract a potential new skill from a completed agent run analysis.
   * Called after each successful error resolution.
   *
   * @returns The newly created skill, or null if no learnable pattern found
   */
  extractSkillFromRun(
    analysis: RunAnalysis,
    sessionId: string,
  ): LearnedSkill | null {
    // Find resolved error patterns — the highest signal for learning
    const resolved = analysis.errorPatterns.filter((ep) => ep.resolution);
    if (resolved.length === 0) return null;

    // Pick the most frequent resolved error
    const best = resolved.reduce((a, b) =>
      b.frequency > a.frequency ? b : a,
    );

    // Build a regex-safe error pattern from the message
    const errorPattern = this.buildErrorPattern(best.message);

    // Check for duplicate skill
    for (const existing of this.skills.values()) {
      if (existing.errorPattern === errorPattern) {
        // Reinforce existing skill instead of creating a new one
        this.updateConfidence(existing.id, true);
        return null;
      }
    }

    // Extract the tool sequence from the analysis
    const toolSeq = analysis.toolPatterns
      .filter((tp) => tp.successRate > 0.5)
      .sort((a, b) => b.count - a.count)
      .map((tp) => tp.tool);

    const skill: LearnedSkill = {
      id: this.generateId(errorPattern),
      errorPattern,
      diagnosis: `${best.type}: ${best.message}`,
      strategy: best.resolution ?? "Unknown resolution",
      toolSequence: toolSeq.length > 0 ? toolSeq : [best.tool],
      validation: this.inferValidation(best.type),
      confidence: INITIAL_CONFIDENCE,
      usageCount: 0,
      successCount: 0,
      lastUsed: Date.now(),
      createdFrom: {
        sessionId,
        errorMessage: best.message,
        fixSummary: best.resolution ?? "",
        timestamp: Date.now(),
      },
      scope: this.inferScope(best),
    };

    this.skills.set(skill.id, skill);
    return skill;
  }

  /**
   * Update skill confidence based on usage result.
   */
  updateConfidence(skillId: string, success: boolean): void {
    const skill = this.skills.get(skillId);
    if (!skill) return;

    skill.usageCount++;
    skill.lastUsed = Date.now();

    if (success) {
      skill.successCount++;
      skill.confidence = Math.min(
        skill.confidence + SUCCESS_INCREMENT,
        MAX_CONFIDENCE,
      );
    } else {
      skill.confidence = Math.max(skill.confidence - FAILURE_DECREMENT, 0);
    }
  }

  /**
   * Find learned skills relevant to current context.
   */
  getRelevantSkills(context: {
    errorMessage?: string;
    filePath?: string;
    language?: string;
  }): LearnedSkill[] {
    const results: LearnedSkill[] = [];

    for (const skill of this.skills.values()) {
      // Skip deprecated skills
      if (skill.confidence < DEPRECATION_THRESHOLD) continue;

      let score = 0;

      // Match error pattern
      if (context.errorMessage) {
        try {
          const re = new RegExp(skill.errorPattern, "i");
          if (re.test(context.errorMessage)) {
            score += 3;
          }
        } catch {
          // Invalid regex — try substring match
          if (
            context.errorMessage
              .toLowerCase()
              .includes(skill.errorPattern.toLowerCase())
          ) {
            score += 2;
          }
        }
      }

      // Match file pattern scope
      if (context.filePath && skill.scope?.filePattern) {
        try {
          const re = new RegExp(skill.scope.filePattern);
          if (re.test(context.filePath)) {
            score += 1;
          }
        } catch {
          // ignore
        }
      }

      // Match language scope
      if (
        context.language &&
        skill.scope?.language &&
        skill.scope.language.toLowerCase() === context.language.toLowerCase()
      ) {
        score += 1;
      }

      if (score > 0) {
        results.push(skill);
      }
    }

    // Sort by relevance (confidence * usage pattern)
    return results.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Remove skills with confidence below threshold.
   * @returns IDs of pruned skills
   */
  pruneDeprecated(threshold?: number): string[] {
    const cutoff = threshold ?? DEPRECATION_THRESHOLD;
    const pruned: string[] = [];

    for (const [id, skill] of this.skills) {
      if (skill.confidence < cutoff) {
        this.skills.delete(id);
        pruned.push(id);
      }
    }

    return pruned;
  }

  /**
   * Convert learned skill to SkillDefinition format for PluginRegistry.
   */
  toSkillDefinition(skill: LearnedSkill): SkillDefinition {
    const trigger: SkillTrigger = {
      kind: "auto",
      pattern: skill.errorPattern,
      confidence: skill.confidence,
    };

    return {
      id: `learned:${skill.id}`,
      name: `Learned: ${skill.diagnosis.slice(0, 60)}`,
      description: `Auto-learned skill: ${skill.strategy}`,
      trigger,
      template: this.buildSkillTemplate(skill),
      enabled: skill.confidence >= DEPRECATION_THRESHOLD,
      tags: [
        "learned",
        ...(skill.scope?.language ? [skill.scope.language] : []),
        ...(skill.scope?.framework ? [skill.scope.framework] : []),
      ],
    };
  }

  /**
   * Learn from user correction (highest signal).
   * When a user manually corrects the agent's work, this captures
   * the before/after delta as a new skill.
   */
  learnFromCorrection(
    before: string,
    after: string,
    context: Record<string, unknown>,
  ): LearnedSkill | null {
    // Build a pattern from the context
    const errorMsg =
      typeof context.errorMessage === "string"
        ? context.errorMessage
        : "user_correction";
    const errorPattern = this.buildErrorPattern(errorMsg);

    const skill: LearnedSkill = {
      id: this.generateId(`correction:${errorPattern}`),
      errorPattern,
      diagnosis: `User corrected agent output`,
      strategy: `Apply user correction pattern: ${after.slice(0, 200)}`,
      toolSequence: ["file_edit"],
      validation: "User verification",
      confidence: 0.7, // User corrections start with higher confidence
      usageCount: 1,
      successCount: 1,
      lastUsed: Date.now(),
      createdFrom: {
        sessionId: String(context.sessionId ?? "unknown"),
        errorMessage: errorMsg,
        fixSummary: `User changed: ${before.slice(0, 100)} → ${after.slice(0, 100)}`,
        timestamp: Date.now(),
      },
      scope:
        typeof context.language === "string"
          ? { language: context.language }
          : undefined,
    };

    this.skills.set(skill.id, skill);
    return skill;
  }

  /**
   * Get all loaded skills.
   */
  getAllSkills(): LearnedSkill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Get skill by ID.
   */
  getSkill(id: string): LearnedSkill | undefined {
    return this.skills.get(id);
  }

  /**
   * Persist all skills to disk.
   */
  async save(): Promise<void> {
    await this.saveSkills();
  }

  // ─── Private: Persistence ───

  private async loadSkills(): Promise<void> {
    try {
      const files = await readdir(this.storagePath);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = await readFile(join(this.storagePath, file), "utf-8");
          const skill = JSON.parse(raw) as LearnedSkill;
          if (skill.id) {
            this.skills.set(skill.id, skill);
          }
        } catch {
          // Skip corrupted skill files
        }
      }
    } catch {
      // Directory doesn't exist yet — that's fine
    }
  }

  private async saveSkills(): Promise<void> {
    await mkdir(this.storagePath, { recursive: true });
    for (const skill of this.skills.values()) {
      await this.saveSkill(skill);
    }

    // Clean up files for deleted skills
    try {
      const files = await readdir(this.storagePath);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const id = file.replace(".json", "");
        if (!this.skills.has(id)) {
          await unlink(join(this.storagePath, file));
        }
      }
    } catch {
      // ignore cleanup errors
    }
  }

  private async saveSkill(skill: LearnedSkill): Promise<void> {
    await mkdir(this.storagePath, { recursive: true });
    const filePath = join(this.storagePath, `${skill.id}.json`);
    await writeFile(filePath, JSON.stringify(skill, null, 2), "utf-8");
  }

  // ─── Private: Helpers ───

  private generateId(pattern: string): string {
    // Simple hash from pattern string
    let hash = 0;
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern.charCodeAt(i);
      hash = ((hash << 5) - hash + ch) | 0;
    }
    const hex = Math.abs(hash).toString(16).padStart(8, "0");
    return `skill_${hex}`;
  }

  private buildErrorPattern(message: string): string {
    // Escape special regex chars but keep structure meaningful
    return message
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\d+/g, "\\d+") // Generalize numbers
      .replace(/\s+/g, "\\s+") // Generalize whitespace
      .slice(0, 200); // Limit pattern length
  }

  private inferValidation(errorType: string): string {
    switch (errorType) {
      case "TypeScriptError":
        return "tsc --noEmit";
      case "LintError":
        return "eslint --quiet";
      case "TestFailure":
        return "npm test";
      case "ModuleNotFoundError":
        return "Check import paths exist";
      case "SyntaxError":
        return "tsc --noEmit";
      default:
        return "Build check";
    }
  }

  private inferScope(errorPattern: {
    type: string;
    tool: string;
  }): LearnedSkill["scope"] | undefined {
    if (
      errorPattern.type === "TypeScriptError" ||
      errorPattern.tool === "tsc"
    ) {
      return { language: "TypeScript", filePattern: "\\.[jt]sx?$" };
    }
    if (errorPattern.type === "LintError") {
      return { filePattern: "\\.[jt]sx?$" };
    }
    return undefined;
  }

  private buildSkillTemplate(skill: LearnedSkill): string {
    const lines: string[] = [
      `## Learned Skill: ${skill.diagnosis}`,
      "",
      `**Pattern:** \`${skill.errorPattern}\``,
      `**Confidence:** ${skill.confidence.toFixed(2)}`,
      `**Uses:** ${skill.usageCount} (${skill.successCount} successes)`,
      "",
      `### Strategy`,
      skill.strategy,
      "",
      `### Tool Sequence`,
      ...skill.toolSequence.map((t, i) => `${i + 1}. ${t}`),
      "",
      `### Validation`,
      skill.validation,
    ];

    if (skill.scope) {
      lines.push("", "### Scope");
      if (skill.scope.language) lines.push(`- Language: ${skill.scope.language}`);
      if (skill.scope.framework)
        lines.push(`- Framework: ${skill.scope.framework}`);
      if (skill.scope.filePattern)
        lines.push(`- Files: \`${skill.scope.filePattern}\``);
    }

    return lines.join("\n");
  }
}
