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
import path from "node:path";
import type {
  BYOKConfig,
  ToolExecutor,
  PlannedTask,
  ModelTier,
  SubAgentContext,
  AgentTermination,
} from "./types.js";
import { AgentLoop } from "./agent-loop.js";
import type { GovernorConfig } from "./governor.js";
import {
  buildSubAgentPrompt,
  type SubAgentRole,
  type SubAgentPromptConfig,
} from "./sub-agent-prompts.js";
import {
  routeSubAgent,
  estimateComplexity,
  type TaskSignals,
  type SubAgentTier,
  type RoutingDecision,
} from "./sub-agent-router.js";
import { getCodingStandards, getGeneralStandards } from "./coding-standards.js";
import type {
  ParsedSkill,
  SkillContext,
} from "./plugin-types.js";
import {
detectProjectEnvironment,
} from "./language-detector.js";
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
  totalTokenBudget?: number;
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
  /** Sub-agent role for prompt specialization (default: "coder") */
  role?: SubAgentRole;
  /** Primary language of the target files (e.g. "typescript") */
  language?: string;
  /** Framework in use (e.g. "react", "next.js") */
  framework?: string;
 /** Test framework in use (e.g. "vitest", "pytest") */
  testFramework?: string;
  /** Package manager in use (e.g. "pnpm", "npm", "cargo") */
  packageManager?: string;
  /** Whether the project is a monorepo */
  isMonorepo?: boolean;
  /** Monorepo/workspace tool if detected */
  workspaceTool?: string;
  /** Whether this task is on a critical path (security, auth, payments) */
  isCriticalPath?: boolean;
  /** Number of previous failures for this task (for routing escalation) */
  previousFailures?: number;
  /** Parent agent's model tier (for cost containment) */
  parentModelTier?: SubAgentTier;
}

/** Verification report generated after sub-agent task execution */
export interface VerificationReport {
  /** Sub-agent identifier */
  subAgentId: string;
  /** Task identifier */
  taskId: string;
  /** Confidence score (0–1) reflecting how well the task was completed */
  confidence: number;
  /** Whether the task passed verification */
  passed: boolean;
  /** List of issues found during verification */
  issues: string[];
  /** Causal chain: symptom -> hypothesis -> evidence -> conclusion */
  causalChain?: string[];
  /** Number of tool calls that succeeded */
  testsPassed?: number;
  /** Total number of tool calls attempted */
  testsTotal?: number;
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
  /** Verification report for main agent validation */
  verification?: VerificationReport;
  /** Model routing decision (which tier was selected and why) */
  routingDecision?: RoutingDecision;
}

/** DAG context passed to a sub-agent so it understands its place in the plan */
export interface DAGContextLike {
  /** The overall user goal for the entire DAG */
  overallGoal: string;
  remainingBudget?: number

