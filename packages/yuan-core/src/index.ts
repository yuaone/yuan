/**
 * @module @yuaone/core
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
  ContentBlock,
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
  // Phase 2: Parallel Agent Orchestration
  TaskComplexity,
  GovernorDecision,
  AgentPlan,
  PlannedTask,
  TaskStatus,
  TaskResult,
  DAGExecutionState,
  DAGResult,
  SubAgentContext,
  // Phase 2: Event Bus, Roles, Contracts, Reflection
  FailureType,
  FixedAgentRole,
  DynamicAgentRole,
  AgentRole,
  AgentProgress,
  DashboardStats,
  ProgressStatusEvent,
  ProgressFileEvent,
  ProgressThinkingEvent,
  ProgressDashboardEvent,
  ProgressEvent,
  TeamEvent,
  InterruptEvent,
  BusEvent,
  TaskContract,
  InterruptSignal,
  ContinuationCheckpoint,
  StructuralValidation,
  SemanticValidation,
  ReviewerPipeline,
  // Design Mode
  DesignFramework,
  DevServerState,
  DesignSessionConfig,
  DOMSnapshot,
  DesignEventType,
  DesignEvent,
} from "./types.js";

// ─── Type Utilities ───
export { contentToString } from "./types.js";

// ─── Errors ───
export {
  YuanError,
  ToolError,
  LLMError,
  ContextOverflowError,
  PlanLimitError,
  ApprovalRequiredError,
} from "./errors.js";

// ─── Constants (non-security) ───
export {
  PLAN_LIMITS,
  MODEL_DEFAULTS,
  PROVIDER_BASE_URLS,
  TOOL_RESULT_LIMITS,
  HISTORY_COMPACTION,
  YUAN_MD_SEARCH_PATHS,
  DEFAULT_LOOP_CONFIG,
  DESIGN_ALLOWED_PATHS,
  DESIGN_BLOCKED_PATHS,
  DESIGN_SECURITY_PATTERNS,
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

// ─── Security (SSOT — single source for all security constants) ───
export {
  DANGEROUS_PATTERNS,
  SENSITIVE_FILE_PATTERNS,
  ALLOWED_EXECUTABLES,
  INTERACTIVE_COMMANDS,
  PATH_TRAVERSAL_PATTERNS,
  SHELL_META_PATTERN,
  validateCommand,
  validateFilePath,
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

// ─── Async Completion Queue ───
export { AsyncCompletionQueue } from "./async-completion-queue.js";

// ─── DAG Orchestrator ───
export { DAGOrchestrator } from "./dag-orchestrator.js";
export type {
  DAGOrchestratorConfig,
  DAGExecuteOptions,
  DAGOrchestratorEvents,
} from "./dag-orchestrator.js";

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

// ─── Failure Recovery ───
export { FailureRecovery } from "./failure-recovery.js";
export type {
  ErrorCategory,
  RecoveryStrategy,
  RootCause,
  RecoveryDecision,
  FailureContext,
  FailureRecoveryConfig,
} from "./failure-recovery.js";

// ─── Dependency Analyzer ───
export { DependencyAnalyzer } from "./dependency-analyzer.js";
export type {
  FileNode,
  ImportRef,
  FileDependencyGraph,
  IndependentGroup,
} from "./dependency-analyzer.js";

// ─── Conflict Resolver ───
export { ConflictResolver, lcs, diff, merge3way } from "./conflict-resolver.js";
export type {
  ConflictType,
  FileConflict,
  ConflictResolution,
  DiffHunk,
  ConflictHunk,
  MergeResult,
} from "./conflict-resolver.js";

// ─── Sub-Agent ───
export { SubAgent } from "./sub-agent.js";
export type {
  SubAgentPhase,
  SubAgentConfig,
  SubAgentResult,
  DAGContextLike,
  SubAgentEvents,
} from "./sub-agent.js";

// ─── Parallel Executor ───
export { ParallelExecutor } from "./parallel-executor.js";
export type {
  ParallelExecutorConfig,
  PlannedTaskLike,
  ParallelExecutorEvents,
} from "./parallel-executor.js";

// ─── Event Bus ───
export { HybridEventBus } from "./event-bus.js";
export type {
  EventBusConfig,
  StampedEvent,
  EventListener,
  Unsubscribe,
} from "./event-bus.js";

// ─── Reasoning Adapter ───
export { ReasoningProgressAdapter } from "./reasoning-adapter.js";
export type {
  ReasoningAdapterConfig,
  OnThinkingCallback,
  OnStatusCallback,
} from "./reasoning-adapter.js";

// ─── Interrupt Manager ───
export { InterruptManager } from "./interrupt-manager.js";
export type { InterruptManagerEvents } from "./interrupt-manager.js";

// ─── Continuous Reflection ───
export {
  ContinuousReflection,
  SELF_VERIFY_PROMPT,
} from "./continuous-reflection.js";
export type {
  ReflectionConfig,
  SelfVerifyVerdict,
  AgentStateSnapshot,
  SelfVerifyFn,
  CheckpointFn,
  GetStateFn,
  ContinuousReflectionOptions,
  ReflectionEvents,
} from "./continuous-reflection.js";

// ─── Role Registry ───
export { RoleConfigRegistry } from "./role-registry.js";
export type { RoleConfig } from "./role-registry.js";

// ─── Dynamic Role Generator ───
export { DynamicRoleGenerator } from "./dynamic-role-generator.js";
export type {
  DynamicRoleRequest,
  DynamicRolePattern,
} from "./dynamic-role-generator.js";

// ─── Model Router ───
export { ModelRouter } from "./model-router.js";
export type {
  TaskComplexityLevel,
  ModelTierLevel,
  RoutingDecision,
  AvailableProviders,
  ModelStats,
  ModelRouterConfig,
  ModelEntry,
} from "./model-router.js";

// ─── Agent Modes ───
export {
  getAgentModeConfig,
  getAllAgentModes,
  isValidAgentMode,
  isToolAllowedInMode,
  isTestFile,
  buildModeSystemPrompt,
} from "./agent-modes.js";
export type {
  AgentMode,
  AgentOutputFormat,
  AutoApproveLevel,
  AgentModeConfig,
} from "./agent-modes.js";

// ─── Context Compressor ───
export { ContextCompressor } from "./context-compressor.js";
export type {
  CompressionPriorities,
  CompressionStrategy,
  ContextCompressorConfig,
  CompressedResult,
} from "./context-compressor.js";

// ─── Memory Manager ───
export { MemoryManager } from "./memory-manager.js";
export type {
  CodePattern,
  Learning,
  FailedApproach,
  ProjectMemory,
  RelevantMemories,
} from "./memory-manager.js";

// ─── State Machine ───
export { AgentStateMachine } from "./state-machine.js";
export type {
  AgentPhase,
  AgentState,
  ApproachOption,
  StepResult,
  StepError,
  VerifyResult,
  PhaseHandler,
  PhaseTransition,
  StateMachineContext,
  StateMachineConfig,
  StateMachineEvents,
} from "./state-machine.js";

// ─── Codebase Context ───
export { CodebaseContext } from "./codebase-context.js";
export type {
  SymbolInfo,
  ParamInfo,
  CallEdge,
  FileAnalysis,
  CodebaseIndex,
  SemanticSearchResult,
  BlastRadiusResult,
  RelatedFile,
  CallChainEntry,
} from "./codebase-context.js";

// ─── Hierarchical Planner ───
export { HierarchicalPlanner } from "./hierarchical-planner.js";
export type {
  PlanLevel,
  Milestone,
  StrategicGoal,
  TacticalTask,
  OperationalAction,
  RiskAssessment,
  HierarchicalPlan,
  RePlanTrigger,
  RePlanResult,
  HierarchicalPlannerConfig,
} from "./hierarchical-planner.js";

// ─── MCP Client ───
export { MCPClient } from "./mcp-client.js";
export type {
  MCPServerConfig,
  MCPClientConfig,
  MCPTool,
  MCPCallResult,
  MCPServerState,
} from "./mcp-client.js";

// ─── Self-Reflection ───
export { SelfReflection } from "./self-reflection.js";
export type {
  DeepVerifyResult,
  DimensionScore,
  SuggestedFix,
  MonologueEntry,
  ReflectionLearning,
  SelfReflectionConfig,
  SelfReflectionEvents,
  MistakeType,
} from "./self-reflection.js";

// ─── Execution Engine ───
export { ExecutionEngine } from "./execution-engine.js";
export type {
  ExecutionEngineConfig,
  ExecutionResult,
  ExecutionEngineEvents,
} from "./execution-engine.js";

// ─── Context Budget Manager ───
export { ContextBudgetManager } from "./context-budget.js";
export type {
  BudgetAllocation,
  ContextPriority,
  ContextItem,
  ContextSummary,
  ContextBudgetSnapshot,
  RetrievalQuery,
  RetrievalResult,
  ContextBudgetConfig,
  BudgetStatus,
  ContextCheckpoint,
} from "./context-budget.js";

// ─── Kernel (4 Core Abstractions) ───
export { PlanGraphManager, ToolContractRegistry, EventLog } from "./kernel.js";
export type {
  KernelSession,
  PendingApprovalInfo,
  ApprovalRecord,
  SessionCheckpoint,
  PlanNodeStatus,
  PlanNode,
  PlanGraphState,
  ToolContract,
  ToolInputSchema,
  ToolOutputSchema,
  ToolPermissions,
  ToolApprovalPolicy,
  AutoApproveCondition,
  ToolSecurityPolicy,
  ToolConstraints,
  KernelEventType,
  KernelEvent,
} from "./kernel.js";

// ─── Test Intelligence ───
export { TestIntelligence } from "./test-intelligence.js";
export type {
  TestFile,
  TestCase,
  TestRunResult,
  TestError,
  AffectedTestResult,
  CoverageGap,
  TestSuggestion,
  SuggestedTestCase,
  TestIntelligenceConfig,
} from "./test-intelligence.js";

// ─── Cross-File Refactoring ───
export { CrossFileRefactor } from "./cross-file-refactor.js";
export type {
  RefactorType,
  RefactorRequest,
  RefactorPreview,
  FileChange,
  TextChange,
  BreakingChange,
  RefactorResult,
  RefactorSafety,
} from "./cross-file-refactor.js";

// ─── Git Intelligence ───
export { GitIntelligence } from "./git-intelligence.js";
export type {
  CommitAnalysis,
  BreakingChangeInfo,
  SmartCommitMessage,
  PRDescription,
  ConflictPrediction,
  FileHotspot,
  BranchSuggestion,
  GitStats,
  GitIntelligenceConfig,
} from "./git-intelligence.js";

// ─── QA Pipeline ───
export { QAPipeline } from "./qa-pipeline.js";
export type {
  QAStage,
  QALevel,
  QAPipelineConfig,
  QualityGates,
  StageResult,
  CheckResult,
  QAFixAttempt,
  QAPipelineResult,
  GateResult,
  QADecision,
  QAPipelineEvents,
} from "./qa-pipeline.js";

// ─── Agent Logger ───
export { AgentLogger } from "./agent-logger.js";
export type {
  LogLevel,
  LogCategory,
  LogEntry,
  LoggerConfig,
  LogOutput,
  LogQuery,
  LogSummary,
} from "./agent-logger.js";

// ─── Vector Index ───
export { VectorIndex } from "./vector-index.js";
export type {
  CodeEmbedding,
  VectorSearchResult,
  EmbeddingProvider,
  SQLExecutor,
  VectorIndexConfig,
  IndexStats,
  SymbolType,
} from "./vector-index.js";

// ─── Persona ───
export { PersonaManager } from "./persona.js";
export type {
  YUANPersona,
  UserProfile,
  UserRule,
  SpeechAnalysis,
  PersonaConfig,
} from "./persona.js";

// ─── Sandbox Tiers ───
export { SandboxManager } from "./sandbox-tiers.js";
export type {
  SandboxTier,
  TierPolicy,
  SandboxDecision,
  SandboxViolation,
  SandboxConfig,
  SandboxState,
} from "./sandbox-tiers.js";

// ─── Security Scanner (DAST) ───
export { SecurityScanner } from "./security-scanner.js";
export type {
  SecuritySeverity,
  SecurityCategory,
  SecurityFinding,
  SecurityScanConfig,
  SecurityPattern,
  SecurityScanResult,
} from "./security-scanner.js";

// ─── Doc Intelligence ───
export { DocIntelligence } from "./doc-intelligence.js";
export type {
  DocCoverage,
  DocMissing,
  DocStale,
  GeneratedDoc,
  ChangelogEntry,
  DocIntelligenceConfig,
  ProjectInfo,
  ExportInfo,
  CommitInfo,
  ParsedCommit,
} from "./doc-intelligence.js";

// ─── Performance Optimizer ───
export { PerfOptimizer } from "./perf-optimizer.js";
export type {
  PerfMetric,
  PhaseMetrics,
  BottleneckInfo,
  CacheEntry,
  ParallelHint,
  PerfReport,
  PerfOptimizerConfig,
} from "./perf-optimizer.js";

// ─── Language Support ───
export { LanguageSupport } from "./language-support.js";
export type {
  SupportedLanguage,
  LanguageConfig,
  LanguagePatterns,
  ProjectType,
  LanguageSupportConfig,
  ParsedSymbol,
  ParsedImport,
} from "./language-support.js";

// ─── Debate Orchestrator ───
export { DebateOrchestrator } from "./debate-orchestrator.js";
export type {
  DebateConfig,
  DebateRole,
  DebateRound,
  ReviewIssue,
  VerifierResult,
  DebateResult,
  DebateOrchestratorEvents,
} from "./debate-orchestrator.js";

// ─── Speculative Executor ───
export { SpeculativeExecutor } from "./speculative-executor.js";
export type {
  SpeculativeConfig,
  ApproachStrategy,
  Approach,
  ApproachResult,
  SpeculativeResult,
  SpeculativeExecutorEvents,
} from "./speculative-executor.js";

// ─── Intent Inference ───
export { IntentInferenceEngine } from "./intent-inference.js";
export type {
  IntentConfig,
  IntentCategory,
  InferredIntent,
  IntentSignal,
} from "./intent-inference.js";

// ─── Design Loop ───
export { DesignLoop } from "./design-loop.js";
export type { DesignLoopOptions } from "./design-loop.js";

// ─── Task Classifier ───
export { TaskClassifier, TaskType } from "./task-classifier.js";
export type { TaskClassification } from "./task-classifier.js";

// ─── Prompt Defense ───
export { PromptDefense } from "./prompt-defense.js";
export type {
  SanitizeResult,
  ValidationResult as PromptValidationResult,
  InjectionDetection,
  InjectionMatch,
  InjectionSeverity,
  StrictnessLevel,
} from "./prompt-defense.js";

// ─── Token Budget ───
export { TokenBudgetManager } from "./token-budget.js";
export type {
  BudgetRole,
  RoleBudgetConfig,
  RoleUsage,
  BudgetCheckResult,
  OverallBudgetStatus,
} from "./token-budget.js";

// ─── Continuation Engine ───
export { ContinuationEngine } from "./continuation-engine.js";
export type { ContinuationEngineConfig } from "./continuation-engine.js";

// ─── Memory Updater ───
export { MemoryUpdater } from "./memory-updater.js";
export type {
  ToolPattern,
  CoChangePattern,
  PerfSummary,
  ErrorPattern,
  RunAnalysis,
  MemoryUpdaterConfig,
  AnalyzeRunParams,
  ToolResultEntry,
} from "./memory-updater.js";

// ─── Reflexion Layer ───
export { ReflexionStore, ReflexionEngine } from "./reflexion.js";
export type {
  ReflexionEntry,
  StrategyRecord,
  ReflexionGuidance,
  ReflexionConfig,
  ReflectParams,
} from "./reflexion.js";

// ─── World State ───
export { WorldStateCollector } from "./world-state.js";
export type {
  WorldStateSnapshot,
  WorldStateConfig,
} from "./world-state.js";

// ─── Execution Policy Engine ───
export { ExecutionPolicyEngine, DEFAULT_POLICY } from "./execution-policy-engine.js";
export type {
  ExecutionPolicy,
  PolicySource,
} from "./execution-policy-engine.js";

// ─── Cost Optimizer ───
export { CostOptimizer } from "./cost-optimizer.js";
export type {
  ModelProfile,
  CostEstimate,
  CostRecord,
  SessionCostSummary,
  CostOptimizerConfig,
} from "./cost-optimizer.js";
// Note: ModelTier already exported from types.ts

// ─── Impact Analyzer ───
export { ImpactAnalyzer } from "./impact-analyzer.js";
export type {
  AffectedFile,
  AffectedTest,
  AffectedAPI,
  ImpactBreakingChange,
  RiskLevel,
  ImpactReport,
  ImpactAnalyzerConfig,
} from "./impact-analyzer.js";

// ─── Benchmark Runner ───
export { BenchmarkRunner } from "./benchmark-runner.js";
export type {
  BenchmarkTask,
  BenchmarkResult,
  BenchmarkSummary,
  BenchmarkRunnerConfig,
} from "./benchmark-runner.js";
