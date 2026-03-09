/**
 * @module parallel-executor
 * @description 병렬 실행 관리자 — 다수의 서브 에이전트를 동시성 제한 내에서 병렬 실행.
 *
 * DAGOrchestrator가 의존성 순서를 결정하고, ParallelExecutor는
 * 독립적인 태스크 배치를 maxParallel 제한 내에서 동시에 실행한다.
 *
 * 각 태스크는 격리된 SubAgent로 실행되며,
 * 하나가 실패해도 나머지는 계속 진행한다 (fault isolation).
 */

import { EventEmitter } from "node:events";
import type {
  BYOKConfig,
  ToolExecutor,
  PlannedTask,
} from "./types.js";
import {
  SubAgent,
  type SubAgentConfig,
  type SubAgentResult,
  type DAGContextLike,
} from "./sub-agent.js";

// ─── Types ───

/** Configuration for the ParallelExecutor */
export interface ParallelExecutorConfig {
  /** Maximum number of sub-agents running concurrently */
  maxParallel: number;
  /** Default BYOK configuration for LLM calls (used when no per-task override) */
  byokConfig: BYOKConfig;
  /** Absolute path to the project root */
  projectPath: string;
  /** Factory to create a ToolExecutor scoped to a working directory */
  createToolExecutor: (
    workDir: string,
    enabledTools?: string[],
  ) => ToolExecutor;
  /**
   * Optional callback to resolve a per-task BYOK configuration.
   * Called for each task before execution. If it returns a config, that config
   * is used instead of the default `byokConfig`. If not provided or returns
   * undefined, the task's `byokOverride` or the default config is used.
   *
   * Resolution order: task.byokOverride > modelResolver(task) > byokConfig
   */
  modelResolver?: (task: PlannedTaskLike) => BYOKConfig | undefined;
}

/** Task input compatible with PlannedTask from types.ts */
export interface PlannedTaskLike {
  /** Unique task identifier */
  id: string;
  /** Task goal description */
  goal: string;
  /** Files this task is allowed to write */
  targetFiles: string[];
  /** Files this task may read (read-only) */
  readFiles: string[];
  /** Tool names to enable */
  tools: string[];
  /** Estimated number of iterations */
  estimatedIterations: number;
  /** Priority (0–10, higher = more urgent) */
  priority: number;
  /** Optional per-task BYOK config override */
  byokOverride?: BYOKConfig;
}

// ─── Parallel Executor Events ───

export interface ParallelExecutorEvents {
  "parallel:start": (taskIds: string[], maxParallel: number) => void;
  "parallel:task_start": (taskId: string) => void;
  "parallel:task_complete": (result: SubAgentResult) => void;
  "parallel:all_complete": (results: SubAgentResult[]) => void;
}

// ─── ParallelExecutor Class ───

/**
 * ParallelExecutor — coordinates multiple sub-agents with concurrency control.
 *
 * Uses a semaphore pattern: maintains a count of running tasks and spawns
 * new ones as slots become available. Tasks within a batch are independent
 * (dependency ordering is handled by the DAGOrchestrator layer above).
 *
 * @example
 * ```typescript
 * const executor = new ParallelExecutor({
 *   maxParallel: 3,
 *   byokConfig: { provider: "anthropic", apiKey: "..." },
 *   projectPath: "/project",
 *   createToolExecutor: (dir, tools) => createExecutor(dir, tools),
 * });
 *
 * executor.on("parallel:task_complete", (result) => {
 *   console.log(`${result.taskId}: ${result.success ? "OK" : "FAIL"}`);
 * });
 *
 * const results = await executor.executeBatch(tasks, dagContext);
 * ```
 */
export class ParallelExecutor extends EventEmitter {
  private readonly config: ParallelExecutorConfig;
  private readonly runningAgents: Map<string, SubAgent> = new Map();
  private abortedAll = false;

  constructor(config: ParallelExecutorConfig) {
    super();
    this.config = config;
  }

