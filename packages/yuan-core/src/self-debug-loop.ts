/**
 * @module self-debug-loop
 * @description Self-Debugging Loop — Aggressive auto-fix with escalating strategies.
 *
 * More aggressive than basic AutoFix:
 * 1. Direct fix (read error, edit file)
 * 2. Context expansion (read related files)
 * 3. Alternative approach (different strategy)
 * 4. Rollback + fresh approach
 * 5. Escalate to user
 *
 * Integrates with FailureRecovery for rollback and error classification.
 *
 * @see auto-fix.ts for the simpler retry loop
 * @see failure-recovery.ts for root cause analysis and strategy selection
 */

import type { ToolCall, ToolResult } from "./types.js";

// ─── Interfaces ───

/** A single debug attempt record */
export interface DebugAttempt {
  /** Attempt number (1-based) */
  attempt: number;
  /** Strategy used for this attempt */
  strategy: DebugStrategy;
  /** Error being debugged */
  error: string;
  /** Fix description / what was tried */
  fix: string;
  /** Files changed during this attempt */
  filesChanged: string[];
  /** Result of running tests after fix */
  testResult: "pass" | "fail" | "error" | "timeout";
  /** Duration of this attempt in ms */
  durationMs: number;
}

/** Debug strategy — escalating from direct to user escalation */
export type DebugStrategy =
  | "direct_fix"       // Read error, edit file
  | "context_expand"   // Read related files, understand full flow
  | "alternative"      // Try different approach
  | "rollback_fresh"   // Git stash / restore originals, start over
  | "escalate";        // Give up, report to user

/** Result of the entire debug loop */
export interface DebugResult {
  /** Whether the issue was resolved */
  success: boolean;
  /** All attempts made */
  attempts: DebugAttempt[];
  /** Total duration in ms */
  totalDurationMs: number;
  /** Root cause analysis (if determined) */
  rootCause?: string;
  /** The strategy that finally worked (if success) */
  finalStrategy?: DebugStrategy;
}

/** Context provided to the debug loop */
export interface DebugContext {
  /** The test/build command to verify fixes */
  testCommand: string;
  /** Current error output */
  errorOutput: string;
  /** Files that were changed and might be the source of the issue */
  changedFiles: string[];
  /** Original file contents before any changes */
  originalSnapshots: Map<string, string>;
  /** Previous attempts (for context) */
  previousAttempts: DebugAttempt[];
  /** Current strategy being used */
  currentStrategy: DebugStrategy;
}

/** Root cause analysis result */
export interface RootCauseAnalysis {
  /** Error category */
  category: ErrorType;
  /** Specific error message extracted */
  message: string;
  /** File where the error originated */
  file?: string;
  /** Line number of the error */
  line?: number;
  /** Column number */
  column?: number;
  /** Suggested fix approach */
  suggestion: string;
  /** Confidence in this analysis (0–1) */
  confidence: number;
  /** Related error codes (e.g., TS2345) */
  errorCodes?: string[];
}

/** Error type classification */
export type ErrorType =
  | "type_error"
  | "syntax_error"
  | "import_error"
  | "runtime_error"
  | "test_assertion"
  | "lint_error"
  | "build_error"
  | "timeout"
  | "permission"
  | "unknown";

/** Minimal tool executor interface for the debug loop */
export interface ToolExecutorLike {
  execute(call: ToolCall, abortSignal?: AbortSignal): Promise<ToolResult>;
}

// ─── Error Patterns ───

interface ErrorPattern {
  category: ErrorType;
  patterns: RegExp[];
  suggestion: string;
}

