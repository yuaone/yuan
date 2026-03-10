/**
 * @module tool-planner
 * @description Tool Planning Layer — Plans optimal tool sequences before execution.
 *
 * Adds explicit planning between reasoning and execution:
 * reasoning → plan → tool sequence → execute → verify
 *
 * Benefits:
 * - Fewer unnecessary tool calls
 * - Better first-attempt quality
 * - Adapts based on task type and repo memory
 */

import type { TaskType } from "./task-classifier.js";

// ─── Interfaces ───

/** Context provided when creating a plan */
export interface PlanContext {
  /** User's original message / goal */
  userMessage: string;
  /** Known file paths relevant to the task */
  knownFiles?: string[];
  /** Project language / framework info */
  language?: string;
  /** Whether the project has tests */
  hasTests?: boolean;
  /** Whether the project has lint configured */
  hasLint?: boolean;
  /** Whether the project uses TypeScript */
  usesTypeScript?: boolean;
  /** Extra context hints from TaskClassifier */
  contextHints?: string[];
}

/** Repo-specific profile used to adapt plans */
export interface RepoProfile {
  /** Whether tsc --noEmit should always be run */
  alwaysTypeCheck?: boolean;
  /** Whether lint should always be run after edits */
  alwaysLint?: boolean;
  /** Whether tests should always be run after changes */
  alwaysTest?: boolean;
  /** Custom verification command (e.g., "pnpm build") */
  verifyCommand?: string;
  /** File patterns to always read first (e.g., CLAUDE.md) */
  alwaysReadFiles?: string[];
  /** Known flaky tools to avoid */
  avoidTools?: string[];
}

/** A single step in a tool plan */
export interface ToolPlanStep {
  /** Tool name */
  tool: string;
  /** Why this tool is needed */
  purpose: string;
  /** Expected input pattern */
  expectedInput?: string;
  /** What to do if this step fails */
  fallback?: string;
  /** Dependencies on previous steps (step indices) */
  dependsOn?: number[];
  /** Can be skipped if previous step covers it */
  optional?: boolean;
}

/** A complete tool execution plan */
export interface ToolPlan {
  /** Planned tool sequence */
  steps: ToolPlanStep[];
  /** Estimated total tool calls */
  estimatedCalls: number;
  /** Reasoning for this plan */
  reasoning: string;
  /** Confidence in this plan (0–1) */
  confidence: number;
}

/** Report on how well execution followed the plan */
export interface PlanComplianceReport {
  /** Did execution follow the plan? */
  compliant: boolean;
  /** Steps that were executed as planned */
  executedSteps: number[];
  /** Steps that were skipped */
  skippedSteps: number[];
  /** Tools used that were not in the plan */
  unplannedTools: string[];
  /** Overall compliance ratio (0–1) */
  complianceRatio: number;
  /** Human-readable summary */
  summary: string;
}

// ─── Task Sequences ───

