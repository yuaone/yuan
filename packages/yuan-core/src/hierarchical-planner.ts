/**
 * @module hierarchical-planner
 * @description 3-Level Hierarchical Planner — Strategic / Tactical / Operational.
 *
 * 사용자의 고수준 목표를 3단계 계획으로 분해한다:
 * - L1 Strategic: 목표 → 서브골 분해 (Flagship 모델)
 * - L2 Tactical: 서브골 → 파일별 태스크 (Premium 모델)
 * - L3 Operational: 태스크 → 구체적 도구 호출 (Standard 모델)
 *
 * 기존 Planner(단일 레벨)와 호환되는 toExecutionPlan() 변환을 지원한다.
 *
 * @example
 * ```typescript
 * const planner = new HierarchicalPlanner({ projectPath: "/app" });
 * const plan = await planner.createHierarchicalPlan("Add auth to the API", llmClient);
 * const execPlan = planner.toExecutionPlan(plan);
 * ```
 */

import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionPlan, PlanStep, Message } from "./types.js";
import type { BYOKClient } from "./llm-client.js";

// ─── Public Types ───

/** Planning level identifier */
export type PlanLevel = "strategic" | "tactical" | "operational";

/** Risk assessment for a strategic goal */
export interface RiskAssessment {
  /** Overall risk level */
  level: "low" | "medium" | "high" | "critical";
  /** Risk factors identified */
  factors: string[];
  /** Recommended mitigations */
  mitigations: string[];
  /** Whether explicit user approval is required */
  requiresApproval: boolean;
}

/** L1: Strategic Goal — high-level decomposition of user intent */
export interface StrategicGoal {
  /** Unique identifier */
  id: string;
  /** Human-readable description of the goal */
  description: string;
  /** Tactical tasks derived from this goal */
  subGoals: TacticalTask[];
  /** Estimated complexity */
  estimatedComplexity: "trivial" | "simple" | "moderate" | "complex" | "massive";
  /** Required tool capabilities */
  requiredCapabilities: string[];
  /** Risk assessment */
  riskAssessment: RiskAssessment;
}

/** L2: Tactical Task — file-level implementation plan */
export interface TacticalTask {
  /** Unique identifier */
  id: string;
  /** Parent strategic goal ID */
  goalId: string;
  /** Human-readable description */
  description: string;
  /** Files to be modified */
  targetFiles: string[];
  /** Files to read for context */
  readFiles: string[];
  /** Tools to use */
  toolStrategy: string[];
  /** Execution order within the goal */
  order: number;
  /** IDs of tactical tasks this depends on */
  dependsOn: string[];
  /** Estimated agent loop iterations */
  estimatedIterations: number;
  /** Preferred model tier */
  modelPreference?: string;
}

/** L3: Operational Action — a single tool invocation */
export interface OperationalAction {
  /** Unique identifier */
  id: string;
  /** Parent tactical task ID */
  taskId: string;
  /** Action category */
  type: "read" | "analyze" | "write" | "edit" | "execute" | "test" | "verify";
  /** Human-readable description */
  description: string;
  /** Tool name to invoke */
  tool: string;
  /** Pre-planned tool arguments */
  toolInput: Record<string, unknown>;
  /** What we expect this action to produce */
  expectedOutcome: string;
  /** Fallback action if this one fails */
  fallbackAction?: OperationalAction;
}

/** Full hierarchical plan containing all three levels */
export interface HierarchicalPlan {
  /** Unique plan identifier */
  id: string;
  /** Original user goal */
  goal: string;
  /** Creation timestamp (epoch ms) */
  createdAt: number;
  /** L1: Strategic goal */
  strategic: StrategicGoal;
  /** L2: Tactical tasks */
  tactical: TacticalTask[];
  /** L3: Operational actions, keyed by tactical task ID */
  operational: Map<string, OperationalAction[]>;
  /** Total estimated agent loop iterations */
  totalEstimatedIterations: number;
  /** Groups of task IDs that can run in parallel */
  parallelizableGroups: string[][];
  /** Longest sequential dependency chain (task IDs) */
  criticalPath: string[];
  /** Estimated token budget */
  estimatedTokenBudget: number;
}

/** Trigger for re-planning mid-execution */
export interface RePlanTrigger {
  /** Category of the trigger */
  type: "error" | "new_info" | "dependency_change" | "user_feedback" | "context_overflow";
  /** Human-readable description */
  description: string;
  /** Task IDs affected by this trigger */
  affectedTaskIds: string[];
  /** How severe this trigger is */
  severity: "minor" | "major" | "critical";
}

/** Result of a re-planning operation */
export interface RePlanResult {
  /** Strategy chosen for recovery */
  strategy: "retry_with_fix" | "alternative_approach" | "skip_and_continue" | "escalate" | "full_replan";
  /** Modified or replacement tasks */
  modifiedTasks: TacticalTask[];
  /** Explanation of the re-plan decision */
  reason: string;
}

