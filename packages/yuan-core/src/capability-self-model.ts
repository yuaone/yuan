/**
 * @module capability-self-model
 * @description Capability-Aware Self Model — tracks tool availability, environment
 * strengths/weaknesses, and generates self-assessments for planning.
 *
 * Reduces overconfidence and improves plan quality by surfacing:
 * - Which tools are available and which require approval
 * - Which environment+taskType combinations have low success rates
 * - Human-readable planning constraints derived from recorded outcomes
 *
 * Storage: ~/.yuan/self-model/capability-state.json
 *
 * @example
 * ```typescript
 * const model = new CapabilitySelfModel();
 *
 * // Record outcomes over time
 * model.recordOutcome("typescript", "bugfix", true);
 * model.recordOutcome("python", "refactor", false);
 *
 * // Check tool availability before planning
 * const check = model.canUse("shell_exec");
 * // { allowed: true, requiresApproval: true }
 *
 * // Generate self-assessment at planning time
 * const assessment = model.assess();
 * // assessment.planningConstraints → ["Weak at Python refactor (40% success)", ...]
 * // assessment.overallConfidence   → 0.67
 * ```
 */

import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Tracks whether a specific tool is available and what approval it requires. */
export interface ToolAvailability {
  toolName: string;
  isAvailable: boolean;
  requiresApproval: boolean;
  isReadOnly: boolean;
  lastChecked: string;
}

/**
 * Tracks the agent's success rate in a specific environment+taskType combination.
 *
 * Rating thresholds (Laplace-smoothed success rate):
 * - >= 0.75 → "strong"
 * - >= 0.50 → "adequate"
 * - >= 0.25 → "weak"
 * - sampleCount < 3 → "unknown"
 */
export interface EnvironmentStrength {
  /** e.g. "typescript", "nextjs", "python", "rust" */
  environment: string;
  /** e.g. "bugfix", "refactor", "feature", "test" */
  taskType: string;
  /** Laplace-smoothed success rate (0..1) */
  successRate: number;
  sampleCount: number;
  rating: "strong" | "adequate" | "weak" | "unknown";
}

/**
 * Full self-assessment snapshot generated at planning time.
 */
export interface SelfAssessment {
  availableTools: ToolAvailability[];
  strengths: EnvironmentStrength[];
  weaknesses: EnvironmentStrength[];
  /** Human-readable list of what the agent should be cautious about. */
  planningConstraints: string[];
  /** Weighted average of environment success rates (0..1). */
  overallConfidence: number;
  generatedAt: string;
}

// ─── Persistence Shape ───────────────────────────────────────────────────────

interface PersistedState {
  tools: ToolAvailability[];
  environments: EnvironmentStrength[];
}

// ─── Default Tools ───────────────────────────────────────────────────────────

type DefaultToolName =
  | "read_file"
  | "write_file"
  | "shell_exec"
  | "grep"
  | "glob"
  | "git_ops";

const DEFAULT_TOOLS: Record<
  DefaultToolName,
  { requiresApproval: boolean; isReadOnly: boolean }
