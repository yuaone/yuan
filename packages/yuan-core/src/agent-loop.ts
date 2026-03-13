/**
 * @module agent-loop
 * @description 메인 Agent Loop — LLM ↔ Tool 반복 실행 엔진.
 *
 * while 루프로 LLM 호출 → tool_use 파싱 → tool 실행 → 결과 피드백을 반복.
 * Governor가 반복 제한/안전 검증을 담당하고,
 * ContextManager가 컨텍스트 윈도우를 관리한다.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { basename, join as pathJoin } from "node:path";
import type {
  AgentConfig,
  AgentEvent,
  AgentTermination,
  Message,
  ToolCall,
  ToolResult,
  ToolExecutor,
  TokenUsage,
} from "./types.js";
import { BYOKClient, type LLMResponse, type LLMStreamChunk } from "./llm-client.js";
import { Governor, type GovernorConfig } from "./governor.js";
import { ContextManager, type ContextManagerConfig } from "./context-manager.js";
import { 
  SessionPersistence, 
  type SessionData, 
  type CheckpointData,
  type SessionSnapshot
} from "./session-persistence.js";
import {
  YuanError,
  ToolError,
  LLMError,
  PlanLimitError,
  ApprovalRequiredError,
} from "./errors.js";
import {
  ApprovalManager,
  type ApprovalHandler,
  type ApprovalRequest,
  type AutoApprovalConfig,
} from "./approval.js";
import {
  AutoFixLoop,
  type AutoFixConfig,
  type ValidationResult,
} from "./auto-fix.js";
import { InterruptManager } from "./interrupt-manager.js";
import type { InterruptSignal } from "./types.js";
import { YuanMemory, type ProjectStructure } from "./memory.js";
import { MemoryManager } from "./memory-manager.js";
import { buildSystemPrompt, type EnvironmentInfo } from "./system-prompt.js";
import {
  HierarchicalPlanner,
  type HierarchicalPlan,
  type TacticalTask,
  type RePlanTrigger,
} from "./hierarchical-planner.js";
import { TaskClassifier, type TaskClassification } from "./task-classifier.js";
import { PromptDefense } from "./prompt-defense.js";
import { ReflexionEngine, type ReflexionEntry } from "./reflexion.js";
import { TokenBudgetManager, type BudgetRole } from "./token-budget.js";
import { ContinuationEngine } from "./continuation-engine.js";
import { MemoryUpdater, type RunAnalysis } from "./memory-updater.js";
import type { ContinuationCheckpoint, ToolDefinition } from "./types.js";
import { MCPClient, type MCPServerConfig } from "./mcp-client.js";
import { WorldStateCollector, type WorldStateSnapshot } from "./world-state.js";
import { FailureRecovery, type RecoveryDecision } from "./failure-recovery.js";
import { ExecutionPolicyEngine, type ExecutionPolicy } from "./execution-policy-engine.js";
import { CostOptimizer } from "./cost-optimizer.js";
import { ImpactAnalyzer, type ImpactReport } from "./impact-analyzer.js";
import { SelfReflection } from "./self-reflection.js";
import { DebateOrchestrator } from "./debate-orchestrator.js";
import {
  ContinuousReflection,
  type AgentStateSnapshot,
} from "./continuous-reflection.js";
import { PluginRegistry, type TriggerMatch } from "./plugin-registry.js";
import { SkillLoader } from "./skill-loader.js";
import type { SkillDefinition } from "./plugin-types.js";
import { SpecialistRegistry, type SpecialistMatch } from "./specialist-registry.js";
import { ToolPlanner, type ToolPlan, type PlanContext } from "./tool-planner.js";
import { SelfDebugLoop, type DebugResult } from "./self-debug-loop.js";
import { SkillLearner } from "./skill-learner.js";
import { RepoKnowledgeGraph, type ImpactReport as GraphImpactReport } from "./repo-knowledge-graph.js";
import { BackgroundAgentManager, type BackgroundEvent } from "./background-agent.js";
import { ReasoningAggregator } from "./reasoning-aggregator.js";
import { ReasoningTree } from "./reasoning-tree.js";
import { ContextCompressor } from "./context-compressor.js";
import { DependencyAnalyzer } from "./dependency-analyzer.js";
import { CrossFileRefactor } from "./cross-file-refactor.js";
import { ContextBudgetManager } from "./context-budget.js";
import { QAPipeline, type QAPipelineResult } from "./qa-pipeline.js";
import { PersonaManager } from "./persona.js";
import { InMemoryVectorStore, OllamaEmbeddingProvider } from "./vector-store.js";
import {
  StateStore,
  TransitionModel,
  SimulationEngine,
  StateUpdater,
} from "./world-model/index.js";
import type { WorldState, StatePatch } from "./world-model/index.js";
import {
  MilestoneChecker,
  RiskEstimator,
  PlanEvaluator,
  ReplanningEngine,
} from "./planner/index.js";
import type { Milestone, MilestoneStatus, RiskScore, PlanHealth, ProactiveReplanResult } from "./planner/index.js";
/** AgentLoop 설정 */
export interface AgentLoopOptions {
  abortSignal?: AbortSignal
  /** 에이전트 설정 */
  config: AgentConfig;
  /** 도구 실행기 */
  toolExecutor: ToolExecutor;
  /** Governor 설정 (planTier 등) */
  governorConfig: GovernorConfig;
  /** ContextManager 설정 */
  contextConfig?: Partial<ContextManagerConfig>;
  /** 승인 시스템 설정 */
  approvalConfig?: Partial<AutoApprovalConfig>;
  /** 승인 핸들러 (CLI/UI에서 등록) */
  approvalHandler?: ApprovalHandler;
  /** 자동 수정 루프 설정 */
  autoFixConfig?: Partial<AutoFixConfig>;
  /** 인터럽트 매니저 (외부에서 주입, 미지정 시 내부 생성) */
  interruptManager?: InterruptManager;
  /** Memory 자동 로드/저장 활성화 (기본 true) */
  enableMemory?: boolean;
  /** 환경 정보 (시스템 프롬프트에 포함) */
  environment?: EnvironmentInfo;
  /** 자동 플래닝 활성화 (복잡한 태스크 감지 시 계획 수립, 기본 true) */
  enablePlanning?: boolean;
  /** 플래닝이 필요한 최소 복잡도 (기본 "moderate") */
  planningThreshold?: "simple" | "moderate" | "complex";
  /** MCP 서버 설정 (외부 도구 연동) */
  mcpServerConfigs?: MCPServerConfig[];
  /** 실행 정책 오버라이드 (미지정 시 .yuan/policy.json 자동 로드) */
  policyOverrides?: Partial<ExecutionPolicy>;
  /** Self-Reflection 활성화 (6D 검증 + quick verify, 기본 true) */
  enableSelfReflection?: boolean;
  /** Multi-Agent Debate 활성화 (complex/massive 태스크에서 Coder→Reviewer→Verifier 루프, 기본 true) */
  enableDebate?: boolean;
  /** Plugin registry instance (shared across sessions) */
  pluginRegistry?: PluginRegistry;
  /** Enable tool planning (plan optimal tool sequences before execution, default true) */
  enableToolPlanning?: boolean;
  /** Enable skill learning (learn from successful fixes, default true) */
  enableSkillLearning?: boolean;
  /** Enable background agents (persistent monitors, default false — opt-in) */
  enableBackgroundAgents?: boolean;
}

/**
 * AgentLoop — YUAN 에이전트의 핵심 실행 루프.
 *
 * 동작 흐름:
 * 1. 사용자 메시지 수신
 * 2. 시스템 프롬프트 + 히스토리로 LLM 호출
 * 3. LLM 응답에서 tool_call 파싱
 * 4. Governor가 안전성 검증
 * 5. 도구 실행 → 결과를 히스토리에 추가
 * 6. LLM에 결과 피드백 → 2번으로 반복
 * 7. 종료 조건 충족 시 결과 반환
 *
 * @example
 * ```typescript
 * const loop = new AgentLoop({
 *   config: agentConfig,
 *   toolExecutor: executor,
 *   governorConfig: { planTier: "PRO" },
 * });
 *
 * loop.on("event", (event: AgentEvent) => {
 *   // SSE 스트리밍
 * });
 *
 * const result = await loop.run("모든 console.log를 제거해줘");
 * ```
 */
/** Minimum confidence for classification-based hints/routing to activate */
const CLASSIFICATION_CONFIDENCE_THRESHOLD = 0.6;

export class AgentLoop extends EventEmitter {
  private readonly abortSignal?: AbortSignal;
  private readonly llmClient: BYOKClient;
  private readonly governor: Governor;
  private readonly contextManager: ContextManager;
  private readonly toolExecutor: ToolExecutor;
  private readonly config: AgentConfig;
  private readonly approvalManager: ApprovalManager;
  private readonly autoFixLoop: AutoFixLoop;
  private readonly interruptManager: InterruptManager;
  private readonly enableMemory: boolean;
  private readonly enablePlanning: boolean;
  private readonly planningThreshold: "simple" | "moderate" | "complex";
  private readonly environment?: EnvironmentInfo;
  private yuanMemory: YuanMemory | null = null;
  private memoryManager: MemoryManager | null = null;
  private planner: HierarchicalPlanner | null = null;
  private activePlan: HierarchicalPlan | null = null;
  private taskClassifier: TaskClassifier;
  private promptDefense: PromptDefense;
  private reflexionEngine: ReflexionEngine | null = null;
  private tokenBudgetManager: TokenBudgetManager;
  private allToolResults: ToolResult[] = [];
  private currentTaskIndex = 0;
  private _lastInjectedTaskIndex = -1; // track when plan progress was last injected
  private changedFiles: string[] = [];
  private aborted = false;
  private initialized = false;
  private continuationEngine: ContinuationEngine | null = null;
  private mcpClient: MCPClient | null = null;
  private mcpToolDefinitions: ToolDefinition[] = [];
  private readonly mcpServerConfigs: MCPServerConfig[];
  private memoryUpdater: MemoryUpdater;
  private failureRecovery: FailureRecovery;
  private policyEngine: ExecutionPolicyEngine | null = null;
  private worldState: WorldStateSnapshot | null = null;
  private costOptimizer: CostOptimizer;
  private impactAnalyzer: ImpactAnalyzer | null = null;
  private impactHintInjected = false;
  private selfReflection: SelfReflection | null = null;
  private debateOrchestrator: DebateOrchestrator | null = null;
  private continuousReflection: ContinuousReflection | null = null;
  private readonly enableSelfReflection: boolean;
  private readonly enableDebate: boolean;
  private currentComplexity: "trivial" | "simple" | "moderate" | "complex" | "massive" = "simple";
  private readonly policyOverrides?: Partial<ExecutionPolicy>;
  private checkpointSaved = false;
  private iterationCount = 0;
  private originalSnapshots: Map<string, string> = new Map();
  private previousStrategies: import("./failure-recovery.js").RecoveryStrategy[] = [];
  private pluginRegistry: PluginRegistry;
  private skillLoader: SkillLoader;
  private specialistRegistry: SpecialistRegistry;
  private toolPlanner: ToolPlanner;
  private selfDebugLoop: SelfDebugLoop;
  private skillLearner: SkillLearner | null = null;
  private repoGraph: RepoKnowledgeGraph | null = null;
  private backgroundAgentManager: BackgroundAgentManager | null = null;
 private sessionPersistence: SessionPersistence | null = null;
  private sessionId: string | null = null;
  private readonly enableToolPlanning: boolean;
  private readonly enableSkillLearning: boolean;
  private readonly enableBackgroundAgents: boolean;
  private currentToolPlan: ToolPlan | null = null;
  private executedToolNames: string[] = [];
  /** Context Budget: max 3 active skills at once */
  private activeSkillIds: string[] = [];
  private static readonly MAX_ACTIVE_SKILLS = 3;
  /** Context Budget: track injected system messages per iteration to cap at 5 */
  private iterationSystemMsgCount = 0;
  /** Task 1: ContextBudgetManager for LLM-based summarization at 60-70% context usage */
  private contextBudgetManager: ContextBudgetManager | null = null;
  /** Task 1: Flag to ensure LLM summarization only runs once per agent run (non-blocking guard) */
  private _contextSummarizationDone = false;
  /** Task 2: Track whether write tools ran this iteration for QA triggering */
  private iterationWriteToolPaths: string[] = [];
  /** Task 2: Last QA result (surfaced to LLM on issues) */
  private lastQAResult: QAPipelineResult | null = null;
  /** Task 3: Track TS files modified this run for auto-tsc */
  private iterationTsFilesModified: string[] = [];
  /** Task 3: Whether tsc was run in the previous iteration (skip cooldown) */
  private tscRanLastIteration = false;
  /** PersonaManager — learns user communication style, injects persona into system prompt */
  private personaManager: PersonaManager | null = null;
  /** InMemoryVectorStore — RAG: semantic code context retrieval for relevant snippets */
  private vectorStore: InMemoryVectorStore | null = null;
  /** Last user message — used for task-specific memory retrieval */
  private lastUserMessage = "";
  // World Model
  private worldModel: StateStore | null = null;
  private transitionModel: TransitionModel | null = null;
  private simulationEngine: SimulationEngine | null = null;
  private stateUpdater: StateUpdater | null = null;
  // Proactive Replanning
  private planEvaluator: PlanEvaluator | null = null;
  private riskEstimator: RiskEstimator | null = null;
  private replanningEngine: ReplanningEngine | null = null;
  private milestoneChecker: MilestoneChecker | null = null;
  private activeMilestones: Milestone[] = [];
  private completedPlanTaskIds: Set<string> = new Set();
  private allToolResultsSinceLastReplan: ToolResult[] = [];
  private tokenUsage: TokenUsage = {
    input: 0,
    output: 0,
    reasoning: 0,
    total: 0,
  };
private readonly reasoningAggregator = new ReasoningAggregator();
private readonly reasoningTree = new ReasoningTree();
private resumedFromSession = false;
  /**
   * Restore AgentLoop state from persisted session (yuan resume)
   */
async restoreSession(data: SessionData): Promise<void> {
    if (!data) return;

    try {
      this.governor.resetIteration?.();
      if (data.snapshot?.id) {
        this.sessionId = data.snapshot.id;
      }
      if (data.snapshot?.iteration) {
 this.iterationCount = data.snapshot.iteration;
 this.governor.restoreIteration?.(data.snapshot.iteration);
      }

      if (data.snapshot?.tokenUsage) {
        const input = data.snapshot.tokenUsage.input ?? 0;
        const output = data.snapshot.tokenUsage.output ?? 0;
        this.tokenUsage = {
          input,
          output,
          reasoning: 0,
          total: input + output,
        };
      }

      if (Array.isArray(data.changedFiles)) {
        this.changedFiles = data.changedFiles;
      }

      if (Array.isArray(data.messages) && data.messages.length > 0) {
        this.contextManager.clear();

        for (const msg of data.messages) {
          this.contextManager.addMessage(msg);
        }
        if (!data.messages.some((msg) => msg.role === "system")) {
          this.contextManager.addMessage({
            role: "system",
            content: this.config.loop.systemPrompt,
          });
        }
      }


      this.activePlan = data.plan ?? null;
     this.resumedFromSession = true;
      this.emitEvent({
        kind: "agent:thinking",
        content: "Session restored.",
      });
    } catch (err) {
      this.emitEvent({
        kind: "agent:error",
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      });
    }
  }
  

  constructor(options: AgentLoopOptions) {
    super();
    this.setMaxListeners(100);
    this.config = options.config;
    this.toolExecutor = options.toolExecutor;
    this.abortSignal = options.abortSignal
    this.enableMemory = options.enableMemory !== false;
    this.enablePlanning = options.enablePlanning !== false;
    this.planningThreshold = options.planningThreshold ?? "moderate";
    this.environment = options.environment;
    this.enableSelfReflection = options.enableSelfReflection !== false;
    this.enableDebate = options.enableDebate !== false;

    // BYOK LLM 클라이언트 생성
    this.llmClient = new BYOKClient(options.config.byok);

    // Governor 생성
    this.governor = new Governor(options.governorConfig);

    // ContextManager 생성
    this.contextManager = new ContextManager({
      maxContextTokens:
        options.contextConfig?.maxContextTokens ??
        options.config.loop.totalTokenBudget,
      outputReserveTokens:
        options.contextConfig?.outputReserveTokens ?? 4096,
      ...options.contextConfig,
    });

    // ApprovalManager 생성
    this.approvalManager = new ApprovalManager(options.approvalConfig);
    if (options.approvalHandler) {
      this.approvalManager.setHandler(options.approvalHandler);
    }

    // AutoFixLoop 생성
    this.autoFixLoop = new AutoFixLoop(options.autoFixConfig);

    // Task Classifier + Prompt Defense + Token Budget + Memory Updater
    this.taskClassifier = new TaskClassifier();
    this.promptDefense = new PromptDefense();
    this.tokenBudgetManager = new TokenBudgetManager({
      totalBudget: options.config.loop.totalTokenBudget,
    });
    this.memoryUpdater = new MemoryUpdater();
    this.failureRecovery = new FailureRecovery();
    this.costOptimizer = new CostOptimizer();
    this.policyOverrides = options.policyOverrides;

    // MCP 서버 설정 저장
    this.mcpServerConfigs = options.mcpServerConfigs ?? [];

    // InterruptManager 설정 (외부 주입 또는 내부 생성)
    this.interruptManager = options.interruptManager ?? new InterruptManager();
    this.setupInterruptListeners();

    // PluginRegistry + SkillLoader 초기화
    this.pluginRegistry = options.pluginRegistry ?? new PluginRegistry();
    this.skillLoader = new SkillLoader();

    // Advanced Intelligence 모듈 초기화
    this.specialistRegistry = new SpecialistRegistry();
    this.toolPlanner = new ToolPlanner();
    this.selfDebugLoop = new SelfDebugLoop();
    this.enableToolPlanning = options.enableToolPlanning !== false;
    this.enableSkillLearning = options.enableSkillLearning !== false;
    this.enableBackgroundAgents = options.enableBackgroundAgents === true;

    // 시스템 프롬프트 추가 (메모리 없이 기본 프롬프트로 시작, init()에서 갱신)
    this.contextManager.addMessage({
      role: "system",
      content: this.config.loop.systemPrompt,
    });
  }