  // SubAgent context
  taskGoal?: string
  targetFiles?: string[]
  readFiles?: string[]
  /** skill matching context */
  skillContext?: SkillContext
  /** resolved skills injected for this task */
  resolvedSkills?: ParsedSkill[]
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

function mapTierToModel(tier: "FAST" | "NORMAL" | "DEEP") {
  switch (tier) {
    case "FAST":
      return "fast";
    case "DEEP":
     return "coding";
    default:
     return "standard";
  }
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
  get role(): SubAgentRole {
    return this.config.role ?? "coder";
  }
  private phase: SubAgentPhase = "spawn";
  private aborted = false;
  private readonly config: SubAgentConfig;
  private agentLoop: AgentLoop | null = null;
  private iterationCount = 0;
  private routingResult: RoutingDecision | null = null;

  constructor(config: SubAgentConfig) {
    super();
    // auto-detect language if not provided
    const detected = detectProjectEnvironment(
      config.projectPath,
      config.targetFiles,
    );

    this.config = {
      ...config,
      language: config.language ?? detected.language,
      framework: config.framework ?? detected.framework,
      testFramework: config.testFramework ?? detected.testFramework,
      packageManager: config.packageManager ?? detected.packageManager,
      isMonorepo: config.isMonorepo ?? detected.isMonorepo,
      workspaceTool: config.workspaceTool ?? detected.workspaceTool,
    };
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

    // 1. Role-specific prompt (from sub-agent-prompts module)
    const role = this.config.role ?? "coder";
    const rolePrompt = buildSubAgentPrompt({
      role,
      language: this.config.language,
      framework: this.config.framework,
   testFramework: this.config.testFramework,
      packageManager: this.config.packageManager,
      isMonorepo: this.config.isMonorepo,
      workspaceTool: this.config.workspaceTool,
      projectContext: dagContext.overallGoal,
    });
    sections.push(rolePrompt);

    // ─────────────────────────────────────────
    // Language Coding Standards Injection
    // ─────────────────────────────────────────

    const language = this.config.language;

    if (language) {
      const standards = getCodingStandards(language);

      if (standards) {
        sections.push(`## Coding Standards (${language})
Follow these language-specific best practices when writing code:

${standards}`);
      } else {
        sections.push(`## Coding Standards
${getGeneralStandards()}`);
      }
    }

   const envLines: string[] = [];
    if (this.config.framework) {
      envLines.push(`- Framework: ${this.config.framework}`);
    }
    if (this.config.testFramework) {
      envLines.push(`- Test framework: ${this.config.testFramework}`);
    }
    if (this.config.packageManager) {
      envLines.push(`- Package manager: ${this.config.packageManager}`);
    }
    if (this.config.isMonorepo) {
      envLines.push(
        `- Monorepo: yes${this.config.workspaceTool ? ` (${this.config.workspaceTool})` : ""}`,
      );
    } else {
      envLines.push(`- Monorepo: no`);
    }

    if (envLines.length > 0) {
      sections.push(`## Detected Repository Facts
${envLines.join("\n")}`);
    }
    // 2. Task-specific goal
    sections.push(
      `## Your Task\n${this.config.goal}`,
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

    // 3.5 Skill injection
    if (dagContext.resolvedSkills && dagContext.resolvedSkills.length > 0) {
      const renderedSkills = dagContext.resolvedSkills
        .map((skill, idx) => {
          const toolSequence =
            skill.toolSequence && skill.toolSequence.length > 0
              ? `\nTool sequence: ${skill.toolSequence.join(" -> ")}`
              : "";

          const checklist =
            skill.validationChecklist && skill.validationChecklist.length > 0
              ? `\nValidation:\n${skill.validationChecklist
                  .map((item) => `- ${item}`)
                  .join("\n")}`
              : "";

          return `### Skill ${idx + 1}: ${skill.definition.name}
${skill.content}${toolSequence}${checklist}`;
        })
        .join("\n\n");

      sections.push(`## Activated Skills
The following skills were matched for this task. Reuse them when relevant, but do not follow them blindly if the live codebase contradicts them.

${renderedSkills}`);
    }

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

      // Route to optimal model tier based on task signals
      const role = this.config.role ?? "coder";
      const complexity = estimateComplexity(
        this.config.targetFiles.length,
        this.config.goal.length,
        this.config.tools.includes("test_run"),
      );
      const taskSignals: TaskSignals = {
        role,
        complexity,
        fileCount: this.config.targetFiles.length,
        hasTests: this.config.tools.includes("test_run"),
        isCriticalPath: this.config.isCriticalPath ?? false,
        previousFailures: this.config.previousFailures ?? 0,
        parentModelTier: this.config.parentModelTier ?? "NORMAL",
      };
      this.routingResult = routeSubAgent(taskSignals);

      // Build the scoped system prompt (role-specialized)
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
const model = mapTierToModel(this.routingResult?.tier ?? "NORMAL");
 const loopBudget =
   dagContext.remainingBudget
     ? Math.min(
         dagContext.remainingBudget,
         this.config.maxIterations * 16384
       )
     : this.config.maxIterations * 16384;
      this.agentLoop = new AgentLoop({
        config: {
          byok: this.config.byokConfig,
          loop: {
            model,
            maxIterations: this.config.maxIterations,
            maxTokensPerIteration: 16_384,
            totalTokenBudget:
              this.config.totalTokenBudget ?? loopBudget,
            tools: toolExecutor.definitions,
            systemPrompt,
            projectPath: this.config.projectPath,
          },
        },
        toolExecutor,
        governorConfig,
      });
      // ─────────────────────────────────────────
      // Bridge AgentLoop events → SubAgent events
      // (so ExecutionEngine / CLI can observe them)
      // ─────────────────────────────────────────

      // Track emitted event IDs to prevent duplicate re-emission.
      // The parent loop already handles its own events; sub-agent should
      // only forward events originating from its own AgentLoop instance.
      const emittedEventIds = new Set<string>();

      this.agentLoop.on("event", (event) => {
        // Deduplicate by kind + tool_call_id (or kind + content hash for text events)
        const dedupeKey =
          (event as { tool_call_id?: string }).tool_call_id
            ? `${event.kind}:${(event as { tool_call_id?: string }).tool_call_id}`
            : (event as { tool?: string }).tool
              ? `${event.kind}:${(event as { tool?: string }).tool}:${Date.now()}`
              : null; // non-deduplicable events pass through
        if (dedupeKey) {
          if (emittedEventIds.has(dedupeKey)) return; // skip duplicate
          emittedEventIds.add(dedupeKey);
          // Cap set size to prevent unbounded growth
          if (emittedEventIds.size > 500) {
            const first = emittedEventIds.values().next().value;
            if (first) emittedEventIds.delete(first);
          }
        }

        switch (event.kind) {
          case "agent:text_delta":
          case "agent:thinking":
          case "agent:tool_call":
          case "agent:tool_result":
          case "agent:token_usage":
          case "agent:error":
          case "agent:completed":
            this.emit("event", event);
            break;

          case "agent:reasoning_delta":
            this.emit("event", {
              kind: "agent:reasoning_timeline",
              source: "subagent",
              taskId: this.taskId,
              role: this.role,
              text: String(event.text ?? ""),
            });
            break;

          case "agent:iteration":
            this.iterationCount = event.index + 1;
            this.emit(
              "subagent:iteration",
              this.taskId,
              event.index,
              event.tokensUsed,
            );
            break;
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

      // Generate VerificationReport for main agent validation
      const verification = this.generateVerificationReport(
        success,
        termination,
        changedFiles,
      );

      const result = this.buildResult(
        success,
        summary,
        changedFiles,
        tokenUsage.input,
        tokenUsage.output,
        success ? undefined : `Terminated: ${termination.reason}`,
        verification,
      );

      // Phase: CLEANUP
      this.setPhase("cleanup");
 if (this.agentLoop) {
   this.agentLoop.removeAllListeners("event");
   this.agentLoop = null;
 }
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
        ["diff", "--name-only", "HEAD"],
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
const isTargetFile = this.config.targetFiles.some((t) => {
  const normalizedTarget = path.normalize(t);
  const normalizedFile = path.normalize(filePath);
 return normalizedFile.endsWith(normalizedTarget);
});

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
    verification?: VerificationReport,
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
      verification,
      routingDecision: this.routingResult ?? undefined,
    };
  }

  /**
   * Generate a VerificationReport based on the sub-agent's execution results.
   *
   * Assesses confidence based on:
   * - Whether the termination was GOAL_ACHIEVED
   * - Number of changed files vs target files
   * - Iteration efficiency (fewer iterations = higher confidence)
   * - Presence of errors during execution
   */
  private generateVerificationReport(
    success: boolean,
    termination: AgentTermination,
    changedFiles: { path: string; diff: string }[],
  ): VerificationReport {
    const issues: string[] = [];
    const causalChain: string[] = [];

    // Assess confidence based on multiple signals
    let confidence = success ? 0.8 : 0.2;

    // Check file coverage — did we touch the expected target files?
    const targetCount = this.config.targetFiles.length;
    const changedCount = changedFiles.length;
    if (targetCount > 0 && changedCount === 0) {
      issues.push("No target files were modified");
      causalChain.push("symptom: zero changed files");
      causalChain.push("hypothesis: task may not have produced expected output");
      confidence *= 0.5;
    } else if (targetCount > 0) {
      const coverage = changedCount / targetCount;
      if (coverage < 0.5) {
        issues.push(`Only ${changedCount}/${targetCount} target files modified`);
        confidence *= 0.7;
      }
    }

    // Iteration efficiency — more iterations spent means less confidence
    const maxIter = this.config.maxIterations;
    if (maxIter > 0) {
      const iterRatio = this.iterationCount / maxIter;
      if (iterRatio >= 1.0) {
        issues.push("Reached maximum iteration limit");
        causalChain.push("evidence: all iterations consumed without early completion");
        confidence = Math.min(confidence, confidence * 0.6);
      } else if (iterRatio > 0.8) {
        issues.push("Used >80% of iteration budget");
        confidence = Math.min(confidence, confidence * 0.8);
      }
    }

    // Termination reason analysis
    if (termination.reason === "ERROR") {
      issues.push(`Terminated with error: ${(termination as { error?: string }).error ?? "unknown"}`);
      causalChain.push(`conclusion: execution failed — ${(termination as { error?: string }).error}`);
      confidence = Math.min(confidence, 0.1);
    } else if (termination.reason === "BUDGET_EXHAUSTED") {
      issues.push("Token budget exhausted before completion");
      confidence = Math.min(confidence, 0.3);
    } else if (termination.reason === "USER_CANCELLED") {
      issues.push("Execution was cancelled");
      confidence = Math.min(confidence, 0.15);
    }

    // Clamp confidence to [0, 1]
    confidence = Math.max(0, Math.min(1, confidence));

    // Count tool successes (approximate tests via iteration progress)
    const testsPassed = success ? this.iterationCount : Math.max(0, this.iterationCount - 1);
    const testsTotal = this.iterationCount;

    return {
      subAgentId: `subagent-${this.taskId}`,
      taskId: this.taskId,
      confidence,
      passed: success && confidence >= 0.5,
      issues,
      causalChain: causalChain.length > 0 ? causalChain : undefined,
      testsPassed,
      testsTotal,
    };
  }
}
