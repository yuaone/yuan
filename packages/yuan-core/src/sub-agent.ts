/**
 * @module sub-agent
 * @description 서브 에이전트 라이프사이클 관리 — 생성, 컨텍스트 준비, 실행, 결과 수집.
 *
 * 서브 에이전트는 독립된 LLM 세션으로 실행되며,
 * 대상 파일 범위가 제한된 전용 시스템 프롬프트를 받는다.
 *
 * Lifecycle: SPAWN → INIT → EXECUTE → VALIDATE → REPORT → CLEANUP
 */

import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  BYOKConfig,
  ToolExecutor,
  PlannedTask,
  SubAgentContext,
  AgentTermination,
} from "./types.js";
import { AgentLoop } from "./agent-loop.js";
import type { GovernorConfig } from "./governor.js";

const execFileAsync = promisify(execFile);

// ─── Types ───

/** Sub-agent lifecycle phase */
export type SubAgentPhase =
  | "spawn"
  | "init"
  | "execute"
  | "validate"
  | "report"
  | "cleanup";

/** Configuration for spawning a sub-agent */
export interface SubAgentConfig {
  /** Unique task identifier */
  taskId: string;
  /** Task goal description */
  goal: string;
  /** Files this sub-agent is allowed to write */
  targetFiles: string[];
  /** Files this sub-agent may read (read-only) */
  readFiles: string[];
  /** Maximum iterations before forced stop */
  maxIterations: number;
  /** Absolute path to the project root */
  projectPath: string;
  /** BYOK configuration for LLM calls */
  byokConfig: BYOKConfig;
  /** List of tool names to enable for this sub-agent */
  tools: string[];
  /** Factory to create a ToolExecutor scoped to workDir and enabled tools */
  createToolExecutor: (
    workDir: string,
    enabledTools?: string[],
  ) => ToolExecutor;
  /** Task priority (0–10, higher is more urgent) */
  priority?: number;
  /** Governor configuration overrides */
  governorConfig?: Partial<GovernorConfig>;
}

/** Result returned when a sub-agent completes (success or failure) */
export interface SubAgentResult {
  /** Task identifier */
  taskId: string;
  /** Whether the task goal was achieved */
  success: boolean;
  /** Human-readable summary of what was done */
  summary: string;
  /** Files changed with unified diffs */
  changedFiles: { path: string; diff: string }[];
  /** Token consumption */
  tokensUsed: { input: number; output: number };
  /** Number of loop iterations executed */
  iterations: number;
  /** Phase at completion */
  phase: SubAgentPhase;
  /** Error message if the sub-agent failed */
  error?: string;
}

/** DAG context passed to a sub-agent so it understands its place in the plan */
export interface DAGContextLike {
  /** The overall user goal for the entire DAG */
  overallGoal: string;
  /** Total number of tasks in the DAG */
  totalTasks: number;
  /** Already-completed tasks with summaries */
  completedTasks: { taskId: string; summary: string }[];
  /** Task IDs currently running in parallel */
  runningTasks: string[];
  /** Project directory tree (depth-limited) */
  projectStructure?: string;
  /** Results from dependency tasks (changedFiles + summary) */
  dependencyResults?: {
    taskId: string;
    summary: string;
    changedFiles: { path: string; diff: string }[];
  }[];
}

// ─── Sub-Agent Events ───

export interface SubAgentEvents {
  "subagent:phase": (taskId: string, phase: SubAgentPhase) => void;
  "subagent:iteration": (
    taskId: string,
    index: number,
    tokensUsed: number,
  ) => void;
  "subagent:complete": (result: SubAgentResult) => void;
}

// ─── SubAgent Class ───

/**
 * SubAgent — manages a single sub-agent's lifecycle from spawn to cleanup.
 *
 * Each SubAgent creates its own AgentLoop internally, scoped to a limited
 * set of target files and tools. It runs to completion and returns a
 * structured result.
 *
 * @example
 * ```typescript
 * const sub = new SubAgent({
 *   taskId: "T1",
 *   goal: "Add error handling to api.ts",
 *   targetFiles: ["src/api.ts"],
 *   readFiles: ["src/types.ts"],
 *   maxIterations: 15,
 *   projectPath: "/project",
 *   byokConfig: { provider: "anthropic", apiKey: "..." },
 *   tools: ["file_read", "file_write", "file_edit"],
 *   createToolExecutor: (dir, tools) => createExecutor(dir, tools),
 * });
 *
 * sub.on("subagent:phase", (id, phase) => console.log(id, phase));
 * const result = await sub.run(dagContext);
 * ```
 */
export class SubAgent extends EventEmitter {
  /** Task identifier for this sub-agent */
  readonly taskId: string;