/** Configuration for the HierarchicalPlanner */
export interface HierarchicalPlannerConfig {
  /** Project root path */
  projectPath: string;
  /** Model tier for L1 strategic planning (default: "flagship") */
  strategicModel?: string;
  /** Model tier for L2 tactical planning (default: "premium") */
  tacticalModel?: string;
  /** Model tier for L3 operational planning (default: "standard") */
  operationalModel?: string;
  /** Maximum sub-goals per strategic goal (default: 10) */
  maxSubGoals?: number;
  /** Maximum tasks per sub-goal (default: 20) */
  maxTasksPerGoal?: number;
  /** Maximum actions per task (default: 50) */
  maxActionsPerTask?: number;
  /** Whether to pre-plan L3 actions or plan on-the-fly (default: false) */
  enableOperationalPrePlanning?: boolean;
}

// ─── Internal Defaults ───

const DEFAULTS = {
  strategicModel: "flagship",
  tacticalModel: "premium",
  operationalModel: "standard",
  maxSubGoals: 10,
  maxTasksPerGoal: 20,
  maxActionsPerTask: 50,
  enableOperationalPrePlanning: false,
} as const;

/** Tokens per iteration estimate for budget calculation */
const TOKENS_PER_ITERATION = 3_000;

/** High-risk file patterns that trigger elevated risk assessment */
const HIGH_RISK_PATTERNS = [
  /\.env/i,
  /secret/i,
  /credential/i,
  /auth/i,
  /password/i,
  /token/i,
  /config\.(ts|js|json)$/i,
  /package\.json$/,
  /tsconfig/i,
  /docker/i,
  /\.ya?ml$/i,
  /migration/i,
  /schema\.(prisma|sql)$/i,
];

/** Destructive operations that elevate risk */
const DESTRUCTIVE_OPS = [
  "file_write",
  "shell_exec",
  "git_ops",
];

// ─── HierarchicalPlanner ───

/**
 * HierarchicalPlanner — 3-level planning hierarchy for the YUAN coding agent.
 *
 * Decomposes a high-level user goal into:
 * 1. **Strategic** — what sub-goals to pursue, risk assessment, capability analysis
 * 2. **Tactical** — which files to touch, which tools to use, dependency ordering
 * 3. **Operational** — exact tool calls with pre-planned arguments
 *
 * Supports re-planning when execution encounters errors or new information.
 * Backward-compatible with the existing `ExecutionPlan` format via `toExecutionPlan()`.
 */
export class HierarchicalPlanner {
  private readonly config: Required<HierarchicalPlannerConfig>;
  private projectContext: string;

  constructor(config: HierarchicalPlannerConfig) {
    this.config = {
      projectPath: config.projectPath,
      strategicModel: config.strategicModel ?? DEFAULTS.strategicModel,
      tacticalModel: config.tacticalModel ?? DEFAULTS.tacticalModel,
      operationalModel: config.operationalModel ?? DEFAULTS.operationalModel,
      maxSubGoals: config.maxSubGoals ?? DEFAULTS.maxSubGoals,
      maxTasksPerGoal: config.maxTasksPerGoal ?? DEFAULTS.maxTasksPerGoal,
      maxActionsPerTask: config.maxActionsPerTask ?? DEFAULTS.maxActionsPerTask,
      enableOperationalPrePlanning:
        config.enableOperationalPrePlanning ?? DEFAULTS.enableOperationalPrePlanning,
    };
    this.projectContext = "";
  }

  // ─── Public API ───

  /**
   * L1: Strategic Planning — decompose a high-level goal into sub-goals.
   * Uses a flagship model for best reasoning quality.
   *
   * @param goal - The user's high-level goal
   * @param llmClient - BYOK LLM client for the strategic model
   * @param projectContext - Optional pre-gathered project context
   * @returns Strategic goal with sub-goals, complexity, and risk assessment
   */
  async planStrategic(
    goal: string,
    llmClient: BYOKClient,
    projectContext?: string,
  ): Promise<StrategicGoal> {
    const ctx = projectContext ?? await this.gatherProjectContext();
    this.projectContext = ctx;

    const prompt = this.buildStrategicPrompt(goal, ctx);
    const messages: Message[] = [
      { role: "system", content: prompt },
      { role: "user", content: goal },
    ];

    const response = await llmClient.chat(messages);
    const parsed = this.parseStrategicResponse(response.content ?? "", goal);

    // Enforce sub-goal limit
    if (parsed.subGoals.length > this.config.maxSubGoals) {
      parsed.subGoals = parsed.subGoals.slice(0, this.config.maxSubGoals);
    }

    // Enrich with risk assessment if not provided by LLM
    if (!parsed.riskAssessment || !parsed.riskAssessment.level) {
      const allFiles = parsed.subGoals.flatMap((sg) => sg.targetFiles);
      parsed.riskAssessment = this.assessRisk(goal, allFiles);
    }

    return parsed;
  }

