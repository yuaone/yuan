/**
 * @module debate-orchestrator
 * @description Multi-Agent Debate system for YUAN.
 *
 * Implements a Coder -> Reviewer -> Coder -> Verifier loop:
 * 1. Coder Agent generates code to solve the task
 * 2. Reviewer Agent reviews the code, finds issues
 * 3. Coder Agent addresses the review feedback
 * 4. Verifier Agent runs tests/builds and makes final judgment
 *
 * This significantly reduces hallucination and improves code quality
 * by having adversarial agents check each other's work.
 *
 * @example
 * ```typescript
 * const orchestrator = DebateOrchestrator.create({
 *   projectPath: "/home/user/project",
 *   maxRounds: 3,
 *   qualityThreshold: 80,
 *   byokConfig: { provider: "openai", apiKey: "sk-..." },
 * });
 *
 * orchestrator.on("debate:round:start", ({ round }) => {
 *   console.log(`Round ${round} starting...`);
 * });
 *
 * const result = await orchestrator.debate(
 *   "Implement a rate limiter middleware",
 *   "Express.js project with TypeScript",
 * );
 *
 * if (result.success) {
 *   console.log(`Passed with score ${result.finalScore}`);
 * }
 * ```
 */

import { EventEmitter } from "node:events";
import { BYOKClient } from "./llm-client.js";
import type { BYOKConfig, ToolExecutor, ToolCall } from "./types.js";

// ─── Types ───────────────────────────────────────────────────────

/** Configuration for a debate session */
export interface DebateConfig {
  /** Maximum debate rounds (coder->reviewer cycles). Default: 3 */
  maxRounds: number;
  /** Minimum quality score to pass (0-100). Default: 80 */
  qualityThreshold: number;
  /** LLM model for coder agent */
  coderModel?: string;
  /** LLM model for reviewer agent (can be different for diversity) */
  reviewerModel?: string;
  /** LLM model for verifier agent */
  verifierModel?: string;
  /** Whether to run verification (build/test) between rounds. Default: true */
  verifyBetweenRounds: boolean;
  /** Project path for file operations */
  projectPath: string;
  /** Tool executor for running tools (build, test, etc.) */
  toolExecutor?: ToolExecutor;
  /** BYOK config for LLM calls */
  byokConfig?: BYOKConfig;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Maximum tokens per LLM call. Default: 16384 */
  maxTokensPerCall: number;
  /** Total token budget for the entire debate. Default: 200000 */
  totalTokenBudget: number;
}

/** Role within the debate */
export type DebateRole = "coder" | "reviewer" | "verifier";

/** A single round of debate */
export interface DebateRound {
  /** Round number (1-based) */
  round: number;
  /** What the coder produced */
  coderOutput: string;
  /** Reviewer's critique text */
  reviewerFeedback: string;
  /** Structured issues found by reviewer */
  issues: ReviewIssue[];
  /** Coder's revised output after receiving feedback */
  coderRevision?: string;
  /** Verifier's result (if verification ran this round) */
  verifierResult?: VerifierResult;
}

/** A structured issue found during review */
export interface ReviewIssue {
  /** How severe the issue is */
  severity: "critical" | "major" | "minor" | "suggestion";
  /** File path where the issue was found */
  file?: string;
  /** Line number of the issue */
  line?: number;
  /** Description of the issue */
  description: string;
  /** Suggested fix */
  suggestion?: string;
}

/** Result from the verifier agent */
export interface VerifierResult {
  /** Whether overall verification passed */
  passed: boolean;
  /** Quality score 0-100 */
  score: number;
  /** Whether the build step passed */
  buildPassed: boolean;
  /** Whether the test step passed */
  testsPassed: boolean;
  /** Whether the security check passed */
  securityPassed: boolean;
  /** Detailed explanation */
  details: string;
}

/** Final result of the entire debate session */
export interface DebateResult {
  /** Whether the debate concluded successfully */
  success: boolean;
  /** All rounds of the debate */
  rounds: DebateRound[];
  /** Final quality score */
  finalScore: number;
  /** Total tokens consumed across all roles */
  totalTokensUsed: number;
  /** Files that were changed during the debate */
  changedFiles: string[];
  /** Human-readable summary of the debate outcome */
  summary: string;
}

/** Token usage tracked per role */
interface RoleTokenUsage {
  coder: { input: number; output: number };
  reviewer: { input: number; output: number };
  verifier: { input: number; output: number };
}

