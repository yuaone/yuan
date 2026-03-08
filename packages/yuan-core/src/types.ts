/**
 * @module types
 * @description YUAN Agent Core 전체 타입 정의
 */

// ─── BYOK (Bring Your Own Key) ───

/** LLM provider 식별자 */
export type LLMProvider = "openai" | "anthropic" | "google";

/** BYOK 설정 — 사용자가 직접 제공하는 API 키 */
export interface BYOKConfig {
  /** LLM 프로바이더 */
  provider: LLMProvider;
  /** 사용자 API 키 (암호화 저장 권장) */
  apiKey: string;
  /** 사용자 지정 모델 (미지정 시 프로바이더별 기본 모델) */
  model?: string;
  /** 커스텀 엔드포인트 (Azure OpenAI 등) */
  baseUrl?: string;
}

// ─── Messages ───

/** 메시지 역할 */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/** 대화 메시지 */
export interface Message {
  role: MessageRole;
  content: string | null;
  /** 어시스턴트가 호출한 도구 목록 */
  tool_calls?: ToolCall[];
  /** 도구 실행 결과 (role=tool 일 때) */
  tool_call_id?: string;
}

// ─── Tools ───

/** JSON Schema 기반 도구 파라미터 정의 */
export interface ToolParameterSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

/** 도구 정의 */
export interface ToolDefinition {
  /** 도구 이름 (snake_case) */
  name: string;
  /** 도구 설명 */
  description: string;
  /** JSON Schema 기반 파라미터 정의 */
  parameters: ToolParameterSchema;
}

/** LLM이 요청한 도구 호출 */
export interface ToolCall {
  /** 호출 고유 ID */
  id: string;
  /** 호출할 도구 이름 */
  name: string;
  /** 도구에 전달할 인자 (JSON 문자열 또는 파싱된 객체) */
  arguments: string | Record<string, unknown>;
}

/** 도구 실행 결과 */
export interface ToolResult {
  /** 대응하는 ToolCall.id */
  tool_call_id: string;
  /** 도구 이름 */
  name: string;
  /** 실행 결과 (문자열) */
  output: string;
  /** 실행 성공 여부 */
  success: boolean;
  /** 실행 시간 (ms) */
  durationMs: number;
}

// ─── Agent Config ───

/** 모델 티어 */
export type ModelTier = "standard" | "coding" | "fast";

/** Agent Loop 설정 */
export interface AgentLoopConfig {
  /** 사용할 모델 티어 */
  model: ModelTier;
  /** 최대 루프 반복 횟수 (기본 25, 플랜별 차등) */
  maxIterations: number;
  /** 반복당 토큰 한도 */
  maxTokensPerIteration: number;
  /** 전체 토큰 예산 */
  totalTokenBudget: number;
  /** 사용 가능 도구 목록 */
  tools: ToolDefinition[];
  /** 시스템 프롬프트 */
  systemPrompt: string;
  /** 프로젝트 루트 경로 */
  projectPath: string;
}

/** 에이전트 전체 설정 */
export interface AgentConfig {
  /** BYOK 설정 */
  byok: BYOKConfig;
  /** Agent Loop 설정 */
  loop: AgentLoopConfig;
  /** 자동 승인 설정 */
  autoApprove?: ApprovalAction[];
}

// ─── Execution Plan ───

/** 계획 단계 */
export interface PlanStep {
  /** 단계 ID */
  id: string;
  /** 단계 설명 */
  goal: string;
  /** 작업 대상 파일 */
  targetFiles: string[];
  /** 참조용 파일 (읽기 전용) */
  readFiles: string[];
  /** 필요한 도구 */
  tools: string[];
  /** 예상 반복 횟수 */
  estimatedIterations: number;
  /** 의존하는 선행 단계 ID */
  dependsOn: string[];
}

/** 실행 계획 */
export interface ExecutionPlan {
  /** 전체 목표 */
  goal: string;
  /** 계획 단계 목록 */
  steps: PlanStep[];
  /** 예상 토큰 사용량 */
  estimatedTokens: number;
}