  /**
   * L2: Tactical Planning — plan file-level tasks for each sub-goal.
   * Uses a premium model for good coding analysis.
   *
   * @param strategicGoal - The strategic goal to decompose
   * @param llmClient - BYOK LLM client for the tactical model
   * @param fileContext - Optional map of file path → content for context
   * @returns Array of tactical tasks with dependencies and ordering
   */
  async planTactical(
    strategicGoal: StrategicGoal,
    llmClient: BYOKClient,
    fileContext?: Map<string, string>,
  ): Promise<TacticalTask[]> {
    const allTasks: TacticalTask[] = [];

    for (const subGoal of strategicGoal.subGoals) {
      const prompt = this.buildTacticalPrompt(subGoal, fileContext);
      const messages: Message[] = [
        { role: "system", content: prompt },
        {
          role: "user",
          content: `Plan implementation for: ${subGoal.description}\nTarget files: ${subGoal.targetFiles.join(", ")}`,
        },
      ];

      const response = await llmClient.chat(messages);
      const tasks = this.parseTacticalResponse(
        response.content ?? "",
        strategicGoal.id,
        subGoal,
      );

      // Enforce task limit per goal
      const limited = tasks.slice(0, this.config.maxTasksPerGoal);
      allTasks.push(...limited);
    }

    // Assign global ordering based on dependencies
    return this.buildDependencyChain(allTasks);
  }

  /**
   * L3: Operational Planning — plan exact tool calls for a task.
   * Uses a standard model for cost efficiency on detailed step planning.
   *
   * @param task - The tactical task to detail
   * @param llmClient - BYOK LLM client for the operational model
   * @param currentState - Optional current execution state for context
   * @returns Array of operational actions with tool inputs
   */
  async planOperational(
    task: TacticalTask,
    llmClient: BYOKClient,
    currentState?: Record<string, unknown>,
  ): Promise<OperationalAction[]> {
    const prompt = this.buildOperationalPrompt(task, currentState);
    const messages: Message[] = [
      { role: "system", content: prompt },
      {
        role: "user",
        content: `Plan exact actions for: ${task.description}\nTools: ${task.toolStrategy.join(", ")}\nFiles: ${task.targetFiles.join(", ")}`,
      },
    ];

    const response = await llmClient.chat(messages);
    const actions = this.parseOperationalResponse(
      response.content ?? "",
      task.id,
    );

    // Enforce action limit
    return actions.slice(0, this.config.maxActionsPerTask);
  }

  /**
   * Create a full hierarchical plan from a user goal.
   * Runs L1 → L2 sequentially; L3 is conditional on config.
   *
   * @param goal - The user's high-level goal
   * @param llmClient - BYOK LLM client (used for all levels)
   * @returns Complete hierarchical plan
   */
  async createHierarchicalPlan(
    goal: string,
    llmClient: BYOKClient,
  ): Promise<HierarchicalPlan> {
    // L1: Strategic
    const strategic = await this.planStrategic(goal, llmClient);

    // L2: Tactical
    const tactical = await this.planTactical(strategic, llmClient);

    // L3: Operational (optional pre-planning)
    const operational = new Map<string, OperationalAction[]>();
    if (this.config.enableOperationalPrePlanning) {
      for (const task of tactical) {
        const actions = await this.planOperational(task, llmClient);
        operational.set(task.id, actions);
      }
    }

    // Compute metadata
    const parallelizableGroups = this.findParallelGroups(tactical);
    const criticalPath = this.findCriticalPath(tactical);
    const totalEstimatedIterations = tactical.reduce(
      (sum, t) => sum + t.estimatedIterations,
      0,
    );

    const plan: HierarchicalPlan = {
      id: randomUUID(),
      goal,
      createdAt: Date.now(),
      strategic,
      tactical,
      operational,
      totalEstimatedIterations,
      parallelizableGroups,
      criticalPath,
      estimatedTokenBudget: 0,
    };

    plan.estimatedTokenBudget = this.estimateTokenBudget(plan);

    return plan;
  }

  /**
   * Re-plan after encountering an error, new information, or other trigger.
   * Decides the best recovery strategy and returns modified tasks.
   *
   * @param currentPlan - The current hierarchical plan
   * @param trigger - What triggered the re-plan
   * @param llmClient - BYOK LLM client for re-planning
   * @returns Re-plan result with strategy and modified tasks
   */
  async replan(
    currentPlan: HierarchicalPlan,
    trigger: RePlanTrigger,
    llmClient: BYOKClient,
  ): Promise<RePlanResult> {
    const prompt = this.buildReplanPrompt(currentPlan, trigger);
    const messages: Message[] = [
      { role: "system", content: prompt },
      {
        role: "user",
        content: `Re-plan needed: ${trigger.description}\nType: ${trigger.type}\nSeverity: ${trigger.severity}\nAffected tasks: ${trigger.affectedTaskIds.join(", ")}`,
      },
    ];

    const response = await llmClient.chat(messages);
    return this.parseReplanResponse(
      response.content ?? "",
      currentPlan,
      trigger,
    );
  }

