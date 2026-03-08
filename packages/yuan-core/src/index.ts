/**
 * @module @yuan/core
 * @description YUAN Agent Core Runtime — 메인 진입점.
 *
 * 핵심 모듈:
 * - types: 전체 타입 정의
 * - errors: 에러 클래스 계층
 * - constants: 플랜 제한, 모델 기본값, 위험 패턴
 * - llm-client: BYOK LLM API 클라이언트
 * - agent-loop: 메인 Agent Loop
 * - governor: 실행 제한/안전 검증
 * - context-manager: 컨텍스트 윈도우 관리
 * - memory: YUAN.md 프로젝트 메모리
 * - planner: 작업 계획 수립
 * - system-prompt: 시스템 프롬프트 생성
 */

// ─── Types ───
export type {
  LLMProvider,
  BYOKConfig,
  MessageRole,
  Message,
  ToolParameterSchema,
  ToolDefinition,
  ToolCall,
  ToolResult,
  ModelTier,
  AgentLoopConfig,
  AgentConfig,
  PlanStep,
  ExecutionPlan,
  AgentEvent,
  SessionConfig,
  SessionState,
  PlanTier,
  PlanLimits,
  ApprovalAction,
  PendingAction,
  AgentTermination,
  TokenUsage,
  ToolExecutor,
} from "./types.js";

// ─── Errors ───
export {
  YuanError,
  ToolError,
  LLMError,
  ContextOverflowError,
  PlanLimitError,
  ApprovalRequiredError,
} from "./errors.js";

// ─── Constants ───
export {
  PLAN_LIMITS,
  MODEL_DEFAULTS,
  PROVIDER_BASE_URLS,
  DANGEROUS_PATTERNS,
  SENSITIVE_FILE_PATTERNS,
  ALLOWED_EXECUTABLES,
  TOOL_RESULT_LIMITS,
  HISTORY_COMPACTION,
  YUAN_MD_SEARCH_PATHS,
  DEFAULT_LOOP_CONFIG,
} from "./constants.js";

// ─── LLM Client ───
export { BYOKClient } from "./llm-client.js";
export type { LLMResponse, LLMStreamChunk } from "./llm-client.js";

// ─── Agent Loop ───
export { AgentLoop } from "./agent-loop.js";
export type { AgentLoopOptions } from "./agent-loop.js";

// ─── Governor ───
export { Governor } from "./governor.js";
export type { GovernorConfig, GovernorState } from "./governor.js";

// ─── Context Manager ───
export { ContextManager } from "./context-manager.js";
export type { ContextManagerConfig } from "./context-manager.js";

// ─── Memory ───
export { YuanMemory } from "./memory.js";
export type { YuanMemoryData, ProjectStructure } from "./memory.js";

// ─── Planner ───
export { Planner } from "./planner.js";
export type { PlannerConfig, FileDependency } from "./planner.js";

// ─── System Prompt ───
export { buildSystemPrompt } from "./system-prompt.js";
export type { SystemPromptOptions } from "./system-prompt.js";

// ─── Security (SSOT) ───
export {
  DANGEROUS_PATTERNS as SECURITY_DANGEROUS_PATTERNS,
  SENSITIVE_FILE_PATTERNS as SECURITY_SENSITIVE_FILES,
  ALLOWED_EXECUTABLES as SECURITY_ALLOWED_EXECUTABLES,
  INTERACTIVE_COMMANDS,
  PATH_TRAVERSAL_PATTERNS,
  SHELL_META_PATTERN,
  validateCommand,
  validateCommand as securityValidateCommand,
  validateFilePath,
  validateFilePath as securityValidateFilePath,
  isSensitiveFile,
  isDangerousCommand,
  isInteractiveCommand,
  isBlockedExecutable,
} from "./security.js";
export type { SecurityValidation } from "./security.js";

// ─── Session Persistence ───
export { SessionPersistence } from "./session-persistence.js";
export type {
  SessionStatus,
  SessionSnapshot,
  SessionData as PersistentSessionData,
  CheckpointData,
} from "./session-persistence.js";

// ─── Approval ───
export { ApprovalManager } from "./approval.js";
export type {
  ApprovalRequest,
  ApprovalResponse,
  ApprovalHandler,
  AutoApprovalConfig,
} from "./approval.js";

// ─── Auto-Fix ───
export { AutoFixLoop, DEFAULT_AUTO_FIX_CONFIG } from "./auto-fix.js";
export type {
  AutoFixConfig,
  ValidationResult,
  ValidationFailure,
  AutoFixTrigger,
  FixAttempt,
  LintResult,
  BuildResult,
} from "./auto-fix.js";