  /**
   * Execute multiple tasks in parallel, respecting the max concurrency limit.
   *
   * Tasks are independent — no dependency ordering is performed here
   * (that is the DAGOrchestrator's responsibility). Tasks are sorted by
   * priority (highest first) and launched as concurrency slots open.
   *
   * If one task fails, others continue to completion (fault isolation).
   *
   * @param tasks Array of planned tasks to execute
   * @param dagContext DAG-level context passed to each sub-agent
   * @returns Array of results, one per task, in completion order
   */
  async executeBatch(
    tasks: PlannedTaskLike[],
    dagContext: DAGContextLike,
  ): Promise<SubAgentResult[]> {
    if (tasks.length === 0) return [];

    this.abortedAll = false;
    const taskIds = tasks.map((t) => t.id);

    this.emit(
      "parallel:start",
      taskIds,
      this.config.maxParallel,
    );

    // Sort by priority descending (higher priority first)
    const sortedTasks = [...tasks].sort(
      (a, b) => b.priority - a.priority,
    );

    const results: SubAgentResult[] = [];
    const pending = [...sortedTasks];

    // Use a promise-based semaphore pattern
    const inFlight = new Set<Promise<SubAgentResult>>();

    while (pending.length > 0 || inFlight.size > 0) {
      if (this.abortedAll) {
        // Drain pending without executing
        for (const task of pending) {
          results.push({
            taskId: task.id,
            success: false,
            summary: "Aborted: parallel executor was cancelled",
            changedFiles: [],
            tokensUsed: { input: 0, output: 0 },
            iterations: 0,
            phase: "cleanup",
            error: "Aborted by orchestrator",
          });
        }
        pending.length = 0;

        // Wait for in-flight to finish (they were already aborted)
        if (inFlight.size > 0) {
          const remaining = await Promise.allSettled([...inFlight]);
          for (const settled of remaining) {
            if (settled.status === "fulfilled") {
              results.push(settled.value);
            }
          }
          inFlight.clear();
        }
        break;
      }

      // Fill up to maxParallel slots
      while (
        pending.length > 0 &&
        inFlight.size < this.config.maxParallel &&
        !this.abortedAll
      ) {
        const task = pending.shift()!;
        const promise = this.runTask(task, dagContext);
        inFlight.add(promise);

        // When this task completes, remove from in-flight and collect result
        promise.then((result) => {
          inFlight.delete(promise);
          results.push(result);
          this.runningAgents.delete(task.id);
          this.emit("parallel:task_complete", result);
        }).catch((err) => {
          inFlight.delete(promise);
          this.runningAgents.delete(task.id);
          this.emit("parallel:task_error", { taskId: task.id, error: err });
        });
      }

      // Wait for at least one task to complete before continuing
      if (inFlight.size > 0) {
        await Promise.race([...inFlight]);
      }
    }

    this.emit("parallel:all_complete", results);
    return results;
  }

  /**
   * Get the task IDs of currently running sub-agents.
   * @returns Array of task ID strings
   */
  getRunningTasks(): string[] {
    return [...this.runningAgents.keys()];
  }

  /**
   * Abort all running sub-agents.
   * Each sub-agent will finish its current iteration and then stop.
   */
  abortAll(): void {
    this.abortedAll = true;
    for (const [, agent] of this.runningAgents) {
      agent.abort();
    }
  }

  // ─── Private ───

  /**
   * Run a single task as a SubAgent and return the result.
   */
  /**
   * Resolve the BYOK configuration for a specific task.
   *
   * Resolution order (first non-undefined wins):
   * 1. task.byokOverride — explicit per-task override
   * 2. config.modelResolver(task) — dynamic callback resolution
   * 3. config.byokConfig — batch-level default
   */
  private resolveByokConfig(task: PlannedTaskLike): BYOKConfig {
    return task.byokOverride
      ?? this.config.modelResolver?.(task)
      ?? this.config.byokConfig;
  }

  private async runTask(
    task: PlannedTaskLike,
    dagContext: DAGContextLike,
  ): Promise<SubAgentResult> {
    const taskByokConfig = this.resolveByokConfig(task);

    const subAgentConfig: SubAgentConfig = {
      taskId: task.id,
      goal: task.goal,
      targetFiles: task.targetFiles,
      readFiles: task.readFiles,
      maxIterations: task.estimatedIterations,
      projectPath: this.config.projectPath,
      byokConfig: taskByokConfig,
      tools: task.tools,
      createToolExecutor: this.config.createToolExecutor,
      priority: task.priority,
    };

    const agent = new SubAgent(subAgentConfig);
    this.runningAgents.set(task.id, agent);

    // Forward sub-agent events
    agent.on("subagent:phase", (taskId: string, phase) => {
      this.emit("subagent:phase", taskId, phase);
    });
    agent.on("subagent:iteration", (taskId: string, index: number, tokens: number) => {
      this.emit("subagent:iteration", taskId, index, tokens);
    });

    this.emit("parallel:task_start", task.id);

    try {
      return await agent.run(dagContext);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : String(err);
      return {
        taskId: task.id,
        success: false,
        summary: `Unexpected error: ${errorMessage}`,
        changedFiles: [],
        tokensUsed: { input: 0, output: 0 },
        iterations: 0,
        phase: "cleanup",
        error: errorMessage,
      };
    }
  }
}
