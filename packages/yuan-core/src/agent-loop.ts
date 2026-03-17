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
} from "./auto-fix.js";
import { InterruptManager } from "./interrupt-manager.js";
import type { InterruptSignal } from "./types.js";
import { YuanMemory, type ProjectStructure } from "./memory.js";
import { MemoryManager } from "./memory-manager.js";
import { buildSystemPrompt, type EnvironmentInfo } from "./system-prompt.js";
import { compilePromptEnvelope, type PromptRuntimeInput } from "./prompt-runtime.js";
import { buildPrompt } from "./prompt-builder.js";
import {
  HierarchicalPlanner,
  type HierarchicalPlan,
  type TacticalTask,
  type RePlanTrigger,
} from "./hierarchical-planner.js";
import { TaskClassifier } from "./task-classifier.js";
import { PromptDefense } from "./prompt-defense.js";
import { ReflexionEngine, type ReflexionEntry } from "./reflexion.js";
import { TokenBudgetManager, type BudgetRole } from "./token-budget.js";
import { ContinuationEngine } from "./continuation-engine.js";
import { MemoryUpdater } from "./memory-updater.js";
import type { ContinuationCheckpoint, ToolDefinition } from "./types.js";
import { MCPClient, type MCPServerConfig } from "./mcp-client.js";
import { loadMCPConfig } from "./mcp-config-loader.js";
import { BOUNDS, cap, truncate, pushCapped } from "./safe-bounds.js";
import { WorldStateCollector, type WorldStateSnapshot } from "./world-state.js";
import { FailureRecovery } from "./failure-recovery.js";
import { ExecutionPolicyEngine, type ExecutionPolicy } from "./execution-policy-engine.js";
import { CostOptimizer } from "./cost-optimizer.js";
import { ImpactAnalyzer, type ImpactReport } from "./impact-analyzer.js";
import { SelfReflection } from "./self-reflection.js";
import { DebateOrchestrator } from "./debate-orchestrator.js";
import {
  ContinuousReflection,
  type AgentStateSnapshot,
} from "./continuous-reflection.js";
import { PluginRegistry } from "./plugin-registry.js";
import { SkillLoader } from "./skill-loader.js";
import { SpecialistRegistry } from "./specialist-registry.js";
import { ToolPlanner, type ToolPlan, type PlanContext } from "./tool-planner.js";
import { SelfDebugLoop } from "./self-debug-loop.js";
import { SkillLearner } from "./skill-learner.js";
import { RepoKnowledgeGraph } from "./repo-knowledge-graph.js";
import { BackgroundAgentManager, type BackgroundEvent } from "./background-agent.js";
import { SubAgent, type SubAgentResult, type DAGContextLike } from "./sub-agent.js";
import type { SubAgentRole } from "./sub-agent-prompts.js";
import { ReasoningAggregator } from "./reasoning-aggregator.js";
import { ReasoningTree } from "./reasoning-tree.js";
import { CrossFileRefactor } from "./cross-file-refactor.js";
import { ContextBudgetManager } from "./context-budget.js";
import { QAPipeline, type QAPipelineResult } from "./qa-pipeline.js";
import { PersonaManager } from "./persona.js";
import { InMemoryVectorStore, OllamaEmbeddingProvider } from "./vector-store.js";
import { agentDecide, DEFAULT_DECISION, worldStateToProjectContext } from "./agent-decision.js";
import type { AgentDecisionContext, AgentProjectContext } from "./agent-decision-types.js";
import { OverheadGovernor, type OverheadGovernorConfig, type TriggerContext, type TaskPhase } from "./overhead-governor.js";
import {
  StateStore,
  TransitionModel,
  SimulationEngine,
  StateUpdater,
} from "./world-model/index.js";
import type { WorldState } from "./world-model/index.js";
import {
  MilestoneChecker,
  RiskEstimator,
  PlanEvaluator,
  ReplanningEngine,
} from "./planner/index.js";
import type { Milestone } from "./planner/index.js";
import { TraceRecorder } from "./trace-recorder.js";
import { ArchSummarizer } from "./arch-summarizer.js";
import { FailureSignatureMemory } from "./failure-signature-memory.js";
import { CausalChainResolver } from "./causal-chain-resolver.js";
import { PlaybookLibrary } from "./playbook-library.js";
import { ProjectExecutive } from "./project-executive.js";
import { StallDetector } from "./stall-detector.js";
import { SelfImprovementLoop } from "./self-improvement-loop.js";
import { MetaLearningCollector } from "./meta-learning-collector.js";
import { TrustEconomics, type ActionClass } from "./trust-economics.js";
import { StrategyLearner } from "./strategy-learner.js";
import { SkillRegistry } from "./skill-registry.js";
import { TracePatternExtractor } from "./trace-pattern-extractor.js";
import { MetaLearningEngine } from "./meta-learning-engine.js";
import { ToolSynthesizer } from "./tool-synthesizer.js";
import { BudgetGovernorV2 } from "./budget-governor-v2.js";
import { CapabilityGraph } from "./capability-graph.js";
import { CapabilitySelfModel } from "./capability-self-model.js";
import { StrategyMarket } from "./strategy-market.js";
import { recordBudgetUsage, checkBudgetShouldHalt } from "./extensions/budget-wiring.js";
import { registerToolsInGraph, recordToolOutcomeInGraph } from "./extensions/cap-graph-wiring.js";
import { getSelfWeaknessContext } from "./extensions/self-model-wiring.js";
import { initMarketPlaybooks, selectMarketStrategy } from "./extensions/strategy-wiring.js";
import { VisionIntentDetector } from "./vision-intent-detector.js";
import { PatchTransactionJournal } from "./patch-transaction.js";
import { securityCheck } from "./security-gate.js";
import { JudgmentRuleRegistry } from "./judgment-rules.js";
import { loadOrScanProfile } from "./repo-capability-profile.js";
import { verifyToolResult } from "./verifier-rules.js";
import { checkDependencyChange } from "./dependency-guard.js";
import { WorkspaceMutationPolicy } from "./workspace-mutation-policy.js";
import { validateBeforeWrite, detectFileRole } from "./pre-write-validator.js";
import { PatchScopeController, detectRepoLifecycle } from "./patch-scope-controller.js";
import { classifyCommand, validateProposedCommand, compileVerifyCommands } from "./command-plan-compiler.js";
import type { CommandCompilerInput } from "./command-plan-compiler.js";
import { reviewFileDiff } from "./semantic-diff-reviewer.js";
import { ModelWeaknessTracker } from "./model-weakness-tracker.js";
import { dlog, dlogSep } from "./debug-logger.js";
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
  /** OverheadGovernor config — per-subsystem OFF/SHADOW/BLOCKING policy */
  overheadGovernorConfig?: OverheadGovernorConfig;
}

const CLASSIFICATION_CONFIDENCE_THRESHOLD = 0.6;

const SPAWN_SUB_AGENT_TOOL: import("./types.js").ToolDefinition = {
  name: "spawn_sub_agent",
  description:
    "Spawn a sub-agent to work on a delegated task in parallel. " +
    "The sub-agent runs an independent agent loop with its own tool access, " +
    "inheriting the same LLM configuration. Use this for tasks that can be " +
    "broken down (e.g., implement one module while you work on another, " +
    "run a review pass, verify changes).",
  parameters: {
    type: "object",
    properties: {
      goal: {
        type: "string",
        description: "The specific task goal for the sub-agent to accomplish.",
      },
      role: {
        type: "string",
        enum: ["coder", "critic", "verifier", "specialist"],
        description:
          "Sub-agent role. 'coder' writes code, 'critic' reviews for issues, " +
          "'verifier' checks correctness, 'specialist' handles domain tasks. " +
          "Defaults to 'coder'.",
      },
    },
    required: ["goal"],
    additionalProperties: false,
  },
  source: "builtin",
  readOnly: false,
  requiresApproval: false,
  riskLevel: "medium",
};