// ─── Event types ─────────────────────────────────────────────────

/** Events emitted by the DebateOrchestrator */
export interface DebateOrchestratorEvents {
  "debate:start": [payload: { task: string; maxRounds: number }];
  "debate:round:start": [payload: { round: number }];
  "debate:round:end": [payload: { round: number; issueCount: number }];
  "debate:coder": [payload: { round: number; output: string }];
  "debate:reviewer": [payload: { round: number; issueCount: number; hasCritical: boolean }];
  "debate:revision": [payload: { round: number; output: string }];
  "debate:verifier": [payload: { round: number; score: number; passed: boolean }];
  "debate:pass": [payload: { round: number; score: number }];
  "debate:fail": [payload: { finalScore: number; reason: string }];
  "debate:token_usage": [payload: { role: DebateRole; input: number; output: number }];
  "debate:abort": [payload: { reason: string }];
}

// ─── Constants ───────────────────────────────────────────────────

const DEFAULT_CONFIG: Omit<DebateConfig, "projectPath"> = {
  maxRounds: 3,
  qualityThreshold: 80,
  verifyBetweenRounds: true,
  maxTokensPerCall: 16384,
  totalTokenBudget: 200_000,
};

const CODER_SYSTEM_PROMPT = `You are an expert software engineer working on a coding task.

Your responsibilities:
- Write clean, correct, complete code
- Follow best practices and established patterns
- Consider edge cases and error handling
- Write tests when appropriate
- Use proper types and documentation

When generating code, output the COMPLETE code (not just snippets).
Structure your response as:

## Plan
Brief plan of what you will implement.

## Code
\`\`\`[language]
[complete code]
\`\`\`

## Files Changed
List each file you created or modified.

## Notes
Any important notes about your implementation.`;

const CODER_REVISION_SYSTEM_PROMPT = `You are an expert software engineer addressing code review feedback.

Your responsibilities:
- Carefully read each review issue
- Fix ALL critical and major issues
- Address minor issues where reasonable
- Explain what you changed and why
- Ensure the fixes don't introduce new problems

Structure your response as:

## Issues Addressed
For each issue, explain what you changed.

## Updated Code
\`\`\`[language]
[complete updated code]
\`\`\`

## Files Changed
List each file you modified.

## Remaining Issues
Any issues you intentionally did not fix, with reasoning.`;

const REVIEWER_SYSTEM_PROMPT = `You are a senior code reviewer conducting a thorough review.

Your responsibilities:
- Find ALL issues including: bugs, security vulnerabilities, performance problems, missing edge cases, style violations, incomplete implementations
- Be specific and constructive — point to exact locations
- Rate each issue: critical, major, minor, or suggestion
- Consider the project context and coding conventions

You MUST respond with ONLY a JSON object (no markdown fencing, no extra text):

{
  "feedback": "Overall assessment text here",
  "issues": [
    {
      "severity": "critical|major|minor|suggestion",
      "file": "path/to/file.ts",
      "line": 42,
      "description": "What is wrong",
      "suggestion": "How to fix it"
    }
  ]
}

Severity guidelines:
- **critical**: Will cause crashes, data loss, or security breaches. Must fix.
- **major**: Significant bugs, performance issues, or missing functionality. Should fix.
- **minor**: Code style, naming, minor inefficiencies. Nice to fix.
- **suggestion**: Improvements that could make the code better but aren't necessary.

Be thorough but fair. Do NOT inflate severity — only use "critical" for genuinely dangerous issues.`;

const VERIFIER_SYSTEM_PROMPT = `You are a quality assurance engineer evaluating code.

Evaluate the code against these criteria and provide a score for each:
1. **Correctness** (0-100): Does the code work? Are there logic errors?
2. **Completeness** (0-100): Does it handle all cases? Missing error handling?
3. **Security** (0-100): Any vulnerabilities? Hardcoded secrets? Injection risks?
4. **Performance** (0-100): Any bottlenecks? Unnecessary complexity?
5. **Maintainability** (0-100): Is it clean, readable, well-documented?

You MUST respond with ONLY a JSON object (no markdown fencing, no extra text):

{
  "passed": true|false,
  "score": 85,
  "buildPassed": true|false,
  "testsPassed": true|false,
  "securityPassed": true|false,
  "details": "Explanation of the assessment",
  "breakdown": {
    "correctness": 90,
    "completeness": 80,
    "security": 95,
    "performance": 75,
    "maintainability": 85
  }
}

The overall "score" should be the weighted average:
- Correctness: 30%
- Completeness: 20%
- Security: 25%
- Performance: 10%
- Maintainability: 15%

Set "passed" to true only if score >= the quality threshold AND no critical security issues.`;