/** Pre-defined tool sequences by task type */
const TASK_SEQUENCES: Record<string, ToolPlanStep[]> = {
  debug: [
    { tool: "grep", purpose: "Find error source/pattern in codebase" },
    { tool: "file_read", purpose: "Read error source file + related files", dependsOn: [0] },
    { tool: "file_edit", purpose: "Apply fix based on analysis", dependsOn: [1] },
    { tool: "shell_exec", purpose: "Run tests to verify fix", dependsOn: [2] },
  ],
  feature: [
    { tool: "file_read", purpose: "Understand existing code context" },
    { tool: "glob", purpose: "Find related files and patterns", optional: true },
    { tool: "file_write", purpose: "Create new files if needed" },
    { tool: "file_edit", purpose: "Modify existing files", dependsOn: [0] },
    { tool: "shell_exec", purpose: "Build + test", dependsOn: [3] },
  ],
  refactor: [
    { tool: "grep", purpose: "Find all references to refactor target" },
    { tool: "file_read", purpose: "Read all affected files", dependsOn: [0] },
    { tool: "file_edit", purpose: "Apply refactoring changes", dependsOn: [1] },
    { tool: "shell_exec", purpose: "Type check (tsc --noEmit)", dependsOn: [2] },
    { tool: "shell_exec", purpose: "Run tests", dependsOn: [3] },
  ],
  test: [
    { tool: "file_read", purpose: "Read source file to test" },
    { tool: "glob", purpose: "Find existing test files/patterns" },
    { tool: "file_write", purpose: "Create test file", dependsOn: [0, 1] },
    { tool: "shell_exec", purpose: "Run new tests", dependsOn: [2] },
  ],
  security: [
    { tool: "grep", purpose: "Find vulnerability patterns in codebase" },
    { tool: "file_read", purpose: "Read potentially vulnerable code", dependsOn: [0] },
    { tool: "file_edit", purpose: "Apply security fix", dependsOn: [1] },
    { tool: "shell_exec", purpose: "Run security scan / tests", dependsOn: [2] },
    { tool: "grep", purpose: "Verify fix removed vulnerability pattern", dependsOn: [3] },
  ],
  explain: [
    { tool: "glob", purpose: "Discover project structure" },
    { tool: "file_read", purpose: "Read target files", dependsOn: [0] },
    { tool: "grep", purpose: "Trace dependencies and references", dependsOn: [1], optional: true },
  ],
  search: [
    { tool: "glob", purpose: "Find files matching pattern" },
    { tool: "grep", purpose: "Search file contents for pattern" },
    { tool: "file_read", purpose: "Read matched files for detail", dependsOn: [0, 1], optional: true },
  ],
  config: [
    { tool: "file_read", purpose: "Read current config file" },
    { tool: "file_edit", purpose: "Modify configuration", dependsOn: [0] },
    { tool: "shell_exec", purpose: "Validate config (build/lint)", dependsOn: [1] },
  ],
  deploy: [
    { tool: "shell_exec", purpose: "Check git status for uncommitted changes" },
    { tool: "shell_exec", purpose: "Run build to verify", dependsOn: [0] },
    { tool: "shell_exec", purpose: "Run tests", dependsOn: [1] },
    { tool: "shell_exec", purpose: "Execute deploy command", dependsOn: [2] },
  ],
  design: [
    { tool: "file_read", purpose: "Read existing design tokens / component styles" },
    { tool: "glob", purpose: "Find related UI components", optional: true },
    { tool: "file_edit", purpose: "Update design tokens or styles", dependsOn: [0] },
    { tool: "file_write", purpose: "Create new components if needed", dependsOn: [0] },
    { tool: "shell_exec", purpose: "Build to verify no regressions", dependsOn: [2, 3] },
  ],
  infra: [
    { tool: "file_read", purpose: "Read infrastructure config (docker, CI, etc.)" },
    { tool: "grep", purpose: "Find related infrastructure references", optional: true },
    { tool: "file_edit", purpose: "Modify infrastructure files", dependsOn: [0] },
    { tool: "file_write", purpose: "Create new infra files if needed", dependsOn: [0] },
    { tool: "shell_exec", purpose: "Validate config (dry-run, lint)", dependsOn: [2, 3] },
  ],
  performance: [
    { tool: "grep", purpose: "Find performance bottleneck patterns" },
    { tool: "file_read", purpose: "Read hot-path code", dependsOn: [0] },
    { tool: "file_edit", purpose: "Apply optimization", dependsOn: [1] },
    { tool: "shell_exec", purpose: "Run benchmarks / profile", dependsOn: [2] },
    { tool: "shell_exec", purpose: "Run tests to ensure no regression", dependsOn: [3] },
  ],
  migration: [
    { tool: "grep", purpose: "Find all references to old API/pattern" },
    { tool: "file_read", purpose: "Read affected files", dependsOn: [0] },
    { tool: "file_edit", purpose: "Apply migration changes", dependsOn: [1] },
    { tool: "shell_exec", purpose: "Type check across codebase", dependsOn: [2] },
    { tool: "shell_exec", purpose: "Run full test suite", dependsOn: [3] },
    { tool: "grep", purpose: "Verify no old pattern remains", dependsOn: [4] },
  ],
  documentation: [
    { tool: "file_read", purpose: "Read source code to document" },
    { tool: "glob", purpose: "Find existing documentation files", optional: true },
    { tool: "file_edit", purpose: "Update existing documentation", dependsOn: [0, 1] },
    { tool: "file_write", purpose: "Create new documentation files", dependsOn: [0], optional: true },
  ],
};

// ─── ToolPlanner ───

/**
 * ToolPlanner — Plans optimal tool sequences before execution.
 *
 * Uses pre-defined task sequences combined with repo-specific profiles
 * to produce an efficient, dependency-ordered plan.
 *
 * @example
 * ```typescript
 * const planner = new ToolPlanner();
 * const plan = planner.planForTask("debug", {
 *   userMessage: "Fix the type error in agent-loop.ts",
 *   usesTypeScript: true,
 * });
 * console.log(planner.formatPlanHint(plan));
 * ```
 */
