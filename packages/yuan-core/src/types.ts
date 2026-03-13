/**
 * @module types
 * @description YUAN Agent Core 전체 타입 정의
 */

// ─── BYOK (Bring Your Own Key) ───
import type { SubAgentRole } from "./sub-agent-prompts.js"
import type { ParsedSkill, SkillContext } from "./plugin-types.js"
/** LLM provider 식별자 */
export type LLMProvider = "openai" | "anthropic" | "yua" | "google";

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

/** 멀티모달 콘텐츠 블록 */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" }
  | { type: "file"; name: string; content: string; language?: string };

/** ContentBlock[] | string | null → string 변환 유틸 */
export function contentToString(content: string | ContentBlock[] | null | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "file") return `[File: ${b.name}]\n${b.content}`;
      if (b.type === "image") return "[Image]";
      return "";
    })
    .join("\n");
}

/** 대화 메시지 */
export interface Message {
  role: MessageRole;
  /** 텍스트 전용이면 string, 멀티모달이면 ContentBlock[] */
  content: string | ContentBlock[] | null;
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
 /** 도구 출처 */
  source?: "builtin" | "plugin" | "mcp";
  /** MCP server name (source === "mcp"일 때) */
  serverName?: string;
  /** 읽기 전용 도구 여부 */
  readOnly?: boolean;
  /** 승인 필요 여부 */
  requiresApproval?: boolean;
  /** 위험도 */
  riskLevel?: "low" | "medium" | "high" | "critical";
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
  role?: SubAgentRole
 /** 이 step에 추천된 skill IDs */
  skillIds?: string[];
  /** 실행 직전 해석된 skill들 */
  resolvedSkills?: ParsedSkill[];
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

export interface ReasoningNode {
  id: string;
  label: string;
  text?: string;
  children: ReasoningNode[];
}

// ─── Agent Events (SSE) ───

/** SSE 이벤트 타입 */
export type AgentEvent =
  | { kind: "agent:start"; goal: string }
  | { kind: "agent:thinking"; content: string }
  | { kind: "agent:tool_call"; tool: string; input: unknown }
  | { kind: "agent:tool_result"; tool: string; output: string; durationMs: number }
  | {
      kind: "agent:reasoning_tree";
      tree: ReasoningNode;
    }
  | {
      kind: "agent:reasoning_timeline";
      source: "subagent" | "speculative" | "dag";
      taskId?: string;
      agentId?: string;
      role?: SubAgentRole | "orchestrator";
      text: string;
    }
  | {
      kind: "agent:subagent_phase"
      taskId: string
      phase: string
    }
  | {
      kind: "agent:subagent_done"
      taskId: string
      success: boolean
    }
| {
    kind: "agent:reasoning_delta"
    id?: string
    text: string
    provider?: string
    model?: string
    source?: "llm" | "agent"
  }
| {
    kind: "agent:tool_batch"
    batchId: string
    size: number
  }
  | { kind: "agent:file_change"; path: string; diff: string }
  | { kind: "agent:iteration"; index: number; tokensUsed: number; durationMs?: number }
  | { kind: "agent:error"; message: string; retryable: boolean }
  | { kind: "agent:approval_needed"; action: PendingAction }
  | { kind: "agent:completed"; summary: string; filesChanged: string[] }
  | { kind: "agent:text_delta"; text: string }
  | { kind: "agent:token_usage"; input: number; output: number }
  | { kind: "agent:qa_result"; stage: "quick" | "thorough"; passed: boolean; issues: string[] }
  | {
      kind: "agent:bg_update";
      /** Background agent ID */
      agentId: string;
      /** Human-readable label (e.g. "type-checker") */
      agentLabel: string;
      /** Event severity */
      eventType: "info" | "warning" | "error" | "success";
      /** Message content */
      message: string;
      /** Unix timestamp */
      timestamp: number;
    };

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
export type PlanTier = "LOCAL" | "FREE" | "PRO" | "BUSINESS" | "ENTERPRISE" | "MAX";

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
  /**
   * 도구 실행.
   * @param call - 실행할 도구 호출
   * @param abortSignal - 인터럽트 시 실행을 취소하기 위한 AbortSignal (선택)
   */
  execute(call: ToolCall, abortSignal?: AbortSignal): Promise<ToolResult>;
  executeSQL?(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

// ─── Phase 2: Parallel Agent Orchestration ───

/** 태스크 복잡도 레벨 */
export type TaskComplexity = "simple" | "moderate" | "complex" | "massive";

/** Governor의 분석 결과 — 복잡도, 실행 모드, 실행 계획 */
export interface GovernorDecision {
  complexity: TaskComplexity;
  mode: "single" | "parallel";
  plan: AgentPlan;
}

/** 병렬 에이전트 실행 계획 */
export interface AgentPlan {
  /** 실행할 태스크 목록 */
  tasks: PlannedTask[];
  /** 태스크 간 의존성 [from, to] */
  dependencies: [string, string][];
  /** 예상 총 토큰 사용량 */
  estimatedTokens: number;
  /** 예상 총 실행 시간 (ms) */
  estimatedDurationMs: number;
  /** 최대 동시 에이전트 수 */
  maxParallelAgents: number;
}

/** 계획된 개별 태스크 */
export interface PlannedTask {
  /** 태스크 고유 ID */
  id: string;
  /** 태스크 목표 설명 */
  goal: string;
  /** 작업 대상 파일 */
  targetFiles: string[];
  /** 참조용 파일 (읽기 전용) */
  readFiles: string[];
  /** 필요한 도구 목록 */
  tools: string[];
  /** 예상 반복 횟수 */
  estimatedIterations: number;
  /** 우선순위 (0–10, 높을수록 우선) */
  priority: number;
  role?: SubAgentRole
 /** 이 step에 추천된 skill IDs */
  skillIds?: string[];
  /** 실행 직전 해석된 skill들 */
  resolvedSkills?: ParsedSkill[];
  /** 태스크별 BYOK 설정 오버라이드 (미지정 시 배치/실행자 기본값 사용) */
  byokOverride?: BYOKConfig;
}

/** 태스크 실행 상태 (discriminated union) */
export type TaskStatus =
  | { status: "pending" }
  | { status: "blocked"; waitingFor: string[] }
  | { status: "running"; agentId: string; iteration: number }
  | { status: "completed"; result: TaskResult; tokensUsed: number }
  | { status: "failed"; error: string; retryCount: number }
  | { status: "skipped"; reason: string };

/** 태스크 실행 결과 */
export interface TaskResult {
  /** 태스크 ID */
  taskId: string;
  /** 실행 요약 */
  summary: string;
  /** 변경된 파일 목록 (diff 포함) */
  changedFiles: { path: string; diff: string }[];
  /** 사용된 토큰 수 */
  tokensUsed: number;
  /** 반복 횟수 */
  iterations: number;
  usedSkillIds?: string[];
}

/** DAG 실행 상태 (실시간 추적용) */
export interface DAGExecutionState {
  /** DAG 실행 고유 ID */
  dagId: string;
  /** 태스크별 상태 맵 */
  tasks: Map<string, TaskStatus>;
  /** 완료된 태스크 ID 목록 */
  completedTasks: string[];
  /** 실행 중인 태스크 ID 목록 */
  runningTasks: string[];
  /** 대기 중인 태스크 ID 목록 */
  pendingTasks: string[];
  /** 실패한 태스크 ID 목록 */
  failedTasks: string[];
  /** 사용된 총 토큰 */
  totalTokensUsed: number;
  /** 토큰 예산 한도 */
  totalTokenBudget: number;
  /** 경과 시간 (ms) */
  wallTimeMs: number;
  /** 실행 시간 제한 (ms) */
  wallTimeLimit: number;
}

/** DAG 실행 최종 결과 */
export interface DAGResult {
  /** DAG 실행 고유 ID */
  dagId: string;
  /** 전체 성공 여부 */
  success: boolean;
  /** 완료된 태스크 결과 목록 */
  completedTasks: TaskResult[];
  /** 실패한 태스크 목록 */
  failedTasks: { taskId: string; error: string }[];
  /** 건너뛴 태스크 목록 */
  skippedTasks: { taskId: string; reason: string }[];
  /** 사용된 총 토큰 */
  totalTokens: number;
  /** 총 실행 시간 (ms) */
  totalDurationMs: number;
}

/** 서브 에이전트에게 전달되는 실행 컨텍스트 */
export interface SubAgentContext {
  /** 전체 목표 */
  overallGoal: string;
  /** 이 태스크의 세부 목표 */
  taskGoal: string;
 /** skill trigger matching용 문맥 */
 
  skillContext?: SkillContext;
  /** 현재 태스크에 해석된 skill들 */
  resolvedSkills?: ParsedSkill[];
  /** 작업 대상 파일 */
  targetFiles: string[];
  /** 참조용 파일 */
  readFiles: string[];
  /** 프로젝트 구조 요약 */
  projectStructure: string;
  remainingBudget?: number
  /** 선행 태스크 결과 (의존성에 의해 전달) */
  dependencyResults?: {
    taskId: string;
    summary: string;
    changedFiles: { path: string; diff: string }[];
  }[];
  /** 관련 파일 내용 (미리 로드) */
  relevantFileContents?: { path: string; content: string }[];
  /** 경고 메시지 */
  warnings?: string[];
}

// ─── Phase 2: Event Bus, Roles, Contracts, Reflection ───

/** 실패 유형 (재시도 정책용) */
export type FailureType =
  | "TRANSIENT"
  | "TOOL_MISUSE"
  | "LOGIC_ERROR"
  | "CONTEXT_LOSS"
  | "SPEC_MISMATCH"
  | "VALIDATION_FAIL";

/** 고정 에이전트 역할 (8개 슬롯) */
export type FixedAgentRole =
  | "orchestrator"
  | "coder"
  | "reviewer"
  | "memory"
  | "search"
  | "security"
  | "data"
  | "automation";

/** 동적 에이전트 역할 (모델이 생성) */
export interface DynamicAgentRole {
  name: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  createdBy: "model";
  reason: string;
}

/** 에이전트 역할 — 고정 또는 동적 */
export type AgentRole = FixedAgentRole | DynamicAgentRole;

/** 에이전트 진행 상황 (대시보드용) */
export interface AgentProgress {
  agentId: string;
  role: AgentRole;
  status: "idle" | "running" | "done" | "error" | "waiting_approval";
  currentFile?: string;
  detail: string;
  progress: number;
  tokensUsed: number;
}

/** 대시보드 통계 */
export interface DashboardStats {
  filesChanged: number;
  tokensUsed: number;
  elapsedMs: number;
  activeAgents: number;
  totalAgents: number;
}

/** Progress 이벤트 — 상태 변경 */
export interface ProgressStatusEvent {
  kind: "progress:status";
  agentId: string;
  role: AgentRole;
  status: "planning" | "coding" | "reviewing" | "testing" | "waiting";
  detail: string;
}

/** Progress 이벤트 — 파일 작업 */
export interface ProgressFileEvent {
  kind: "progress:file";
  agentId: string;
  file: string;
  action: "reading" | "writing" | "analyzing";
  progress?: number;
}

/** Progress 이벤트 — 사고 과정 */
export interface ProgressThinkingEvent {
  kind: "progress:thinking";
  agentId: string;
  delta: string;
}

/** Progress 이벤트 — 대시보드 스냅샷 */
export interface ProgressDashboardEvent {
  kind: "progress:dashboard";
  agents: AgentProgress[];
  stats: DashboardStats;
}

/** Progress 이벤트 통합 타입 */
export type ProgressEvent =
  | ProgressStatusEvent
  | ProgressFileEvent
  | ProgressThinkingEvent
  | ProgressDashboardEvent;

/** 팀 이벤트 (팀 모드용) */
export type TeamEvent =
  | { kind: "team:member_joined"; userId: number; name: string }
  | { kind: "team:member_left"; userId: number }
  | { kind: "team:feedback"; userId: number; message: string; targetAgentId?: string }
  | { kind: "team:approval_delegated"; userId: number; actionId: string; response: "approve" | "reject" };

/** 인터럽트 이벤트 */
export type InterruptEvent =
  | { kind: "interrupt:soft"; feedback?: string }
  | { kind: "interrupt:hard" }
  | { kind: "interrupt:pause" }
  | { kind: "interrupt:resume" };

/** 통합 이벤트 버스 이벤트 타입 */
export type BusEvent =
  | AgentEvent
  | ProgressEvent
  | TeamEvent
  | InterruptEvent;

/** 태스크 계약 — 에이전트에게 부여되는 구체적 작업 명세 */
export interface TaskContract {
  /** 태스크 고유 ID */
  id: string;
  /** 태스크 목표 */
  goal: string;
  /** 담당 역할 */
  assignedRole: AgentRole;
  /** 의존하는 태스크 ID 목록 */
  dependencies: string[];
  /** 입력 스키마 */
  inputSchema: { files: string[]; context: string };
  /** 출력 스키마 */
  outputSchema: { expectedFiles: string[]; successCriteria: string[] };
  /** 사용 가능 도구 */
  allowedTools: string[];
  /** 부수효과 레벨 */
  sideEffectLevel: "none" | "read" | "write" | "execute" | "destructive";
  /** 재시도 정책 */
  retryPolicy: { maxRetries: number; backoffMs: number; failureTypes: FailureType[] };
  /** 토큰 예산 */
  tokenBudget: number;
  /** 타임아웃 (ms) */
  timeoutMs: number;
}

/** 인터럽트 시그널 — CLI/Web/팀에서 에이전트에 전달 */
export interface InterruptSignal {
  type: "soft" | "hard" | "pause" | "resume";
  feedback?: string;
  source: "cli" | "web" | "team";
  userId?: number;
}

/** 컨텍스트 소진 시 자동 저장되는 체크포인트 */
export interface ContinuationCheckpoint {
  sessionId: string;
  parentSessionId?: string;
  goal: string;
  progress: {
    completedTasks: string[];
    currentTask: string;
    remainingTasks: string[];
  };
  changedFiles: Array<{ path: string; diff: string }>;
  workingMemory: string;
  yuanMdUpdates: string[];
  errors: string[];
  contextUsageAtSave: number;
  totalTokensUsed: number;
  iterationsCompleted: number;
  createdAt: Date;
}

/** 구조적 검증 결과 (Reviewer Pipeline) */
export interface StructuralValidation {
  typeCheck: boolean;
  lintPass: boolean;
  buildPass: boolean;
  testPass: boolean;
  importIntegrity: boolean;
  schemaValid: boolean;
}

/** 의미적 검증 결과 (Reviewer Pipeline) */
export interface SemanticValidation {
  goalAchieved: boolean;
  codeQuality: number;
  noRegression: boolean;
  securityClean: boolean;
  conventions: boolean;
}

/** 리뷰어 파이프라인 — 구조적 + 의미적 검증 */
export interface ReviewerPipeline {
  structural: StructuralValidation;
  semantic: SemanticValidation;
}

// ─── Design Mode Types ───

/** Supported frontend frameworks for Design Mode */
export type DesignFramework = "nextjs" | "vite" | "cra" | "astro" | "svelte" | "unknown";

/** Dev server state */
export interface DevServerState {
  framework: DesignFramework;
  command: string;
  url: string;
  port: number;
  pid: number;
  managed: boolean;
}

/** Design Mode session config */
export interface DesignSessionConfig {
  workDir: string;
  autoVision?: boolean;
  viewport?: { width: number; height: number };
  devCommand?: string;
  port?: number;
}

/** DOM snapshot result */
export interface DOMSnapshot {
  accessibilityTree: string;
  url: string;
  title: string;
  timestamp: number;
}

/** Design Mode event types */
export type DesignEventType =
  | "design:server_started"
  | "design:browser_connected"
  | "design:dom_snapshot"
  | "design:screenshot"
  | "design:hmr_detected"
  | "design:file_changed"
  | "design:security_warning";

export interface DesignEvent {
  type: DesignEventType;
  data: Record<string, unknown>;
  timestamp: number;
}