// ─── DebateOrchestrator ──────────────────────────────────────────

/**
 * DebateOrchestrator — Multi-agent debate loop for code quality improvement.
 *
 * Creates adversarial Coder/Reviewer/Verifier agents that check each other's work,
 * significantly reducing hallucination and improving code quality.
 *
 * Uses EventEmitter for observability so callers can track progress in real-time.
 */
export class DebateOrchestrator extends EventEmitter {
  private readonly config: DebateConfig;
  private rounds: DebateRound[] = [];
  private totalTokens = 0;
  private llmClient?: BYOKClient;
  private readonly roleTokens: RoleTokenUsage = {
    coder: { input: 0, output: 0 },
    reviewer: { input: 0, output: 0 },
    verifier: { input: 0, output: 0 },
  };
  private readonly changedFiles = new Set<string>();

  constructor(config: Partial<DebateConfig> & { projectPath: string }) {
    super();
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
    if (this.config.byokConfig) {
      this.llmClient = new BYOKClient(this.config.byokConfig);
    }
  }

  /**
   * Run a debate session for a given task.
   *
   * The debate proceeds through rounds of Coder -> Reviewer -> Revision -> Verifier
   * until the quality threshold is met or max rounds are exhausted.
   *
   * @param task - The coding task description
   * @param context - Additional context (file contents, plan, etc.)
   * @returns DebateResult with all rounds and final score
   */
  async debate(task: string, context?: string): Promise<DebateResult> {
    this.rounds = [];
    this.totalTokens = 0;
    this.changedFiles.clear();
    this.resetRoleTokens();

    this.emit("debate:start", { task, maxRounds: this.config.maxRounds });

    for (let round = 1; round <= this.config.maxRounds; round++) {
      // Check abort signal
      if (this.config.abortSignal?.aborted) {
        this.emit("debate:abort", { reason: "AbortSignal triggered" });
        break;
      }

      // Check token budget
      if (this.totalTokens >= this.config.totalTokenBudget) {
        this.emit("debate:abort", { reason: "Token budget exhausted" });
        break;
      }

      this.emit("debate:round:start", { round });

      // Step 1: Coder generates/revises code
      const coderOutput = await this.runCoder(task, context, round);
      if (this.config.abortSignal?.aborted) break;

      this.emit("debate:coder", { round, output: this.truncate(coderOutput, 500) });
      this.extractFilePaths(coderOutput);

      // Step 2: Reviewer critiques the code
      const review = await this.runReviewer(coderOutput, task, round);
      if (this.config.abortSignal?.aborted) break;

      const criticalOrMajor = review.issues.filter(
        (i) => i.severity === "critical" || i.severity === "major",
      );

      this.emit("debate:reviewer", {
        round,
        issueCount: review.issues.length,
        hasCritical: review.issues.some((i) => i.severity === "critical"),
      });

      // Step 3: If no critical/major issues, try verification early
      if (criticalOrMajor.length === 0 && this.config.verifyBetweenRounds) {
        const verification = await this.runVerifier(coderOutput, task);

        this.emit("debate:verifier", {
          round,
          score: verification.score,
          passed: verification.passed,
        });

        const debateRound: DebateRound = {
          round,
          coderOutput,
          reviewerFeedback: review.feedback,
          issues: review.issues,
          verifierResult: verification,
        };
        this.rounds.push(debateRound);
        this.emit("debate:round:end", {
          round,
          issueCount: review.issues.length,
        });
        if (verification.passed && verification.score >= this.config.qualityThreshold) {
          this.emit("debate:pass", { round, score: verification.score });
          return this.buildResult(verification);
        }
      }

      // Step 4: Coder addresses review feedback (revision)
      const revision = await this.runCoderRevision(coderOutput, review, task, round);
      if (this.config.abortSignal?.aborted) break;

      this.emit("debate:revision", { round, output: this.truncate(revision, 500) });
      this.extractFilePaths(revision);

      // If we didn't push a round with verification yet (had critical issues), push now
      if (criticalOrMajor.length > 0 || !this.config.verifyBetweenRounds) {
        // Optionally verify the revision
        let verifierResult: VerifierResult | undefined;
        if (this.config.verifyBetweenRounds) {
          verifierResult = await this.runVerifier(revision, task);
          this.emit("debate:verifier", {
            round,
            score: verifierResult.score,
            passed: verifierResult.passed,
          });
        }

        const debateRound: DebateRound = {
          round,
          coderOutput,
          reviewerFeedback: review.feedback,
          issues: review.issues,
          coderRevision: revision,
          verifierResult,
        };
        this.rounds.push(debateRound);

        // Check if revision passes
        if (verifierResult?.passed && verifierResult.score >= this.config.qualityThreshold) {
          this.emit("debate:pass", { round, score: verifierResult.score });
          return this.buildResult(verifierResult);
        }
      } else {
        // Update the already-pushed round with the revision
        const existingRound = this.rounds[this.rounds.length - 1];
        if (existingRound) {
          existingRound.coderRevision = revision;
        }
      }

      // Update context for next round with the revision and feedback
      context = this.buildNextRoundContext(context, this.rounds[this.rounds.length - 1]);

      this.emit("debate:round:end", {
        round,
        issueCount: review.issues.length,
      });
    }

    // Final verification on the last output
    const lastRound = this.rounds[this.rounds.length - 1];
    const lastOutput = lastRound?.coderRevision ?? lastRound?.coderOutput ?? "";

    let finalVerification: VerifierResult;
    if (lastRound?.verifierResult) {
      finalVerification = lastRound.verifierResult;
    } else {
      finalVerification = await this.runVerifier(lastOutput, task);
    }

    const result = this.buildResult(finalVerification);

    if (!result.success) {
      this.emit("debate:fail", {
        finalScore: result.finalScore,
        reason: result.summary,
      });
    }

    return result;
  }