  /**
   * Memory와 프로젝트 컨텍스트를 로드하여 시스템 프롬프트를 갱신.
   * run() 호출 전에 한 번 호출하면 메모리가 자동으로 주입된다.
   * 이미 초기화되었으면 스킵.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    // Task 1: Initialize ContextBudgetManager with the total token budget
    this.contextBudgetManager = new ContextBudgetManager({
      totalBudget: this.config.loop.totalTokenBudget,
      enableSummarization: true,
      summarizationThreshold: 0.60, // trigger summarize() at 60% (before ContextCompressor at 70%)
    });

    const projectPath = this.config.loop.projectPath;
    if (!projectPath) return;
  // Session persistence init
  try {
    this.sessionPersistence = new SessionPersistence(undefined, projectPath);
  } catch {
    this.sessionPersistence = null;
  }
    let yuanMdContent: string | undefined;
    let projectStructure: ProjectStructure | undefined;

    // Memory 로드
    if (this.enableMemory) {
      try {
        // YUAN.md (raw markdown)
        this.yuanMemory = new YuanMemory(projectPath);
        const memData = await this.yuanMemory.load();
        if (memData) {
          yuanMdContent = memData.raw;
        }

        // MemoryManager (structured learnings)
        this.memoryManager = new MemoryManager(projectPath);
        await this.memoryManager.load();

        // PersonaManager — user communication style learning + persona injection
        const personaUserId = basename(projectPath) || "default";
        this.personaManager = new PersonaManager({
          userId: personaUserId,
          profilePath: pathJoin(projectPath, ".yuan", `persona-${personaUserId}.json`),
          enableLearning: true,
        });
        await this.personaManager.loadProfile().catch(() => {});

        // InMemoryVectorStore — RAG semantic code context (TF-IDF fallback if Ollama unavailable)
        this.vectorStore = new InMemoryVectorStore({
          projectId: personaUserId,
          projectPath,
          embeddingProvider: new OllamaEmbeddingProvider(),
        });
        await this.vectorStore.load().catch(() => {});

        // Background indexing — non-blocking, fires and forgets
        const vectorStoreRef = this.vectorStore;
        import("./code-indexer.js").then(({ CodeIndexer }) => {
          const indexer = new CodeIndexer({});
          indexer.indexProject(projectPath, vectorStoreRef).catch(() => {});
        }).catch(() => {});

        // 프로젝트 구조 분석
        projectStructure = await this.yuanMemory.analyzeProject();
      } catch (memErr) {
        // 메모리 로드 실패는 치명적이지 않음 — 경고만 출력
        this.emitEvent({
          kind: "agent:error",
          message: `Memory load failed: ${memErr instanceof Error ? memErr.message : String(memErr)}`,
          retryable: false,
        });
      }
    }

    // ExecutionPolicyEngine 로드
    try {
      this.policyEngine = new ExecutionPolicyEngine(projectPath);
      const policy = await this.policyEngine.load();
      if (this.policyOverrides) {
        for (const [section, values] of Object.entries(this.policyOverrides)) {
          this.policyEngine.override(
            section as keyof ExecutionPolicy,
            values as Partial<ExecutionPolicy[keyof ExecutionPolicy]>,
          );
        }
      }
      // FailureRecovery에 정책 적용
      const recoveryConfig = this.policyEngine.toFailureRecoveryConfig();
      this.failureRecovery = new FailureRecovery(recoveryConfig);
    } catch {
      // 정책 로드 실패 → 기본값 사용
    }

    // WorldState 수집 → system prompt에 주입
    try {
      const worldStateCollector = new WorldStateCollector({
        projectPath,
        maxRecentCommits: 10,
        skipTest: true,
      });
      this.worldState = await worldStateCollector.collect();
    } catch {
      // WorldState 수집 실패는 치명적이지 않음
    }

    // Initialize World Model
    if (this.worldState && projectPath) {
      try {
        this.transitionModel = new TransitionModel();
        this.worldModel = StateStore.fromSnapshot(this.worldState, projectPath);
        this.simulationEngine = new SimulationEngine(this.transitionModel, this.worldModel);
        this.stateUpdater = new StateUpdater(this.worldModel, projectPath);
      } catch {
        // World Model initialization failure is non-fatal
      }
    }

    // Capture last known good git commit for FailureRecovery rollback
    try {
      const headHash = execSync("git rev-parse HEAD", {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 5_000,
      }).toString().trim();
      if (headHash) {
        this.failureRecovery.setLastGoodCommit(headHash, projectPath);
      }
    } catch {
      // Not a git repo or git unavailable — FailureRecovery will use file-level rollback only
    }

    // ImpactAnalyzer 생성
    this.impactAnalyzer = new ImpactAnalyzer({ projectPath });

    // ContinuationEngine 생성
    this.continuationEngine = new ContinuationEngine({ projectPath });

    // 이전 세션 체크포인트 복원
    try {
      const latestCheckpoint = await this.continuationEngine.findLatestCheckpoint();
      if (latestCheckpoint) {
        const continuationPrompt = this.continuationEngine.formatContinuationPrompt(latestCheckpoint);
        this.contextManager.addMessage({
          role: "system",
          content: continuationPrompt,
        });
        // 복원 후 체크포인트 정리
        await this.continuationEngine.pruneOldCheckpoints();
      }
    } catch {
      // 체크포인트 복원 실패는 치명적이지 않음
    }

    // MCP 클라이언트 연결
    if (this.mcpServerConfigs.length > 0) {
      try {
        this.mcpClient = new MCPClient({
          servers: this.mcpServerConfigs,
        });
        await this.mcpClient.connectAll();
        this.mcpToolDefinitions = this.mcpClient.toToolDefinitions();
      } catch {
        // MCP 연결 실패는 치명적이지 않음 — 로컬 도구만 사용
        this.mcpClient = null;
        this.mcpToolDefinitions = [];
      }
    }

    // ReflexionEngine 생성
    if (projectPath) {
      this.reflexionEngine = new ReflexionEngine({ projectPath });
    }

    // SelfReflection 생성 (6D deep verify + quick verify)
    if (this.enableSelfReflection) {
      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.selfReflection = new SelfReflection(sessionId, {
        enableDeepVerify: true,
        enableMonologue: true,
        enableLearning: true,
        minScoreToPass: 70,
        criticalDimensions: ["correctness", "security"],
      });

      // 메모리에서 기존 학습 복원
      if (this.memoryManager) {
        try {
          const memory = await this.memoryManager.load();
          this.selfReflection.loadFromMemory(memory);
        } catch {
          // 학습 복원 실패는 치명적이지 않음
        }
      }
    }

    // DebateOrchestrator 생성 (complex/massive 태스크에서 multi-agent debate)
    if (this.enableDebate && projectPath) {
      this.debateOrchestrator = new DebateOrchestrator({
        projectPath,
        maxRounds: 3,
        qualityThreshold: 80,
        verifyBetweenRounds: true,
        byokConfig: this.config.byok,
        toolExecutor: this.toolExecutor,
        maxTokensPerCall: 16384,
        totalTokenBudget: Math.floor(this.config.loop.totalTokenBudget * 0.3),
      });
    }

    // 향상된 시스템 프롬프트 생성
    const enhancedPrompt = buildSystemPrompt({
      projectStructure,
      yuanMdContent,
      tools: [...this.config.loop.tools, ...this.mcpToolDefinitions],
      projectPath,
      environment: this.environment,
    });

    // WorldState를 시스템 프롬프트에 추가
    let worldStateSection = "";
    if (this.worldState) {
      const collector = new WorldStateCollector({ projectPath });
      worldStateSection = "\n\n" + collector.formatForPrompt(this.worldState);
    }

    // 기존 시스템 메시지를 향상된 프롬프트로 교체
    this.contextManager.replaceSystemMessage(enhancedPrompt + worldStateSection);

    // MemoryManager의 관련 학습/경고를 추가 컨텍스트로 주입
    if (this.memoryManager) {
      const memory = this.memoryManager.getMemory();
      if (memory.learnings.length > 0 || memory.failedApproaches.length > 0) {
        const memoryContext = this.buildMemoryContext(memory);
        if (memoryContext) {
          this.contextManager.addMessage({
            role: "system",
            content: memoryContext,
          });
        }
      }
    }

    // SkillLearner 초기화 (경험에서 학습된 스킬 자동 로드)
    if (this.enableSkillLearning && projectPath) {
      try {
        this.skillLearner = new SkillLearner(projectPath);
        await this.skillLearner.init();
      } catch {
        this.skillLearner = null;
      }
    }

    // HierarchicalPlanner 생성
    this.planner = new HierarchicalPlanner({ projectPath });

    if (this.skillLearner) {
      this.planner.setSkillLearner(this.skillLearner);
    }

    // Initialize Proactive Replanning (requires planner + impactAnalyzer + worldModel)
    try {
      if (this.impactAnalyzer && this.worldModel && this.simulationEngine && this.transitionModel) {
        this.milestoneChecker = new MilestoneChecker();
        this.riskEstimator = new RiskEstimator(
          this.transitionModel,
          this.impactAnalyzer,
        );
        this.planEvaluator = new PlanEvaluator(
          this.worldModel,
          this.simulationEngine,
        );
        this.replanningEngine = new ReplanningEngine(
          this.planner,
          this.planEvaluator,
          this.riskEstimator,
          this.milestoneChecker,
        );
      }
    } catch {
      // Proactive replanning initialization failure is non-fatal
    }

    if (this.skillLearner) {
      const learnedSkills = this.skillLearner.getAllSkills();
      if (learnedSkills.length > 0) {
        const skillNames = learnedSkills
          .filter((s) => s.confidence >= CLASSIFICATION_CONFIDENCE_THRESHOLD)
          .map((s) => s.id);
        if (skillNames.length > 0) {
          this.contextManager.addMessage({
            role: "system",
            content: `[Learned Skills: ${skillNames.join(", ")}] — Auto-activate on matching error patterns.`,
          });
        }
      }
    }

    // RepoKnowledgeGraph 초기화 (코드 구조 그래프 — 비동기 빌드)
    if (projectPath) {
      try {
        this.repoGraph = new RepoKnowledgeGraph(projectPath);
        // 백그라운드에서 그래프 빌드 (블로킹하지 않음)
        this.repoGraph.buildFromProject(projectPath).catch(() => {
          // 그래프 빌드 실패는 치명적이지 않음
        });
      } catch {
        this.repoGraph = null;
      }
    }

    // BackgroundAgentManager 초기화 (opt-in)
    if (this.enableBackgroundAgents && projectPath) {
      try {
        this.backgroundAgentManager = new BackgroundAgentManager();
        this.backgroundAgentManager.createDefaults(projectPath);
        // Background events → agent loop events
        for (const agent of this.backgroundAgentManager.list()) {
          const bgAgent = this.backgroundAgentManager.get(agent.id);
          if (bgAgent) {
            bgAgent.on("event", (event: BackgroundEvent) => {
              if (event.type === "error" || event.type === "warning") {
                this.emitEvent({
                  kind: "agent:thinking",
                  content: `[Background: ${event.agentId}] ${event.message}`,
                });
              }
            });
          }
        }
      } catch {
        this.backgroundAgentManager = null;
      }
    }

    // Inject active plugin skills into system prompt (lazy: names only)
    // Full skill content is loaded on-demand when triggered (file-pattern or error match)
    const activeSkills = this.pluginRegistry.getAllSkills();
    if (activeSkills.length > 0) {
      const skillSummary = activeSkills
        .map((s) => `${s.pluginId}/${s.skill.name}`)
        .join(", ");
      this.contextManager.addMessage({
        role: "system",
        content: `[Plugins: ${skillSummary}] — Skills auto-activate on matching files/errors.`,
      });
    }

    // ContinuousReflection 생성 (1분 간격 체크포인트 + 자기검증 + 컨텍스트 모니터)
    this.continuousReflection = new ContinuousReflection({
      getState: () => this.getStateSnapshot(),
      checkpoint: async (state, emergency) => {
        if (!this.continuationEngine) return;
        const checkpoint: ContinuationCheckpoint = {
          sessionId: this.sessionId ?? "unknown-session",
          goal: state.goal,
          progress: {
            completedTasks: state.completedTasks,
            currentTask: state.currentTask,
            remainingTasks: state.remainingTasks,
          },
          changedFiles: state.changedFiles.map((path) => ({ path, diff: "" })),
          workingMemory: state.workingMemory,
          yuanMdUpdates: [],
          errors: state.errors,
          contextUsageAtSave: state.contextUsagePercent,
          totalTokensUsed: state.totalTokensUsed,
          iterationsCompleted: state.iteration,
          createdAt: new Date(),
        };
        await this.continuationEngine.saveCheckpoint(checkpoint);
      },
      selfVerify: async (prompt) => {
        // 경량 LLM 호출 (~200 토큰)로 자기검증
        try {
          const response = await this.llmClient.chat(
            [{ role: "user", content: prompt }],
            [],
          );
          const text = typeof response.content === "string"
            ? response.content
            : "";
          const parsed = JSON.parse(text);
          return {
            onTrack: Boolean(parsed.onTrack),
            needsCorrection: Boolean(parsed.needsCorrection),
            issue: String(parsed.issue ?? ""),
            suggestion: String(parsed.suggestion ?? ""),
            confidence: Number(parsed.confidence ?? 0.5),
          };
        } catch {
          return {
            onTrack: true,
            needsCorrection: false,
            issue: "",
            suggestion: "",
            confidence: 0.5,
          };
        }
      },
    });

    // Wire ContinuousReflection events to agent loop
    this.continuousReflection.on("reflection:feedback", (feedback: string) => {
      this.contextManager.addMessage({
        role: "system",
        content: `[ContinuousReflection] ${feedback}`,
      });
    });
    this.continuousReflection.on("reflection:context_warning", (usagePercent: number) => {
      this.emitEvent({
        kind: "agent:thinking",
        content: `Context usage at ${Math.round(usagePercent * 100)}% — emergency checkpoint saved.`,
      });
    });
    this.continuousReflection.on("reflection:context_overflow", () => {
      void this.handleSoftContextOverflow();
    });
  }

  /**
   * MemoryManager의 학습/실패 기록을 시스템 메시지로 변환.
   */
  private buildMemoryContext(memory: {
    learnings: Array<{ category: string; content: string; confidence: number }>;
    failedApproaches: Array<{ approach: string; reason: string }>;
    conventions: string[];
  }): string | null {
    const parts: string[] = [];

    // 높은 confidence 학습만 포함
    const highConfLearnings = memory.learnings.filter((l) => l.confidence >= CLASSIFICATION_CONFIDENCE_THRESHOLD);
    if (highConfLearnings.length > 0) {
      parts.push("## Things I've Learned About This Project");
      for (const l of highConfLearnings.slice(0, 20)) {
        parts.push(`- [${l.category}] ${l.content}`);
      }
    }

    // 실패한 접근 방식 (최근 10개)
    if (memory.failedApproaches.length > 0) {
      parts.push("\n## Approaches That Failed Before (Avoid These)");
      for (const f of memory.failedApproaches.slice(0, 10)) {
        parts.push(`- **${f.approach}** — failed because: ${f.reason}`);
      }
    }

    // 코딩 규칙
    if (memory.conventions.length > 0) {
      parts.push("\n## Project Conventions");
      for (const c of memory.conventions) {
        parts.push(`- ${c}`);
      }
    }

    return parts.length > 0 ? parts.join("\n") : null;
  }