const ERROR_PATTERNS: readonly ErrorPattern[] = [
  {
    category: "type_error",
    patterns: [
      /error TS\d+/i,
      /Type '.+' is not assignable to type/i,
      /Property '.+' does not exist on type/i,
      /Argument of type '.+' is not assignable/i,
      /Cannot find name '.+'/i,
    ],
    suggestion: "Fix type annotations, add missing type definitions, or use type assertions.",
  },
  {
    category: "syntax_error",
    patterns: [
      /SyntaxError/i,
      /Unexpected token/i,
      /Unexpected end of/i,
      /Missing semicolon/i,
      /Unterminated string/i,
    ],
    suggestion: "Fix syntax: check for missing brackets, semicolons, or malformed expressions.",
  },
  {
    category: "import_error",
    patterns: [
      /Cannot find module/i,
      /Module not found/i,
      /ERR_MODULE_NOT_FOUND/i,
      /Unable to resolve/i,
      /Could not resolve/i,
    ],
    suggestion: "Check import paths, verify the module is installed, check tsconfig paths.",
  },
  {
    category: "test_assertion",
    patterns: [
      /Expected .+ (to |but )?received/i,
      /AssertionError/i,
      /expect\(.+\)\./i,
      /\bFAIL\b.*\btest\b/i,
      /test failed/i,
    ],
    suggestion: "Update test expectations or fix the code to match expected behavior.",
  },
  {
    category: "lint_error",
    patterns: [
      /eslint/i,
      /prettier/i,
      /\blint\b/i,
    ],
    suggestion: "Fix lint violations per project rules.",
  },
  {
    category: "build_error",
    patterns: [
      /build failed/i,
      /compilation failed/i,
      /webpack.*error/i,
      /esbuild.*error/i,
      /rollup.*error/i,
    ],
    suggestion: "Fix build configuration or source errors reported in build output.",
  },
  {
    category: "runtime_error",
    patterns: [
      /TypeError:/,
      /ReferenceError:/,
      /RangeError:/,
      /\bError:/,
      /Uncaught/i,
    ],
    suggestion: "Add null checks, verify data shapes, and handle edge cases.",
  },
  {
    category: "timeout",
    patterns: [
      /\btimeout\b/i,
      /timed out/i,
      /ETIMEDOUT/i,
    ],
    suggestion: "Reduce operation scope, increase timeout, or add pagination.",
  },
  {
    category: "permission",
    patterns: [
      /EACCES/i,
      /EPERM/i,
      /permission denied/i,
    ],
    suggestion: "Check file permissions or run with appropriate privileges.",
  },
];

// ─── Strategy Order ───

/** Default strategy escalation order */
const STRATEGY_ORDER: DebugStrategy[] = [
  "direct_fix",
  "context_expand",
  "alternative",
  "rollback_fresh",
  "escalate",
];

// ─── SelfDebugLoop ───

/**
 * SelfDebugLoop — Aggressive auto-fix with escalating strategies.
 *
 * Runs an escalating loop of fix attempts:
 * 1. direct_fix: Analyze the error and make a targeted edit
 * 2. context_expand: Read more files to understand the full picture
 * 3. alternative: Try a fundamentally different approach
 * 4. rollback_fresh: Restore original files and start from scratch
 * 5. escalate: Report to user with full analysis
 *
 * @example
 * ```typescript
 * const debugLoop = new SelfDebugLoop({ maxAttempts: 5 });
 *
 * // Analyze an error
 * const analysis = debugLoop.analyzeError(errorOutput);
 * console.log(analysis.category, analysis.suggestion);
 *
 * // Build a fix prompt for the LLM
 * const prompt = debugLoop.buildFixPrompt("direct_fix", {
 *   testCommand: "pnpm tsc --noEmit",
 *   errorOutput: "error TS2345: ...",
 *   changedFiles: ["src/agent.ts"],
 *   originalSnapshots: new Map(),
 *   previousAttempts: [],
 *   currentStrategy: "direct_fix",
 * });
 *
 * // Run the full loop
 * const result = await debugLoop.debug({
 *   testCommand: "pnpm tsc --noEmit",
 *   errorOutput: "error TS2345: ...",
 *   changedFiles: ["src/agent.ts"],
 *   originalSnapshots: snapshots,
 *   toolExecutor: executor,
 * });
 * ```
 */
export class SelfDebugLoop {
  private readonly maxAttempts: number;

  constructor(config?: { maxAttempts?: number }) {
    this.maxAttempts = config?.maxAttempts ?? 5;
  }

