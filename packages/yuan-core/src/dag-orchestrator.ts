/**
 * @module dag-orchestrator
 * @description DAG 기반 병렬 에이전트 오케스트레이터.
 *
 * AgentPlan의 태스크를 의존성 그래프(DAG) 순서에 따라 병렬 실행하고,
 * 완료/실패 이벤트를 수집하여 최종 결과를 반환한다.
 */

import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { AsyncCompletionQueue } from "./async-completion-queue.js";
import type {
  AgentPlan,
  PlannedTask,
  TaskStatus,
  TaskResult,
  DAGExecutionState,
  DAGResult,
  SubAgentContext,
} from "./types.js";
import type { SkillContext } from "./plugin-types.js";
// ─── Config & Options ───

/** DAG 오케스트레이터 설정 */
export interface DAGOrchestratorConfig {
  /** 최대 동시 에이전트 수 */
  maxParallelAgents: number;
  /** 태스크 실패 시 최대 재시도 횟수 (기본 2) */
  maxRetries: number;
  /** 전체 토큰 예산 */
  tokenBudget: number;
  /** 전체 실행 시간 제한 (ms) */
  wallTimeLimit: number;
  /** 에이전트 생성 콜백 — 실제 에이전트 실행을 위임 */
  spawnAgent: (
    task: PlannedTask,
    context: SubAgentContext,
    signal: AbortSignal
  ) => Promise<TaskResult>;
}

/** DAG 실행 옵션 */
export interface DAGExecuteOptions {
  /** 전체 작업 목표 */
  overallGoal: string;
  /** 프로젝트 루트 경로 */
  projectPath: string;
  /** 프로젝트 구조 요약 (선택) */
  projectStructure?: string;
}

// ─── Event types ───

export interface DAGOrchestratorEvents {
  "dag:task_start": { taskId: string; agentId: string };
  "dag:task_complete": { taskId: string; result: TaskResult };
  "dag:task_failed": { taskId: string; error: string; retryCount: number };
  "dag:agent_reasoning": { taskId: string; agentId: string; text: string };
  "dag:progress": {
    completed: number;
    running: number;
    pending: number;
    failed: number;
    total: number;
    tokensUsed: number;
  };
  "dag:complete": DAGResult;
}

// ─── Completion Event (internal) ───

interface CompletionEvent {
  taskId: string;
  success: boolean;
  result?: TaskResult;
  error?: string;
}

/**
 * DAG 기반 병렬 에이전트 오케스트레이터.
 *
 * AgentPlan을 받아 태스크 의존성 그래프를 분석하고,
 * 의존성이 해결된 태스크부터 병렬로 에이전트를 생성하여 실행한다.
 *
 * @example
 * ```ts
 * const orchestrator = new DAGOrchestrator({
 *   maxParallelAgents: 3,
 *   maxRetries: 2,
 *   tokenBudget: 500_000,
 *   wallTimeLimit: 600_000,
 *   spawnAgent: async (task, ctx) => { ... },
 * });
 *
 * const result = await orchestrator.execute(plan, {
 *   overallGoal: "Implement feature X",
 *   projectPath: "/path/to/project",
 * });
 * ```
 */
export class DAGOrchestrator extends EventEmitter {
  private readonly config: DAGOrchestratorConfig;
  /** 태스크 ID → 의존하는 선행 태스크 ID 집합 */
  private dependencyMap: Map<string, Set<string>> = new Map();
  private reverseDependencyMap: Map<string, Set<string>> = new Map();
  /** 태스크 ID → PlannedTask */
  private taskMap: Map<string, PlannedTask> = new Map();
  private depthMap: Map<string, number> = new Map();
  /** 태스크별 재시도 횟수 추적 */
  private retryCounts: Map<string, number> = new Map();

  constructor(config: DAGOrchestratorConfig) {
    super();
    this.config = config;
  }