  // ─── Role Implementations ─────────────────────────────────────

  /**
   * Coder Agent: Generates code to solve the task.
   * Uses system prompt that emphasizes correctness, completeness, and clean code.
   */
  private async runCoder(
    task: string,
    context: string | undefined,
    round: number,
  ): Promise<string> {
    const sections: string[] = [];

    sections.push(`## Task\n${task}`);

    if (context) {
      sections.push(`## Context\n${context}`);
    }

    sections.push(`## Project Path\n${this.config.projectPath}`);

    if (round > 1) {
      sections.push(`## Note\nThis is round ${round} of the debate. Previous rounds had issues that need to be addressed. See the context above for details.`);
    }

    const userMessage = sections.join("\n\n");
    return this.callLLM(CODER_SYSTEM_PROMPT, userMessage, "coder", this.config.coderModel);
  }

  /**
   * Reviewer Agent: Critically reviews the coder's output.
   * Uses system prompt that emphasizes finding bugs, security issues, edge cases.
   * Returns structured feedback with severity levels.
   */
  private async runReviewer(
    coderOutput: string,
    task: string,
    round: number,
  ): Promise<{ feedback: string; issues: ReviewIssue[] }> {
    const sections: string[] = [];

    sections.push(`## Original Task\n${task}`);
    sections.push(`## Code to Review (Round ${round})\n${coderOutput}`);
    sections.push(`## Project Path\n${this.config.projectPath}`);

    const userMessage = sections.join("\n\n");
    const response = await this.callLLM(
      REVIEWER_SYSTEM_PROMPT,
      userMessage,
      "reviewer",
      this.config.reviewerModel,
    );

    return this.parseReviewerResponse(response);
  }

  /**
   * Coder Agent (revision): Addresses reviewer feedback.
   * Given the original code and reviewer issues, produces improved code.
   */
  private async runCoderRevision(
    originalCode: string,
    review: { feedback: string; issues: ReviewIssue[] },
    task: string,
    round: number,
  ): Promise<string> {
    const sections: string[] = [];

    sections.push(`## Original Task\n${task}`);
    sections.push(`## Your Previous Code (Round ${round})\n${originalCode}`);
    sections.push(`## Reviewer Feedback\n${review.feedback}`);

    if (review.issues.length > 0) {
      const issuesList = review.issues
        .map((issue, idx) => {
          const parts = [`${idx + 1}. [${issue.severity.toUpperCase()}] ${issue.description}`];
          if (issue.file) parts.push(`   File: ${issue.file}${issue.line ? `:${issue.line}` : ""}`);
          if (issue.suggestion) parts.push(`   Suggestion: ${issue.suggestion}`);
          return parts.join("\n");
        })
        .join("\n\n");

      sections.push(`## Issues to Fix\n${issuesList}`);
    }

    sections.push(`## Project Path\n${this.config.projectPath}`);

    const userMessage = sections.join("\n\n");
    return this.callLLM(
      CODER_REVISION_SYSTEM_PROMPT,
      userMessage,
      "coder",
      this.config.coderModel,
    );
  }