  private phase: SubAgentPhase = "spawn";
  private aborted = false;
  private readonly config: SubAgentConfig;
  private agentLoop: AgentLoop | null = null;
  private iterationCount = 0;

  constructor(config: SubAgentConfig) {
    super();
    this.config = config;
    this.taskId = config.taskId;
  }

  /**
   * Build the sub-agent system prompt with scope constraints.
   *
   * The prompt follows the design doc section 3.7.2 pattern:
   * - Role definition with specific goal
   * - File scope (WRITE targets, READ-ONLY references)
   * - DAG context (overall mission, completed/running tasks)
   * - Iteration constraints and summary requirement
   *
   * @param dagContext Context about the overall DAG execution
   * @returns Fully constructed system prompt string
   */
  buildPrompt(dagContext: DAGContextLike): string {
    const sections: string[] = [];

    // 1. Role definition
    sections.push(
      `You are a YUAN Sub-Agent. Your role: ${this.config.goal}`,
    );

    // 2. File scope
    sections.push(`## Your Scope
- Target files (WRITE): ${this.config.targetFiles.length > 0 ? this.config.targetFiles.join(", ") : "(none)"}
- Reference files (READ-ONLY): ${this.config.readFiles.length > 0 ? this.config.readFiles.join(", ") : "(none)"}
- DO NOT modify files outside your target scope.
- If you need to read a file not listed above, you may use file_read, but NEVER write outside target files.`);

    // 3. Overall mission
    sections.push(`## Overall Mission
${dagContext.overallGoal}`);

    // 4. DAG context
    const completedSummaries =
      dagContext.completedTasks.length > 0
        ? dagContext.completedTasks
            .map((t) => `  - [${t.taskId}] ${t.summary}`)
            .join("\n")
        : "  (none yet)";

    const runningSiblings =
      dagContext.runningTasks.length > 0
        ? dagContext.runningTasks.join(", ")
        : "(none)";

    sections.push(`## DAG Context
- Total tasks: ${dagContext.totalTasks}
- Your task ID: ${this.config.taskId} (priority: ${this.config.priority ?? 5})
- Dependencies completed:
${completedSummaries}
- Parallel siblings: ${runningSiblings}`);

    // 5. Dependency results (if any)
    if (
      dagContext.dependencyResults &&
      dagContext.dependencyResults.length > 0
    ) {
      const depDetails = dagContext.dependencyResults
        .map((d) => {
          const files = d.changedFiles
            .map((f) => `    - ${f.path}`)
            .join("\n");
          return `  [${d.taskId}] ${d.summary}\n  Changed files:\n${files}`;
        })
        .join("\n\n");

      sections.push(`## Dependency Results
The following tasks completed before you. Their changes are already applied:

${depDetails}`);
    }

    // 6. Project structure (if available)
    if (dagContext.projectStructure) {
      sections.push(`## Project Structure
\`\`\`
${dagContext.projectStructure}
\`\`\``);
    }

    // 7. Constraints
    const maxIter = this.config.maxIterations;
    sections.push(`## Constraints
- Max iterations: ${maxIter}
- When done, provide a structured summary of ALL changes made.
- If you encounter an issue outside your scope, report it — don't fix it.
- Focus on completing your specific goal efficiently.`);

    return sections.join("\n\n").trim();
  }