  /**
   * 실행 계획(AgentPlan)을 DAG 순서에 따라 병렬 실행한다.
   *
   * 1. 실행 가능한 태스크 탐색 (의존성 충족)
   * 2. 에이전트 생성 및 병렬 실행
   * 3. 완료 이벤트 수집 → 상태 갱신
   * 4. 반복 (모든 태스크 완료 또는 예산 소진까지)
   *
   * @param plan - 실행할 에이전트 계획
   * @param options - 실행 옵션 (목표, 프로젝트 경로 등)
   * @returns DAG 실행 최종 결과
   */
  async execute(
    plan: AgentPlan,
    options: DAGExecuteOptions,
  ): Promise<DAGResult> {
this.dependencyMap.clear();
 this.taskMap.clear();
 this.retryCounts.clear();
    // Build lookup structures
    this.buildLookups(plan);
   this.validateDAG(plan);
   this.computeTaskDepths(plan);
    const state = this.initState(plan);
    const startTime = Date.now();
    const completionQueue = new AsyncCompletionQueue<CompletionEvent>();
   const abortController = new AbortController();
    // Main DAG loop
    while (this.hasPendingWork(state)) {
      // Check budget / wall time
      state.wallTimeMs = Date.now() - startTime;
      if (state.totalTokensUsed >= state.totalTokenBudget) {
        // Skip remaining tasks
        this.skipRemaining(state, "Token budget exhausted");
        break;
      }
      if (state.wallTimeMs >= state.wallTimeLimit) {
        this.skipRemaining(state, "Wall time limit exceeded");
        break;
      }

      // Find runnable tasks (respecting maxParallelAgents)
      const runnable = this.findRunnableTasks(state);
      const slotsAvailable =
        Math.min(this.config.maxParallelAgents, plan.maxParallelAgents) -
        state.runningTasks.length;
      const toSpawn = runnable.slice(0, Math.max(0, slotsAvailable));

       const remainingBudget = Math.max(
        0,
        state.totalTokenBudget - state.totalTokensUsed,
      );
      const perTaskBudget =
        toSpawn.length > 0
          ? Math.max(4000, Math.floor(remainingBudget / toSpawn.length))
          : 0;

      // Spawn agents for runnable tasks
      for (const task of toSpawn) {
   if (state.totalTokensUsed >= state.totalTokenBudget) {
   break;
 }
        const agentId = randomUUID();

        // Update state to running
        state.tasks.set(task.id, {
          status: "running",
          agentId,
          iteration: 0,
        });
        state.pendingTasks = state.pendingTasks.filter((id) => id !== task.id);
        state.runningTasks.push(task.id);

        this.emit("dag:task_start", { taskId: task.id, agentId });
        this.emit("dag:agent_reasoning", {
          taskId: task.id,
          agentId,
          text: `Spawned task "${task.goal}"`,
        });
        // Build context for sub-agent
        const context = this.buildSubAgentContext(task, state, options);

const agentContext: SubAgentContext = {
   ...context,
   remainingBudget
 }
        // Spawn agent (fire-and-forget, result via queue)
        this.config
          .spawnAgent(
            task,
            {
              ...context,
              remainingBudget: perTaskBudget,
            },
            abortController.signal,
          )
          .then((result) => {
            completionQueue.push({
              taskId: task.id,
              success: true,
              result,
            });
          })
          .catch((err: unknown) => {
            const errorMsg =
              err instanceof Error ? err.message : String(err);
            completionQueue.push({
              taskId: task.id,
              success: false,
              error: errorMsg,
            });
          });
      }

      // If nothing is running, we're stuck (circular dependency or all blocked)
      if (state.runningTasks.length === 0 && toSpawn.length === 0) {
        this.skipRemaining(
          state,
          "No runnable tasks — possible circular dependency",
        );
        break;
      }

      // Wait for at least one completion
const event = await Promise.race([
  completionQueue.shift(),
  new Promise<CompletionEvent>((_, reject) =>
    setTimeout(() => {
      abortController.abort();
      reject(new Error("Agent timeout"));
    }, 300000),
  ),
]);
      this.processCompletionEvent(state, event);

      // Drain any additional completions that arrived
      for (const extra of completionQueue.drain()) {
        this.processCompletionEvent(state, extra);
      }

      // Emit progress
      state.wallTimeMs = Date.now() - startTime;
      this.emitProgress(state, plan.tasks.length);
    }

    state.wallTimeMs = Date.now() - startTime;
    const result = this.buildResult(state);
    this.emit("dag:complete", result);
    return result;
  }

  /**
   * 의존성이 모두 충족되어 실행 가능한 태스크를 찾는다.
   * priority 내림차순으로 정렬하여 반환한다.
   */
  private findRunnableTasks(state: DAGExecutionState): PlannedTask[] {
    const runnable: PlannedTask[] = [];
    const completedSet = new Set(state.completedTasks);
    for (const taskId of state.pendingTasks) {
      const deps = this.dependencyMap.get(taskId) ?? new Set();
const allDepsCompleted = [...deps].every((depId) =>
  completedSet.has(depId),
);

      if (allDepsCompleted) {
        const task = this.taskMap.get(taskId);
        if (task) {
          runnable.push(task);
        }
      }
    }

    // Sort by priority descending (higher priority first)
    runnable.sort((a, b) => b.priority - a.priority);
    return runnable;
  }

  /**
   * 아직 처리해야 할 작업이 남아있는지 확인한다.
   */
  private hasPendingWork(state: DAGExecutionState): boolean {
    return state.pendingTasks.length > 0 || state.runningTasks.length > 0;
  }