  /**
   * Verifier Agent: Runs objective checks (build, test, security scan)
   * and provides a holistic quality assessment via LLM.
   */
  private async runVerifier(code: string, task: string): Promise<VerifierResult> {
    // Step 1: Run build/test checks if tool executor is available
    let buildPassed = true;
    let testsPassed = true;
    let buildOutput = "";
    let testOutput = "";

    if (this.config.toolExecutor) {
      const buildResult = await this.runToolSafe("shell_exec", {
        command: "pnpm run build --if-present 2>&1",
        cwd: this.config.projectPath,
      });
      buildPassed = buildResult.success;
      buildOutput = buildResult.output;

      const testResult = await this.runToolSafe("shell_exec", {
        command: "pnpm run test --if-present 2>&1",
        cwd: this.config.projectPath,
      });
      testsPassed = testResult.success;
      testOutput = testResult.output;
    }

    // Step 2: LLM quality assessment
    const sections: string[] = [];

    sections.push(`## Original Task\n${task}`);
    sections.push(`## Code to Verify\n${code}`);
    sections.push(`## Quality Threshold\n${this.config.qualityThreshold}/100`);

    if (buildOutput) {
      sections.push(`## Build Result\n${buildPassed ? "PASSED" : "FAILED"}\n\`\`\`\n${this.truncate(buildOutput, 2000)}\n\`\`\``);
    }
    if (testOutput) {
      sections.push(`## Test Result\n${testsPassed ? "PASSED" : "FAILED"}\n\`\`\`\n${this.truncate(testOutput, 2000)}\n\`\`\``);
    }

    const userMessage = sections.join("\n\n");
    const response = await this.callLLM(
      VERIFIER_SYSTEM_PROMPT,
      userMessage,
      "verifier",
      this.config.verifierModel,
    );

    const parsed = this.parseVerifierResponse(response);

    // Override with actual build/test results if we ran them
    if (this.config.toolExecutor) {
      parsed.buildPassed = buildPassed;
      parsed.testsPassed = testsPassed;

      // If build or tests failed, cap the score and mark as not passed
      if (!buildPassed || !testsPassed) {
        parsed.score = Math.min(parsed.score, 50);
        parsed.passed = false;
      }
    }

    return parsed;
  }

  // ─── LLM Calling ──────────────────────────────────────────────

