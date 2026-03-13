/**
 * @module execution-engine
 * @description Top-level Execution Engine — StateMachine(brain) ↔ AgentLoop(hands) 오케스트레이터.
 *
 * 모든 하위 시스템을 연결하여 사용자 목표를 end-to-end로 실행한다:
 * - **StateMachine** — phase 전이 (analyze → plan → implement → verify → done)
 * - **AgentLoop** — LLM ↔ Tool 반복 실행 (implement/fix phase)
 * - **HierarchicalPlanner** — 3-level 계획 수립 (plan phase)
 * - **SelfReflection** — 6-dimension 심층 검증 (verify phase)
 * - **CodebaseContext** — 코드베이스 인덱싱/검색 (analyze phase)
 *
 * @example
 * ```typescript
 * const engine = new ExecutionEngine({
 *   byokConfig: { provider: "anthropic", apiKey: "sk-..." },
 *   projectPath: "/my/project",
 *   toolExecutor: myExecutor,
 *   maxIterations: 100,
 *   totalTokenBudget: 500_000,
 * });
 *
 * engine.on("phase:enter", (phase) => console.log(`Phase: ${phase}`));
 * engine.on("monologue", (entry) => console.log(entry.thought));
 *
 * const result = await engine.execute("Add error handling to all API routes");
 * console.log(result.success, result.summary);
 * ```
 */

import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  BYOKConfig,
  ToolExecutor,
  ExecutionPlan,
  AgentTermination,
  ToolDefinition,
 AgentPlan,
  PlannedTask,
  TaskResult,
  SubAgentContext,
  ToolResult,
} from "./types.js";

import { BYOKClient } from "./llm-client.js";
import { AgentLoop } from "./agent-loop.js";
import { AgentLogger } from "./agent-logger.js";
import type { LoggerConfig } from "./agent-logger.js";
import type { GovernorConfig } from "./governor.js";
import type { ContextManagerConfig } from "./context-manager.js";
import type { ApprovalHandler, AutoApprovalConfig } from "./approval.js";
import type { AutoFixConfig } from "./auto-fix.js";
import {
  AgentStateMachine,
  type AgentPhase,
  type AgentState,
  type ApproachOption,
  type StateMachineContext,
  type StepResult,
  type StepError,
  type VerifyResult,
} from "./state-machine.js";
import { CodebaseContext } from "./codebase-context.js";
import { VectorIndex } from "./vector-index.js";
import type { EmbeddingCache } from "./vector-index.js";
import type { SQLExecutor, EmbeddingProvider } from "./vector-index.js";
import {
  InMemoryVectorStore,
  OllamaEmbeddingProvider,
} from "./vector-store.js";
import type { VectorStoreMode } from "./vector-store.js";
import { LanguageSupport } from "./language-support.js";
import {
  HierarchicalPlanner,
  type HierarchicalPlan,
} from "./hierarchical-planner.js";
import {
  SelfReflection,
  type DeepVerifyResult,
  type MonologueEntry,
  type ReflectionLearning,
} from "./self-reflection.js";
import { PlanGraphManager } from "./kernel.js";
import { SessionPersistence } from "./session-persistence.js";
import { MCPClient } from "./mcp-client.js";
import type { MCPServerConfig } from "./mcp-client.js";
import { PerfOptimizer } from "./perf-optimizer.js";
import { SandboxManager } from "./sandbox-tiers.js";
import type { SandboxTier } from "./sandbox-tiers.js";
import { DebateOrchestrator } from "./debate-orchestrator.js";
import { SecurityScanner } from "./security-scanner.js";
import type { SecurityScanResult } from "./security-scanner.js";
import { DocIntelligence } from "./doc-intelligence.js";
import type { DocCoverage } from "./doc-intelligence.js";
import { IntentInferenceEngine } from "./intent-inference.js";
import type { InferredIntent } from "./intent-inference.js";
import { SpeculativeExecutor } from "./speculative-executor.js";
import type { SpeculativeResult } from "./speculative-executor.js";
import { SubAgent } from "./sub-agent.js";
import { routeSubAgent } from "./sub-agent-router.js";
import type { SubAgentRole } from "./sub-agent-prompts.js";
import { DAGOrchestrator } from "./dag-orchestrator.js"
import { WorkspaceLock } from "./workspace-lock.js"
import {
  SkillLoader,
} from "./skill-loader.js";
import {
  SkillLearner,
} from "./skill-learner.js";
import type {
  SkillDefinition,
  SkillContext,
  ParsedSkill,
} from "./plugin-types.js";
// ─── Types ───────────────────────────────────────────────────────

/** ExecutionEngine 설정 */
export interface ExecutionEngineConfig {
  /** BYOK LLM 설정 */
  byokConfig: BYOKConfig;

  /** 프로젝트 루트 경로 */
  projectPath: string;

  /** 도구 실행기 */
  toolExecutor: ToolExecutor;

  /** 최대 반복 횟수 (기본 100) */
  maxIterations?: number;

  /** 전체 토큰 예산 (기본 500,000) */
  totalTokenBudget?: number;

  /** 최대 수정 시도 횟수 (기본 3) */
  maxFixAttempts?: number;

  /** 코드베이스 인덱싱 활성화 (기본 true) */
  enableCodebaseIndex?: boolean;

  /** 3-level 계층적 계획 활성화 (기본 true) */
  enableHierarchicalPlanning?: boolean;

  /** 6-dimension 심층 검증 활성화 (기본 true) */
  enableDeepVerify?: boolean;

  /** 내적 독백 활성화 (기본 true) */
  enableMonologue?: boolean;

  /** 학습 기록 활성화 (기본 true) */
  enableLearning?: boolean;

  /** 단순 태스크 시 design phase 스킵 (기본 true) */
  skipDesignForSimple?: boolean;

  /** 병렬 실행 활성화 (기본 true) */
  enableParallel?: boolean;

  /** Governor 설정 오버라이드 */
  governorConfig?: GovernorConfig;

  /** ContextManager 설정 오버라이드 */
  contextConfig?: Partial<ContextManagerConfig>;

  /** 자동 승인 설정 오버라이드 */
  approvalConfig?: Partial<AutoApprovalConfig>;

  /** 승인 핸들러 (CLI/UI에서 등록) */
  approvalHandler?: ApprovalHandler;

  /** 자동 수정 루프 설정 오버라이드 */
  autoFixConfig?: Partial<AutoFixConfig>;

  /** 구조화된 실행 로거 (미제공 시 기본 생성) */
  logger?: AgentLogger;

  /** 로거 설정 (logger 미제공 시 기본 로거 생성에 사용) */
  loggerConfig?: Partial<LoggerConfig>;

  /** 세션 영속성 핸들러 (체크포인트 저장용, 미제공 시 비활성) */
  sessionPersistence?: SessionPersistence | null;

  /** 세션 ID (resume 시 기존 세션 ID 전달) */
  sessionId?: string;

  /** 병렬 실행 활성화 — PlanGraph DAG 기반 (기본 true) */
  enableParallelExecution?: boolean;

  /** 최대 동시 병렬 에이전트 수 (기본 3) */
  maxParallelAgents?: number;

  /** 벡터 검색 활성화 — pgvector 기반 시맨틱 검색 (기본 false, pgvector 필요) */
  enableVectorSearch?: boolean;

  /**
   * 벡터 스토어 백엔드 선택.
   * - "postgres" — pgvector만 사용 (실패 시 에러)
   * - "memory"   — InMemoryVectorStore만 사용 (오프라인 OK)
   * - "auto"     — postgres 시도 후 실패 시 memory로 폴백 (기본값)
   */
  vectorStoreMode?: VectorStoreMode;

  /** MCP server configurations for external tool integration (기본 undefined — disabled) */
  mcpServerConfigs?: Array<{ name: string; command: string; args?: string[] }>;

  /** 성능 추적 활성화 (기본 false) */
  enablePerfTracking?: boolean;

  /** 샌드박스 보안 격리 활성화 (기본 false) */
  enableSandbox?: boolean;

  /** 샌드박스 기본 티어 (기본 2 — Project-Scoped) */
  sandboxTier?: SandboxTier;

  /** Multi-agent debate verification 활성화 (기본 false) */
  enableDebate?: boolean;

  /** Security DAST scanning in verify phase 활성화 (기본 false) */
  enableSecurityScan?: boolean;

  /** Documentation intelligence in verify phase 활성화 (기본 false) */
  enableDocGeneration?: boolean;

  /** Intent inference pre-processing 활성화 (기본 true — 모호한 입력에만 활성) */
  enableIntentInference?: boolean;

  /** Speculative execution 활성화 (기본 false — 비용이 높으므로 opt-in) */
  enableSpeculative?: boolean;

  /** Speculative execution 시 최대 접근법 수 (기본 3) */
  speculativeMaxApproaches?: number;

  skills?: SkillDefinition[];
}

/** 내부 전용 — 기본값 적용 후 설정 */
interface ResolvedConfig {
  byokConfig: BYOKConfig;
  projectPath: string;
  toolExecutor: ToolExecutor;
  maxIterations: number;
  totalTokenBudget: number;
  maxFixAttempts: number;
  enableCodebaseIndex: boolean;
  enableHierarchicalPlanning: boolean;
  enableDeepVerify: boolean;
  enableMonologue: boolean;
  enableLearning: boolean;
  skipDesignForSimple: boolean;
  enableParallel: boolean;
  enableParallelExecution: boolean;
  maxParallelAgents: number;
  enableVectorSearch: boolean;
  vectorStoreMode: VectorStoreMode;
  enableDebate: boolean;
  enableSecurityScan: boolean;
  enableDocGeneration: boolean;
  enableIntentInference: boolean;
  enableSpeculative: boolean;
  speculativeMaxApproaches: number;
  governorConfig?: GovernorConfig;
  contextConfig?: Partial<ContextManagerConfig>;
  approvalConfig?: Partial<AutoApprovalConfig>;
  approvalHandler?: ApprovalHandler;
  autoFixConfig?: Partial<AutoFixConfig>;
}

/** ExecutionEngine 실행 결과 */
export interface ExecutionResult {
  /** 성공 여부 */
  success: boolean;

  /** AgentLoop 종료 사유 (마지막 loop의 종료 사유, 있으면) */
  termination: AgentTermination;

  /** StateMachine 최종 phase */
  finalPhase: AgentPhase;

  /** 변경된 파일 목록 */
  changedFiles: string[];

  /** 실행 요약 */
  summary: string;

  /** 총 토큰 사용량 */
  totalTokens: { input: number; output: number };

  /** 총 반복 횟수 */
  totalIterations: number;

  /** 총 도구 호출 횟수 */
  totalToolCalls: number;

  /** 실행 시간 (ms) */
  durationMs: number;

  /** 심층 검증 결과 (마지막 verify phase) */
  verifyResult?: DeepVerifyResult;

  /** 내적 독백 기록 */
  monologue: MonologueEntry[];

  /** 학습 기록 */
  learnings: ReflectionLearning[];

  /** 사용된 계획 */
  plan?: HierarchicalPlan;
}

/** ExecutionEngine 이벤트 정의 */
export interface ExecutionEngineEvents {
  /** 실행 시작 */
  "engine:start": (goal: string) => void;
  /** 실행 완료 */
  "engine:complete": (result: ExecutionResult) => void;
  /** 실행 에러 */
  "engine:error": (error: Error) => void;

  /** Phase 진입 */
  "phase:enter": (phase: AgentPhase) => void;
  /** Phase 퇴장 */
  "phase:exit": (phase: AgentPhase) => void;

  /** 내적 독백 항목 */
  monologue: (entry: MonologueEntry) => void;
  /** 도구 호출 */
  "tool:call": (name: string, input: unknown) => void;
  /** 도구 결과 */
  "tool:result": (name: string, output: string) => void;
  /** 검증 결과 */
  "verify:result": (result: DeepVerifyResult | undefined) => void;

