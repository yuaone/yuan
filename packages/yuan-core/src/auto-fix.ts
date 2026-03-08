/**
 * @module auto-fix
 * @description 자동 수정 루프 — 도구 실행 결과를 검증하고, 실패 시 자동 수정 시도.
 *
 * 플로우:
 * 1. 도구 실행 결과 수신
 * 2. 결과 검증 (lint 에러, 빌드 에러, 타입 에러 등)
 * 3. 실패 시 → 에러 메시지를 LLM에 피드백할 프롬프트 생성
 * 4. LLM이 수정 제안 → 도구 재실행
 * 5. 최대 maxRetries 반복 후 포기
 *
 * @see 설계 문서 Section 6.4
 */

import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";

// ─── Interfaces ───

/** 자동 수정 루프 설정 */
export interface AutoFixConfig {
  /** 최대 수정 시도 횟수 (기본 3) */
  maxRetries: number;
  /** file_write/edit 후 자동 lint 실행 */
  autoLint: boolean;
  /** 변경 후 자동 테스트 (Phase 1b) */
  autoTest: boolean;
  /** 변경 후 자동 빌드 체크 */
  autoBuild: boolean;
}

/** 검증 결과 */
export interface ValidationResult {
  /** 검증 통과 여부 */
  passed: boolean;
  /** 실패한 검증 항목 */
  failures: ValidationFailure[];
}

/** 검증 실패 항목 */
export interface ValidationFailure {
  /** 검증 종류 */
  type: AutoFixTrigger;
  /** 에러 메시지 */
  message: string;
  /** 관련 파일 경로 */
  file?: string;
  /** 관련 라인 번호 */
  line?: number;
  /** 원본 명령 출력 */
  rawOutput: string;
}

/** 자동 수정 트리거 유형 */
export type AutoFixTrigger =
  | "BUILD_FAIL"
  | "TEST_FAIL"
  | "LINT_ERROR"
  | "RUNTIME_ERROR"
  | "TYPE_ERROR"
  | "IMPORT_ERROR";

/** 수정 시도 기록 */
export interface FixAttempt {
  /** 시도 번호 (1-based) */
  iteration: number;
  /** 발생한 에러 */
  error: string;
  /** 수정 내용 설명 */
  fix: string;
  /** 수정 성공 여부 */
  success: boolean;
  /** 소요 시간 (ms) */
  durationMs: number;
}

/** lint 실행 결과 */
export interface LintResult {
  /** 성공 여부 */
  passed: boolean;
  /** 에러 수 */
  errorCount: number;
  /** 경고 수 */
  warningCount: number;
  /** 원본 출력 */
  output: string;
}

/** 빌드 체크 결과 */
export interface BuildResult {
  /** 성공 여부 */
  passed: boolean;
  /** 에러 수 */
  errorCount: number;
  /** 원본 출력 */
  output: string;
}

/** 기본 자동 수정 설정 */
export const DEFAULT_AUTO_FIX_CONFIG: AutoFixConfig = {
  maxRetries: 3,
  autoLint: true,
  autoTest: false, // Phase 1b
  autoBuild: true,
};

// ─── AutoFixLoop ───

/**
 * AutoFixLoop — 도구 실행 결과를 검증하고 자동 수정 루프를 관리.
 *
 * 이 클래스 자체는 LLM을 호출하지 않는다.
 * 검증 실패 시 LLM에 피드백할 프롬프트를 생성하고,
 * AgentLoop이 해당 프롬프트를 LLM에 전달하여 수정 도구 호출을 받는다.
 *
 * @example
 * ```typescript
 * const autoFix = new AutoFixLoop({ maxRetries: 3, autoLint: true, autoBuild: true, autoTest: false });
 *
 * // 도구 실행 후 검증
 * const validation = await autoFix.validateResult('file_write', result, '/project');
 * if (!validation.passed) {
 *   const fixPrompt = autoFix.buildFixPrompt(
 *     validation.failures[0].message,
 *     'Writing component file'
 *   );
 *   // fixPrompt를 LLM에 전달 → 수정 도구 호출 수신
 * }
 * ```
 */
export class AutoFixLoop {
  private readonly config: AutoFixConfig;
  private readonly attempts: FixAttempt[] = [];

  constructor(config?: Partial<AutoFixConfig>) {
    this.config = { ...DEFAULT_AUTO_FIX_CONFIG, ...config };
  }