  /**
   * Call the LLM with a system prompt and user message.
   * Tracks token usage per role and total.
   */
  private async callLLM(
    systemPrompt: string,
    userMessage: string,
    role: DebateRole,
    model?: string,
  ): Promise<string> {
    if (!this.config.byokConfig) {
      // No BYOK config — return a placeholder indicating LLM is not configured
      return `[LLM not configured — ${role} agent would process: ${this.truncate(userMessage, 200)}]`;
    }

    const byokConfig: BYOKConfig = { ...this.config.byokConfig };
    if (model) {
      byokConfig.model = model;
    }

const client = this.llmClient ?? new BYOKClient(byokConfig);

    try {
      const response = await client.chat([
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ]);

      // Track token usage
      const usage = response.usage;
 const newTotal = this.totalTokens + usage.input + usage.output;

 if (newTotal > this.config.totalTokenBudget) {
        throw new Error(
          `[DebateOrchestrator] ${role} token budget exceeded: ` +
          `${newTotal}/${this.config.totalTokenBudget}`,
        );
      }
      this.roleTokens[role].input += usage.input;
      this.roleTokens[role].output += usage.output;
      this.totalTokens = newTotal;

      this.emit("debate:token_usage", {
        role,
        input: usage.input,
        output: usage.output,
      });

      return response.content ?? "";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[DebateOrchestrator] ${role} LLM call failed: ${message}`);
    } 
  }



  // ─── Tool Execution ───────────────────────────────────────────

  /**
   * Safely execute a tool via the tool executor.
   * Returns a success/failure result, never throws.
   */
  private async runToolSafe(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; output: string }> {
    if (!this.config.toolExecutor) {
      return { success: true, output: "[No tool executor — skipped]" };
    }

    try {
      const call: ToolCall = {
        id: `debate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: toolName,
        arguments: args,
      };

      const result = await this.config.toolExecutor.execute(
        call,
        this.config.abortSignal,
      );

      return { success: result.success, output: result.output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Tool error: ${message}` };
    }
  }

  // ─── Response Parsers ─────────────────────────────────────────

  /**
   * Parse the reviewer's JSON response into structured feedback + issues.
   * Handles malformed JSON gracefully.
   */
  private parseReviewerResponse(
    response: string,
  ): { feedback: string; issues: ReviewIssue[] } {
    try {
      const jsonStr = this.extractJson(response);
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

      const feedback =
        typeof parsed.feedback === "string"
          ? parsed.feedback
          : "No feedback provided";

      const rawIssues = Array.isArray(parsed.issues) ? parsed.issues : [];
      const issues = this.parseIssues(rawIssues);

      return { feedback, issues };
    } catch {
      // If JSON parsing fails, treat entire response as feedback with no structured issues
      return {
        feedback: response,
        issues: [],
      };
    }
  }

  /**
   * Parse raw issue objects into typed ReviewIssue[].
   */
  private parseIssues(raw: unknown[]): ReviewIssue[] {
    const validSeverities = new Set(["critical", "major", "minor", "suggestion"]);

    return raw
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null,
      )
      .map((item) => {
        const issue: ReviewIssue = {
          severity: validSeverities.has(item.severity as string)
            ? (item.severity as ReviewIssue["severity"])
            : "minor",
          description:
            typeof item.description === "string"
              ? item.description
              : "No description",
        };

        if (typeof item.file === "string") {
          issue.file = item.file;
          // Track changed files mentioned in reviews
          this.changedFiles.add(item.file);
        }
        if (typeof item.line === "number") {
          issue.line = item.line;
        }
        if (typeof item.suggestion === "string") {
          issue.suggestion = item.suggestion;
        }

        return issue;
      });
  }

  /**
   * Parse the verifier's JSON response into a VerifierResult.
   * Handles malformed JSON gracefully.
   */
  private parseVerifierResponse(response: string): VerifierResult {
    try {
      const jsonStr = this.extractJson(response);
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

      const score =
        typeof parsed.score === "number"
          ? Math.max(0, Math.min(100, Math.round(parsed.score)))
          : 50;

      return {
        passed: typeof parsed.passed === "boolean" ? parsed.passed : score >= this.config.qualityThreshold,
        score,
        buildPassed: typeof parsed.buildPassed === "boolean" ? parsed.buildPassed : true,
        testsPassed: typeof parsed.testsPassed === "boolean" ? parsed.testsPassed : true,
        securityPassed: typeof parsed.securityPassed === "boolean" ? parsed.securityPassed : true,
        details: typeof parsed.details === "string" ? parsed.details : "No details provided",
      };
    } catch {
      // If JSON parsing fails, return a conservative default
      return {
        passed: false,
        score: 50,
        buildPassed: true,
        testsPassed: true,
        securityPassed: true,
        details: `Verifier response could not be parsed: ${this.truncate(response, 200)}`,
      };
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────

  /**
   * Extract JSON from a response that might contain markdown fencing or extra text.
   */
  private extractJson(text: string): string {
    text = text.trim();
    // Try ```json ... ``` pattern first
    const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenced) return fenced[1].trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return jsonMatch[0];
  }
    // Try to find raw JSON object
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return text.slice(firstBrace, lastBrace + 1);
    }

    return text.trim();
  }

  /**
   * Build context for the next round, incorporating previous round's results.
   */
  private buildNextRoundContext(
    previousContext: string | undefined,
    round: DebateRound,
  ): string {
    const sections: string[] = [];

    if (previousContext) {
      // Keep only essential previous context to stay within token limits
      sections.push(`## Previous Context\n${this.truncate(previousContext, 2000)}`);
    }

    sections.push(`## Round ${round.round} Summary`);
    sections.push(`### Reviewer Found ${round.issues.length} Issue(s)`);

    if (round.issues.length > 0) {
      const criticalCount = round.issues.filter((i) => i.severity === "critical").length;
      const majorCount = round.issues.filter((i) => i.severity === "major").length;
      const minorCount = round.issues.filter((i) => i.severity === "minor").length;

      sections.push(
        `- Critical: ${criticalCount}, Major: ${majorCount}, Minor: ${minorCount}`,
      );

      // Include critical and major issues in detail
      const important = round.issues.filter(
        (i) => i.severity === "critical" || i.severity === "major",
      );
      if (important.length > 0) {
        sections.push("\n### Unresolved Important Issues:");
        for (const issue of important) {
          sections.push(`- [${issue.severity.toUpperCase()}] ${issue.description}`);
          if (issue.suggestion) {
            sections.push(`  Fix: ${issue.suggestion}`);
          }
        }
      }
    }

    if (round.verifierResult) {
      sections.push(
        `\n### Verifier Score: ${round.verifierResult.score}/100 (${round.verifierResult.passed ? "PASSED" : "FAILED"})`,
      );
      sections.push(`Details: ${round.verifierResult.details}`);
    }

    if (round.coderRevision) {
      sections.push(`\n### Last Revision\n${this.truncate(round.coderRevision, 2000)}`);
    } else {
      sections.push(`\n### Last Code Output\n${this.truncate(round.coderOutput, 4000)}`);
    }

    return sections.join("\n");
  }

