/**
 * @module speculative-executor
 * @description Speculative Execution — 2~3개의 서로 다른 접근법을 병렬로 시도하여
 * 최적의 결과를 선택하는 모듈.
 *
 * conservative(안전/최소 변경), aggressive(대담한 리팩토링),
 * creative(새로운 패러다임) 전략을 동시에 실행하고, 빌드·테스트·품질 점수로 승자를 결정한다.
 */

import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { BYOKClient } from "./llm-client.js";
import type { BYOKConfig, ToolExecutor, ToolCall } from "./types.js";

// ─── Interfaces ───

/** Speculative Execution 설정 */
export interface SpeculativeConfig {
  /** 최대 병렬 접근법 수 (기본 3) */
  maxApproaches: number;
  /** 접근법별 타임아웃 ms (기본 120_000) */
  approachTimeout: number;
  /** 최소 품질 점수 (0–100, 기본 60) */
  minQualityThreshold: number;
  /** BYOK 설정 (LLM 호출용) */
  byokConfig: BYOKConfig;
  /** 프로젝트 루트 경로 */
  projectPath: string;
}

/** 접근법 전략 유형 */
export type ApproachStrategy = "conservative" | "aggressive" | "creative";

/** 개별 접근법 */
export interface Approach {
  /** 고유 ID */
  id: string;
  /** 전략 유형 */
  strategy: ApproachStrategy;
  /** 접근법 설명 */
  description: string;
  /** 시스템 프롬프트에 추가할 델타 */
  systemPromptDelta: string;
}

/** 접근법 실행 결과 */
export interface ApproachResult {
  /** 해당 접근법 */
  approach: Approach;
  /** 성공 여부 */
  success: boolean;
  /** 변경된 파일 맵 (path → newContent) */
  changes: Map<string, string>;
  /** 빌드 통과 여부 */
  buildPassed: boolean;
  /** 테스트 통과 여부 */
  testPassed: boolean;
  /** 품질 점수 (0–100) */
  qualityScore: number;
  /** 사용된 토큰 수 */
  tokensUsed: number;
  /** 소요 시간 ms */
  durationMs: number;
  /** 실패 시 에러 메시지 */
  error?: string;
}

/** Speculative Execution 최종 결과 */
export interface SpeculativeResult {
  /** 선택된 최적 접근법 (없으면 null) */
  winner: ApproachResult | null;
  /** 모든 접근법 결과 */
  allResults: ApproachResult[];
  /** 승자 선택 사유 */
  selectionReason: string;
  /** 전체 접근법 합산 토큰 사용량 */
  totalTokensUsed: number;
  /** 실패한 접근법에서 얻은 학습 */
  learnings: string[];
}

// ─── Event Types ───

export interface SpeculativeExecutorEvents {
  "speculative:start": [payload: { goal: string; approachCount: number }];
  "speculative:approach:start": [payload: { approach: Approach }];
  "speculative:approach:complete": [payload: { result: ApproachResult }];
  "speculative:evaluation": [payload: { allResults: ApproachResult[]; winner: ApproachResult | null }];
  "speculative:complete": [payload: { result: SpeculativeResult }];
}

// ─── Constants ───

const DEFAULT_CONFIG: Omit<SpeculativeConfig, "byokConfig" | "projectPath"> = {
  maxApproaches: 3,
  approachTimeout: 120_000,
  minQualityThreshold: 60,
};

const APPROACH_GENERATION_PROMPT = `You are a senior software architect. Given a coding task, generate distinct approaches to solve it.

Each approach MUST be a different strategy:
- "conservative": Minimal changes, safe, follows existing patterns closely. Prefer small targeted edits.
- "aggressive": Bold refactor, may change interfaces/APIs, restructure modules. Aims for ideal architecture.
- "creative": Novel solution using a different paradigm/pattern than currently exists. Think outside the box.

Rules:
- Generate between 2 and {maxApproaches} approaches.
- Each approach must have a unique strategy type.
- The systemPromptDelta should give specific instructions to a coding agent about HOW to implement this approach.
- Keep descriptions concise but specific.

Return ONLY a JSON array (no markdown fences, no extra text):
[
  {
    "strategy": "conservative" | "aggressive" | "creative",
    "description": "What this approach does",
    "systemPromptDelta": "Additional system prompt instructions for this approach"
  }
]`;