  /**
   * 도구 실행 결과를 검증.
   * file_write/file_edit 후에는 lint/빌드 체크를 자동 실행한다.
   *
   * @param toolName 실행된 도구 이름
   * @param toolOutput 도구 실행 결과 출력
   * @param success 도구 실행 성공 여부
   * @param workDir 프로젝트 루트 경로
   * @returns 검증 결과
   */
  async validateResult(
    toolName: string,
    toolOutput: string,
    success: boolean,
    workDir: string,
  ): Promise<ValidationResult> {
    const failures: ValidationFailure[] = [];

    // 도구 실행 자체가 실패한 경우
    if (!success) {
      const trigger = this.classifyError(toolOutput);
      failures.push({
        type: trigger,
        message: toolOutput,
        rawOutput: toolOutput,
      });
      return { passed: false, failures };
    }

    // file_write / file_edit 후 검증
    if (["file_write", "file_edit"].includes(toolName)) {
      // 자동 lint
      if (this.config.autoLint) {
        const lintResult = await this.runLint(workDir);
        if (!lintResult.passed) {
          failures.push({
            type: "LINT_ERROR",
            message: `Lint failed with ${lintResult.errorCount} error(s)`,
            rawOutput: lintResult.output,
          });
        }
      }

      // 자동 빌드 체크
      if (this.config.autoBuild) {
        const buildResult = await this.runBuildCheck(workDir);
        if (!buildResult.passed) {
          failures.push({
            type: this.isBuildTypeError(buildResult.output)
              ? "TYPE_ERROR"
              : "BUILD_FAIL",
            message: `Build check failed with ${buildResult.errorCount} error(s)`,
            rawOutput: buildResult.output,
          });
        }
      }
    }

    // shell_exec 결과에서 에러 감지
    if (toolName === "shell_exec" && success) {
      const shellErrors = this.detectShellErrors(toolOutput);
      failures.push(...shellErrors);
    }

    return {
      passed: failures.length === 0,
      failures,
    };
  }

  /**
   * 실패 시 LLM에 피드백할 수정 프롬프트를 생성.
   *
   * @param error 에러 메시지
   * @param context 현재 작업 컨텍스트
   * @returns LLM에 전달할 프롬프트 문자열
   */
  buildFixPrompt(error: string, context: string): string {
    const attemptNum = this.attempts.length + 1;
    const maxRetries = this.config.maxRetries;

    let prompt =
      `[AUTO-FIX ${attemptNum}/${maxRetries}] The previous action resulted in an error.\n\n`;

    prompt += `## Error\n\`\`\`\n${this.truncateOutput(error, 2000)}\n\`\`\`\n\n`;

    prompt += `## Context\n${context}\n\n`;

    prompt += `## Instructions\n`;
    prompt += `- Analyze the error and fix the issue.\n`;
    prompt += `- Make minimal, targeted changes to resolve the error.\n`;
    prompt += `- Do not introduce new functionality or refactoring.\n`;

    if (attemptNum > 1) {
      prompt += `\n## Previous Attempts\n`;
      for (const attempt of this.attempts) {
        prompt += `- Attempt ${attempt.iteration}: ${attempt.fix} → ${attempt.success ? "OK" : "FAILED"}\n`;
      }
      prompt += `\nAvoid repeating the same fix. Try a different approach.\n`;
    }

    if (attemptNum >= maxRetries) {
      prompt +=
        `\nThis is the LAST attempt. If this fix doesn't work, the error will be reported to the user.\n`;
    }

    return prompt;
  }

  /**
   * 수정 시도를 기록.
   * @param error 에러 메시지
   * @param fix 수정 내용 설명
   * @param success 수정 성공 여부
   * @param durationMs 소요 시간
   */
  recordAttempt(
    error: string,
    fix: string,
    success: boolean,
    durationMs: number,
  ): void {
    this.attempts.push({
      iteration: this.attempts.length + 1,
      error,
      fix,
      success,
      durationMs,
    });
  }

  /**
   * 남은 수정 시도 횟수를 반환.
   */
  getRemainingRetries(): number {
    return Math.max(0, this.config.maxRetries - this.attempts.length);
  }

  /**
   * 수정 시도를 더 할 수 있는지 반환.
   */
  canRetry(): boolean {
    return this.getRemainingRetries() > 0;
  }

  /**
   * 수정 시도 기록을 반환.
   */
  getAttempts(): readonly FixAttempt[] {
    return this.attempts;
  }

  /**
   * 수정 시도 기록을 초기화 (새 도구 호출 시작 시).
   */
  resetAttempts(): void {
    this.attempts.length = 0;
  }

  /**
   * 현재 설정을 반환.
   */
  getConfig(): Readonly<AutoFixConfig> {
    return { ...this.config };
  }