  /**
   * Convert a HierarchicalPlan to the existing ExecutionPlan format.
   * Provides backward compatibility with code that uses the single-level Planner.
   *
   * @param plan - Hierarchical plan to convert
   * @returns ExecutionPlan compatible with existing agent infrastructure
   */
  toExecutionPlan(plan: HierarchicalPlan): ExecutionPlan {
    const steps: PlanStep[] = plan.tactical.map((task) => ({
      id: task.id,
      goal: task.description,
      targetFiles: task.targetFiles,
      readFiles: task.readFiles,
      tools: task.toolStrategy,
      estimatedIterations: task.estimatedIterations,
      dependsOn: task.dependsOn,
    }));

    return {
      goal: plan.goal,
      steps,
      estimatedTokens: plan.estimatedTokenBudget,
    };
  }

  /**
   * Find groups of tasks that can execute in parallel.
   * Tasks with no mutual dependencies can run concurrently.
   *
   * @param tasks - Tactical tasks to analyze
   * @returns Array of groups, each group is an array of task IDs
   */
  findParallelGroups(tasks: TacticalTask[]): string[][] {
    if (tasks.length === 0) return [];

    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const completed = new Set<string>();
    const groups: string[][] = [];

    // Iterative topological grouping
    let remaining = tasks.length;
    const maxIterations = tasks.length + 1; // safety bound
    let iteration = 0;

    while (remaining > 0 && iteration < maxIterations) {
      iteration++;
      const group: string[] = [];

      for (const task of tasks) {
        if (completed.has(task.id)) continue;

        // Check if all dependencies are completed
        const depsReady = task.dependsOn.every(
          (dep) => completed.has(dep) || !taskMap.has(dep),
        );

        if (depsReady) {
          group.push(task.id);
        }
      }

      if (group.length === 0) {
        // Circular dependency detected — break remaining tasks into single group
        const stuck = tasks
          .filter((t) => !completed.has(t.id))
          .map((t) => t.id);
        groups.push(stuck);
        break;
      }

      groups.push(group);
      for (const id of group) {
        completed.add(id);
        remaining--;
      }
    }

    return groups;
  }

  /**
   * Find the critical path — the longest sequential dependency chain.
   * Uses DFS with memoization for path length calculation.
   *
   * @param tasks - Tactical tasks to analyze
   * @returns Array of task IDs forming the critical path
   */
  findCriticalPath(tasks: TacticalTask[]): string[] {
    if (tasks.length === 0) return [];

    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const memo = new Map<string, string[]>();

    /**
     * Recursively find the longest path starting from a task.
     */
    const longestFrom = (taskId: string, visited: Set<string>): string[] => {
      if (memo.has(taskId)) return memo.get(taskId)!;
      if (visited.has(taskId)) return [taskId]; // cycle — stop

      visited.add(taskId);

      const task = taskMap.get(taskId);
      if (!task) return [taskId];

      // Find dependents (tasks that depend on this one)
      const dependents = tasks.filter((t) => t.dependsOn.includes(taskId));

      if (dependents.length === 0) {
        const path = [taskId];
        memo.set(taskId, path);
        visited.delete(taskId);
        return path;
      }

      let longestChild: string[] = [];
      for (const dep of dependents) {
        const childPath = longestFrom(dep.id, visited);
        if (childPath.length > longestChild.length) {
          longestChild = childPath;
        }
      }

      const path = [taskId, ...longestChild];
      memo.set(taskId, path);
      visited.delete(taskId);
      return path;
    };

    // Find roots (tasks with no dependencies or only external deps)
    const roots = tasks.filter(
      (t) => t.dependsOn.length === 0 || t.dependsOn.every((d) => !taskMap.has(d)),
    );

    let criticalPath: string[] = [];
    for (const root of roots) {
      const path = longestFrom(root.id, new Set());
      if (path.length > criticalPath.length) {
        criticalPath = path;
      }
    }

    // If no roots found (all circular), just return all task IDs
    if (criticalPath.length === 0 && tasks.length > 0) {
      criticalPath = tasks.map((t) => t.id);
    }

    return criticalPath;
  }

  /**
   * Estimate the total token budget for a hierarchical plan.
   * Based on iteration count, planning overhead, and operational detail.
   *
   * @param plan - The hierarchical plan
   * @returns Estimated token budget
   */
  estimateTokenBudget(plan: HierarchicalPlan): number {
    // Base: iterations * tokens per iteration
    const iterationTokens = plan.totalEstimatedIterations * TOKENS_PER_ITERATION;

    // Planning overhead: ~2K tokens per tactical task for planning
    const planningOverhead = plan.tactical.length * 2_000;

    // Operational overhead: if pre-planned, count actions
    let operationalTokens = 0;
    if (plan.operational.size > 0) {
      for (const [, actions] of plan.operational) {
        operationalTokens += actions.length * 500;
      }
    }

    // Strategic overhead: one-time cost for L1 planning
    const strategicOverhead = 5_000;

    return iterationTokens + planningOverhead + operationalTokens + strategicOverhead;
  }

  // ─── Private: Project Context ───