  /**
   * AgentPlan으로부터 초기 실행 상태를 생성한다.
   */
  private initState(plan: AgentPlan): DAGExecutionState {
    const tasks = new Map<string, TaskStatus>();
    const pendingTasks: string[] = [];

for (const task of plan.tasks) {
  const deps = this.dependencyMap.get(task.id) ?? new Set();

  if (deps.size === 0) {
    tasks.set(task.id, { status: "pending" });
  } else {
    tasks.set(task.id, {
      status: "blocked",
      waitingFor: [...deps],
    });
  }
  pendingTasks.push(task.id)
}

    return {
      dagId: randomUUID(),
      tasks,
      completedTasks: [],
      runningTasks: [],
      pendingTasks,
      failedTasks: [],
      totalTokensUsed: 0,
      totalTokenBudget: this.config.tokenBudget,
      wallTimeMs: 0,
      wallTimeLimit: this.config.wallTimeLimit,
    };
  }

  /**
   * 태스크 완료 후 실행 상태를 갱신한다.
   */
  private updateState(state: DAGExecutionState, result: TaskResult): void {
    state.tasks.set(result.taskId, {
      status: "completed",
      result,
      tokensUsed: result.tokensUsed,
    });

    state.runningTasks = state.runningTasks.filter(
      (id) => id !== result.taskId,
    );
    state.completedTasks.push(result.taskId);
    state.totalTokensUsed += result.tokensUsed;

    // Unblock dependent tasks
 const dependents =
   this.reverseDependencyMap.get(result.taskId) ?? new Set();

 for (const taskId of dependents) {

      const taskStatus = state.tasks.get(taskId);
      if (taskStatus && taskStatus.status === "blocked") {
        const remaining = taskStatus.waitingFor.filter(
          (id) => !state.completedTasks.includes(id),
        );
        if (remaining.length === 0) {
          state.tasks.set(taskId, { status: "pending" });
          state.pendingTasks.push(taskId)
        } else {
          state.tasks.set(taskId, {
            status: "blocked",
            waitingFor: remaining,
          });
        }
      }
    }
  }

  /**
   * 태스크 실패를 처리한다. 재시도 한도 내이면 pending으로 되돌린다.
   */
  private handleFailure(
    state: DAGExecutionState,
    taskId: string,
    error: string,
  ): void {
    const retryCount = (this.retryCounts.get(taskId) ?? 0) + 1;
    this.retryCounts.set(taskId, retryCount);

    state.runningTasks = state.runningTasks.filter((id) => id !== taskId);

    if (retryCount <= this.config.maxRetries) {
      // Retry: move back to pending
      state.tasks.set(taskId, { status: "pending" });
      state.pendingTasks.push(taskId);

      this.emit("dag:task_failed", { taskId, error, retryCount });
    } else {
      // Exhausted retries
      state.tasks.set(taskId, {
        status: "failed",
        error,
        retryCount,
      });
      state.failedTasks.push(taskId);

      this.emit("dag:task_failed", { taskId, error, retryCount });

      // Skip tasks that depend on this failed task
      this.skipDependents(state, taskId);
    }
  }

  /**
   * 최종 DAGResult를 생성한다.
   */
  private buildResult(state: DAGExecutionState): DAGResult {
    const completedTasks: TaskResult[] = [];
    const failedTasks: { taskId: string; error: string }[] = [];
    const skippedTasks: { taskId: string; reason: string }[] = [];

    for (const [taskId, taskStatus] of state.tasks) {
      switch (taskStatus.status) {
        case "completed":
          completedTasks.push(taskStatus.result);
          break;
        case "failed":
          failedTasks.push({ taskId, error: taskStatus.error });
          break;
        case "skipped":
          skippedTasks.push({ taskId, reason: taskStatus.reason });
          break;
        // pending/blocked/running are unexpected at this point
      }
    }

    return {
      dagId: state.dagId,
      success: failedTasks.length === 0 && skippedTasks.length === 0,
      completedTasks,
      failedTasks,
      skippedTasks,
      totalTokens: state.totalTokensUsed,
      totalDurationMs: state.wallTimeMs,
    };
  }

  // ─── Private helpers ───

  /** plan으로부터 의존성 맵과 태스크 맵을 빌드한다. */
  private buildLookups(plan: AgentPlan): void {
    this.dependencyMap.clear();
    this.reverseDependencyMap.clear();
    this.taskMap.clear();
    this.retryCounts.clear();

    for (const task of plan.tasks) {
      this.taskMap.set(task.id, task);
      this.dependencyMap.set(task.id, new Set());
      this.reverseDependencyMap.set(task.id, new Set());
    }

    for (const [from, to] of plan.dependencies) {
      // "from" must complete before "to" can run
      const deps = this.dependencyMap.get(to);
      if (deps) {
        deps.add(from);
      }
    const rev = this.reverseDependencyMap.get(from);
    if (rev) {
      rev.add(to);
    }
    }
  }

