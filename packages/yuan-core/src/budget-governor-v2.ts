/**
 * @module budget-governor-v2
 * @description Multi-dimensional Budget Governor v2.
 *
 * Tracks and enforces budgets across six dimensions simultaneously:
 *   task, project, daily, branch, research, model_tier
 *
 * Features:
 * - Graceful degradation: suggests LOCAL model tier when usage >= degradeAtPercent
 * - Hard halt: emits budget_exhausted event when usage >= haltAtPercent
 * - Atomic JSON storage to ~/.yuan/budget/budget-state.json
 * - Daily budget auto-resets at UTC midnight
 * - Never throws — all checks are non-blocking
 */

import { EventEmitter } from "node:events";
import { writeFileSync, readFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Types ───

export type BudgetType =
  | "task"
  | "project"
  | "daily"
  | "branch"
  | "research"
  | "model_tier";

export interface BudgetAllocationV2 {
  type: BudgetType;
  id: string; // task ID, project ID, branch name, etc.
  limit: number; // token count
  used: number;
  remaining: number;
  exhaustedAt?: string;
  degradedAt?: string; // when graceful degradation triggered
}

export interface BudgetPolicy {
  taskBudget: number;      // tokens per task (default 50000)
  projectBudget: number;   // tokens per project (default 500000)
  dailyBudget: number;     // tokens per day (default 200000)
  branchBudget: number;    // tokens per git branch (default 100000)
  researchBudget: number;  // tokens per research session (default 20000)
  degradeAtPercent: number; // % used before degradation (default 80)
  haltAtPercent: number;    // % used before hard stop (default 100)
}

export interface BudgetStatusV2 {
  taskId?: string;
  projectId?: string;
  allocations: BudgetAllocationV2[];
  isDegraded: boolean;  // at least one budget >degradeAtPercent
  isHalted: boolean;    // at least one budget >haltAtPercent
  recommendation: "continue" | "degrade" | "halt";
  suggestedModelTier?: "LOCAL" | "STANDARD" | "PREMIUM";
}

// ─── Internal ───

interface TaskEntry {
  taskId: string;
  projectId?: string;
  branchName?: string;
  startedAt: string;
}

interface PersistedState {
  allocations: BudgetAllocationV2[];
  dailyDate: string; // UTC date string "YYYY-MM-DD"
}

// ─── Defaults ───

const DEFAULT_POLICY: BudgetPolicy = {
  taskBudget: 50_000,
  projectBudget: 500_000,
  dailyBudget: 200_000,
  branchBudget: 100_000,
  researchBudget: 20_000,
  degradeAtPercent: 80,
  haltAtPercent: 100,
};

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function nowIso(): string {
  return new Date().toISOString();
}

// ─── BudgetGovernorV2 ───

export class BudgetGovernorV2 extends EventEmitter {
  private readonly policy: BudgetPolicy;
  private readonly storageDir: string;
  private readonly storagePath: string;

  /** All tracked allocations keyed by `${type}:${id}` */
  private allocations: Map<string, BudgetAllocationV2>;

  /** Active task entries (taskId → metadata) */
  private activeTasks: Map<string, TaskEntry>;

  /** Last known daily date for midnight detection */
  private currentDailyDate: string;

  constructor(policy?: Partial<BudgetPolicy>, storageDir?: string) {
    super();
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.storageDir =
      storageDir ?? join(homedir(), ".yuan", "budget");
    this.storagePath = join(this.storageDir, "budget-state.json");
    this.allocations = new Map();
    this.activeTasks = new Map();
    this.currentDailyDate = todayUtc();
    this._loadState();
  }

  // ─── Public API ───

  /**
   * Start tracking a task.
   * Creates allocation entries for task / project (if given) / daily / branch (if given).
   */
  startTask(taskId: string, projectId?: string, branchName?: string): void {
    try {
      this._checkDailyReset();

      const entry: TaskEntry = {
        taskId,
        projectId,
        branchName,
        startedAt: nowIso(),
      };
      this.activeTasks.set(taskId, entry);

      // Ensure allocation entries exist
      this._ensureAllocation("task", taskId, this.policy.taskBudget);
      if (projectId) {
        this._ensureAllocation("project", projectId, this.policy.projectBudget);
      }
      this._ensureAllocation("daily", this.currentDailyDate, this.policy.dailyBudget);
      if (branchName) {
        this._ensureAllocation("branch", branchName, this.policy.branchBudget);
      }

      this._saveState();
    } catch {
      // never crash main loop
    }
  }

  /**
   * Record token usage for a specific budget dimension.
   * Triggers degradation/exhaustion events as thresholds are crossed.
   */
  recordUsage(tokens: number, budgetType: BudgetType, id: string): void {
    try {
      this._checkDailyReset();

      const key = this._key(budgetType, id);
      let alloc = this.allocations.get(key);

      if (!alloc) {
        // Auto-create allocation for unknown id using policy default
        const limit = this._defaultLimit(budgetType);
        alloc = this._makeAllocation(budgetType, id, limit);
        this.allocations.set(key, alloc);
      }

      const previousUsed = alloc.used;
      alloc.used = Math.min(alloc.used + tokens, Number.MAX_SAFE_INTEGER);
      alloc.remaining = Math.max(0, alloc.limit - alloc.used);

      const percentUsed = alloc.limit > 0 ? (alloc.used / alloc.limit) * 100 : 100;
      const previousPercent =
        alloc.limit > 0 ? (previousUsed / alloc.limit) * 100 : 0;

      const haltThreshold = this.policy.haltAtPercent;
      const degradeThreshold = this.policy.degradeAtPercent;

      // Halt threshold crossed
      if (percentUsed >= haltThreshold && !alloc.exhaustedAt) {
        alloc.exhaustedAt = nowIso();
        this.emit("agent:budget_exhausted", {
          kind: "agent:budget_exhausted",
          budgetType,
          id,
          percentUsed: Math.round(percentUsed * 100) / 100,
          timestamp: alloc.exhaustedAt,
        });
      }

      // Degrade threshold crossed (only once)
      if (
        percentUsed >= degradeThreshold &&
        previousPercent < degradeThreshold &&
        !alloc.degradedAt
      ) {
        alloc.degradedAt = nowIso();
        this.emit("agent:budget_degraded", {
          kind: "agent:budget_degraded",
          budgetType,
          id,
          percentUsed: Math.round(percentUsed * 100) / 100,
          suggestedTier: "LOCAL",
          timestamp: alloc.degradedAt,
        });
      }

      this._saveState();
    } catch {
      // never crash main loop
    }
  }

  /**
   * Check if the task is allowed to continue.
   * Returns status with recommendation ("continue" | "degrade" | "halt").
   */
  check(taskId: string): BudgetStatusV2 {
    try {
      this._checkDailyReset();

      const entry = this.activeTasks.get(taskId);
      const relevantAllocs: BudgetAllocationV2[] = [];

      // Collect allocations relevant to this task
      const taskAlloc = this.allocations.get(this._key("task", taskId));
      if (taskAlloc) relevantAllocs.push(taskAlloc);

      if (entry?.projectId) {
        const pAlloc = this.allocations.get(
          this._key("project", entry.projectId)
        );
        if (pAlloc) relevantAllocs.push(pAlloc);
      }

      const dailyAlloc = this.allocations.get(
        this._key("daily", this.currentDailyDate)
      );
      if (dailyAlloc) relevantAllocs.push(dailyAlloc);

      if (entry?.branchName) {
        const bAlloc = this.allocations.get(
          this._key("branch", entry.branchName)
        );
        if (bAlloc) relevantAllocs.push(bAlloc);
      }

      const haltThreshold = this.policy.haltAtPercent;
      const degradeThreshold = this.policy.degradeAtPercent;

      let isHalted = false;
      let isDegraded = false;

      for (const alloc of relevantAllocs) {
        const percent =
          alloc.limit > 0 ? (alloc.used / alloc.limit) * 100 : 0;
        if (percent >= haltThreshold) isHalted = true;
        if (percent >= degradeThreshold) isDegraded = true;
      }

      const recommendation: "continue" | "degrade" | "halt" = isHalted
        ? "halt"
        : isDegraded
        ? "degrade"
        : "continue";

      const status: BudgetStatusV2 = {
        taskId,
        projectId: entry?.projectId,
        allocations: relevantAllocs,
        isDegraded,
        isHalted,
        recommendation,
        suggestedModelTier: isHalted
          ? "LOCAL"
          : isDegraded
          ? "LOCAL"
          : undefined,
      };

      this.emit("agent:budget_status", {
        kind: "agent:budget_status",
        taskId,
        recommendation,
        timestamp: nowIso(),
      });

      return status;
    } catch {
      // fallback: safe continue
      return {
        taskId,
        allocations: [],
        isDegraded: false,
        isHalted: false,
        recommendation: "continue",
      };
    }
  }

  /**
   * End task and finalize its budget tracking.
   */
  endTask(taskId: string): void {
    try {
      this.activeTasks.delete(taskId);
      this._saveState();
    } catch {
      // never crash main loop
    }
  }

  /**
   * Reset the daily budget allocation.
   * Call this at day boundary or let it auto-detect via internal checks.
   */
  resetDaily(): void {
    try {
      const today = todayUtc();
      this.currentDailyDate = today;

      // Remove old daily allocations and create fresh one
      for (const [key] of this.allocations) {
        if (key.startsWith("daily:")) {
          this.allocations.delete(key);
        }
      }
      this._ensureAllocation("daily", today, this.policy.dailyBudget);
      this._saveState();
    } catch {
      // never crash main loop
    }
  }

  /**
   * Get all current allocations.
   */
  getAllocations(): BudgetAllocationV2[] {
    return Array.from(this.allocations.values());
  }

  // ─── Private Helpers ───

  private _key(type: BudgetType, id: string): string {
    return `${type}:${id}`;
  }

  private _makeAllocation(
    type: BudgetType,
    id: string,
    limit: number
  ): BudgetAllocationV2 {
    return { type, id, limit, used: 0, remaining: limit };
  }

  private _ensureAllocation(
    type: BudgetType,
    id: string,
    limit: number
  ): void {
    const key = this._key(type, id);
    if (!this.allocations.has(key)) {
      this.allocations.set(key, this._makeAllocation(type, id, limit));
    }
  }

  private _defaultLimit(type: BudgetType): number {
    switch (type) {
      case "task":       return this.policy.taskBudget;
      case "project":    return this.policy.projectBudget;
      case "daily":      return this.policy.dailyBudget;
      case "branch":     return this.policy.branchBudget;
      case "research":   return this.policy.researchBudget;
      case "model_tier": return this.policy.taskBudget; // sensible fallback
    }
  }

  /** Auto-detect UTC day rollover and reset daily budget. */
  private _checkDailyReset(): void {
    const today = todayUtc();
    if (today !== this.currentDailyDate) {
      this.resetDaily();
    }
  }

  // ─── Atomic Storage ───

  private _saveState(): void {
    try {
      mkdirSync(this.storageDir, { recursive: true });
      const state: PersistedState = {
        allocations: Array.from(this.allocations.values()),
        dailyDate: this.currentDailyDate,
      };
      const tmp = this.storagePath + ".tmp";
      writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
      // Atomic rename on POSIX
      renameSync(tmp, this.storagePath);
    } catch {
      // storage failure is non-fatal — in-memory state remains valid
    }
  }

  private _loadState(): void {
    try {
      const raw = readFileSync(this.storagePath, "utf-8");
      const state = JSON.parse(raw) as PersistedState;

      // Restore allocations
      this.allocations = new Map();
      if (Array.isArray(state.allocations)) {
        for (const alloc of state.allocations) {
          if (this._isValidAllocation(alloc)) {
            this.allocations.set(this._key(alloc.type, alloc.id), alloc);
          }
        }
      }

      // Restore or reset daily date
      if (typeof state.dailyDate === "string") {
        const today = todayUtc();
        if (state.dailyDate === today) {
          this.currentDailyDate = today;
        } else {
          // Day has changed since last run — reset daily
          this.currentDailyDate = today;
          for (const [key] of this.allocations) {
            if (key.startsWith("daily:")) {
              this.allocations.delete(key);
            }
          }
        }
      }
    } catch {
      // File doesn't exist or is corrupt — start fresh
    }
  }

  private _isValidAllocation(v: unknown): v is BudgetAllocationV2 {
    if (typeof v !== "object" || v === null) return false;
    const obj = v as Record<string, unknown>;
    return (
      typeof obj["type"] === "string" &&
      typeof obj["id"] === "string" &&
      typeof obj["limit"] === "number" &&
      typeof obj["used"] === "number" &&
      typeof obj["remaining"] === "number"
    );
  }
}

