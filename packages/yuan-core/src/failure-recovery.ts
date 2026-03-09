/**
 * @module failure-recovery
 * @description Intelligent error recovery on top of AutoFixLoop.
 *
 * While AutoFixLoop handles simple retry loops (validate → fix prompt → retry),
 * FailureRecovery classifies root causes and selects from 5 recovery strategies:
 *   1. retry          — same approach, try again
 *   2. rollback       — undo changes, restore originals
 *   3. approach_change — different implementation approach
 *   4. scope_reduce   — simplify the task
 *   5. escalate       — ask user for help
 *
 * Flow:
 *   error → analyzeRootCause → selectStrategy → buildRecoveryPrompt
 *         → (optionally) executeRollback / buildScopeReduction
 *
 * @see auto-fix.ts for the underlying AutoFixLoop
 * @see 설계 문서 Section 6.4
 */

import { rename, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

// ─── Error Classification ───

/** Extended error categories beyond AutoFixLoop's basic triggers. */
export type ErrorCategory =
  | "BUILD_FAIL"
  | "TEST_FAIL"
  | "LINT_ERROR"
  | "RUNTIME_ERROR"
  | "TYPE_ERROR"
  | "IMPORT_ERROR"
  | "PERMISSION_ERROR"
  | "TIMEOUT"
  | "RESOURCE_ERROR"
  | "UNKNOWN";

// ─── Recovery Strategies ───

/** Available recovery strategies, ordered from least to most disruptive. */
export type RecoveryStrategy =
  | "retry"
  | "rollback"
  | "approach_change"
  | "scope_reduce"
  | "escalate";

// ─── Interfaces ───

/** Root cause analysis result. */
export interface RootCause {
  /** Error classification */
  category: ErrorCategory;
  /** Human-readable error summary */
  message: string;
  /** File where the error originated */
  file?: string;
  /** Line number of the error */
  line?: number;
  /** Suggested fix or next step */
  suggestion?: string;
  /** Confidence in the classification (0–1) */
  confidence: number;
}

/** Decision on which recovery strategy to use. */
export interface RecoveryDecision {
  /** Selected strategy */
  strategy: RecoveryStrategy;
  /** Why this strategy was chosen */
  reason: string;
  /** Additional context for the strategy */
  context: Record<string, unknown>;
  /** LLM prompt for the chosen strategy */
  prompt?: string;
}

/** Full context about a failure, used by strategy selection. */
export interface FailureContext {
  /** Raw error string */
  error: string;
  /** Tool that produced the error */
  toolName?: string;
  /** Raw tool output */
  toolOutput?: string;
  /** Current attempt number (1-based) */
  attemptNumber: number;
  /** Maximum attempts allowed */
  maxAttempts: number;
  /** Files that were changed during this task */
  changedFiles: string[];
  /** Original file contents before changes (file path → content) */
  originalSnapshots: Map<string, string>;
  /** Strategies already tried for this failure */
  previousStrategies: RecoveryStrategy[];
}

/** Configuration for the FailureRecovery system. */
export interface FailureRecoveryConfig {
  /** Maximum number of strategy switches before escalating (default 3) */
  maxStrategySwitches: number;
  /** Whether rollback is allowed (default true) */
  enableRollback: boolean;
  /** Whether scope reduction is allowed (default true) */
  enableScopeReduce: boolean;
  /** Escalate after this many failed strategies (default 2) */
  escalateThreshold: number;
}

/** Record of a strategy attempt and its outcome. */
interface StrategyRecord {
  strategy: RecoveryStrategy;
  success: boolean;
  timestamp: number;
}

// ─── Constants ───

const DEFAULT_CONFIG: FailureRecoveryConfig = {
  maxStrategySwitches: 3,
  enableRollback: true,
  enableScopeReduce: true,
  escalateThreshold: 2,
};

/**
 * Patterns used to classify errors into categories.
 * Order matters: more specific patterns are checked first.
 */
const ERROR_PATTERNS: ReadonlyArray<{
  category: ErrorCategory;
  patterns: RegExp[];
  suggestion: string;
}> = [
  {
    category: "PERMISSION_ERROR",
    patterns: [
      /EACCES/i,
      /EPERM/i,
      /permission denied/i,
      /sandbox/i,
    ],
    suggestion: "Check file permissions or sandbox configuration.",
  },
  {
    category: "RESOURCE_ERROR",
    patterns: [
      /ENOMEM/i,
      /ENOSPC/i,
      /heap out of memory/i,
      /out of memory/i,
    ],
    suggestion: "Free resources or reduce scope of operation.",
  },
  {
    category: "TIMEOUT",
    patterns: [
      /ETIMEDOUT/i,
      /\btimeout\b/i,
      /timed out/i,
    ],
    suggestion: "Increase timeout or reduce operation scope.",
  },
  {
    category: "IMPORT_ERROR",
    patterns: [
      /Cannot find module/i,
      /Module not found/i,
      /ERR_MODULE_NOT_FOUND/i,
    ],
    suggestion: "Check import paths and ensure the module is installed.",
  },
  {
    category: "TYPE_ERROR",
    patterns: [
      /Type .+ is not assignable/i,
      /Property .+ does not exist/i,
      /error TS\d+/i,
    ],
    suggestion: "Fix type annotations or add missing type definitions.",
  },
  {
    category: "LINT_ERROR",
    patterns: [
      /eslint/i,
      /prettier/i,
      /\blint\b/i,
      /\bwarning:/i,
    ],
    suggestion: "Fix lint/style issues per project config.",
  },
  {
    category: "TEST_FAIL",
    patterns: [
      /\bFAIL\b/,
      /AssertionError/i,
      /AssertionError/i,
      /Expected .+ received/i,
      /test failed/i,
    ],
    suggestion: "Fix test assertions or update expected values.",
  },
  {
    category: "BUILD_FAIL",
    patterns: [
      /Unexpected token/i,
      /SyntaxError/i,
      /build failed/i,
      /compilation failed/i,
    ],
    suggestion: "Fix syntax or build configuration errors.",
  },
  {
    category: "RUNTIME_ERROR",
    patterns: [
      /\bError:/,
      /TypeError:/,
      /ReferenceError:/,
      /RangeError:/,
    ],
    suggestion: "Debug the runtime error and fix the underlying logic.",
  },
];

// ─── FailureRecovery ───

/**
 * FailureRecovery — Intelligent error recovery with root cause analysis
 * and multi-strategy recovery selection.
 *
 * Sits on top of AutoFixLoop to provide higher-level recovery when
 * simple retries are insufficient.
 *
 * @example
 * ```typescript
 * const recovery = new FailureRecovery({ maxStrategySwitches: 3 });
 *
 * // Analyze the error
 * const rootCause = recovery.analyzeRootCause(errorOutput, 'shell_exec');
 *
 * // Select a strategy
 * const decision = recovery.selectStrategy(rootCause, failureContext);
 *
 * // Get the recovery prompt for LLM
 * const prompt = recovery.buildRecoveryPrompt(decision, failureContext);
 *
 * // If rollback was selected
 * if (decision.strategy === 'rollback') {
 *   await recovery.executeRollback(changedFiles, originalSnapshots);
 * }
 *
 * // Record outcome
 * recovery.recordStrategyResult(decision.strategy, wasSuccessful);
 * ```
 */
export class FailureRecovery {
  private readonly config: FailureRecoveryConfig;
  private readonly history: StrategyRecord[] = [];

  constructor(config?: Partial<FailureRecoveryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Root Cause Analysis ───

  /**
   * Analyze an error string and classify its root cause.
   *
   * Checks against known error patterns in priority order and extracts
   * file/line information when available.
   *
   * @param error Raw error string
   * @param toolName Optional tool that produced the error
   * @returns Root cause analysis with category, confidence, and suggestion
   */
  analyzeRootCause(error: string, toolName?: string): RootCause {
    // Try each pattern group in priority order
    for (const group of ERROR_PATTERNS) {
      for (const pattern of group.patterns) {
        if (pattern.test(error)) {
          const { file, line } = this.extractFileLocation(error);
          const confidence = this.computeConfidence(error, group.category, toolName);

          return {
            category: group.category,
            message: this.extractErrorMessage(error),
            file,
            line,
            suggestion: group.suggestion,
            confidence,
          };
        }
      }
    }

    // No pattern matched
    return {
      category: "UNKNOWN",
      message: this.extractErrorMessage(error),
      suggestion: "Investigate the error manually.",
      confidence: 0.2,
    };
  }

  // ─── Strategy Selection ───

  /**
   * Select the best recovery strategy based on root cause and context.
   *
   * Strategy selection logic:
   * - Attempt 1 + fixable categories → retry
   * - PERMISSION_ERROR / RESOURCE_ERROR → escalate immediately
   * - Attempt 2+ + rollback not tried → rollback
   * - Rollback tried + approach_change not tried → approach_change
   * - TIMEOUT + attempt 2+ → scope_reduce
   * - Too many strategies tried → escalate
   * - Default → approach_change
   *
   * @param rootCause Analyzed root cause
   * @param context Full failure context
   * @returns Recovery decision with strategy, reason, and optional prompt
   */
  selectStrategy(rootCause: RootCause, context: FailureContext): RecoveryDecision {
    const { category } = rootCause;
    const { attemptNumber, previousStrategies } = context;

    const tried = (s: RecoveryStrategy): boolean => previousStrategies.includes(s);

    // Immediate escalation for unrecoverable errors
    if (category === "PERMISSION_ERROR" || category === "RESOURCE_ERROR") {
      return {
        strategy: "escalate",
        reason: `${category} requires user intervention — cannot be auto-resolved.`,
        context: { category, immediateEscalation: true },
      };
    }

    // First attempt with fixable errors → simple retry
    const fixableOnRetry: ErrorCategory[] = [
      "BUILD_FAIL",
      "LINT_ERROR",
      "TYPE_ERROR",
    ];
    if (attemptNumber === 1 && fixableOnRetry.includes(category)) {
      return {
        strategy: "retry",
        reason: `First attempt with ${category} — retry with targeted fix.`,
        context: { category, attemptNumber },
      };
    }

    // Too many strategies tried → escalate
    if (previousStrategies.length >= this.config.escalateThreshold) {
      return {
        strategy: "escalate",
        reason: `Exhausted ${previousStrategies.length} strategies (threshold: ${this.config.escalateThreshold}).`,
        context: {
          triedStrategies: [...previousStrategies],
          threshold: this.config.escalateThreshold,
        },
      };
    }

    // Timeout on second+ attempt → scope_reduce
    if (category === "TIMEOUT" && attemptNumber >= 2 && this.config.enableScopeReduce) {
      return {
        strategy: "scope_reduce",
        reason: "Operation timed out repeatedly — reducing scope.",
        context: { category, attemptNumber },
      };
    }

    // Attempt 2+ and haven't tried rollback yet
    if (attemptNumber >= 2 && !tried("rollback") && this.config.enableRollback) {
      return {
        strategy: "rollback",
        reason: `Attempt ${attemptNumber} failed — rolling back to start fresh.`,
        context: {
          category,
          attemptNumber,
          filesCount: context.changedFiles.length,
        },
      };
    }

    // Tried rollback but not approach_change
    if (tried("rollback") && !tried("approach_change")) {
      return {
        strategy: "approach_change",
        reason: "Rollback completed — trying a fundamentally different approach.",
        context: { category, previousStrategies: [...previousStrategies] },
      };
    }

    // Default: approach_change
    return {
      strategy: "approach_change",
      reason: `${category} persists after ${attemptNumber} attempts — switching approach.`,
      context: { category, attemptNumber },
    };
  }

  // ─── Recovery Prompts ───

  /**
   * Build an LLM prompt tailored to the selected recovery strategy.
   *
   * Each strategy produces a different prompt style:
   * - retry: focused on the specific error with suggestion
   * - rollback: instructs fresh start after file restoration
   * - approach_change: suggests alternative implementations
   * - scope_reduce: narrows down the task scope
   * - escalate: summarizes the situation for the user
   *
   * @param decision Recovery decision from selectStrategy
   * @param context Full failure context
   * @returns Formatted prompt string
   */
  buildRecoveryPrompt(decision: RecoveryDecision, context: FailureContext): string {
    switch (decision.strategy) {
      case "retry":
        return this.buildRetryPrompt(decision, context);
      case "rollback":
        return this.buildRollbackPrompt(decision, context);
      case "approach_change":
        return this.buildApproachChangePrompt(decision, context);
      case "scope_reduce":
        return this.buildScopeReducePrompt(decision, context);
      case "escalate":
        return this.buildEscalatePrompt(decision, context);
      default:
        return this.buildRetryPrompt(decision, context);
    }
  }

  // ─── Rollback ───

  /**
   * Execute a rollback by restoring original file contents.
   *
   * Uses atomic writes: writes to a .tmp file first, then renames.
   * This prevents partial writes from corrupting files.
   *
   * @param changedFiles List of file paths to restore
   * @param originalSnapshots Map of file path → original content
   * @returns true if all files were successfully restored
   */
  async executeRollback(
    changedFiles: string[],
    originalSnapshots: Map<string, string>,
  ): Promise<boolean> {
    let allSuccess = true;

    for (const filePath of changedFiles) {
      const originalContent = originalSnapshots.get(filePath);
      if (originalContent === undefined) {
        // No snapshot for this file — skip (it may be a new file)
        continue;
      }

      try {
        // Atomic write: write to .tmp then rename
        const tmpPath = filePath + ".recovery.tmp";
        await writeFile(tmpPath, originalContent, "utf-8");
        await rename(tmpPath, filePath);
      } catch (err) {
        allSuccess = false;
        // Continue restoring other files even if one fails
      }
    }

    return allSuccess;
  }

  // ─── Scope Reduction ───

  /**
   * Build a scope-reduced version of the task description.
   *
   * Strips failed aspects from the original goal and produces
   * a simplified task that avoids the problematic areas.
   *
   * @param originalGoal The original task description
   * @param failedAspects Aspects that failed and should be skipped
   * @returns Scope-reduced task description
   */
  buildScopeReduction(originalGoal: string, failedAspects: string[]): string {
    const skipList = failedAspects
      .map((aspect) => `  - ${aspect}`)
      .join("\n");

    return [
      "The full task is too complex for the current context. Focus on the core requirement only.",
      "",
      `Original goal: ${originalGoal}`,
      "",
      "Reduced scope:",
      "  - Implement only the essential, minimum-viable version",
      "  - Skip edge cases and optional features",
      "  - Use simple/direct approaches over elegant ones",
      "",
      "Skip these aspects (they caused failures):",
      skipList,
      "",
      "You can add TODO comments for the skipped parts.",
    ].join("\n");
  }

  // ─── Strategy Tracking ───

  /**
   * Record the outcome of a strategy attempt.
   *
   * Used to track success rates and inform future strategy selection.
   *
   * @param strategy The strategy that was attempted
   * @param success Whether it resolved the error
   */
  recordStrategyResult(strategy: RecoveryStrategy, success: boolean): void {
    this.history.push({
      strategy,
      success,
      timestamp: Date.now(),
    });
  }

  /**
   * Reset all state for a new task.
   * Clears strategy history and statistics.
   */
  reset(): void {
    this.history.length = 0;
  }

  /**
   * Get statistics about strategy usage and success rate.
   *
   * @returns Object with strategies used, success rate, and current attempt count
   */
  getStats(): {
    strategiesUsed: RecoveryStrategy[];
    successRate: number;
    currentAttempt: number;
  } {
    const strategiesUsed = this.history.map((r) => r.strategy);
    const total = this.history.length;
    const successes = this.history.filter((r) => r.success).length;

    return {
      strategiesUsed,
      successRate: total > 0 ? successes / total : 0,
      currentAttempt: total + 1,
    };
  }

  // ─── Private: Prompt Builders ───

  private buildRetryPrompt(
    decision: RecoveryDecision,
    context: FailureContext,
  ): string {
    const rootCause = this.analyzeRootCause(context.error, context.toolName);
    const suggestion = rootCause.suggestion ?? "analyze the error and try a different fix";

    return [
      `[RECOVERY: RETRY — Attempt ${context.attemptNumber}/${context.maxAttempts}]`,
      "",
      `The previous attempt failed with:`,
      "```",
      this.truncate(context.error, 2000),
      "```",
      "",
      `Try again with a different approach to fix: ${suggestion}`,
      "",
      "Instructions:",
      "- Make minimal, targeted changes.",
      "- Do not repeat the same approach that failed.",
      rootCause.file ? `- Focus on file: ${rootCause.file}${rootCause.line ? ` (line ${rootCause.line})` : ""}` : "",
    ].filter(Boolean).join("\n");
  }

  private buildRollbackPrompt(
    decision: RecoveryDecision,
    context: FailureContext,
  ): string {
    const fileList = context.changedFiles.length > 0
      ? context.changedFiles.map((f) => path.basename(f)).join(", ")
      : "modified files";

    return [
      "[RECOVERY: ROLLBACK]",
      "",
      `Rolling back changes to ${fileList}.`,
      `The original approach failed because: ${decision.reason}`,
      "",
      "Start fresh with a different strategy:",
      "- Analyze why the previous approach failed before writing code.",
      "- Consider a fundamentally different implementation path.",
      "- Test incrementally — don't make large changes at once.",
      "",
      "Previous error:",
      "```",
      this.truncate(context.error, 1500),
      "```",
    ].join("\n");
  }

  private buildApproachChangePrompt(
    decision: RecoveryDecision,
    context: FailureContext,
  ): string {
    const rootCause = this.analyzeRootCause(context.error, context.toolName);
    const alternatives = this.suggestAlternatives(rootCause);

    return [
      "[RECOVERY: APPROACH CHANGE]",
      "",
      `Previous approach failed (${decision.reason}).`,
      "Consider alternative implementations:",
      "",
      ...alternatives.map((alt, i) => `${i + 1}. ${alt}`),
      "",
      "Previous error:",
      "```",
      this.truncate(context.error, 1200),
      "```",
      "",
      "Requirements:",
      "- Use a fundamentally different approach than before.",
      "- Avoid the pattern/API that caused the previous failure.",
      "- Start with the simplest possible implementation.",
    ].join("\n");
  }

  private buildScopeReducePrompt(
    decision: RecoveryDecision,
    context: FailureContext,
  ): string {
    return [
      "[RECOVERY: SCOPE REDUCE]",
      "",
      "The full task is too complex. Focus on the core requirement only.",
      "",
      "Previous error:",
      "```",
      this.truncate(context.error, 1000),
      "```",
      "",
      "Reduced scope instructions:",
      "- Implement the minimum viable version only.",
      "- Skip optional features, edge cases, and optimizations.",
      "- Use TODO comments for deferred work.",
      "- Break the task into smaller, independent steps.",
      "",
      `Changed files so far: ${context.changedFiles.length}`,
      `Attempt: ${context.attemptNumber}/${context.maxAttempts}`,
    ].join("\n");
  }

  private buildEscalatePrompt(
    decision: RecoveryDecision,
    context: FailureContext,
  ): string {
    const stats = this.getStats();
    const strategiesTried = context.previousStrategies.length > 0
      ? context.previousStrategies.join(", ")
      : "none";

    return [
      "[RECOVERY: ESCALATE — User Help Needed]",
      "",
      `I need your help. After ${context.attemptNumber} attempts with strategies [${strategiesTried}], I couldn't resolve:`,
      "",
      "```",
      this.truncate(context.error, 1500),
      "```",
      "",
      "Suggested next steps:",
      "- Review the error manually and provide guidance.",
      "- Check if the project environment is set up correctly.",
      "- Consider if this task requires a different approach entirely.",
      "",
      `Strategies tried: ${strategiesTried}`,
      `Success rate: ${(stats.successRate * 100).toFixed(0)}%`,
      `Files changed: ${context.changedFiles.join(", ") || "none"}`,
    ].join("\n");
  }

  // ─── Private: Root Cause Helpers ───

  /**
   * Extract file path and line number from an error string.
   * Handles common formats: "file.ts(10,5)", "file.ts:10:5", "(file.ts:10)"
   */
  private extractFileLocation(error: string): { file?: string; line?: number } {
    // TypeScript style: src/foo.ts(10,5): error TS...
    const tsMatch = error.match(/([^\s(]+\.(?:ts|tsx|js|jsx|mjs|cjs))\((\d+),\d+\)/);
    if (tsMatch) {
      return { file: tsMatch[1], line: parseInt(tsMatch[2], 10) };
    }

    // Colon style: src/foo.ts:10:5
    const colonMatch = error.match(/([^\s:]+\.(?:ts|tsx|js|jsx|mjs|cjs)):(\d+):\d+/);
    if (colonMatch) {
      return { file: colonMatch[1], line: parseInt(colonMatch[2], 10) };
    }

    // Just file, no line
    const fileMatch = error.match(/([^\s]+\.(?:ts|tsx|js|jsx|mjs|cjs))/);
    if (fileMatch) {
      return { file: fileMatch[1] };
    }

    return {};
  }

  /**
   * Extract a clean error message from raw output.
   * Takes the first meaningful error line.
   */
  private extractErrorMessage(error: string): string {
    const lines = error.split("\n").map((l) => l.trim()).filter(Boolean);

    // Look for lines starting with "error", "Error:", "TypeError:", etc.
    for (const line of lines) {
      if (/^(error|Error|TypeError|ReferenceError|SyntaxError)/i.test(line)) {
        return this.truncate(line, 300);
      }
    }

    // Look for "error TS" patterns
    for (const line of lines) {
      if (/error TS\d+/i.test(line)) {
        return this.truncate(line, 300);
      }
    }

    // Fallback: first non-empty line
    return this.truncate(lines[0] ?? error, 300);
  }

  /**
   * Compute confidence score for a category match.
   * Higher confidence when multiple signals align.
   */
  private computeConfidence(
    error: string,
    category: ErrorCategory,
    toolName?: string,
  ): number {
    let confidence = 0.6; // Base confidence for pattern match

    // Boost if tool name aligns with category
    const toolCategoryMap: Record<string, ErrorCategory[]> = {
      shell_exec: ["BUILD_FAIL", "RUNTIME_ERROR", "TIMEOUT"],
      file_write: ["PERMISSION_ERROR", "RESOURCE_ERROR"],
      file_edit: ["PERMISSION_ERROR"],
      file_read: ["PERMISSION_ERROR", "IMPORT_ERROR"],
    };

    if (toolName && toolCategoryMap[toolName]?.includes(category)) {
      confidence += 0.15;
    }

    // Boost if multiple patterns match
    const group = ERROR_PATTERNS.find((g) => g.category === category);
    if (group) {
      const matchCount = group.patterns.filter((p) => p.test(error)).length;
      if (matchCount > 1) {
        confidence += 0.1 * Math.min(matchCount - 1, 2);
      }
    }

    // Boost for very specific patterns (e.g., "error TS2345")
    if (/error TS\d{4}/.test(error) && category === "TYPE_ERROR") {
      confidence += 0.1;
    }
    if (/EACCES|EPERM/.test(error) && category === "PERMISSION_ERROR") {
      confidence += 0.1;
    }

    return Math.min(confidence, 1.0);
  }

  /**
   * Suggest alternative approaches based on the root cause category.
   */
  private suggestAlternatives(rootCause: RootCause): string[] {
    switch (rootCause.category) {
      case "TYPE_ERROR":
        return [
          "Use explicit type assertions or generics to resolve the type mismatch.",
          "Simplify the type structure — use a union or intersection type.",
          "Break the operation into smaller, type-safe steps.",
        ];
      case "IMPORT_ERROR":
        return [
          "Verify the module exists and is installed (check package.json).",
          "Use a relative import path instead of a package name.",
          "Check for typos in the import path and verify the export name.",
        ];
      case "BUILD_FAIL":
        return [
          "Fix syntax errors or missing tokens reported in the build output.",
          "Check for incompatible API usage with the current library version.",
          "Simplify the implementation to avoid the problematic construct.",
        ];
      case "TEST_FAIL":
        return [
          "Update expected values to match the new behavior.",
          "Mock or stub the dependency that causes the test to fail.",
          "Simplify the test case to isolate the failure.",
        ];
      case "LINT_ERROR":
        return [
          "Fix the specific lint rule violations reported.",
          "Use inline lint-disable comments only as a last resort.",
          "Refactor to follow the project's code style conventions.",
        ];
      case "TIMEOUT":
        return [
          "Reduce the amount of work in a single operation.",
          "Add chunking or pagination to process data incrementally.",
          "Skip optional validations to reduce execution time.",
        ];
      case "RUNTIME_ERROR":
        return [
          "Add null/undefined checks before accessing properties.",
          "Wrap the operation in try/catch and handle the error gracefully.",
          "Verify input data format matches what the code expects.",
        ];
      default:
        return [
          "Try a simpler implementation that avoids the problematic pattern.",
          "Break the task into smaller, independent steps.",
          "Check project documentation for guidance on the expected approach.",
        ];
    }
  }

  // ─── Private: Utilities ───

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    const half = Math.floor(maxLength / 2);
    return text.slice(0, half) + "\n... [truncated] ...\n" + text.slice(-half);
  }
}