// ─── Agent Events (SSE) ───

/** SSE 이벤트 타입 */
export type AgentEvent =
  | { kind: "agent:start"; goal: string }
  | { kind: "agent:thinking"; content: string }
  | { kind: "agent:tool_call"; tool: string; input: unknown }
  | { kind: "agent:tool_result"; tool: string; output: string; durationMs: number }
  | { kind: "agent:file_change"; path: string; diff: string }
  | { kind: "agent:iteration"; index: number; tokensUsed: number }
  | { kind: "agent:error"; message: string; retryable: boolean }
  | { kind: "agent:approval_needed"; action: PendingAction }
  | { kind: "agent:completed"; summary: string; filesChanged: string[] }
  | { kind: "agent:text_delta"; text: string }
  | { kind: "agent:token_usage"; input: number; output: number };

// ─── Session ───

/** 세션 설정 */
export interface SessionConfig {
  /** 세션 ID */
  id: string;
  /** 프로젝트 루트 경로 */
  projectPath: string;
  /** 세션 TTL (ms) */
  ttlMs: number;
}

/** 세션 상태 */
export interface SessionState {
  /** 세션 ID */
  id: string;
  /** 상태 */
  status: "initializing" | "ready" | "running" | "completed" | "error";
  /** 현재 반복 인덱스 */
  currentIteration: number;
  /** 사용된 총 토큰 */
  totalTokensUsed: number;
  /** 변경된 파일 목록 */
  changedFiles: string[];
  /** 생성 시각 (epoch ms) */
  createdAt: number;
  /** 마지막 활동 시각 (epoch ms) */
  lastActiveAt: number;
}

// ─── Plan Tiers ───

/** 플랜 티어 */
export type PlanTier = "FREE" | "PRO" | "BUSINESS" | "ENTERPRISE";

/** 플랜별 제한값 */
export interface PlanLimits {
  /** 일일 실행 횟수 */
  dailyExecutions: number;
  /** 최대 반복 횟수 */
  maxIterations: number;
  /** 병렬 에이전트 수 */
  maxParallelAgents: number;
  /** 요청당 토큰 한도 */
  tokensPerRequest: number;
  /** 세션 TTL (ms) */
  sessionTtlMs: number;
  /** 동시 세션 수 */
  concurrentSessions: number;
}

// ─── Approval ───

/** 승인이 필요한 액션 유형 */
export type ApprovalAction =
  | "DELETE_FILE"
  | "OVERWRITE_FILE"
  | "INSTALL_PACKAGE"
  | "RUN_DANGEROUS_CMD"
  | "MODIFY_CONFIG"
  | "GIT_PUSH"
  | "CREATE_PR";

/** 보류 중인 승인 액션 */
export interface PendingAction {
  /** 고유 ID */
  id: string;
  /** 액션 유형 */
  type: ApprovalAction;
  /** 유저에게 보여줄 설명 */
  description: string;
  /** 변경 내용 상세 */
  details: unknown;
  /** 위험도 */
  risk: "low" | "medium" | "high";
  /** 승인 대기 시간 (ms) */
  timeout: number;
}

// ─── Agent Termination ───

/** 에이전트 종료 사유 */
export type AgentTermination =
  | { reason: "GOAL_ACHIEVED"; summary: string }
  | { reason: "MAX_ITERATIONS"; lastState: string }
  | { reason: "BUDGET_EXHAUSTED"; tokensUsed: number }
  | { reason: "USER_CANCELLED" }
  | { reason: "ERROR"; error: string }
  | { reason: "NEEDS_APPROVAL"; action: PendingAction };

// ─── Token Usage ───

/** 토큰 사용량 */
export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  total: number;
}

// ─── Tool Executor Interface ───

/** 도구 실행기 인터페이스 (yuan-tools에서 구현) */
export interface ToolExecutor {
  /** 도구 정의 목록 */
  definitions: ToolDefinition[];
  /** 도구 실행 */
  execute(call: ToolCall): Promise<ToolResult>;
}
