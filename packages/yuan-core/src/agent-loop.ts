/**
 * @module agent-loop
 * @description 메인 Agent Loop — LLM ↔ Tool 반복 실행 엔진.
 *
 * while 루프로 LLM 호출 → tool_use 파싱 → tool 실행 → 결과 피드백을 반복.
 * Governor가 반복 제한/안전 검증을 담당하고,
 * ContextManager가 컨텍스트 윈도우를 관리한다.
 */

import { EventEmitter } from "node:events";
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

/** AgentLoop 설정 */
export interface AgentLoopOptions {
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
export class AgentLoop extends EventEmitter {
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
  private readonly policyOverrides?: Partial<ExecutionPolicy>;
  private checkpointSaved = false;
  private iterationCount = 0;
  private originalSnapshots: Map<string, string> = new Map();
  private previousStrategies: import("./failure-recovery.js").RecoveryStrategy[] = [];
  private tokenUsage: TokenUsage = {
    input: 0,
    output: 0,
    reasoning: 0,
    total: 0,
  };

  constructor(options: AgentLoopOptions) {
    super();

    this.config = options.config;
    this.toolExecutor = options.toolExecutor;
    this.enableMemory = options.enableMemory !== false;
    this.enablePlanning = options.enablePlanning !== false;
    this.planningThreshold = options.planningThreshold ?? "moderate";
    this.environment = options.environment;

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

    const projectPath = this.config.loop.projectPath;
    if (!projectPath) return;

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

    // HierarchicalPlanner 생성
    if (this.enablePlanning && projectPath) {
      this.planner = new HierarchicalPlanner({ projectPath });
    }

    // ReflexionEngine 생성
    if (projectPath) {
      this.reflexionEngine = new ReflexionEngine({ projectPath });
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
    const highConfLearnings = memory.learnings.filter((l) => l.confidence >= 0.3);
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
    this.changedFiles = [];
    this.allToolResults = [];
    this.checkpointSaved = false;
    this.iterationCount = 0;
    this.originalSnapshots.clear();
    this.previousStrategies = [];
    this.failureRecovery.reset();
    this.costOptimizer.reset();
    this.tokenBudgetManager.reset();
    const runStartTime = Date.now();

    // 첫 실행 시 메모리/프로젝트 컨텍스트 자동 로드
    await this.init();

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

    this.emitEvent({ kind: "agent:start", goal: userMessage });

    try {
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
      if (classification.confidence >= 0.3) {
        const classificationHint = this.taskClassifier.formatForSystemPrompt(classification);
        this.contextManager.addMessage({
          role: "system",
          content: classificationHint,
        });
      }

      // 복잡도 감지 → 필요 시 자동 플래닝
      await this.maybeCreatePlan(userMessage);

      const result = await this.executeLoop();

      // 실행 완료 후 메모리 자동 업데이트
      await this.updateMemoryAfterRun(userMessage, result, Date.now() - runStartTime);

      return result;
    } catch (err) {
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

      // 에러로 종료된 경우 실패 기록도 추가
      if (result.reason === "ERROR") {
        this.memoryManager.addFailedApproach(
          `Task: ${userGoal.slice(0, 80)}`,
          (result as { error?: string }).error ?? "Unknown error",
        );
      }

      // 메모리 저장
      await this.memoryManager.save();
    } catch {
      // 메모리 저장 실패는 치명적이지 않음
    }

    // Reflexion: 실행 결과 반영 + 전략 추출
    if (this.reflexionEngine) {
      try {
        const entry = this.reflexionEngine.reflect({
          goal: userGoal,
          runId: crypto.randomUUID(),
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

    const complexity = this.detectComplexity(userMessage);

    // 임계값 미만이면 플래닝 스킵
    const thresholdOrder = { simple: 1, moderate: 2, complex: 3 };
    const complexityOrder: Record<string, number> = {
      trivial: 0, simple: 1, moderate: 2, complex: 3, massive: 4,
    };
    if ((complexityOrder[complexity] ?? 0) < thresholdOrder[this.planningThreshold]) {
      return;
    }

    this.emitEvent({
      kind: "agent:thinking",
      content: `Task complexity: ${complexity}. Creating execution plan...`,
    });

    try {
      const plan = await this.planner.createHierarchicalPlan(
        userMessage,
        this.llmClient,
      );

      this.activePlan = plan;
      this.currentTaskIndex = 0;

      // Estimate planner token usage (plan creation typically uses ~500 tokens per task)
      const planTokenEstimate = plan.tactical.length * 500;
      this.tokenBudgetManager.recordUsage("planner", planTokenEstimate, planTokenEstimate);

      // 계획을 컨텍스트에 주입 (LLM이 따라갈 수 있도록)
      const planContext = this.formatPlanForContext(plan);
      this.contextManager.addMessage({
        role: "system",
        content: planContext,
      });

      this.emitEvent({
        kind: "agent:thinking",
        content: `Plan created: ${plan.tactical.length} tasks, ${plan.totalEstimatedIterations} estimated iterations. Risk: ${plan.strategic.riskAssessment.level}.`,
      });
    } catch {
      // 플래닝 실패는 치명적이지 않음 — LLM이 직접 처리하도록 폴백
      this.activePlan = null;
    }
  }

  /**
   * 사용자 메시지에서 태스크 복잡도를 휴리스틱으로 추정.
   * LLM 호출 없이 빠르게 결정 (토큰 절약).
   */
  private detectComplexity(
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
    let iteration = 0;

    while (!this.aborted) {
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

      this.emitEvent({
        kind: "agent:thinking",
        content: `Iteration ${iteration}...`,
      });

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

        if (content) {
          this.contextManager.addMessage({
            role: "assistant",
            content,
          });
        }

        this.emitEvent({
          kind: "agent:completed",
          summary: content || "Task completed.",
          filesChanged: [],
        });

        return {
          reason: "GOAL_ACHIEVED",
          summary: content || "Task completed.",
        };
      }

      // 어시스턴트 메시지 저장 (tool_calls 포함)
      this.contextManager.addMessage({
        role: "assistant",
        content: response.content,
        tool_calls: response.toolCalls,
      });

      if (response.content) {
        this.emitEvent({
          kind: "agent:thinking",
          content: response.content,
        });
      }

      // 4. 도구 실행
      const toolResults = await this.executeTools(response.toolCalls);

      // Reflexion: 도구 결과 수집
      this.allToolResults.push(...toolResults);

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

      // iteration 이벤트
      this.emitEvent({
        kind: "agent:iteration",
        index: iteration,
        tokensUsed: response.usage.input + response.usage.output,
        durationMs: Date.now() - iterationStart,
      });

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
            kind: "agent:thinking",
            content: `Rolled back changes. ${decision.reason}`,
          });
        } else {
          // retry, approach_change, scope_reduce → 복구 프롬프트 주입
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
          this.contextManager.addMessage({
            role: "system",
            content: recoveryPrompt,
          });
        }

        // HierarchicalPlanner 리플래닝도 시도
        if (this.activePlan) {
          await this.attemptReplan(errorSummary);
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
    );

    for await (const chunk of stream) {
      if (this.aborted) break;

      switch (chunk.type) {
        case "text":
          if (chunk.text) {
            content += chunk.text;
            this.emitEvent({
              kind: "agent:text_delta",
              text: chunk.text,
            });
          }
          break;

        case "tool_call":
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
          if (chunk.usage) {
            usage = chunk.usage;
          }
          break;
      }
    }

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
  private async executeTools(
    toolCalls: ToolCall[],
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const toolCall of toolCalls) {
      // Governor: 안전성 검증
      try {
        this.governor.validateToolCall(toolCall);
      } catch (err) {
        if (err instanceof ApprovalRequiredError) {
          // Governor가 위험 감지 → ApprovalManager로 승인 프로세스 위임
          const args = this.parseToolArgs(toolCall.arguments);
          const approvalResult = await this.handleApproval(toolCall, args, err);
          if (approvalResult) {
            results.push(approvalResult);
            continue;
          }
          // 승인됨 → 계속 실행
        } else {
          throw err;
        }
      }

      // ApprovalManager: 추가 승인 체크 (Governor가 못 잡은 규칙)
      const args = this.parseToolArgs(toolCall.arguments);
      const approvalRequest = this.approvalManager.checkApproval(
        toolCall.name,
        args,
      );
      if (approvalRequest) {
        const approvalResult = await this.handleApprovalRequest(
          toolCall,
          approvalRequest,
        );
        if (approvalResult) {
          results.push(approvalResult);
          continue;
        }
        // 승인됨 → 계속 실행
      }

      // MCP 도구 호출 확인
      if (this.mcpClient && this.isMCPTool(toolCall.name)) {
        const mcpResult = await this.executeMCPTool(toolCall);
        results.push(mcpResult);
        this.emitEvent({
          kind: "agent:tool_result",
          tool: toolCall.name,
          output:
            mcpResult.output.length > 200
              ? mcpResult.output.slice(0, 200) + "..."
              : mcpResult.output,
          durationMs: mcpResult.durationMs,
        });
        continue;
      }

      // 도구 실행 — AbortController를 InterruptManager에 등록
      const startTime = Date.now();
      const toolAbort = new AbortController();
      this.interruptManager.registerToolAbort(toolAbort);

      try {
        const result = await this.toolExecutor.execute(toolCall, toolAbort.signal);
        this.interruptManager.clearToolAbort();
        results.push(result);

        this.emitEvent({
          kind: "agent:tool_result",
          tool: toolCall.name,
          output:
            result.output.length > 200
              ? result.output.slice(0, 200) + "..."
              : result.output,
          durationMs: result.durationMs,
        });

        // 파일 변경 이벤트 + 추적
        if (
          ["file_write", "file_edit"].includes(toolCall.name) &&
          result.success
        ) {
          const filePath =
            (args as Record<string, unknown>).path ??
            (args as Record<string, unknown>).file ??
            "unknown";
          const filePathStr = String(filePath);

          // 변경 파일 추적 (메모리 업데이트용)
          if (!this.changedFiles.includes(filePathStr)) {
            this.changedFiles.push(filePathStr);
            // 원본 스냅샷 저장 (rollback용) — 최초 변경 시에만
            if (!this.originalSnapshots.has(filePathStr)) {
              try {
                const { readFile } = await import("node:fs/promises");
                const original = await readFile(filePathStr, "utf-8");
                this.originalSnapshots.set(filePathStr, original);
              } catch {
                // 파일이 새로 생성된 경우 스냅샷 없음
              }
            }
          }

          this.emitEvent({
            kind: "agent:file_change",
            path: filePathStr,
            diff: result.output,
          });

          // ImpactAnalyzer: 변경 영향 분석 (비동기, 실패 무시)
          if (this.impactAnalyzer) {
            this.analyzeFileImpact(filePathStr).catch(() => {});
          }
        }

        // AutoFixLoop: 결과 검증
        await this.validateAndFeedback(toolCall.name, result);
      } catch (err) {
        this.interruptManager.clearToolAbort();
        const durationMs = Date.now() - startTime;

        // AbortError인 경우 (인터럽트로 취소됨)
        if (toolAbort.signal.aborted) {
          results.push({
            tool_call_id: toolCall.id,
            name: toolCall.name,
            output: `[INTERRUPTED] Tool execution was cancelled by user interrupt.`,
            success: false,
            durationMs,
          });

          this.emitEvent({
            kind: "agent:error",
            message: `Tool ${toolCall.name} cancelled by interrupt`,
            retryable: false,
          });

          // soft interrupt: 남은 tool calls 건너뛰고 루프 계속
          // hard interrupt: aborted=true로 루프 종료됨
          break;
        }

        const errorMessage =
          err instanceof Error ? err.message : String(err);

        results.push({
          tool_call_id: toolCall.id,
          name: toolCall.name,
          output: `Error: ${errorMessage}`,
          success: false,
          durationMs,
        });

        this.emitEvent({
          kind: "agent:error",
          message: `Tool ${toolCall.name} failed: ${errorMessage}`,
          retryable: true,
        });
      }
    }

    return results;
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
      id: crypto.randomUUID(),
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
  ): Promise<void> {
    // file_write/file_edit만 검증 (다른 도구는 스킵)
    if (!["file_write", "file_edit"].includes(toolName)) {
      return;
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
      return;
    }

    // 검증 실패 → 에러 피드백
    if (!this.autoFixLoop.canRetry()) {
      // 재시도 한도 초과 → 에러 이벤트만 emit
      this.emitEvent({
        kind: "agent:error",
        message: `Auto-fix exhausted (${this.autoFixLoop.getAttempts().length} attempts): ${validation.failures[0]?.message ?? "Unknown error"}`,
        retryable: false,
      });
      return;
    }

    // 수정 프롬프트 생성 → 대화 히스토리에 user 메시지로 추가
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

    // 피드백을 히스토리에 추가 (다음 LLM 호출에서 수정 시도)
    this.contextManager.addMessage({
      role: "user",
      content: fixPrompt,
    });
  }

  /**
   * 도구 인자를 파싱하는 헬퍼.
   */
  private parseToolArgs(
    args: string | Record<string, unknown>,
  ): Record<string, unknown> {
    if (typeof args === "string") {
      try {
        return JSON.parse(args) as Record<string, unknown>;
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
        sessionId: crypto.randomUUID(),
        goal: this.contextManager.getMessages().find((m) => m.role === "user")?.content as string ?? "",
        progress,
        changedFiles: this.changedFiles.map((path) => ({ path, diff: "" })),
        workingMemory: this.buildWorkingMemorySummary(),
        yuanMdUpdates: [],
        errors: this.allToolResults
          .filter((r) => !r.success)
          .slice(-5)
          .map((r) => `${r.name}: ${r.output.slice(0, 200)}`),
        contextUsageAtSave: this.tokenUsage.total / this.config.loop.totalTokenBudget,
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

  private emitEvent(event: AgentEvent): void {
    this.emit("event", event);
  }

  private handleFatalError(err: unknown): AgentTermination {
    const message = err instanceof Error ? err.message : String(err);

    this.emitEvent({
      kind: "agent:error",
      message,
      retryable: false,
    });

    return { reason: "ERROR", error: message };
  }
}