  /**
   * Build the final DebateResult from all rounds and the final verification.
   */
  private buildResult(finalVerification: VerifierResult): DebateResult {
    const roundCount = this.rounds.length;

    const success =
      finalVerification.passed &&
      finalVerification.score >= this.config.qualityThreshold;

    let summary: string;
    if (success) {
      summary = `Debate completed successfully after ${roundCount} round(s) with a quality score of ${finalVerification.score}/100.`;
    } else if (this.config.abortSignal?.aborted) {
      summary = `Debate aborted after ${roundCount} round(s). Last score: ${finalVerification.score}/100.`;
    } else if (this.totalTokens >= this.config.totalTokenBudget) {
      summary = `Debate stopped: token budget exhausted after ${roundCount} round(s). Last score: ${finalVerification.score}/100.`;
    } else {
      const totalIssues = this.rounds.reduce((sum, r) => sum + r.issues.length, 0);
      summary = `Debate completed ${roundCount} round(s) but did not meet quality threshold (${this.config.qualityThreshold}). Final score: ${finalVerification.score}/100. Total issues found: ${totalIssues}.`;
    }

    return {
      success,
      rounds: this.rounds,
      finalScore: finalVerification.score,
      totalTokensUsed: this.totalTokens,
      changedFiles: [...this.changedFiles],
      summary,
    };
  }

  /**
   * Extract file paths mentioned in code output (e.g., "src/foo.ts").
   */
  private extractFilePaths(text: string): void {
    // Match common file path patterns
    const pathPattern = /(?:^|\s|`)((?:src|lib|app|test|packages)\/[\w./-]+\.\w+)/gm;
    let match: RegExpExecArray | null;
    while ((match = pathPattern.exec(text)) !== null) {
      const filePath = match[1];
      if (filePath && !filePath.startsWith("http") && !filePath.startsWith("//")) {
        this.changedFiles.add(filePath);
      }
    }
  }

  /** Reset per-role token usage counters */
  private resetRoleTokens(): void {
    this.roleTokens.coder = { input: 0, output: 0 };
    this.roleTokens.reviewer = { input: 0, output: 0 };
    this.roleTokens.verifier = { input: 0, output: 0 };
  }

  /** Truncate text to a maximum length */
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + "...";
  }

  // ─── Public Accessors ─────────────────────────────────────────

  /** Get the current total token usage */
  getTotalTokensUsed(): number {
    return this.totalTokens;
  }

  /** Get token usage broken down by role */
  getRoleTokenUsage(): Readonly<RoleTokenUsage> {
    return { ...this.roleTokens };
  }

  /** Get all rounds from the current/last debate */
  getRounds(): readonly DebateRound[] {
    return this.rounds;
  }

  /** Get the current config */
  getConfig(): Readonly<DebateConfig> {
    return { ...this.config };
  }

  // ─── Static Factory ───────────────────────────────────────────

  /**
   * Create a new DebateOrchestrator with the given config.
   *
   * @param config - Debate configuration (projectPath is required, rest have defaults)
   * @returns A new DebateOrchestrator instance
   */
  static create(
    config: Partial<DebateConfig> & { projectPath: string },
  ): DebateOrchestrator {
    return new DebateOrchestrator(config);
  }
}