  /** 완료 이벤트를 처리한다. */
  private processCompletionEvent(
    state: DAGExecutionState,
    event: CompletionEvent,
  ): void {
    if (event.success && event.result) {
      this.updateState(state, event.result);
      this.emit("dag:task_complete", {
        taskId: event.taskId,
        result: event.result,
      });
    } else {
      this.handleFailure(state, event.taskId, event.error ?? "Unknown error");
    }
  }

  /** 실패한 태스크에 의존하는 모든 후속 태스크를 건너뛴다. */
  private skipDependents(state: DAGExecutionState, failedId: string): void {
    const toSkip: string[] = [];

    const collectDependents = (id: string): void => {
      for (const [taskId, deps] of this.dependencyMap) {
        if (deps.has(id) && !toSkip.includes(taskId)) {
          const taskStatus = state.tasks.get(taskId);
          if (
            taskStatus &&
            (taskStatus.status === "pending" || taskStatus.status === "blocked")
          ) {
            toSkip.push(taskId);
            collectDependents(taskId);
          }
        }
      }
    };

    collectDependents(failedId);

    for (const taskId of toSkip) {
      state.tasks.set(taskId, {
        status: "skipped",
        reason: `Dependency "${failedId}" failed`,
      });
      state.pendingTasks = state.pendingTasks.filter((id) => id !== taskId);
    }
  }

  /** 남은 모든 pending/blocked 태스크를 skip 처리한다. */
  private skipRemaining(state: DAGExecutionState, reason: string): void {
    for (const taskId of [...state.pendingTasks]) {
      state.tasks.set(taskId, { status: "skipped", reason });
    }
    state.pendingTasks = [];

  }

  private validateDAG(plan: AgentPlan): void {
  const inDegree = new Map<string, number>();

  for (const task of plan.tasks) {
    inDegree.set(task.id, 0);
  }

  for (const [from, to] of plan.dependencies) {
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let visited = 0;

  while (queue.length > 0) {
    const id = queue.shift()!;
    visited++;

    for (const [from, to] of plan.dependencies) {
      if (from !== id) continue;

      const deg = (inDegree.get(to) ?? 0) - 1;
      inDegree.set(to, deg);

      if (deg === 0) queue.push(to);
    }
  }

  if (visited !== plan.tasks.length) {
    throw new Error("Invalid DAG: circular dependency detected");
  }
}

  /** 서브 에이전트 컨텍스트를 빌드한다. */
  private buildSubAgentContext(
    task: PlannedTask,
    state: DAGExecutionState,
    options: DAGExecuteOptions,
  ): SubAgentContext {
    // Collect results from dependency tasks
    const deps = this.dependencyMap.get(task.id) ?? new Set();
    const dependencyResults: SubAgentContext["dependencyResults"] = [];
    const skillContext: SkillContext = {
      taskDescription: task.goal,
      filePath: task.targetFiles[0],
    };
    for (const depId of deps) {
      const depStatus = state.tasks.get(depId);
      if (depStatus && depStatus.status === "completed") {
        dependencyResults.push({
          taskId: depId,
          summary: depStatus.result.summary,
          changedFiles: depStatus.result.changedFiles,
        });
      }
    }

    return {
      overallGoal: options.overallGoal,
      taskGoal: task.goal,
      targetFiles: task.targetFiles,
      readFiles: task.readFiles,
      projectStructure: options.projectStructure ?? "",
      skillContext,
      resolvedSkills: task.resolvedSkills,
      dependencyResults:
        dependencyResults.length > 0 ? dependencyResults : undefined,
    };
  }
private computeTaskDepths(plan: AgentPlan): void {
  const memo = new Map<string, number>();

  const dfs = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!;

    const deps = this.dependencyMap.get(id) ?? new Set();

    if (deps.size === 0) {
      memo.set(id, 0);
      return 0;
    }

    const depth =
      1 + Math.max(...[...deps].map((d) => dfs(d)));

    memo.set(id, depth);
    return depth;
  };

  for (const task of plan.tasks) {
    const depth = dfs(task.id);
    this.depthMap.set(task.id, depth);
  }
}
  /** 진행 상황 이벤트를 emit한다. */
  private emitProgress(state: DAGExecutionState, total: number): void {
    this.emit("dag:progress", {
      completed: state.completedTasks.length,
      running: state.runningTasks.length,
      pending: state.pendingTasks.length,
      failed: state.failedTasks.length,
      total,
      tokensUsed: state.totalTokensUsed,
    });
  }
}