  /**
   * Run the self-debugging loop.
   * Tries escalating strategies until tests pass or max attempts reached.
   *
   * @param params - Debug parameters
   * @returns Debug result with success status, attempts, and root cause
   */
  async debug(params: {
    testCommand: string;
    errorOutput: string;
    changedFiles: string[];
    originalSnapshots: Map<string, string>;
    toolExecutor: ToolExecutorLike;
    /** Optional LLM fixer callback. Receives a fix prompt, returns LLM response text. */
    llmFixer?: (prompt: string) => Promise<string>;
  }): Promise<DebugResult> {
    const { testCommand, errorOutput, changedFiles, originalSnapshots, toolExecutor, llmFixer } = params;

    const attempts: DebugAttempt[] = [];
    let currentError = errorOutput;
    const startTime = Date.now();

    for (let i = 0; i < this.maxAttempts; i++) {
      const attemptStart = Date.now();
      const strategy = this.selectStrategy(i, attempts);

      // If we've reached escalation, stop
      if (strategy === "escalate") {
        const rootCause = this.analyzeError(currentError);
        attempts.push({
          attempt: i + 1,
          strategy: "escalate",
          error: currentError,
          fix: "Escalated to user — automated fixes exhausted.",
          filesChanged: [],
          testResult: "error",
          durationMs: Date.now() - attemptStart,
        });

        return {
          success: false,
          attempts,
          totalDurationMs: Date.now() - startTime,
          rootCause: rootCause.message,
          finalStrategy: "escalate",
        };
      }

      // Execute rollback if that's the strategy
      if (strategy === "rollback_fresh") {
        await this.executeRollback(changedFiles, originalSnapshots, toolExecutor);
      }

      // If llmFixer is provided, build a fix prompt, get LLM response, and apply fixes
      let fixDescription = "";
      const attemptFilesChanged: string[] = [];

      if (llmFixer) {
        const debugContext: DebugContext = {
          testCommand,
          errorOutput: currentError,
          changedFiles,
          originalSnapshots,
          previousAttempts: attempts,
          currentStrategy: strategy,
        };

        const fixPrompt = this.buildFixPrompt(strategy, debugContext);
        const llmResponse = await llmFixer(fixPrompt);

        // Parse and execute tool calls from LLM response
        const toolCalls = this.parseLlmToolCalls(llmResponse);
        for (const call of toolCalls) {
          try {
            await toolExecutor.execute(call);
            // Track files changed by file_write / file_edit calls
            const args = typeof call.arguments === "string"
              ? JSON.parse(call.arguments) as Record<string, unknown>
              : call.arguments;
            if ((call.name === "file_write" || call.name === "file_edit") && typeof args.path === "string") {
              attemptFilesChanged.push(args.path);
            }
          } catch {
            // Individual tool call failure — continue with remaining calls
          }
        }

        fixDescription = toolCalls.length > 0
          ? `Strategy "${strategy}": applied ${toolCalls.length} tool call(s) from LLM`
          : `Strategy "${strategy}": LLM provided no tool calls`;
      }

      // Run the test command to see current state
      const testResult = await this.runTest(testCommand, toolExecutor);

      // If tests pass, we're done
      if (testResult.passed) {
        attempts.push({
          attempt: i + 1,
          strategy,
          error: currentError,
          fix: fixDescription || (strategy === "rollback_fresh"
            ? "Rolled back to original — tests now pass."
            : "Tests pass after previous fix."),
          filesChanged: attemptFilesChanged,
          testResult: "pass",
          durationMs: Date.now() - attemptStart,
        });

        return {
          success: true,
          attempts,
          totalDurationMs: Date.now() - startTime,
          finalStrategy: strategy,
        };
      }

      // Update current error from test output
      currentError = testResult.output || currentError;

      // Record the attempt
      const rootAnalysis = this.analyzeError(currentError);
      attempts.push({
        attempt: i + 1,
        strategy,
        error: currentError,
        fix: fixDescription || `Strategy "${strategy}": ${rootAnalysis.suggestion}`,
        filesChanged: attemptFilesChanged.length > 0 ? attemptFilesChanged : changedFiles,
        testResult: testResult.timedOut ? "timeout" : "fail",
        durationMs: Date.now() - attemptStart,
      });
    }

    // Max attempts exhausted
    const finalRootCause = this.analyzeError(currentError);
    return {
      success: false,
      attempts,
      totalDurationMs: Date.now() - startTime,
      rootCause: finalRootCause.message,
    };
  }