export class ToolPlanner {
  /**
   * Create a tool plan based on task classification.
   *
   * @param taskType - Task type from TaskClassifier (e.g., "debug", "feature")
   * @param context - Optional planning context (user message, known files, etc.)
   * @returns A ToolPlan with ordered steps, estimated calls, and confidence
   */
  planForTask(taskType: string, context?: PlanContext): ToolPlan {
    const baseSteps = TASK_SEQUENCES[taskType];

    if (!baseSteps) {
      // Unknown task type — return a generic exploration plan
      return {
        steps: [
          { tool: "glob", purpose: "Discover project structure" },
          { tool: "file_read", purpose: "Read relevant files" },
          { tool: "grep", purpose: "Search for relevant patterns", optional: true },
        ],
        estimatedCalls: 3,
        reasoning: `Unknown task type "${taskType}" — using generic exploration plan.`,
        confidence: 0.3,
      };
    }

    // Deep-copy base steps so we don't mutate the template
    let steps: ToolPlanStep[] = baseSteps.map((s) => ({ ...s }));

    // Customize based on context
    if (context) {
      steps = this.customizeSteps(steps, taskType, context);
    }

    // Compute confidence based on context availability
    const confidence = this.computeConfidence(taskType, context);

    // Build reasoning
    const reasoning = this.buildReasoning(taskType, steps, context);

    return {
      steps,
      estimatedCalls: steps.filter((s) => !s.optional).length,
      reasoning,
      confidence,
    };
  }

  /**
   * Adapt plan based on repo-specific memory.
   * E.g., if repo always needs tsc check, add it.
   *
   * @param plan - The base plan to adapt
   * @param repoProfile - Repo-specific profile
   * @returns Adapted plan with extra steps as needed
   */
  adaptPlan(plan: ToolPlan, repoProfile?: RepoProfile): ToolPlan {
    if (!repoProfile) return plan;

    const steps = [...plan.steps.map((s) => ({ ...s }))];

    // Add always-read files as first step
    if (repoProfile.alwaysReadFiles && repoProfile.alwaysReadFiles.length > 0) {
      const hasInitialRead = steps.length > 0 && steps[0].tool === "file_read";
      if (!hasInitialRead) {
        steps.unshift({
          tool: "file_read",
          purpose: `Read required files: ${repoProfile.alwaysReadFiles.join(", ")}`,
          expectedInput: repoProfile.alwaysReadFiles.join(", "),
        });
        // Shift all dependsOn indices by 1
        for (let i = 1; i < steps.length; i++) {
          if (steps[i].dependsOn) {
            steps[i].dependsOn = steps[i].dependsOn!.map((d) => d + 1);
          }
        }
      }
    }

    // Add type check if always required and not present
    if (repoProfile.alwaysTypeCheck) {
      const hasTypeCheck = steps.some(
        (s) => s.tool === "shell_exec" && s.purpose.toLowerCase().includes("type check"),
      );
      if (!hasTypeCheck) {
        const lastEditIdx = this.findLastIndex(steps, (s) =>
          s.tool === "file_edit" || s.tool === "file_write",
        );
        if (lastEditIdx >= 0) {
          steps.splice(lastEditIdx + 1, 0, {
            tool: "shell_exec",
            purpose: "Type check (tsc --noEmit) — repo requires it",
            dependsOn: [lastEditIdx],
          });
        }
      }
    }

    // Add lint if always required and not present
    if (repoProfile.alwaysLint) {
      const hasLint = steps.some(
        (s) => s.tool === "shell_exec" && s.purpose.toLowerCase().includes("lint"),
      );
      if (!hasLint) {
        const lastStep = steps.length - 1;
        steps.push({
          tool: "shell_exec",
          purpose: "Run lint — repo requires it",
          dependsOn: [lastStep],
          optional: true,
        });
      }
    }

    // Add test if always required and not present
    if (repoProfile.alwaysTest) {
      const hasTest = steps.some(
        (s) => s.tool === "shell_exec" && s.purpose.toLowerCase().includes("test"),
      );
      if (!hasTest) {
        const lastStep = steps.length - 1;
        steps.push({
          tool: "shell_exec",
          purpose: "Run tests — repo requires it",
          dependsOn: [lastStep],
        });
      }
    }

    // Add custom verify command
    if (repoProfile.verifyCommand) {
      const hasVerify = steps.some(
        (s) => s.expectedInput === repoProfile.verifyCommand,
      );
      if (!hasVerify) {
        const lastStep = steps.length - 1;
        steps.push({
          tool: "shell_exec",
          purpose: `Run repo verify: ${repoProfile.verifyCommand}`,
          expectedInput: repoProfile.verifyCommand,
          dependsOn: [lastStep],
        });
      }
    }

    // Remove avoided tools
    if (repoProfile.avoidTools && repoProfile.avoidTools.length > 0) {
      const avoid = new Set(repoProfile.avoidTools);
      const filtered = steps.filter((s) => !avoid.has(s.tool));
      return {
        ...plan,
        steps: filtered,
        estimatedCalls: filtered.filter((s) => !s.optional).length,
        reasoning: plan.reasoning + ` (adapted for repo profile, avoided: ${repoProfile.avoidTools.join(", ")})`,
      };
    }

    return {
      ...plan,
      steps,
      estimatedCalls: steps.filter((s) => !s.optional).length,
      reasoning: plan.reasoning + " (adapted for repo profile)",
    };
  }