  /**
   * Gather project context by reading package.json and directory listing.
   * @returns Concatenated project context string
   */
  private async gatherProjectContext(): Promise<string> {
    const parts: string[] = [];

    // package.json
    try {
      const pkgContent = await readFile(
        join(this.config.projectPath, "package.json"),
        "utf-8",
      );
      parts.push(`package.json:\n${pkgContent}`);
    } catch {
      // no package.json
    }

    // tsconfig.json
    try {
      const tsContent = await readFile(
        join(this.config.projectPath, "tsconfig.json"),
        "utf-8",
      );
      parts.push(`tsconfig.json:\n${tsContent}`);
    } catch {
      // no tsconfig
    }

    // Directory listing (shallow)
    try {
      const entries = await readdir(this.config.projectPath, {
        withFileTypes: true,
      });
      const filtered = entries
        .filter(
          (e) =>
            !e.name.startsWith(".") &&
            e.name !== "node_modules" &&
            e.name !== "dist",
        )
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      parts.push(`Project files:\n${filtered.join("\n")}`);
    } catch {
      // can't list
    }

    return parts.join("\n\n");
  }

  // ─── Private: Prompt Builders ───

  /**
   * Build the system prompt for L1 strategic planning.
   * Instructs the LLM to decompose the goal into sub-goals with JSON output.
   */
  private buildStrategicPrompt(goal: string, context: string): string {
    return `You are a senior software architect. Decompose the user's goal into strategic sub-goals.

## Project Context
${context}

## Goal
${goal}

## Instructions
- Break the goal into 1-${this.config.maxSubGoals} sub-goals
- Each sub-goal should be independently achievable
- Identify required capabilities (tools needed)
- Assess overall complexity and risk
- Consider file dependencies and ordering

## Output Format
Respond with ONLY a JSON object (no markdown fences):
{
  "description": "overall strategic description",
  "subGoals": [
    {
      "description": "what this sub-goal achieves",
      "targetFiles": ["files to modify"],
      "readFiles": ["files to read for context"],
      "toolStrategy": ["tool names"],
      "dependsOn": [],
      "estimatedIterations": 3,
      "modelPreference": "premium"
    }
  ],
  "complexity": "moderate",
  "requiredCapabilities": ["file_write", "shell_exec"],
  "riskAssessment": {
    "level": "low",
    "factors": [],
    "mitigations": [],
    "requiresApproval": false
  }
}

Available tools: file_read, file_write, file_edit, shell_exec, grep, glob, git_ops, test_run, security_scan

Complexity levels: trivial, simple, moderate, complex, massive
Risk levels: low, medium, high, critical`;
  }

  /**
   * Build the system prompt for L2 tactical planning.
   * Instructs the LLM to plan file-level tasks for a sub-goal.
   */
  private buildTacticalPrompt(
    subGoal: TacticalTask,
    fileContext?: Map<string, string>,
  ): string {
    let contextSection = "";
    if (fileContext && fileContext.size > 0) {
      const entries: string[] = [];
      for (const [path, content] of fileContext) {
        // Truncate large files
        const truncated =
          content.length > 2_000
            ? content.slice(0, 2_000) + "\n... (truncated)"
            : content;
        entries.push(`--- ${path} ---\n${truncated}`);
      }
      contextSection = `\n## File Context\n${entries.join("\n\n")}`;
    }

    return `You are a tech lead planning implementation tasks. For this sub-goal, plan specific file-level tasks.

## Sub-Goal
${subGoal.description}

## Target Files
${subGoal.targetFiles.join(", ") || "TBD"}
${contextSection}

## Instructions
- Plan concrete tasks that modify specific files
- Identify read-only dependencies (files to read but not modify)
- Choose the right tools for each task
- Estimate iterations conservatively (2-10 per file)
- Mark dependencies between tasks (by task ID)
- Suggest model preference: "flagship" for complex logic, "premium" for standard coding, "standard" for simple edits

## Output Format
Respond with ONLY a JSON object (no markdown fences):
{
  "tasks": [
    {
      "description": "what this task does",
      "targetFiles": ["src/foo.ts"],
      "readFiles": ["src/types.ts"],
      "toolStrategy": ["file_read", "file_edit"],
      "dependsOn": [],
      "estimatedIterations": 3,
      "modelPreference": "premium"
    }
  ]
}

Available tools: file_read, file_write, file_edit, shell_exec, grep, glob, git_ops, test_run, security_scan`;
  }