/** Map user-facing sub-agent roles to internal SubAgentRole */
function mapToSubAgentRole(role?: string): SubAgentRole {
  switch (role) {
    case "critic":
      return "reviewer";
    case "verifier":
      return "tester";
    case "specialist":
      return "coder";
    case "coder":
      return "coder";
    default:
      return "coder";
  }
}

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
  /** @deprecated Use decision.core.memoryLoad.shouldLoad at runtime. Kept for constructor init only. */
  private readonly enableMemory: boolean;
  /** @deprecated Use decision.core.planRequired at runtime. Kept for constructor init only. */
  private readonly enablePlanning: boolean;
  /** @deprecated Planning threshold is now determined by Decision Engine. Kept for constructor init only. */
  private readonly planningThreshold: "simple" | "moderate" | "complex";
  private readonly environment?: EnvironmentInfo;
  private yuanMemory: YuanMemory | null = null;
  private memoryManager: MemoryManager | null = null;
  private judgmentRegistry: JudgmentRuleRegistry | null = null;
  private planner: HierarchicalPlanner | null = null;
  private activePlan: HierarchicalPlan | null = null;
  /** @deprecated Use AgentDecisionContext when available; taskClassifier is legacy fallback only */
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
  private partialInit = false;
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
  private lastImpactReport: import("./impact-analyzer.js").ImpactReport | null = null;
  private lastImpactFilesKey: string = "";
  private selfReflection: SelfReflection | null = null;
  private debateOrchestrator: DebateOrchestrator | null = null;
  private continuousReflection: ContinuousReflection | null = null;
  private readonly enableSelfReflection: boolean;
  private readonly enableDebate: boolean;
  private currentComplexity: "trivial" | "simple" | "moderate" | "complex" | "massive" = "simple";
  // ─── Agent Decision Engine ─────────────────────────────────────────────────
  private decision: AgentDecisionContext = DEFAULT_DECISION;
  // ─── Prompt 3-Layer Architecture ──────────────────────────────────────────
  private pendingRunContext: NonNullable<PromptRuntimeInput["runContext"]> = {};
  /** Cached values for refreshSystemPrompt() — set during criticalInit/backgroundInit */
  private _cachedProjectStructure: import("./memory.js").ProjectStructure | undefined;
  private _cachedYuanMdContent: string | undefined;
  private prevDecision: AgentDecisionContext = DEFAULT_DECISION;
  private toolUsageCounter = {
    reads: 0,
    edits: 0,
    shells: 0,
    tests: 0,
    searches: 0,
    webLookups: 0,
    sameFileEdits: new Map<string, number>(),
  };
  private readonly policyOverrides?: Partial<ExecutionPolicy>;
  private checkpointSaved = false;
  private iterationCount = 0;
  private agentHypothesis: string | undefined = undefined;
  private agentFailureSig: string | undefined = undefined;
  private agentVerifyState: "pass" | "fail" | "pending" | undefined = undefined;
  private lastAgentStateInjection = 0;
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
  /** @deprecated Use decision.core.skillActivation.enableToolPlanning at runtime. Kept for constructor init only. */
  private readonly enableToolPlanning: boolean;
  /** @deprecated Use decision.core.skillActivation.enableSkillLearning at runtime. Kept for constructor init only. */
  private readonly enableSkillLearning: boolean;
  /** @deprecated Use decision.core.subAgentPlan.enabled at runtime. Kept for constructor init only. */
  private readonly enableBackgroundAgents: boolean;
  private currentToolPlan: ToolPlan | null = null;
  private executedToolNames: string[] = [];
  /** Unfulfilled-intent continuation counter — reset each run(), max 3 nudges */
  private _unfulfilledContinuations = 0;
  /** Model weakness learning layer — scoped by model+repo */
  private weaknessTracker: ModelWeaknessTracker | null = null;
  /** Context Budget: max 3 active skills at once */
  private activeSkillIds: string[] = [];
  private static readonly MAX_ACTIVE_SKILLS = 3;
  /** Context Budget: track injected system messages per iteration to cap at 5 */
  private iterationSystemMsgCount = 0;
  private contextBudgetManager: ContextBudgetManager | null = null;
  private _contextSummarizationDone = false;
  private iterationWriteToolPaths: string[] = [];
  private lastQAResult: QAPipelineResult | null = null;
  private iterationTsFilesModified: string[] = [];
  private tscRanLastIteration = false;
  private patchJournal: PatchTransactionJournal | null = null;
  private mutationPolicy: WorkspaceMutationPolicy | null = null;
  private patchScopeController: PatchScopeController | null = null;
  /** Per-iteration ephemeral hints — collected and bulk-injected before next LLM call */
  private ephemeralHints: string[] = [];
  // ─── OverheadGovernor ──────────────────────────────────────────────────
  private readonly overheadGovernor: OverheadGovernor;
  /** Writes since last verify ran (for QA/quickVerify trigger) */
  private writeCountSinceVerify = 0;
  /** Current task phase (explore → implement → verify → finalize) */
  private taskPhase: TaskPhase = "explore";
  /** Per-iteration: verify already ran this iteration (single-flight guard) */
  private verifyRanThisIteration = false;
  /** Per-iteration: summarize already ran this iteration */
  private summarizeRanThisIteration = false;
  /** Per-iteration: llmFixer run count */
  private llmFixerRunCount = 0;
  /** Repeated error signature (same error string seen 2+ times) */
  private repeatedErrorSignature: string | undefined = undefined;
  private _lastErrorSignature: string | undefined = undefined;
  private _errorSignatureCount = 0;
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
private traceRecorder: TraceRecorder | null = null;
private archSummarizer: ArchSummarizer | null = null;
  private failureSigMemory: FailureSignatureMemory | null = null;
  private playbookLibrary: PlaybookLibrary | null = null;
  private projectExecutive: ProjectExecutive | null = null;
  private stallDetector: StallDetector | null = null;
  private selfImprovementLoop: SelfImprovementLoop | null = null;
  private metaLearningCollector: MetaLearningCollector | null = null;
  private trustEconomics: TrustEconomics | null = null;
  private strategyLearner: StrategyLearner | null = null;
  private skillRegistry: SkillRegistry | null = null;
  private tracePatternExtractor: TracePatternExtractor | null = null;
  private metaLearningEngine: MetaLearningEngine | null = null;
  private toolSynthesizer: ToolSynthesizer | null = null;
  private budgetGovernorV2: BudgetGovernorV2 | null = null;
  private capabilityGraph: CapabilityGraph | null = null;
  private capabilitySelfModel: CapabilitySelfModel | null = null;
  private strategyMarket: StrategyMarket | null = null;
  private sessionRunCount: number = 0;
  /** Vision Intent Detector — auto-triggers image reads when LLM/user signals intent */
  private readonly visionIntentDetector: VisionIntentDetector = new VisionIntentDetector();
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

    this.llmClient = new BYOKClient(options.config.byok);
    this.governor = new Governor(options.governorConfig);
    this.overheadGovernor = new OverheadGovernor(
      options.overheadGovernorConfig,
      (subsystem, reason) => {
        // Shadow log — emit as thinking event so TUI can see it (dimmed)
        this.emitEvent({ kind: "agent:thinking", content: `[shadow] ${subsystem}: ${reason}` });
      },
    );

    this.contextManager = new ContextManager({
      maxContextTokens:
        options.contextConfig?.maxContextTokens ??
        options.config.loop.totalTokenBudget,
      outputReserveTokens:
        options.contextConfig?.outputReserveTokens ?? 4096,
      ...options.contextConfig,
    });

    this.approvalManager = new ApprovalManager(options.approvalConfig);
    if (options.approvalHandler) {
      this.approvalManager.setHandler(options.approvalHandler);
    }

    this.autoFixLoop = new AutoFixLoop(options.autoFixConfig);
    this.taskClassifier = new TaskClassifier();
    this.promptDefense = new PromptDefense();
    this.tokenBudgetManager = new TokenBudgetManager({
      totalBudget: options.config.loop.totalTokenBudget,
    });
    this.memoryUpdater = new MemoryUpdater();
    this.failureRecovery = new FailureRecovery();
    this.costOptimizer = new CostOptimizer();
    this.policyOverrides = options.policyOverrides;

    this.mcpServerConfigs = options.mcpServerConfigs ?? [];
    this.interruptManager = options.interruptManager ?? new InterruptManager();
    this.setupInterruptListeners();

    this.pluginRegistry = options.pluginRegistry ?? new PluginRegistry();
    this.skillLoader = new SkillLoader();
    this.specialistRegistry = new SpecialistRegistry();
    this.toolPlanner = new ToolPlanner();
    this.selfDebugLoop = new SelfDebugLoop();
    this.enableToolPlanning = options.enableToolPlanning !== false;
    this.enableSkillLearning = options.enableSkillLearning !== false;
    this.enableBackgroundAgents = options.enableBackgroundAgents === true;

    this.contextManager.addMessage({
      role: "system",
      content: this.config.loop.systemPrompt,
    });
  }

  /**
   * Memory와 프로젝트 컨텍스트를 로드하여 시스템 프롬프트를 갱신.
   * run() 호출 전에 한 번 호출하면 메모리가 자동으로 주입된다.
   * 이미 초기화되었으면 스킵.
   * @deprecated run()은 내부적으로 criticalInit() + backgroundInit()을 직접 호출함.
   *             외부에서 호출 시 하위호환을 위해 유지.
   */
  async init(): Promise<void> {
    await this.criticalInit();
    await this.backgroundInit();
  }

  /**
   * TTFT 최적화: LLM 호출 전 반드시 완료되어야 하는 최소 초기화.
   * - 메모리/페르소나 로드 (YUAN.md, MemoryManager, PersonaManager)
   * - ExecutionPolicyEngine (FailureRecovery 설정)
   * - ImpactAnalyzer, ContinuationEngine + 체크포인트 복원
   * - buildSystemPrompt (projectStructure 없이 — background에서 보완)
   * 목표: 1초 이내 완료.
   */
  private async criticalInit(): Promise<void> {
    if (this.initialized) return;
    if (this.partialInit) return;
    this.partialInit = true;

    this.contextBudgetManager = new ContextBudgetManager({
      totalBudget: this.config.loop.totalTokenBudget,
      enableSummarization: true,
      summarizationThreshold: 0.60,
    });

    const projectPath = this.config.loop.projectPath;
    if (!projectPath) return;

    try {
      this.sessionPersistence = new SessionPersistence(undefined, projectPath);
    } catch {
      this.sessionPersistence = null;
    }

    let yuanMdContent: string | undefined;

    if (this.enableMemory) {
      try {
        this.yuanMemory = new YuanMemory(projectPath);
        const memData = await this.yuanMemory.load();
        if (memData) {
          yuanMdContent = memData.raw;
        }

        this.memoryManager = new MemoryManager(projectPath);
        await this.memoryManager.load();

        this.judgmentRegistry = new JudgmentRuleRegistry(projectPath);

        // Auto-expand judgment rules from repo capability profile
        try {
          const repoProfile = loadOrScanProfile(projectPath);
          this.judgmentRegistry.autoExpandFromProfile(repoProfile);
        } catch { /* non-fatal */ }

        const personaUserId = basename(projectPath) || "default";
        this.personaManager = new PersonaManager({
          userId: personaUserId,
          profilePath: pathJoin(projectPath, ".yuan", `persona-${personaUserId}.json`),
          enableLearning: true,
        });
        await this.personaManager.loadProfile().catch(() => {});
      } catch (memErr) {
        this.emitEvent({
          kind: "agent:error",
          message: `Memory load failed: ${memErr instanceof Error ? memErr.message : String(memErr)}`,
          retryable: false,
        });
      }
    }

    try {
      this.policyEngine = new ExecutionPolicyEngine(projectPath);
      await this.policyEngine.load();
      if (this.policyOverrides) {
        for (const [section, values] of Object.entries(this.policyOverrides)) {
          this.policyEngine.override(
            section as keyof ExecutionPolicy,
            values as Partial<ExecutionPolicy[keyof ExecutionPolicy]>,
          );
        }
      }
      const recoveryConfig = this.policyEngine.toFailureRecoveryConfig();
      this.failureRecovery = new FailureRecovery(recoveryConfig);
    } catch {
      // Policy load failure — use defaults
    }

    this.impactAnalyzer = new ImpactAnalyzer({ projectPath });
    this.continuationEngine = new ContinuationEngine({ projectPath });
    try {
      const latestCheckpoint = await this.continuationEngine.findLatestCheckpoint();
      if (latestCheckpoint) {
        const continuationPrompt = this.continuationEngine.formatContinuationPrompt(latestCheckpoint);
        this.contextManager.addMessage({
          role: "system",
          content: continuationPrompt,
        });
        await this.continuationEngine.pruneOldCheckpoints();
      }
    } catch {
      // non-fatal
    }

    this._cachedYuanMdContent = yuanMdContent;
    this._cachedProjectStructure = undefined;

    const allTools = [...this.config.loop.tools, ...this.mcpToolDefinitions, SPAWN_SUB_AGENT_TOOL];
    try {
      const envelope = compilePromptEnvelope({
        decision: this.decision,
        promptOptions: {
          projectStructure: undefined, // background에서 analyzeProject() 후 갱신
          yuanMdContent,
          tools: allTools,
          activeToolNames: allTools.map(t => t.name),
          projectPath,
          environment: this.environment,
        },
        runContext: this.pendingRunContext,
      });
      const enhancedPrompt = buildPrompt(envelope);
      this.contextManager.replaceSystemMessage(enhancedPrompt);
    } catch {
      // Fallback to legacy buildSystemPrompt if PromptRuntime fails
      const enhancedPrompt = buildSystemPrompt({
        projectStructure: undefined,
        yuanMdContent,
        tools: allTools,
        projectPath,
        environment: this.environment,
      });
      this.contextManager.replaceSystemMessage(enhancedPrompt);
    }
    // MemoryManager learnings → pendingRunContext
    if (this.memoryManager) {
      const memory = this.memoryManager.getMemory();
      if (memory.learnings.length > 0 || memory.failedApproaches.length > 0) {
        const memoryContext = this.buildMemoryContext(memory);
        if (memoryContext) {
          this.pendingRunContext.memoryContext = memoryContext;
          this.refreshSystemPrompt();
        }
      }
    }

  }

  /**
   * TTFT 최적화: LLM 호출을 블로킹하지 않는 백그라운드 초기화.
   * - VectorStore.load() + CodeIndexer
   * - analyzeProject() + WorldState 수집
   * - MCP connectAll()
   * - CapabilityGraph, SkillLearner, Phase 4/5/6
   * - HierarchicalPlanner, ContinuousReflection
   * criticalInit() 완료 후 fire-and-forget으로 실행됨.
   */
  private async backgroundInit(): Promise<void> {
    if (this.initialized) return;

    const projectPath = this.config.loop.projectPath;
    if (!projectPath) {
      this.initialized = true;
      this.partialInit = false;
      return;
    }

    this.partialInit = false;

    if (this.enableMemory && this.yuanMemory) {
      try {
        const personaUserId = basename(projectPath) || "default";
        this.vectorStore = new InMemoryVectorStore({
          projectId: personaUserId,
          projectPath,
          embeddingProvider: new OllamaEmbeddingProvider(),
        });
        await Promise.race([
          this.vectorStore.load(),
          new Promise<void>(resolve => setTimeout(resolve, 1_500)),
        ]).catch(() => {});

        const vectorStoreRef = this.vectorStore;
        import("./code-indexer.js").then(({ CodeIndexer }) => {
          const indexer = new CodeIndexer({});
          indexer.indexProject(projectPath, vectorStoreRef).catch(() => {});
        }).catch(() => {});

        const projectStructure = await this.yuanMemory.analyzeProject();
        const yuanMdContent = (await this.yuanMemory.load().catch(() => null))?.raw;
        this._cachedProjectStructure = projectStructure;
        this._cachedYuanMdContent = yuanMdContent;
        this.refreshSystemPrompt();
      } catch {
        // non-fatal
      }
    }

    try {
      const worldStateCollector = new WorldStateCollector({
        projectPath,
        maxRecentCommits: 10,
        skipTest: true,
      });
      this.worldState = await worldStateCollector.collect();

      if (this.worldState) {
        const collector = new WorldStateCollector({ projectPath });
        const worldStateSection = collector.formatForPrompt(this.worldState);
        this.pendingRunContext.worldStateSection = worldStateSection;
        this.refreshSystemPrompt();
      }
    } catch {
      // non-fatal
    }

    // CodeOrchestrator — append directly (not yet in runContext schema)
    try {
      const { codeOrchestrator } = await import('./code-orchestrator.js');
      const codeCtx = await codeOrchestrator.getContextForLLM(projectPath ?? '');
      if (codeCtx) {
        const currentMsgs = this.contextManager.getMessages();
        const sysMsg = currentMsgs.find((m) => m.role === "system");
        if (sysMsg) {
          this.contextManager.replaceSystemMessage(String(sysMsg.content) + '\n\n' + codeCtx);
        }
      }
    } catch { /* non-fatal */ }

    if (this.worldState && projectPath) {
      try {
        this.transitionModel = new TransitionModel();
        this.worldModel = StateStore.fromSnapshot(this.worldState, projectPath);
        this.simulationEngine = new SimulationEngine(this.transitionModel, this.worldModel);
        this.stateUpdater = new StateUpdater(this.worldModel, projectPath);
      } catch { /* non-fatal */ }
    }

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
      // non-fatal — FailureRecovery will use file-level rollback
    }

    {
      let mergedMCPConfigs = [...this.mcpServerConfigs];
      try {
        const fileConfig = await loadMCPConfig();
        if (fileConfig && fileConfig.servers.length > 0) {
          const existingNames = new Set(mergedMCPConfigs.map((s) => s.name));
          for (const server of fileConfig.servers) {
            if (!existingNames.has(server.name)) {
              mergedMCPConfigs.push(server);
            }
          }
        }
      } catch (mcpLoadErr) {
        this.emitEvent({
          kind: "agent:error",
          message: `MCP config load warning: ${mcpLoadErr instanceof Error ? mcpLoadErr.message : String(mcpLoadErr)}`,
          retryable: false,
        });
      }

      if (mergedMCPConfigs.length > 0) {
        try {
          this.mcpClient = new MCPClient({
            servers: mergedMCPConfigs,
          });
          await this.mcpClient.connectAll();
          this.mcpToolDefinitions = this.mcpClient.toToolDefinitions();
          this.emitEvent({
            kind: "agent:thinking",
            content: `MCP: loaded ${this.mcpToolDefinitions.length} tools from ${mergedMCPConfigs.length} server(s)`,
          });
        } catch {
          this.mcpClient = null;
          this.mcpToolDefinitions = [];
        }
      }
    }

    this.reflexionEngine = new ReflexionEngine({ projectPath });

    if (this.enableSelfReflection) {
      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.selfReflection = new SelfReflection(sessionId, {
        enableDeepVerify: true,
        enableMonologue: true,
        enableLearning: true,
        minScoreToPass: 70,
        criticalDimensions: ["correctness", "security"],
      });

      if (this.memoryManager) {
        try {
          const memory = await this.memoryManager.load();
          this.selfReflection.loadFromMemory(memory);
        } catch { /* non-fatal */ }
      }
    }

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

    const weaknessCtx = getSelfWeaknessContext(this.capabilitySelfModel);
    if (weaknessCtx) {
      this.pendingRunContext.weaknessContext = weaknessCtx;
      this.refreshSystemPrompt();
    }

    // ModelWeaknessTracker — learn from repeated validator blocks
    if (projectPath) {
      try {
        const modelId = this.config.byok.model ?? this.config.byok.provider;
        this.weaknessTracker = new ModelWeaknessTracker(projectPath, modelId);
        const hints = this.weaknessTracker.getPreventiveHints();
        if (hints.length > 0) {
          const existing = this.pendingRunContext.weaknessContext ?? "";
          this.pendingRunContext.weaknessContext =
            (existing ? existing + "\n" : "") +
            "[Model Weakness Prevention]\n" + hints.map(h => `- ${h}`).join("\n");
          this.refreshSystemPrompt();
        }
      } catch {
        this.weaknessTracker = null;
      }
    }

    const shouldLearnSkills = this.decision.core.skillActivation.enableSkillLearning;
    if (shouldLearnSkills && projectPath) {
      try {
        this.skillLearner = new SkillLearner(projectPath);
        await this.skillLearner.init();
      } catch {
        this.skillLearner = null;
      }
    }

    if (projectPath) {
      try {
        this.failureSigMemory = new FailureSignatureMemory({ projectPath });
        this.playbookLibrary = new PlaybookLibrary();
        this.projectExecutive = new ProjectExecutive(projectPath);
        const estimatedIter = this.config.loop.maxIterations ?? 20;
        this.stallDetector = new StallDetector(estimatedIter);
        this.projectExecutive.on("event", (ev) => this.emitEvent(ev));
        this.selfImprovementLoop = new SelfImprovementLoop({ projectPath });
        this.selfImprovementLoop.on("event", (ev) => this.emitEvent(ev as import("./types.js").AgentEvent));
        this.metaLearningCollector = new MetaLearningCollector({ projectPath });
        this.trustEconomics = new TrustEconomics({ projectPath });
      } catch { /* non-fatal */ }
    }

    try {
      this.strategyLearner = new StrategyLearner();
      this.skillRegistry = new SkillRegistry();
      this.strategyLearner.on("event", (ev) => this.emitEvent(ev as import("./types.js").AgentEvent));
      this.skillRegistry.on("event", (ev) => this.emitEvent(ev as import("./types.js").AgentEvent));
    } catch { /* non-fatal */ }
    try {
      this.tracePatternExtractor = new TracePatternExtractor();
      this.metaLearningEngine = new MetaLearningEngine({
        collector: this.metaLearningCollector ?? undefined,
        strategyLearner: this.strategyLearner ?? undefined,
      });
      this.toolSynthesizer = new ToolSynthesizer();
      this.tracePatternExtractor.on("event", (ev) => this.emitEvent(ev as import("./types.js").AgentEvent));
      this.metaLearningEngine.on("event", (ev) => this.emitEvent(ev as import("./types.js").AgentEvent));
      this.toolSynthesizer.on("event", (ev) => this.emitEvent(ev as import("./types.js").AgentEvent));
    } catch { /* non-fatal */ }
    try {
      this.budgetGovernorV2 = new BudgetGovernorV2({ taskBudget: this.config.loop.totalTokenBudget || 200_000 });
      this.capabilityGraph = new CapabilityGraph();
      this.capabilitySelfModel = new CapabilitySelfModel();
      this.strategyMarket = new StrategyMarket();
      this.budgetGovernorV2.on("event", (ev) => this.emitEvent(ev as import("./types.js").AgentEvent));
      this.capabilityGraph.on("event", (ev) => this.emitEvent(ev as import("./types.js").AgentEvent));
      this.capabilitySelfModel.on("event", (ev) => this.emitEvent(ev as import("./types.js").AgentEvent));
      this.strategyMarket.on("event", (ev) => this.emitEvent(ev as import("./types.js").AgentEvent));
      const toolNames = this.config.loop.tools.map((t) => t.name);
      registerToolsInGraph(this.capabilityGraph, toolNames);
    } catch { /* non-fatal */ }

    this.planner = new HierarchicalPlanner({ projectPath });
    if (this.skillLearner) {
      this.planner.setSkillLearner(this.skillLearner);
    }

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
    } catch { /* non-fatal */ }

    if (this.skillLearner) {
      const learnedSkills = this.skillLearner.getAllSkills();
      if (learnedSkills.length > 0) {
        const skillNames = learnedSkills
          .filter((s) => s.confidence >= CLASSIFICATION_CONFIDENCE_THRESHOLD)
          .map((s) => s.id);
        if (skillNames.length > 0) {
          this.pendingRunContext.learnedSkills = `[Learned Skills: ${skillNames.join(", ")}] — Auto-activate on matching error patterns.`;
          this.refreshSystemPrompt();
        }
      }
    }

    try {
      this.repoGraph = new RepoKnowledgeGraph(projectPath);
      this.repoGraph.buildFromProject(projectPath).catch(() => {});
    } catch {
      this.repoGraph = null;
    }

    const shouldEnableBgAgents = this.decision.core.subAgentPlan.enabled;
    if (shouldEnableBgAgents && projectPath) {
      try {
        this.backgroundAgentManager = new BackgroundAgentManager();
        this.backgroundAgentManager.createDefaults(projectPath);
        for (const agent of this.backgroundAgentManager.list()) {
          const bgAgent = this.backgroundAgentManager.get(agent.id);
          if (bgAgent) {
            bgAgent.on("event", (event: BackgroundEvent) => {
              this.emitEvent({
                kind: "agent:bg_update",
                agentId: event.agentId,
                agentLabel: event.agentId.replace(/-/g, " "),
                eventType: event.type,
                message: event.message,
                timestamp: event.timestamp,
              });
            });
          }
        }
      } catch {
        this.backgroundAgentManager = null;
      }
    }

    const activeSkills = this.pluginRegistry.getAllSkills();
    if (activeSkills.length > 0) {
      const skillSummary = activeSkills
        .map((s) => `${s.pluginId}/${s.skill.name}`)
        .join(", ");
      this.pendingRunContext.pluginSkills = `[Plugins: ${skillSummary}] — Skills auto-activate on matching files/errors.`;
      this.refreshSystemPrompt();
    }

    this.continuousReflection = new ContinuousReflection({
      getState: () => this.getStateSnapshot(),
      checkpoint: async (state, _emergency) => {
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

    this.initialized = true;
    this.partialInit = false;
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
   * 3-Layer Prompt 재빌드: pendingRunContext + cached state → PromptRuntime → PromptBuilder.
   * backgroundInit()에서 부분 컨텍스트가 채워질 때마다 호출.
   */
  private refreshSystemPrompt(): void {
    if (!this.initialized && !this.partialInit) return;
    const projectPath = this.config.loop.projectPath;
    const allTools = [...this.config.loop.tools, ...this.mcpToolDefinitions, SPAWN_SUB_AGENT_TOOL];
    try {
      const envelope = compilePromptEnvelope({
        decision: this.decision,
        promptOptions: {
          projectStructure: this._cachedProjectStructure,
          yuanMdContent: this._cachedYuanMdContent,
          tools: allTools,
          activeToolNames: allTools.map(t => t.name),
          projectPath,
          environment: this.environment,
        },
        runContext: this.pendingRunContext,
      });
      const prompt = buildPrompt(envelope);
      this.contextManager.replaceSystemMessage(prompt);
    } catch {
      // If PromptRuntime fails, leave existing system message as-is
    }
  }

  /**
   * 에이전트 루프를 실행.
   * 첫 호출 시 자동으로 Memory와 프로젝트 컨텍스트를 로드한다.
   * @param userMessage 사용자의 요청 메시지
   * @returns 종료 사유 및 결과
   */
  async run(userMessage: string): Promise<AgentTermination> {
    this.aborted = false;
    dlogSep("RUN START");
    dlog("AGENT-LOOP", `run() called`, { goal: userMessage.slice(0, 120), resumedFromSession: this.resumedFromSession });
    this.reasoningAggregator.reset();
    this.reasoningTree.reset();
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
      this.pendingRunContext = {};
      this.decision = DEFAULT_DECISION;
      this.toolUsageCounter = { reads: 0, edits: 0, shells: 0, tests: 0, searches: 0, webLookups: 0, sameFileEdits: new Map() };
      this.iterationTsFilesModified = [];
      this.tscRanLastIteration = false;
      this._contextSummarizationDone = false;
      this._unfulfilledContinuations = 0;
    }
    this.resumedFromSession = false;

this.checkpointSaved = false;
    this.failureRecovery.reset();
    this.patchJournal?.reset();
    this.patchScopeController?.reset();
    this.costOptimizer.reset();
    this.tokenBudgetManager.reset();
    const runStartTime = Date.now();

    dlog("AGENT-LOOP", `emitting agent:start, sessionId=${this.sessionId}`);
    this.emitEvent({ kind: "agent:start", goal: userMessage });

    await Promise.race([
      this.criticalInit(),
      new Promise<void>(resolve => setTimeout(resolve, 1_000)),
    ]);
    if (this.partialInit && !this.initialized) {
      this.partialInit = false;
    }
    this.backgroundInit().catch(() => {});
  this.sessionId = randomUUID();
  // Initialize patch transaction journal for atomic rollback
  if (this.config.loop.projectPath) {
    this.patchJournal = new PatchTransactionJournal(
      this.config.loop.projectPath,
      this.sessionId,
    );
  }
  try {
    this.budgetGovernorV2?.startTask(this.sessionId ?? "default");
    initMarketPlaybooks(this.strategyMarket);
  } catch { /* non-fatal */ }
  if (!this.traceRecorder) {
    this.traceRecorder = new TraceRecorder(this.sessionId);
  }
  if (!this.archSummarizer && this.config.loop.projectPath) {
    this.archSummarizer = new ArchSummarizer(this.config.loop.projectPath);
    this.archSummarizer.getSummary().catch(() => {/* non-fatal */});
  }
  if (this.playbookLibrary) {
    try {
      const playbook = this.playbookLibrary.query(userMessage);
      if (playbook) {
        this.pendingRunContext.playbookHint =
          `[Playbook: ${playbook.taskType} v${playbook.version}] ` +
          `Phase order: ${playbook.phaseOrder.join(" → ")}. ` +
          `Stop conditions: ${playbook.stopConditions.join(", ")}. ` +
          `Evidence required: ${playbook.evidenceRequirements.join(", ")}.`;
      }
    } catch { /* non-fatal */ }
  }
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
    const inputValidation = this.promptDefense.validateUserInput(userMessage);
    if (inputValidation.injectionDetected && (inputValidation.severity === "critical" || inputValidation.severity === "high")) {
      this.emitEvent({
        kind: "agent:error",
        message: `Prompt injection detected in user input (${inputValidation.severity}): ${inputValidation.patternsFound.join(", ")}`,
        retryable: false,
      });
    }

    this.contextManager.addMessage({
      role: "user",
      content: userMessage,
    });

    this.lastUserMessage = userMessage;
    if (this.personaManager) {
      this.personaManager.analyzeUserMessage(userMessage);
    }

    try {
      const visionIntent = this.visionIntentDetector.detect(userMessage);
      if (visionIntent && visionIntent.confidence >= 0.5) {
        this.emitEvent({
          kind: "agent:thinking",
          content: `[Vision] Detected intent to view "${visionIntent.filePath}" (${visionIntent.detectedLanguage}, confidence ${visionIntent.confidence}). Auto-reading…`,
        });
        const visionResult = await this.toolExecutor.execute({
          id: `vision-auto-${Date.now()}`,
          name: "file_read",
          arguments: { path: visionIntent.filePath },
        });
        if (visionResult.output.startsWith("[IMAGE_BLOCK]\n")) {
          const jsonStr = visionResult.output.slice("[IMAGE_BLOCK]\n".length);
          const parsed = JSON.parse(jsonStr) as { mediaType: string; data: string };
          const validMediaTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
          type ValidMediaType = typeof validMediaTypes[number];
          const mediaType: ValidMediaType = validMediaTypes.includes(parsed.mediaType as ValidMediaType)
            ? (parsed.mediaType as ValidMediaType)
            : "image/png";
          this.contextManager.addMessage({
            role: "user",
            content: [
              { type: "image" as const, data: parsed.data, mediaType },
            ],
          });
        }
      }
    } catch { /* non-fatal */ }

    try {
      if (this.personaManager) {
        const personaSection = this.personaManager.buildPersonaPrompt();
        if (personaSection) {
          this.pendingRunContext.personaSection = personaSection;
        }
      }

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
          this.pendingRunContext.taskMemory = `[Task Memory]\n${parts.join("\n\n")}`;
        }
      }

      if (this.vectorStore) {
        try {
          const hits = await this.vectorStore.search(userMessage, 3, 0.2);
          if (hits.length > 0) {
            const ragCtx = hits
              .map((h) => `**${h.id}** (relevance: ${(h.similarity * 100).toFixed(0)}%)\n${h.text.slice(0, 400)}`)
              .join("\n\n---\n\n");
            this.pendingRunContext.ragContext = `[RAG Context — semantically relevant code snippets]\n${ragCtx}`;
          }
        } catch { /* non-fatal */ }
      }

      if (this.reflexionEngine) {
        try {
          const guidance = await this.reflexionEngine.getGuidance(userMessage);
          const validStrategies = guidance.relevantStrategies.filter(
            (s) => s.strategy && s.strategy.length > 5 && s.confidence > 0.1,
          );
          if (validStrategies.length > 0 || guidance.recentFailures.length > 0) {
            const filteredGuidance = { ...guidance, relevantStrategies: validStrategies };
            const guidancePrompt = this.reflexionEngine.formatForSystemPrompt(filteredGuidance);
            this.pendingRunContext.reflexionGuidance = guidancePrompt;
          }
        } catch { /* non-fatal */ }
      }

      this.refreshSystemPrompt();

      // Legacy task classification block removed — Decision Engine is now always present.
      // Task classification, specialist routing, and tool planning are handled via
      // decision.core.skillActivation in the Decision-based overrides section below.

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
        } catch { /* non-fatal */ }
      }

      try {
        let projectCtx: AgentProjectContext | undefined = this.worldState
          ? worldStateToProjectContext(this.worldState)
          : undefined;
        // Codebase complexity stats are enriched by ExecutionEngine when it calls agentDecide
        // AgentLoop uses worldState only; CodebaseContext lives in ExecutionEngine

        this.decision = agentDecide({
          message: userMessage,
          projectContext: projectCtx,
          prevDecision: this.prevDecision ?? undefined,
        });

        this.emitEvent({
          kind: "agent:decision",
          decision: {
            intent: this.decision.core.reasoning.intent,
            complexity: this.decision.core.reasoning.complexity,
            taskStage: this.decision.core.reasoning.taskStage,
            planRequired: this.decision.core.planRequired,
            nextAction: this.decision.core.nextAction,
          },
        });

        this.emitEvent({
          kind: "agent:interaction_mode",
          mode: this.decision.core.interactionMode,
        });

        if (this.decision.core.nextAction === "ask_user" && this.decision.core.clarification) {
          const clar = this.decision.core.clarification;
          const clarMsg = `I need some clarification before proceeding:\n\n${clar.reason}` +
            (clar.missingFields.length > 0 ? `\n\nMissing: ${clar.missingFields.join(", ")}` : "") +
            (clar.allowProceedWithAssumptions ? "\n\n(I can proceed with assumptions if you prefer.)" : "");
          this.emitEvent({ kind: "agent:completed", summary: clarMsg, filesChanged: [] });
          return { reason: "NEEDS_CLARIFICATION", summary: clarMsg };
        }

        if (this.decision.core.nextAction === "blocked_external") {
          const blockedMsg = "This task appears to be blocked by an external dependency. Please resolve the blocking issue and retry.";
          this.emitEvent({ kind: "agent:completed", summary: blockedMsg, filesChanged: [] });
          return { reason: "BLOCKED_EXTERNAL", summary: blockedMsg };
        }

        this.currentComplexity = this.decision.core.reasoning.complexity;

        const decMode = this.decision.core.interactionMode;
        const decVd = this.decision.core.verifyDepth;
        if (decMode === "CHAT") {
          this.overheadGovernor.overrideConfig({
            autoTsc: "OFF",
            debate: "OFF",
            deepVerify: "OFF",
            quickVerify: "OFF",
            qaPipeline: "OFF",
            llmFixer: "OFF",
            summarize: "OFF",
          });
        } else if (decMode === "AGENT" && decVd === "thorough") {
          this.overheadGovernor.overrideConfig({
            autoTsc: "BLOCKING",
            deepVerify: "BLOCKING",
            quickVerify: "BLOCKING",
            qaPipeline: "BLOCKING",
          });
        } else if (decMode === "HYBRID") {
          this.overheadGovernor.overrideConfig({
            autoTsc: "SHADOW",
            quickVerify: "SHADOW",
            qaPipeline: "SHADOW",
          });
        }

        // ── Initialize safety floor modules (MutationPolicy + PatchScopeController) ──
        if (this.config.loop.projectPath) {
          this.mutationPolicy = new WorkspaceMutationPolicy(this.config.loop.projectPath);
          const lifecycle = detectRepoLifecycle(this.config.loop.projectPath);
          this.patchScopeController = new PatchScopeController(
            this.decision.core.reasoning.complexity,
            lifecycle,
          );
        }

        // ── Decision-based memory load override (Phase I+ SSOT) ──
        // If Decision says memory is not needed, clear already-loaded memory context
        // to reduce prompt size for trivial tasks.
        const shouldLoadMemory = this.decision.core.memoryLoad.shouldLoad;
        if (!shouldLoadMemory) {
          this.pendingRunContext.memoryContext = undefined;
          this.pendingRunContext.taskMemory = undefined;
          this.pendingRunContext.ragContext = undefined;
        }

        // ── Decision-based skill/specialist/background overrides (Phase I SSOT) ──
        const sa = this.decision.core.skillActivation;

        // Specialist routing from Decision
        if (sa.enableSpecialist && sa.specialistDomain) {
          const specialistMatch = this.specialistRegistry.findSpecialist(sa.specialistDomain);
          if (specialistMatch && specialistMatch.confidence >= CLASSIFICATION_CONFIDENCE_THRESHOLD) {
            this.contextManager.addMessage({
              role: "system",
              content: `[Specialist: ${specialistMatch.specialist.name}] ${specialistMatch.specialist.systemPrompt.slice(0, 500)}`,
            });
          }
        }

        // Tool planning from Decision
        if (sa.enableToolPlanning) {
          const classification = this.taskClassifier.classify(userMessage);
          if (classification.confidence >= CLASSIFICATION_CONFIDENCE_THRESHOLD) {
            const planContext: PlanContext = { userMessage };
            this.currentToolPlan = this.toolPlanner.planForTask(classification.type, planContext);
            this.executedToolNames = [];
            if (this.currentToolPlan.confidence >= CLASSIFICATION_CONFIDENCE_THRESHOLD) {
              const planHint = this.toolPlanner.formatPlanHint(this.currentToolPlan);
              this.contextManager.addMessage({
                role: "system",
                content: planHint,
              });
            }
          }
        }
      } catch {
        this.decision = DEFAULT_DECISION;
      }

      await this.maybeCreatePlan(userMessage);

      if (this.continuousReflection) {
        this.continuousReflection.start();
      }

      let result: AgentTermination;
      try {
        result = await this.executeLoop();
      } finally {
        if (this.continuousReflection) {
          this.continuousReflection.stop();
        }
      }

      this.prevDecision = this.decision;
      this.toolUsageCounter = { reads: 0, edits: 0, shells: 0, tests: 0, searches: 0, webLookups: 0, sameFileEdits: new Map() };

      if (this.sessionPersistence && this.sessionId) {
        const finalStatus =
          result.reason === "ERROR"
            ? "crashed"
            : "completed";
        await this.sessionPersistence.updateStatus(this.sessionId, finalStatus);
      }
      await this.updateMemoryAfterRun(userMessage, result, Date.now() - runStartTime);

      if (result.reason === "GOAL_ACHIEVED") {
        try {
          if (this.failureSigMemory && this.repeatedErrorSignature) {
            this.failureSigMemory.promote(
              this.repeatedErrorSignature,
              "resolved",
              this.allToolResults.filter(r => r.success).map(r => r.name),
              true,
            );
          }
          if (this.playbookLibrary) {
            const taskType = this.playbookLibrary.query(userMessage)?.taskType;
            if (taskType) {
              this.playbookLibrary.recordOutcome(taskType, true);
            }
          }
        } catch { /* non-fatal */ }
      }

      try {
        const taskType = this.playbookLibrary?.query(userMessage)?.taskType ?? "unknown";
        const championPlaybook = selectMarketStrategy(this.strategyMarket, taskType);
        if (championPlaybook) {
          this.emitReasoning(`strategy champion for ${taskType}: ${championPlaybook}`);
        }
        const toolSeq = this.allToolResults.slice(-20).map((r) => r.name);
        const runSuccess = result.reason === "GOAL_ACHIEVED";
        const runDurationMs = Date.now() - runStartTime;

        if (this.selfImprovementLoop) {
          this.selfImprovementLoop.recordOutcome({
            taskType,
            strategy: "default",
            toolSequence: toolSeq,
            success: runSuccess,
            iterationsUsed: this.iterationCount,
            tokensUsed: this.tokenUsage.total,
            durationMs: runDurationMs,
            errorSignatures: this.repeatedErrorSignature ? [this.repeatedErrorSignature] : [],
          });
          this.selfImprovementLoop.generateProposals();
        }

        if (this.metaLearningCollector) {
          this.metaLearningCollector.record({
            taskType,
            governorPolicies: {},
            toolSequence: toolSeq,
            latencyMs: runDurationMs,
            tokensUsed: this.tokenUsage.total,
            success: runSuccess,
            iterationsUsed: this.iterationCount,
          });
        }

        if (this.trustEconomics) {
          for (const tr of this.allToolResults.slice(-20)) {
            const ac = toolNameToActionClass(tr.name);
            if (ac) this.trustEconomics.record(ac, tr.success);
          }
        }

        if (this.strategyLearner) {
          const activePlaybookId = (this as unknown as { _activePlaybookId?: string })._activePlaybookId ?? "default";
          if (runSuccess) {
            this.strategyLearner.recordSuccess(activePlaybookId, taskType, this.iterationCount, this.tokenUsage.total);
          } else {
            this.strategyLearner.recordFailure(activePlaybookId, taskType, this.iterationCount, this.tokenUsage.total);
          }
        }

        this.sessionRunCount += 1;
        if (this.sessionRunCount % 10 === 0) {
          if (this.tracePatternExtractor) {
            this.tracePatternExtractor.extract().catch(() => {/* non-fatal */});
          }
          if (this.metaLearningEngine) {
            this.metaLearningEngine.analyze().catch(() => {/* non-fatal */});
          }
        }

        try {
          const env = (this as unknown as { _detectedEnvironment?: string })._detectedEnvironment ?? "general";
          this.capabilitySelfModel?.recordOutcome(env, taskType, runSuccess);
          this.strategyMarket?.recordResult(
            (this as unknown as { _activePlaybookId?: string })._activePlaybookId ?? "default",
            taskType,
            {
              success: runSuccess,
              tokenCost: this.tokenUsage?.total ?? 0,
              latencyMs: Date.now() - runStartTime,
            },
          );
          this.budgetGovernorV2?.endTask(this.sessionId ?? "default");
        } catch { /* non-fatal */ }
      } catch { /* non-fatal */ }

      if (this.skillLearner && result.reason === "GOAL_ACHIEVED") {
        try {
          let newSkillId: string | null = null;
          const errorToolResults = this.allToolResults.filter((r) => !r.success);
          if (errorToolResults.length > 0 && this.changedFiles.length > 0) {
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
        } catch { /* non-fatal */ }
      }

      if (this.currentToolPlan && this.executedToolNames.length > 0) {
        try {
          this.toolPlanner.validateExecution(this.currentToolPlan, this.executedToolNames);
        } catch { /* non-fatal */ }
      }

      if (this.repoGraph && this.changedFiles.length > 0) {
        this.repoGraph.updateFiles(this.changedFiles).catch(() => {});
      }

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
    // Gate by both memoryLoad (loading) and memoryIntent (saving)
    if (!this.decision.core.memoryIntent.shouldSave || !this.memoryManager) return;

    try {
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

      const learnings = this.memoryUpdater.extractLearnings(analysis, userGoal);
      for (const learning of learnings) {
        this.memoryManager.addLearning(learning.category, learning.content);
      }

      for (const convention of analysis.conventions) {
        this.memoryManager.addConvention(convention);
      }

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

      if (result.reason === "ERROR") {
        this.memoryManager.addFailedApproach(
          `Task: ${userGoal.slice(0, 80)}`,
          (result as { error?: string }).error ?? "Unknown error",
        );
      }

      if (this.iterationCount % 5 === 0) {
        this.memoryManager.prune();
      }

      await this.memoryManager.save();

      if (this.personaManager) {
        await this.personaManager.saveProfile().catch(() => {});
      }
    } catch { /* non-fatal */ }

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

        if (entry.outcome === "success") {
          const strategy = this.reflexionEngine.extractStrategy(entry, userGoal);
          if (strategy) {
            await this.reflexionEngine.store.saveStrategy(strategy);
          }
        }
      } catch { /* non-fatal */ }
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
      hypothesis: this.agentHypothesis,
      failureSignature: this.agentFailureSig,
      verifyState: this.agentVerifyState,
    };
  }

  /**
   * 매 이터레이션 LLM 호출 전 compact AgentState를 컨텍스트에 주입한다.
   * 3 이터레이션마다 갱신하여 컨텍스트 팽창 방지.
   */
  private injectAgentStateIfNeeded(iteration: number): void {
    // 첫 이터레이션 or 3회마다 or 상태 변화 시 주입
    const stateChanged =
      this.agentHypothesis !== undefined ||
      this.agentFailureSig !== undefined ||
      this.agentVerifyState === "fail";
    const shouldInject =
      iteration <= 1 ||
      iteration - this.lastAgentStateInjection >= 3 ||
      stateChanged;
    if (!shouldInject) return;

    const budgetPct = this.config?.loop?.totalTokenBudget
      ? Math.round((this.tokenUsage.total / this.config.loop.totalTokenBudget) * 100)
      : 0;
    const remaining = 100 - budgetPct;

    const lines: string[] = [`[AgentState] iteration=${iteration}`];
    if (this.agentHypothesis) lines.push(`hypothesis: ${this.agentHypothesis}`);
    if (this.agentFailureSig) lines.push(`last_failure: ${this.agentFailureSig}`);
    if (this.agentVerifyState) lines.push(`verify: ${this.agentVerifyState}`);
    if (this.changedFiles.length > 0) {
      const files = this.changedFiles.slice(-4).join(", ");
      lines.push(`changed: ${files}`);
    }
    lines.push(`token_budget: ${remaining}% remaining`);

    this.ephemeralHints.push(lines.join(" | "));
    this.lastAgentStateInjection = iteration;
  }

  /**
   * Phase B: flush collected ephemeral hints into context as system messages.
   * Applies rate-limiting: max 7 hints, max 3000 tokens total (matching PromptRuntime compileEphemeral).
   * Called at end of each iteration (before next LLM call) and before `continue` statements.
   */
  private flushEphemeralHints(): void {
    if (this.ephemeralHints.length === 0) return;

    const MAX_HINTS = 7;
    const MAX_TOKENS = 3000;
    let tokenCount = 0;

    for (const hint of this.ephemeralHints.slice(0, MAX_HINTS)) {
      const tokens = Math.ceil(hint.length / 3.5);
      if (tokenCount + tokens > MAX_TOKENS) break;
      tokenCount += tokens;
      this.contextManager.addMessage({ role: "system", content: hint });
    }

    this.ephemeralHints = [];
  }

  /**
   * LLM 응답 텍스트에서 "Updated hypothesis:" 마커를 파싱해 hypothesis를 갱신한다.
   */
  updateHypothesisFromResponse(text: string): void {
    const match = text.match(/Updated hypothesis:\s*(.+?)(?:\n|$)/i);
    if (match?.[1]) {
      this.agentHypothesis = match[1].trim().slice(0, 300);
    }
  }

  /**
   * 검증 결과를 기록한다. CausalChainResolver 트리거에 사용.
   */
  recordVerifyResult(state: "pass" | "fail" | "pending", signature?: string): void {
    this.agentVerifyState = state;
    if (signature) this.agentFailureSig = signature;
    if (state === "pass") this.agentFailureSig = undefined;
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
    if (!this.planner) return;

    if (!this.decision.core.planRequired) return;

this.emitSubagent("planner", "start", `task complexity ${this.currentComplexity}. creating execution plan`);

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
   * Detect the best test/verify command for the current project.
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

  /** @deprecated Use AgentDecisionContext.core.reasoning.complexity instead */
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
   * @deprecated Use AgentDecisionContext.core.reasoning.complexity instead.
   * Hybrid complexity detection: keyword heuristic + LLM fallback for borderline cases.
   * Only called when Decision Engine is absent.
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

        this.ephemeralHints.push(`[Re-plan] Strategy: ${result.strategy}. Reason: ${result.reason}.\nModified tasks: ${result.modifiedTasks.map((t) => t.description).join(", ")}`);
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
    dlog("AGENT-LOOP", `entering main loop`, { contextMessages: this.contextManager?.getMessages?.()?.length ?? "?", totalTokenBudget: this.config.loop.totalTokenBudget });
let iteration = this.iterationCount;

    while (!this.aborted) {
  // ensure loop state always matches persisted iteration
  if (iteration !== this.iterationCount) {
    iteration = this.iterationCount;
  }
 if (this.abortSignal?.aborted) {
    return { reason: "USER_CANCELLED" };
  }
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
          dlog("AGENT-LOOP", `run() terminating`, { reason: "MAX_ITERATIONS", tokensUsed: this.tokenUsage.total, iterations: this.iterationCount });
          return {
            reason: "MAX_ITERATIONS",
            lastState: `Stopped at iteration ${iteration}: ${err.message}`,
          };
        }
        throw err;
      }

      iteration++;
      this.iterationCount = iteration;
      dlog("AGENT-LOOP", `── iteration ${iteration} start ──`, { tokenUsageTotal: this.tokenUsage.total });
      const iterationStart = Date.now();
      dlog("AGENT-LOOP", `BUDGET_EXHAUSTED check`, { used: this.tokenUsage.total, budget: this.config.loop.totalTokenBudget });
      if (checkBudgetShouldHalt(this.budgetGovernorV2, this.sessionId ?? "default")) {
        return { reason: "BUDGET_EXHAUSTED", tokensUsed: this.tokenUsage.total };
      }
      this.verifyRanThisIteration = false;
      this.summarizeRanThisIteration = false;
      this.llmFixerRunCount = 0;
      this.iterationSystemMsgCount = 0;
      this.ephemeralHints = [];
      this.pruneMessagesIfNeeded();

      this.allToolResults = cap(this.allToolResults, BOUNDS.allToolResults);
      this.allToolResultsSinceLastReplan = cap(this.allToolResultsSinceLastReplan, BOUNDS.toolResultsSinceReplan);

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

            this.allToolResultsSinceLastReplan = [];

            this.ephemeralHints.push(`[Proactive Replan] ${replanResult.message}\nScope: ${replanResult.decision.scope}, Risk: ${replanResult.decision.urgency}`);
          }
        } catch { /* non-fatal */ }
      }

      if (this.activePlan) {
        this.injectPlanProgress(iteration);
      }

      const contextUsageRatio = this.contextManager.getUsageRatio();
      const summarizeMode = this.overheadGovernor.shouldRunSummarize(this.buildTriggerContext());
      if (summarizeMode === "BLOCKING") this.summarizeRanThisIteration = true;
      if (contextUsageRatio >= 0.75 && this.contextBudgetManager && !this._contextSummarizationDone && summarizeMode === "BLOCKING") {
        this._contextSummarizationDone = true;
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
          }).catch(() => {});
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
        const slotsRemaining = AgentLoop.MAX_ACTIVE_SKILLS - this.activeSkillIds.length;
        for (const skill of fileSkills.slice(0, Math.min(2, slotsRemaining))) {
          if (this.activeSkillIds.includes(skill.id)) continue; // no duplicate
          const parsed = this.skillLoader.loadTemplate(skill);
          if (parsed) {
            this.ephemeralHints.push(`[File Skill: ${skill.name}] ${parsed.domain ? `[${parsed.domain}] ` : ""}${skill.description}`);
            this.activeSkillIds.push(skill.id);
          }
        }
      }

      // 1. 컨텍스트 준비 + AgentState 주입 (매 이터레이션, compact)
      this.injectAgentStateIfNeeded(iteration);
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

      let response: LLMResponse;
      try {
        dlog("AGENT-LOOP", `calling LLM`, { messages: (this as unknown as Record<string, unknown[]>).messages?.length ?? "?", iteration });
        response = await this.callLLMStreaming(messages);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        dlog("AGENT-LOOP", `run() LLM error`, { reason: "ERROR", error: errMsg, tokensUsed: this.tokenUsage.total, iterations: this.iterationCount });
        this.emit("event", { kind: "agent:error", message: errMsg, retryable: false });
        if (err instanceof LLMError) {
          return { reason: "ERROR", error: errMsg };
        }
        throw err;
      }

      // 토큰 추적
      this.tokenUsage.input += response.usage.input;
      this.tokenUsage.output += response.usage.output;
      this.tokenUsage.total += response.usage.input + response.usage.output;
      recordBudgetUsage(this.budgetGovernorV2, response.usage.input, response.usage.output, this.sessionId ?? "default");
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

      // hypothesis 업데이트 — LLM 응답에서 "Updated hypothesis:" 마커 파싱
      if (response.content) {
        this.updateHypothesisFromResponse(response.content);
      }

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

      // Vision Intent Detection — LLM reasoning/response
      // If the LLM signals it wants to look at an image in its content/reasoning,
      // auto-read it and inject as a user-side vision message for the next iteration.
      if (response.content) {
        try {
          const visionIntent = this.visionIntentDetector.detect(response.content);
          if (visionIntent && visionIntent.confidence >= 0.5 && response.toolCalls.length === 0) {
            this.emitEvent({
              kind: "agent:thinking",
              content: `[Vision] LLM requested view of "${visionIntent.filePath}" (${visionIntent.detectedLanguage}, confidence ${visionIntent.confidence}). Auto-reading…`,
            });
            const visionResult = await this.toolExecutor.execute({
              id: `vision-auto-llm-${Date.now()}`,
              name: "file_read",
              arguments: { path: visionIntent.filePath },
            });
            if (visionResult.output.startsWith("[IMAGE_BLOCK]\n")) {
              const jsonStr = visionResult.output.slice("[IMAGE_BLOCK]\n".length);
              const parsed = JSON.parse(jsonStr) as { mediaType: string; data: string };
              const validMediaTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
              type ValidMediaType = typeof validMediaTypes[number];
              const mediaType: ValidMediaType = validMediaTypes.includes(parsed.mediaType as ValidMediaType)
                ? (parsed.mediaType as ValidMediaType)
                : "image/png";
              // Add LLM response to context first, then inject vision as user follow-up
              this.contextManager.addMessage({
                role: "assistant",
                content: response.content,
              });
              this.contextManager.addMessage({
                role: "user",
                content: [
                  { type: "image" as const, data: parsed.data, mediaType },
                ],
              });
              // Continue loop so LLM gets the image on the next iteration
              continue;
            }
          }
        } catch {
          // Vision intent detection from LLM response is non-fatal
        }
      }

      // 3. 응답 처리
      if (response.toolCalls.length === 0) {
        const content = response.content ?? "";
        let finalSummary = content || "Task completed.";

        // Text-only response: let model decide next step (removed aggressive nudging)

        // Phase transition: implement → verify when LLM signals completion (no tool calls)
        if (this.taskPhase === "implement" && this.changedFiles.length > 0) {
          this.transitionPhase("verify", "LLM completion signal (no tool calls)");
          // Run cheap checks — if they fail, stay in implement and continue loop
          const cheapOk = await this.runCheapChecks();
          if (cheapOk) {
            this.recordVerifyResult("pass");
            this.transitionPhase("finalize", "cheap checks passed");
          } else {
            // cheap checks failed — stay in implement, let LLM fix
            this.recordVerifyResult("fail", "cheap checks failed");
            this.transitionPhase("implement", "cheap check failed, continuing");
            continue;
          }
        }

        const finalImpactSummary = await this.buildFinalImpactSummary();
        if (finalImpactSummary) {
          finalSummary = `${finalSummary}\n\n${finalImpactSummary}`;
        }
        // Level 2: Deep verification before declaring completion — Governor gated (default OFF)
        const deepVerifyMode = this.overheadGovernor.shouldRunDeepVerify(this.buildTriggerContext());
        if (deepVerifyMode === "BLOCKING") this.verifyRanThisIteration = true;
        if (this.selfReflection && this.changedFiles.length > 0 && deepVerifyMode === "BLOCKING") {
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
              this.ephemeralHints.push(`[Self-Reflection L2] Verification failed (score: ${deepResult.overallScore}, confidence: ${deepResult.confidence.toFixed(2)}). ${deepResult.selfCritique}${issuesList ? ` Issues: ${issuesList}` : ""}. Please address these before completing.`);
              // Flush ephemeral hints before continue (next iteration resets them)
              this.flushEphemeralHints();
             this.emitSubagent("verifier", "done", `deep verification failed, score ${deepResult.overallScore}. continuing to address issues`);
              continue; // Don't return GOAL_ACHIEVED, continue the loop
            }

            // Level 3: Multi-agent debate — Governor gated (default OFF)
            const debateMode = this.overheadGovernor.shouldRunDebate(this.buildTriggerContext());
            if (
              this.debateOrchestrator &&
              ["complex", "massive"].includes(this.currentComplexity) &&
              deepResult.verdict !== "pass" &&
              debateMode === "BLOCKING"
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
                  this.ephemeralHints.push(`[Debate] Multi-agent debate did not pass (score: ${debateResult.finalScore}). ${debateResult.summary}. Please address the identified issues.`);
                  // Flush ephemeral hints before continue
                  this.flushEphemeralHints();
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

        dlog("AGENT-LOOP", `run() terminating`, { reason: "GOAL_ACHIEVED", tokensUsed: this.tokenUsage.total, iterations: this.iterationCount });
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

      // Intercept task_complete — protocol-level completion signal
      const taskCompleteCall = response.toolCalls.find((tc) => tc.name === "task_complete");
      if (taskCompleteCall) {
        const callArgs = this.parseToolArgs(taskCompleteCall.arguments);
        const taskCompleteSummary = String(callArgs["summary"] ?? response.content ?? "Task completed.");

        if (this.decision.core.vetoFlags.verifyRequired && !this.verifyRanThisIteration) {
          this.ephemeralHints.push("[VERIFY REQUIRED] You must run build/test verification before completing. Run tsc, tests, or verification commands now.");
          // Don't return completion — continue loop so LLM runs verification first
          this.contextManager.addMessage({
            role: "assistant",
            content: response.content,
            tool_calls: response.toolCalls.filter((tc) => tc.name !== "task_complete"),
          });
          continue;
        }

          // Filter task_complete from tool_calls — internal protocol signal without matching tool result
        const nonProtocolCalls = response.toolCalls.filter((tc) => tc.name !== "task_complete");
        this.contextManager.addMessage({
          role: "assistant",
          content: response.content,
          tool_calls: nonProtocolCalls.length > 0 ? nonProtocolCalls : undefined,
        });

        this.emitEvent({
          kind: "agent:tool_result",
          tool: "task_complete",
          output: taskCompleteSummary,
          durationMs: 0,
        });

        dlog("AGENT-LOOP", `run() terminating`, { reason: "GOAL_ACHIEVED", tokensUsed: this.tokenUsage.total, iterations: this.iterationCount });
        this.emitEvent({
          kind: "agent:completed",
          summary: taskCompleteSummary,
          filesChanged: this.changedFiles,
        });
        this.emitEvent({
          kind: "agent:reasoning_tree",
          tree: this.reasoningTree.toJSON(),
        });
        return {
          reason: "GOAL_ACHIEVED",
          summary: taskCompleteSummary,
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

      this.allToolResults.push(...toolResults);

      const failedResults = toolResults.filter(r => !r.success);

for (const tr of toolResults) {
        recordToolOutcomeInGraph(this.capabilityGraph, tr.name, tr.success);
      }

      this.allToolResultsSinceLastReplan.push(...toolResults);

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

        // Image block from file_read — inject as vision ContentBlock
        if (sanitized.output.startsWith("[IMAGE_BLOCK]\n")) {
          try {
            const jsonStr = sanitized.output.slice("[IMAGE_BLOCK]\n".length);
            const parsed = JSON.parse(jsonStr) as { mediaType: string; data: string };
            const validMediaTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
            type ValidMediaType = typeof validMediaTypes[number];
            const mediaType: ValidMediaType = validMediaTypes.includes(parsed.mediaType as ValidMediaType)
              ? (parsed.mediaType as ValidMediaType)
              : "image/png";
            this.contextManager.addMessage({
              role: "tool",
              content: [
                { type: "image" as const, data: parsed.data, mediaType },
              ],
              tool_call_id: result.tool_call_id,
            });
          } catch {
            // Fallback: treat as plain text if parsing fails
            this.contextManager.addMessage({
              role: "tool",
              content: sanitized.output,
              tool_call_id: result.tool_call_id,
            });
          }
          continue;
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

      const projectPath = this.config.loop.projectPath;
      const qaMode = this.overheadGovernor.shouldRunQaPipeline(this.buildTriggerContext());
      if (this.iterationWriteToolPaths.length > 0 && projectPath && qaMode !== "OFF") {
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

          const failedChecks = qaResult.stages
            .flatMap((s) => s.checks)
            .filter((c) => c.status === "fail" || c.status === "warn");

          const qaIssues = failedChecks
            .slice(0, 10)
            .map((c) => `[${c.severity}] ${c.name}: ${c.message}`);

          // Always emit event for TUI display (SHADOW + BLOCKING)
          this.emitEvent({
            kind: "agent:qa_result",
            stage: "quick",
            passed: failedChecks.length === 0,
            issues: qaIssues,
          });

          // Only inject into LLM context in BLOCKING mode (SHADOW = observe only)
          if (qaMode === "BLOCKING" && failedChecks.length > 0) {
            const checkSummary = failedChecks
              .slice(0, 5)
              .map((c) => `  - [${c.severity}] ${c.name}: ${c.message}`)
              .join("\n");
            this.ephemeralHints.push(`[QA Quick Check] ${failedChecks.length} issue(s) detected in modified files:\n${checkSummary}`);
          }
        } catch {
          // QAPipeline failure is non-fatal
        }
      }
      this.iterationWriteToolPaths = [];

      if (this.stallDetector) {
        try {
          const stallResult = this.stallDetector.check(
            this.iterationCount,
            this.changedFiles,
            this.repeatedErrorSignature,
          );
          if (stallResult.stalled && stallResult.reason) {
            this.emitEvent({
              kind: "agent:task_stalled",
              taskId: this.sessionId ?? "unknown",
              stallReason: stallResult.reason,
              iterationsElapsed: stallResult.iterationsElapsed,
              estimatedIterations: this.config.loop.maxIterations ?? 20,
              timestamp: Date.now(),
            });
          }
        } catch { /* non-fatal */ }
      }

      const tscFilesThisIteration = [...this.iterationTsFilesModified];
      this.iterationTsFilesModified = []; // reset for next iteration
      const tscRanPrev = this.tscRanLastIteration;
      this.tscRanLastIteration = false; // will set to true below if we run it

      const tscMode = this.overheadGovernor.shouldRunAutoTsc(this.buildTriggerContext());
      if (tscFilesThisIteration.length >= 2 && projectPath && !tscRanPrev && tscMode !== "OFF") {
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

          if (tscResult.success && tscResult.output && tscResult.output.trim().length > 0) {
            const tscOutput = tscResult.output.trim();
            const hasErrors = tscOutput.includes(": error TS") || tscOutput.includes("error TS");
            if (hasErrors) {
              // Always emit thinking event (SHADOW + BLOCKING)
              this.emitEvent({
                kind: "agent:thinking",
                content: `Auto-TSC: TypeScript errors found after editing ${tscFilesThisIteration.join(", ")}.`,
              });
              // Only inject into LLM context in BLOCKING mode
              if (tscMode === "BLOCKING") {
                const truncated = tscOutput.length > 2000
                  ? tscOutput.slice(0, 2000) + "\n[...tsc output truncated]"
                  : tscOutput;
                this.ephemeralHints.push(`[Auto-TSC] TypeScript errors detected after modifying ${tscFilesThisIteration.length} files:\n\`\`\`\n${truncated}\n\`\`\`\nPlease fix these type errors.`);
              }
            } else {
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
          if (insight && insight.length > 10) {
            this.ephemeralHints.push(`[Reflection] ${insight}`);
          }
        } catch {
          // Reflection failure is non-fatal
        }
      }

      // Level 1: Quick verification — Governor gated (default SHADOW = no LLM call)
      const quickVerifyMode = this.overheadGovernor.shouldRunQuickVerify(this.buildTriggerContext());
      if (this.selfReflection && iteration % 3 === 0 && quickVerifyMode === "BLOCKING") {
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
              this.ephemeralHints.push(`[Self-Reflection L1] Issues detected: ${issues.join(", ")}. Confidence: ${quickResult.confidence}`);
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

        // Track repeated error signature for Governor
        this.trackErrorSignature(errorSummary);

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
          // 에스컬레이션: log only, don't surface as error (too noisy for UX)
          dlog("AGENT-LOOP", `recovery escalated: ${decision.reason}`);
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
        } else {
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
          const llmFixerMode = this.overheadGovernor.shouldRunLlmFixer(this.buildTriggerContext());
          if (iteration >= 3 && llmFixerMode === "BLOCKING") {
            const rootCauseAnalysis = this.selfDebugLoop.analyzeError(errorSummary);
            if (rootCauseAnalysis.confidence >= 0.5) {
              const debugStrategy = this.selfDebugLoop.selectStrategy(
                iteration - 2,
                [],
              );
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

              if (debugStrategy !== "escalate") {
                this.llmFixerRunCount++;
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

          this.ephemeralHints.push(recoveryPrompt + debugSuffix);
        }

        // CausalChainResolver: root cause analysis for code-related errors
        if (this.failureSigMemory && projectPath) {
          try {
            const resolver = new CausalChainResolver(this.failureSigMemory);
            const causal = await resolver.resolve(
              errorSummary,
              this.changedFiles,
              projectPath,
            );
            if (causal && causal.confidence > 0.5) {
              this.ephemeralHints.push(
                `[ROOT_CAUSE] ${causal.suspectedRootCause} (confidence: ${causal.confidence.toFixed(2)})` +
                (causal.affectedFiles.length > 0 ? `\nAffected: ${causal.affectedFiles.join(", ")}` : "") +
                (causal.recommendedStrategy ? `\nStrategy: ${causal.recommendedStrategy}` : "")
              );
            }
          } catch { /* CausalChainResolver failure is non-fatal */ }
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
        if (errorTriggerBudgetRatio <= 0.85) {
          // SkillLearner: 학습된 스킬 중 현재 에러에 매칭되는 것 주입
          if (this.skillLearner && this.activeSkillIds.length < AgentLoop.MAX_ACTIVE_SKILLS) {
            try {
              const relevantSkills = this.skillLearner.getRelevantSkills({
                errorMessage: errorSummary,
                language: undefined,
              });
              for (const skill of relevantSkills.slice(0, 1)) {
                if (this.activeSkillIds.includes(skill.id)) continue;
                this.ephemeralHints.push(`[Learned Skill: ${skill.id}] Diagnosis: ${skill.diagnosis}\nStrategy: ${skill.strategy}\nTools: ${skill.toolSequence.join(" → ")}`);
                this.activeSkillIds.push(skill.id);
                this.skillLearner.updateConfidence(skill.id, false);
              }
            } catch {
              /* non-fatal */
            }
          }

          // Plugin trigger matching — match errors/context to plugin skills
          if (
            this.activeSkillIds.length < AgentLoop.MAX_ACTIVE_SKILLS
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
                  this.ephemeralHints.push(`[Plugin Skill: ${bestMatch.pluginId}/${bestMatch.skill.name}]\n${resolved}`);
                  this.activeSkillIds.push(bestMatch.skill.id);
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
        } catch { /* non-fatal */ }
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
        } catch { /* non-fatal */ }
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
      this.flushEphemeralHints();

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

    const allTools = [...this.config.loop.tools, ...this.mcpToolDefinitions, SPAWN_SUB_AGENT_TOOL];
    const stream = this.llmClient.chatStream(
      messages,
      allTools,
      this.abortSignal ?? undefined,
    );

    // 텍스트 버퍼링 — 1토큰씩 emit하지 않고 청크 단위로 모아서 emit
    let textBuffer = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const FLUSH_INTERVAL_MS = 20;        // 20ms마다 flush (faster first-token display)
    const FLUSH_SIZE_THRESHOLD = 15;     // 15자 이상이면 즉시 flush
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
    const allDefinitions = [...this.config.loop.tools, ...this.mcpToolDefinitions, SPAWN_SUB_AGENT_TOOL];
    const matchedDefinition = allDefinitions.find((t) => t.name === toolCall.name);

    // Security gate — deterministic pattern check (shell injection, credential leaks, etc.)
    {
      const secResult = securityCheck(toolCall.name, args as Record<string, unknown>);
      if (secResult.verdict === "BLOCK") {
        this.ephemeralHints.push(`[SECURITY] Blocked: ${secResult.reason}`);
        // Log security block event to .yuan/logs/security-events.jsonl (non-fatal)
        try {
          const { mkdirSync, appendFileSync } = await import("node:fs");
          const logDir = pathJoin(this.config.loop.projectPath, ".yuan", "logs");
          mkdirSync(logDir, { recursive: true });
          const logPath = pathJoin(logDir, "security-events.jsonl");
          appendFileSync(logPath, JSON.stringify({
            tool: toolCall.name,
            verdict: "BLOCK",
            reason: secResult.reason,
            pattern: secResult.pattern,
            timestamp: Date.now(),
          }) + "\n");
        } catch { /* non-fatal */ }
        const blockResult: ToolResult = {
          tool_call_id: toolCall.id,
          name: toolCall.name,
          output: `[SECURITY_BLOCKED] ${secResult.reason}. This operation is not allowed.`,
          success: false,
          durationMs: 0,
        };
        return { result: blockResult, deferredFixPrompt: null };
      }
      if (secResult.verdict === "WARN") {
        this.ephemeralHints.push(`[SECURITY WARNING] ${secResult.reason} — proceeding with caution`);
      }
    }

    // Workspace Mutation Policy — path-level safety zones (after security gate)
    if (this.mutationPolicy && (toolCall.name === "file_edit" || toolCall.name === "file_write")) {
      const filePath = String((args as Record<string, unknown>).path ?? (args as Record<string, unknown>).file_path ?? "");
      const mutation = this.mutationPolicy.check(filePath);
      if (!mutation.allowed) {
        return {
          result: {
            tool_call_id: toolCall.id,
            name: toolCall.name,
            output: `[MUTATION_BLOCKED] ${mutation.reason}`,
            success: false,
            durationMs: 0,
          },
          deferredFixPrompt: null,
        };
      }
      if (mutation.requiresApproval) {
        this.ephemeralHints.push(`[MUTATION] ${filePath} is in ${mutation.zone} zone — approval recommended`);
      }
    }

    // Judgment rules — deterministic rule-based tool approval (loaded from .yuan/judgment-rules.json)
    if (this.judgmentRegistry) {
      const judgment = this.judgmentRegistry.evaluate(toolCall.name, args as Record<string, unknown>);
      if (judgment.action === "BLOCK") {
        const judgmentResult: ToolResult = {
          tool_call_id: toolCall.id,
          name: toolCall.name,
          output: `[JUDGMENT_BLOCKED] ${judgment.reason}`,
          success: false,
          durationMs: 0,
        };
        return { result: judgmentResult, deferredFixPrompt: null };
      }
      if (judgment.action === "WARN") {
        this.ephemeralHints.push(`[JUDGMENT] ${judgment.reason}`);
      }
      if (judgment.action === "REQUIRE_APPROVAL") {
        this.ephemeralHints.push(`[JUDGMENT] ${judgment.reason} — approval recommended`);
      }
    }

    // ToolGate enforcement — block tools based on Decision Engine gate level
    {
      const gate = this.decision.core.toolGate;
      if (gate.blockedTools.includes(toolCall.name)) {
        const gateResult: ToolResult = {
          tool_call_id: toolCall.id,
          name: toolCall.name,
          output: `[TOOL_GATE] ${toolCall.name} is blocked in ${gate.level} mode.`,
          success: false,
          durationMs: 0,
        };
        return { result: gateResult, deferredFixPrompt: null };
      }
    }

    {
      const vetoFlags = this.decision.core.vetoFlags;

      // editVetoed → block file_edit/file_write tools
      if (vetoFlags.editVetoed && (toolCall.name === "file_edit" || toolCall.name === "file_write")) {
        const vetoResult: ToolResult = {
          tool_call_id: toolCall.id,
          name: toolCall.name,
          output: "[Decision Engine] Edit vetoed: patch risk is too high without a plan. Please create a plan first or ask the user for clarification.",
          success: false,
          durationMs: 0,
        };
        return { result: vetoResult, deferredFixPrompt: null };
      }
    }

    // Pre-edit quality gate: remind LLM to verify before writing
    {
      const cq = this.decision.core.codeQuality;
      if (cq.preEditVerify && (toolCall.name === "file_edit" || toolCall.name === "file_write")) {
        if (this.toolUsageCounter.edits === 0) {
          this.ephemeralHints.push(
            `[Code Quality] This is a ${cq.codeTaskType} task. ` +
            `Primary risk: ${cq.primaryRisk}. ` +
            `Verify your change is complete and correct before proceeding to the next file.`,
          );
        }
      }
    }

    // Dependency guard — detect package installs and manifest changes
    {
      const depResult = checkDependencyChange(toolCall.name, args as Record<string, unknown>);
      if (depResult.isDependencyChange) {
        this.ephemeralHints.push(`[DEP CHANGE] ${depResult.reason}. Verify after: ${depResult.verifyAfter}`);

        if (depResult.requiresApproval) {
          this.ephemeralHints.push(`[DEP APPROVAL] Dependency change requires careful review. Budget multiplier: ${depResult.budgetMultiplier}x`);
        }

        if (depResult.kind) {
          const depFilePath = String((args as Record<string, unknown>).path ?? (args as Record<string, unknown>).file_path ?? (args as Record<string, unknown>).command ?? "");
          this.emitEvent({
            kind: "agent:dependency_change_detected",
            depKind: depResult.kind,
            path: depFilePath.slice(0, 200),
            requiresApproval: depResult.requiresApproval,
          });
        }
      }
    }

    {
      const budget = this.decision.core.toolBudget;
      const counter = this.toolUsageCounter;
      const toolName = toolCall.name;

      if (toolName === "file_read") counter.reads++;
      else if (toolName === "file_edit" || toolName === "file_write") {
        counter.edits++;
        const filePath = String((args as Record<string, unknown>).path ?? (args as Record<string, unknown>).file ?? "");
        if (filePath) {
          const prev = counter.sameFileEdits.get(filePath) ?? 0;
          counter.sameFileEdits.set(filePath, prev + 1);
          if (prev + 1 > budget.maxSameFileEdits) {
            this.emitEvent({
              kind: "agent:budget_warning",
              tool: toolName,
              used: prev + 1,
              limit: budget.maxSameFileEdits,
            });
            this.contextManager.addMessage({
              role: "system",
              content: `[Budget Warning] Same-file edit limit approaching for ${filePath} (${prev + 1}/${budget.maxSameFileEdits}). Consider a different approach.`,
            });
          }
        }
      } else if (toolName === "shell_exec" || toolName === "bash") {
        counter.shells++;
        const cmd = String((args as Record<string, unknown>).command ?? "").toLowerCase();
        if (/\b(test|jest|vitest|mocha|pytest|cargo test|go test)\b/.test(cmd)) {
          counter.tests++;
        }

        // CommandPlanCompiler — validate LLM-proposed shell commands against deterministic compiled plan
        const rawCmd = String((args as Record<string, unknown>).command ?? "");
        const classified = classifyCommand(rawCmd);
        if (classified.purpose && this.config.loop.projectPath) {
          const compilerInput: CommandCompilerInput = {
            verifyDepth: this.decision.core.verifyDepth,
            packageManager: this.worldState?.deps?.packageManager ?? "npm",
            testFramework: "unknown",
            buildTool: "tsc",
            hasStrictMode: false,
            monorepo: false,
          };
          let compiled;
          if (classified.purpose === "verify") compiled = compileVerifyCommands(compilerInput);
          else if (classified.purpose === "build") compiled = compileVerifyCommands({ ...compilerInput, verifyDepth: "thorough" });
          else compiled = null;

          if (compiled && compiled.commands.length > 0) {
            const validation = validateProposedCommand(rawCmd, compiled);
            if (validation.recommendation === "use_compiled") {
              this.ephemeralHints.push(`[CMD_PLAN] Command mismatch: ${validation.deviation}. Compiled: ${compiled.commands[0]}`);
            } else if (validation.recommendation === "warn") {
              this.ephemeralHints.push(`[CMD_PLAN] Note: ${validation.deviation ?? "Minor deviation from compiled command"}`);
            }
          }
        }
      }
      else if (toolName === "grep" || toolName === "glob" || toolName === "file_search") counter.searches++;
      else if (toolName === "web_search" || toolName === "parallel_web_search") counter.webLookups++;
      else if (toolName === "test_run" || toolName === "run_tests") counter.tests++;

      const checks: Array<{ name: string; used: number; limit: number }> = [
        { name: "file_read", used: counter.reads, limit: budget.maxFileReads },
        { name: "file_edit", used: counter.edits, limit: budget.maxEdits },
        { name: "shell_exec", used: counter.shells, limit: budget.maxShellExecs },
        { name: "search", used: counter.searches, limit: budget.maxSearches },
        { name: "web_lookup", used: counter.webLookups, limit: budget.maxWebLookups },
        { name: "test_run", used: counter.tests, limit: budget.maxTestRuns },
      ];

      for (const check of checks) {
        if (check.limit <= 0) continue;
        const ratio = check.used / check.limit;

        if (ratio >= 1.0) {
          this.emitEvent({ kind: "agent:budget_exceeded", tool: check.name });
          const budgetResult: ToolResult = {
            tool_call_id: toolCall.id,
            name: toolCall.name,
            output: `[Decision Engine] Tool budget exceeded for ${check.name} (${check.used}/${check.limit}). Try a different approach or wrap up.`,
            success: false,
            durationMs: 0,
          };
          return { result: budgetResult, deferredFixPrompt: null };
        }

        if (ratio >= 0.8) {
          this.emitEvent({
            kind: "agent:budget_warning",
            tool: check.name,
            used: check.used,
            limit: check.limit,
          });
          if (this.iterationSystemMsgCount < 5) {
            this.contextManager.addMessage({
              role: "system",
              content: `[Budget Warning] ${check.name} usage at ${Math.round(ratio * 100)}% (${check.used}/${check.limit}). Consider wrapping up or using fewer ${check.name} calls.`,
            });
            this.iterationSystemMsgCount++;
          }
        }
      }
    }

    try {
      this.governor.validateToolCall(toolCall);
    } catch (err) {
      if (err instanceof ApprovalRequiredError) {
        const approvalResult = await this.handleApproval(toolCall, args, err);
        if (approvalResult) {
          return { result: approvalResult, deferredFixPrompt: null };
        }
        // Approved — continue execution
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

    const approvalRequest = this.approvalManager.checkApproval(toolCall.name, args);
    if (approvalRequest) {
      const approvalResult = await this.handleApprovalRequest(toolCall, approvalRequest);
      if (approvalResult) {
        return { result: approvalResult, deferredFixPrompt: null };
      }
    }

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

    if (toolCall.name === "spawn_sub_agent") {
      const subAgentResult = await this.executeSpawnSubAgent(toolCall, args);
      return { result: subAgentResult, deferredFixPrompt: null };
    }

    if (this.mcpClient && this.isMCPTool(toolCall.name)) {
      // Emit tool_start before execution (required for trace, QA pipeline, replay)
      this.emitEvent({
        kind: "agent:tool_start",
        tool: toolCall.name,
        input: args,
        source: "mcp",
      });
      const mcpResult = await this.executeMCPTool(toolCall);
      const normalizedOutput = this.normalizeMcpResult(toolCall.name, mcpResult.output);
      const finalResult: ToolResult = { ...mcpResult, output: normalizedOutput };
      this.emitEvent({
        kind: "agent:tool_result",
        tool: toolCall.name,
        output:
          finalResult.output.length > 200
            ? finalResult.output.slice(0, 200) + "..."
            : finalResult.output,
        durationMs: finalResult.durationMs,
      });
      this.emitEvent({ kind: "agent:reasoning_delta", text: `tool finished: ${toolCall.name}` });
      return { result: finalResult, deferredFixPrompt: null };
    }

    // Pre-write validator — quality gate before actual file write (after all gates)
    if ((toolCall.name === "file_edit" || toolCall.name === "file_write") && this.decision.core.codeQuality.strictMode) {
      const filePath = String((args as Record<string, unknown>).path ?? (args as Record<string, unknown>).file_path ?? "");
      const content = String((args as Record<string, unknown>).content ?? (args as Record<string, unknown>).new_string ?? "");
      if (content) {
        const fileRole = detectFileRole(filePath);
        const validation = validateBeforeWrite(content, { path: filePath, fileRole, changedHunksOnly: true });
        if (!validation.valid) {
          this.ephemeralHints.push(`[QUALITY_BLOCK] ${validation.blockedReason}: ${validation.issues.filter(i => i.severity === "error").map(i => i.message).join("; ")}`);
          // Record weakness patterns for learning
          if (this.weaknessTracker) {
            for (const issue of validation.issues.filter(i => i.severity === "error")) {
              const pattern = issue.message.includes("TODO") ? "todo_in_code"
                : issue.message.includes("empty function") ? "empty_function_body"
                : issue.message.includes("any") ? "any_type_usage"
                : issue.message.includes("console") ? "console_log_leak"
                : issue.message.includes("stub") ? "stub_implementation"
                : "unknown_quality_issue";
              this.weaknessTracker.record(pattern, `CRITICAL: ${issue.message}. Fix this BEFORE writing.`);
            }
          }
          return {
            result: {
              tool_call_id: toolCall.id,
              name: toolCall.name,
              output: `[QUALITY_BLOCKED] ${validation.blockedReason}. Fix these issues and try again.`,
              success: false,
              durationMs: 0,
            },
            deferredFixPrompt: null,
          };
        }
        if (validation.issues.length > 0) {
          this.ephemeralHints.push(`[QUALITY_WARN] ${validation.issues.map(i => i.message).join("; ")}`);
        }
      }
    }

    const startTime = Date.now();
    const toolAbort = new AbortController();
    this.interruptManager.registerToolAbort(toolAbort);
    if (["file_write", "file_edit"].includes(toolCall.name)) {
      const candidatePath =
        (args as Record<string, unknown>).path ??
        (args as Record<string, unknown>).file;
      if (candidatePath) {
        const filePathStr = String(candidatePath);
        // Record before snapshot in patch journal for atomic rollback
        if (this.patchJournal) {
          this.patchJournal.recordBefore(toolCall.name, filePathStr);
        }
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
    const isSearchTool = toolCall.name === "web_search" || toolCall.name === "parallel_web_search";
    if (isSearchTool) {
      const searchArgs = typeof toolCall.arguments === "string"
        ? (() => { try { return JSON.parse(toolCall.arguments) as Record<string, unknown>; } catch { return {}; } })()
        : (toolCall.arguments as Record<string, unknown>) ?? {};
      const queries: string[] = toolCall.name === "parallel_web_search"
        ? (Array.isArray(searchArgs.queries) ? searchArgs.queries as string[] : [])
        : (typeof searchArgs.query === "string" ? [searchArgs.query] : []);
      if (queries.length > 0) {
        this.emitEvent({ kind: "agent:search_start", queries });
      }
    }

    try {
      const result = await this.toolExecutor.execute(toolCall, toolAbort?.signal);
      this.interruptManager.clearToolAbort();

      if (isSearchTool && result.success) {
        const searchArgs = typeof toolCall.arguments === "string"
          ? (() => { try { return JSON.parse(toolCall.arguments) as Record<string, unknown>; } catch { return {}; } })()
          : (toolCall.arguments as Record<string, unknown>) ?? {};
        const query = toolCall.name === "parallel_web_search"
          ? `${(Array.isArray(searchArgs.queries) ? searchArgs.queries as string[] : []).length} queries`
          : (typeof searchArgs.query === "string" ? searchArgs.query : "");
        const sourceMatch = result.output.match(/\(via ([^)]+)\)/);
        this.emitEvent({
          kind: "agent:search_result",
          query,
          source: sourceMatch?.[1] ?? "web",
          resultCount: (result.output.match(/^\d+\./gm) ?? []).length,
        });
      }

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
      this.reasoningTree.add("tool", `success: ${toolCall.name}`);

      if (["file_write", "file_edit"].includes(toolCall.name) && result.success) {
        if (this.taskPhase === "explore") {
          this.transitionPhase("implement", `first write: ${toolCall.name}`);
        }
        const filePath =
          (args as Record<string, unknown>).path ??
          (args as Record<string, unknown>).file ??
          "unknown";
        const filePathStr = String(filePath);
        if (!this.changedFiles.includes(filePathStr)) {
          this.changedFiles.push(filePathStr);
          if (this.changedFiles.length > BOUNDS.changedFiles) {
            this.changedFiles = this.changedFiles.slice(-BOUNDS.changedFiles);
          }
        }
        if (!this.iterationWriteToolPaths.includes(filePathStr)) {
          this.iterationWriteToolPaths.push(filePathStr);
        }
        if (filePathStr.match(/\.[cm]?tsx?$/) && !this.iterationTsFilesModified.includes(filePathStr)) {
          this.iterationTsFilesModified.push(filePathStr);
        }
        this.emitEvent({ kind: "agent:file_change", path: filePathStr, diff: result.output });
        this.emitEvidenceReport(
          filePathStr,
          toolCall.name as "file_write" | "file_edit",
        ).catch(() => {/* non-fatal */});

        // SemanticDiffReviewer — classify change meaning and recommend verification depth
        if (this.originalSnapshots.has(filePathStr)) {
          try {
            const { readFile } = await import("node:fs/promises");
            const newContent = await readFile(filePathStr, "utf-8");
            const oldContent = this.originalSnapshots.get(filePathStr) ?? "";
            const review = reviewFileDiff({
              path: filePathStr,
              oldContent,
              newContent,
              language: filePathStr.match(/\.[cm]?tsx?$/) ? "typescript" : undefined,
            });
            if (review.recommendedRiskBoost > 0) {
              this.ephemeralHints.push(
                `[SEMANTIC_DIFF] ${filePathStr}: ${review.changes.join(", ")} — risk +${review.recommendedRiskBoost.toFixed(2)}, recommend verify=${review.recommendedVerifyDepth}`,
              );
            }
          } catch { /* non-fatal — file may have been deleted */ }
        }

        if (this.config.loop.projectPath) {
          const wsProjectPath = this.config.loop.projectPath;
          new WorldStateCollector({ projectPath: wsProjectPath, skipTest: true })
            .collect()
            .then((snapshot) => { this.worldState = snapshot; })
            .catch(() => {});
        }
        if (this.impactAnalyzer) {
          this.analyzeFileImpact(filePathStr).catch(() => {});
        }

        // Auto-create rollback point based on Decision failureSurface
        if (this.patchJournal && this.patchJournal.shouldCreateRollbackPoint(
          this.decision.core.failureSurface.patchRisk,
          this.changedFiles.length,
        )) {
          const point = this.patchJournal.createRollbackPoint(
            `patchRisk=${this.decision.core.failureSurface.patchRisk}, files=${this.changedFiles.length}`,
          );
          this.emitEvent({
            kind: "agent:rollback_point_created",
            pointId: point.id,
            reason: point.reason,
          });
        }

        // Patch scope tracking (after successful file mutation)
        if (this.patchScopeController) {
          const content = String((args as Record<string, unknown>).content ?? (args as Record<string, unknown>).new_string ?? "");
          const isProtected = this.mutationPolicy?.check(filePathStr).zone === "PROTECTED" || this.mutationPolicy?.check(filePathStr).zone === "CAUTION";
          this.patchScopeController.recordChange(filePathStr, content.split("\n").length, 0, isProtected ?? false);

          const scopeCheck = this.patchScopeController.check();
          if (!scopeCheck.allowed) {
            this.ephemeralHints.push(`[SCOPE_LIMIT] ${scopeCheck.reason}. Consider splitting into smaller tasks or requesting plan escalation.`);
          }
        }
      }

      // Verifier rules — deterministic check of tool output for success/failure patterns
      {
        const verification = verifyToolResult(toolCall.name, args as Record<string, unknown>, result.output, result.success);
        if (verification.verdict === "FAIL") {
          this.ephemeralHints.push(`[VERIFY FAIL] ${verification.reason}. Suggested: ${verification.suggestedAction}`);
        }
        if (verification.verdict === "WARN") {
          this.ephemeralHints.push(`[VERIFY WARN] ${verification.reason}`);
        }
      }

      if (this.stateUpdater && result.success) {
        this.stateUpdater.applyToolResult(
          toolCall.name,
          args as Record<string, unknown>,
          result,
        ).catch(() => {/* non-blocking */});
      }

      const editedFilePath = (args as Record<string, unknown>)?.path as string
        ?? (args as Record<string, unknown>)?.file_path as string
        ?? undefined;
      const fixPrompt = await this.validateAndFeedback(toolCall.name, result, editedFilePath);
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
    //   • Write tools                      → run sequentially (wave 99)
    //   • shell_exec / git_ops / etc.     → always sequential (side-effects)

    const READ_ONLY = new Set(['file_read', 'grep', 'glob', 'code_search', 'security_scan']);
    const WRITE_TOOLS = new Set(['file_write', 'file_edit']);

    // Separate reads, writes, and heavy side-effect tools
    const writeToolCalls = toolCalls.filter((tc) => WRITE_TOOLS.has(tc.name));

    // ─── Step 2: Dependency-aware write tool batching ────────────────────────
    // Map each write tool call to a "wave index" (0 = can run first, 1 = needs wave-0 done, etc.)
    const writeBatchMap = new Map<string, number>(); // tc.id → wave index

    // DependencyAnalyzer removed: it scanned the entire filesystem (50-1000ms blocking).
    // Write tools run sequentially (wave 0) — no dependency analysis overhead.
    // writeBatchMap stays empty → all writes default to wave 99 (sequential).

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
   * Execute spawn_sub_agent tool — creates a SubAgent, runs it, returns result.
   * The sub-agent inherits the parent's LLM config (provider, model, apiKey).
   */
  private async executeSpawnSubAgent(
    toolCall: ToolCall,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const startTime = Date.now();
    const goal = String(args.goal ?? "");
    const roleInput = typeof args.role === "string" ? args.role : "coder";
    const role = mapToSubAgentRole(roleInput);

    if (!goal) {
      return {
        tool_call_id: toolCall.id,
        name: toolCall.name,
        output: "Error: 'goal' parameter is required for spawn_sub_agent.",
        success: false,
        durationMs: Date.now() - startTime,
      };
    }

    // Emit tool_start
    this.emitEvent({
      kind: "agent:tool_start",
      tool: toolCall.name,
      input: args,
      source: "builtin",
    });

    const taskId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const projectPath = this.config.loop.projectPath || process.cwd();

    try {
      const subAgent = new SubAgent({
        taskId,
        goal,
        targetFiles: [],  // sub-agent discovers files via tools
        readFiles: [],
        maxIterations: Math.min(this.config.loop.maxIterations, 15),
        projectPath,
        byokConfig: this.config.byok,
        tools: this.config.loop.tools.map((t) => t.name),
        createToolExecutor: (_workDir, _enabledTools) => this.toolExecutor,
        role,
      });

      // Forward sub-agent events as bg_update for TUI visibility
      subAgent.on("subagent:phase", (tid: string, phase: string) => {
        this.emitEvent({
          kind: "agent:bg_update",
          agentId: taskId,
          agentLabel: `sub-agent (${roleInput})`,
          eventType: "info",
          message: `Phase: ${phase}`,
          timestamp: Date.now(),
        });
      });

      subAgent.on("event", (event: import("./types.js").AgentEvent) => {
        // Re-emit sub-agent text/thinking for observability
        if (event.kind === "agent:text_delta") {
          this.emitEvent({
            kind: "agent:bg_update",
            agentId: taskId,
            agentLabel: `sub-agent (${roleInput})`,
            eventType: "info",
            message: String(event.text ?? ""),
            timestamp: Date.now(),
          });
        } else if (event.kind === "agent:thinking") {
          this.emitEvent({
            kind: "agent:bg_update",
            agentId: taskId,
            agentLabel: `sub-agent (${roleInput})`,
            eventType: "info",
            message: String(event.content ?? ""),
            timestamp: Date.now(),
          });
        }
      });

      // Build DAG context for the sub-agent
      const dagContext: DAGContextLike = {
        overallGoal: goal,
        totalTasks: 1,
        completedTasks: [],
        runningTasks: [taskId],
      };

      // Run sub-agent
      const result: SubAgentResult = await subAgent.run(dagContext);

      // Build output summary
      const changedFilesList = result.changedFiles.length > 0
        ? result.changedFiles.map((f) => f.path).join(", ")
        : "none";
      const output = [
        `## Sub-Agent Result (${roleInput})`,
        `- Task ID: ${taskId}`,
        `- Success: ${result.success}`,
        `- Iterations: ${result.iterations}`,
        `- Tokens: input=${result.tokensUsed.input}, output=${result.tokensUsed.output}`,
        `- Changed files: ${changedFilesList}`,
        ``,
        `### Summary`,
        result.summary,
        result.error ? `\n### Error\n${result.error}` : "",
      ].join("\n");

      this.emitEvent({
        kind: "agent:tool_result",
        tool: toolCall.name,
        output: output.length > 200 ? output.slice(0, 200) + "..." : output,
        durationMs: Date.now() - startTime,
      });

      return {
        tool_call_id: toolCall.id,
        name: toolCall.name,
        output,
        success: result.success,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      this.emitEvent({
        kind: "agent:bg_update",
        agentId: taskId,
        agentLabel: `sub-agent (${roleInput})`,
        eventType: "error",
        message: `Sub-agent failed: ${errorMsg}`,
        timestamp: Date.now(),
      });

      return {
        tool_call_id: toolCall.id,
        name: toolCall.name,
        output: `Sub-agent error: ${errorMsg}`,
        success: false,
        durationMs: Date.now() - startTime,
      };
    }
  }

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
    filePath?: string,
  ): Promise<string | null> {
    if (!["file_write", "file_edit", "shell_exec"].includes(toolName)) {
      return null;
    }

    const validation = await this.autoFixLoop.validateResult(
      toolName,
      result.output,
      result.success,
      this.config.loop.projectPath,
      filePath,
    );

    if (validation.passed) {
      this.autoFixLoop.resetAttempts();
      return null;
    }

    if (!this.autoFixLoop.canRetry()) {
      const failMsg = validation.failures
        .map((f) => `[${f.type}] ${f.message}`)
        .join("; ");
      this.emitEvent({
        kind: "agent:thinking",
        content: `Auto-fix exhausted (${this.autoFixLoop.getAttempts().length} attempts): ${failMsg}`,
      });
      this.autoFixLoop.resetAttempts();
      return `[LINT VALIDATION FAILED after 3 auto-fix attempts — SKIP lint for this file and continue with the main task. Do NOT retry fixing lint errors. Move on to the next step.]\nFailures: ${failMsg}`;
    }

    const errorMsg = validation.failures
      .map((f) => `[${f.type}] ${f.message}\n${f.rawOutput}`)
      .join("\n\n");

    const fixPrompt = this.autoFixLoop.buildFixPrompt(
      errorMsg,
      `After ${toolName} execution on project at ${this.config.loop.projectPath}`,
    );

    this.autoFixLoop.recordAttempt(
      errorMsg,
      "Requesting LLM fix",
      false,
      0,
    );

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
    } catch { /* non-fatal */ }
  }

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

    this.ephemeralHints.push(lines.join("\n"));
  }

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

  private async getOrComputeImpact(
    files: string[],
  ): Promise<import("./impact-analyzer.js").ImpactReport | null> {
    if (!this.impactAnalyzer || files.length === 0) return null;
    const key = [...files].sort().join("|");
    if (key === this.lastImpactFilesKey && this.lastImpactReport) {
      return this.lastImpactReport;
    }
    try {
      const report = await this.impactAnalyzer.analyzeChanges(files);
      this.lastImpactFilesKey = key;
      this.lastImpactReport = report;
      return report;
    } catch {
      return null;
    }
  }

  /**
   * 파일 변경 후 영향 분석을 실행하고 결과를 컨텍스트에 주입.
   * 고위험 변경이면 경고를 emit.
   */
  private async analyzeFileImpact(filePath: string): Promise<void> {
    if (!this.impactAnalyzer) return;

    const report = await this.getOrComputeImpact([filePath]);
    if (!report) return;

    if (report.riskLevel === "high" || report.riskLevel === "critical") {
      this.emitEvent({
        kind: "agent:thinking",
        content: `Impact analysis: ${report.riskLevel} risk. ${report.affectedFiles.length} affected files, ${report.breakingChanges.length} breaking changes.`,
      });

      const impactPrompt = this.impactAnalyzer.formatForPrompt(report);
      this.ephemeralHints.push(impactPrompt);
    }
  }
  /**
   * 다중 파일 변경이 누적된 경우 aggregate impact를 1회만 컨텍스트에 주입한다.
   * 무거운 분석이므로 complex/massive 태스크에서만 사용.
   */
  private async maybeInjectAggregateImpactHint(): Promise<void> {
    if (!this.impactAnalyzer || this.changedFiles.length < 2) return;

    const report = await this.getOrComputeImpact(this.changedFiles);
    if (!report) return;

    try {
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

      this.ephemeralHints.push(hintLines.join("\n"));

      this.impactHintInjected = true;

      this.emitEvent({
        kind: "agent:thinking",
        content:
          `Aggregate impact hint injected: ${report.riskLevel} risk, ` +
          `${report.breakingChanges.length} breaking changes, ` +
          `${report.deadCodeCandidates.length} dead code candidates.`,
      });
    } catch { /* non-fatal */ }
  }

  private async buildFinalImpactSummary(): Promise<string | null> {
    if (!this.impactAnalyzer || this.changedFiles.length === 0) return null;

    try {
      const report = await this.getOrComputeImpact(this.changedFiles);
      if (!report) return null;

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

  private normalizeMcpResult(toolName: string, output: string): string {
    const isSearch = /search/i.test(toolName);
    if (!isSearch) return output;

    // If already valid JSON, leave as-is
    try {
      JSON.parse(output);
      return output;
    } catch {
      // Not JSON — wrap plain-text lines into structured objects
    }

    const lines = output
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) return output;

    const structured = lines.map((line) => {
      // Attempt to extract a URL from the line
      const urlMatch = line.match(/https?:\/\/\S+/);
      return {
        title: "",
        url: urlMatch ? urlMatch[0] : "",
        snippet: line,
        source: toolName,
      };
    });

    return JSON.stringify(structured, null, 2);
  }

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
    this.traceRecorder?.stop();
  }
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
    // Trace recording — fire-and-forget, never blocks
    this.traceRecorder?.record(event);
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
    // Route subagent events to task panel via proper events
    if (phase === "start") {
      this.emitEvent({ kind: "agent:subagent_phase", taskId: name, phase: content });
    } else {
      this.emitEvent({ kind: "agent:subagent_done", taskId: name, success: !content.includes("failed") });
    }
  }
  private handleFatalError(err: unknown): AgentTermination {
    const message = err instanceof Error ? err.message : String(err);
  if (this.sessionPersistence && this.sessionId) {
    void this.sessionPersistence.updateStatus(this.sessionId, "crashed");
  }
    dlog("AGENT-LOOP", `run() terminating`, { reason: "ERROR", tokensUsed: this.tokenUsage.total, iterations: this.iterationCount });
    this.emitEvent({
      kind: "agent:error",
      message,
      retryable: false,
    });

    return { reason: "ERROR", error: message };
  }


  private transitionPhase(to: TaskPhase, trigger: string): void {
    if (this.taskPhase === to) return;
    const from = this.taskPhase;
    this.taskPhase = to;
    this.emitEvent({
      kind: "agent:phase_transition",
      from,
      to,
      iteration: this.iterationCount,
      trigger,
    });
  }

  private async runCheapChecks(): Promise<boolean> {
    const projectPath = this.config.loop.projectPath;

    // 1. Diff size check — if nothing changed, skip
    if (this.changedFiles.length === 0) return true;

    // 2. File existence check — all changedFiles should exist
    const { existsSync } = await import("node:fs");
    for (const f of this.changedFiles) {
      const abs = projectPath ? `${projectPath}/${f}` : f;
      if (f.startsWith("/") ? !existsSync(f) : !existsSync(abs)) {
        // cheap check: file missing — stay in verify
        return false;
      }
    }

    // 3. Fast syntax check — tsc --noEmit --skipLibCheck only on changed TS files
    const tsFiles = this.changedFiles.filter(f => /\.[cm]?tsx?$/.test(f));
    if (tsFiles.length > 0 && projectPath) {
      try {
        const result = await this.toolExecutor.execute({
          id: `cheap-tsc-${Date.now()}`,
          name: "shell_exec",
          arguments: JSON.stringify({
            command: `npx tsc --noEmit --skipLibCheck 2>&1 | head -20 || true`,
            cwd: projectPath,
            timeout: 30000,
          }),
        });
        if (result.success && result.output) {
          const hasErrors = result.output.includes(": error TS");
          if (hasErrors) {
            // cheap check: tsc errors found — staying in verify
            // Inject TS errors so LLM sees them and fixes them
            const truncated = result.output.length > 1000
              ? result.output.slice(0, 1000) + "\n[truncated]"
              : result.output;
            this.ephemeralHints.push(`[Verify Phase] TypeScript errors found:\n\`\`\`\n${truncated}\n\`\`\`\nPlease fix before completion.`);
            return false;
          }
        }
      } catch {
        // cheap check failure is non-fatal — allow finalize
      }
    }

    return true;
  }

  private async emitEvidenceReport(
    filePath: string,
    tool: "file_write" | "file_edit",
  ): Promise<void> {
    const timestamp = Date.now();
    const projectPath = this.config.loop.projectPath;

    // 1. Diff stats via git diff --stat
    let diffStats: { added: number; removed: number } | null = null;
    try {
      const diffResult = await this.toolExecutor.execute({
        id: `evidence-diff-${timestamp}`,
        name: "shell_exec",
        arguments: JSON.stringify({
          command: `git diff --numstat HEAD -- "${filePath}" 2>/dev/null || echo "0\t0\t${filePath}"`,
          cwd: projectPath ?? ".",
          timeout: 5000,
        }),
      });
      if (diffResult.success && diffResult.output) {
        const match = diffResult.output.match(/^(\d+)\s+(\d+)/m);
        if (match) {
          diffStats = { added: parseInt(match[1], 10), removed: parseInt(match[2], 10) };
        }
      }
    } catch { /* non-fatal */ }

    const syntax: "ok" | "error" | "skipped" = "skipped";

    this.emitEvent({
      kind: "agent:evidence_report",
      filePath,
      tool,
      syntax,
      diffStats,
      lintResult: "skipped",
      timestamp,
    });

    const isDepsChange = filePath.includes("package.json") || filePath.includes("tsconfig");
    if (isDepsChange && this.archSummarizer) {
      this.archSummarizer.regenerate().catch(() => {/* non-fatal */});
    }
  }
  /**
   * 현재 런타임 상태로 TriggerContext 빌드.
   */
  private buildTriggerContext(): TriggerContext {
    const totalBudget = this.config.loop.totalTokenBudget;
    return {
      changedFiles: this.changedFiles,
      writeCountSinceVerify: this.writeCountSinceVerify,
      failureCount: this.allToolResults.filter(r => !r.success).length,
      repeatedErrorSignature: this.repeatedErrorSignature,
      plannerConfidence: undefined,
      contextUsageRatio: totalBudget > 0 ? this.tokenUsage.total / totalBudget : 0,
      riskyWrite: this.changedFiles.some(f =>
        f.includes("tsconfig") || f.includes("package.json") ||
        f.endsWith("index.ts") || f.endsWith("index.tsx") || f.includes(".d.ts")
      ),
      taskPhase: this.taskPhase,
      iteration: this.iterationCount,
      verifyRanThisIteration: this.verifyRanThisIteration,
      summarizeRanThisIteration: this.summarizeRanThisIteration,
      llmFixerRunCount: this.llmFixerRunCount,
    };
  }

  /**
   * 반복 에러 시그니처 추적 — 같은 에러가 2번 이상 나오면 repeatedErrorSignature 세팅.
   */
  private trackErrorSignature(errorSummary: string): void {
    const sig = errorSummary.slice(0, 120);
    if (sig === this._lastErrorSignature) {
      this._errorSignatureCount++;
      if (this._errorSignatureCount >= 2) {
        this.repeatedErrorSignature = sig;
      }
    } else {
      this._lastErrorSignature = sig;
      this._errorSignatureCount = 1;
      this.repeatedErrorSignature = undefined;
    }
  }

  private static readonly MAX_MESSAGES = 40;
  private static readonly PRUNE_KEEP_RECENT = 10;
  private pruneMessagesIfNeeded(): void {
    const msgs = this.contextManager.getMessages();
    if (msgs.length <= AgentLoop.MAX_MESSAGES) return;

    const system = msgs.filter(m => m.role === "system");
    const nonSystem = msgs.filter(m => m.role !== "system");

    // last N non-system messages 유지
    const keep = nonSystem.slice(-AgentLoop.PRUNE_KEEP_RECENT);
    // pruned 범위에서 task summary 추출 (user 메시지 첫 번째)
    const pruned = nonSystem.slice(0, nonSystem.length - AgentLoop.PRUNE_KEEP_RECENT);
    const userGoals = pruned
      .filter(m => m.role === "user")
      .map(m => typeof m.content === "string" ? m.content.slice(0, 200) : "")
      .filter(Boolean)
      .slice(0, 3);

    const summaryContent = userGoals.length > 0
      ? `[Context pruned — earlier goals: ${userGoals.join(" | ")}]`
      : `[Context pruned — ${pruned.length} older messages removed]`;

    const summary = [{ role: "system" as const, content: summaryContent }];

    // contextManager 재구성 (system + summary + recent)
    this.contextManager.clear();
    for (const m of [...system, ...summary, ...keep]) {
      this.contextManager.addMessage(m);
    }
  }
}

// ─── Phase 4: TrustEconomics helper ─────────────────────────────────────────

function toolNameToActionClass(name: string): ActionClass | null {
  if (name === "file_read") return "file_read";
  if (name === "file_write") return "file_write";
  if (name === "file_edit") return "file_edit";
  if (name === "file_delete") return "file_delete";
  if (name === "shell_exec") return "shell_exec_risky"; // conservative default
  if (name === "git_read" || name === "git_log" || name === "git_blame") return "git_read";
  if (name === "git_commit" || name === "git_push" || name === "git_stash") return "git_write";
  if (name.startsWith("mcp_")) return "mcp_call";
  return null;
}
