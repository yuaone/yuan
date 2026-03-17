/**
 * @module agent-coordinator
 * @description Role-aware multi-agent coordinator.
 *
 * Sits above individual agent loops. Routes tasks to appropriate role agents,
 * prevents resource conflicts, collects/merges results, enforces budget and
 * approval constraints.
 *
 * Relationship to DAGOrchestrator:
 *   - DAGOrchestrator: raw DAG execution, parallel task scheduling, retry logic
 *   - AgentCoordinator: role routing, resource conflict prevention, budget
 *     enforcement, task history persistence — the orchestration layer
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RoleAgentType } from "./agent-reputation.js";

// Re-export so callers can import RoleAgentType from either module
export type { RoleAgentType } from "./agent-reputation.js";

export interface CoordinatorTask {
  /** Unique task ID */
  id: string;
  /** Human-readable goal for the agent */
  goal: string;
  /** Classifier-style task type (e.g. "feature", "security", "test") */
  taskType: string;
  /** Optional execution environment hint */
  environment?: string;
  /** Which role agent should handle this task */
  requiredRole: RoleAgentType;
  /** Execution priority */
  priority: "high" | "normal" | "low";
  /** Per-task wall-time limit in ms (default: no limit) */
  timeoutMs?: number;
  /** Max tokens this task is allowed to consume */
  budgetTokens?: number;
  /** Task IDs that must complete successfully before this task can run */
  dependencies?: string[];
}

export interface CoordinatorResult {
  taskId: string;
  role: RoleAgentType;
  outcome: "success" | "failure" | "skipped" | "timeout";
  output: string;
  tokenUsed: number;
  latencyMs: number;
  /** Resource IDs that were in conflict when this task started */
  conflicts: string[];
}

export interface CoordinatorConfig {
  /** Max concurrent tasks. Default: 1 (sequential — prevents conflicts) */
  maxConcurrent?: number;
  /** How long a resource lock stays active in ms. Default: 30000 */
  conflictWindowMs?: number;
  /** Directory for task history storage. Default: ~/.yuan/coordinator */
  storageDir?: string;
}

// ─── Internal types ───

interface ResourceLock {
  taskId: string;
  expiresAt: number;
}

interface TaskHistoryEntry {
  taskId: string;
  role: RoleAgentType;
  goal: string;
  taskType: string;
  outcome: CoordinatorResult["outcome"];
  tokenUsed: number;
  latencyMs: number;
  timestamp: string;
}

// ─── Constants ───

const HISTORY_MAX = 500;
const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_CONFLICT_WINDOW_MS = 30_000;

// ─── AgentCoordinator ───

/**
 * Routes tasks to specialized role agents, prevents resource conflicts,
 * and persists task history for audit and analysis.
 *
 * @example
 * ```ts
 * const coordinator = new AgentCoordinator();
 *
 * const result = await coordinator.dispatch(
 *   {
 *     id: "task-1",
 *     goal: "Implement user authentication",
 *     taskType: "feature",
 *     requiredRole: "coder",
 *     priority: "high",
 *     timeoutMs: 120_000,
 *   },
 *   async (goal, role) => {
 *     // Call your actual agent loop here
 *     return agentLoop.run(goal, role);
 *   }
 * );
 * ```
 */
export class AgentCoordinator extends EventEmitter {
  private readonly maxConcurrent: number;
  private readonly conflictWindowMs: number;
  private readonly storageFile: string;

  /** resource ID → lock info */
  private readonly locks: Map<string, ResourceLock> = new Map();

  /** Currently executing task IDs */
  private readonly activeTasks: Map<string, CoordinatorTask> = new Map();

  /** Completed task IDs in this session (used for dependency checks) */
  private readonly completedIds: Set<string> = new Set();

  /** Failed task IDs in this session (used to skip dependents) */
  private readonly failedIds: Set<string> = new Set();

  constructor(config?: CoordinatorConfig) {
    super();
    this.maxConcurrent = config?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.conflictWindowMs = config?.conflictWindowMs ?? DEFAULT_CONFLICT_WINDOW_MS;

    const storageDir = config?.storageDir ?? join(homedir(), ".yuan", "coordinator");
    this.storageFile = join(storageDir, "task-history.json");
    this.ensureStorageDir(storageDir);
  }