  /**
   * Build the system prompt for L3 operational planning.
   * Instructs the LLM to plan exact tool invocations for a task.
   */
  private buildOperationalPrompt(
    task: TacticalTask,
    currentState?: Record<string, unknown>,
  ): string {
    const stateSection = currentState
      ? `\n## Current State\n${JSON.stringify(currentState, null, 2)}`
      : "";

    return `You are a developer writing step-by-step tool actions. Plan exact tool calls for this task.

## Task
${task.description}

## Target Files
${task.targetFiles.join(", ")}

## Read Files
${task.readFiles.join(", ")}

## Available Tools
${task.toolStrategy.join(", ")}
${stateSection}

## Instructions
- Plan each action as a specific tool call with arguments
- Include expected outcomes for verification
- Add fallback actions for risky operations
- Keep actions atomic and verifiable
- Maximum ${this.config.maxActionsPerTask} actions

## Output Format
Respond with ONLY a JSON object (no markdown fences):
{
  "actions": [
    {
      "type": "read",
      "description": "Read current file contents",
      "tool": "file_read",
      "toolInput": { "path": "src/foo.ts" },
      "expectedOutcome": "File contents loaded for analysis"
    },
    {
      "type": "edit",
      "description": "Add import statement",
      "tool": "file_edit",
      "toolInput": { "path": "src/foo.ts", "old_string": "...", "new_string": "..." },
      "expectedOutcome": "Import added successfully",
      "fallbackAction": {
        "type": "write",
        "description": "Rewrite file if edit fails",
        "tool": "file_write",
        "toolInput": { "path": "src/foo.ts", "content": "..." },
        "expectedOutcome": "File rewritten"
      }
    }
  ]
}

Action types: read, analyze, write, edit, execute, test, verify`;
  }

  /**
   * Build the system prompt for re-planning after failure.
   */
  private buildReplanPrompt(
    plan: HierarchicalPlan,
    trigger: RePlanTrigger,
  ): string {
    const affectedTasks = plan.tactical
      .filter((t) => trigger.affectedTaskIds.includes(t.id))
      .map((t) => `  - ${t.id}: ${t.description}`)
      .join("\n");

    const completedTasks = plan.tactical
      .filter((t) => !trigger.affectedTaskIds.includes(t.id))
      .map((t) => `  - ${t.id}: ${t.description}`)
      .join("\n");

    return `You are an engineering manager deciding how to recover from a problem during task execution.

## Original Goal
${plan.goal}

## Problem
Type: ${trigger.type}
Severity: ${trigger.severity}
Description: ${trigger.description}

## Affected Tasks
${affectedTasks || "  (none)"}

## Completed Tasks
${completedTasks || "  (none)"}

## Instructions
Decide the best recovery strategy:
- "retry_with_fix": retry the failed task with modifications
- "alternative_approach": try a completely different approach
- "skip_and_continue": skip the failed task and continue with remaining
- "escalate": the problem requires user intervention
- "full_replan": discard remaining plan and create a new one

## Output Format
Respond with ONLY a JSON object (no markdown fences):
{
  "strategy": "retry_with_fix",
  "reason": "explanation of the decision",
  "modifiedTasks": [
    {
      "description": "modified task description",
      "targetFiles": ["..."],
      "readFiles": ["..."],
      "toolStrategy": ["..."],
      "dependsOn": [],
      "estimatedIterations": 3,
      "modelPreference": "premium"
    }
  ]
}`;
  }

  // ─── Private: Response Parsers ───

  /**
   * Parse LLM JSON response into a StrategicGoal.
   * Falls back to a minimal goal on parse failure.
   */
  private parseStrategicResponse(content: string, fallbackGoal: string): StrategicGoal {
    const goalId = `goal-${randomUUID().slice(0, 8)}`;
    const json = this.extractJson(content);

    if (json) {
      try {
        const parsed = JSON.parse(json) as Record<string, unknown>;

        const rawSubGoals = (parsed.subGoals ?? parsed.sub_goals ?? []) as Array<
          Record<string, unknown>
        >;

        const subGoals: TacticalTask[] = rawSubGoals.map((sg, i) => ({
          id: `task-${randomUUID().slice(0, 8)}`,
          goalId,
          description: (sg.description as string) ?? "",
          targetFiles: (sg.targetFiles as string[]) ?? [],
          readFiles: (sg.readFiles as string[]) ?? [],
          toolStrategy: (sg.toolStrategy as string[]) ?? ["file_read", "file_edit"],
          order: i,
          dependsOn: (sg.dependsOn as string[]) ?? [],
          estimatedIterations: (sg.estimatedIterations as number) ?? 5,
          modelPreference: sg.modelPreference as string | undefined,
        }));

        const rawRisk = (parsed.riskAssessment ?? {}) as Record<string, unknown>;

        return {
          id: goalId,
          description: (parsed.description as string) ?? fallbackGoal,
          subGoals,
          estimatedComplexity: this.normalizeComplexity(
            (parsed.complexity as string) ?? "moderate",
          ),
          requiredCapabilities: (parsed.requiredCapabilities as string[]) ?? [],
          riskAssessment: {
            level: this.normalizeRiskLevel((rawRisk.level as string) ?? "low"),
            factors: (rawRisk.factors as string[]) ?? [],
            mitigations: (rawRisk.mitigations as string[]) ?? [],
            requiresApproval: (rawRisk.requiresApproval as boolean) ?? false,
          },
        };
      } catch {
        // fall through to default
      }
    }

    // Default: single sub-goal wrapping the entire request
    return {
      id: goalId,
      description: fallbackGoal,
      subGoals: [
        {
          id: `task-${randomUUID().slice(0, 8)}`,
          goalId,
          description: fallbackGoal,
          targetFiles: [],
          readFiles: [],
          toolStrategy: ["file_read", "file_edit"],
          order: 0,
          dependsOn: [],
          estimatedIterations: 5,
        },
      ],
      estimatedComplexity: "moderate",
      requiredCapabilities: ["file_read", "file_edit"],
      riskAssessment: {
        level: "low",
        factors: [],
        mitigations: [],
        requiresApproval: false,
      },
    };
  }