  /** AgentLoop 텍스트 델타 패스스루 */
  text_delta: (text: string) => void;
  /** AgentLoop 사고 패스스루 */
  thinking: (text: string) => void;

  /** 사용자 위임 (delegate phase에서 질문 전달) */
  "engine:delegate": (question: string) => void;
  /** 통합 agent 이벤트 */
  "agent:event": (event: unknown) => void;
  /** 서브에이전트 phase 이벤트 */
  "agent:subagent_phase": (event: {
    role: SubAgentRole;
    phase: string;
    taskId: string;
    goal: string;
  }) => void;
}

// ─── Defaults ────────────────────────────────────────────────────

const ENGINE_DEFAULTS = {
  maxIterations: 100,
  totalTokenBudget: 500_000,
  maxFixAttempts: 3,
  enableCodebaseIndex: true,
  enableHierarchicalPlanning: true,
  enableDeepVerify: true,
  enableMonologue: true,
  enableLearning: true,
  skipDesignForSimple: true,
  enableParallel: true,
  enableParallelExecution: true,
  maxParallelAgents: 3,
} as const;

// ─── ExecutionEngine ─────────────────────────────────────────────

/**
 * ExecutionEngine — YUAN 에이전트의 최상위 오케스트레이터.
 *
 * StateMachine이 phase 전이를 결정하고,
 * ExecutionEngine이 각 phase에서 적절한 하위 시스템을 호출한다.
 *
 * - **analyze**: CodebaseContext로 프로젝트 구조 파악
 * - **design**: LLM으로 접근법 제안
 * - **plan**: HierarchicalPlanner로 3-level 계획 수립
 * - **implement**: AgentLoop로 LLM ↔ Tool 반복 실행
 * - **verify**: SelfReflection.deepVerify로 6-dimension 검증
 * - **fix**: AgentLoop로 에러 수정
 * - **replan**: HierarchicalPlanner.replan으로 재계획
 */
export class ExecutionEngine extends EventEmitter {
  private readonly config: ResolvedConfig;
  private readonly llmClient: BYOKClient;
  private readonly reflection: SelfReflection;
  private codebaseContext: CodebaseContext | null;
  private vectorIndex: VectorIndex | null;
  private inMemoryVectorStore: InMemoryVectorStore | null;
private embeddingCache: EmbeddingCache;
  private stateMachine: AgentStateMachine | null;
  private abortController: AbortController;
  private readonly changedFiles: Set<string>;
  private readonly originalFiles: Map<string, string>;
  private lastTermination: AgentTermination;
  private lastVerifyResult: DeepVerifyResult | undefined;
  private hierarchicalPlan: HierarchicalPlan | undefined;
  private planGraph: PlanGraphManager | null;
  private sessionId: string;
  private readonly _logger: AgentLogger;
  private readonly sessionPersistence: SessionPersistence | null;

  /** DAG 기반 병렬 실행 결과 캐시 (stepIndex → StepResult) */
  private parallelStepResults: Map<number, StepResult>;
  /** DAG 기반 병렬 실행이 완료되었는지 */
  private parallelExecutionDone: boolean;
  private dagOrchestrator: DAGOrchestrator | null = null;
  private workspaceLock: WorkspaceLock;
  /** MCP server configurations (stored from constructor config) */
  private readonly mcpServerConfigs: Array<{ name: string; command: string; args?: string[] }>;
  /** MCP Client — external tool bridge (null if disabled) */
  private mcpClient: MCPClient | null = null;
  /** MCP tool definitions discovered at runtime */
  private mcpToolDefinitions: ToolDefinition[] = [];

  /** Performance optimizer (null if disabled) */
  private perfOptimizer: PerfOptimizer | null = null;
  /**
   * step / sub-agent 단위 토큰 예산 SSOT.
   * - 최소 5k 보장
   * - 병렬도 고려해서 전체 예산을 안전하게 분할
   */
  private getSubAgentTokenBudget(): number {
    const divisor = Math.max(1, this.config.maxParallelAgents + 1);
    return Math.max(
      5000,
      Math.floor(this.config.totalTokenBudget / divisor),
    );
  }
  /** Sandbox manager for tool call validation (null if disabled) */
  private sandboxManager: SandboxManager | null = null;
  /** Skill loader */
  private readonly skillLoader: SkillLoader;
  /** Skill learner */
  private readonly skillLearner: SkillLearner;
  /** Static + learned skill definitions */
  private readonly skills: SkillDefinition[];
  /** Run-level skill context */
  private activeSkillContext: SkillContext | null = null;
  /** Step resolved skills */
  private readonly resolvedSkillsByStepId: Map<string, ParsedSkill[]> = new Map();

  /** Global complexity inferred during analyze phase */
  private globalComplexity:
    | "trivial"
    | "simple"
    | "moderate"
    | "complex"
    | "massive" = "moderate";
  constructor(config: ExecutionEngineConfig) {
    super();
   this.setMaxListeners(200);
    this.config = {
      byokConfig: config.byokConfig,
      projectPath: config.projectPath,
      toolExecutor: config.toolExecutor,
      maxIterations: config.maxIterations ?? ENGINE_DEFAULTS.maxIterations,
      totalTokenBudget: config.totalTokenBudget ?? ENGINE_DEFAULTS.totalTokenBudget,
      maxFixAttempts: config.maxFixAttempts ?? ENGINE_DEFAULTS.maxFixAttempts,
      enableCodebaseIndex: config.enableCodebaseIndex ?? ENGINE_DEFAULTS.enableCodebaseIndex,
      enableHierarchicalPlanning: config.enableHierarchicalPlanning ?? ENGINE_DEFAULTS.enableHierarchicalPlanning,
      enableDeepVerify: config.enableDeepVerify ?? ENGINE_DEFAULTS.enableDeepVerify,
      enableMonologue: config.enableMonologue ?? ENGINE_DEFAULTS.enableMonologue,
      enableLearning: config.enableLearning ?? ENGINE_DEFAULTS.enableLearning,
      skipDesignForSimple: config.skipDesignForSimple ?? ENGINE_DEFAULTS.skipDesignForSimple,
      enableParallel: config.enableParallel ?? ENGINE_DEFAULTS.enableParallel,
      enableParallelExecution: config.enableParallelExecution ?? ENGINE_DEFAULTS.enableParallelExecution,
      maxParallelAgents: config.maxParallelAgents ?? ENGINE_DEFAULTS.maxParallelAgents,
      enableVectorSearch: config.enableVectorSearch ?? false,
      vectorStoreMode: config.vectorStoreMode ?? "auto",
      enableDebate: config.enableDebate ?? false,
      enableSecurityScan: config.enableSecurityScan ?? false,
      enableDocGeneration: config.enableDocGeneration ?? false,
      enableIntentInference: config.enableIntentInference ?? true,
      enableSpeculative: config.enableSpeculative ?? false,
      speculativeMaxApproaches: config.speculativeMaxApproaches ?? 3,
      governorConfig: config.governorConfig,
      contextConfig: config.contextConfig,
      approvalConfig: config.approvalConfig,
      approvalHandler: config.approvalHandler,
      autoFixConfig: config.autoFixConfig,
    };

    this.llmClient = new BYOKClient(this.config.byokConfig);
    this.sessionId = config.sessionId ?? `engine-${Date.now().toString(36)}`;
    this.sessionPersistence = config.sessionPersistence ?? null;
    this.reflection = new SelfReflection(this.sessionId, {
      enableDeepVerify: this.config.enableDeepVerify,
      enableMonologue: this.config.enableMonologue,
      enableLearning: this.config.enableLearning,
    });

    // Initialize structured logger
    this._logger = config.logger ?? new AgentLogger({
      sessionId: this.sessionId,
      level: "info",
      outputs: [{ type: "memory" }],
      ...config.loggerConfig,
    });


    this.codebaseContext = null;
    this.vectorIndex = null;
    this.inMemoryVectorStore = null;
const memoryCache = new Map<string, number[]>();

this.embeddingCache = {
  async get(key: string) {
    return memoryCache.get(key) ?? null;
  },
  async set(key: string, embedding: number[]) {
    memoryCache.set(key, embedding);
  },
};
    this.stateMachine = null;
    this.planGraph = null;
    this.abortController = new AbortController();
    this.changedFiles = new Set();
    this.originalFiles = new Map();
    this.lastTermination = { reason: "USER_CANCELLED" };
    this.parallelStepResults = new Map();
    this.parallelExecutionDone = false;
    this.skillLoader = new SkillLoader();
    this.skillLearner = new SkillLearner(this.config.projectPath);
    this.skills = config.skills ?? [];
    this.activeSkillContext = null;
    this.resolvedSkillsByStepId = new Map();
   this.workspaceLock = new WorkspaceLock();
 // Agent DAG orchestrator
 this.dagOrchestrator = new DAGOrchestrator({
   maxParallelAgents: this.config.maxParallelAgents,
   maxRetries: 2,
   tokenBudget: this.config.totalTokenBudget,
   wallTimeLimit: 600000,
   spawnAgent: this.spawnAgent.bind(this),
 });
this.dagOrchestrator.on("dag:agent_reasoning", (e: { text: string; taskId: string; agentId: string }) => {
   this.emit("agent:event", {
     kind: "agent:reasoning_timeline",
     source: "dag",
     taskId: e.taskId,
     text: e.text,
   });
 });
    // Store MCP server configs for use in execute()
    this.mcpServerConfigs = config.mcpServerConfigs ?? [];

    // Initialize PerfOptimizer if enabled
    if (config.enablePerfTracking) {
      this.perfOptimizer = new PerfOptimizer();
    }

    // Initialize SandboxManager if enabled
    if (config.enableSandbox) {
      this.sandboxManager = new SandboxManager({
        projectPath: this.config.projectPath,
        defaultTier: config.sandboxTier,
      });
    }
    // Wire reflection monologue events to engine events
    this.reflection.on("monologue:entry", (entry: MonologueEntry) => {
      this.emit("monologue", entry);
    });
  }

  // ─── Logger Access ─────────────────────────────────────────────

  /** 실행 로거 — 실행 후 로그 조회에 사용 */
  get logger(): AgentLogger {
    return this._logger;
  }

  /** 현재 PlanGraphManager 인스턴스 (계획 진행 상태 조회용) */
  get currentPlanGraph(): PlanGraphManager | null {
    return this.planGraph;
  }

  /**
   * 현재 계획의 진행 상황을 반환한다.
   * PlanGraphManager가 없으면 null을 반환한다.
   *
   * @returns 진행 상황 객체 또는 null
   */
  getPlanProgress(): {
    completed: number;
    total: number;
    percent: number;
    running: string[];
    failed: string[];
  } | null {
    if (!this.planGraph) return null;
    const progress = this.planGraph.getProgress();
    const graphState = this.planGraph.getState();
    return {
      completed: progress.completed,
      total: progress.total,
      percent: progress.percent,
      running: [...graphState.runningNodes],
      failed: [...graphState.failedNodes],
    };
  }

  // ─── Main Entry ────────────────────────────────────────────────