  /**
   * Select next strategy based on attempt number and previous results.
   *
   * Strategy escalation:
   * - Attempt 0: direct_fix
   * - Attempt 1: context_expand (or direct_fix again if first was timeout)
   * - Attempt 2: alternative
   * - Attempt 3: rollback_fresh
   * - Attempt 4+: escalate
   *
   * Adjustments based on previous attempt results:
   * - If last attempt was timeout, skip to alternative
   * - If same error persists across 2+ attempts, escalate faster
   *
   * @param attempt - Current attempt number (0-based)
   * @param previousAttempts - Previous debug attempts
   * @returns Selected strategy
   */
  selectStrategy(attempt: number, previousAttempts: DebugAttempt[]): DebugStrategy {
    // Check for repeated same errors — escalate faster
    if (previousAttempts.length >= 2) {
      const lastTwo = previousAttempts.slice(-2);
      const sameError = lastTwo[0].error === lastTwo[1].error;
      if (sameError && attempt >= 2) {
        // Same error twice — skip ahead in escalation
        const currentIdx = Math.min(attempt + 1, STRATEGY_ORDER.length - 1);
        return STRATEGY_ORDER[currentIdx];
      }
    }

    // Check if last attempt timed out — skip context_expand
    if (previousAttempts.length > 0) {
      const lastAttempt = previousAttempts[previousAttempts.length - 1];
      if (lastAttempt.testResult === "timeout" && attempt === 1) {
        return "alternative"; // Skip context_expand for timeouts
      }
    }

    // Default: follow the escalation order
    if (attempt >= STRATEGY_ORDER.length) {
      return "escalate";
    }
    return STRATEGY_ORDER[attempt];
  }

  /**
   * Build fix prompt for the LLM based on strategy.
   *
   * Each strategy produces a different prompt style:
   * - direct_fix: Focused on the specific error with file/line info
   * - context_expand: Asks LLM to read more files before fixing
   * - alternative: Suggests trying a completely different approach
   * - rollback_fresh: Files restored, start with clean slate
   * - escalate: Summarize for user
   *
   * @param strategy - Selected debug strategy
   * @param context - Full debug context
   * @returns Formatted prompt for the LLM
   */
  buildFixPrompt(strategy: DebugStrategy, context: DebugContext): string {
    const analysis = this.analyzeError(context.errorOutput);

    switch (strategy) {
      case "direct_fix":
        return this.buildDirectFixPrompt(context, analysis);
      case "context_expand":
        return this.buildContextExpandPrompt(context, analysis);
      case "alternative":
        return this.buildAlternativePrompt(context, analysis);
      case "rollback_fresh":
        return this.buildRollbackFreshPrompt(context, analysis);
      case "escalate":
        return this.buildEscalatePrompt(context, analysis);
      default:
        return this.buildDirectFixPrompt(context, analysis);
    }
  }

  /**
   * Analyze error output for root cause.
   *
   * Extracts:
   * - Error category (type, syntax, import, etc.)
   * - File and line information
   * - Error codes (e.g., TS2345)
   * - Suggested fix approach
   *
   * @param errorOutput - Raw error output string
   * @returns Root cause analysis
   */
  analyzeError(errorOutput: string): RootCauseAnalysis {
    // Try each pattern group
    for (const group of ERROR_PATTERNS) {
      for (const pattern of group.patterns) {
        if (pattern.test(errorOutput)) {
          const { file, line, column } = this.extractLocation(errorOutput);
          const errorCodes = this.extractErrorCodes(errorOutput);
          const message = this.extractCleanMessage(errorOutput);
          const confidence = this.computeAnalysisConfidence(
            errorOutput,
            group.category,
            errorCodes,
          );

          return {
            category: group.category,
            message,
            file,
            line,
            column,
            suggestion: group.suggestion,
            confidence,
            ...(errorCodes.length > 0 ? { errorCodes } : {}),
          };
        }
      }
    }

    // No pattern matched
    return {
      category: "unknown",
      message: this.extractCleanMessage(errorOutput),
      suggestion: "Investigate the error output manually and apply an appropriate fix.",
      confidence: 0.2,
    };
  }