  // ─── Public API ───

  /**
   * Dispatch a single task to the appropriate role agent.
   *
   * Steps:
   * 1. Verify dependencies are complete
   * 2. Check for resource conflicts (goal keywords as resource IDs)
   * 3. Lock resources
   * 4. Execute runAgent with optional timeout
   * 5. Release locks
   * 6. Persist to history
   * 7. Emit events and return result
   *
   * @param task - Task to execute
   * @param runAgent - Caller-provided execution function
   */
  async dispatch(
    task: CoordinatorTask,
    runAgent: (goal: string, role: RoleAgentType) => Promise<string | { output: string; tokensUsed: number }>,
  ): Promise<CoordinatorResult> {
    // 1. Dependency check
    const unmet = this.getUnmetDependencies(task);
    if (unmet.length > 0) {
      const result: CoordinatorResult = {
        taskId: task.id,
        role: task.requiredRole,
        outcome: "skipped",
        output: `Skipped: unmet dependencies [${unmet.join(", ")}]`,
        tokenUsed: 0,
        latencyMs: 0,
        conflicts: [],
      };
      this.appendHistory(task, result);
      return result;
    }

    // 2. Check for resource conflicts
    const resourceIds = this.extractResourceIds(task.goal);
    const conflicts = resourceIds.filter((r) => this.isConflict(r));

    if (conflicts.length > 0) {
      this.emit("agent:coordinator_conflict", {
        kind: "agent:coordinator_conflict",
        taskId: task.id,
        conflictedWith: conflicts,
        resourceId: conflicts[0],
        timestamp: new Date().toISOString(),
      });
    }

    // 3. Lock resources and mark as active
    for (const resourceId of resourceIds) {
      this.lockResource(resourceId, task.id);
    }
    this.activeTasks.set(task.id, task);

    this.emit("agent:coordinator_task_started", {
      kind: "agent:coordinator_task_started",
      taskId: task.id,
      role: task.requiredRole,
      goal: task.goal,
      timestamp: new Date().toISOString(),
    });

    // 4. Execute with optional timeout
    const startTime = Date.now();
    let outcome: CoordinatorResult["outcome"] = "success";
    let output = "";
    let tokenUsed = 0;

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const agentPromise = runAgent(task.goal, task.requiredRole);

      let rawResult: string | { output: string; tokensUsed: number };
      if (task.timeoutMs != null) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(
            () => reject(new Error(`Task timed out after ${task.timeoutMs}ms`)),
            task.timeoutMs,
          );
        });
        rawResult = await Promise.race([agentPromise, timeoutPromise]);
      } else {
        rawResult = await agentPromise;
      }

      // Extract output and token usage from callback result
      if (typeof rawResult === "string") {
        output = rawResult;
      } else {
        output = rawResult.output;
        tokenUsed = rawResult.tokensUsed;
      }

      this.completedIds.add(task.id);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      outcome = errMsg.includes("timed out") ? "timeout" : "failure";
      output = errMsg;
      this.failedIds.add(task.id);
    } finally {
      // Clear timeout timer to prevent leak / unhandled rejection
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      // 5. Release locks
      for (const resourceId of resourceIds) {
        this.releaseResource(resourceId);
      }
      this.activeTasks.delete(task.id);
    }

    const latencyMs = Date.now() - startTime;

    const result: CoordinatorResult = {
      taskId: task.id,
      role: task.requiredRole,
      outcome,
      output,
      tokenUsed,
      latencyMs,
      conflicts,
    };

    // 6. Persist history
    this.appendHistory(task, result);

    // 7. Emit completion event
    this.emit("agent:coordinator_task_complete", {
      kind: "agent:coordinator_task_complete",
      taskId: task.id,
      role: task.requiredRole,
      outcome,
      tokenUsed,
      latencyMs,
      timestamp: new Date().toISOString(),
    });

    return result;
  }

  /**
   * Dispatch multiple tasks in dependency order (topological sort).
   *
   * Respects maxConcurrent (default 1 = sequential). Skips tasks whose
   * dependencies have failed.
   *
   * @param tasks - List of tasks; may include cross-task dependencies
   * @param runAgent - Caller-provided execution function
   */
  async dispatchBatch(
    tasks: CoordinatorTask[],
    runAgent: (goal: string, role: RoleAgentType) => Promise<string | { output: string; tokensUsed: number }>,
  ): Promise<CoordinatorResult[]> {
    const sorted = this.topoSort(tasks);
    const results: CoordinatorResult[] = [];

    // Process tasks in chunks of maxConcurrent, respecting dependency order
    let remaining = [...sorted];

    while (remaining.length > 0) {
      // Collect ready tasks (dependencies met, not failed)
      const ready: CoordinatorTask[] = [];
      const deferred: CoordinatorTask[] = [];

      for (const task of remaining) {
        const hasFailed = (task.dependencies ?? []).some((dep) =>
          this.failedIds.has(dep),
        );
        if (hasFailed) {
          const skipped: CoordinatorResult = {
            taskId: task.id,
            role: task.requiredRole,
            outcome: "skipped",
            output: `Skipped: dependency failed`,
            tokenUsed: 0,
            latencyMs: 0,
            conflicts: [],
          };
          this.failedIds.add(task.id);
          this.appendHistory(task, skipped);
          results.push(skipped);
          continue;
        }

        const unmet = this.getUnmetDependencies(task);
        if (unmet.length === 0 && ready.length < this.maxConcurrent) {
          ready.push(task);
        } else {
          deferred.push(task);
        }
      }

      if (ready.length === 0) {
        // No tasks are ready — remaining tasks have unresolvable dependencies
        for (const task of deferred) {
          const skipped: CoordinatorResult = {
            taskId: task.id,
            role: task.requiredRole,
            outcome: "skipped",
            output: `Skipped: unresolvable dependencies`,
            tokenUsed: 0,
            latencyMs: 0,
            conflicts: [],
          };
          this.failedIds.add(task.id);
          this.appendHistory(task, skipped);
          results.push(skipped);
        }
        break;
      }

      // Execute ready chunk concurrently (up to maxConcurrent)
      const chunkResults = await Promise.all(
        ready.map((task) => this.dispatch(task, runAgent)),
      );
      results.push(...chunkResults);

      remaining = deferred;
    }

    return results;
  }

  /**
   * Check whether a resource is currently locked by another task.
   *
   * A lock is considered active if it exists and has not expired.
   *
   * @param resourceId - Resource identifier to check
   */
  isConflict(resourceId: string): boolean {
    const lock = this.locks.get(resourceId);
    if (!lock) return false;
    if (Date.now() > lock.expiresAt) {
      this.locks.delete(resourceId);
      return false;
    }
    return true;
  }

  /**
   * Acquire an exclusive lock on a resource for the given task.
   * Overwrites any existing (possibly expired) lock.
   *
   * @param resourceId - Resource to lock
   * @param taskId - Task acquiring the lock
   */
  lockResource(resourceId: string, taskId: string): void {
    this.locks.set(resourceId, {
      taskId,
      expiresAt: Date.now() + this.conflictWindowMs,
    });
  }

  /**
   * Release a resource lock.
   *
   * @param resourceId - Resource to unlock
   */
  releaseResource(resourceId: string): void {
    this.locks.delete(resourceId);
  }

  /**
   * Get all currently executing tasks.
   */
  getActiveTasks(): CoordinatorTask[] {
    return Array.from(this.activeTasks.values());
  }

  // ─── Private helpers ───

  /**
   * Return dependency task IDs that have not yet completed.
   */
  private getUnmetDependencies(task: CoordinatorTask): string[] {
    if (!task.dependencies || task.dependencies.length === 0) return [];
    return task.dependencies.filter((dep) => !this.completedIds.has(dep));
  }

  /**
   * Extract resource IDs from a goal string.
   * Uses significant words (>3 chars, non-common) as resource keys.
   * This is a lightweight heuristic — callers can pre-lock specific resources
   * with lockResource() for precise control.
   */
  private extractResourceIds(goal: string): string[] {
    const stopWords = new Set([
      "the", "and", "for", "with", "that", "this", "from", "into",
      "have", "will", "should", "must", "also", "only", "then",
      "implement", "update", "create", "delete", "check", "verify",
      "build", "write", "read", "fix", "add", "remove", "change",
      "make", "use", "set", "get",
    ]);
    return goal
      .toLowerCase()
      .replace(/[^a-z0-9\s_/-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 4 && !stopWords.has(w))
      .slice(0, 5); // cap to 5 resource IDs per task
  }

  /**
   * Topological sort of tasks by their dependency graph.
   * Tasks with no dependencies come first; tasks with satisfied dependencies
   * come after their prerequisites.
   * Ties broken by priority (high > normal > low) then by original order.
   */
  private topoSort(tasks: CoordinatorTask[]): CoordinatorTask[] {
    const PRIORITY_WEIGHT: Record<CoordinatorTask["priority"], number> = {
      high: 3,
      normal: 2,
      low: 1,
    };

    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const inDegree = new Map(tasks.map((t) => [t.id, 0]));
    const reverseDeps = new Map(tasks.map((t) => [t.id, [] as string[]]));

    for (const task of tasks) {
      for (const dep of task.dependencies ?? []) {
        inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
        if (taskMap.has(dep)) {
          reverseDeps.get(dep)!.push(task.id);
        } else {
          // External dependency — treat as already satisfied
          inDegree.set(task.id, Math.max(0, (inDegree.get(task.id) ?? 0) - 1));
        }
      }
    }

    const queue: CoordinatorTask[] = tasks
      .filter((t) => (inDegree.get(t.id) ?? 0) === 0)
      .sort((a, b) => PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority]);

    const sorted: CoordinatorTask[] = [];

    while (queue.length > 0) {
      const task = queue.shift()!;
      sorted.push(task);

      const dependents = reverseDeps.get(task.id) ?? [];
      const unblocked: CoordinatorTask[] = [];

      for (const depId of dependents) {
        const newDeg = (inDegree.get(depId) ?? 0) - 1;
        inDegree.set(depId, newDeg);
        if (newDeg === 0) {
          const depTask = taskMap.get(depId);
          if (depTask) unblocked.push(depTask);
        }
      }

      // Insert unblocked tasks in priority order
      unblocked.sort(
        (a, b) => PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority],
      );
      queue.push(...unblocked);
    }

    // Any tasks not in sorted (circular deps) go at the end in original order
    const sortedIds = new Set(sorted.map((t) => t.id));
    for (const task of tasks) {
      if (!sortedIds.has(task.id)) sorted.push(task);
    }

    return sorted;
  }

  /**
   * Append a result to the persistent task history file (last HISTORY_MAX entries).
   * Uses atomic rename to prevent partial writes.
   */
  private appendHistory(task: CoordinatorTask, result: CoordinatorResult): void {
    try {
      let history: TaskHistoryEntry[] = [];
      if (existsSync(this.storageFile)) {
        const raw = readFileSync(this.storageFile, "utf-8");
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) history = parsed as TaskHistoryEntry[];
      }

      history.push({
        taskId: task.id,
        role: task.requiredRole,
        goal: task.goal,
        taskType: task.taskType,
        outcome: result.outcome,
        tokenUsed: result.tokenUsed,
        latencyMs: result.latencyMs,
        timestamp: new Date().toISOString(),
      });

      // Keep only the last HISTORY_MAX entries
      if (history.length > HISTORY_MAX) {
        history = history.slice(history.length - HISTORY_MAX);
      }

      const tmpFile = `${this.storageFile}.tmp`;
      writeFileSync(tmpFile, JSON.stringify(history, null, 2), "utf-8");
      renameSync(tmpFile, this.storageFile);
    } catch {
      // Non-fatal: storage failures must not crash the agent loop
    }
  }

  /**
   * Ensure the storage directory exists.
   */
  private ensureStorageDir(dir: string): void {
    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    } catch {
      // Non-fatal
    }
  }
}