  /**
   * 사용자 목표를 end-to-end로 실행한다.
   *
   * 내부적으로 StateMachine을 생성하고, 각 phase에 대한 콜백을 연결하여
   * idle → analyze → plan → implement → verify → done까지 자동 진행한다.
   *
   * @param goal - 사용자의 실행 목표
   * @returns 실행 결과 (성공 여부, 변경 파일, 토큰 사용량 등)
   */
  async execute(goal: string): Promise<ExecutionResult> {
    const startTime = Date.now();
    this.abortController = new AbortController();
    this.changedFiles.clear();
    this.originalFiles.clear();
    this.lastVerifyResult = undefined;
    this.hierarchicalPlan = undefined;
    this.planGraph = null;
    this.parallelStepResults = new Map();
    this.parallelExecutionDone = false;
    this.resolvedSkillsByStepId.clear();
    this.activeSkillContext = {
      taskDescription: goal,
    };
    this.emit("engine:start", goal);
    this._logger.logInput(goal);
    this.reflection.think("start", `Goal received: "${goal}"`);

    try {
        // 0.5 Load learned skills
     try {
        await this.skillLearner.init();
      } catch (err) {
        this._logger.warn(
          "system",
          `SkillLearner init failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // 0. Intent inference pre-processing (refine ambiguous goals)
      if (this.config.enableIntentInference) {
        try {
          const intentEngine = new IntentInferenceEngine({
            byokConfig: this.config.byokConfig,
            projectPath: this.config.projectPath,
            maxContextTokens: 4000,
          });

          const intentResult = await intentEngine.infer(goal);
          this.emit("intent:inferred", intentResult);

          if (intentResult.isAmbiguous) {
            this._logger.info(
              "system",
              `Intent inference: ambiguous input refined — "${goal}" → "${intentResult.refinedGoal}" (category: ${intentResult.category}, confidence: ${intentResult.confidence.toFixed(2)})`,
            );
            this.reflection.think(
              "analyze",
              `Intent inference refined ambiguous goal: "${goal}" → "${intentResult.refinedGoal}" [${intentResult.category}, confidence=${intentResult.confidence.toFixed(2)}]`,
            );
            goal = intentResult.refinedGoal;
            this.activeSkillContext = {
              ...(this.activeSkillContext ?? {}),
              taskDescription: goal,
            };
          } else {
            this._logger.info(
              "system",
              `Intent inference: input is clear (category: ${intentResult.category}, confidence: ${intentResult.confidence.toFixed(2)})`,
            );
          }
        } catch (intentErr) {
          this._logger.warn(
            "system",
            `Intent inference failed (continuing with original goal): ${intentErr instanceof Error ? intentErr.message : String(intentErr)}`,
          );
        }
      }

      // 1. Build codebase index (if enabled and not already built)
      if (this.config.enableCodebaseIndex && !this.codebaseContext) {
        const languageSupport = new LanguageSupport();
        this.codebaseContext = new CodebaseContext(this.config.projectPath, languageSupport);
        this._logger.info("system", "Building codebase index", { projectPath: this.config.projectPath });
        this.reflection.think("analyze", "Building codebase index...");
        await this.codebaseContext.buildIndex();
        const stats = this.codebaseContext.getStats();
        this._logger.info("system", `Codebase indexed: ${stats.totalFiles} files, ${stats.totalSymbols} symbols`);
        this.reflection.think(
          "analyze",
          `Index built: ${stats.totalFiles} files, ${stats.totalSymbols} symbols`,
        );
      }

      // 1b. VectorIndex initialization (pgvector or in-memory semantic search)
      if (this.config.enableVectorSearch && !this.vectorIndex && !this.inMemoryVectorStore) {
        const mode = this.config.vectorStoreMode;
        const projectId = path.basename(this.config.projectPath);

        // Helper: try to initialize pgvector
        const tryPostgres = async (): Promise<boolean> => {
          const sqlExecutor: SQLExecutor = {
            query: async (sql: string, params?: unknown[]) => {
              return this.config.toolExecutor.executeSQL
                ? await this.config.toolExecutor.executeSQL(sql, params)
                : { rows: [] };
            },
          };
          const embeddingProvider: EmbeddingProvider = {
            dimension: 1536,
            embed: async (texts: string[]) => {
              const results: number[][] = [];
              for (const text of texts) {
                const resp = await this.llmClient.embed(text);
                results.push(resp.embedding);
              }
              return results;
            },
          };
          const vi = new VectorIndex({
            projectId,
            sqlExecutor,
            embeddingProvider,
            embeddingCache: this.embeddingCache,
          });
          await vi.initialize();
          this.vectorIndex = vi;
          return true;
        };

        // Helper: initialize in-memory store with Ollama (auto-falls back to TF-IDF)
        const initMemory = async (): Promise<void> => {
          const ollamaProvider = new OllamaEmbeddingProvider();
          const store = new InMemoryVectorStore({
            projectId,
            projectPath: this.config.projectPath,
            embeddingProvider: ollamaProvider,
          });
          await store.load();
          this.inMemoryVectorStore = store;
        };

        if (mode === "postgres") {
          // Strict postgres mode — fail loudly if unavailable
          try {
            await tryPostgres();
            this._logger.info("system", "VectorIndex: pgvector mode active");
          } catch (err) {
            this._logger.warn(
              "system",
              `VectorIndex (postgres): init failed — ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        } else if (mode === "memory") {
          // In-memory only mode
          await initMemory();
          const ollamaState = (this.inMemoryVectorStore as unknown as { embeddingProvider: OllamaEmbeddingProvider })
            ?.embeddingProvider?.ollamaAvailable;
          const backendName = ollamaState === false ? "TF-IDF fallback" : "Ollama (nomic-embed-text)";
          this._logger.info(
            "system",
            `VectorIndex: in-memory mode active (embedding: ${backendName})`,
          );
        } else {
          // "auto" mode — try postgres, fall back to in-memory
          let usedPostgres = false;
          try {
            usedPostgres = await tryPostgres();
            this._logger.info("system", "VectorIndex: pgvector mode active (auto)");
          } catch (pgErr) {
            this._logger.warn(
              "system",
              `VectorIndex: pgvector unavailable (${pgErr instanceof Error ? pgErr.message : String(pgErr)}) — falling back to in-memory store`,
            );
          }
          if (!usedPostgres) {
            await initMemory();
            this._logger.info(
              "system",
              "VectorIndex: in-memory mode active (Ollama/TF-IDF fallback, auto mode)",
            );
          }
        }
      }

      // 1c. MCP Client initialization (optional — connect to external MCP servers)
      if (this.mcpServerConfigs.length > 0) {
        try {
          this.mcpClient = new MCPClient({
            servers: this.mcpServerConfigs.map((s) => ({
              name: s.name,
              transport: "stdio" as const,
              command: s.command,
              args: s.args ?? [],
            })),
          });
          await this.mcpClient.connectAll();
          this.mcpToolDefinitions = this.mcpClient.toToolDefinitions();
          this._logger.info(
            "system",
            `MCP: discovered ${this.mcpToolDefinitions.length} tool(s) from ${this.mcpServerConfigs.length} server(s)`,
          );
          this.reflection.think(
            "analyze",
            `MCP tools available: ${this.mcpToolDefinitions.length}`,
          );
        } catch (mcpErr) {
          this._logger.warn(
            "system",
            `MCP connection failed (continuing without MCP tools): ${mcpErr instanceof Error ? mcpErr.message : String(mcpErr)}`,
          );
          this.mcpClient = null;
          this.mcpToolDefinitions = [];
        }
      }

      // 2. Create state machine with wired callbacks
      const context = this.buildStateMachineContext();
      this.stateMachine = new AgentStateMachine(context, {
        maxFixAttempts: this.config.maxFixAttempts,
        skipDesignForSimple: this.config.skipDesignForSimple,
        enableParallel: this.config.enableParallel,
      });

      // Wire state machine events
      this.stateMachine.on("phase:enter", (phase: AgentPhase) => {
        this.emit("phase:enter", phase);
        if (this.perfOptimizer) {
          this.perfOptimizer.startPhase(phase);
        }
        // Checkpoint after each phase transition
        this.checkpoint().catch((err) => {
          console.warn("[YUAN] Checkpoint failed:", err instanceof Error ? err.message : err);
        });
      });
      this.stateMachine.on("phase:exit", (phase: AgentPhase) => {
        this.emit("phase:exit", phase);
        if (this.perfOptimizer) {
          this.perfOptimizer.endPhase(phase);
        }
      });
      this.stateMachine.on("verify:result", (r: VerifyResult) => {
        // Convert VerifyResult to a lightweight emit; deepVerify result is emitted separately
        this.emit("verify:result", this.lastVerifyResult);
      });

      // 3. Run state machine
      const finalState = await this.stateMachine.run(
        goal,
        this.abortController.signal,
      );

      // 4. Build result
      const result = this.buildResult(finalState, startTime);

      // Performance report (if tracking enabled)
      if (this.perfOptimizer) {
        const perfReport = this.perfOptimizer.generateReport(this.sessionId);
        this._logger.info("system", `Perf: efficiency score ${perfReport.efficiencyScore}/100`);
        if (perfReport.bottlenecks.length > 0) {
          this._logger.info(
            "system",
            `Perf: ${perfReport.bottlenecks.length} bottleneck(s) detected`,
          );
        }
      }

      // Disconnect MCP servers (cleanup)
      if (this.mcpClient) {
        await this.mcpClient.disconnectAll().catch(() => {
          // Best-effort cleanup
        });
      }
      this._logger.logOutput(result.summary, result.success, result.totalTokens);
      await this._logger.flush();

      this.emit("engine:complete", result);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this._logger.error("error", `Execution failed: ${error.message}`);
      await this._logger.flush();
      this.emit("engine:error", error);

      return {
        success: false,
        termination: { reason: "ERROR", error: error.message },
        finalPhase: this.stateMachine?.getState().phase ?? "idle",
        changedFiles: [...this.changedFiles],
        summary: `Execution failed: ${error.message}`,
        totalTokens: { input: 0, output: 0 },
        totalIterations: 0,
        totalToolCalls: 0,
        durationMs: Date.now() - startTime,
        monologue: [...this.reflection.getMonologue()],
        learnings: [...this.reflection.getAllLearnings()],
      };
    }
  }