  /**
   * Get the maximum number of attempts configured.
   */
  getMaxAttempts(): number {
    return this.maxAttempts;
  }

  /**
   * Get the strategy escalation order.
   */
  getStrategyOrder(): readonly DebugStrategy[] {
    return STRATEGY_ORDER;
  }

  // ─── Private: Prompt Builders ───

  private buildDirectFixPrompt(
    context: DebugContext,
    analysis: RootCauseAnalysis,
  ): string {
    const lines: string[] = [
      `[SELF-DEBUG: DIRECT FIX — Attempt ${context.previousAttempts.length + 1}/${this.maxAttempts}]`,
      "",
      "An error occurred. Analyze and fix it directly.",
      "",
      "## Error Output",
      "```",
      this.truncate(context.errorOutput, 2500),
      "```",
      "",
      "## Analysis",
      `Category: ${analysis.category}`,
      `Root cause: ${analysis.message}`,
    ];

    if (analysis.file) {
      lines.push(`File: ${analysis.file}${analysis.line ? `:${analysis.line}` : ""}`);
    }
    if (analysis.errorCodes?.length) {
      lines.push(`Error codes: ${analysis.errorCodes.join(", ")}`);
    }

    lines.push("");
    lines.push("## Instructions");
    lines.push(`- ${analysis.suggestion}`);
    lines.push("- Make minimal, targeted changes.");
    lines.push("- Focus on the root cause, not symptoms.");

    if (context.changedFiles.length > 0) {
      lines.push("");
      lines.push(`## Changed Files`);
      for (const f of context.changedFiles) {
        lines.push(`  - ${f}`);
      }
    }

    lines.push("");
    lines.push(`## Verify Command: \`${context.testCommand}\``);

    return lines.join("\n");
  }

  private buildContextExpandPrompt(
    context: DebugContext,
    analysis: RootCauseAnalysis,
  ): string {
    const lines: string[] = [
      `[SELF-DEBUG: CONTEXT EXPAND — Attempt ${context.previousAttempts.length + 1}/${this.maxAttempts}]`,
      "",
      "The direct fix didn't work. Read more context before trying again.",
      "",
      "## Error Output",
      "```",
      this.truncate(context.errorOutput, 2000),
      "```",
      "",
      "## Instructions",
      "1. Read related files to understand the full data flow.",
      "2. Trace imports and dependencies of the failing file.",
      "3. Check type definitions that might be involved.",
      "4. Then apply a fix with full understanding of the context.",
      "",
      `Root cause: ${analysis.message}`,
      `Suggestion: ${analysis.suggestion}`,
    ];

    if (analysis.file) {
      lines.push("");
      lines.push(`Start by reading: ${analysis.file}`);
      lines.push("Then trace its imports and dependents.");
    }

    if (context.previousAttempts.length > 0) {
      lines.push("");
      lines.push("## Previous Attempts (avoid repeating)");
      for (const prev of context.previousAttempts) {
        lines.push(`  - Attempt ${prev.attempt} (${prev.strategy}): ${prev.fix} → ${prev.testResult}`);
      }
    }

    return lines.join("\n");
  }

  private buildAlternativePrompt(
    context: DebugContext,
    analysis: RootCauseAnalysis,
  ): string {
    const alternatives = this.suggestAlternatives(analysis);

    const lines: string[] = [
      `[SELF-DEBUG: ALTERNATIVE APPROACH — Attempt ${context.previousAttempts.length + 1}/${this.maxAttempts}]`,
      "",
      "Previous approaches failed. Try a fundamentally different strategy.",
      "",
      "## Error Output",
      "```",
      this.truncate(context.errorOutput, 1500),
      "```",
      "",
      "## Alternative Approaches",
    ];

    for (let i = 0; i < alternatives.length; i++) {
      lines.push(`${i + 1}. ${alternatives[i]}`);
    }

    lines.push("");
    lines.push("## Requirements");
    lines.push("- Do NOT repeat previous approaches.");
    lines.push("- Use a fundamentally different pattern/API/strategy.");
    lines.push("- Start with the simplest possible implementation.");

    if (context.previousAttempts.length > 0) {
      lines.push("");
      lines.push("## Failed Approaches (do NOT repeat)");
      for (const prev of context.previousAttempts) {
        lines.push(`  - ${prev.fix}`);
      }
    }

    return lines.join("\n");
  }