  /**
   * Format plan as system prompt hint for the LLM.
   *
   * @param plan - The tool plan to format
   * @returns Formatted string suitable for system prompt injection
   */
  formatPlanHint(plan: ToolPlan): string {
    const lines: string[] = [
      "<tool-plan>",
      `Confidence: ${(plan.confidence * 100).toFixed(0)}%`,
      `Estimated tool calls: ${plan.estimatedCalls}`,
      "",
      "Planned steps:",
    ];

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const prefix = step.optional ? "  (optional) " : "  ";
      const deps = step.dependsOn?.length
        ? ` [after step ${step.dependsOn.map((d) => d + 1).join(", ")}]`
        : "";
      lines.push(`${prefix}${i + 1}. ${step.tool} — ${step.purpose}${deps}`);
      if (step.fallback) {
        lines.push(`     Fallback: ${step.fallback}`);
      }
    }

    lines.push("");
    lines.push(`Reasoning: ${plan.reasoning}`);
    lines.push("</tool-plan>");

    return lines.join("\n");
  }

  /**
   * Validate execution against plan (did we follow the plan?).
   *
   * @param plan - The original plan
   * @param executedTools - List of tool names actually executed (in order)
   * @returns Compliance report
   */
  validateExecution(plan: ToolPlan, executedTools: string[]): PlanComplianceReport {
    const executedSteps: number[] = [];
    const skippedSteps: number[] = [];
    const unplannedTools: string[] = [];

    // Track which plan steps were matched
    const matched = new Set<number>();
    const plannedTools = plan.steps.map((s) => s.tool);

    // For each executed tool, try to match it to a plan step
    let planCursor = 0;
    for (const tool of executedTools) {
      let found = false;
      // Search forward from cursor for a matching plan step
      for (let i = planCursor; i < plan.steps.length; i++) {
        if (!matched.has(i) && plan.steps[i].tool === tool) {
          matched.add(i);
          executedSteps.push(i);
          planCursor = i + 1;
          found = true;
          break;
        }
      }
      // If not found forward, search from beginning (out-of-order execution)
      if (!found) {
        for (let i = 0; i < planCursor; i++) {
          if (!matched.has(i) && plan.steps[i].tool === tool) {
            matched.add(i);
            executedSteps.push(i);
            found = true;
            break;
          }
        }
      }
      if (!found) {
        // Tool not in plan
        if (!plannedTools.includes(tool)) {
          unplannedTools.push(tool);
        }
      }
    }

    // Steps not matched are skipped
    for (let i = 0; i < plan.steps.length; i++) {
      if (!matched.has(i)) {
        skippedSteps.push(i);
      }
    }

    // Calculate compliance
    const requiredSteps = plan.steps.filter((s) => !s.optional).length;
    const requiredExecuted = executedSteps.filter(
      (idx) => !plan.steps[idx].optional,
    ).length;
    const complianceRatio = requiredSteps > 0 ? requiredExecuted / requiredSteps : 1;

    const compliant = complianceRatio >= 0.7 && unplannedTools.length <= 2;

    // Build summary
    const summaryParts: string[] = [];
    summaryParts.push(`${executedSteps.length}/${plan.steps.length} steps executed`);
    if (skippedSteps.length > 0) {
      const skippedNames = skippedSteps.map((i) => plan.steps[i].tool);
      summaryParts.push(`skipped: ${skippedNames.join(", ")}`);
    }
    if (unplannedTools.length > 0) {
      summaryParts.push(`unplanned: ${unplannedTools.join(", ")}`);
    }

    return {
      compliant,
      executedSteps,
      skippedSteps,
      unplannedTools,
      complianceRatio,
      summary: summaryParts.join("; "),
    };
  }

  /**
   * Get all available task types that have predefined sequences.
   */
  getAvailableTaskTypes(): string[] {
    return Object.keys(TASK_SEQUENCES);
  }

  /**
   * Get the raw step template for a task type (or undefined).
   */
  getStepsForType(taskType: string): readonly ToolPlanStep[] | undefined {
    const steps = TASK_SEQUENCES[taskType];
    return steps ? steps.map((s) => ({ ...s })) : undefined;
  }

  // ─── Private ───

  /**
   * Customize steps based on context.
   */
  private customizeSteps(
    steps: ToolPlanStep[],
    taskType: string,
    context: PlanContext,
  ): ToolPlanStep[] {
    const result = [...steps];

    // If specific files are known, add expected input hints
    if (context.knownFiles && context.knownFiles.length > 0) {
      for (const step of result) {
        if (step.tool === "file_read" && !step.expectedInput) {
          step.expectedInput = context.knownFiles.join(", ");
        }
      }
    }

    // If project has no tests, make test steps optional
    if (context.hasTests === false) {
      for (const step of result) {
        if (
          step.tool === "shell_exec" &&
          step.purpose.toLowerCase().includes("test")
        ) {
          step.optional = true;
          step.fallback = "Skip tests — project has no test setup";
        }
      }
    }

    // If project uses TypeScript, add type check hint to shell_exec steps
    if (context.usesTypeScript) {
      const hasTypeCheck = result.some(
        (s) => s.tool === "shell_exec" && s.purpose.toLowerCase().includes("type check"),
      );
      if (!hasTypeCheck && (taskType === "feature" || taskType === "refactor" || taskType === "migration")) {
        const lastEditIdx = this.findLastIndex(result, (s) =>
          s.tool === "file_edit" || s.tool === "file_write",
        );
        if (lastEditIdx >= 0) {
          result.splice(lastEditIdx + 1, 0, {
            tool: "shell_exec",
            purpose: "Type check (tsc --noEmit)",
            dependsOn: [lastEditIdx],
          });
        }
      }
    }

    // Add fallback hints for key steps
    for (const step of result) {
      if (!step.fallback) {
        if (step.tool === "grep") {
          step.fallback = "Try glob or file_read with broader pattern";
        } else if (step.tool === "file_edit") {
          step.fallback = "If edit fails, try file_write to replace entire file";
        } else if (step.tool === "shell_exec") {
          step.fallback = "If command fails, check error output and retry with fix";
        }
      }
    }

    return result;
  }

  /**
   * Compute plan confidence based on task type and context completeness.
   */
  private computeConfidence(taskType: string, context?: PlanContext): number {
    let confidence = 0.6; // Base confidence for having a known task type

    if (!context) return confidence;

    // Boost for known files
    if (context.knownFiles && context.knownFiles.length > 0) {
      confidence += 0.1;
    }

    // Boost for known language/framework
    if (context.language) {
      confidence += 0.05;
    }

    // Boost for test/lint awareness
    if (context.hasTests !== undefined) {
      confidence += 0.05;
    }
    if (context.hasLint !== undefined) {
      confidence += 0.05;
    }

    // Boost for TypeScript projects (better tooling support)
    if (context.usesTypeScript) {
      confidence += 0.05;
    }

    // Context hints boost
    if (context.contextHints && context.contextHints.length > 0) {
      confidence += Math.min(context.contextHints.length * 0.03, 0.1);
    }

    // Task-specific confidence adjustments
    const highConfidenceTasks = ["debug", "test", "search", "config"];
    if (highConfidenceTasks.includes(taskType)) {
      confidence += 0.05;
    }

    return Math.min(confidence, 0.95);
  }

  /**
   * Build reasoning string for the plan.
   */
  private buildReasoning(
    taskType: string,
    steps: ToolPlanStep[],
    context?: PlanContext,
  ): string {
    const parts: string[] = [];

    parts.push(`Task type: ${taskType}`);
    parts.push(`${steps.length} steps planned (${steps.filter((s) => s.optional).length} optional)`);

    if (context?.knownFiles?.length) {
      parts.push(`targeting ${context.knownFiles.length} known file(s)`);
    }

    if (context?.usesTypeScript) {
      parts.push("TypeScript project — includes type checking");
    }

    if (context?.hasTests === false) {
      parts.push("no test setup detected — test steps optional");
    }

    return parts.join("; ") + ".";
  }

  /**
   * Find the last index in an array matching a predicate.
   */
  private findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (predicate(arr[i])) return i;
    }
    return -1;
  }
}