  /**
   * 런타임 상태를 디스크에 체크포인트로 저장한다.
   * sessionPersistence가 없으면 아무것도 하지 않는다.
   * 실패해도 실행을 중단하지 않는다 (경고 로그만 남김).
   *
   * @param stepIndex - 현재 step 인덱스 (있으면)
   */
  private async checkpoint(stepIndex?: number): Promise<void> {
    if (!this.sessionPersistence) return;

    try {
      await this.sessionPersistence.saveRuntimeState(this.sessionId, {
        planGraphState: this.planGraph?.toJSON() ?? null,
        stateMachinePhase: this.stateMachine?.getState().phase,
        stepIndex,
        reflectionLearnings: [...this.reflection.getAllLearnings()],
        reflectionMonologue: [...this.reflection.getMonologue()],
      });
    } catch (err) {
      this._logger.warn(
        "system",
        `Checkpoint save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 실행을 중단한다.
   * 현재 진행 중인 AgentLoop와 StateMachine이 다음 체크포인트에서 중단된다.
   */
  abort(): void {
    // Emergency checkpoint save before stopping
    this.checkpoint().catch(() => {
      // Ignore — best-effort save during abort
    });
    this.abortController.abort();
  }

  // ─── StateMachineContext Builder ────────────────────────────────

  /**
   * StateMachine에 주입할 콜백 컨텍스트를 생성한다.
   * 각 콜백이 적절한 하위 시스템(AgentLoop, HierarchicalPlanner 등)을 호출한다.
   */
  private buildStateMachineContext(): StateMachineContext {
    return {
      analyzeFn: this.analyzeGoal.bind(this),
      designFn: this.designApproaches.bind(this),
      planFn: this.createPlan.bind(this),
      executeFn: this.executeStepWithParallel.bind(this),
      verifyFn: this.verifyWork.bind(this),
      fixFn: this.fixErrors.bind(this),
      replanFn: this.replanWork.bind(this),
      delegateFn: this.delegateToUser.bind(this),
    };
  }

  // ─── Phase Callbacks ───────────────────────────────────────────

  /**
   * analyze phase 콜백 — CodebaseContext + LLM으로 목표를 분석한다.
   *
   * @param goal - 사용자 목표
   * @param state - 현재 에이전트 상태
   * @returns 복잡도 판정과 분석 컨텍스트
   */
  private async analyzeGoal(
    goal: string,
    state: AgentState,
  ): Promise<{ complexity: string; context: string }> {
    const exitAnalyze = this._logger.enterLayer("analyze", `Analyzing goal: "${goal}"`);
    this.reflection.think("analyze", `Analyzing goal: "${goal}"`);

    let codebaseStats = {};
    if (this.codebaseContext) {
      codebaseStats = this.codebaseContext.getStats();

      // Semantic search for relevant symbols
      const relevant = this.codebaseContext.searchSymbols(goal, 10);
      if (relevant.length > 0) {
        const symbolNames = relevant.map(
          (r: { symbol: { name: string; kind: string; file: string } }) =>
            `${r.symbol.name} (${r.symbol.kind}) in ${r.symbol.file}`,
        );
        this.reflection.think(
          "analyze",
          `Found ${relevant.length} relevant symbols: ${symbolNames.slice(0, 5).join(", ")}`,
        );
      }
    }

    const analysisPrompt = this.buildAnalysisPrompt(goal, codebaseStats);
    const response = await this.llmClient.chat([
      { role: "system", content: analysisPrompt },
      { role: "user", content: goal },
    ]);

    const content = response.content ?? "";

    // Parse complexity from LLM response
    let complexity = "moderate";
    const complexityMatch = content.match(
      /\b(trivial|simple|moderate|complex|massive)\b/i,
    );
    if (complexityMatch) {
      complexity = complexityMatch[1]!.toLowerCase();
    }
    this.globalComplexity =
      complexity as
        | "trivial"
        | "simple"
        | "moderate"
        | "complex"
        | "massive";
    this._logger.logDecision(
      "Goal complexity assessment",
      ["trivial", "simple", "moderate", "complex", "massive"],
      complexity,
      `LLM analysis determined complexity based on goal and codebase context`,
    );
    this.reflection.think(
      "analyze",
      `Analysis complete — complexity: ${complexity}`,
    );
    this.activeSkillContext = {
      ...(this.activeSkillContext ?? {}),
      taskDescription: goal,
    };
    exitAnalyze();
    this.activeSkillContext = {
      ...(this.activeSkillContext ?? {}),
      taskDescription: goal,
    };
    return { complexity, context: content };
  }

  /**
   * design phase 콜백 — LLM에게 구현 접근법 제안을 요청한다.
   *
   * @param goal - 사용자 목표
   * @param context - analyze phase에서 수집한 컨텍스트
   * @returns 제안된 접근법 목록
   */
  private async designApproaches(
    goal: string,
    context: string,
  ): Promise<ApproachOption[]> {
    const exitDesign = this._logger.enterLayer("design", "Generating approach options");
    this.reflection.think("design", "Generating approach options...");

    const prompt = `You are a senior architect. Based on the analysis, propose 2-3 implementation approaches.

## Analysis Context
${context}

## Goal
${goal}

## Output Format
Respond with ONLY a JSON array (no markdown fences):
[
  {
    "id": 1,
    "name": "approach name",
    "description": "what this approach does",
    "pros": ["advantage 1"],
    "cons": ["disadvantage 1"],
    "estimatedComplexity": "low",
    "recommended": true
  }
]

Complexity: "low" | "medium" | "high"
Exactly one approach should have recommended=true.`;

    const response = await this.llmClient.chat([
      { role: "system", content: prompt },
      { role: "user", content: goal },
    ]);

    const content = response.content ?? "[]";
    try {
      const jsonStr = this.extractJson(content);
      const parsed = JSON.parse(jsonStr) as ApproachOption[];

      if (Array.isArray(parsed) && parsed.length > 0) {
        const recommended = parsed.find((a) => a.recommended);
        this._logger.logDecision(
          "Select implementation approach",
          parsed.map((a) => a.name),
          recommended?.name ?? parsed[0]!.name,
          `LLM recommended approach based on goal analysis`,
        );
        this.reflection.think(
          "design",
          `Generated ${parsed.length} approaches. Recommended: ${recommended?.name ?? "none"}`,
        );
        exitDesign();
        return parsed;
      }
    } catch {
      // Parse failure — fall through
    }

    // Default: single direct approach
    const defaultApproach: ApproachOption = {
      id: 1,
      name: "direct",
      description: "Direct implementation based on analysis",
      pros: ["Simple", "Fast"],
      cons: ["May miss edge cases"],
      estimatedComplexity: "medium",
      recommended: true,
    };

    this._logger.logReasoning("LLM response could not be parsed, falling back to default direct approach");
    this.reflection.think("design", "Using default direct approach");
    exitDesign();
    return [defaultApproach];
  }

  /**
   * plan phase 콜백 — HierarchicalPlanner로 3-level 실행 계획을 수립한다.
   *
   * @param goal - 사용자 목표
   * @param approach - 선택된 접근법
   * @returns 실행 계획 (ExecutionPlan 형식)
   */
  private async createPlan(
    goal: string,
    approach: ApproachOption,
  ): Promise<ExecutionPlan> {
    const exitPlan = this._logger.enterLayer("plan", `Creating plan with approach: "${approach.name}"`);
    this.reflection.think(
      "plan",
      `Creating plan with approach: "${approach.name}"`,
    );

    if (this.config.enableHierarchicalPlanning) {
      const planner = new HierarchicalPlanner({
        projectPath: this.config.projectPath,
      });

      const hPlan = await planner.createHierarchicalPlan(goal, this.llmClient);
      this.hierarchicalPlan = hPlan;

      this._logger.info("system", `Hierarchical plan: ${hPlan.tactical.length} tasks, ${hPlan.totalEstimatedIterations} iterations, ${hPlan.parallelizableGroups.length} parallel groups`);
      this.reflection.think(
        "plan",
        `Hierarchical plan created: ${hPlan.tactical.length} tactical tasks, ` +
          `${hPlan.totalEstimatedIterations} estimated iterations, ` +
          `${hPlan.parallelizableGroups.length} parallel groups`,
      );

      const executionPlan = planner.toExecutionPlan(hPlan);
      for (const step of executionPlan.steps) {
        const stepSkillContext: SkillContext = {
          ...(this.activeSkillContext ?? {}),
          taskDescription: step.goal,
          filePath: step.targetFiles[0],
        };

        const matched = this.skillLoader.matchTriggers(this.skills, stepSkillContext);
        const learned = this.skillLearner
          .getRelevantSkills({
            filePath: step.targetFiles[0],
          })
          .map((s) => this.skillLearner.toSkillDefinition(s));

        const combined = [...matched, ...learned];
        const deduped = new Map<string, SkillDefinition>();
        for (const skill of combined) {
          deduped.set(skill.id, skill);
        }

        const resolvedSkills = [...deduped.values()].map((skill) =>
          this.skillLoader.loadTemplate(skill),
        );

        step.skillIds = resolvedSkills.map((s) => s.definition.id);
        step.resolvedSkills = resolvedSkills;
        this.resolvedSkillsByStepId.set(step.id, resolvedSkills);
      }
      // Initialize PlanGraphManager for step progress tracking
      this.planGraph = PlanGraphManager.fromExecutionPlan(this.sessionId, executionPlan);
      this._logger.info("system", `PlanGraph initialized: ${executionPlan.steps.length} nodes, ${this.planGraph.getState().parallelGroups.length} parallel groups`);
      this.reflection.think("plan", `PlanGraph initialized with ${executionPlan.steps.length} nodes`);

      exitPlan();
      return executionPlan;
    }

    // Fallback: single-step plan
    this._logger.logReasoning("Hierarchical planning disabled, using single-step fallback");
    this.reflection.think("plan", "Using single-step fallback plan");

    const fallbackPlan: ExecutionPlan = {
      goal,
      steps: [
        {
          id: "step-1",
          goal: `${approach.description}: ${goal}`,
          targetFiles: [],
          role: "coder",
          readFiles: [],
          skillIds: [],
          resolvedSkills: [],
          tools: ["file_read", "file_write", "file_edit", "grep", "glob"],
          estimatedIterations: 10,
          dependsOn: [],
        },
      ],
      estimatedTokens: 50_000,
    };
    {
      const step = fallbackPlan.steps[0]!;
      const stepSkillContext: SkillContext = {
        ...(this.activeSkillContext ?? {}),
        taskDescription: step.goal,
      };
      const matched = this.skillLoader.matchTriggers(this.skills, stepSkillContext);
      const learned = this.skillLearner
        .getRelevantSkills({})
        .map((s) => this.skillLearner.toSkillDefinition(s));
      const combined = [...matched, ...learned];
      const deduped = new Map<string, SkillDefinition>();
      for (const skill of combined) deduped.set(skill.id, skill);
      const resolvedSkills = [...deduped.values()].map((skill) =>
        this.skillLoader.loadTemplate(skill),
      );
      step.skillIds = resolvedSkills.map((s) => s.definition.id);
      step.resolvedSkills = resolvedSkills;
      this.resolvedSkillsByStepId.set(step.id, resolvedSkills);
    }
    // Initialize PlanGraphManager for fallback plan too
    this.planGraph = PlanGraphManager.fromExecutionPlan(this.sessionId, fallbackPlan);
    this._logger.info("system", `PlanGraph initialized (fallback): 1 node`);

    exitPlan();
    return fallbackPlan;
  }

  /**
   * 병렬 실행 가능 여부에 따라 DAG 기반 병렬 실행 또는 단일 step 실행을 선택한다.
   *
   * StateMachine의 `handleParallel` phase에서 호출될 때:
   * - 첫 호출 시 DAG 기반 병렬 실행을 수행하고 모든 결과를 캐시한다.
   * - 이후 호출은 캐시에서 결과를 반환한다.
   *
   * StateMachine의 `handleImplement` phase에서 호출될 때:
   * - 기존 순차 실행을 그대로 사용한다.
   *
   * @param plan - 실행 계획
   * @param stepIndex - 실행할 step 인덱스
   * @param state - 현재 에이전트 상태
   * @returns step 실행 결과
   */
  private async executeStepWithParallel(
    plan: ExecutionPlan,
    stepIndex: number,
    state: AgentState,
  ): Promise<StepResult> {
    // Parallel DAG execution: if enabled and PlanGraph exists and plan has multiple steps
    const shouldRunParallel =
      this.config.enableParallelExecution &&
      this.planGraph !== null &&
      plan.steps.length > 1;

    if (!shouldRunParallel) {
      // Sequential fallback
      return this.executeStep(plan, stepIndex, state);
    }

    // If DAG execution already ran, return cached result
    if (this.parallelExecutionDone) {
      const cached = this.parallelStepResults.get(stepIndex);
      if (cached) return cached;
      // No cached result means this step was not reached by DAG (failed deps, etc.)
      return {
        stepIndex,
        phase: "implement",
        success: false,
        output: `Step ${stepIndex} was not executed (blocked by dependency failure or skipped)`,
        changedFiles: [],
        tokensUsed: 0,
        durationMs: 0,
      };
    }

    // First call triggers full DAG execution for ALL steps
 if (!this.dagOrchestrator) {
   throw new Error("DAGOrchestrator not initialized");
 }

 const agentPlan: AgentPlan = {
   tasks: plan.steps.map((s, i) => ({
     id: s.id,
     goal: s.goal,
     targetFiles: s.targetFiles,
     readFiles: s.readFiles,
     tools: s.tools,
     estimatedIterations: s.estimatedIterations,
     priority: plan.steps.length - i,
     complexity:
       (state.workingMemory.get("complexity") as
         | "simple"
         | "moderate"
         | "complex"
         | "massive"
         | "trivial") ?? "moderate",
     role: s.role ?? "coder",
     skillIds: s.skillIds ?? [],
     resolvedSkills: s.resolvedSkills ?? this.resolvedSkillsByStepId.get(s.id) ?? [],
   })),
   estimatedTokens: plan.estimatedTokens,
   estimatedDurationMs: plan.steps.reduce(
     (sum, s) => sum + s.estimatedIterations * 1000,
     0,
   ),
   dependencies: plan.steps.flatMap((s) =>
     (s.dependsOn ?? []).map((dep) => [dep, s.id] as [string, string])
   ),
   maxParallelAgents: this.config.maxParallelAgents,
 };

 const dagResult = await this.dagOrchestrator.execute(agentPlan, {
  overallGoal: plan.goal,
  projectPath: this.config.projectPath,
  projectStructure: this.config.projectPath,
 });

 for (const task of dagResult.completedTasks) {
   const stepIndex = plan.steps.findIndex(s => s.id === task.taskId);
   if (stepIndex >= 0) {
     this.parallelStepResults.set(stepIndex, {
       stepIndex,
       phase: "implement",
       success: true,
       output: task.summary,
      changedFiles: task.changedFiles.map((f) => f.path),
       tokensUsed: task.tokensUsed,
       durationMs: 0
     });
   }
 }
    this.parallelExecutionDone = true;

    // Return this step's result from cache
    const result = this.parallelStepResults.get(stepIndex);
    if (result) return result;

    return {
      stepIndex,
      phase: "implement",
      success: false,
      output: `Step ${stepIndex} was not executed during DAG execution`,
      changedFiles: [],
      tokensUsed: 0,
      durationMs: 0,
    };
  }

  /**
   * PlanGraph DAG 기반 병렬 step 실행.
   *
   * PlanGraphManager의 의존성 그래프를 따라:
   * 1. 의존성이 모두 완료된 ready 노드를 가져온다.
   * 2. maxParallelAgents만큼 동시에 실행한다.
   * 3. 완료되면 의존 노드를 ready로 전환하고 반복한다.
   * 4. 모든 노드가 종료 상태가 될 때까지 반복한다.
   *
   * @param plan - 실행 계획
   * @param state - 현재 에이전트 상태
   */
  private async executeStepsWithDAG(
    plan: ExecutionPlan,
    state: AgentState,
  ): Promise<void> {
    if (!this.planGraph) return;

    const maxConcurrent = this.config.maxParallelAgents;

    this._logger.info("system", `DAG parallel execution started: ${plan.steps.length} steps, max ${maxConcurrent} concurrent`);
    this.reflection.think("implement", `Starting DAG-based parallel execution: ${plan.steps.length} steps, max ${maxConcurrent} concurrent`);

    while (true) {
      // Check abort
      if (this.abortController.signal.aborted) {
        this._logger.info("system", "DAG parallel execution aborted");
        break;
      }

      // Get nodes that are ready (all dependencies completed)
      const readyNodes = this.planGraph.getReadyNodes();

      if (readyNodes.length === 0) {
        // Check if all done or stuck
        if (this.planGraph.isComplete()) {
          this._logger.info("system", "DAG parallel execution: all nodes complete");
          break;
        }

        // If there are running nodes, wait for them to finish
        const graphState = this.planGraph.getState();
        if (graphState.runningNodes.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }

        // No ready, no running = deadlock (all remaining nodes are blocked/failed)
        this._logger.warn("system", "DAG parallel execution: deadlock — no ready or running nodes, but graph not complete");
        break;
      }

      // Take up to maxConcurrent ready nodes
      const batch = readyNodes.slice(0, maxConcurrent);

      this._logger.info("system", `DAG batch: executing ${batch.length} steps in parallel [${batch.map(n => n.id).join(", ")}]`);
      this.reflection.think(
        "implement",
        `Parallel batch: ${batch.map(n => `"${n.goal}" (${n.id})`).join(", ")}`,
      );

      // Execute batch in parallel using Promise.allSettled
      await Promise.allSettled(
        batch.map(async (node) => {
          const stepIndex = plan.steps.findIndex(s => s.id === node.id);
          if (stepIndex === -1) {
            this._logger.warn("system", `DAG: node "${node.id}" not found in plan steps`);
            return;
          }

          try {
            // executeStep already handles markRunning/markCompleted/markFailed
            const stepResult = await this.executeStep(plan, stepIndex, state);

            // Cache the result
            this.parallelStepResults.set(stepIndex, stepResult);

            // Update state tracking
            state.currentStepIndex = Math.max(state.currentStepIndex, stepIndex + 1);
          } catch (err) {
            // executeStep should not throw (it handles errors internally),
            // but just in case, cache a failure result
            const errorMessage = err instanceof Error ? err.message : String(err);
            this._logger.error("error", `DAG: unexpected error executing step ${stepIndex}: ${errorMessage}`);

            this.parallelStepResults.set(stepIndex, {
              stepIndex,
              phase: "implement",
              success: false,
              output: `Unexpected error: ${errorMessage}`,
              changedFiles: [],
              tokensUsed: 0,
              durationMs: 0,
            });
          }
        })
      );

      // Checkpoint after each parallel batch
      await this.checkpoint(state.currentStepIndex);

      // Log progress
      const progress = this.planGraph.getProgress();
      this._logger.info("system", `DAG progress: ${progress.completed}/${progress.total} (${progress.percent}%)`);
    }

    // Final summary
    const progress = this.planGraph.getProgress();
    const graphState = this.planGraph.getState();
    this._logger.info(
      "system",
      `DAG parallel execution complete: ${progress.completed}/${progress.total} succeeded, ${graphState.failedNodes.length} failed, ${graphState.skippedNodes.length} skipped`,
    );
    this.reflection.think(
      "implement",
      `DAG execution complete: ${progress.completed}/${progress.total} steps, ${graphState.failedNodes.length} failed`,
    );
  }

  /**
   * implement phase 콜백 — AgentLoop로 개별 step을 실행한다.
   *
   * @param plan - 실행 계획
   * @param stepIndex - 실행할 step 인덱스
   * @param state - 현재 에이전트 상태
   * @returns step 실행 결과
   */
  private async executeStep(
    plan: ExecutionPlan,
    stepIndex: number,
    state: AgentState,
  ): Promise<StepResult> {
    const step = plan.steps[stepIndex];
    if (!step) {
      this._logger.warn("error", `Step ${stepIndex} not found in plan`);
      return {
        stepIndex,
        phase: "implement",
        success: false,
        output: `Step ${stepIndex} not found in plan`,
        changedFiles: [],
        tokensUsed: 0,
        durationMs: 0,
      };
    }

    const exitImplement = this._logger.enterLayer("implement", `Step ${stepIndex + 1}/${plan.steps.length}: "${step.goal}"`);
    this.reflection.think(
      "implement",
      `Executing step ${stepIndex + 1}/${plan.steps.length}: "${step.goal}"`,
    );
    const stepSkillContext: SkillContext = {
      ...(this.activeSkillContext ?? {}),
      taskDescription: step.goal,
      filePath: step.targetFiles[0],
    };
    // Mark step as running in PlanGraph
    const stepId = step.id;
    if (this.planGraph) {
      try {
        this.planGraph.markRunning(stepId);
        this._logger.info("system", `PlanGraph: node "${stepId}" → running`);
      } catch (pgErr) {
        // Node may not be in ready state (e.g., if called out of order)
        this._logger.warn("system", `PlanGraph: failed to mark "${stepId}" running: ${pgErr instanceof Error ? pgErr.message : String(pgErr)}`);
      }
    }

    // Snapshot target files before modification
    await this.snapshotFiles(step.targetFiles);

    // ─── Speculative Execution (auto-activates when complexity >= complex) ───
    const specComplexity = state.workingMemory.get("complexity") as string | undefined;
    const specAutoActivate = ["complex", "massive"].includes(specComplexity ?? "");
    if (this.config.enableSpeculative || specAutoActivate) {
      try {
        this._logger.info("system", `Speculative execution enabled for step ${stepIndex + 1}`);
        this.reflection.think("implement", `Using speculative execution for step ${stepIndex + 1}`);

        const specExecutor = new SpeculativeExecutor({
          maxApproaches: this.config.speculativeMaxApproaches,
          approachTimeout: 120_000,
          minQualityThreshold: 60,
          byokConfig: this.config.byokConfig,
          projectPath: this.config.projectPath,
        });

        // Forward speculative events
        const specEvents = [
          "speculative:start",
          "speculative:approach:start",
          "speculative:approach:complete",
          "speculative:evaluation",
          "speculative:complete",
          "speculative:timeline",
        ] as const;
        for (const eventName of specEvents) {
          specExecutor.on(eventName, (...args: unknown[]) => {
            this.emit(eventName, ...args);
          });
        }
        specExecutor.on("speculative:timeline", (payload) => {
          this.emit("agent:event", {
            kind: "agent:reasoning_timeline",
            source: "speculative",
            taskId: payload.taskId,
            text: payload.text,
          });
        });
        // Build codebase context summary for speculative executor
        let codebaseContextSummary = "";
        if (this.codebaseContext) {
          const stats = this.codebaseContext.getStats();
          codebaseContextSummary = `Project: ${stats.totalFiles} files, ${stats.totalSymbols} symbols. Path: ${this.config.projectPath}`;
        }

        const specResult: SpeculativeResult = await specExecutor.execute(
          step.goal,
          this.config.toolExecutor,
          codebaseContextSummary,
        );

        if (specResult.winner) {
          this._logger.info(
            "system",
            `Speculative execution winner: "${specResult.winner.approach.strategy}" (quality: ${specResult.winner.qualityScore}, tokens: ${specResult.winner.tokensUsed})`,
          );
          this.reflection.think(
            "implement",
            `Speculative winner: ${specResult.winner.approach.strategy} — ${specResult.selectionReason}`,
          );

          // Apply winner's file changes
          for (const [filePath] of specResult.winner.changes) {
            this.changedFiles.add(filePath);
          }

          // Update PlanGraph
          if (this.planGraph) {
            try {
              this.planGraph.markCompleted(
                stepId,
                `Speculative execution (${specResult.winner.approach.strategy}): quality ${specResult.winner.qualityScore}`,
                [...specResult.winner.changes.keys()],
                { input: specResult.totalTokensUsed, output: 0 },
              );
              this._logger.info("system", `PlanGraph: node "${stepId}" → completed (speculative)`);
            } catch (pgErr) {
              this._logger.warn("system", `PlanGraph: failed to update "${stepId}": ${pgErr instanceof Error ? pgErr.message : String(pgErr)}`);
            }
          }

          // Checkpoint and return
          await this.checkpoint(stepIndex);
          exitImplement();
          return {
            stepIndex,
            phase: "implement",
            success: specResult.winner.success,
            output: `Speculative execution (${specResult.winner.approach.strategy}): ${specResult.selectionReason}`,
            changedFiles: [...specResult.winner.changes.keys()],
            tokensUsed: specResult.totalTokensUsed,
            durationMs: specResult.winner.durationMs,
          };
        }

        // No winner — fall through to normal AgentLoop execution
        this._logger.info("system", "Speculative execution: no winner found, falling back to normal execution");
        this.reflection.think("implement", "Speculative execution produced no winner — falling back to AgentLoop");
        if (specResult.learnings.length > 0) {
          this.reflection.think(
            "implement",
            `Speculative learnings: ${specResult.learnings.join("; ")}`,
          );
        }
      } catch (specErr) {
        this._logger.warn(
          "system",
          `Speculative execution failed (falling back to normal): ${specErr instanceof Error ? specErr.message : String(specErr)}`,
        );
      }
    }

    // ─── Normal AgentLoop Execution ─────────────────────────────
    // ─────────────────────────────────────────
    // SubAgent execution
    // ─────────────────────────────────────────

    const startMs = Date.now();

 const routing = routeSubAgent({
   role: step.role ?? "coder",
  complexity:
    (state.workingMemory.get("complexity") as
      | "trivial"
      | "simple"
      | "moderate"
      | "complex"
      | "massive") ?? "moderate",
   fileCount: step.targetFiles.length,
   hasTests: step.tools.includes("test_run"),
   isCriticalPath: false,
   previousFailures: 0,
   parentModelTier: "NORMAL"
 })
const role: SubAgentRole = step.role ?? "coder";
 const tier = routing.tier;

    const subAgent = new SubAgent({
      taskId: step.id,
      goal: step.goal,
      targetFiles: step.targetFiles,
      readFiles: step.readFiles,
      maxIterations: this.config.maxIterations,
     totalTokenBudget: this.getSubAgentTokenBudget(),
      projectPath: this.config.projectPath,
      byokConfig: this.config.byokConfig,
      tools: step.tools,
      createToolExecutor: () => this.config.toolExecutor,
      role,
      parentModelTier: tier,
    });
const agentRole = subAgent.role;
   // ─────────────────────────────────────────
    // SubAgent lifecycle forwarding (CLI stream)
    // ─────────────────────────────────────────

 subAgent.on("subagent:phase", (_taskId, phase) => {
   this.emit("agent:subagent_phase", {
     role: agentRole,
     phase,
     taskId: step.id,
     goal: step.goal,
   });
 });
    // ─────────────────────────────────────────
    // Forward SubAgent events → ExecutionEngine
    // ─────────────────────────────────────────

    subAgent.on("event", (event) => {
      this.emit("agent:event", event);
    });
    const subResult = await subAgent.run({
      overallGoal: plan.goal,
      taskGoal: step.goal,
      targetFiles: step.targetFiles,
      readFiles: step.readFiles,
      projectStructure: this.config.projectPath,
      skillContext: stepSkillContext,
      resolvedSkills: step.resolvedSkills ?? this.resolvedSkillsByStepId.get(step.id) ?? [],
      totalTasks: plan.steps.length,
      completedTasks: [],
      runningTasks: [],
    });

    const durationMs = Date.now() - startMs;

const stepChangedFiles = new Set(
  subResult.changedFiles.map((f: any) =>
    typeof f === "string" ? f : f.path
  )
);

    const loopUsage = {
  input: subResult.tokensUsed?.input ?? 0,
  output: subResult.tokensUsed?.output ?? 0,
    };

    const success = subResult.success;

 for (const file of this.changedFiles) {
   if (step.targetFiles.length === 0) continue;
   if (step.targetFiles.some(f => file.endsWith(f))) {
     stepChangedFiles.add(file);
   }
 }



    // Update PlanGraph with step outcome
    if (this.planGraph) {
      try {
        if (success) {
          this.planGraph.markCompleted(
            stepId,
            subResult.summary,
            [...stepChangedFiles],
            { input: loopUsage.input, output: loopUsage.output },
          );
          this._logger.info("system", `PlanGraph: node "${stepId}" → completed`);
        } else {
          const errorMsg = subResult.error ?? "SubAgent failed";
          this.planGraph.markFailed(stepId, errorMsg);
          this._logger.info("system", `PlanGraph: node "${stepId}" → failed`);
        }
      } catch (pgErr) {
        this._logger.warn("system", `PlanGraph: failed to update "${stepId}": ${pgErr instanceof Error ? pgErr.message : String(pgErr)}`);
      }

      // Log plan progress after each step
      const progress = this.planGraph.getProgress();
      this._logger.info("system", `PlanGraph progress: ${progress.completed}/${progress.total} (${progress.percent}%)`);
    }

    this._logger.logDecision(
      `Step ${stepIndex + 1} outcome`,
      ["succeeded", "failed"],
      success ? "succeeded" : "failed",
      `SubAgent execution result`,
    );
    this.reflection.think(
      "implement",
      `Step ${stepIndex + 1} ${success ? "succeeded" : "failed"}: ${
        subResult.summary
      }`,
    );

    // Checkpoint after step completes (success or failure)
    await this.checkpoint(stepIndex);

    exitImplement();
    return {
      stepIndex,
      phase: "implement",
      success,
      output: subResult.summary,
      changedFiles: [...stepChangedFiles],
      tokensUsed: loopUsage.input + loopUsage.output,
      durationMs,
    };
  }

  /**
   * verify phase 콜백 — SelfReflection.deepVerify로 6-dimension 검증을 수행한다.
   *
   * @param state - 현재 에이전트 상태
   * @returns 검증 결과 (StateMachine VerifyResult 형식)
   */
  private async verifyWork(state: AgentState): Promise<VerifyResult> {
    const exitVerify = this._logger.enterLayer("verify", "Starting deep verification");
    this.reflection.think("verify", "Starting deep verification...");

    if (!this.config.enableDeepVerify || this.changedFiles.size === 0) {
      this._logger.logReasoning(
        "Deep verify skipped",
        ["run deep verify", "skip deep verify"],
        "skip deep verify",
        undefined,
        "Deep verify disabled or no changed files",
      );
      this.reflection.think(
        "verify",
        "Deep verify skipped (disabled or no changed files)",
      );
      exitVerify();


      return {
        verdict: "pass",
        checks: {
          buildSuccess: true,
          typesSafe: true,
          testsPass: true,
          noRegressions: true,
          followsPatterns: true,
          securityClean: true,
        },
        issues: [],
        suggestions: [],
        confidence: 1.0,
      };
    }

    // Collect current file contents
    const changedFileContents = new Map<string, string>();
    for (const filePath of this.changedFiles) {
      try {
        const content = await readFile(filePath, "utf-8");
        changedFileContents.set(filePath, content);
      } catch {
        // File may have been deleted
        changedFileContents.set(filePath, "");
      }
    }

    // Gather project patterns from codebase context
    const patterns: string[] = [];
    if (this.codebaseContext) {
      const stats = this.codebaseContext.getStats();
      if (stats.totalFiles > 0) {
        patterns.push(`Project has ${stats.totalFiles} files`);
      }
    }

    // Run deep verification
    const deepResult = await this.reflection.deepVerify(
      state.goal,
      changedFileContents,
      this.originalFiles,
      patterns,
      async (prompt: string) => {
        const response = await this.llmClient.chat([
          { role: "user", content: prompt },
        ]);
        return response.content ?? "";
      },
    );

    this.lastVerifyResult = deepResult;

    // Cross-check with PlanGraph completion status
    if (this.planGraph) {
      const pgComplete = this.planGraph.isComplete();
      const progress = this.planGraph.getProgress();
      this._logger.info("system", `PlanGraph completion check: complete=${pgComplete}, ${progress.completed}/${progress.total} nodes`);

      if (!pgComplete && deepResult.verdict === "pass") {
        this.reflection.think(
          "verify",
          `Warning: Deep verify passed but PlanGraph shows ${progress.total - progress.completed} incomplete nodes`,
        );
      }
    }

    this._logger.logDecision(
      "Verification verdict",
      ["pass", "warn", "fail"],
      deepResult.verdict,
      `Score: ${deepResult.overallScore}, confidence: ${deepResult.confidence}`,
    );
    this.reflection.think(
      "verify",
      `Deep verification: ${deepResult.verdict} (score: ${deepResult.overallScore}, confidence: ${deepResult.confidence})`,
    );

    // ─── Debate Orchestrator (optional — auto-activates when complexity >= moderate) ───
    const debateComplexity = state.workingMemory.get("complexity") as string | undefined;
    const debateAutoActivate = ["moderate", "complex", "massive"].includes(debateComplexity ?? "");
    const shouldDebate = (this.config.enableDebate || debateAutoActivate) && this.changedFiles.size > 0;
    if (shouldDebate) {
      try {
        this._logger.info("system", "Running multi-agent debate verification...");
        this.reflection.think("verify", "Starting debate orchestrator for code review...");

        const debateOrchestrator = DebateOrchestrator.create({
          projectPath: this.config.projectPath,
          byokConfig: this.config.byokConfig,
          toolExecutor: this.config.toolExecutor,
        });

        // Forward debate events
        const debateEvents = [
          "debate:start",
          "debate:round:start",
          "debate:round:end",
          "debate:coder",
          "debate:reviewer",
          "debate:revision",
          "debate:verifier",
          "debate:pass",
          "debate:fail",
          "debate:token_usage",
          "debate:abort",
        ] as const;
        for (const eventName of debateEvents) {
          debateOrchestrator.on(eventName, (...args: unknown[]) => {
            this.emit(eventName, ...args);
          });
        }

        const changedFilesSummary = [...this.changedFiles]
          .map((f) => {
            const content = changedFileContents.get(f) ?? "";
            return `## ${f}\n${content.slice(0, 2000)}`;
          })
          .join("\n\n");

        const debateResult = await debateOrchestrator.debate(
          state.goal,
          changedFilesSummary,
        );

        this._logger.info(
          "system",
          `Debate result: score=${debateResult.finalScore}, success=${debateResult.success}, rounds=${debateResult.rounds.length}`,
        );
        this.reflection.think(
          "verify",
          `Debate: ${debateResult.success ? "PASSED" : "FAILED"} (score: ${debateResult.finalScore}, ${debateResult.rounds.length} round(s))`,
        );

        // If debate fails and deep verify passed, downgrade to "concern"
        if (!debateResult.success && deepResult.verdict === "pass") {
          deepResult.verdict = "concern";
          const reviewerIssues = debateResult.rounds
            .flatMap((r) => r.issues)
            .filter((i) => i.severity === "critical" || i.severity === "major");
          deepResult.suggestedFixes.push(
            ...reviewerIssues.map((i) => ({
              dimension: "correctness" as const,
              severity: i.severity === "critical" ? ("critical" as const) : ("high" as const),
              description: `[debate] ${i.description}`,
              file: i.file,
              autoFixable: false,
            })),
          );
          this.reflection.think(
            "verify",
            `Debate downgraded verdict to "concern" due to ${reviewerIssues.length} critical/major issue(s)`,
          );
        }
      } catch (debateErr) {
        this._logger.warn(
          "system",
          `Debate orchestrator failed (continuing): ${debateErr instanceof Error ? debateErr.message : String(debateErr)}`,
        );
      }
    }

    // ─── Security Scanner (optional) ──────────────────────────
    if (this.config.enableSecurityScan && this.changedFiles.size > 0) {
      try {
        this._logger.info("system", "Running security scan on changed files...");
        this.reflection.think("verify", "Running security scanner...");

        const scanner = new SecurityScanner({
          projectPath: this.config.projectPath,
        });

        const changedFileList = [...this.changedFiles];
        const scanResult: SecurityScanResult = await scanner.scan(changedFileList);

        this._logger.info(
          "system",
          `Security scan: passed=${scanResult.passed}, findings=${scanResult.summary.total} (critical=${scanResult.summary.critical}, high=${scanResult.summary.high})`,
        );
        this.reflection.think(
          "verify",
          `Security scan: ${scanResult.passed ? "PASSED" : "FAILED"} — ${scanResult.summary.total} finding(s) (${scanResult.summary.critical} critical, ${scanResult.summary.high} high)`,
        );

        // If critical findings found, add them to suggestedFixes and downgrade verdict
        if (scanResult.summary.critical > 0 || scanResult.summary.high > 0) {
          const securityFindings = scanResult.findings
            .filter((f) => f.severity === "critical" || f.severity === "high");
          deepResult.suggestedFixes.push(
            ...securityFindings.map((f) => ({
              dimension: "security" as const,
              severity: f.severity === "critical" ? ("critical" as const) : ("high" as const),
              description: `[security] ${f.rule} in ${f.file}:${f.line} — ${f.message}`,
              file: f.file,
              autoFixable: false,
            })),
          );

          if (scanResult.summary.critical > 0 && deepResult.verdict !== "fail") {
            deepResult.verdict = "fail";
            this.reflection.think(
              "verify",
              `Security scanner escalated verdict to "fail" due to ${scanResult.summary.critical} critical finding(s)`,
            );
          } else if (deepResult.verdict === "pass") {
            deepResult.verdict = "concern";
            this.reflection.think(
              "verify",
              `Security scanner downgraded verdict to "concern" due to high-severity findings`,
            );
          }
        }
      } catch (scanErr) {
        this._logger.warn(
          "system",
          `Security scan failed (continuing): ${scanErr instanceof Error ? scanErr.message : String(scanErr)}`,
        );
      }
    }

    // ─── Doc Intelligence (optional) ──────────────────────────
    if (this.config.enableDocGeneration && this.changedFiles.size > 0) {
      try {
        this._logger.info("system", "Running documentation intelligence...");
        this.reflection.think("verify", "Analyzing documentation coverage...");

        const docIntel = new DocIntelligence({
          projectPath: this.config.projectPath,
        });

        const docCoverage: DocCoverage = docIntel.analyzeCoverage(changedFileContents);

        this._logger.info(
          "system",
          `Doc coverage: ${docCoverage.coveragePercent}% (grade: ${docCoverage.grade}), ${docCoverage.missing.length} undocumented symbol(s)`,
        );
        this.reflection.think(
          "verify",
          `Documentation: ${docCoverage.coveragePercent}% coverage (grade ${docCoverage.grade}), ${docCoverage.missing.length} missing`,
        );

        // If coverage is below D grade, add as suggestedFix (non-blocking)
        if (docCoverage.grade === "D" || docCoverage.grade === "F") {
          const missingSymbols = docCoverage.missing
            .slice(0, 10)
            .map((m) => `${m.symbolName} (${m.symbolType}) in ${m.filePath}:${m.line}`);
          deepResult.suggestedFixes.push({
            dimension: "quality" as const,
            severity: "low" as const,
            description: `Documentation coverage is ${docCoverage.grade} (${docCoverage.coveragePercent}%). Missing JSDoc for: ${missingSymbols.join(", ")}`,
            autoFixable: false,
          });
          this.reflection.think(
            "verify",
            `Low doc coverage (${docCoverage.grade}) — added suggestion for ${missingSymbols.length} symbol(s)`,
          );
        }
      } catch (docErr) {
        this._logger.warn(
          "system",
          `Doc intelligence failed (continuing): ${docErr instanceof Error ? docErr.message : String(docErr)}`,
        );
      }
    }

    exitVerify();

    // Best-effort learned skill persistence hook
    try {
      const syntheticAnalysis = {
        errorPatterns: deepResult.suggestedFixes
          .filter((f) => !!f.description)
          .map((f) => ({
            message: f.description,
            resolution: f.description,
            frequency: 1,
            type: "VerificationIssue",
            tool: "verify",
          })),
        toolPatterns: [],
      } as unknown as import("./memory-updater.js").RunAnalysis;

      const learned = this.skillLearner.extractSkillFromRun(
        syntheticAnalysis,
        this.sessionId,
      );
      if (learned) {
        await this.skillLearner.save();
      }
    } catch (err) {
      this._logger.warn(
        "system",
        `Skill learn/save failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Map DeepVerifyResult → VerifyResult
    return this.mapVerifyResult(deepResult);
  }

  /**
   * fix phase 콜백 — AgentLoop로 에러를 수정한다.
   *
   * @param errors - 수정할 에러 목록
   * @param state - 현재 에이전트 상태
   * @returns 수정 시도 결과
   */
  private async fixErrors(
    errors: StepError[],
    state: AgentState,
  ): Promise<StepResult> {
    const exitFix = this._logger.enterLayer("fix", `Fixing ${errors.length} error(s)`);
    const errorDescriptions = errors
      .map(
        (e, i) =>
          `${i + 1}. [${e.phase}] ${e.error}${e.suggestedFix ? ` (suggested: ${e.suggestedFix})` : ""}`,
      )
      .join("\n");

    this._logger.info("error", `Errors to fix: ${errors.length}`, {
      errors: errors.map((e) => ({ phase: e.phase, error: e.error })),
    });
    this.reflection.think(
      "fix",
      `Attempting to fix ${errors.length} error(s):\n${errorDescriptions}`,
    );

    const fixPrompt = `You are fixing errors found during verification. Address each issue:

## Errors to Fix
${errorDescriptions}

## Changed Files
${[...this.changedFiles].join(", ")}

## Instructions
- Fix each error by reading the affected file and making corrections
- Run relevant build/lint checks after each fix
- Be precise — only change what's needed to fix the issue
- If an error seems unfixable, explain why`;

    const loop = this.createAgentLoop(fixPrompt);
    this.wireAgentLoopEvents(loop);

    const startMs = Date.now();
    const termination = await loop.run(
      `Fix the following errors:\n${errorDescriptions}`,
    );
    const durationMs = Date.now() - startMs;

    this.lastTermination = termination;
    const loopUsage = loop.getTokenUsage();
    const success = termination.reason === "GOAL_ACHIEVED";

    this._logger.logDecision(
      "Fix attempt result",
      ["succeeded", "failed"],
      success ? "succeeded" : "failed",
      `Fix loop terminated with reason: ${termination.reason}`,
    );
    this.reflection.think(
      "fix",
      `Fix attempt ${success ? "succeeded" : "failed"}: ${termination.reason}`,
    );

    exitFix();
    return {
      stepIndex: state.currentStepIndex,
      phase: "fix",
      success,
      output:
        termination.reason === "GOAL_ACHIEVED"
          ? (termination as { reason: "GOAL_ACHIEVED"; summary: string }).summary
          : `Fix attempt ended: ${termination.reason}`,
      changedFiles: [...this.changedFiles],
      tokensUsed: loopUsage.input + loopUsage.output,
      durationMs,
    };
  }

  /**
   * replan phase 콜백 — HierarchicalPlanner.replan으로 재계획을 수립한다.
   *
   * @param state - 현재 에이전트 상태
   * @returns 새로운 실행 계획
   */
  private async replanWork(state: AgentState): Promise<ExecutionPlan> {
    const exitReplan = this._logger.enterLayer("replan", `Re-planning due to ${state.errors.length} error(s)`);
    this.reflection.think(
      "replan",
      `Re-planning due to ${state.errors.length} error(s)`,
    );

    if (this.config.enableHierarchicalPlanning && this.hierarchicalPlan) {
      const planner = new HierarchicalPlanner({
        projectPath: this.config.projectPath,
      });

      const errorDescriptions = state.errors
        .map((e) => e.error)
        .join("; ");

      const affectedTaskIds = state.errors
        .map((e) => state.plan?.steps[e.stepIndex]?.id)
        .filter((id): id is string => !!id);

      const replanResult = await planner.replan(
        this.hierarchicalPlan,
        {
          type: "error",
          description: errorDescriptions,
          affectedTaskIds,
          severity: "major",
        },
        this.llmClient,
      );

      this._logger.logDecision(
        "Replan strategy",
        ["retry", "simplify", "restructure", "abort"],
        replanResult.strategy,
        replanResult.reason,
      );
      this.reflection.think(
        "replan",
        `Re-plan strategy: ${replanResult.strategy} — ${replanResult.reason}`,
      );

      // Convert modified tasks back to ExecutionPlan
      const newSteps = replanResult.modifiedTasks.map((task) => ({
        id: task.id,
        goal: task.description,
        targetFiles: task.targetFiles,
        readFiles: task.readFiles,
        tools: task.toolStrategy,
        estimatedIterations: task.estimatedIterations,
        dependsOn: task.dependsOn,
      }));

      const newPlan: ExecutionPlan = {
        goal: state.goal,
        steps: newSteps,
        estimatedTokens: newSteps.length * 10_000,
      };

      // Re-initialize PlanGraph for the new plan
      this.planGraph = PlanGraphManager.fromExecutionPlan(this.sessionId, newPlan);
      this._logger.info("system", `PlanGraph re-initialized (replan): ${newSteps.length} nodes`);

      // Checkpoint after replan completes (save new plan state)
      await this.checkpoint(state.currentStepIndex);

      exitReplan();
      return newPlan;
    }

    // Fallback: single retry step
    this._logger.logReasoning("Hierarchical replanning unavailable, using single-step fallback");
    this.reflection.think("replan", "Using fallback single-step replan");

    const fallbackReplan: ExecutionPlan = {
      goal: state.goal,
      steps: [
        {
          id: "replan-step-1",
          goal: `Retry: ${state.goal} (previous errors: ${state.errors.map((e) => e.error).join("; ")})`,
          targetFiles: [],
          readFiles: [],
          tools: ["file_read", "file_write", "file_edit", "grep", "glob"],
          estimatedIterations: 10,
          dependsOn: [],
        },
      ],
      estimatedTokens: 50_000,
    };

    // Re-initialize PlanGraph for fallback replan
    this.planGraph = PlanGraphManager.fromExecutionPlan(this.sessionId, fallbackReplan);
    this._logger.info("system", `PlanGraph re-initialized (fallback replan): 1 node`);

    // Checkpoint after fallback replan completes
    await this.checkpoint(state.currentStepIndex);

    exitReplan();
    return fallbackReplan;
  }

  /**
   * delegate phase 콜백 — 사용자에게 질문을 전달하고 응답을 대기한다.
   *
   * 현재 구현에서는 기본 응답을 반환한다.
   * 실제 환경에서는 이벤트를 emit하고 외부 응답을 대기해야 한다.
   *
   * @param question - 사용자에게 전달할 질문
   * @returns 사용자 응답
   */
  private async delegateToUser(question: string): Promise<string> {
    this.reflection.think("delegate", `Delegating to user: "${question}"`);

    // Emit event for external handling
    this.emit("engine:delegate", question);

    // In a real implementation, this would wait for user input.
    // For now, return a default that selects the recommended approach.
    return "1";
  }

  // ─── Helpers ───────────────────────────────────────────────────

  /**
   * 변경 전 파일 내용을 스냅샷으로 저장한다.
   * 이미 스냅샷이 있는 파일은 건너뛴다 (최초 원본만 보존).
   *
   * @param files - 스냅샷할 파일 경로 목록
   */
  private async snapshotFiles(files: string[]): Promise<void> {
    for (const file of files) {
      if (this.originalFiles.has(file)) continue;

      try {
        const content = await readFile(file, "utf-8");
        this.originalFiles.set(file, content);
      } catch {
        // File doesn't exist yet — no snapshot needed
      }
    }
  }


 /**
  * DAGOrchestrator가 호출하는 Agent worker
  */
 private async spawnAgent(
   task: PlannedTask,
  context: SubAgentContext,
  _signal?: AbortSignal
 ): Promise<TaskResult> {

   const routing = routeSubAgent({
     role: task.role ?? "coder",
     complexity: this.globalComplexity,
     fileCount: task.targetFiles.length,
     hasTests: task.tools?.includes("test_run") ?? false,
     isCriticalPath: false,
     previousFailures: 0,
     parentModelTier: "NORMAL"
   });

   const role: SubAgentRole = task.role ?? "coder";

   const subAgent = new SubAgent({
     taskId: task.id,
     goal: task.goal,
     targetFiles: task.targetFiles,
     readFiles: task.readFiles,
     maxIterations: this.config.maxIterations,
     totalTokenBudget: this.getSubAgentTokenBudget(),
     projectPath: this.config.projectPath,
     byokConfig: this.config.byokConfig,
     tools: task.tools,
     createToolExecutor: () => this.config.toolExecutor,
     role,
     parentModelTier: routing.tier,
   });

   const result = await subAgent.run({
     overallGoal: context.overallGoal,
     taskGoal: context.taskGoal ?? task.goal,
     targetFiles: context.targetFiles ?? task.targetFiles,
     readFiles: context.readFiles ?? task.readFiles,
     projectStructure: context.projectStructure,
     skillContext: context.skillContext ?? {
       taskDescription: task.goal,
       filePath: task.targetFiles[0],
     },
     resolvedSkills: context.resolvedSkills ?? task.resolvedSkills ?? [],
     totalTasks: 1,
     completedTasks: [],
     runningTasks: [],
   });

   return {
     taskId: task.id,
     summary: result.summary,
    changedFiles: result.changedFiles.map((file) => ({
      path: typeof file === "string" ? file : file.path,
      diff: "",
    })),
     tokensUsed:
       (result.tokensUsed?.input ?? 0) +
       (result.tokensUsed?.output ?? 0),
     iterations: this.config.maxIterations,
     usedSkillIds: task.skillIds ?? [],
   };
 }
  /**
   * 개별 step 실행을 위한 AgentLoop 인스턴스를 생성한다.
   *
   * @param systemPrompt - step별 시스템 프롬프트
   * @returns 새 AgentLoop 인스턴스
   */
  private createAgentLoop(systemPrompt: string): AgentLoop {
    // Merge base tool definitions with MCP tool definitions
    // Tool filtering to avoid token explosion
    const baseTools = this.config.toolExecutor.definitions;

    const mcpToolsFiltered = this.mcpToolDefinitions.filter((t) =>
     true
    );

    const tools: ToolDefinition[] = [
      ...baseTools,
      ...mcpToolsFiltered,
    ];

    // Wrap tool executor to add sandbox validation and MCP tool routing
    const baseExecutor = this.config.toolExecutor;
    const sandboxMgr = this.sandboxManager;
    const mcpCli = this.mcpClient;
    const mcpToolDefs = this.mcpToolDefinitions;

    const wrappedExecutor: ToolExecutor = {
      definitions: tools,
      execute: async (call, abortSignal) => {
    let args: Record<string, unknown> = {};

       let release: (() => void) | null = null;

        try {
          // Parse arguments to object if needed
          try {
            args = typeof call.arguments === "string"
              ? (JSON.parse(call.arguments) as Record<string, unknown>)
              : call.arguments;
          } catch {
            return {
              tool_call_id: call.id,
              name: call.name,
              output: "[Error] invalid tool arguments JSON",
              success: false,
              durationMs: 0,
            };
          }
        

          const targetFile =
            typeof args?.path === "string"
              ? args.path
              : typeof args?.file === "string"
              ? args.file
              : null;

          if (targetFile && this.isFileMutationTool(call.name)) {
            release = await this.workspaceLock.acquire(targetFile);
          }
          // Sandbox pre-validation
          if (sandboxMgr) {
            const validation = sandboxMgr.validateToolCall(call.name, args);
            if (!validation.allowed) {
              return {
                tool_call_id: call.id,
                name: call.name,
                output: `[Sandbox blocked] ${validation.violations.join("; ")}`,
                success: false,
                durationMs: 0,
              };
            }
          }

          // Route MCP tool calls to MCPClient (check MCP registry, not string pattern)
          if (mcpCli && mcpToolDefs.some((t) => t.name === call.name)) {
            const MCP_TIMEOUT = 20000;

            const timeout = new Promise((_, reject) =>
              setTimeout(() => reject(new Error("MCP timeout")), MCP_TIMEOUT)
            );

  try {
    return (await Promise.race([
      mcpCli.callToolAsYuan(call.name, args, call.id),
      timeout,
    ])) as ToolResult;
  } catch (err) {
    return {
      tool_call_id: call.id,
      name: call.name,
      output: `[MCP error] ${err instanceof Error ? err.message : String(err)}`,
      success: false,
      durationMs: MCP_TIMEOUT,
    };
  }
          }

          // Default: use base executor
          return await baseExecutor.execute(call, abortSignal);
        } finally {
          if (release) {
            release();
          }
        }
     },
    };

    return new AgentLoop({
  abortSignal: this.abortController.signal,
  config: {
    byok: this.config.byokConfig,
        loop: {
          model: "coding",
          maxIterations: this.config.maxIterations,
          maxTokensPerIteration: 16_384,
          totalTokenBudget: this.config.totalTokenBudget,
          tools,
          systemPrompt,
          projectPath: this.config.projectPath,
        },
      },
      toolExecutor: wrappedExecutor,
      governorConfig: this.config.governorConfig ?? { planTier: "PRO" },
      contextConfig: this.config.contextConfig,
      approvalConfig: this.config.approvalConfig,
      approvalHandler: this.config.approvalHandler,
      autoFixConfig: this.config.autoFixConfig,
    });
  }

  /**
   * AgentLoop 이벤트를 ExecutionEngine 이벤트로 전파한다.
   *
   * @param loop - 이벤트를 연결할 AgentLoop 인스턴스
   */
  private wireAgentLoopEvents(loop: AgentLoop): void {
    loop.on("event", (event: { kind: string; [key: string]: unknown }) => {
      switch (event.kind) {
        case "agent:text_delta":
          this.emit("text_delta", event.text as string);
          break;

        case "agent:thinking":
          this.emit("thinking", event.content as string);
          break;

        case "agent:tool_call": {
          const toolName = event.tool as string;
          const toolInput = (event.input ?? {}) as Record<string, unknown>;

          // Sandbox pre-validation: block disallowed tool calls
          if (this.sandboxManager) {
            const validation = this.sandboxManager.validateToolCall(toolName, toolInput);
            if (!validation.allowed) {
              this._logger.warn(
                "system",
                `Sandbox blocked tool "${toolName}": ${validation.violations.join("; ")}`,
              );
              // The event is still emitted for observability, but the
              // AgentLoop's toolExecutor wrapper handles the actual blocking.
              // We emit a synthetic tool_result error to signal the block.
            }
          }

          this._logger.logToolCall(toolName, toolInput);
          this.emit("tool:call", toolName, toolInput);
          break;
        }

        case "agent:tool_result":
          this._logger.logToolResult(
            event.tool as string,
            event.output as string,
            (event.durationMs as number) ?? 0,
            (event.success as boolean) ?? true,
          );
          this.emit("tool:result", event.tool as string, event.output as string, (event.durationMs as number) ?? 0);
          if (this.perfOptimizer) {
            this.perfOptimizer.recordToolCall(
              event.tool as string,
              event.input ?? {},
              (event.durationMs as number) ?? 0,
            );
          }
          break;

        case "agent:file_change":
          // Track changed files
          if (typeof event.path === "string") {
            this.changedFiles.add(event.path);
          }
          break;
      }
    });
  }

  /**
   * analyze phase용 분석 프롬프트를 생성한다.
   *
   * @param goal - 사용자 목표
   * @param codebaseStats - CodebaseContext 통계
   * @returns 시스템 프롬프트
   */
  private buildAnalysisPrompt(
    goal: string,
    codebaseStats: object,
  ): string {
    const statsStr =
      Object.keys(codebaseStats).length > 0
        ? `\n## Codebase Statistics\n${JSON.stringify(codebaseStats, null, 2)}`
        : "";

    return `You are a code analysis expert. Analyze the user's request and the project context.
${statsStr}

## Instructions
1. Determine the complexity of the request: trivial, simple, moderate, complex, or massive
2. Identify relevant files and patterns
3. Note any risks or dependencies
4. Provide a brief analysis summary

Start your response with the complexity level (e.g., "Complexity: moderate")
Then provide your analysis.`;
  }

  /**
   * 개별 step 실행을 위한 시스템 프롬프트를 생성한다.
   *
   * @param plan - 전체 실행 계획
   * @param step - 현재 step
   * @param stepIndex - step 인덱스
   * @returns 시스템 프롬프트
   */
  private buildStepPrompt(
    plan: ExecutionPlan,
    step: ExecutionPlan["steps"][number],
    stepIndex: number,
  ): string {
    const sections: string[] = [];

    sections.push(
      `You are an expert coding agent executing step ${stepIndex + 1} of ${plan.steps.length}.`,
    );
    sections.push("");
    sections.push(`## Overall Goal`);
    sections.push(plan.goal);
    sections.push("");
    sections.push(`## Current Step`);
    sections.push(step.goal);
    sections.push("");

    if (step.targetFiles.length > 0) {
      sections.push(`## Target Files`);
      sections.push(step.targetFiles.join(", "));
      sections.push("");
    }

    if (step.readFiles.length > 0) {
      sections.push(`## Reference Files (read only)`);
      sections.push(step.readFiles.join(", "));
      sections.push("");
    }

    sections.push(`## Instructions`);
    sections.push(`- Focus on this step's goal only`);
    sections.push(`- Read relevant files before making changes`);
    sections.push(`- Make precise, minimal changes`);
    sections.push(`- Verify your changes compile/work`);
    sections.push(`- When done, provide a summary of what you changed`);

    return sections.join("\n");
  }

  /**
   * DeepVerifyResult를 StateMachine의 VerifyResult 형식으로 변환한다.
   *
   * @param deep - 6-dimension 심층 검증 결과
   * @returns StateMachine VerifyResult
   */
  private mapVerifyResult(deep: DeepVerifyResult): VerifyResult {
    const d = deep.dimensions;

    return {
      verdict: deep.verdict,
      checks: {
        buildSuccess: d.correctness.status !== "fail",
        typesSafe: d.correctness.status !== "fail",
        testsPass: d.completeness.status !== "fail",
        noRegressions: d.consistency.status !== "fail",
        followsPatterns: d.quality.status !== "fail",
        securityClean: d.security.status !== "fail",
      },
      issues: [
        ...d.correctness.issues,
        ...d.completeness.issues,
        ...d.consistency.issues,
        ...d.quality.issues,
        ...d.security.issues,
        ...d.performance.issues,
      ],
      suggestions: deep.suggestedFixes.map(
        (f) => `[${f.dimension}/${f.severity}] ${f.description}`,
      ),
      confidence: deep.confidence,
    };
  }
 private isFileMutationTool(toolName: string): boolean {
    const mutationTools = new Set([
      "file_write",
      "file_edit",
      "file_delete",
      "file_move",
      "file_rename",
      "apply_patch",
    ]);

    return mutationTools.has(toolName);
  }
  /**
   * StateMachine 최종 상태에서 ExecutionResult를 생성한다.
   *
   * @param smState - StateMachine 최종 상태
   * @param startTime - 실행 시작 시각 (epoch ms)
   * @returns 실행 결과
   */
  private buildResult(smState: AgentState, startTime: number): ExecutionResult {
    const hasErrors = smState.errors.length > 0;
    const lastReflection =
      smState.reflections[smState.reflections.length - 1];
    const passed =
      !hasErrors ||
      (lastReflection && lastReflection.verdict === "pass");

    // Build summary from step results
    const summaryParts: string[] = [];
    for (const sr of smState.stepResults) {
      if (sr.phase === "implement" || sr.phase === "fix") {
        summaryParts.push(`[${sr.phase}] ${sr.output}`);
      }
    }
    const summary =
      summaryParts.length > 0
        ? summaryParts.join("\n")
        : `Execution completed in phase: ${smState.phase}`;

    return {
      success: !!passed,
      termination: this.lastTermination,
      finalPhase: smState.phase,
      changedFiles: [...this.changedFiles],
      summary,
      totalTokens: {
        input: smState.tokenUsage.input,
        output: smState.tokenUsage.output,
      },
      totalIterations: smState.iterationCount,
      totalToolCalls: smState.toolCalls,
      durationMs: Date.now() - startTime,
      verifyResult: this.lastVerifyResult,
      monologue: [...this.reflection.getMonologue()],
      learnings: [...this.reflection.getAllLearnings()],
      plan: this.hierarchicalPlan,
    };
  }

  /**
   * JSON 문자열에서 JSON 블록을 추출한다.
   * markdown 코드 펜스 또는 순수 JSON을 처리한다.
   *
   * @param content - 원본 문자열
   * @returns 추출된 JSON 문자열
   */
  private extractJson(content: string): string {
    // Strip markdown code fences
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      return fenced[1]!.trim();
    }

    // Find first JSON array or object
 const start = content.indexOf("[");
 const end = content.lastIndexOf("]");
 if (start !== -1 && end !== -1 && end > start) {
   return content.slice(start, end + 1);
 }

 const objStart = content.indexOf("{");
 const objEnd = content.lastIndexOf("}");
 if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
   return content.slice(objStart, objEnd + 1);
 }

    return content.trim();
  }
}