> = {
  read_file:  { requiresApproval: false, isReadOnly: true  },
  write_file: { requiresApproval: true,  isReadOnly: false },
  shell_exec: { requiresApproval: true,  isReadOnly: false },
  grep:       { requiresApproval: false, isReadOnly: true  },
  glob:       { requiresApproval: false, isReadOnly: true  },
  git_ops:    { requiresApproval: true,  isReadOnly: false },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Laplace-smoothed success rate: (successes + 1) / (total + 2) */
function laplaceRate(successCount: number, totalCount: number): number {
  return (successCount + 1) / (totalCount + 2);
}

/** Derive a rating from a smoothed success rate and raw sample count. */
function deriveRating(
  successRate: number,
  sampleCount: number,
): EnvironmentStrength["rating"] {
  if (sampleCount < 3) return "unknown";
  if (successRate >= 0.75) return "strong";
  if (successRate >= 0.50) return "adequate";
  if (successRate >= 0.25) return "weak";
  return "weak";
}

/** Composite key for environment+taskType lookup. */
function envKey(environment: string, taskType: string): string {
  return `${environment}::${taskType}`;
}

// ─── Class ───────────────────────────────────────────────────────────────────

/**
 * Capability-Aware Self Model.
 *
 * Maintains an in-memory + persisted record of:
 * 1. Tool availability (registered via `registerTool`)
 * 2. Environment+taskType success rates (updated via `recordOutcome`)
 *
 * Emits `agent:self_model_updated` whenever state changes.
 */
export class CapabilitySelfModel extends EventEmitter {
  private readonly storageFile: string;
  private tools: Map<string, ToolAvailability>;
  private environments: Map<string, EnvironmentStrength>;

  constructor(storageDir?: string) {
    super();
    const dir = storageDir ?? join(homedir(), ".yuan", "self-model");
    this.storageFile = join(dir, "capability-state.json");

    const loaded = this._load(dir);
    this.tools = loaded.tools;
    this.environments = loaded.environments;

    // Pre-register default tools only if they weren't already in persisted state.
    for (const [name, opts] of Object.entries(DEFAULT_TOOLS) as [
      DefaultToolName,
      { requiresApproval: boolean; isReadOnly: boolean },
    ][]) {
      if (!this.tools.has(name)) {
        this._upsertTool(name, {
          requiresApproval: opts.requiresApproval,
          isReadOnly: opts.isReadOnly,
          isAvailable: true,
        });
      }
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Register (or update) a tool's availability metadata.
   *
   * @param toolName - Unique tool identifier.
   * @param opts - Approval/read-only/availability flags.
   */
  registerTool(
    toolName: string,
    opts: { requiresApproval: boolean; isReadOnly: boolean; isAvailable?: boolean },
  ): void {
    this._upsertTool(toolName, opts);
    this._save();
    this.emit("agent:self_model_updated", {
      kind: "agent:self_model_updated",
      action: "tool_registered",
      toolName,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Record a success or failure for a specific environment+taskType combination.
   * Updates the Laplace-smoothed success rate and re-derives the rating.
   *
   * @param environment - e.g. "typescript", "python"
   * @param taskType    - e.g. "bugfix", "refactor"
   * @param success     - Whether the task succeeded.
   */
  recordOutcome(environment: string, taskType: string, success: boolean): void {
    const key = envKey(environment, taskType);
    const existing = this.environments.get(key) ?? {
      environment,
      taskType,
      successRate: 0.5,
      sampleCount: 0,
      rating: "unknown" as EnvironmentStrength["rating"],
    };

    // Track raw counts (store them as hidden fields via type cast).
    const raw = existing as EnvironmentStrength & {
      _successCount?: number;
      _totalCount?: number;
    };
    const successCount = (raw._successCount ?? 0) + (success ? 1 : 0);
    const totalCount   = (raw._totalCount  ?? 0) + 1;

    const smoothed = laplaceRate(successCount, totalCount);
    const rating   = deriveRating(smoothed, totalCount);

    const updated: EnvironmentStrength & {
      _successCount: number;
      _totalCount: number;
    } = {
      environment,
      taskType,
      successRate: smoothed,
      sampleCount: totalCount,
      rating,
      _successCount: successCount,
      _totalCount: totalCount,
    };

    this.environments.set(key, updated);
    this._save();

    this.emit("agent:self_model_updated", {
      kind: "agent:self_model_updated",
      action: "outcome_recorded",
      environment,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Generate a self-assessment snapshot.
   * Intended to be called at planning time to inform plan quality.
   */
  assess(): SelfAssessment {
    const now = new Date().toISOString();
    const availableTools = Array.from(this.tools.values());
    const allEnvs = Array.from(this.environments.values());

    const strengths  = allEnvs.filter((e) => e.rating === "strong" || e.rating === "adequate");
    const weaknesses = allEnvs.filter((e) => e.rating === "weak" || (e.rating === "unknown" && e.sampleCount >= 3));

    const planningConstraints = this._buildConstraints(availableTools, allEnvs);
    const overallConfidence   = this._computeConfidence(allEnvs);

    return {
      availableTools,
      strengths,
      weaknesses,
      planningConstraints,
      overallConfidence,
      generatedAt: now,
    };
  }

  /**
   * Check whether a specific tool can be used.
   *
   * @param toolName - Tool to check.
   * @returns `{ allowed, requiresApproval, reason? }`
   */
  canUse(toolName: string): {
    allowed: boolean;
    requiresApproval: boolean;
    reason?: string;
  } {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `Tool "${toolName}" is not registered.`,
      };
    }
    if (!tool.isAvailable) {
      return {
        allowed: false,
        requiresApproval: tool.requiresApproval,
        reason: `Tool "${toolName}" is currently unavailable.`,
      };
    }
    return {
      allowed: true,
      requiresApproval: tool.requiresApproval,
    };
  }

  /**
   * Return weak and unknown (with sufficient samples) environment+taskType areas.
   * Use this to add caution to planning prompts.
   */
  getWeakAreas(): EnvironmentStrength[] {
    return Array.from(this.environments.values()).filter(
      (e) =>
        e.rating === "weak" ||
        (e.rating === "unknown" && e.sampleCount >= 3),
    );
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /** Upsert a tool into the in-memory map (does NOT save or emit). */
  private _upsertTool(
    toolName: string,
    opts: { requiresApproval: boolean; isReadOnly: boolean; isAvailable?: boolean },
  ): void {
    const now = new Date().toISOString();
    const existing = this.tools.get(toolName);
    this.tools.set(toolName, {
      toolName,
      isAvailable: opts.isAvailable ?? existing?.isAvailable ?? true,
      requiresApproval: opts.requiresApproval,
      isReadOnly: opts.isReadOnly,
      lastChecked: now,
    });
  }

  /**
   * Build human-readable planning constraints from tool and environment state.
   */
  private _buildConstraints(
    tools: ToolAvailability[],
    envs: EnvironmentStrength[],
  ): string[] {
    const constraints: string[] = [];

    // Tool constraints
    for (const tool of tools) {
      if (!tool.isAvailable) {
        constraints.push(`Tool "${tool.toolName}" is currently unavailable.`);
      } else if (tool.requiresApproval) {
        constraints.push(`"${tool.toolName}" requires approval before use.`);
      }
    }

    // Environment weakness constraints
    for (const env of envs) {
      if (env.rating === "weak") {
        const pct = Math.round(env.successRate * 100);
        constraints.push(
          `Weak at ${env.environment} ${env.taskType} (${pct}% success, n=${env.sampleCount}) — apply extra caution.`,
        );
      } else if (env.rating === "unknown" && env.sampleCount >= 3) {
        const pct = Math.round(env.successRate * 100);
        constraints.push(
          `Uncertain performance in ${env.environment} ${env.taskType} (${pct}% success, n=${env.sampleCount}).`,
        );
      }
    }

    return constraints;
  }

  /**
   * Compute overall confidence as a weighted average of environment success rates.
   * Weights are proportional to sample counts.
   * Returns 0.5 if no environment data is available.
   */
  private _computeConfidence(envs: EnvironmentStrength[]): number {
    if (envs.length === 0) return 0.5;

    let weightedSum = 0;
    let totalWeight = 0;
    for (const env of envs) {
      const w = Math.max(env.sampleCount, 1);
      weightedSum += env.successRate * w;
      totalWeight += w;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0.5;
  }

  /** Load persisted state from disk. Non-fatal on any error. */
  private _load(storageDir: string): {
    tools: Map<string, ToolAvailability>;
    environments: Map<string, EnvironmentStrength>;
  } {
    const empty = {
      tools: new Map<string, ToolAvailability>(),
      environments: new Map<string, EnvironmentStrength>(),
    };

    try {
      if (!existsSync(storageDir)) {
        mkdirSync(storageDir, { recursive: true });
      }
      if (!existsSync(this.storageFile)) return empty;

      const raw = readFileSync(this.storageFile, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;

      const tools = new Map<string, ToolAvailability>();
      for (const t of parsed.tools ?? []) {
        tools.set(t.toolName, t);
      }

      const environments = new Map<string, EnvironmentStrength>();
      for (const e of parsed.environments ?? []) {
        environments.set(envKey(e.environment, e.taskType), e);
      }

      return { tools, environments };
    } catch {
      // Non-fatal: storage failures should not crash the agent loop
      return empty;
    }
  }

  /** Atomically persist current state to disk. Non-fatal on any error. */
  private _save(): void {
    const tmpFile = `${this.storageFile}.tmp`;
    try {
      const state: PersistedState = {
        tools: Array.from(this.tools.values()),
        environments: Array.from(this.environments.values()),
      };
      writeFileSync(tmpFile, JSON.stringify(state, null, 2), "utf8");
      renameSync(tmpFile, this.storageFile);
    } catch {
      // Non-fatal: storage failures should not crash the agent loop
    }
  }
}
