/**
 * @module governor
 * @description 실행 제한 및 안전 검증 엔진.
 * 반복 횟수 제한, 토큰 추적, 위험 작업 판별, 민감 파일 차단.
 */

import { EventEmitter } from "node:events";
import type { PlanLimits, PlanTier, ToolCall } from "./types.js";
import { PLAN_LIMITS } from "./constants.js";
import {
  DANGEROUS_PATTERNS,
  SENSITIVE_FILE_PATTERNS,
} from "./security.js";
import { PlanLimitError, ApprovalRequiredError } from "./errors.js";

/** Governor 설정 */
export interface GovernorConfig {
  /** 현재 사용자의 플랜 티어 */
  planTier: PlanTier;
  /** 자동 승인할 액션 (이 목록의 액션은 승인 없이 실행) */
  autoApproveActions?: string[];
  /** 커스텀 제한값 오버라이드 */
  customLimits?: Partial<PlanLimits>;
}

/** Governor 상태 (현재 세션 추적) */
export interface GovernorState {
  iterationCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  toolCallCount: number;
  startedAt: number;
}

/**
 * Governor — 에이전트 실행의 안전 장치.
 *
 * 역할:
 * - 반복 횟수 제한 (maxIterations)
 * - 토큰 사용량 추적 (tokensPerRequest)
 * - 위험 명령어 감지 (DANGEROUS_PATTERNS)
 * - 민감 파일 접근 차단 (SENSITIVE_FILE_PATTERNS)
 * - 세션 TTL 검증
 */
export class Governor extends EventEmitter {
  private readonly limits: PlanLimits;
  private readonly autoApproveActions: Set<string>;
  private readonly state: GovernorState;
  /**
   * iteration 카운터 초기화
   */
  resetIteration(): void {
    this.state.iterationCount = 0;
  }

  /**
   * 세션 복원 시 iteration 카운터 설정
   */
  restoreIteration(iteration: number): void {
    if (Number.isFinite(iteration) && iteration >= 0) {
      this.state.iterationCount = iteration;
    }
  }
  constructor(config: GovernorConfig) {
    super();
    this.limits = {
      ...PLAN_LIMITS[config.planTier],
      ...config.customLimits,
    };
    this.autoApproveActions = new Set(config.autoApproveActions ?? []);
    this.state = {
      iterationCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      toolCallCount: 0,
      startedAt: Date.now(),
    };
  }

  /**
   * 새 iteration 시작 전 검증.
   * 반복 횟수/토큰/TTL 초과 시 PlanLimitError를 던진다.
   */
  checkIteration(): void {
    // 반복 횟수 제한
    if (this.state.iterationCount >= this.limits.maxIterations) {
      throw new PlanLimitError(
        "maxIterations",
        this.state.iterationCount,
        this.limits.maxIterations,
      );
    }

    // 토큰 제한
    const totalTokens =
      this.state.totalInputTokens + this.state.totalOutputTokens;
    if (totalTokens >= this.limits.tokensPerRequest) {
      throw new PlanLimitError(
        "tokensPerRequest",
        totalTokens,
        this.limits.tokensPerRequest,
      );
    }

    // 세션 TTL
    const elapsed = Date.now() - this.state.startedAt;
    if (elapsed >= this.limits.sessionTtlMs) {
      throw new PlanLimitError(
        "sessionTtl",
        elapsed,
        this.limits.sessionTtlMs,
      );
    }
  }

  /**
   * iteration 완료 후 상태 업데이트.
   * @param inputTokens 이번 iteration에서 사용한 input 토큰
   * @param outputTokens 이번 iteration에서 사용한 output 토큰
   */
  recordIteration(inputTokens: number, outputTokens: number): void {
    this.state.iterationCount++;
    this.state.totalInputTokens += inputTokens;
    this.state.totalOutputTokens += outputTokens;
  }

  /**
   * 도구 호출이 안전한지 검증.
   * 위험한 명령어나 민감 파일 접근 시 ApprovalRequiredError를 던진다.
   * @param toolCall 검증할 도구 호출
   */
  validateToolCall(toolCall: ToolCall): void {
    this.state.toolCallCount++;

    const args = this.parseArgs(toolCall.arguments);

    // shell_exec 위험 명령어 검사
    if (toolCall.name === "shell_exec") {
      this.checkDangerousCommand(args);
    }

    // 파일 관련 도구: 민감 파일 접근 검사
    if (
      ["file_read", "file_write", "file_edit"].includes(toolCall.name)
    ) {
      const filePath = (args.path as string) ?? (args.file as string) ?? "";
      this.checkSensitiveFile(filePath, toolCall.name);
    }
  }

  /**
   * 현재 Governor 상태를 반환.
   */
  getState(): Readonly<GovernorState> {
    return { ...this.state };
  }

  /**
   * 현재 적용 중인 제한값을 반환.
   */
  getLimits(): Readonly<PlanLimits> {
    return { ...this.limits };
  }

  /**
   * 남은 iteration 수를 반환.
   */
  getRemainingIterations(): number {
    return Math.max(0, this.limits.maxIterations - this.state.iterationCount);
  }

  /**
   * 남은 토큰 예산을 반환.
   */
  getRemainingTokens(): number {
    const used =
      this.state.totalInputTokens + this.state.totalOutputTokens;
    return Math.max(0, this.limits.tokensPerRequest - used);
  }

  // ─── Private ───

  private parseArgs(
    args: string | Record<string, unknown>,
  ): Record<string, unknown> {
    if (typeof args === "string") {
      try {
  const parsed = JSON.parse(args);
  if (typeof parsed === "object" && parsed !== null) {
    return parsed as Record<string, unknown>;
  }
  return { raw: args };
      } catch {
        return { raw: args };
      }
    }
    return args;
  }

  private checkDangerousCommand(args: Record<string, unknown>): void {
    const command = String(args.command ?? args.cmd ?? "");
    const executable = String(args.executable ?? "");
    // Include args array in the full command string for pattern matching
    const argsArr = Array.isArray(args.args) ? (args.args as string[]).join(" ") : "";
    const fullCmd = `${executable} ${argsArr} ${command}`.trim();

    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(fullCmd)) {
        if (this.autoApproveActions.has("RUN_DANGEROUS_CMD")) {
          this.emit("warning", {
            type: "dangerous_command",
            command: fullCmd,
            pattern: pattern.source,
          });
          return;
        }
        throw new ApprovalRequiredError(
          "RUN_DANGEROUS_CMD",
          `Dangerous command detected: ${fullCmd} (matches ${pattern.source})`,
        );
      }
    }
  }

  private checkSensitiveFile(filePath: string, toolName: string): void {
    for (const pattern of SENSITIVE_FILE_PATTERNS) {
      if (pattern.test(filePath)) {
        // file_read은 경고만, file_write/edit는 차단
        if (toolName === "file_read") {
          this.emit("warning", {
            type: "sensitive_file_read",
            path: filePath,
            pattern: pattern.source,
          });
          return;
        }
        throw new ApprovalRequiredError(
          "MODIFY_CONFIG",
          `Sensitive file access: ${filePath} (matches ${pattern.source})`,
        );
      }
    }
  }
}
