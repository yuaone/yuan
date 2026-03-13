/**
 * @module errors
 * @description YUAN Agent 에러 클래스 계층
 */

/**
 * YUAN 에러 기본 클래스.
 * 모든 YUAN 에러는 이 클래스를 상속한다.
 */
export class YuanError extends Error {
  /** 에러 코드 (머신-리더블) */
  public readonly code: string;

  constructor(message: string, code = "YUAN_ERROR") {
    super(message);
    this.name = new.target.name;
    this.code = code;
    // V8 stack trace 보존
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * 도구 실행 실패 에러.
 * file_read, shell_exec 등 도구 실행 중 발생.
 */
export class ToolError extends YuanError {
  /** 실패한 도구 이름 */
  public readonly toolName: string;

  constructor(toolName: string, message: string) {
    super(`Tool '${toolName}' failed: ${message}`, "TOOL_ERROR");
    this.name = "ToolError";
    this.toolName = toolName;
  }
}

/**
 * LLM API 호출 실패 에러.
 * OpenAI, Anthropic, Google API 호출 중 발생.
 */
export class LLMError extends YuanError {
  /** LLM 프로바이더 */
  public readonly provider: string;
  /** HTTP 상태 코드 (있으면) */
  public readonly statusCode?: number;

  constructor(provider: string, message: string, statusCode?: number) {
    super(`LLM (${provider}) error: ${message}`, "LLM_ERROR");
    this.name = "LLMError";
    this.provider = provider;
    this.statusCode = statusCode;
  }
}

/**
 * 컨텍스트 윈도우 초과 에러.
 * 토큰 수가 모델의 컨텍스트 윈도우를 초과할 때 발생.
 */
export class ContextOverflowError extends YuanError {
  /** 현재 토큰 수 */
  public readonly currentTokens: number;
  /** 최대 토큰 수 */
  public readonly maxTokens: number;

  constructor(currentTokens: number, maxTokens: number) {
    super(
      `Context overflow: ${currentTokens} tokens exceeds limit of ${maxTokens}`,
      "CONTEXT_OVERFLOW",
    );
    this.name = "ContextOverflowError";
    this.currentTokens = currentTokens;
    this.maxTokens = maxTokens;
  }
}

/**
 * 플랜 제한 초과 에러.
 * 일일 실행 횟수, 토큰 한도 등 플랜별 제한 초과 시 발생.
 */
export class PlanLimitError extends YuanError {
  /** 제한 항목 이름 */
  public readonly limitName: string;
  /** 현재 값 */
  public readonly currentValue: number;
  /** 제한 값 */
  public readonly limitValue: number;

  constructor(limitName: string, currentValue: number, limitValue: number) {
    super(
      `Plan limit exceeded: ${limitName} (${currentValue}/${limitValue})`,
      "PLAN_LIMIT",
    );
    this.name = "PlanLimitError";
    this.limitName = limitName;
    this.currentValue = currentValue;
    this.limitValue = limitValue;
  }
}

/**
 * 위험 작업 승인 필요 에러.
 * 파일 삭제, 패키지 설치 등 위험한 작업에 유저 승인이 필요할 때 발생.
 */
export class ApprovalRequiredError extends YuanError {
  /** 승인이 필요한 액션 유형 */
  public readonly actionType: string;
  /** 상세 설명 */
  public readonly description: string;

  constructor(actionType: string, description: string) {
    super(
      `Approval required for '${actionType}': ${description}`,
      "APPROVAL_REQUIRED",
    );
    this.name = "ApprovalRequiredError";
    this.actionType = actionType;
    this.description = description;
  }
}