  /**
   * Run the sub-agent to completion.
   *
   * Creates an AgentLoop internally, runs it with the task goal,
   * and collects results including changed files (via git diff).
   *
   * @param dagContext Context about the overall DAG execution
   * @returns Structured result with success status, summary, changed files, and token usage
   */
  async run(dagContext: DAGContextLike): Promise<SubAgentResult> {
    if (this.aborted) {
      return this.buildResult(false, "Aborted before start", [], 0, 0);
    }

    try {
      // Phase: INIT
      this.setPhase("init");

      // Build the scoped system prompt
      const systemPrompt = this.buildPrompt(dagContext);

      // Create a ToolExecutor scoped to the project path and enabled tools
      const toolExecutor = this.config.createToolExecutor(
        this.config.projectPath,
        this.config.tools,
      );

      // Create an AgentLoop with the sub-agent prompt
      const governorConfig: GovernorConfig = {
        planTier: "PRO",
        ...this.config.governorConfig,
      };

      this.agentLoop = new AgentLoop({
        config: {
          byok: this.config.byokConfig,
          loop: {
            model: "coding",
            maxIterations: this.config.maxIterations,
            maxTokensPerIteration: 16_384,
            totalTokenBudget: this.config.maxIterations * 16_384,
            tools: toolExecutor.definitions,
            systemPrompt,
            projectPath: this.config.projectPath,
          },
        },
        toolExecutor,
        governorConfig,
      });

      // Forward iteration events
      this.agentLoop.on("event", (event) => {
        if (event.kind === "agent:iteration") {
          this.iterationCount = event.index;
          this.emit(
            "subagent:iteration",
            this.taskId,
            event.index,
            event.tokensUsed,
          );
        }
      });

      // Phase: EXECUTE
      if (this.aborted) {
        return this.buildResult(false, "Aborted during init", [], 0, 0);
      }
      this.setPhase("execute");

      // Run the agent loop
      const termination = await this.agentLoop.run(this.config.goal);

      if (this.aborted) {
        return this.buildResult(false, "Aborted during execution", [], 0, 0);
      }

      // Phase: VALIDATE
      this.setPhase("validate");

      // Collect changed files via git diff
      const changedFiles = await this.collectChangedFiles();

      // Get token usage
      const tokenUsage = this.agentLoop.getTokenUsage();

      // Phase: REPORT
      this.setPhase("report");

      // Determine success and build summary
      const success = termination.reason === "GOAL_ACHIEVED";
      const summary = this.extractSummary(termination);

      const result = this.buildResult(
        success,
        summary,
        changedFiles,
        tokenUsage.input,
        tokenUsage.output,
        success ? undefined : `Terminated: ${termination.reason}`,
      );

      // Phase: CLEANUP
      this.setPhase("cleanup");

      this.emit("subagent:complete", result);
      return result;
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : String(err);

      this.setPhase("cleanup");

      const result = this.buildResult(
        false,
        `Sub-agent failed: ${errorMessage}`,
        [],
        0,
        0,
        errorMessage,
      );

      this.emit("subagent:complete", result);
      return result;
    }
  }

  /**
   * Abort the running sub-agent.
   * The current iteration will complete, but no further iterations will start.
   */
  abort(): void {
    this.aborted = true;
    if (this.agentLoop) {
      this.agentLoop.abort();
    }
  }

  /**
   * Get the current lifecycle phase.
   * @returns Current SubAgentPhase
   */
  getPhase(): SubAgentPhase {
    return this.phase;
  }

  // ─── Private Helpers ───

  private setPhase(phase: SubAgentPhase): void {
    this.phase = phase;
    this.emit("subagent:phase", this.taskId, phase);
  }

  /**
   * Collect changed files by running `git diff` in the project directory.
   * Returns an array of { path, diff } for each modified file.
   */
  private async collectChangedFiles(): Promise<
    { path: string; diff: string }[]
  > {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["diff", "--name-only"],
        { cwd: this.config.projectPath, timeout: 10_000 },
      );

      const files = stdout
        .trim()
        .split("\n")
        .filter((f) => f.length > 0);

      if (files.length === 0) return [];

      const results: { path: string; diff: string }[] = [];

      for (const filePath of files) {
        // Only include files in our target scope
        const isTargetFile = this.config.targetFiles.some(
          (t) => filePath === t || filePath.endsWith(`/${t}`) || t.endsWith(`/${filePath}`),
        );

        if (!isTargetFile) continue;

        try {
          const { stdout: diff } = await execFileAsync(
            "git",
            ["diff", "--", filePath],
            { cwd: this.config.projectPath, timeout: 10_000 },
          );
          results.push({ path: filePath, diff });
        } catch {
          // If git diff fails for a single file, skip it
          results.push({ path: filePath, diff: "(diff unavailable)" });
        }
      }

      return results;
    } catch {
      // git not available or not a git repo — return empty
      return [];
    }
  }

  /**
   * Extract a human-readable summary from the agent termination result.
   */
  private extractSummary(termination: AgentTermination): string {
    switch (termination.reason) {
      case "GOAL_ACHIEVED":
        return termination.summary;
      case "MAX_ITERATIONS":
        return `Reached iteration limit: ${termination.lastState}`;
      case "BUDGET_EXHAUSTED":
        return `Token budget exhausted (${termination.tokensUsed} tokens used)`;
      case "USER_CANCELLED":
        return "Cancelled by user or orchestrator";
      case "ERROR":
        return `Error: ${termination.error}`;
      case "NEEDS_APPROVAL":
        return `Blocked on approval: ${termination.action.description}`;
      default:
        return "Unknown termination";
    }
  }

  /**
   * Build a SubAgentResult from the collected data.
   */
  private buildResult(
    success: boolean,
    summary: string,
    changedFiles: { path: string; diff: string }[],
    inputTokens: number,
    outputTokens: number,
    error?: string,
  ): SubAgentResult {
    return {
      taskId: this.taskId,
      success,
      summary,
      changedFiles,
      tokensUsed: { input: inputTokens, output: outputTokens },
      iterations: this.iterationCount,
      phase: this.phase,
      error,
    };
  }
}