const QUALITY_ASSESSMENT_PROMPT = `Rate the quality of these code changes on a scale of 0-10.

Consider:
- Code readability and clarity
- Error handling
- Following best practices
- Minimal unnecessary complexity

Changes:
{changes}

Return ONLY a JSON object: { "score": <0-10>, "reason": "brief reason" }`;

// ─── SpeculativeExecutor ───

/**
 * Speculative Execution 엔진.
 *
 * 2~3개의 서로 다른 접근법을 병렬로 시도하고,
 * 빌드/테스트/품질 점수를 기반으로 최적의 결과를 선택한다.
 *
 * @example
 * ```ts
 * const executor = new SpeculativeExecutor({
 *   maxApproaches: 3,
 *   approachTimeout: 120_000,
 *   minQualityThreshold: 60,
 *   byokConfig: { provider: "anthropic", apiKey: "sk-..." },
 *   projectPath: "/path/to/project",
 * });
 *
 * executor.on("speculative:complete", ({ result }) => {
 *   console.log("Winner:", result.winner?.approach.strategy);
 * });
 *
 * const result = await executor.execute("Add error handling to all API routes", toolExecutor);
 * ```
 */
export class SpeculativeExecutor extends EventEmitter<SpeculativeExecutorEvents> {
  private readonly config: SpeculativeConfig;
  private readonly llmClient: BYOKClient;