  /**
   * 에이전트 루프를 실행.
   * 첫 호출 시 자동으로 Memory와 프로젝트 컨텍스트를 로드한다.
   * @param userMessage 사용자의 요청 메시지
   * @returns 종료 사유 및 결과
   */
  async run(userMessage: string): Promise<AgentTermination> {
    this.aborted = false;
    this.reasoningAggregator.reset();
    this.reasoningTree.reset();
    // Capture before reset so session snapshot gets accurate file list
    const prevChangedFiles = [...this.changedFiles];
    if (!this.resumedFromSession) {
      this.changedFiles = [];
      this.allToolResults = [];
      this.iterationCount = 0;
      this.originalSnapshots.clear();
      this.previousStrategies = [];
      this.activeSkillIds = [];
      this.iterationSystemMsgCount = 0;
      this.tokenUsage = {
        input: 0,
        output: 0,
        reasoning: 0,
        total: 0,
      };
      this.impactHintInjected = false;
      // Task 3: reset tsc tracking per run
      this.iterationTsFilesModified = [];
      this.tscRanLastIteration = false;
      // Task 1: reset context summarization guard per run
      this._contextSummarizationDone = false;
    }

this.checkpointSaved = false;
    this.failureRecovery.reset();
    this.costOptimizer.reset();
    this.tokenBudgetManager.reset();
    const runStartTime = Date.now();

    // 첫 실행 시 메모리/프로젝트 컨텍스트 자동 로드
    await this.init();
  if (this.sessionPersistence) {
    if (!this.sessionId) {
      this.sessionId = randomUUID();
    }

    const nowIso = new Date().toISOString();
    const snapshot: SessionSnapshot = {
      id: this.sessionId,
      createdAt: nowIso,
      updatedAt: nowIso,
      workDir: this.config.loop.projectPath ?? "",
      provider: String(this.config.byok.provider ?? "unknown"),
      model: String(this.config.byok.model ?? "unknown"),
      status: "running",
      iteration: this.iterationCount,
      tokenUsage: {
        input: this.tokenUsage.input,
        output: this.tokenUsage.output,
      },
      messageCount: this.contextManager.getMessages().length,
    };

    await this.sessionPersistence.save(this.sessionId, {
      snapshot,
      messages: this.contextManager.getMessages(),
      plan: this.activePlan,
      changedFiles: prevChangedFiles,
    });
  }
    // 사용자 입력 검증 (prompt injection 방어)
    const inputValidation = this.promptDefense.validateUserInput(userMessage);
    if (inputValidation.injectionDetected && (inputValidation.severity === "critical" || inputValidation.severity === "high")) {
      this.emitEvent({
        kind: "agent:error",
        message: `Prompt injection detected in user input (${inputValidation.severity}): ${inputValidation.patternsFound.join(", ")}`,
        retryable: false,
      });
    }

    // 사용자 메시지 추가
    this.contextManager.addMessage({
      role: "user",
      content: userMessage,
    });

    // PersonaManager — 유저 메시지로 커뮤니케이션 스타일 학습
    this.lastUserMessage = userMessage;
    if (this.personaManager) {
      this.personaManager.analyzeUserMessage(userMessage);
    }

    this.emitEvent({ kind: "agent:start", goal: userMessage });

    try {
      // Persona injection — 유저 선호도/언어/스타일 어댑테이션을 시스템 메시지로 주입
      if (this.personaManager) {
        const personaSection = this.personaManager.buildPersonaPrompt();
        if (personaSection) {
          this.contextManager.addMessage({ role: "system", content: personaSection });
        }
      }

      // MemoryManager.getRelevant() — 현재 태스크와 관련된 conventions/patterns/warnings 주입
      if (this.memoryManager) {
        const relevant = this.memoryManager.getRelevant(userMessage);
        const parts: string[] = [];
        if (relevant.conventions.length > 0) {
          parts.push(`## Project Conventions\n${relevant.conventions.slice(0, 5).map((c) => `- ${c}`).join("\n")}`);
        }
        if (relevant.warnings.length > 0) {
          parts.push(`## Relevant Warnings\n${relevant.warnings.slice(0, 3).map((w) => `⚠ ${w}`).join("\n")}`);
        }
        if (relevant.patterns.length > 0) {
          parts.push(`## Relevant Code Patterns\n${relevant.patterns.slice(0, 3).map((p) => `- **${p.name}**: ${p.description}`).join("\n")}`);
        }
        if (parts.length > 0) {
          this.contextManager.addMessage({
            role: "system",
            content: `[Task Memory]\n${parts.join("\n\n")}`,
          });
        }
      }

      // VectorStore RAG — 태스크와 의미적으로 유사한 코드 컨텍스트 검색·주입
      if (this.vectorStore) {
        try {
          const hits = await this.vectorStore.search(userMessage, 3, 0.2);
          if (hits.length > 0) {
            const ragCtx = hits
              .map((h) => `**${h.id}** (relevance: ${(h.similarity * 100).toFixed(0)}%)\n${h.text.slice(0, 400)}`)
              .join("\n\n---\n\n");
            this.contextManager.addMessage({
              role: "system",
              content: `[RAG Context — semantically relevant code snippets]\n${ragCtx}`,
            });
          }
        } catch {
          // VectorStore search failure is non-fatal
        }
      }

      // Reflexion: 과거 실행에서 배운 가이던스 주입
      if (this.reflexionEngine) {
        try {
          const guidance = await this.reflexionEngine.getGuidance(userMessage);
          // 가이던스 유효성 검증: 빈 전략이나 매우 낮은 confidence 필터링
          const validStrategies = guidance.relevantStrategies.filter(
            (s) => s.strategy && s.strategy.length > 5 && s.confidence > 0.1,
          );
          if (validStrategies.length > 0 || guidance.recentFailures.length > 0) {
            const filteredGuidance = { ...guidance, relevantStrategies: validStrategies };
            const guidancePrompt = this.reflexionEngine.formatForSystemPrompt(filteredGuidance);
            this.contextManager.addMessage({
              role: "system",
              content: guidancePrompt,
            });
          }
        } catch {
          // guidance 로드 실패는 치명적이지 않음
        }
      }

      // Task 분류 → 시스템 프롬프트에 tool sequence hint 주입
      const classification = this.taskClassifier.classify(userMessage);
      if (classification.confidence >= CLASSIFICATION_CONFIDENCE_THRESHOLD) {
        const classificationHint = this.taskClassifier.formatForSystemPrompt(classification);
        this.contextManager.addMessage({
          role: "system",
          content: classificationHint,
        });
      }

      // Specialist routing: 태스크 타입에 맞는 전문 에이전트 설정 주입
      if (classification.specialistDomain) {
        const specialistMatch = this.specialistRegistry.findSpecialist(
          classification.specialistDomain,
        );
        if (specialistMatch && specialistMatch.confidence >= CLASSIFICATION_CONFIDENCE_THRESHOLD) {
          this.contextManager.addMessage({
            role: "system",
            content: `[Specialist: ${specialistMatch.specialist.name}] ${specialistMatch.specialist.systemPrompt.slice(0, 500)}`,
          });
        }
      }

      // Tool Planning: 태스크 타입에 맞는 도구 실행 계획 힌트 주입
      if (this.enableToolPlanning && classification.confidence >= CLASSIFICATION_CONFIDENCE_THRESHOLD) {
        const planContext: PlanContext = {
          userMessage,
        };
        this.currentToolPlan = this.toolPlanner.planForTask(
          classification.type,
          planContext,
        );
        this.executedToolNames = [];
        if (this.currentToolPlan.confidence >= CLASSIFICATION_CONFIDENCE_THRESHOLD) {
          const planHint = this.toolPlanner.formatPlanHint(this.currentToolPlan);
          this.contextManager.addMessage({
            role: "system",
            content: planHint,
          });
        }
      }

      // CrossFileRefactor: detect rename/move intent and inject preview hint
      if (this.config.loop.projectPath) {
        try {
          const renameMatch = userMessage.match(
            /\brename\s+[`'"]?(\w[\w.]*)[`'"]?\s+to\s+[`'"]?(\w[\w.]*)[`'"]/i,
          );
          const moveMatch = userMessage.match(
            /\bmove\s+[`'"]?([\w./\\-]+)[`'"]?\s+to\s+[`'"]?([\w./\\-]+)[`'"]/i,
          );

          if (renameMatch) {
            const [, symbolName, newName] = renameMatch;
            const refactor = new CrossFileRefactor(this.config.loop.projectPath);
            const preview = await refactor.renameSymbol(symbolName, newName);
            if (preview.totalChanges > 0) {
              const affectedList = preview.affectedFiles
                .map((f) => `  - ${f.file} (${f.changes.length} change(s))`)
                .join("\n");
              this.contextManager.addMessage({
                role: "system",
                content:
                  `[CrossFileRefactor] Rename "${symbolName}" → "${newName}" preview:\n` +
                  `Risk: ${preview.riskLevel}, Files affected: ${preview.affectedFiles.length}\n` +
                  affectedList +
                  (preview.warnings.length > 0
                    ? `\nWarnings: ${preview.warnings.join("; ")}`
                    : ""),
              });
              this.iterationSystemMsgCount++;
            }
          } else if (moveMatch) {
            const [, symbolOrFile, destination] = moveMatch;
            const refactor = new CrossFileRefactor(this.config.loop.projectPath);
            // Try move as symbol move (source heuristic: look for a file with that name)
            const preview = await refactor.moveSymbol(symbolOrFile, symbolOrFile, destination);
            if (preview.totalChanges > 0) {
              const affectedList = preview.affectedFiles
                .map((f) => `  - ${f.file} (${f.changes.length} change(s))`)
                .join("\n");
              this.contextManager.addMessage({
                role: "system",
                content:
                  `[CrossFileRefactor] Move "${symbolOrFile}" → "${destination}" preview:\n` +
                  `Risk: ${preview.riskLevel}, Files affected: ${preview.affectedFiles.length}\n` +
                  affectedList +
                  (preview.warnings.length > 0
                    ? `\nWarnings: ${preview.warnings.join("; ")}`
                    : ""),
              });
              this.iterationSystemMsgCount++;
            }
          }
        } catch {
          // CrossFileRefactor preview failure is non-fatal
        }
      }

      // 복잡도 감지 → 필요 시 자동 플래닝
      await this.maybeCreatePlan(userMessage);

      // ContinuousReflection 시작 (1분 간격 체크포인트/자기검증/컨텍스트모니터)
      if (this.continuousReflection) {
        this.continuousReflection.start();
      }

      let result: AgentTermination;
      try {
        result = await this.executeLoop();
      } finally {
        // ContinuousReflection 정지 (루프 종료 시 반드시 정리)
        if (this.continuousReflection) {
          this.continuousReflection.stop();
        }
      }
      if (this.sessionPersistence && this.sessionId) {
        const finalStatus =
          result.reason === "ERROR"
            ? "crashed"
            : "completed";
        await this.sessionPersistence.updateStatus(this.sessionId, finalStatus);
      }
      // 실행 완료 후 메모리 자동 업데이트
      await this.updateMemoryAfterRun(userMessage, result, Date.now() - runStartTime);

      // SkillLearner: 성공적 에러 해결 시 새로운 스킬 학습
      if (this.skillLearner && result.reason === "GOAL_ACHIEVED") {
        try {
          let newSkillId: string | null = null;
          const errorToolResults = this.allToolResults.filter((r) => !r.success);
          if (errorToolResults.length > 0 && this.changedFiles.length > 0) {
            // 에러가 있었지만 결국 성공 → 학습 가능한 패턴
            const runAnalysis = this.memoryUpdater.analyzeRun({
              goal: userMessage,
              termination: { reason: result.reason, summary: result.summary },
              toolResults: this.allToolResults.map((r) => ({
                name: r.name,
                success: r.success,
                output: r.output.slice(0, 500),
              })),
              changedFiles: this.changedFiles,
              messages: [],
              tokensUsed: this.tokenUsage.total,
              durationMs: Date.now() - runStartTime,
              iterations: this.iterationCount,
            });
            const learned = this.skillLearner.extractSkillFromRun(
              runAnalysis,
              this.sessionId ?? `session-${Date.now()}`,
            );
            if (learned) {
              newSkillId = learned.id;
            }
            await this.skillLearner.save();
            if (newSkillId) {
              this.emitEvent({
                kind: "agent:thinking",
                content: `Learned new skill: ${newSkillId}`,
              });
            }
          }
        } catch {
          // 학습 실패는 치명적이지 않음
        }
      }

      // Tool plan compliance check (non-blocking, for metrics)
      if (this.currentToolPlan && this.executedToolNames.length > 0) {
        try {
          this.toolPlanner.validateExecution(
            this.currentToolPlan,
            this.executedToolNames,
          );
        } catch {
          // compliance check 실패는 치명적이지 않음
        }
      }

      // RepoKnowledgeGraph: 변경 파일 그래프 업데이트
      if (this.repoGraph && this.changedFiles.length > 0) {
        this.repoGraph.updateFiles(this.changedFiles).catch(() => {
          // 그래프 업데이트 실패는 치명적이지 않음
        });
      }

      // BackgroundAgentManager: 정리 (stopAll은 abort 시에만)
      // Background agents는 세션 간 지속되므로 여기서 stop하지 않음

      return result;
      
    } catch (err) {
      // Attempt recovery from last checkpoint via ContinuationEngine
      if (this.continuationEngine) {
        try {
          const recovered = await this.continuationEngine.findLatestCheckpoint();
          if (recovered) {
            this.emitReasoning(`recovered from checkpoint at iteration ${recovered.iterationsCompleted ?? "unknown"}`);
          }
        } catch {
          // Recovery failure is non-fatal
        }
      }
      return this.handleFatalError(err);
    }
  }

  /**
   * 에이전트 실행 완료 후 메모리를 자동 업데이트한다.
   * - 변경된 파일 목록 기록
   * - 성공/실패 패턴 학습
   */
  private async updateMemoryAfterRun(
    userGoal: string,
    result: AgentTermination,
    runDurationMs = 0,
  ): Promise<void> {
    if (!this.enableMemory || !this.memoryManager) return;

    try {
      // MemoryUpdater로 풍부한 학습 추출
      const analysis = this.memoryUpdater.analyzeRun({
        goal: userGoal,
        termination: {
          reason: result.reason,
          error: (result as { error?: string }).error,
          summary: (result as { summary?: string }).summary,
        },
        toolResults: this.allToolResults.map((r) => ({
          name: r.name,
          output: r.output,
          success: r.success,
          durationMs: r.durationMs,
        })),
        changedFiles: this.changedFiles,
        messages: this.contextManager.getMessages().map((m) => ({
          role: m.role,
          content: typeof m.content === "string" ? m.content : null,
        })),
        tokensUsed: this.tokenUsage.total,
        durationMs: runDurationMs,
        iterations: this.iterationCount,
      });

      // 추출된 학습을 MemoryManager에 저장
      const learnings = this.memoryUpdater.extractLearnings(analysis, userGoal);
      for (const learning of learnings) {
        this.memoryManager.addLearning(learning.category, learning.content);
      }

      // 감지된 컨벤션 저장 (기존에 추출만 되고 저장 안 되던 버그 수정)
      for (const convention of analysis.conventions) {
        this.memoryManager.addConvention(convention);
      }

      // 감지된 패턴 저장
      for (const pattern of analysis.toolPatterns) {
        if (pattern.successRate > 0.7 && pattern.count >= 3) {
          this.memoryManager.addPattern({
            name: `tool:${pattern.tool}`,
            description: `success ${Math.round(pattern.successRate * 100)}%, avg ${pattern.avgDurationMs}ms`,
            files: this.changedFiles.slice(0, 5),
            frequency: pattern.count,
          });
        }
      }

      // 에러로 종료된 경우 실패 기록도 추가
      if (result.reason === "ERROR") {
        this.memoryManager.addFailedApproach(
          `Task: ${userGoal.slice(0, 80)}`,
          (result as { error?: string }).error ?? "Unknown error",
        );
      }

      // 오래된 항목 정리 (매 5회 실행마다)
      if (this.iterationCount % 5 === 0) {
        this.memoryManager.prune();
      }

      // 메모리 저장
      await this.memoryManager.save();

      // PersonaManager — 유저 프로필 저장 (학습된 커뮤니케이션 스타일 유지)
      if (this.personaManager) {
        await this.personaManager.saveProfile().catch(() => {});
      }
    } catch {
      // 메모리 저장 실패는 치명적이지 않음
    }

    // Reflexion: 실행 결과 반영 + 전략 추출
    if (this.reflexionEngine) {
      try {
        const entry = this.reflexionEngine.reflect({
          goal: userGoal,
          runId: randomUUID(),
          termination: result,
          toolResults: this.allToolResults,
          messages: this.contextManager.getMessages(),
          tokensUsed: this.tokenUsage.total,
          durationMs: runDurationMs,
          changedFiles: this.changedFiles,
        });

        await this.reflexionEngine.store.saveReflection(entry);

        // 성공 시 전략 추출
        if (entry.outcome === "success") {
          const strategy = this.reflexionEngine.extractStrategy(entry, userGoal);
          if (strategy) {
            await this.reflexionEngine.store.saveStrategy(strategy);
          }
        }
      } catch {
        // reflexion 저장 실패는 치명적이지 않음
      }
    }
  }

  /**
   * 실행 중인 루프를 중단.
   */
  abort(): void {
    this.aborted = true;
  }

  /**
   * 에이전트에 인터럽트 시그널을 전달한다.
   * InterruptManager로 위임하며, 관련 이벤트를 발행한다.
   *
   * @param signal - 인터럽트 시그널
   */
  interrupt(signal: InterruptSignal): void {
    this.interruptManager.interrupt(signal);

    // Emit as agent:error for external listeners (backward-compatible)
    this.emitEvent({
      kind: "agent:error",
      message: `Interrupt received: ${signal.type}${signal.feedback ? ` — ${signal.feedback}` : ""}`,
      retryable: signal.type === "soft",
    });

    // Also emit raw interrupt event on the EventEmitter for specialized listeners
    this.emit("interrupt", signal);
  }

  /**
   * InterruptManager 인스턴스를 반환한다.
   * 외부에서 직접 인터럽트를 전달하거나 이벤트를 구독할 때 사용.
   */
  getInterruptManager(): InterruptManager {
    return this.interruptManager;
  }

  /**
   * 현재 토큰 사용량을 반환.
   */
  getTokenUsage(): Readonly<TokenUsage> {
    return { ...this.tokenUsage };
  }

  /** Get the plugin registry for external management */
  getPluginRegistry(): PluginRegistry {
    return this.pluginRegistry;
  }

  /** Get the specialist registry for custom specialist registration */
  getSpecialistRegistry(): SpecialistRegistry {
    return this.specialistRegistry;
  }

  /** Get the skill learner for inspection */
  getSkillLearner(): SkillLearner | null {
    return this.skillLearner;
  }

  /** Get the repo knowledge graph */
  getRepoGraph(): RepoKnowledgeGraph | null {
    return this.repoGraph;
  }

  /** Get background agent manager */
  getBackgroundAgentManager(): BackgroundAgentManager | null {
    return this.backgroundAgentManager;
  }

  /**
   * ContinuousReflection이 사용하는 에이전트 상태 스냅샷을 생성한다.
   * 읽기 전용 — reflection tick마다 호출된다.
   */
  getStateSnapshot(): AgentStateSnapshot {
    const userMsg = this.contextManager.getMessages().find((m) => m.role === "user");
    const goal = typeof userMsg?.content === "string" ? userMsg.content : "";
    const progress = this.extractProgress();
    const recentTools = this.allToolResults.slice(-3).map((r) => ({
      tool: r.name,
      input: typeof r.tool_call_id === "string" ? r.tool_call_id : "",
      output: r.output.slice(0, 200),
    }));
    const errors = this.allToolResults
      .filter((r) => !r.success)
      .slice(-5)
      .map((r) => `${r.name}: ${r.output.slice(0, 200)}`);

    return {
      goal,
      iteration: this.iterationCount,
      maxIteration: this.config.loop.maxIterations,
      changedFiles: [...this.changedFiles],
      recentToolCalls: recentTools,
      errors,
      contextUsagePercent:
        this.config.loop.totalTokenBudget > 0
          ? this.tokenUsage.total / this.config.loop.totalTokenBudget
          : 0,
      sessionId: this.sessionId ?? "unknown-session",
      totalTokensUsed: this.tokenUsage.total,
      workingMemory: this.buildWorkingMemorySummary(),
      completedTasks: progress.completedTasks,
      currentTask: progress.currentTask,
      remainingTasks: progress.remainingTasks,
    };
  }

  /**
   * ContinuousReflection 인스턴스를 반환한다.
   * 외부에서 ESC 토글(pause/resume) 또는 이벤트 구독에 사용.
   */
  getContinuousReflection(): ContinuousReflection | null {
    return this.continuousReflection;
  }

  /**
   * 대화 히스토리를 반환.
   */
  getHistory(): Message[] {
    return this.contextManager.getMessages();
  }