  private buildRollbackFreshPrompt(
    context: DebugContext,
    analysis: RootCauseAnalysis,
  ): string {
    const lines: string[] = [
      `[SELF-DEBUG: ROLLBACK + FRESH START — Attempt ${context.previousAttempts.length + 1}/${this.maxAttempts}]`,
      "",
      "All changed files have been restored to their original state.",
      "Start fresh with a completely new approach.",
      "",
      "## Original Error",
      "```",
      this.truncate(context.errorOutput, 1500),
      "```",
      "",
      "## Root Cause Analysis",
      `Category: ${analysis.category}`,
      `Message: ${analysis.message}`,
      `Suggestion: ${analysis.suggestion}`,
      "",
      "## Instructions",
      "- Files are back to their original state.",
      "- Think step by step about the correct approach.",
      "- Read the relevant code BEFORE making changes.",
      "- Make incremental changes and verify each step.",
    ];

    if (context.previousAttempts.length > 0) {
      lines.push("");
      lines.push(`## What NOT to do (${context.previousAttempts.length} approaches failed)`);
      for (const prev of context.previousAttempts) {
        lines.push(`  - ${prev.strategy}: ${prev.fix}`);
      }
    }

    lines.push("");
    lines.push(`## Verify: \`${context.testCommand}\``);

    return lines.join("\n");
  }

  private buildEscalatePrompt(
    context: DebugContext,
    analysis: RootCauseAnalysis,
  ): string {
    const lines: string[] = [
      "[SELF-DEBUG: ESCALATE — User Help Needed]",
      "",
      `After ${context.previousAttempts.length} automated fix attempts, the issue could not be resolved.`,
      "",
      "## Error",
      "```",
      this.truncate(context.errorOutput, 2000),
      "```",
      "",
      "## Root Cause",
      `Category: ${analysis.category}`,
      `Message: ${analysis.message}`,
    ];

    if (analysis.file) {
      lines.push(`File: ${analysis.file}${analysis.line ? `:${analysis.line}` : ""}`);
    }

    lines.push("");
    lines.push("## Attempts Made");
    for (const prev of context.previousAttempts) {
      lines.push(`  ${prev.attempt}. [${prev.strategy}] ${prev.fix} → ${prev.testResult} (${prev.durationMs}ms)`);
    }

    lines.push("");
    lines.push("## Suggested Next Steps");
    lines.push("- Review the error output and provide guidance.");
    lines.push("- Check if the project environment is set up correctly.");
    lines.push(`- ${analysis.suggestion}`);

    return lines.join("\n");
  }

  // ─── Private: Error Analysis Helpers ───