  constructor(config: SpeculativeConfig) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.llmClient = new BYOKClient(config.byokConfig);
  }

  /**
   * 리소스 정리. 내부 LLM 클라이언트를 해제하고 이벤트 리스너를 제거한다.
   */
  destroy(): void {
    this.llmClient.destroy();
    this.removeAllListeners();
  }

  /**
   * LLM을 사용하여 2~3개의 접근법을 생성한다.
   * @param goal 달성할 목표
   * @param codebaseContext 프로젝트 컨텍스트 (파일 구조, 기존 패턴 등)
   * @returns 생성된 접근법 목록
   */
  async generateApproaches(goal: string, codebaseContext: string): Promise<Approach[]> {
    const prompt = APPROACH_GENERATION_PROMPT.replace("{maxApproaches}", String(this.config.maxApproaches));

    const response = await this.llmClient.chat([
      { role: "system", content: prompt },
      {
        role: "user",
        content: `Task: ${goal}\n\nProject context:\n${codebaseContext}`,
      },
    ]);

    const content = response.content ?? "[]";
    let rawApproaches: Array<{
      strategy: ApproachStrategy;
      description: string;
      systemPromptDelta: string;
    }>;

    try {
      // Strip markdown code fences if present
      const cleaned = content.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
      rawApproaches = JSON.parse(cleaned);
    } catch {
      // Fallback: generate default approaches if LLM response is malformed
      rawApproaches = this.getDefaultApproaches(goal);
    }

    // Validate and cap at maxApproaches
    const approaches = rawApproaches
      .filter(
        (a) =>
          a.strategy &&
          a.description &&
          a.systemPromptDelta &&
          ["conservative", "aggressive", "creative"].includes(a.strategy),
      )
      .slice(0, this.config.maxApproaches)
      .map((a, idx) => ({
        id: `approach-${a.strategy}-${idx}`,
        strategy: a.strategy,
        description: a.description,
        systemPromptDelta: a.systemPromptDelta,
      }));

    // Ensure at least 2 approaches
    if (approaches.length < 2) {
      return this.getDefaultApproaches(goal).map((a, idx) => ({
        id: `approach-${a.strategy}-${idx}`,
        ...a,
      }));
    }

    return approaches;
  }

  /**
   * 단일 접근법을 실행한다.
   * ToolExecutor를 사용하여 도구 호출을 수행하고, 변경 사항을 추적한다.
   * @param approach 실행할 접근법
   * @param goal 달성할 목표
   * @param toolExecutor 도구 실행기
   * @returns 접근법 실행 결과
   */
  async executeApproach(
    approach: Approach,
    goal: string,
    toolExecutor: ToolExecutor,
  ): Promise<ApproachResult> {
    const startTime = Date.now();
    const changes = new Map<string, string>();
    let tokensUsed = 0;
    let buildPassed = false;
    let testPassed = false;

    try {
      // Build enhanced system prompt with approach delta
      const systemPrompt = [
        `You are an expert coding agent. Your goal: ${goal}`,
        "",
        `Strategy: ${approach.strategy}`,
        approach.systemPromptDelta,
        "",
        "Use the available tools to implement the changes. Track all file modifications.",
        `Project path: ${this.config.projectPath}`,
      ].join("\n");

      // Run agent loop for this approach using the LLM + tool executor
      const messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }> = [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Implement this task: ${goal}\n\nApproach: ${approach.description}` },
      ];

      const MAX_ITERATIONS = 15;
      let iteration = 0;

      while (iteration < MAX_ITERATIONS) {
        iteration++;

        const response = await this.llmClient.chat(messages, toolExecutor.definitions);
        tokensUsed += (response.usage.input + response.usage.output);

        // If no tool calls, the agent is done
        if (response.toolCalls.length === 0) {
          if (response.content) {
            messages.push({ role: "assistant", content: response.content });
          }
          break;
        }

        // Process tool calls
        messages.push({
          role: "assistant",
          content: response.content,
          tool_calls: response.toolCalls,
        });

        for (const toolCall of response.toolCalls) {
          const result = await toolExecutor.execute(toolCall);
          messages.push({
            role: "tool",
            content: result.output,
            tool_call_id: toolCall.id,
          });

          // Track file changes from write/edit tools
          this.trackFileChanges(toolCall, result.output, changes);
        }
      }

      // Verify build
      buildPassed = await this.verifyBuild(toolExecutor);

      // Verify tests
      testPassed = await this.verifyTests(toolExecutor);

      // Calculate quality score
      const qualityScore = await this.calculateQualityScore(
        changes,
        buildPassed,
        testPassed,
        tokensUsed,
      );

      const durationMs = Date.now() - startTime;

      return {
        approach,
        success: buildPassed,
        changes,
        buildPassed,
        testPassed,
        qualityScore,
        tokensUsed,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);

      return {
        approach,
        success: false,
        changes,
        buildPassed,
        testPassed,
        qualityScore: 0,
        tokensUsed,
        durationMs,
        error: errorMessage,
      };
    }
  }

  /**
   * 모든 접근법 결과를 평가하여 최적의 결과를 선택한다.
   *
   * 평가 기준 (가중치 순서):
   * 1. buildPassed (+40점)
   * 2. testPassed (+30점)
   * 3. 변경 파일 수가 적을수록 (+10점)
   * 4. 토큰 사용량이 적을수록 (+10점)
   * 5. LLM 품질 평가 (+10점)
   *
   * @param results 모든 접근법 결과
   * @returns 최적 결과 (모두 기준 미달이면 null)
   */
  evaluateResults(results: ApproachResult[]): ApproachResult | null {
    const validResults = results.filter(
      (r) => r.success && r.qualityScore >= this.config.minQualityThreshold,
    );

    if (validResults.length === 0) {
      // Fallback: pick any result that at least built
      const builtResults = results.filter((r) => r.buildPassed);
      if (builtResults.length === 0) return null;
      return builtResults.sort((a, b) => b.qualityScore - a.qualityScore)[0];
    }

    // Sort by composite score (higher is better)
    validResults.sort((a, b) => {
      const scoreA = this.compositeScore(a, results);
      const scoreB = this.compositeScore(b, results);
      return scoreB - scoreA;
    });

    return validResults[0];
  }

  /**
   * 메인 실행 메서드. 접근법 생성 → 병렬 실행 → 평가 → 최적 결과 반환.
   * @param goal 달성할 목표
   * @param toolExecutor 도구 실행기
   * @param codebaseContext 프로젝트 컨텍스트 (선택)
   * @returns Speculative Execution 결과
   */
  async execute(
    goal: string,
    toolExecutor: ToolExecutor,
    codebaseContext?: string,
  ): Promise<SpeculativeResult> {
    const context = codebaseContext ?? "";

    // 1. Generate approaches
    const approaches = await this.generateApproaches(goal, context);

    this.emit("speculative:start", { goal, approachCount: approaches.length });

    // 2. Execute approaches SEQUENTIALLY with git-based isolation.
    //    Each approach runs on a clean working tree; changes are stashed
    //    after execution so subsequent approaches start from the same baseline.
    const allSettled: PromiseSettledResult<ApproachResult>[] = [];

    for (const approach of approaches) {
      this.emit("speculative:approach:start", { approach });

      // Snapshot: stash any uncommitted changes so each approach starts clean
      const stashLabel = `yuan-speculative-${approach.id}-${Date.now()}`;
      try {
        execSync("git stash push -u -q -m " + JSON.stringify(stashLabel), {
          cwd: this.config.projectPath,
          encoding: "utf-8",
          timeout: 10_000,
        });
      } catch {
        // Not a git repo or nothing to stash — continue
      }

      try {
        const result = await this.withTimeout(
          this.executeApproach(approach, goal, toolExecutor),
          this.config.approachTimeout,
          approach,
        );

        // Capture file changes from the working tree into the result
        this.emit("speculative:approach:complete", { result });

        // Restore baseline: discard approach's filesystem changes, keep result in memory
        try {
          execSync("git checkout -- . && git clean -fd -q", {
            cwd: this.config.projectPath,
            encoding: "utf-8",
            timeout: 10_000,
          });
        } catch {
          // best-effort cleanup
        }

        allSettled.push({ status: "fulfilled", value: result });
      } catch (err) {
        // Restore baseline on failure too
        try {
          execSync("git checkout -- . && git clean -fd -q", {
            cwd: this.config.projectPath,
            encoding: "utf-8",
            timeout: 10_000,
          });
        } catch {
          // best-effort cleanup
        }

        allSettled.push({
          status: "rejected",
          reason: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    const settledResults = allSettled;

    const allResults: ApproachResult[] = settledResults.map((settled, idx) => {
      if (settled.status === "fulfilled") {
        return settled.value;
      }

      // Rejected — create a failed result
      return {
        approach: approaches[idx],
        success: false,
        changes: new Map<string, string>(),
        buildPassed: false,
        testPassed: false,
        qualityScore: 0,
        tokensUsed: 0,
        durationMs: 0,
        error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
      };
    });

    // 3. Evaluate and pick winner
    const winner = this.evaluateResults(allResults);

    this.emit("speculative:evaluation", { allResults, winner });

    // 4. Extract learnings from failed approaches
    const learnings = this.extractLearnings(allResults, winner);

    // 5. Build final result
    const totalTokensUsed = allResults.reduce((sum, r) => sum + r.tokensUsed, 0);

    const selectionReason = winner
      ? this.buildSelectionReason(winner, allResults)
      : "No approach met the minimum quality threshold.";

    const result: SpeculativeResult = {
      winner,
      allResults,
      selectionReason,
      totalTokensUsed,
      learnings,
    };

    this.emit("speculative:complete", { result });

    return result;
  }

  // ─── Private Helpers ───

  /**
   * 도구 호출에서 파일 변경을 추적한다.
   */
  private trackFileChanges(
    toolCall: ToolCall,
    _output: string,
    changes: Map<string, string>,
  ): void {
    const args =
      typeof toolCall.arguments === "string"
        ? this.safeParseJSON(toolCall.arguments)
        : toolCall.arguments;

    if (!args) return;

    const name = toolCall.name;
    const record = args as Record<string, unknown>;
    const filePath = typeof record["file_path"] === "string" ? record["file_path"] : undefined;
    const content = typeof record["content"] === "string" ? record["content"] : undefined;

    if (name === "file_write" && filePath && content) {
      changes.set(filePath, content);
    } else if (name === "file_edit" && filePath) {
      // For edits, we mark the file as changed but can't track full content
      const existing = changes.get(filePath) ?? "[edited]";
      changes.set(filePath, existing);
    }
  }

  /**
   * 빌드 검증 — shell_exec로 tsc --noEmit 실행.
   */
  private async verifyBuild(toolExecutor: ToolExecutor): Promise<boolean> {
    try {
      const buildCall: ToolCall = {
        id: `verify-build-${Date.now()}`,
        name: "shell_exec",
        arguments: {
          command: "npx tsc --noEmit",
          cwd: this.config.projectPath,
        },
      };
      const result = await toolExecutor.execute(buildCall);
      return result.success;
    } catch {
      return false;
    }
  }

  /**
   * 테스트 검증 — shell_exec로 테스트 실행.
   */
  private async verifyTests(toolExecutor: ToolExecutor): Promise<boolean> {
    try {
      const testCall: ToolCall = {
        id: `verify-test-${Date.now()}`,
        name: "shell_exec",
        arguments: {
          command: "npm test --if-present 2>/dev/null || true",
          cwd: this.config.projectPath,
        },
      };
      const result = await toolExecutor.execute(testCall);
      return result.success;
    } catch {
      return false;
    }
  }

  /**
   * 품질 점수 계산 (0–100).
   *
   * - buildPassed: +40
   * - testPassed: +30
   * - 변경 파일 수 적을수록: +10
   * - 토큰 효율: +10
   * - LLM 품질 평가: +10
   */
  private async calculateQualityScore(
    changes: Map<string, string>,
    buildPassed: boolean,
    testPassed: boolean,
    tokensUsed: number,
  ): Promise<number> {
    let score = 0;

    // Build: +40
    if (buildPassed) score += 40;

    // Tests: +30
    if (testPassed) score += 30;

    // Fewer files changed: +10 (10 for 1 file, 5 for 5+, linear scale)
    const fileCount = changes.size;
    score += Math.max(0, Math.round(10 * (1 - Math.min(fileCount, 10) / 10)));

    // Token efficiency: +10 (fewer tokens = higher score)
    // Baseline: 50k tokens = 0, 0 tokens = 10
    const tokenScore = Math.max(0, Math.round(10 * (1 - Math.min(tokensUsed, 50_000) / 50_000)));
    score += tokenScore;

    // LLM quality assessment: +10
    score += await this.llmQualityAssessment(changes);

    return Math.min(100, score);
  }

  /**
   * LLM에 코드 변경 품질 평가 요청 (0–10점 → 0–10 범위).
   */
  private async llmQualityAssessment(changes: Map<string, string>): Promise<number> {
    if (changes.size === 0) return 0;

    try {
      // Summarize changes for evaluation (cap at 4000 chars to save tokens)
      const changeSummary = Array.from(changes.entries())
        .map(([path, content]) => {
          const truncated = content.length > 500 ? content.slice(0, 500) + "..." : content;
          return `--- ${path} ---\n${truncated}`;
        })
        .join("\n\n")
        .slice(0, 4000);

      const prompt = QUALITY_ASSESSMENT_PROMPT.replace("{changes}", changeSummary);

      const response = await this.llmClient.chat([
        { role: "user", content: prompt },
      ]);

      const content = response.content ?? "{}";
      const cleaned = content.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
      const parsed = JSON.parse(cleaned) as { score?: number };
      const rawScore = typeof parsed.score === "number" ? parsed.score : 5;
      return Math.min(10, Math.max(0, Math.round(rawScore)));
    } catch {
      // Default score if LLM assessment fails
      return 5;
    }
  }

  /**
   * 복합 점수 계산 (평가 정렬용).
   */
  private compositeScore(result: ApproachResult, allResults: ApproachResult[]): number {
    let score = result.qualityScore;

    // Bonus for build passing
    if (result.buildPassed) score += 40;

    // Bonus for tests passing
    if (result.testPassed) score += 30;

    // Token efficiency bonus (relative to other approaches)
    const maxTokens = Math.max(...allResults.map((r) => r.tokensUsed), 1);
    const tokenEfficiency = 1 - result.tokensUsed / maxTokens;
    score += tokenEfficiency * 10;

    // Fewer changes bonus
    const maxChanges = Math.max(...allResults.map((r) => r.changes.size), 1);
    const changeEfficiency = 1 - result.changes.size / maxChanges;
    score += changeEfficiency * 10;

    return score;
  }

  /**
   * 실패한 접근법에서 학습 포인트를 추출한다.
   */
  private extractLearnings(
    allResults: ApproachResult[],
    winner: ApproachResult | null,
  ): string[] {
    const learnings: string[] = [];

    for (const result of allResults) {
      if (result === winner) continue;

      if (result.error) {
        learnings.push(
          `[${result.approach.strategy}] Failed: ${result.error}`,
        );
      } else if (!result.buildPassed) {
        learnings.push(
          `[${result.approach.strategy}] Build failed — approach "${result.approach.description}" may have structural issues.`,
        );
      } else if (!result.testPassed) {
        learnings.push(
          `[${result.approach.strategy}] Tests failed — regression detected.`,
        );
      } else if (result.qualityScore < this.config.minQualityThreshold) {
        learnings.push(
          `[${result.approach.strategy}] Quality score ${result.qualityScore} below threshold ${this.config.minQualityThreshold}.`,
        );
      }
    }

    return learnings;
  }

  /**
   * 승자 선택 이유를 생성한다.
   */
  private buildSelectionReason(
    winner: ApproachResult,
    allResults: ApproachResult[],
  ): string {
    const parts: string[] = [
      `Selected "${winner.approach.strategy}" approach.`,
    ];

    if (winner.buildPassed) parts.push("Build passed.");
    if (winner.testPassed) parts.push("Tests passed.");
    parts.push(`Quality score: ${winner.qualityScore}/100.`);
    parts.push(`Files changed: ${winner.changes.size}.`);
    parts.push(`Tokens used: ${winner.tokensUsed}.`);

    const otherCount = allResults.filter((r) => r !== winner).length;
    parts.push(`Evaluated against ${otherCount} other approach(es).`);

    return parts.join(" ");
  }

  /**
   * Promise에 타임아웃을 적용한다.
   */
  private async withTimeout(
    promise: Promise<ApproachResult>,
    timeoutMs: number,
    approach: Approach,
  ): Promise<ApproachResult> {
    return new Promise<ApproachResult>((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          approach,
          success: false,
          changes: new Map<string, string>(),
          buildPassed: false,
          testPassed: false,
          qualityScore: 0,
          tokensUsed: 0,
          durationMs: timeoutMs,
          error: `Approach timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);

      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          resolve({
            approach,
            success: false,
            changes: new Map<string, string>(),
            buildPassed: false,
            testPassed: false,
            qualityScore: 0,
            tokensUsed: 0,
            durationMs: 0,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    });
  }

  /**
   * LLM이 유효한 접근법을 생성하지 못했을 때 사용하는 기본 접근법.
   */
  private getDefaultApproaches(
    goal: string,
  ): Array<{ strategy: ApproachStrategy; description: string; systemPromptDelta: string }> {
    return [
      {
        strategy: "conservative",
        description: `Make minimal, safe changes to achieve: ${goal}`,
        systemPromptDelta:
          "Make the smallest possible changes. Follow existing code patterns exactly. " +
          "Do not refactor or reorganize. Keep the same interfaces and APIs.",
      },
      {
        strategy: "aggressive",
        description: `Refactor and restructure to best achieve: ${goal}`,
        systemPromptDelta:
          "Feel free to refactor, rename, and restructure code for the ideal solution. " +
          "Improve interfaces and APIs if it leads to better code. Be thorough.",
      },
    ];
  }

  /**
   * 안전한 JSON 파싱 (실패 시 null 반환).
   */
  private safeParseJSON(str: string): Record<string, unknown> | null {
    try {
      return JSON.parse(str) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