  /**
   * 프로젝트에서 lint를 실행.
   * 순서: eslint → npx tsc --noEmit (lint 대체)
   * @param workDir 프로젝트 루트 경로
   */
  async runLint(workDir: string): Promise<LintResult> {
    // eslint 먼저 시도
    const hasEslint = await this.fileExists(
      path.join(workDir, "node_modules/.bin/eslint"),
    );

    if (hasEslint) {
      const result = await this.exec("npx", ["eslint", ".", "--quiet"], workDir);
      const errorCount = (result.output.match(/\d+ error/g) || []).length;
      return {
        passed: result.exitCode === 0,
        errorCount: result.exitCode === 0 ? 0 : Math.max(1, errorCount),
        warningCount: 0,
        output: result.output,
      };
    }

    // eslint 없으면 tsc --noEmit으로 대체
    return this.runTscCheck(workDir);
  }

  /**
   * 프로젝트에서 빌드 체크 (tsc --noEmit) 를 실행.
   * @param workDir 프로젝트 루트 경로
   */
  async runBuildCheck(workDir: string): Promise<BuildResult> {
    const result = await this.runTscCheck(workDir);
    return {
      passed: result.passed,
      errorCount: result.errorCount,
      output: result.output,
    };
  }

  // ─── Private ───

  private async runTscCheck(
    workDir: string,
  ): Promise<LintResult> {
    const hasTsc = await this.fileExists(
      path.join(workDir, "node_modules/.bin/tsc"),
    );

    if (!hasTsc) {
      // tsc 없으면 검증 통과 (검증 불가)
      return { passed: true, errorCount: 0, warningCount: 0, output: "" };
    }

    const result = await this.exec(
      "npx",
      ["tsc", "--noEmit", "--pretty"],
      workDir,
    );

    const errorMatch = result.output.match(/Found (\d+) error/);
    const errorCount = errorMatch ? parseInt(errorMatch[1], 10) : 0;

    return {
      passed: result.exitCode === 0,
      errorCount: result.exitCode === 0 ? 0 : Math.max(1, errorCount),
      warningCount: 0,
      output: result.output,
    };
  }

  private classifyError(output: string): AutoFixTrigger {
    const lower = output.toLowerCase();

    if (lower.includes("type") && lower.includes("error")) {
      return "TYPE_ERROR";
    }
    if (
      lower.includes("cannot find module") ||
      lower.includes("import") ||
      lower.includes("require")
    ) {
      return "IMPORT_ERROR";
    }
    if (lower.includes("lint")) {
      return "LINT_ERROR";
    }
    if (lower.includes("test")) {
      return "TEST_FAIL";
    }
    if (
      lower.includes("build") ||
      lower.includes("compile") ||
      lower.includes("tsc")
    ) {
      return "BUILD_FAIL";
    }
    return "RUNTIME_ERROR";
  }

  private isBuildTypeError(output: string): boolean {
    return /TS\d{4}:/.test(output) || /type.*error/i.test(output);
  }

  private detectShellErrors(output: string): ValidationFailure[] {
    const failures: ValidationFailure[] = [];

    // TypeScript 에러 감지
    const tsErrors = output.match(/error TS\d+:.+/g);
    if (tsErrors && tsErrors.length > 0) {
      failures.push({
        type: "TYPE_ERROR",
        message: `TypeScript: ${tsErrors.length} error(s) detected`,
        rawOutput: tsErrors.join("\n"),
      });
    }

    // ESLint 에러 감지
    if (/\d+ error/.test(output) && /eslint/i.test(output)) {
      failures.push({
        type: "LINT_ERROR",
        message: "ESLint errors detected",
        rawOutput: output,
      });
    }

    return failures;
  }

  private truncateOutput(output: string, maxLength: number): string {
    if (output.length <= maxLength) return output;
    const half = Math.floor(maxLength / 2);
    return (
      output.slice(0, half) +
      "\n... [truncated] ...\n" +
      output.slice(-half)
    );
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private exec(
    executable: string,
    args: string[],
    cwd: string,
  ): Promise<{ exitCode: number; output: string }> {
    return new Promise((resolve) => {
      execFile(
        executable,
        args,
        {
          cwd,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, FORCE_COLOR: "0" },
        },
        (error, stdout, stderr) => {
          const exitCode = error && "code" in error ? (error.code as number) ?? 1 : 0;
          resolve({
            exitCode: typeof exitCode === "number" ? exitCode : 1,
            output: (stdout + "\n" + stderr).trim(),
          });
        },
      );
    });
  }
}