  /**
   * Parse LLM JSON response into TacticalTask[].
   */
  private parseTacticalResponse(
    content: string,
    goalId: string,
    parentSubGoal: TacticalTask,
  ): TacticalTask[] {
    const json = this.extractJson(content);

    if (json) {
      try {
        const parsed = JSON.parse(json) as Record<string, unknown>;
        const rawTasks = (parsed.tasks ?? []) as Array<Record<string, unknown>>;

        return rawTasks.map((t, i) => ({
          id: `task-${randomUUID().slice(0, 8)}`,
          goalId,
          description: (t.description as string) ?? "",
          targetFiles: (t.targetFiles as string[]) ?? [],
          readFiles: (t.readFiles as string[]) ?? [],
          toolStrategy: (t.toolStrategy as string[]) ?? ["file_read", "file_edit"],
          order: i,
          dependsOn: (t.dependsOn as string[]) ?? [],
          estimatedIterations: (t.estimatedIterations as number) ?? 5,
          modelPreference: t.modelPreference as string | undefined,
        }));
      } catch {
        // fall through
      }
    }

    // Default: return the parent sub-goal as a single task
    return [
      {
        ...parentSubGoal,
        id: `task-${randomUUID().slice(0, 8)}`,
        goalId,
      },
    ];
  }

  /**
   * Parse LLM JSON response into OperationalAction[].
   */
  private parseOperationalResponse(
    content: string,
    taskId: string,
  ): OperationalAction[] {
    const json = this.extractJson(content);

    if (json) {
      try {
        const parsed = JSON.parse(json) as Record<string, unknown>;
        const rawActions = (parsed.actions ?? []) as Array<Record<string, unknown>>;

        return rawActions.map((a) => {
          const action: OperationalAction = {
            id: `action-${randomUUID().slice(0, 8)}`,
            taskId,
            type: this.normalizeActionType((a.type as string) ?? "read"),
            description: (a.description as string) ?? "",
            tool: (a.tool as string) ?? "file_read",
            toolInput: (a.toolInput as Record<string, unknown>) ?? {},
            expectedOutcome: (a.expectedOutcome as string) ?? "",
          };

          // Parse fallback action if present
          if (a.fallbackAction) {
            const fb = a.fallbackAction as Record<string, unknown>;
            action.fallbackAction = {
              id: `action-${randomUUID().slice(0, 8)}`,
              taskId,
              type: this.normalizeActionType((fb.type as string) ?? "write"),
              description: (fb.description as string) ?? "",
              tool: (fb.tool as string) ?? "file_write",
              toolInput: (fb.toolInput as Record<string, unknown>) ?? {},
              expectedOutcome: (fb.expectedOutcome as string) ?? "",
            };
          }

          return action;
        });
      } catch {
        // fall through
      }
    }

    // Default: single read action
    return [
      {
        id: `action-${randomUUID().slice(0, 8)}`,
        taskId,
        type: "read",
        description: "Read target files",
        tool: "file_read",
        toolInput: {},
        expectedOutcome: "Files loaded for analysis",
      },
    ];
  }

  /**
   * Parse re-plan LLM response into RePlanResult.
   */
  private parseReplanResponse(
    content: string,
    currentPlan: HierarchicalPlan,
    trigger: RePlanTrigger,
  ): RePlanResult {
    const json = this.extractJson(content);

    if (json) {
      try {
        const parsed = JSON.parse(json) as Record<string, unknown>;

        const rawTasks = (parsed.modifiedTasks ?? []) as Array<Record<string, unknown>>;
        const modifiedTasks: TacticalTask[] = rawTasks.map((t, i) => ({
          id: `task-${randomUUID().slice(0, 8)}`,
          goalId: currentPlan.strategic.id,
          description: (t.description as string) ?? "",
          targetFiles: (t.targetFiles as string[]) ?? [],
          readFiles: (t.readFiles as string[]) ?? [],
          toolStrategy: (t.toolStrategy as string[]) ?? ["file_read", "file_edit"],
          order: i,
          dependsOn: (t.dependsOn as string[]) ?? [],
          estimatedIterations: (t.estimatedIterations as number) ?? 5,
          modelPreference: t.modelPreference as string | undefined,
        }));

        return {
          strategy: this.normalizeReplanStrategy(
            (parsed.strategy as string) ?? "retry_with_fix",
          ),
          modifiedTasks,
          reason: (parsed.reason as string) ?? "Re-plan generated by LLM",
        };
      } catch {
        // fall through
      }
    }

    // Default: escalate on parse failure
    return {
      strategy: trigger.severity === "critical" ? "escalate" : "retry_with_fix",
      modifiedTasks: currentPlan.tactical.filter((t) =>
        trigger.affectedTaskIds.includes(t.id),
      ),
      reason: "Could not parse re-plan response; defaulting to safe strategy",
    };
  }