  /**
   * ApprovalManager 인스턴스를 반환.
   * CLI/UI에서 핸들러를 등록하거나 설정을 변경할 때 사용.
   */
  getApprovalManager(): ApprovalManager {
    return this.approvalManager;
  }

  /**
   * AutoFixLoop 인스턴스를 반환.
   * 수정 시도 기록 등을 조회할 때 사용.
   */
  getAutoFixLoop(): AutoFixLoop {
    return this.autoFixLoop;
  }

  /**
   * TokenBudgetManager 인스턴스를 반환.
   * 역할별 토큰 사용량 조회/리밸런싱에 사용.
   */
  getTokenBudgetManager(): TokenBudgetManager {
    return this.tokenBudgetManager;
  }

  // ─── Planning ───

  /**
   * 사용자 메시지의 복잡도를 감지하고, 복잡한 태스크이면 계획을 수립하여 컨텍스트에 주입.
   *
   * 복잡도 판단 기준:
   * - 메시지 길이, 파일/작업 수 언급, 키워드 패턴
   * - "trivial"/"simple" → 플래닝 스킵 (LLM이 직접 처리)
   * - "moderate" 이상 → HierarchicalPlanner로 L1+L2 계획 수립
   */
  private async maybeCreatePlan(userMessage: string): Promise<void> {
    if (!this.planner || !this.enablePlanning) return;

    const complexity = await this.detectComplexity(userMessage);
    this.currentComplexity = complexity;

    // 임계값 미만이면 플래닝 스킵
    // Bug 4 fix: extend thresholdOrder to include "massive" (4), so that when planningThreshold
    // is "complex", both "complex" (3) and "massive" (4) trigger planning.
    // Previously "massive" had no entry and fell through to undefined → NaN comparisons.
    const thresholdOrder: Record<string, number> = { simple: 1, moderate: 2, complex: 3, massive: 4 };
    const complexityOrder: Record<string, number> = {
      trivial: 0, simple: 1, moderate: 2, complex: 3, massive: 4,
    };
    // Use the threshold for the configured level; "complex" threshold activates for complexity >= "complex"
    const effectiveThreshold = thresholdOrder[this.planningThreshold] ?? 2;
    if ((complexityOrder[complexity] ?? 0) < effectiveThreshold) {
      return;
    }

this.emitSubagent("planner", "start", `task complexity ${complexity}. creating execution plan`);

try {
  const plan = await this.planner.createHierarchicalPlan(
    userMessage,
    this.llmClient,
  );

  this.activePlan = plan;
  this.currentTaskIndex = 0;

  // Run plan simulation + extract milestones
  if (this.simulationEngine && this.milestoneChecker && this.activePlan) {
    const capturedPlan = this.activePlan;
    this.simulationEngine.simulate(capturedPlan).then((simResult) => {
      if (simResult.criticalSteps.length > 0 || simResult.overallSuccessProbability < 0.6) {
        this.contextManager.addMessage({
          role: "system",
          content: this.simulationEngine!.formatForPrompt(simResult),
        });
      }
    }).catch(() => {/* non-blocking */});

    this.activeMilestones = this.milestoneChecker.extractMilestones(this.activePlan);
    this.completedPlanTaskIds.clear();
  }

  const planTokenEstimate = plan.tactical.length * 500;
  this.tokenBudgetManager.recordUsage("planner", planTokenEstimate, planTokenEstimate);

  const planContext = this.formatPlanForContext(plan);
  this.contextManager.addMessage({
    role: "system",
    content: planContext,
  });

  this.emitSubagent(
    "planner",
    "done",
    `plan created: ${plan.tactical.length} tasks, ${plan.totalEstimatedIterations} estimated iterations, risk ${plan.strategic.riskAssessment.level}`,
  );

} catch (err) {
  this.emitEvent({
    kind: "agent:error",
    message: `Planning failed: ${err instanceof Error ? err.message : String(err)}`,
    retryable: false,
  });
}
  }
  /**
   * 사용자 메시지에서 태스크 복잡도를 휴리스틱으로 추정.
   * LLM 호출 없이 빠르게 결정 (토큰 절약).
   */
  /**
   * Detect the best test/verify command for the current project.
   * Bug 3 fix: replaces the hardcoded "pnpm build" default.
   */
  private detectTestCommand(): string {
    const projectPath = this.config.loop.projectPath;
    try {
      const { existsSync } = require("node:fs") as typeof import("node:fs");
      // Check for package.json with a "test" script
      const pkgPath = `${projectPath}/package.json`;
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(
            require("node:fs").readFileSync(pkgPath, "utf-8") as string,
          ) as Record<string, unknown>;
          const scripts = pkg.scripts as Record<string, string> | undefined;
          if (scripts?.test && scripts.test !== "echo \"Error: no test specified\" && exit 1") {
            // Prefer pnpm if pnpm-lock.yaml exists
            const usesPnpm = existsSync(`${projectPath}/pnpm-lock.yaml`);
            return usesPnpm ? "pnpm test" : "npm test";
          }
        } catch {
          // package.json parse failure — fall through
        }
      }
      // Check for tsconfig.json → TypeScript type check
      if (existsSync(`${projectPath}/tsconfig.json`)) {
        return "npx tsc --noEmit";
      }
    } catch {
      // Require/existsSync failure in unusual environments — use default
    }
    return "pnpm build";
  }

  private _detectComplexityHeuristic(
    message: string,
  ): "trivial" | "simple" | "moderate" | "complex" | "massive" {
    const lower = message.toLowerCase();
    const len = message.length;

    // 복잡도 점수 계산
    let score = 0;

    // 길이 기반
    if (len > 500) score += 2;
    else if (len > 200) score += 1;

    // 다중 파일/작업 키워드
    const multiFileKeywords = [
      "refactor", "리팩토링", "리팩터",
      "migrate", "마이그레이션",
      "모든 파일", "all files", "전체",
      "여러 파일", "multiple files",
      "아키텍처", "architecture",
      "시스템", "system-wide",
    ];
    for (const kw of multiFileKeywords) {
      if (lower.includes(kw)) { score += 2; break; }
    }

    // 여러 작업 나열 (1. 2. 3. 또는 - 으로 나열)
    const listItems = message.match(/(?:^|\n)\s*(?:\d+[.)]\s|-\s)/gm);
    if (listItems && listItems.length >= 3) score += 2;
    else if (listItems && listItems.length >= 2) score += 1;

    // 파일 경로 패턴
    const filePaths = message.match(/\b[\w\-./]+\.[a-z]{1,4}\b/g);
    if (filePaths && filePaths.length >= 5) score += 2;
    else if (filePaths && filePaths.length >= 2) score += 1;

    // 야망형 태스크 키워드 — 짧아도 대형 작업 (score +4 → 즉시 "complex" 이상)
    // "OS 만들어", "설계해줘", "컴파일러 구현" 같은 짧지만 massive한 요청을 잡기 위함
    const ambitiousSystemKeywords = [
      "운영체제", "os ", " os", "kernel", "커널",
      "compiler", "컴파일러", "인터프리터", "interpreter",
      "database", "데이터베이스", "dbms",
      "framework", "프레임워크",
      "vm ", "virtual machine", "가상머신", "hypervisor",
      "distributed", "분산 시스템", "분산시스템",
      "blockchain", "블록체인",
      "게임 엔진", "game engine",
    ];
    for (const kw of ambitiousSystemKeywords) {
      if (lower.includes(kw)) { score += 4; break; }
    }

    // 설계/아키텍처 요청 키워드 (score +3)
    const designKeywords = [
      "설계", "디자인해", "아키텍처 만들", "구조 설계",
      "design the", "architect the", "design a ", "design an ",
      "from scratch", "처음부터", "새로 만들", "전부 만들",
    ];
    for (const kw of designKeywords) {
      if (lower.includes(kw)) { score += 3; break; }
    }

    // 전체 구현 요청 키워드 (score +2)
    const buildKeywords = [
      "만들어줘", "만들어 줘", "만들어봐", "구현해줘", "개발해줘",
      "build me", "create a full", "implement a full", "make me a",
      "전체 구현", "full implementation", "complete implementation",
    ];
    for (const kw of buildKeywords) {
      if (lower.includes(kw)) { score += 2; break; }
    }

    // 간단한 작업 키워드 (감점)
    const simpleKeywords = [
      "fix", "고쳐", "수정해",
      "rename", "이름 바꿔",
      "한 줄", "one line",
      "간단", "simple", "quick",
    ];
    for (const kw of simpleKeywords) {
      if (lower.includes(kw)) { score -= 1; break; }
    }

    // 점수 → 복잡도
    if (score <= 0) return "trivial";
    if (score <= 1) return "simple";
    if (score <= 3) return "moderate";
    if (score <= 5) return "complex";
    return "massive";
  }

  /**
   * Hybrid complexity detection: keyword heuristic for clear cases,
   * LLM single-word classification for ambiguous borderline cases (score 1-3).
   * This prevents both over-planning (trivial tasks) and under-planning
   * (ambitious short requests that keywords miss across any language).
   */
  private async detectComplexity(
    message: string,
  ): Promise<"trivial" | "simple" | "moderate" | "complex" | "massive"> {
    const heuristic = this._detectComplexityHeuristic(message);

    // Clear extremes — trust heuristic, skip LLM call cost
    if (heuristic === "trivial" || heuristic === "massive") return heuristic;

    // Borderline ambiguous range: ask LLM for one-word verdict
    // Short cheap call: no tools, 1-word response, ~50 tokens total
    try {
      const resp = await this.llmClient.chat(
        [
          {
            role: "user",
            content: `Rate this software task complexity in ONE word only (trivial/simple/moderate/complex/massive). Task: "${message.slice(0, 300)}"`,
          },
        ],
        [], // no tools
      );
      const word = (resp.content ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
      const valid = ["trivial", "simple", "moderate", "complex", "massive"] as const;
      if ((valid as readonly string[]).includes(word)) {
        return word as typeof valid[number];
      }
    } catch {
      // LLM classification failure — fall back to heuristic
    }

    return heuristic;
  }

  /**
   * HierarchicalPlan을 LLM이 따라갈 수 있는 컨텍스트 메시지로 포맷.
   */
  private formatPlanForContext(plan: HierarchicalPlan): string {
    const parts: string[] = [];

    parts.push("## Execution Plan");
    parts.push(`**Goal:** ${plan.goal}`);
    parts.push(`**Complexity:** ${plan.strategic.estimatedComplexity}`);
    parts.push(`**Risk:** ${plan.strategic.riskAssessment.level}`);

    if (plan.strategic.riskAssessment.requiresApproval) {
      parts.push("**⚠ Requires user approval for high-risk operations.**");
    }

    parts.push("\n### Tasks (execute in order):");
    for (let i = 0; i < plan.tactical.length; i++) {
      const task = plan.tactical[i];
      const deps = task.dependsOn.length > 0
        ? ` (after: ${task.dependsOn.join(", ")})`
        : "";
      parts.push(`${i + 1}. **${task.description}**${deps}`);
      if (task.targetFiles.length > 0) {
        parts.push(`   Files: ${task.targetFiles.join(", ")}`);
      }
      if (task.readFiles.length > 0) {
        parts.push(`   Read: ${task.readFiles.join(", ")}`);
      }
      parts.push(`   Tools: ${task.toolStrategy.join(", ")}`);
    }

    if (plan.strategic.riskAssessment.mitigations.length > 0) {
      parts.push("\n### Risk Mitigations:");
      for (const m of plan.strategic.riskAssessment.mitigations) {
        parts.push(`- ${m}`);
      }
    }

    parts.push("\n### Execution Instructions:");
    parts.push("- Follow the task order above. Complete each task before moving to the next.");
    parts.push("- Read target files before modifying them.");
    parts.push("- If a task fails, report the error and attempt an alternative approach.");
    parts.push("- After all tasks, verify the changes work correctly.");

    return parts.join("\n");
  }

  /**
   * 실행 중 에러 발생 시 리플래닝을 시도한다.
   * @returns 리플래닝 성공 시 true (계속 진행), 실패 시 false
   */
  private async attemptReplan(
    error: string,
    failedTaskId?: string,
  ): Promise<boolean> {
    if (!this.planner || !this.activePlan) return false;

    const trigger: RePlanTrigger = {
      type: "error",
      description: error,
      affectedTaskIds: failedTaskId ? [failedTaskId] : [],
      severity: "major",
    };

    try {
      const result = await this.planner.replan(
        this.activePlan,
        trigger,
        this.llmClient,
      );

      if (result.strategy === "escalate") {
        // 에스컬레이션 → 유저에게 알림
        this.emitEvent({
          kind: "agent:error",
          message: `Re-plan escalated: ${result.reason}`,
          retryable: false,
        });
        return false;
      }

      // 수정된 태스크로 업데이트
      if (result.modifiedTasks.length > 0) {
        // 기존 tactical 태스크를 교체
        for (const modTask of result.modifiedTasks) {
          const idx = this.activePlan.tactical.findIndex(
            (t) => t.id === modTask.id,
          );
          if (idx >= 0) {
            this.activePlan.tactical[idx] = modTask;
          } else {
            this.activePlan.tactical.push(modTask);
          }
        }

        // 리플래닝 결과를 컨텍스트에 주입
        this.contextManager.addMessage({
          role: "system",
          content: `[Re-plan] Strategy: ${result.strategy}. Reason: ${result.reason}.\nModified tasks: ${result.modifiedTasks.map((t) => t.description).join(", ")}`,
        });
      }

      // Estimate replan token usage
      this.tokenBudgetManager.recordUsage("planner", 500, 500);

      this.emitEvent({
        kind: "agent:thinking",
        content: `Re-planned: ${result.strategy} — ${result.reason}`,
      });

      return true;
    } catch {
      return false;
    }
  }

  /**
   * 현재 활성 플랜을 반환 (외부에서 진행 상황 조회용).
   */
  getActivePlan(): HierarchicalPlan | null {
    return this.activePlan;
  }

  // ─── Core Loop ───

  private async executeLoop(): Promise<AgentTermination> {
let iteration = this.iterationCount;

    while (!this.aborted) {
  // ensure loop state always matches persisted iteration
  if (iteration !== this.iterationCount) {
    iteration = this.iterationCount;
  }
 if (this.abortSignal?.aborted) {
    return { reason: "USER_CANCELLED" };
  }
      if (iteration === 0) this.emitReasoning("starting agent loop");
      // Interrupt: pause 상태이면 resume될 때까지 대기
      if (this.interruptManager.isPaused()) {
        await this.waitForResume();
        // hard interrupt로 paused된 경우 aborted일 수 있음
        if (this.aborted) break;
      }

      // Governor: iteration 검증
      try {
        this.governor.checkIteration();
      } catch (err) {
        if (err instanceof PlanLimitError) {
          return {
            reason: "MAX_ITERATIONS",
            lastState: `Stopped at iteration ${iteration}: ${err.message}`,
          };
        }
        throw err;
      }

      iteration++;
      this.iterationCount = iteration;
      const iterationStart = Date.now();
      this.emitReasoning(`iteration ${iteration}: preparing context`);
      this.iterationSystemMsgCount = 0; // Reset per-iteration (prevents accumulation across iterations)

      // Proactive replanning check (every 10 iterations when plan is active)
      if (
        this.replanningEngine &&
        this.activePlan &&
        this.activeMilestones.length > 0 &&
        iteration > 0 &&
        iteration % 10 === 0
      ) {
        try {
          const tokenBudget = this.config?.loop?.totalTokenBudget ?? 200_000;
          const tokensUsed = this.tokenUsage.total;

          const replanResult = await this.replanningEngine.evaluate(
            this.activePlan,
            this.worldModel?.getState() ?? ({} as WorldState),
            [...this.completedPlanTaskIds],
            this.allToolResultsSinceLastReplan,
            tokensUsed,
            tokenBudget,
            [...this.changedFiles],
            iteration,
            this.activeMilestones,
            this.llmClient,
          );

          if (replanResult.triggered) {
            this.emitEvent({ kind: "agent:thinking", content: `[Proactive Replan] ${replanResult.message}` });

            if (replanResult.newPlan) {
              this.activePlan = replanResult.newPlan;
              this.activeMilestones = this.milestoneChecker!.extractMilestones(this.activePlan);
              this.completedPlanTaskIds.clear();
            } else if (replanResult.modifiedTasks && replanResult.modifiedTasks.length > 0) {
              for (const modified of replanResult.modifiedTasks) {
                const idx = this.activePlan.tactical.findIndex(t => t.id === modified.id);
                if (idx >= 0) this.activePlan.tactical[idx] = modified;
              }
            }

            // Reset tool results accumulator after replan
            this.allToolResultsSinceLastReplan = [];

            // Inject replan notice into context
            this.contextManager.addMessage({
              role: "system",
              content: `[Proactive Replan] ${replanResult.message}\nScope: ${replanResult.decision.scope}, Risk: ${replanResult.decision.urgency}`,
            });
          }
        } catch {
          // Non-blocking — proactive replanning failures should not crash the agent
        }
      }

      // Plan progress injection — every 3 iterations or when task advances
      if (this.activePlan) {
        this.injectPlanProgress(iteration);
      }

      // Policy validation — check cost limits from ExecutionPolicyEngine
      if (this.policyEngine) {
        try {
          const costPolicy = this.policyEngine.get("cost");
          const iterationTokensUsed = this.tokenUsage.input + this.tokenUsage.output;
          if (costPolicy.maxTokensPerIteration > 0 && iterationTokensUsed > costPolicy.maxTokensPerIteration) {
            this.emitReasoning(`policy blocked iteration ${iteration}: token usage ${iterationTokensUsed} exceeds maxTokensPerIteration ${costPolicy.maxTokensPerIteration}`);
            return { reason: "BUDGET_EXHAUSTED", tokensUsed: iterationTokensUsed };
          }
        } catch {
          // Policy engine failure is non-fatal
        }
      }

      // Soft context rollover:
      // checkpoint first, then let ContextManager compact instead of aborting/throwing.
      const contextUsageRatio = this.contextManager.getUsageRatio();

      // Task 1: ContextBudgetManager LLM summarization at 60-70% — runs BEFORE ContextCompressor
      // Summarizes old "medium" priority conversation turns into a compact summary message,
      // freeing tokens before the heavier ContextCompressor kicks in at 70%.
      if (contextUsageRatio >= 0.60 && contextUsageRatio < 0.70 && this.contextBudgetManager && !this._contextSummarizationDone) {
        this._contextSummarizationDone = true; // run at most once per agent turn
        // Non-blocking: fire-and-forget so the main iteration is not stalled
        this.contextBudgetManager.importMessages(this.contextManager.getMessages());
        if (this.contextBudgetManager.needsSummarization()) {
          const budgetMgr = this.contextBudgetManager;
          const ratio = contextUsageRatio;
          budgetMgr.summarize(async (prompt: string): Promise<string> => {
            const resp = await this.llmClient.chat(
              [{ role: "user", content: prompt }],
              [],
            );
            return typeof resp.content === "string" ? resp.content : "";
          }).then(summary => {
            if (summary) {
              this.emitEvent({
                kind: "agent:thinking",
                content: `Context at ${Math.round(ratio * 100)}%: summarized ${summary.originalIds.length} old messages (${summary.originalTokens} → ${summary.summarizedTokens} tokens, ${Math.round(summary.compressionRatio * 100)}% ratio).`,
              });
            }
          }).catch(() => {
            // summarization failure is non-fatal
          });
        }
      }

      // Bug 5 fix: use ContextCompressor as an alternative when context pressure is high (>70%)
      // At 70-84% we apply intelligent priority-based compression before falling back to truncation.
      if (contextUsageRatio >= 0.70 && contextUsageRatio < 0.85) {
        try {
          // Estimate maxTokens from the usage ratio and current message count
          // contextUsageRatio = estimatedTokens / (maxTokens - outputReserve)
          // We use a conservative 128_000 as a safe upper bound
          const estimatedMaxTokens = 128_000;
          const contextCompressor = new ContextCompressor({
            maxTokens: estimatedMaxTokens,
            reserveTokens: Math.ceil(estimatedMaxTokens * 0.15),
          });
          const currentMessages = this.contextManager.getMessages();
          const currentTokenEstimate = Math.ceil(estimatedMaxTokens * contextUsageRatio);
          const compressed = contextCompressor.compress(currentMessages, currentTokenEstimate);
          if (compressed.evicted > 0 || compressed.summarized > 0) {
            // Replace messages in contextManager with compressed version
            // by clearing and re-adding (contextManager.addMessages is the public API)
            const internalMessages = (this.contextManager as unknown as { messages: import("./types.js").Message[] }).messages;
            if (internalMessages) {
              internalMessages.length = 0;
              internalMessages.push(...compressed.messages);
            }
            this.emitEvent({
              kind: "agent:thinking",
              content: `Context pressure ${Math.round(contextUsageRatio * 100)}%: ContextCompressor applied (evicted ${compressed.evicted}, summarized ${compressed.summarized} messages).`,
            });
          }
        } catch {
          // ContextCompressor failure is non-fatal; ContextManager will handle via compactHistory
        }
      }

      if (contextUsageRatio >= 0.85) {
        if (!this.checkpointSaved) {
          await this.saveAutoCheckpoint(iteration);
          this.checkpointSaved = true;
        }
        this.emitEvent({
          kind: "agent:thinking",
          content:
            `High context pressure detected (${Math.round(contextUsageRatio * 100)}%). ` +
            `Compressing conversation state and continuing.`,
        });
      }

      // Check file-pattern skill triggers based on changed files
      // Guard: skip skill injection if over 80% token budget to preserve remaining budget
      // Guard: max 3 active skills globally (Context Budget Rules)
      const fileTriggerBudgetRatio = this.config.loop.totalTokenBudget > 0
        ? this.tokenUsage.total / this.config.loop.totalTokenBudget
        : 0;
      if (
        this.changedFiles.length > 0 &&
        fileTriggerBudgetRatio <= 0.8 &&
        this.activeSkillIds.length < AgentLoop.MAX_ACTIVE_SKILLS
      ) {
        const lastFile = this.changedFiles[this.changedFiles.length - 1];
        const fileSkills = this.pluginRegistry.findMatchingSkills({
          filePath: lastFile,
        });
        // Max 2 skills per iteration, capped by global 3-skill limit
        const slotsRemaining = AgentLoop.MAX_ACTIVE_SKILLS - this.activeSkillIds.length;
        for (const skill of fileSkills.slice(0, Math.min(2, slotsRemaining))) {
          if (this.activeSkillIds.includes(skill.id)) continue; // no duplicate
          const parsed = this.skillLoader.loadTemplate(skill);
          if (parsed) {
            this.contextManager.addMessage({
              role: "system",
              content: `[File Skill: ${skill.name}] ${parsed.domain ? `[${parsed.domain}] ` : ""}${skill.description}`,
            });
            this.activeSkillIds.push(skill.id);
            this.iterationSystemMsgCount++;
          }
        }
      }

      // 1. 컨텍스트 준비
      const messages = this.contextManager.prepareForLLM();

      // 2. LLM 호출 (streaming)

      // Before LLM call, check executor budget
      const budgetCheck = this.tokenBudgetManager.canUse("executor", 4000);
      if (!budgetCheck.allowed) {
        this.emitEvent({
          kind: "agent:thinking",
          content: `Token budget warning: ${budgetCheck.reason}`,
        });
        // Try rebalancing to free up budget from idle roles
        this.tokenBudgetManager.rebalance();
      }

     this.emitReasoning(`iteration ${iteration}: calling model`);

      let response: LLMResponse;
      try {
        response = await this.callLLMStreaming(messages);
      } catch (err) {
        if (err instanceof LLMError) {
          return { reason: "ERROR", error: err.message };
        }
        throw err;
      }

      // 토큰 추적
      this.tokenUsage.input += response.usage.input;
      this.tokenUsage.output += response.usage.output;
      this.tokenUsage.total += response.usage.input + response.usage.output;
      this.governor.recordIteration(
        response.usage.input,
        response.usage.output,
      );

      // Role-based token budget 추적
      this.tokenBudgetManager.recordUsage(
        "executor",
        response.usage.input,
        response.usage.output,
      );

      // Cost tracking
      this.costOptimizer.recordUsage(
        this.config.byok.model ?? "unknown",
        response.usage.input,
        response.usage.output,
        "executor",
      );

      // Rebalance budgets every 5 iterations to redistribute from idle roles
      if (iteration % 5 === 0) {
        this.tokenBudgetManager.rebalance();
      }

      this.emitEvent({
        kind: "agent:token_usage",
        input: this.tokenUsage.input,
        output: this.tokenUsage.output,
      });

      // LLM 응답 살균 — 간접 프롬프트 인젝션 방어
      if (response.content) {
        const llmSanitized = this.promptDefense.sanitizeToolOutput("llm_response", response.content);
        if (llmSanitized.injectionDetected) {
          this.emitEvent({
            kind: "agent:error",
            message: `Prompt injection detected in LLM response: ${llmSanitized.patternsFound.join(", ")}`,
            retryable: false,
          });
          // 살균된 콘텐츠로 교체
          response = { ...response, content: llmSanitized.output };
        }
      }

      // 3. 응답 처리
      if (response.toolCalls.length === 0) {
        const content = response.content ?? "";
        let finalSummary = content || "Task completed.";

        const finalImpactSummary = await this.buildFinalImpactSummary();
        if (finalImpactSummary) {
          finalSummary = `${finalSummary}\n\n${finalImpactSummary}`;
        }
        // Level 2: Deep verification before declaring completion
        if (this.selfReflection && this.changedFiles.length > 0) {
          try {
            const changedFilesMap = this.buildChangedFilesMap();

            const verifyFn = async (prompt: string): Promise<string> => {
              const verifyResponse = await this.llmClient.chat([
                { role: "system", content: "You are a meticulous code reviewer." },
                { role: "user", content: prompt },
              ]);
              this.tokenBudgetManager.recordUsage(
                "validator",
                verifyResponse.usage.input,
                verifyResponse.usage.output,
              );
              return verifyResponse.content ?? "";
            };

            const deepResult = await this.selfReflection.deepVerify(
              content || "Complete the task",
              changedFilesMap,
              this.originalSnapshots,
              [], // projectPatterns — could be enhanced with YUAN.md rules
              verifyFn,
            );

            if (deepResult.verdict === "fail" && deepResult.confidence >= 0.5) {
              // Not confident enough — inject feedback and continue loop
              const issuesList = deepResult.suggestedFixes
                .map((f) => `[${f.severity}] ${f.description}`)
                .join("; ");

              this.contextManager.addMessage({
                role: "assistant",
                content: content || "",
              });
              this.contextManager.addMessage({
                role: "system",
                content: `[Self-Reflection L2] Verification failed (score: ${deepResult.overallScore}, confidence: ${deepResult.confidence.toFixed(2)}). ${deepResult.selfCritique}${issuesList ? ` Issues: ${issuesList}` : ""}. Please address these before completing.`,
              });
             this.emitSubagent("verifier", "done", `deep verification failed, score ${deepResult.overallScore}. continuing to address issues`);
              continue; // Don't return GOAL_ACHIEVED, continue the loop
            }

            // Level 3: Multi-agent debate for complex/massive tasks
            if (
              this.debateOrchestrator &&
              ["complex", "massive"].includes(this.currentComplexity) &&
              deepResult.verdict !== "pass"
            ) {
              try {
                this.emitSubagent("reviewer", "start", `starting debate for ${this.currentComplexity} task verification`);


                const debateContext = [
                  `Changed files: ${this.changedFiles.join(", ")}`,
                  `Self-reflection score: ${deepResult.overallScore}/100`,
                  `Concerns: ${deepResult.selfCritique}`,
                ].join("\n");

                const debateResult = await this.debateOrchestrator.debate(
                  content || "Verify task completion",
                  debateContext,
                );

                // Track debate token usage (split roughly 60/40 input/output)
                const debateInput = Math.round(debateResult.totalTokensUsed * 0.6);
                const debateOutput = debateResult.totalTokensUsed - debateInput;
                this.tokenUsage.input += debateInput;
                this.tokenUsage.output += debateOutput;
                this.tokenUsage.total += debateResult.totalTokensUsed;

                if (!debateResult.success) {
                  this.contextManager.addMessage({
                    role: "assistant",
                    content: content || "",
                  });
                  this.contextManager.addMessage({
                    role: "system",
                    content: `[Debate] Multi-agent debate did not pass (score: ${debateResult.finalScore}). ${debateResult.summary}. Please address the identified issues.`,
                  });
                  this.emitEvent({
                    kind: "agent:thinking",
                    content: `Debate failed (score: ${debateResult.finalScore}). Continuing to address issues...`,
                  });
                  continue; // Continue loop to address debate feedback
                }

                this.emitSubagent("reviewer", "done", `debate failed, score ${debateResult.finalScore}. continuing to address issues`);
              } catch {
                // Debate failure is non-fatal — proceed with completion
              }
            }

            // Persist learnings from self-reflection
            if (this.memoryManager) {
              try {
                await this.selfReflection.persistLearnings(this.memoryManager);
              } catch {
                // Learning persistence failure is non-fatal
              }
            }
          } catch {
            // Deep verification failure is non-fatal — proceed with completion
          }
        }

        if (content) {
          this.contextManager.addMessage({
            role: "assistant",
            content: finalSummary,
          });
        }

        // Task 2: QAPipeline "thorough" mode at final task completion (LLM review included)
        if (this.changedFiles.length > 0 && this.config.loop.projectPath) {
          try {
            const thoroughQA = new QAPipeline({
              projectPath: this.config.loop.projectPath,
              level: "thorough",
              enableStructural: true,
              enableSemantic: false, // skip tests for speed — structural + quality + review
              enableQuality: true,
              enableReview: true,
              enableDecision: true,
              autoFix: false,
            });
            const thoroughResult = await thoroughQA.run(
              this.changedFiles,
              async (prompt: string): Promise<string> => {
                try {
                  const reviewResp = await this.llmClient.chat(
                    [
                      { role: "system", content: "You are a code reviewer. Review the code changes concisely." },
                      { role: "user", content: prompt },
                    ],
                    [],
                  );
                  return typeof reviewResp.content === "string" ? reviewResp.content : "";
                } catch {
                  return "";
                }
              },
            );
            const thoroughFailures = thoroughResult.stages
              .flatMap((s) => s.checks)
              .filter((c) => c.status === "fail");
            const thoroughIssues = thoroughFailures
              .slice(0, 10)
              .map((c) => `[${c.severity}] ${c.name}: ${c.message}`);
            // Emit structured qa_result event for TUI display
            this.emitEvent({
              kind: "agent:qa_result",
              stage: "thorough",
              passed: thoroughFailures.length === 0,
              issues: thoroughIssues,
            });
            this.lastQAResult = thoroughResult;
          } catch {
            // Thorough QA failure is non-fatal — proceed with completion
          }
        }

        this.emitEvent({
          kind: "agent:completed",
    summary: finalSummary,
  filesChanged: this.changedFiles
        });
this.emitEvent({
  kind: "agent:reasoning_tree",
  tree: this.reasoningTree.toJSON(),
});
        return {
          reason: "GOAL_ACHIEVED",
          summary: finalSummary,
        };
      }

      // 어시스턴트 메시지 저장 (tool_calls 포함)
      this.contextManager.addMessage({
        role: "assistant",
        content: response.content,
        tool_calls: response.toolCalls,
      });

      if (response.toolCalls.length > 1 && iteration === this.iterationCount) {
        const batchId = `batch_${Date.now()}`;
        this.emitEvent({
          kind: "agent:tool_batch",
          batchId,
          size: response.toolCalls.length,
        });
      }
      // 4. 도구 실행
      const { results: toolResults, deferredFixPrompts } = await this.executeTools(response.toolCalls);

      // Reflexion: 도구 결과 수집
      this.allToolResults.push(...toolResults);

      // Accumulate tool results for proactive replanning evaluation
      this.allToolResultsSinceLastReplan.push(...toolResults);

      // Tool plan tracking: 실행된 도구 이름 기록
      for (const result of toolResults) {
        this.executedToolNames.push(result.name);
      }

      // 5. 도구 결과를 히스토리에 추가 (살균 + 압축)
      for (const result of toolResults) {
        // Prompt injection 방어: 도구 출력 살균
        const sanitized = this.promptDefense.sanitizeToolOutput(
          result.name,
          result.output,
        );

        if (sanitized.injectionDetected) {
          this.emitEvent({
            kind: "agent:error",
            message: `Prompt injection detected in ${result.name} output: ${sanitized.patternsFound.join(", ")}`,
            retryable: false,
          });
        }

        // 큰 결과는 추가 압축
        const compressedOutput = this.contextManager.compressToolResult(
          result.name,
          sanitized.output,
        );

        this.contextManager.addMessage({
          role: "tool",
          content: compressedOutput,
          tool_call_id: result.tool_call_id,
        });
      }

      // AutoFix: deferred fix prompts를 tool results 뒤에 추가
      // (tool results 전에 넣으면 OpenAI 400 에러 발생 — tool_calls 뒤에 tool 메시지가 바로 와야 함)
      for (const fixPrompt of deferredFixPrompts) {
        this.contextManager.addMessage({
          role: "user",
          content: fixPrompt,
        });
      }

      // Task 2: QAPipeline — run "quick" (structural only) after any WRITE tool call this iteration
      const projectPath = this.config.loop.projectPath;
      if (this.iterationWriteToolPaths.length > 0 && projectPath) {
        try {
          const qaPipeline = new QAPipeline({
            projectPath,
            level: "quick",
            enableStructural: true,
            enableSemantic: false,
            enableQuality: false,
            enableReview: false,
            enableDecision: true,
            autoFix: false,
          });
          const qaResult = await qaPipeline.run(this.iterationWriteToolPaths);
          this.lastQAResult = qaResult;

          // Surface QA issues as a system message so LLM sees them next iteration
          const failedChecks = qaResult.stages
            .flatMap((s) => s.checks)
            .filter((c) => c.status === "fail" || c.status === "warn");

          const qaIssues = failedChecks
            .slice(0, 10)
            .map((c) => `[${c.severity}] ${c.name}: ${c.message}`);

          // Emit structured qa_result event for TUI display
          this.emitEvent({
            kind: "agent:qa_result",
            stage: "quick",
            passed: failedChecks.length === 0,
            issues: qaIssues,
          });

          if (failedChecks.length > 0 && this.iterationSystemMsgCount < 5) {
            const checkSummary = failedChecks
              .slice(0, 5)
              .map((c) => `  - [${c.severity}] ${c.name}: ${c.message}`)
              .join("\n");
            this.contextManager.addMessage({
              role: "system",
              content: `[QA Quick Check] ${failedChecks.length} issue(s) detected in modified files:\n${checkSummary}`,
            });
            this.iterationSystemMsgCount++;
          }
        } catch {
          // QAPipeline failure is non-fatal
        }
      }
      // Reset per-iteration write tool tracking
      this.iterationWriteToolPaths = [];

      // Task 3: Auto-run tsc --noEmit after 2+ TS files modified in this iteration
      // Skip if tsc was already run in the previous iteration (cooldown)
      const tscFilesThisIteration = [...this.iterationTsFilesModified];
      this.iterationTsFilesModified = []; // reset for next iteration
      const tscRanPrev = this.tscRanLastIteration;
      this.tscRanLastIteration = false; // will set to true below if we run it

      if (tscFilesThisIteration.length >= 2 && projectPath && !tscRanPrev) {
        try {
          const tscResult = await this.toolExecutor.execute({
            id: `auto-tsc-${Date.now()}`,
            name: "shell_exec",
            arguments: JSON.stringify({
              command: "npx tsc --noEmit 2>&1 || true",
              cwd: projectPath,
              timeout: 60000,
            }),
          });
          this.tscRanLastIteration = true;

          // Inject TypeScript errors into context so LLM sees them next iteration
          if (tscResult.success && tscResult.output && tscResult.output.trim().length > 0) {
            const tscOutput = tscResult.output.trim();
            // Only inject if there are actual TS errors (output is non-empty)
            const hasErrors = tscOutput.includes(": error TS") || tscOutput.includes("error TS");
            if (hasErrors && this.iterationSystemMsgCount < 5) {
              // Truncate long tsc output to avoid context bloat
              const truncated = tscOutput.length > 2000
                ? tscOutput.slice(0, 2000) + "\n[...tsc output truncated]"
                : tscOutput;
              this.contextManager.addMessage({
                role: "system",
                content: `[Auto-TSC] TypeScript errors detected after modifying ${tscFilesThisIteration.length} files:\n\`\`\`\n${truncated}\n\`\`\`\nPlease fix these type errors.`,
              });
              this.iterationSystemMsgCount++;
              this.emitEvent({
                kind: "agent:thinking",
                content: `Auto-TSC: TypeScript errors found after editing ${tscFilesThisIteration.join(", ")}.`,
              });
            } else if (!hasErrors) {
              this.emitEvent({
                kind: "agent:thinking",
                content: `Auto-TSC: No type errors after editing ${tscFilesThisIteration.length} file(s).`,
              });
            }
          }
        } catch {
          // Auto-tsc failure is non-fatal
          this.tscRanLastIteration = false;
        }
      }

      // Plan task advancement — check if current task's target files were modified
      if (this.activePlan) {
        this.tryAdvancePlanTask();
      }

      // iteration 이벤트
      this.emitEvent({
        kind: "agent:iteration",
        index: iteration,
        tokensUsed: response.usage.input + response.usage.output,
        durationMs: Date.now() - iterationStart,
      });
// session checkpoint
if (this.sessionPersistence && this.sessionId) {
  const checkpoint: CheckpointData = {
    iteration,
    tokenUsage: {
      input: this.tokenUsage.input,
      output: this.tokenUsage.output,
    },
    timestamp: new Date().toISOString(),
    changedFiles: this.changedFiles,
  };

  await this.sessionPersistence.checkpoint(this.sessionId, checkpoint);
}
      // ReflexionEngine: reflect on this iteration's tool results
      if (this.reflexionEngine && toolResults.length > 0) {
        try {
          const iterReflection = this.reflexionEngine.reflect({
            goal: "",
            runId: `iter-${iteration}-${randomUUID()}`,
            termination: { reason: "USER_CANCELLED" },
            toolResults,
            messages: this.contextManager.getMessages(),
            tokensUsed: this.tokenUsage.total,
            durationMs: Date.now() - iterationStart,
            changedFiles: this.changedFiles,
          });
          // Build insight from available reflection fields
          const insight =
            iterReflection.reflection.alternativeApproach ??
            (iterReflection.reflection.whatFailed.length > 0
              ? iterReflection.reflection.whatFailed.slice(0, 2).join("; ")
              : null);
          if (insight && insight.length > 10 && this.iterationSystemMsgCount < 5) {
            this.contextManager.addMessage({
              role: "system",
              content: `[Reflection] ${insight}`,
            });
            this.iterationSystemMsgCount++;
          }
        } catch {
          // Reflection failure is non-fatal
        }
      }

      // Level 1: Quick verification after every 3rd iteration
      if (this.selfReflection && iteration % 3 === 0) {
        try {
          this.emitSubagent("verifier", "start", "running quick verification");
          const changedFilesMap = this.buildChangedFilesMap();

          const quickResult = await this.selfReflection.quickVerify(
            changedFilesMap,
            async (prompt: string) => {
              const verifyResponse = await this.llmClient.chat([
                { role: "system", content: "You are a code verification assistant." },
                { role: "user", content: prompt },
              ]);
              this.tokenBudgetManager.recordUsage(
                "validator",
                verifyResponse.usage.input,
                verifyResponse.usage.output,
              );
              return verifyResponse.content ?? "";
            },
          );

          if (quickResult.verdict !== "pass") {
            const issues = Object.entries(quickResult.dimensions)
              .filter(([, dim]) => dim.issues.length > 0)
              .flatMap(([, dim]) => dim.issues);

            if (issues.length > 0) {
              this.contextManager.addMessage({
                role: "system",
                content: `[Self-Reflection L1] Issues detected: ${issues.join(", ")}. Confidence: ${quickResult.confidence}`,
              });
              this.emitSubagent("verifier", "done", `quick verification flagged ${issues.length} issues, confidence ${quickResult.confidence.toFixed(2)}`);
            } else {
              this.emitSubagent("verifier", "done", `quick verification passed, confidence ${quickResult.confidence.toFixed(2)}`);
            }
          }
        } catch {
          // Quick verification failure is non-fatal
        }
      }

      // 에러가 많으면 FailureRecovery + 리플래닝 시도
      const errorResults = toolResults.filter((r) => !r.success);
      if (errorResults.length > 0) {
        const errorSummary = errorResults
          .map((r) => `${r.name}: ${r.output}`)
          .join("\n");

        // FailureRecovery: 근본 원인 분석 + 전략 선택
        const rootCause = this.failureRecovery.analyzeRootCause(
          errorSummary,
          errorResults[0]?.name,
        );
        const decision = this.failureRecovery.selectStrategy(rootCause, {
          error: errorSummary,
          toolName: errorResults[0]?.name,
          toolOutput: errorResults[0]?.output,
          attemptNumber: iteration,
          maxAttempts: this.config.loop.maxIterations,
          changedFiles: this.changedFiles,
          originalSnapshots: this.originalSnapshots,
          previousStrategies: this.previousStrategies,
        });

        this.previousStrategies.push(decision.strategy);
        this.failureRecovery.recordStrategyResult(decision.strategy, false);

        if (decision.strategy === "escalate") {
          // 에스컬레이션: 유저에게 도움 요청
          this.emitEvent({
            kind: "agent:error",
            message: `Recovery escalated: ${decision.reason}`,
            retryable: false,
          });
        } else if (decision.strategy === "rollback") {
          // 롤백 시도
          await this.failureRecovery.executeRollback(
            this.changedFiles,
            this.originalSnapshots,
          );
          this.emitEvent({
  kind: "agent:reasoning_delta",
  text: `rollback executed: ${decision.reason}`,
  source: "agent",
          });
        } else if (this.iterationSystemMsgCount < 5) {
          // retry, approach_change, scope_reduce → 복구 프롬프트 주입
          // Context Budget: consolidated error guidance (recovery + debug in one message)
          const recoveryPrompt = this.failureRecovery.buildRecoveryPrompt(
            decision,
            {
              error: errorSummary,
              attemptNumber: iteration,
              maxAttempts: this.config.loop.maxIterations,
              changedFiles: this.changedFiles,
              originalSnapshots: this.originalSnapshots,
              previousStrategies: this.previousStrategies,
            },
          );

          // SelfDebugLoop: merge debug strategy into recovery message (not separate system msg)
          let debugSuffix = "";
          if (iteration >= 3) {
            const rootCauseAnalysis = this.selfDebugLoop.analyzeError(errorSummary);
            if (rootCauseAnalysis.confidence >= 0.5) {
              const debugStrategy = this.selfDebugLoop.selectStrategy(
                iteration - 2,
                [],
              );
              // Bug 3 fix: use dynamic test command detection instead of hardcoded "pnpm build"
              const testCmd = (this.config.loop as unknown as Record<string, unknown>).testCommand as string | undefined
                ?? this.detectTestCommand();
              const debugPrompt = this.selfDebugLoop.buildFixPrompt(debugStrategy, {
                testCommand: testCmd,
                errorOutput: errorSummary,
                changedFiles: this.changedFiles,
                originalSnapshots: this.originalSnapshots,
                previousAttempts: [],
                currentStrategy: debugStrategy,
              });
              debugSuffix = `\n\n[SelfDebug L${Math.min(iteration - 2, 5)}] Strategy: ${debugStrategy}\n${debugPrompt}`;

              // Bug 2 fix: wire a real llmFixer so selfDebugLoop.debug() can call LLM
              if (debugStrategy !== "escalate") {
                this.selfDebugLoop.debug({
                  testCommand: testCmd,
                  errorOutput: errorSummary,
                  changedFiles: this.changedFiles,
                  originalSnapshots: this.originalSnapshots,
                  toolExecutor: this.toolExecutor,
                  llmFixer: async (prompt: string): Promise<string> => {
                    try {
                      const response = await this.llmClient.chat(
                        [
                          { role: "system", content: "You are an expert debugging assistant. Analyze the error and provide tool calls to fix it." },
                          { role: "user", content: prompt },
                        ],
                        [],
                      );
                      return response.content ?? "";
                    } catch {
                      return "";
                    }
                  },
                }).catch(() => {
                  // selfDebugLoop.debug() failures are non-fatal — recovery continues
                });
              }
            }
          }

          this.contextManager.addMessage({
            role: "system",
            content: recoveryPrompt + debugSuffix,
          });
          this.iterationSystemMsgCount++;
        }

        // HierarchicalPlanner 리플래닝도 시도
        if (this.activePlan) {
          await this.attemptReplan(errorSummary);
        }

        // 에러 트리거 예산 비율 계산 (SkillLearner + Plugin 모두 사용)
        const errorTriggerBudgetRatio = this.config.loop.totalTokenBudget > 0
          ? this.tokenUsage.total / this.config.loop.totalTokenBudget
          : 0;

        // Context Budget: skip all optional injections at 85%+ budget
        if (errorTriggerBudgetRatio <= 0.85 && this.iterationSystemMsgCount < 5) {
          // SkillLearner: 학습된 스킬 중 현재 에러에 매칭되는 것 주입
          if (this.skillLearner && this.activeSkillIds.length < AgentLoop.MAX_ACTIVE_SKILLS) {
            try {
              const relevantSkills = this.skillLearner.getRelevantSkills({
                errorMessage: errorSummary,
                language: undefined,
              });
              for (const skill of relevantSkills.slice(0, 1)) {
                if (this.activeSkillIds.includes(skill.id)) continue;
                this.contextManager.addMessage({
                  role: "system",
                  content: `[Learned Skill: ${skill.id}] Diagnosis: ${skill.diagnosis}\nStrategy: ${skill.strategy}\nTools: ${skill.toolSequence.join(" → ")}`,
                });
                this.activeSkillIds.push(skill.id);
                this.iterationSystemMsgCount++;
                this.skillLearner.updateConfidence(skill.id, false);
              }
            } catch {
              // 학습 스킬 매칭 실패는 치명적이지 않음
            }
          }

          // Plugin trigger matching — match errors/context to plugin skills
          if (
            this.activeSkillIds.length < AgentLoop.MAX_ACTIVE_SKILLS &&
            this.iterationSystemMsgCount < 5
          ) {
            const triggerMatches = this.pluginRegistry.matchTriggers({
              errorMessage: errorSummary,
              taskDescription: "",
            });

            if (triggerMatches.length > 0) {
              const bestMatch = triggerMatches[0];
              if (bestMatch.skill && !this.activeSkillIds.includes(bestMatch.skill.id)) {
                const skillTemplate = this.skillLoader.loadTemplate(bestMatch.skill);
                if (skillTemplate) {
                  let resolved = this.skillLoader.resolveTemplate(
                    skillTemplate.content,
                    {
                      error: errorSummary,
                      files: this.changedFiles,
                    },
                  );
                  const MAX_SKILL_INJECT_CHARS = 2000;
                  if (resolved.length > MAX_SKILL_INJECT_CHARS) {
                    resolved = resolved.slice(0, MAX_SKILL_INJECT_CHARS) + "\n[...truncated for token budget]";
                  }
                  this.contextManager.addMessage({
                    role: "system",
                    content: `[Plugin Skill: ${bestMatch.pluginId}/${bestMatch.skill.name}]\n${resolved}`,
                  });
                  this.activeSkillIds.push(bestMatch.skill.id);
                  this.iterationSystemMsgCount++;
                  this.emitEvent({
                    kind: "agent:thinking",
                    content: `Activated plugin skill: ${bestMatch.skill.name} from ${bestMatch.pluginId}`,
                  });
                }
              }
            }
          }
        }
      }

      // 체크포인트 저장: 토큰 예산 80% 이상 사용 시 자동 저장 (1회만)
      if (
        !this.checkpointSaved &&
        this.continuationEngine?.shouldCheckpoint(
          this.tokenUsage.total,
          this.config.loop.totalTokenBudget,
        )
      ) {
        await this.saveAutoCheckpoint(iteration);
        this.checkpointSaved = true;
      }

      // ContinuationEngine: checkpoint current state after each iteration (every 3 iterations, non-fatal)
      if (this.continuationEngine && iteration > 0 && iteration % 3 === 0 && !this.checkpointSaved) {
        try {
          const progress = this.extractProgress();
          await this.continuationEngine.saveCheckpoint({
            sessionId: this.sessionId ?? `session-${Date.now()}`,
            goal: this.contextManager.getMessages().find((m) => m.role === "user")?.content as string ?? "",
            progress,
            changedFiles: [...this.changedFiles].map((p) => ({ path: p, diff: "" })),
            workingMemory: this.buildWorkingMemorySummary(),
            yuanMdUpdates: [],
            errors: [],
            contextUsageAtSave: this.config.loop.totalTokenBudget > 0 ? this.tokenUsage.total / this.config.loop.totalTokenBudget : 0,
            totalTokensUsed: this.tokenUsage.total,
            iterationsCompleted: iteration,
            createdAt: new Date(),
          });
        } catch {
          // Checkpoint failure is non-fatal
        }
      }

      // ContinuousReflection: 매 5 iteration마다 비상 체크포인트 트리거
      // (정기 타이머 외에 iteration 기반 추가 안전망)
      if (
        this.continuousReflection?.isRunning() &&
        iteration > 0 &&
        iteration % 5 === 0
      ) {
        try {
          await this.continuousReflection.emergencyCheckpoint();
        } catch {
          // reflection 체크포인트 실패는 치명적이지 않음
        }
      }
      // complex/massive task + 다중 변경 파일일 때만 aggregate impact hint 1회 주입
      if (
        !this.impactHintInjected &&
        this.impactAnalyzer &&
        this.changedFiles.length >= 2 &&
        (this.currentComplexity === "complex" || this.currentComplexity === "massive")
      ) {
        await this.maybeInjectAggregateImpactHint();
      }
      // 예산 초과 체크
      if (this.tokenUsage.total >= this.config.loop.totalTokenBudget) {
        return {
          reason: "BUDGET_EXHAUSTED",
          tokensUsed: this.tokenUsage.total,
        };
      }
    }

    // abort된 경우
    return { reason: "USER_CANCELLED" };
  }

  /**
   * LLM을 스트리밍 모드로 호출하여 text delta를 실시간 emit.
   * 텍스트 청크는 `agent:text_delta` 이벤트로, tool_call은 누적 후 완료 시 반환.
   */
  private async callLLMStreaming(messages: Message[]): Promise<LLMResponse> {
    let content = "";
    const toolCalls: ToolCall[] = [];
    let usage = { input: 0, output: 0 };
    let finishReason = "stop";

    const allTools = [...this.config.loop.tools, ...this.mcpToolDefinitions];
    const stream = this.llmClient.chatStream(
      messages,
      allTools,
      this.abortSignal ?? undefined,
    );

    // 텍스트 버퍼링 — 1토큰씩 emit하지 않고 청크 단위로 모아서 emit
    let textBuffer = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const FLUSH_INTERVAL_MS = 80;        // 80ms마다 flush
    const FLUSH_SIZE_THRESHOLD = 40;     // 40자 이상이면 즉시 flush
    const SENTENCE_BREAKS = /[.!?\n。！？\n]\s*$/;  // 문장 경계에서도 flush

    const flushTextBuffer = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (textBuffer.length > 0) {
        this.emitEvent({ kind: "agent:text_delta", text: textBuffer });
        textBuffer = "";
      }
    };

    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(flushTextBuffer, FLUSH_INTERVAL_MS);
    };

    for await (const chunk of stream) {
      if (this.aborted) break;
      if (chunk.type === "reasoning" && chunk.reasoning?.text) {
        const aggregated = this.reasoningAggregator.push(
          chunk.reasoning.text,
          {
            id: chunk.reasoning.id,
            provider: chunk.reasoning.provider,
            model: chunk.reasoning.model,
            source: chunk.reasoning.source ?? "llm",
          },
        );

        for (const item of aggregated) {
          this.reasoningTree.add("llm", item.text);
          this.emitEvent({
            kind: "agent:reasoning_delta",
            id: item.id,
            text: item.text,
            provider: item.provider,
            model: item.model,
            source: item.source ?? "llm",
          });
        }
        continue;
      }
      switch (chunk.type) {

        case "text":
          if (chunk.text) {
            content += chunk.text;
            textBuffer += chunk.text;

            // 문장 경계 또는 크기 임계값 도달 시 즉시 flush
            if (textBuffer.length >= FLUSH_SIZE_THRESHOLD || SENTENCE_BREAKS.test(textBuffer)) {
              flushTextBuffer();
            } else {
              scheduleFlush();
            }
          }
          break;

        case "tool_call":
          // tool_call 전에 남은 텍스트 flush
          flushTextBuffer();
          for (const item of this.reasoningAggregator.flush()) {
            this.emitEvent({
              kind: "agent:reasoning_delta",
              id: item.id,
              text: item.text,
              provider: item.provider,
              model: item.model,
              source: item.source ?? "llm",
            });
          }
          if (chunk.toolCall) {
            toolCalls.push(chunk.toolCall);
            this.emitEvent({
              kind: "agent:tool_call",
              tool: chunk.toolCall.name,
              input: chunk.toolCall.arguments,
            });
          }
          break;

        case "done":
          for (const item of this.reasoningAggregator.flush()) {
            this.emitEvent({
              kind: "agent:reasoning_delta",
              id: item.id,
              text: item.text,
              provider: item.provider,
              model: item.model,
              source: item.source ?? "llm",
            });
          }
 if (chunk.usage) {
   usage = {
     input: chunk.usage.input ?? 0,
     output: chunk.usage.output ?? 0,
   };
 }
          break;
      }
    }

    // 스트림 종료 후 남은 버퍼 flush
    flushTextBuffer();
    for (const item of this.reasoningAggregator.flush()) {
      this.emitEvent({
        kind: "agent:reasoning_delta",
        id: item.id,
        text: item.text,
        provider: item.provider,
        model: item.model,
        source: item.source ?? "llm",
      });
    }
   if (flushTimer) clearTimeout(flushTimer);
    return {
      content: content || null,
      toolCalls,
      usage,
      finishReason,
    };
  }

  /**
   * 도구 호출 목록을 실행.
   * 각 도구 호출에 대해:
   * 1. Governor 안전성 검증
   * 2. ApprovalManager 승인 체크 → 필요 시 대기
   * 3. 도구 실행
   * 4. AutoFixLoop 결과 검증 → 실패 시 에러 피드백 메시지 추가
   */
  /**
   * Execute a single tool call (extracted helper for parallel execution support).
   */
  private async executeSingleTool(
    toolCall: ToolCall,
    toolCalls: ToolCall[],
  ): Promise<{ result: ToolResult | null; deferredFixPrompt: string | null }> {
    const args = this.parseToolArgs(toolCall.arguments);
    const allDefinitions = [...this.config.loop.tools, ...this.mcpToolDefinitions];
    const matchedDefinition = allDefinitions.find((t) => t.name === toolCall.name);
    // Governor: 안전성 검증
    try {
      this.governor.validateToolCall(toolCall);
    } catch (err) {
      if (err instanceof ApprovalRequiredError) {
        const approvalResult = await this.handleApproval(toolCall, args, err);
        if (approvalResult) {
          return { result: approvalResult, deferredFixPrompt: null };
        }
        // 승인됨 → 계속 실행
      }
      // Generic tool-definition approval gate
      if (matchedDefinition?.requiresApproval) {
        const definitionApprovalReq: ApprovalRequest = {
          id: `definition-approval-${toolCall.id}`,
          toolName: toolCall.name,
          arguments: args as Record<string, unknown>,
          reason:
            matchedDefinition.source === "mcp"
              ? `MCP tool "${toolCall.name}" requires approval`
              : `Tool "${toolCall.name}" requires approval`,
          riskLevel:
            matchedDefinition.riskLevel === "critical" ||
            matchedDefinition.riskLevel === "high"
              ? "high"
              : "medium",
          timeout: 120_000,
        };

        const definitionApprovalResult = await this.handleApprovalRequest(
          toolCall,
          definitionApprovalReq,
        );
        if (definitionApprovalResult) {
          return { result: definitionApprovalResult, deferredFixPrompt: null };
        }
      } else if (err instanceof ApprovalRequiredError) {
        // already handled above
      } else {
        throw err;
      }
    }

    // ApprovalManager: 추가 승인 체크
    const approvalRequest = this.approvalManager.checkApproval(toolCall.name, args);
    if (approvalRequest) {
      const approvalResult = await this.handleApprovalRequest(toolCall, approvalRequest);
      if (approvalResult) {
        return { result: approvalResult, deferredFixPrompt: null };
      }
    }

    // Plugin Tool Approval Gate
    const pluginTools = this.pluginRegistry.getAllTools();
    const matchedPluginTool = pluginTools.find((pt) => pt.tool.name === toolCall.name);
    if (
      matchedPluginTool &&
      (matchedPluginTool.tool.requiresApproval === true ||
        matchedPluginTool.tool.sideEffectLevel === "destructive")
    ) {
      const pluginApprovalReq: ApprovalRequest = {
        id: `plugin-approval-${toolCall.id}`,
        toolName: toolCall.name,
        arguments: args as Record<string, unknown>,
        reason: `Plugin tool "${toolCall.name}" (from ${matchedPluginTool.pluginId}) requires approval (${
          matchedPluginTool.tool.sideEffectLevel === "destructive"
            ? "destructive side effect"
            : "requiresApproval=true"
        })`,
        riskLevel: matchedPluginTool.tool.riskLevel === "high" ? "high" : "medium",
        timeout: 120_000,
      };
      const pluginApprovalResult = await this.handleApprovalRequest(toolCall, pluginApprovalReq);
      if (pluginApprovalResult) {
        return { result: pluginApprovalResult, deferredFixPrompt: null };
      }
    }

    // MCP 도구 호출 확인
    if (this.mcpClient && this.isMCPTool(toolCall.name)) {
      const mcpResult = await this.executeMCPTool(toolCall);
      this.emitEvent({
        kind: "agent:tool_result",
        tool: toolCall.name,
        output:
          mcpResult.output.length > 200
            ? mcpResult.output.slice(0, 200) + "..."
            : mcpResult.output,
        durationMs: mcpResult.durationMs,
      });
      this.emitEvent({ kind: "agent:reasoning_delta", text: `tool finished: ${toolCall.name}` });
      return { result: mcpResult, deferredFixPrompt: null };
    }

    // 도구 실행
    const startTime = Date.now();
    const toolAbort = new AbortController();
    this.interruptManager.registerToolAbort(toolAbort);
    if (["file_write", "file_edit"].includes(toolCall.name)) {
      const candidatePath =
        (args as Record<string, unknown>).path ??
        (args as Record<string, unknown>).file;
      if (candidatePath) {
        const filePathStr = String(candidatePath);
        if (!this.originalSnapshots.has(filePathStr)) {
          try {
            const { readFile } = await import("node:fs/promises");
            const original = await readFile(filePathStr, "utf-8");
            this.originalSnapshots.set(filePathStr, original);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }
        }
      }
    }
    try {
      const result = await this.toolExecutor.execute(toolCall, toolAbort?.signal);
      this.interruptManager.clearToolAbort();

      if (this.skillLearner) {
        try {
          const relevantSkills = this.skillLearner.getRelevantSkills({
            errorMessage: `${toolCall.name}\n${result.output}`,
            filePath:
              typeof args.path === "string"
                ? args.path
                : typeof args.file === "string"
                ? args.file
                : undefined,
          });
          for (const skill of relevantSkills.slice(0, 1)) {
            this.skillLearner.updateConfidence(skill.id, result.success);
          }
        } catch {}
      }

      this.emitEvent({
        kind: "agent:tool_result",
        tool: toolCall.name,
        output:
          result.output.length > 200
            ? result.output.slice(0, 200) + "..."
            : result.output,
        durationMs: result.durationMs,
      });
      this.emitReasoning(`success: ${toolCall.name}`);
      this.reasoningTree.add("tool", `success: ${toolCall.name}`);

      if (["file_write", "file_edit"].includes(toolCall.name) && result.success) {
        const filePath =
          (args as Record<string, unknown>).path ??
          (args as Record<string, unknown>).file ??
          "unknown";
        const filePathStr = String(filePath);
        if (!this.changedFiles.includes(filePathStr)) {
          this.changedFiles.push(filePathStr);
        }
        // Task 2: track write tool paths per-iteration for QA triggering
        if (!this.iterationWriteToolPaths.includes(filePathStr)) {
          this.iterationWriteToolPaths.push(filePathStr);
        }
        // Task 3: track TS/TSX files modified this iteration for auto-tsc
        if (filePathStr.match(/\.[cm]?tsx?$/) && !this.iterationTsFilesModified.includes(filePathStr)) {
          this.iterationTsFilesModified.push(filePathStr);
        }
        this.emitEvent({ kind: "agent:file_change", path: filePathStr, diff: result.output });
        // Update world state after file modification
        if (this.config.loop.projectPath) {
          const wsProjectPath = this.config.loop.projectPath;
          new WorldStateCollector({ projectPath: wsProjectPath, skipTest: true })
            .collect()
            .then((snapshot) => { this.worldState = snapshot; })
            .catch(() => {
              // Non-fatal: world state update failure should not interrupt tool execution
            });
        }
        if (this.impactAnalyzer) {
          this.analyzeFileImpact(filePathStr).catch((err: unknown) => {
            // Non-fatal: impact analysis failure should not interrupt tool execution
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[AgentLoop] impact analysis skipped for ${filePathStr}: ${msg}`);
          });
        }
      }

      // StateUpdater: sync world model with actual tool execution result
      if (this.stateUpdater && result.success) {
        this.stateUpdater.applyToolResult(
          toolCall.name,
          args as Record<string, unknown>,
          result,
        ).catch(() => {/* non-blocking */});
      }

      const fixPrompt = await this.validateAndFeedback(toolCall.name, result);
      return { result, deferredFixPrompt: fixPrompt ?? null };
    } catch (err) {
      this.interruptManager.clearToolAbort();
      const durationMs = Date.now() - startTime;

      if (toolAbort.signal.aborted) {
        const abortResult: ToolResult = {
          tool_call_id: toolCall.id,
          name: toolCall.name,
          output: `[INTERRUPTED] Tool execution was cancelled by user interrupt.`,
          success: false,
          durationMs,
        };
        this.emitEvent({
          kind: "agent:error",
          message: `Tool ${toolCall.name} cancelled by interrupt`,
          retryable: false,
        });
        return { result: abortResult, deferredFixPrompt: null };
      }

      const errorMessage = err instanceof Error ? err.message : String(err);
      if (this.skillLearner) {
        try {
          const relevantSkills = this.skillLearner.getRelevantSkills({
            errorMessage: `${toolCall.name}\n${errorMessage}`,
            filePath:
              typeof args.path === "string"
                ? args.path
                : typeof args.file === "string"
                ? args.file
                : undefined,
          });
          for (const skill of relevantSkills.slice(0, 1)) {
            this.skillLearner.updateConfidence(skill.id, false);
          }
        } catch {}
      }
      const errorResult: ToolResult = {
        tool_call_id: toolCall.id,
        name: toolCall.name,
        output: `Error: ${errorMessage}`,
        success: false,
        durationMs,
      };
      this.emitEvent({
        kind: "agent:error",
        message: `Tool ${toolCall.name} failed: ${errorMessage}`,
        retryable: true,
      });
      this.emitEvent({ kind: "agent:reasoning_delta", text: `failed: ${toolCall.name}` });
      this.reasoningTree.add("tool", `failed: ${toolCall.name}`);
      return { result: errorResult, deferredFixPrompt: null };
    }
  }

  private async executeTools(
    toolCalls: ToolCall[],
  ): Promise<{ results: ToolResult[]; deferredFixPrompts: string[] }> {
    if (toolCalls.length === 0) return { results: [], deferredFixPrompts: [] };

    // ─── Step 1: Build execution plan ───────────────────────────────────────
    // Strategy:
    //   • Read-only tools (low-risk)      → batch together, run all in parallel
    //   • Write tools (independent files) → use DependencyAnalyzer to group,
    //                                       run each independent group in parallel
    //   • Write tools (dependent files)   → run sequentially after their deps
    //   • shell_exec / git_ops / etc.     → always sequential (side-effects)

    const READ_ONLY = new Set(['file_read', 'grep', 'glob', 'code_search', 'security_scan']);
    const WRITE_TOOLS = new Set(['file_write', 'file_edit']);

    // Separate reads, writes, and heavy side-effect tools
    const writeToolCalls = toolCalls.filter((tc) => WRITE_TOOLS.has(tc.name));

    // ─── Step 2: Dependency-aware write tool batching ────────────────────────
    // Map each write tool call to a "wave index" (0 = can run first, 1 = needs wave-0 done, etc.)
    const writeBatchMap = new Map<string, number>(); // tc.id → wave index

    if (writeToolCalls.length > 1 && this.config.loop.projectPath) {
      try {
        const depAnalyzer = new DependencyAnalyzer();
        const depGraph = await depAnalyzer.analyze(this.config.loop.projectPath);

        // Collect target file paths from write tool args
        const writeFilePaths = writeToolCalls.flatMap((tc) => {
          const args = this.parseToolArgs(tc.arguments);
          const p = typeof args.path === "string" ? args.path
            : typeof args.file_path === "string" ? args.file_path
            : null;
          return p ? [p] : [];
        });

        if (writeFilePaths.length > 1) {
          const groups = depAnalyzer.groupIndependentFiles(depGraph, writeFilePaths);

          // Assign wave indices: independent groups get wave 0,
          // dependent groups get wave = max(their dep waves) + 1
          // For simplicity: canParallelize=true → wave 0, else sequential waves
          let wave = 0;
          for (const group of groups) {
            if (!group.canParallelize) wave++;
            for (const filePath of group.files) {
              const tc = writeToolCalls.find((c) => {
                const args = this.parseToolArgs(c.arguments);
                const p = args.path ?? args.file_path;
                return p === filePath;
              });
              if (tc) writeBatchMap.set(tc.id, wave);
            }
            if (group.canParallelize) wave = 0; // reset: next independent group is also wave 0
          }
        }
      } catch {
        // DependencyAnalyzer failure is non-fatal — all writes run sequentially
      }
    }

    // ─── Step 3: Build ordered batch list ────────────────────────────────────
    // Final structure: array of batches, each batch runs in parallel.
    // Reads accumulate until interrupted by a non-read tool.
    // Writes are grouped by wave (same wave → parallel, different wave → sequential).
    const batches: Array<{ calls: ToolCall[]; label: string }> = [];
    let readBatch: ToolCall[] = [];
    const writeBatchGroups = new Map<number, ToolCall[]>(); // wave → calls

    const flushReadBatch = () => {
      if (readBatch.length > 0) {
        batches.push({ calls: [...readBatch], label: `${readBatch.length} read-only` });
        readBatch = [];
      }
    };

    const flushWriteBatches = () => {
      if (writeBatchGroups.size === 0) return;
      const waves = [...writeBatchGroups.keys()].sort((a, b) => a - b);
      for (const w of waves) {
        const wCalls = writeBatchGroups.get(w)!;
        batches.push({
          calls: wCalls,
          label: wCalls.length > 1
            ? `${wCalls.length} independent writes (wave ${w})`
            : `write: ${wCalls[0]!.name}`,
        });
      }
      writeBatchGroups.clear();
    };

    for (const tc of toolCalls) {
      if (READ_ONLY.has(tc.name)) {
        // Reads accumulate; don't flush write batches yet (they don't conflict)
        readBatch.push(tc);
      } else if (WRITE_TOOLS.has(tc.name)) {
        // Flush any pending reads first (reads before writes)
        flushReadBatch();
        const wave = writeBatchMap.get(tc.id) ?? 99; // unknown dep → run last
        if (!writeBatchGroups.has(wave)) writeBatchGroups.set(wave, []);
        writeBatchGroups.get(wave)!.push(tc);
      } else {
        // Heavy tool (shell_exec, git_ops, etc.) → flush everything, run solo
        flushReadBatch();
        flushWriteBatches();
        batches.push({ calls: [tc], label: tc.name });
      }
    }
    flushReadBatch();
    flushWriteBatches();

    // ─── Step 4: Execute batches ─────────────────────────────────────────────
    if (toolCalls.length > 1) {
      const parallelCount = batches.filter(b => b.calls.length > 1).length;
      this.emitReasoning(
        parallelCount > 0
          ? `executing ${toolCalls.length} tools in ${batches.length} batches (${parallelCount} parallel)`
          : `executing ${toolCalls.length} tools sequentially`,
      );
    }

    const results: ToolResult[] = [];
    const deferredFixPrompts: string[] = [];
    let interrupted = false;

    for (const batch of batches) {
      if (interrupted) {
        // Fill remaining tools with SKIPPED placeholders
        for (const tc of batch.calls) {
          results.push({
            tool_call_id: tc.id,
            name: tc.name,
            output: '[SKIPPED] Execution interrupted.',
            success: false,
            durationMs: 0,
          });
        }
        continue;
      }

      if (batch.calls.length === 1) {
        // Single tool — sequential execution
        const { result, deferredFixPrompt } = await this.executeSingleTool(batch.calls[0]!, toolCalls);
        if (result) results.push(result);
        if (deferredFixPrompt) deferredFixPrompts.push(deferredFixPrompt);
        if (result?.output.startsWith('[INTERRUPTED]')) interrupted = true;
      } else {
        // Multi-tool — parallel execution
        this.emitReasoning(`⚡ running ${batch.label} in parallel`);
        const settled = await Promise.allSettled(
          batch.calls.map((tc) => this.executeSingleTool(tc, toolCalls)),
        );
        for (let i = 0; i < settled.length; i++) {
          const s = settled[i]!;
          const tc = batch.calls[i]!;
          if (s.status === 'fulfilled') {
            if (s.value.result) results.push(s.value.result);
            if (s.value.deferredFixPrompt) deferredFixPrompts.push(s.value.deferredFixPrompt);
            if (s.value.result?.output.startsWith('[INTERRUPTED]')) interrupted = true;
          } else {
            results.push({
              tool_call_id: tc.id,
              name: tc.name,
              output: `Error: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
              success: false,
              durationMs: 0,
            });
          }
        }
      }
    }

    return { results, deferredFixPrompts };
  }

  /**
   * Governor의 ApprovalRequiredError를 ApprovalManager로 처리.
   * 승인되면 null 반환 (실행 계속), 거부되면 ToolResult 반환 (실행 차단).
   */
  private async handleApproval(
    toolCall: ToolCall,
    args: Record<string, unknown>,
    err: ApprovalRequiredError,
  ): Promise<ToolResult | null> {
    const request: ApprovalRequest = {
      id: randomUUID(),
      toolName: toolCall.name,
      arguments: args,
      riskLevel: "high",
      reason: err.description,
      timeout: 120_000,
    };

    return this.handleApprovalRequest(toolCall, request);
  }

  /**
   * ApprovalRequest를 처리하고 승인/거부 결과를 반환.
   * 승인되면 null (실행 계속), 거부되면 ToolResult (차단).
   */
  private async handleApprovalRequest(
    toolCall: ToolCall,
    request: ApprovalRequest,
  ): Promise<ToolResult | null> {
    const pendingAction = this.approvalManager.buildPendingAction(
      toolCall,
      request,
    );

    this.emitEvent({
      kind: "agent:approval_needed",
      action: pendingAction,
    });

    const response = await this.approvalManager.requestApproval(request);

    if (response === "reject") {
      return {
        tool_call_id: toolCall.id,
        name: toolCall.name,
        output: `[REJECTED] User denied approval: ${request.reason}`,
        success: false,
        durationMs: 0,
      };
    }

    // approve 또는 always_approve → 실행 허가
    return null;
  }

  /**
   * 도구 실행 결과를 AutoFixLoop으로 검증하고,
   * 실패 시 수정 프롬프트를 대화 히스토리에 추가.
   */
  private async validateAndFeedback(
    toolName: string,
    result: ToolResult,
  ): Promise<string | null> {
    // file_write/file_edit/shell_exec만 검증
    if (!["file_write", "file_edit", "shell_exec"].includes(toolName)) {
      return null;
    }

    const validation = await this.autoFixLoop.validateResult(
      toolName,
      result.output,
      result.success,
      this.config.loop.projectPath,
    );

    if (validation.passed) {
      // 검증 통과 → 수정 시도 기록 초기화
      this.autoFixLoop.resetAttempts();
      return null;
    }

    // 검증 실패 → 에러 피드백
    if (!this.autoFixLoop.canRetry()) {
      // 재시도 한도 초과 → 에러 이벤트만 emit
      this.emitEvent({
        kind: "agent:error",
        message: `Auto-fix exhausted (${this.autoFixLoop.getAttempts().length} attempts): ${validation.failures[0]?.message ?? "Unknown error"}`,
        retryable: false,
      });
      return null;
    }

    // 수정 프롬프트 생성 — 히스토리 추가는 caller가 tool result 추가 후 수행
    const errorMsg = validation.failures
      .map((f) => `[${f.type}] ${f.message}\n${f.rawOutput}`)
      .join("\n\n");

    const fixPrompt = this.autoFixLoop.buildFixPrompt(
      errorMsg,
      `After ${toolName} execution on project at ${this.config.loop.projectPath}`,
    );

    // 수정 시도 기록
    this.autoFixLoop.recordAttempt(
      errorMsg,
      "Requesting LLM fix",
      false,
      0,
    );

    // fixPrompt를 반환 — caller가 tool result 메시지 추가 후 context에 넣음
    return fixPrompt;
  }

  /**
   * 도구 인자를 파싱하는 헬퍼.
   */
  private parseToolArgs(
    args: string | Record<string, unknown>,
  ): Record<string, unknown> {
    if (typeof args === "string") {
      try {
  const parsed = JSON.parse(args);
  if (parsed && typeof parsed === "object") {
    return parsed as Record<string, unknown>;
  }
  return { raw: args };
      } catch {
        return { raw: args };
      }
    }
    return args;
  }

  // ─── Continuation Helpers ───

  /**
   * 토큰 예산 소진 임박 시 자동 체크포인트를 저장한다.
   * 현재 진행 상태, 변경 파일, 에러 등을 직렬화.
   */
  private async saveAutoCheckpoint(iteration: number): Promise<void> {
    if (!this.continuationEngine) return;

    try {
      // 현재 plan 정보에서 진행 상황 추출
      const progress = this.extractProgress();

      const checkpoint: ContinuationCheckpoint = {
        sessionId: this.sessionId ?? "unknown-session",
        goal: this.contextManager.getMessages().find((m) => m.role === "user")?.content as string ?? "",
        progress,
        changedFiles: this.changedFiles.map((path) => ({ path, diff: "" })),
        workingMemory: this.buildWorkingMemorySummary(),
        yuanMdUpdates: [],
        errors: this.allToolResults
          .filter((r) => !r.success)
          .slice(-5)
          .map((r) => `${r.name}: ${r.output.slice(0, 200)}`),
        contextUsageAtSave: 
 this.config.loop.totalTokenBudget > 0
   ? this.tokenUsage.total / this.config.loop.totalTokenBudget
   : 0,
        totalTokensUsed: this.tokenUsage.total,
        iterationsCompleted: iteration,
        createdAt: new Date(),
      };

      const savedPath = await this.continuationEngine.saveCheckpoint(checkpoint);
      if (savedPath) {
        this.emitEvent({
          kind: "agent:thinking",
          content: `Auto-checkpoint saved at ${Math.round(checkpoint.contextUsageAtSave * 100)}% token usage (iteration ${iteration}).`,
        });
      }
    } catch {
      // 체크포인트 저장 실패는 치명적이지 않음
    }
  }

  /**
   * 매 iteration 시작 시 현재 플랜 진행 상황을 컨텍스트에 주입.
   * 같은 태스크 인덱스라면 3 iteration마다만 주입 (컨텍스트 bloat 방지).
   */
  private injectPlanProgress(iteration: number): void {
    if (!this.activePlan) return;
    const tasks = this.activePlan.tactical;
    if (tasks.length === 0) return;

    const idx = this.currentTaskIndex;
    const total = tasks.length;

    // 같은 태스크면 3iteration마다, 태스크 전진 시 즉시 주입
    const taskAdvanced = idx !== this._lastInjectedTaskIndex;
    if (!taskAdvanced && iteration > 1 && iteration % 3 !== 1) return;
    this._lastInjectedTaskIndex = idx;

    const lines: string[] = [
      `## Plan Progress [${idx}/${total} done]`,
    ];
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i]!;
      const marker = i < idx ? "✓" : i === idx ? "→" : "○";
      lines.push(`${marker} Task ${i + 1}: ${task.description}`);
      if (i === idx && task.targetFiles.length > 0) {
        lines.push(`   Files: ${task.targetFiles.join(", ")}`);
      }
    }

    if (idx < total) {
      const cur = tasks[idx]!;
      lines.push(`\nCurrent task: **${cur.description}**`);
      if (cur.toolStrategy.length > 0) {
        lines.push(`Suggested tools: ${cur.toolStrategy.join(", ")}`);
      }
      if (cur.readFiles.length > 0) {
        lines.push(`Read first: ${cur.readFiles.join(", ")}`);
      }
    } else {
      lines.push(`\nAll tasks complete — verify and wrap up.`);
    }

    this.contextManager.addMessage({
      role: "system",
      content: lines.join("\n"),
    });
    this.iterationSystemMsgCount++;
  }

  /**
   * 현재 태스크의 targetFiles가 changedFiles에 포함됐는지 확인해
   * 완료 감지 시 다음 태스크로 자동 전진.
   */
  private tryAdvancePlanTask(): void {
    if (!this.activePlan) return;
    const tasks = this.activePlan.tactical;
    if (this.currentTaskIndex >= tasks.length) return;

    const currentTask = tasks[this.currentTaskIndex];
    if (!currentTask) return;

    // targetFiles가 없으면 tool call이 있었던 것만으로 완료 간주
    if (currentTask.targetFiles.length === 0) {
      if (this.allToolResults.length > 0) {
        this.completedPlanTaskIds.add(currentTask.id);
        this.currentTaskIndex++;
        this._emitPlanAdvance(tasks);
      }
      return;
    }

    // targetFiles 중 하나라도 changedFiles에 있으면 완료
    const changedBasenames = new Set(
      this.changedFiles.map((f) => f.split("/").pop()!.toLowerCase()),
    );
    const targetBasenames = currentTask.targetFiles.map((f) =>
      f.split("/").pop()!.toLowerCase(),
    );
    const hit = targetBasenames.some((b) => changedBasenames.has(b));

    if (hit) {
      this.completedPlanTaskIds.add(currentTask.id);
      this.currentTaskIndex++;
      this._emitPlanAdvance(tasks);
    }
  }

  private _emitPlanAdvance(tasks: import("./hierarchical-planner.js").TacticalTask[]): void {
    const idx = this.currentTaskIndex;
    if (idx < tasks.length) {
      this.emitEvent({
        kind: "agent:thinking",
        content: `✓ Task ${idx}/${tasks.length} done. Next: ${tasks[idx]!.description}`,
      });
    } else {
      this.emitEvent({
        kind: "agent:thinking",
        content: `✓ All ${tasks.length} tasks completed.`,
      });
    }
  }

  /**
   * 현재 plan에서 진행 상황을 추출한다.
   */
  private extractProgress(): ContinuationCheckpoint["progress"] {
    if (!this.activePlan) {
      return { completedTasks: [], currentTask: "", remainingTasks: [] };
    }

    const tasks = this.activePlan.tactical;
    const completedTasks = tasks
      .slice(0, this.currentTaskIndex)
      .map((t) => t.description);
    const currentTask = tasks[this.currentTaskIndex]?.description ?? "";
    const remainingTasks = tasks
      .slice(this.currentTaskIndex + 1)
      .map((t) => t.description);

    return { completedTasks, currentTask, remainingTasks };
  }

  /**
   * 현재 작업 메모리 요약을 생성한다.
   * 최근 도구 결과와 LLM 응답의 핵심만 추출.
   */
  private buildWorkingMemorySummary(): string {
    const parts: string[] = [];

    // 최근 도구 결과 요약 (최대 5개)
    const recentTools = this.allToolResults.slice(-5);
    if (recentTools.length > 0) {
      parts.push("Recent tool results:");
      for (const r of recentTools) {
        const status = r.success ? "OK" : "FAIL";
        parts.push(`- ${r.name} [${status}]: ${r.output.slice(0, 100)}`);
      }
    }

    // 변경된 파일 목록
    if (this.changedFiles.length > 0) {
      parts.push(`\nChanged files: ${this.changedFiles.join(", ")}`);
    }

    // 토큰 사용량
    parts.push(`\nTokens used: ${this.tokenUsage.total} / ${this.config.loop.totalTokenBudget}`);

    return parts.join("\n");
  }

  /**
   * ContinuationEngine 인스턴스를 반환한다.
   * 외부에서 체크포인트 조회/관리에 사용.
   */
  getContinuationEngine(): ContinuationEngine | null {
    return this.continuationEngine;
  }

  /**
   * FailureRecovery 인스턴스를 반환한다.
   */
  getFailureRecovery(): FailureRecovery {
    return this.failureRecovery;
  }

  /**
   * ExecutionPolicyEngine 인스턴스를 반환한다.
   */
  getPolicyEngine(): ExecutionPolicyEngine | null {
    return this.policyEngine;
  }

  /**
   * 마지막 수집된 WorldState를 반환한다.
   */
  getWorldState(): WorldStateSnapshot | null {
    return this.worldState;
  }

  // ─── Interrupt Helpers ───

  /**
   * InterruptManager 이벤트를 AgentLoop에 연결한다.
   * - soft interrupt: 피드백을 user 메시지로 주입
   * - hard interrupt: 루프 즉시 중단
   */
  private setupInterruptListeners(): void {
    // soft interrupt: 피드백을 대화 히스토리에 주입
    this.interruptManager.on("interrupt:feedback", (feedback: string) => {
      this.contextManager.addMessage({
        role: "user",
        content: feedback,
      });
    });

    // hard interrupt: 루프 중단
    this.interruptManager.on("interrupt:hard", () => {
      this.aborted = true;
    });
  }

  /**
   * pause 상태일 때 resume 시그널을 대기한다.
   * resume 또는 hard interrupt가 올 때까지 블로킹.
   */
  private waitForResume(): Promise<void> {
    return new Promise<void>((resolve) => {
      // 이미 resume 상태이면 즉시 반환
      if (!this.interruptManager.isPaused()) {
        resolve();
        return;
      }

      const onResume = () => {
        this.interruptManager.removeListener("interrupt:resume", onResume);
        this.interruptManager.removeListener("interrupt:hard", onHard);
        resolve();
      };

      const onHard = () => {
        this.interruptManager.removeListener("interrupt:resume", onResume);
        this.interruptManager.removeListener("interrupt:hard", onHard);
        resolve();
      };

      this.interruptManager.on("interrupt:resume", onResume);
      this.interruptManager.on("interrupt:hard", onHard);
    });
  }

  // ─── Impact Analysis ───

  /**
   * 파일 변경 후 영향 분석을 실행하고 결과를 컨텍스트에 주입.
   * 고위험 변경이면 경고를 emit.
   */
  private async analyzeFileImpact(filePath: string): Promise<void> {
    if (!this.impactAnalyzer) return;

    try {
      const report = await this.impactAnalyzer.analyzeChanges([filePath]);
      if (report.riskLevel === "high" || report.riskLevel === "critical") {
        this.emitEvent({
          kind: "agent:thinking",
          content: `Impact analysis: ${report.riskLevel} risk. ${report.affectedFiles.length} affected files, ${report.breakingChanges.length} breaking changes.`,
        });

        // 고위험 변경 정보를 LLM에 주입
        const impactPrompt = this.impactAnalyzer.formatForPrompt(report);
        this.contextManager.addMessage({
          role: "system",
          content: impactPrompt,
        });
      }
    } catch {
      // Impact analysis 실패는 치명적이지 않음
    }
  }
  /**
   * 다중 파일 변경이 누적된 경우 aggregate impact를 1회만 컨텍스트에 주입한다.
   * 무거운 분석이므로 complex/massive 태스크에서만 사용.
   */
  private async maybeInjectAggregateImpactHint(): Promise<void> {
    if (!this.impactAnalyzer || this.changedFiles.length < 2) return;

    try {
      const report = await this.impactAnalyzer.analyzeChanges(this.changedFiles);

      const shouldInject =
        report.breakingChanges.length > 0 ||
        report.deadCodeCandidates.length > 0 ||
        report.testCoverage.some((t) => t.inferredCoverage === "low") ||
        report.riskLevel === "high" ||
        report.riskLevel === "critical";

      if (!shouldInject) return;

      const planPreview = report.refactorPlan
        .slice(0, 3)
        .map((step) => `${step.step}. ${step.action}`)
        .join("\n");

      const hintLines: string[] = [
        "[Aggregate Impact Hint]",
        `Risk: ${report.riskLevel}`,
        `Breaking changes: ${report.breakingChanges.length}`,
        `Dead code candidates: ${report.deadCodeCandidates.length}`,
        `Low coverage files: ${report.testCoverage.filter((t) => t.inferredCoverage === "low").length}`,
      ];

      if (planPreview) {
        hintLines.push("", "Suggested refactor order:", planPreview);
      }

      this.contextManager.addMessage({
        role: "system",
        content: hintLines.join("\n"),
      });

      this.impactHintInjected = true;

      this.emitEvent({
        kind: "agent:thinking",
        content:
          `Aggregate impact hint injected: ${report.riskLevel} risk, ` +
          `${report.breakingChanges.length} breaking changes, ` +
          `${report.deadCodeCandidates.length} dead code candidates.`,
      });
    } catch {
      // aggregate impact 실패는 치명적이지 않음
    }
  }

  /**
   * 종료 직전 최종 impact 요약 생성.
   * assistant final summary에만 붙이고 system prompt 오염은 하지 않는다.
   */
  private async buildFinalImpactSummary(): Promise<string | null> {
    if (!this.impactAnalyzer || this.changedFiles.length === 0) return null;

    try {
      const report = await this.impactAnalyzer.analyzeChanges(this.changedFiles);

      const lines: string[] = [];
      lines.push("Impact summary:");
      lines.push(
        `- Risk: ${report.riskLevel}, affected files: ${report.affectedFiles.length}, breaking changes: ${report.breakingChanges.length}`,
      );

      const lowCoverage = report.testCoverage.filter(
        (t) => t.inferredCoverage === "low",
      );
      if (lowCoverage.length > 0) {
        lines.push(`- Low inferred test coverage: ${lowCoverage.map((t) => t.file).join(", ")}`);
      }

      if (report.deadCodeCandidates.length > 0) {
        lines.push(
          `- Dead code candidates: ${report.deadCodeCandidates
            .slice(0, 5)
            .map((d) => `${d.file}:${d.symbol}`)
            .join(", ")}`,
        );
      }

      if (report.refactorPlan.length > 0) {
        lines.push(
          `- Suggested next step: ${report.refactorPlan[0]?.action ?? "review refactor plan"}`,
        );
      }

      return lines.join("\n");
    } catch {
      return null;
    }
  }
  /**
   * CostOptimizer 인스턴스를 반환한다.
   */
  getCostOptimizer(): CostOptimizer {
    return this.costOptimizer;
  }

  /**
   * ImpactAnalyzer 인스턴스를 반환한다.
   */
  getImpactAnalyzer(): ImpactAnalyzer | null {
    return this.impactAnalyzer;
  }

  // ─── MCP Helpers ───

  /** MCP 도구인지 확인 */
  private isMCPTool(toolName: string): boolean {
    return this.mcpToolDefinitions.some((t) => t.name === toolName);
  }

  /** MCP 도구 실행 (callToolAsYuan 활용) */
  private async executeMCPTool(toolCall: ToolCall): Promise<ToolResult> {
    const args = this.parseToolArgs(toolCall.arguments);
    return this.mcpClient!.callToolAsYuan(toolCall.name, args, toolCall.id);
  }
  /**
   * ContinuousReflection overflow signal을 soft rollover로 처리한다.
   * 절대 abort하지 않고, 체크포인트 저장 후 다음 iteration에서
   * ContextManager가 압축된 컨텍스트를 사용하도록 둔다.
   */
  private async handleSoftContextOverflow(): Promise<void> {
    try {
      await this.saveAutoCheckpoint(this.iterationCount);
      this.checkpointSaved = true;
    } catch {
      // checkpoint 실패는 치명적이지 않음
    }

    this.emitEvent({
      kind: "agent:thinking",
      content:
        "Context usage exceeded safe threshold. " +
        "Saved checkpoint, compacting history, and continuing without abort.",
    });
  }
  /** MCP 클라이언트 정리 (세션 종료 시 호출) */
  async dispose(): Promise<void> {
    if (this.mcpClient) {
      try {
        await this.mcpClient.disconnectAll();
      } catch {
        // cleanup failure ignored
      }
    }
  }

  // ─── Helpers ───

  /**
   * Builds a Map<filePath, toolOutput> for all changed files from write/edit tool results.
   * Used by selfReflection deepVerify and quickVerify.
   */
  private buildChangedFilesMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const filePath of this.changedFiles) {
      const lastWrite = this.allToolResults
        .filter((r) => r.name === "file_write" || r.name === "file_edit")
        .find((r) => r.output.includes(filePath));
      if (lastWrite) {
        map.set(filePath, lastWrite.output);
      }
    }
    return map;
  }

  private emitEvent(event: AgentEvent): void {
    this.emit("event", event);
  }
  private emitReasoning(content: string): void {
    this.reasoningTree.add("reasoning", content);
    this.emitEvent({
      kind: "agent:reasoning_delta",
      text: content,
      source: "agent",
    });
  }

  private emitSubagent(name: string, phase: "start" | "done", content: string): void {
    this.reasoningTree.add(name, `[${phase}] ${content}`);
    this.emitReasoning(`[${name}:${phase}] ${content}`);
  }
  private handleFatalError(err: unknown): AgentTermination {
    const message = err instanceof Error ? err.message : String(err);
  if (this.sessionPersistence && this.sessionId) {
    void this.sessionPersistence.updateStatus(this.sessionId, "crashed");
  }
    this.emitEvent({
      kind: "agent:error",
      message,
      retryable: false,
    });

    return { reason: "ERROR", error: message };
  }
}