  /**
   * Extract file location from error output.
   */
  private extractLocation(error: string): {
    file?: string;
    line?: number;
    column?: number;
  } {
    // TypeScript style: src/foo.ts(10,5)
    const tsMatch = error.match(
      /([^\s(]+\.(?:ts|tsx|js|jsx|mjs|cjs))\((\d+),(\d+)\)/,
    );
    if (tsMatch) {
      return {
        file: tsMatch[1],
        line: parseInt(tsMatch[2], 10),
        column: parseInt(tsMatch[3], 10),
      };
    }

    // Colon style: src/foo.ts:10:5
    const colonMatch = error.match(
      /([^\s:]+\.(?:ts|tsx|js|jsx|mjs|cjs)):(\d+):(\d+)/,
    );
    if (colonMatch) {
      return {
        file: colonMatch[1],
        line: parseInt(colonMatch[2], 10),
        column: parseInt(colonMatch[3], 10),
      };
    }

    // Just file with line: src/foo.ts:10
    const fileLineMatch = error.match(
      /([^\s:]+\.(?:ts|tsx|js|jsx|mjs|cjs)):(\d+)/,
    );
    if (fileLineMatch) {
      return {
        file: fileLineMatch[1],
        line: parseInt(fileLineMatch[2], 10),
      };
    }

    // Just file
    const fileMatch = error.match(
      /([^\s]+\.(?:ts|tsx|js|jsx|mjs|cjs))/,
    );
    if (fileMatch) {
      return { file: fileMatch[1] };
    }

    return {};
  }

  /**
   * Extract error codes like TS2345, TS2322, etc.
   */
  private extractErrorCodes(error: string): string[] {
    const codes: string[] = [];
    const codeRegex = /\b(TS\d{4})\b/g;
    let match: RegExpExecArray | null;
    while ((match = codeRegex.exec(error)) !== null) {
      if (!codes.includes(match[1])) {
        codes.push(match[1]);
      }
    }
    return codes;
  }

  /**
   * Extract a clean error message from raw output.
   */
  private extractCleanMessage(error: string): string {
    const lines = error.split("\n").map((l) => l.trim()).filter(Boolean);

    // Look for error lines
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

    // Look for "FAIL" lines
    for (const line of lines) {
      if (/\bFAIL\b/.test(line)) {
        return this.truncate(line, 300);
      }
    }

    // Fallback: first non-empty line
    return this.truncate(lines[0] ?? error, 300);
  }

  /**
   * Compute confidence in the error analysis.
   */
  private computeAnalysisConfidence(
    error: string,
    category: ErrorType,
    errorCodes: string[],
  ): number {
    let confidence = 0.5; // base

    // Error codes are very specific
    if (errorCodes.length > 0) {
      confidence += 0.2;
    }

    // Multiple pattern matches in same category boost confidence
    const group = ERROR_PATTERNS.find((g) => g.category === category);
    if (group) {
      const matchCount = group.patterns.filter((p) => p.test(error)).length;
      if (matchCount > 1) {
        confidence += 0.1 * Math.min(matchCount - 1, 3);
      }
    }

    // File location found boosts confidence
    const { file } = this.extractLocation(error);
    if (file) {
      confidence += 0.1;
    }

    return Math.min(confidence, 0.95);
  }

  /**
   * Suggest alternative approaches based on error category.
   */
  private suggestAlternatives(analysis: RootCauseAnalysis): string[] {
    switch (analysis.category) {
      case "type_error":
        return [
          "Use `as unknown as TargetType` to bypass strict type checking temporarily.",
          "Simplify the type structure — replace complex generics with simpler types.",
          "Break the operation into smaller type-safe helper functions.",
          "Add an overload signature or use a type predicate.",
        ];
      case "syntax_error":
        return [
          "Rewrite the problematic expression from scratch.",
          "Use a simpler construct (e.g., if/else instead of ternary chains).",
          "Check for encoding issues or invisible characters.",
        ];
      case "import_error":
        return [
          "Use a relative path instead of a package/alias path.",
          "Check if the module needs to be installed (pnpm add).",
          "Try importing from a different entry point.",
          "Check tsconfig paths and verify the alias mapping.",
        ];
      case "test_assertion":
        return [
          "Update expected values to match current behavior.",
          "Mock the dependency that produces different output.",
          "Simplify the test to focus on one assertion at a time.",
        ];
      case "runtime_error":
        return [
          "Add defensive null/undefined checks throughout the call chain.",
          "Wrap in try/catch and add explicit error handling.",
          "Validate input data before passing it to the function.",
        ];
      case "build_error":
        return [
          "Check for incompatible library versions in package.json.",
          "Try removing node_modules and reinstalling.",
          "Simplify the build target to isolate the issue.",
        ];
      case "timeout":
        return [
          "Reduce the data size or add pagination.",
          "Increase the timeout limit if the operation is inherently slow.",
          "Use async/streaming to process data incrementally.",
        ];
      default:
        return [
          "Try a simpler implementation that avoids the problematic pattern.",
          "Break the task into smaller, independently testable steps.",
          "Read project documentation for the expected approach.",
        ];
    }
  }

  // ─── Private: Execution Helpers ───

  /**
   * Run the test/verify command and return result.
   */
  private async runTest(
    testCommand: string,
    toolExecutor: ToolExecutorLike,
  ): Promise<{ passed: boolean; output: string; timedOut: boolean }> {
    try {
      const result = await toolExecutor.execute({
        id: `self-debug-test-${Date.now()}`,
        name: "shell_exec",
        arguments: { command: testCommand },
      });

      return {
        passed: result.success,
        output: result.output,
        timedOut: result.output.toLowerCase().includes("timeout") ||
                  result.output.toLowerCase().includes("timed out"),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        passed: false,
        output: message,
        timedOut: message.toLowerCase().includes("timeout"),
      };
    }
  }

  /**
   * Execute a rollback by restoring original file contents via the tool executor.
   */
  private async executeRollback(
    changedFiles: string[],
    originalSnapshots: Map<string, string>,
    toolExecutor: ToolExecutorLike,
  ): Promise<boolean> {
    let allSuccess = true;

    for (const filePath of changedFiles) {
      const originalContent = originalSnapshots.get(filePath);
      if (originalContent === undefined) continue;

      try {
        await toolExecutor.execute({
          id: `self-debug-rollback-${Date.now()}`,
          name: "file_write",
          arguments: {
            path: filePath,
            content: originalContent,
          },
        });
      } catch {
        allSuccess = false;
      }
    }

    return allSuccess;
  }

  /**
   * Parse LLM response text for tool calls.
   *
   * Looks for JSON tool call blocks in the LLM response. Supports two formats:
   * 1. Fenced JSON blocks with a "tool_calls" array
   * 2. Individual fenced JSON objects with "name" and "arguments" fields
   *
   * @param response - Raw LLM response text
   * @returns Array of parsed ToolCall objects
   */
  private parseLlmToolCalls(response: string): ToolCall[] {
    const toolCalls: ToolCall[] = [];

    // Extract all JSON code blocks from the response
    const jsonBlocks = response.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/g);
    if (!jsonBlocks) return toolCalls;

    for (const block of jsonBlocks) {
      const jsonContent = block.replace(/```(?:json)?\s*\n/, "").replace(/\n\s*```$/, "").trim();
      try {
        const parsed: unknown = JSON.parse(jsonContent);

        // Format 1: { "tool_calls": [...] }
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          "tool_calls" in (parsed as Record<string, unknown>) &&
          Array.isArray((parsed as Record<string, unknown>).tool_calls)
        ) {
          for (const tc of (parsed as { tool_calls: unknown[] }).tool_calls) {
            const call = this.validateToolCall(tc);
            if (call) toolCalls.push(call);
          }
          continue;
        }

        // Format 2: Array of tool calls
        if (Array.isArray(parsed)) {
          for (const tc of parsed) {
            const call = this.validateToolCall(tc);
            if (call) toolCalls.push(call);
          }
          continue;
        }

        // Format 3: Single tool call object
        const call = this.validateToolCall(parsed);
        if (call) toolCalls.push(call);
      } catch {
        // Not valid JSON — skip this block
      }
    }

    return toolCalls;
  }

  /**
   * Validate and normalize a parsed object into a ToolCall.
   */
  private validateToolCall(obj: unknown): ToolCall | null {
    if (obj === null || typeof obj !== "object") return null;
    const record = obj as Record<string, unknown>;
    if (typeof record.name !== "string") return null;
    if (record.arguments === undefined) return null;

    return {
      id: typeof record.id === "string" ? record.id : `self-debug-fix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: record.name,
      arguments: typeof record.arguments === "string"
        ? record.arguments
        : record.arguments as Record<string, unknown>,
    };
  }

  /**
   * Truncate text with ellipsis indicator.
   */
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    const half = Math.floor(maxLength / 2);
    return text.slice(0, half) + "\n... [truncated] ...\n" + text.slice(-half);
  }
}