  // ─── Private: Risk Assessment ───

  /**
   * Assess risk based on the goal description and target files.
   */
  private assessRisk(goal: string, files: string[]): RiskAssessment {
    const factors: string[] = [];
    const mitigations: string[] = [];
    let riskScore = 0; // 0=low, 1=medium, 2=high, 3=critical

    // Check files against high-risk patterns
    for (const file of files) {
      for (const pattern of HIGH_RISK_PATTERNS) {
        if (pattern.test(file)) {
          factors.push(`Modifies sensitive file: ${file}`);
          riskScore = Math.max(riskScore, 1);
          break;
        }
      }
    }

    // Check goal for destructive keywords
    const destructiveKeywords = /\b(delete|remove|drop|reset|force|overwrite|wipe|migrate)\b/i;
    if (destructiveKeywords.test(goal)) {
      factors.push("Goal contains destructive operation keywords");
      riskScore = Math.min(riskScore + 1, 3);
      mitigations.push("Create backup before executing");
    }

    // Check for destructive tool usage
    const goalLower = goal.toLowerCase();
    if (DESTRUCTIVE_OPS.some((op) => goalLower.includes(op))) {
      factors.push("Requires write/execute operations");
      riskScore = Math.max(riskScore, 1);
      mitigations.push("Verify changes with tests after modification");
    }

    const riskLevels: RiskAssessment["level"][] = ["low", "medium", "high", "critical"];
    const maxRisk = riskLevels[Math.min(riskScore, 3)]!;

    // Determine approval requirement
    const requiresApproval = maxRisk === "high" || maxRisk === "critical";

    if (requiresApproval) {
      mitigations.push("Request user approval before executing");
    }

    return { level: maxRisk, factors, mitigations, requiresApproval };
  }

  // ─── Private: Dependency Analysis ───

  /**
   * Sort tasks by dependency order and assign sequential order values.
   * Uses Kahn's algorithm for topological sorting.
   */
  private buildDependencyChain(tasks: TacticalTask[]): TacticalTask[] {
    if (tasks.length === 0) return [];

    const taskMap = new Map(tasks.map((t) => [t.id, t]));

    // Compute in-degree for each task (only count internal deps)
    const inDegree = new Map<string, number>();
    for (const task of tasks) {
      if (!inDegree.has(task.id)) inDegree.set(task.id, 0);
      for (const dep of task.dependsOn) {
        if (taskMap.has(dep)) {
          inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
        }
      }
    }

    // Kahn's algorithm
    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }

    const sorted: TacticalTask[] = [];
    let order = 0;

    while (queue.length > 0) {
      const current = queue.shift()!;
      const task = taskMap.get(current);
      if (!task) continue;

      task.order = order++;
      sorted.push(task);

      // Reduce in-degree for dependents
      for (const other of tasks) {
        if (other.dependsOn.includes(current) && taskMap.has(other.id)) {
          const newDegree = (inDegree.get(other.id) ?? 1) - 1;
          inDegree.set(other.id, newDegree);
          if (newDegree === 0) {
            queue.push(other.id);
          }
        }
      }
    }

    // Append any remaining tasks (cycle members) at the end
    for (const task of tasks) {
      if (!sorted.includes(task)) {
        task.order = order++;
        sorted.push(task);
      }
    }

    return sorted;
  }

  // ─── Private: Helpers ───

  /**
   * Extract the first JSON object or array from a response string.
   * Handles common LLM output patterns (markdown fences, preamble text).
   */
  private extractJson(content: string): string | null {
    // Strip markdown code fences if present
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      return fenced[1]!.trim();
    }

    // Find first { ... } block
    const objectMatch = content.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      return objectMatch[0];
    }

    return null;
  }

  /** Normalize complexity string to valid union type */
  private normalizeComplexity(
    value: string,
  ): StrategicGoal["estimatedComplexity"] {
    const valid = new Set(["trivial", "simple", "moderate", "complex", "massive"]);
    return valid.has(value)
      ? (value as StrategicGoal["estimatedComplexity"])
      : "moderate";
  }

  /** Normalize risk level string to valid union type */
  private normalizeRiskLevel(value: string): RiskAssessment["level"] {
    const valid = new Set(["low", "medium", "high", "critical"]);
    return valid.has(value) ? (value as RiskAssessment["level"]) : "low";
  }

  /** Normalize action type string to valid union type */
  private normalizeActionType(value: string): OperationalAction["type"] {
    const valid = new Set([
      "read",
      "analyze",
      "write",
      "edit",
      "execute",
      "test",
      "verify",
    ]);
    return valid.has(value) ? (value as OperationalAction["type"]) : "read";
  }

  /** Normalize re-plan strategy string to valid union type */
  private normalizeReplanStrategy(value: string): RePlanResult["strategy"] {
    const valid = new Set([
      "retry_with_fix",
      "alternative_approach",
      "skip_and_continue",
      "escalate",
      "full_replan",
    ]);
    return valid.has(value) ? (value as RePlanResult["strategy"]) : "retry_with_fix";
  }
}
