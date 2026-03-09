/**
 * @module state-machine
 * @description LangGraph-style Agent State Machine — 에이전트 실행을 위한 유한 상태 기계.
 *
 * 에이전트 실행 흐름을 명시적 phase 전이로 관리한다.
 * analyze → design → plan → implement/parallel → verify → fix/replan → done
 *
 * 각 phase는 독립적인 핸들러로 구현되며, 전이 조건은 핸들러 반환값으로 결정.
 * EventEmitter를 통해 외부에서 phase 진입/퇴장, 전이, 완료 등을 구독할 수 있다.
 */

import { EventEmitter } from "node:events";
import type { ExecutionPlan } from "./types.js";

// ─── Phase Types ───

/** 에이전트 실행 단계 */
export type AgentPhase =
  | "idle"
  | "analyze"
  | "design"
  | "plan"
  | "implement"
  | "parallel"
  | "delegate"
  | "verify"
  | "fix"
  | "replan"
  | "done";

// ─── State & Data Types ───

/** 접근법 옵션 — design phase에서 LLM이 제안하는 구현 방안 */
export interface ApproachOption {
  /** 옵션 ID */
  id: number;
  /** 옵션 이름 */
  name: string;
  /** 설명 */
  description: string;
  /** 장점 */
  pros: string[];
  /** 단점 */
  cons: string[];
  /** 예상 복잡도 */
  estimatedComplexity: "low" | "medium" | "high";
  /** 추천 여부 */
  recommended: boolean;
}

/** 단계 실행 결과 */
export interface StepResult {
  /** 실행된 단계 인덱스 */
  stepIndex: number;
  /** 실행된 phase */
  phase: AgentPhase;
  /** 성공 여부 */
  success: boolean;
  /** 실행 결과 출력 */
  output: string;
  /** 변경된 파일 목록 */
  changedFiles: string[];
  /** 사용된 토큰 수 */
  tokensUsed: number;
  /** 실행 시간 (ms) */
  durationMs: number;
}

/** 단계 실행 에러 */
export interface StepError {
  /** 에러가 발생한 단계 인덱스 */
  stepIndex: number;
  /** 에러가 발생한 phase */
  phase: AgentPhase;
  /** 에러 메시지 */
  error: string;
  /** 복구 가능 여부 */
  recoverable: boolean;
  /** 자동 수정 제안 */
  suggestedFix?: string;
}

/** 검증 결과 — verify phase에서 반환 */
export interface VerifyResult {
  /** 검증 판정 */
  verdict: "pass" | "concern" | "fail";
  /** 개별 검증 항목 */
  checks: {
    buildSuccess: boolean;
    typesSafe: boolean;
    testsPass: boolean;
    noRegressions: boolean;
    followsPatterns: boolean;
    securityClean: boolean;
  };
  /** 발견된 문제 */
  issues: string[];
  /** 개선 제안 */
  suggestions: string[];
  /** 신뢰도 (0–1) */
  confidence: number;
}

/** 에이전트 상태 — 전체 실행 컨텍스트를 담는 단일 객체 */
export interface AgentState {
  /** 현재 phase */
  phase: AgentPhase;
  /** 에이전트 목표 */
  goal: string;

  // ─── Planning ───
  /** 실행 계획 */
  plan: ExecutionPlan | null;
  /** 현재 실행 중인 step 인덱스 */
  currentStepIndex: number;
  /** 제안된 접근법 목록 */
  approaches: ApproachOption[];
  /** 선택된 접근법 인덱스 */
  selectedApproach: number;

  // ─── Execution Results ───
  /** 단계별 실행 결과 */
  stepResults: StepResult[];
  /** 발생한 에러 */
  errors: StepError[];

  // ─── Reflection ───
  /** 검증 결과 이력 */
  reflections: VerifyResult[];
  /** 현재 수정 시도 횟수 */
  fixAttempts: number;
  /** 최대 수정 시도 횟수 */
  maxFixAttempts: number;

  // ─── Memory ───
  /** 작업 메모리 (phase 간 데이터 전달) */
  workingMemory: Map<string, unknown>;

  // ─── Metrics ───
  /** 누적 토큰 사용량 */
  tokenUsage: { input: number; output: number };
  /** 총 도구 호출 횟수 */
  toolCalls: number;
  /** 총 반복 횟수 */
  iterationCount: number;
  /** 실행 시작 시각 (epoch ms) */
  startTime: number;

  // ─── Control ───
  /** 중단 시그널 */
  abortSignal?: AbortSignal;
  /** 사용자 피드백 (delegate phase 등에서 수집) */
  userFeedback: string[];
}

// ─── Transition & Handler Types ───

/** Phase 전이 결과 — 핸들러가 반환 */
export interface PhaseTransition {
  /** 다음 phase */
  nextPhase: AgentPhase;
  /** 상태 업데이트 (부분 적용) */
  updates: Partial<AgentState>;
  /** 전이 사유 */
  reason: string;
}

/** Phase 핸들러 함수 타입 */
export type PhaseHandler = (
  state: AgentState,
  context: StateMachineContext,
) => Promise<PhaseTransition>;

/** 상태 기계 컨텍스트 — 외부 시스템 콜백 주입 */
export interface StateMachineContext {
  /** 코드베이스/요청 분석 */
  analyzeFn: (
    goal: string,
    state: AgentState,
  ) => Promise<{ complexity: string; context: string }>;
  /** 접근법 설계 */
  designFn: (goal: string, context: string) => Promise<ApproachOption[]>;
  /** 실행 계획 수립 */
  planFn: (goal: string, approach: ApproachOption) => Promise<ExecutionPlan>;
  /** 단일 step 실행 */
  executeFn: (
    plan: ExecutionPlan,
    stepIndex: number,
    state: AgentState,
  ) => Promise<StepResult>;
  /** 결과 검증 */
  verifyFn: (state: AgentState) => Promise<VerifyResult>;
  /** 에러 수정 */
  fixFn: (errors: StepError[], state: AgentState) => Promise<StepResult>;
  /** 실패 후 재계획 */
  replanFn: (state: AgentState) => Promise<ExecutionPlan>;
  /** 사용자 위임 (질문/승인) */
  delegateFn: (question: string) => Promise<string>;
}

/** 상태 기계 설정 */
export interface StateMachineConfig {
  /** 최대 수정 시도 횟수 (기본 3) */
  maxFixAttempts: number;
  /** 최대 재계획 횟수 (기본 2) */
  maxReplanAttempts: number;
  /** 단순 태스크 시 design phase 스킵 (기본 true) */
  skipDesignForSimple: boolean;
  /** 병렬 실행 활성화 (기본 true) */
  enableParallel: boolean;
  /** 각 step 후 검증 수행 (기본 false — 전체 완료 후에만) */
  verifyAfterEachStep: boolean;
}

/** 상태 기계 이벤트 정의 */
export interface StateMachineEvents {
  "phase:enter": (phase: AgentPhase, state: AgentState) => void;
  "phase:exit": (phase: AgentPhase, state: AgentState) => void;
  transition: (from: AgentPhase, to: AgentPhase, reason: string) => void;
  "step:complete": (result: StepResult) => void;
  "step:error": (error: StepError) => void;
  "verify:result": (result: VerifyResult) => void;
  done: (state: AgentState) => void;
  abort: (reason: string) => void;
}

// ─── Default Config ───

const DEFAULT_CONFIG: StateMachineConfig = {
  maxFixAttempts: 3,
  maxReplanAttempts: 2,
  skipDesignForSimple: true,
  enableParallel: true,
  verifyAfterEachStep: false,
};

// ─── Terminal Phases ───

const TERMINAL_PHASES: ReadonlySet<AgentPhase> = new Set(["done", "idle"]);

// ─── AgentStateMachine ───

/**
 * LangGraph-style Agent State Machine.
 *
 * 에이전트 실행을 유한 상태 기계(FSM)로 모델링한다.
 * 각 phase에 대응하는 핸들러가 상태를 변환하고 다음 phase를 결정한다.
 * run()을 호출하면 idle → analyze → ... → done까지 자동 진행.
 *
 * @example
 * ```typescript
 * const sm = new AgentStateMachine(context, { maxFixAttempts: 5 });
 * sm.on("transition", (from, to, reason) => console.log(`${from} → ${to}: ${reason}`));
 * const finalState = await sm.run("모든 console.log를 제거해줘");
 * ```
 */
export class AgentStateMachine extends EventEmitter {
  private state: AgentState;
  private readonly context: StateMachineContext;
  private readonly config: StateMachineConfig;
  private readonly handlers: Map<AgentPhase, PhaseHandler>;
  private replanCount: number;

  constructor(
    context: StateMachineContext,
    config?: Partial<StateMachineConfig>,
  ) {
    super();
    this.context = context;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.replanCount = 0;
    this.state = this.createInitialState("");

    // Phase 핸들러 등록
    this.handlers = new Map<AgentPhase, PhaseHandler>();
    this.handlers.set("analyze", this.handleAnalyze.bind(this));
    this.handlers.set("design", this.handleDesign.bind(this));
    this.handlers.set("plan", this.handlePlan.bind(this));
    this.handlers.set("implement", this.handleImplement.bind(this));
    this.handlers.set("parallel", this.handleParallel.bind(this));
    this.handlers.set("delegate", this.handleDelegate.bind(this));
    this.handlers.set("verify", this.handleVerify.bind(this));
    this.handlers.set("fix", this.handleFix.bind(this));
    this.handlers.set("replan", this.handleReplan.bind(this));
  }

  // ─── Public API ───

  /**
   * 상태 기계를 실행한다.
   * idle → analyze부터 시작하여 done에 도달할 때까지 phase를 자동 전이한다.
   *
   * @param goal - 에이전트 목표
   * @param abortSignal - 외부 중단 시그널 (선택)
   * @returns 최종 에이전트 상태
   */
  async run(goal: string, abortSignal?: AbortSignal): Promise<AgentState> {
    this.state = this.createInitialState(goal);
    this.replanCount = 0;

    if (abortSignal) {
      this.state.abortSignal = abortSignal;
    }

    // idle → analyze 초기 전이
    await this.transition({
      nextPhase: "analyze",
      updates: {},
      reason: "Starting agent execution",
    });

    // 메인 루프 — 터미널 phase에 도달할 때까지 반복
    const MAX_TOTAL_ITERATIONS = 1000;
    while (!this.isTerminal(this.state.phase)) {
      // Guard against infinite loops
      if (this.state.iterationCount >= MAX_TOTAL_ITERATIONS) {
        const reason = `Maximum iteration limit reached (${MAX_TOTAL_ITERATIONS})`;
        this.emit("abort", reason);
        await this.transition({
          nextPhase: "done",
          updates: {},
          reason,
        });
        break;
      }
      // 중단 체크
      if (this.state.abortSignal?.aborted) {
        const reason = "Execution aborted by signal";
        this.emit("abort", reason);
        await this.transition({
          nextPhase: "done",
          updates: {},
          reason,
        });
        break;
      }

      const handler = this.handlers.get(this.state.phase);
      if (!handler) {
        const reason = `No handler registered for phase: ${this.state.phase}`;
        this.emit("abort", reason);
        await this.transition({
          nextPhase: "done",
          updates: {},
          reason,
        });
        break;
      }

      try {
        const next = await handler(this.state, this.context);
        await this.transition(next);
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : String(err);
        const stepError: StepError = {
          stepIndex: this.state.currentStepIndex,
          phase: this.state.phase,
          error: errorMessage,
          recoverable: false,
        };
        this.state.errors.push(stepError);
        this.emit("step:error", stepError);

        await this.transition({
          nextPhase: "done",
          updates: {},
          reason: `Fatal error in ${this.state.phase}: ${errorMessage}`,
        });
      }

      this.state.iterationCount++;
    }

    this.emit("done", this.state);
    return this.state;
  }

  /**
   * 현재 상태를 읽기 전용으로 반환한다.
   */
  getState(): Readonly<AgentState> {
    return this.state;
  }

  /**
   * 실행 중인 에이전트에 사용자 피드백을 주입한다.
   * delegate phase에서 수집되거나, 외부에서 즉시 주입 가능.
   *
   * @param feedback - 사용자 피드백 문자열
   */
  injectFeedback(feedback: string): void {
    this.state.userFeedback.push(feedback);
  }

  /**
   * 특정 phase로 강제 전이한다 (escape hatch).
   * 디버깅이나 외부 제어에 사용.
   *
   * @param phase - 전이할 phase
   * @param reason - 전이 사유
   */
  forceTransition(phase: AgentPhase, reason: string): void {
    const from = this.state.phase;
    this.emit("phase:exit", from, this.state);
    this.state.phase = phase;
    this.emit("transition", from, phase, `[FORCED] ${reason}`);
    this.emit("phase:enter", phase, this.state);
  }

  // ─── Phase Handlers ───

  /**
   * analyze phase — 코드베이스와 요청을 분석한다.
   * 복잡도가 trivial이고 skipDesignForSimple이면 plan으로 직행.
   */
  private async handleAnalyze(
    state: AgentState,
    ctx: StateMachineContext,
  ): Promise<PhaseTransition> {
    const startMs = Date.now();
    const analysis = await ctx.analyzeFn(state.goal, state);
    const durationMs = Date.now() - startMs;

    state.workingMemory.set("analysisContext", analysis.context);
    state.workingMemory.set("complexity", analysis.complexity);

    const result: StepResult = {
      stepIndex: 0,
      phase: "analyze",
      success: true,
      output: `Complexity: ${analysis.complexity}. ${analysis.context}`,
      changedFiles: [],
      tokensUsed: 0,
      durationMs,
    };
    state.stepResults.push(result);
    this.emit("step:complete", result);

    // trivial + skipDesign → plan으로 직행
    if (
      analysis.complexity === "trivial" &&
      this.config.skipDesignForSimple
    ) {
      return {
        nextPhase: "plan",
        updates: {},
        reason: `Trivial task — skipping design phase`,
      };
    }

    return {
      nextPhase: "design",
      updates: {},
      reason: `Analysis complete (complexity: ${analysis.complexity})`,
    };
  }

  /**
   * design phase — 구현 접근법을 제안한다.
   * 추천 접근법이 있으면 자동 선택 후 plan으로, 없으면 delegate로.
   */
  private async handleDesign(
    state: AgentState,
    ctx: StateMachineContext,
  ): Promise<PhaseTransition> {
    const analysisContext =
      (state.workingMemory.get("analysisContext") as string) ?? "";
    const startMs = Date.now();
    const approaches = await ctx.designFn(state.goal, analysisContext);
    const durationMs = Date.now() - startMs;

    const result: StepResult = {
      stepIndex: state.stepResults.length,
      phase: "design",
      success: true,
      output: `Generated ${approaches.length} approach(es)`,
      changedFiles: [],
      tokensUsed: 0,
      durationMs,
    };
    state.stepResults.push(result);
    this.emit("step:complete", result);

    // 추천 접근법 자동 선택
    const recommendedIdx = approaches.findIndex((a) => a.recommended);

    if (recommendedIdx >= 0) {
      return {
        nextPhase: "plan",
        updates: {
          approaches,
          selectedApproach: recommendedIdx,
        },
        reason: `Auto-selected recommended approach: ${approaches[recommendedIdx]!.name}`,
      };
    }

    // 추천 없음 → 사용자에게 위임
    return {
      nextPhase: "delegate",
      updates: {
        approaches,
      },
      reason: "No recommended approach — delegating to user",
    };
  }

  /**
   * plan phase — 실행 계획을 수립한다.
   * 독립적 태스크가 있고 enableParallel이면 parallel로, 아니면 implement로.
   */
  private async handlePlan(
    state: AgentState,
    ctx: StateMachineContext,
  ): Promise<PhaseTransition> {
    const approach = state.approaches[state.selectedApproach];

    // 접근법이 없는 경우 (trivial → plan 직행 시) 기본 접근법 생성
    const effectiveApproach: ApproachOption = approach ?? {
      id: 0,
      name: "direct",
      description: "Direct implementation",
      pros: ["Simple"],
      cons: [],
      estimatedComplexity: "low" as const,
      recommended: true,
    };

    const startMs = Date.now();
    const plan = await ctx.planFn(state.goal, effectiveApproach);
    const durationMs = Date.now() - startMs;

    const result: StepResult = {
      stepIndex: state.stepResults.length,
      phase: "plan",
      success: true,
      output: `Plan created with ${plan.steps.length} step(s)`,
      changedFiles: [],
      tokensUsed: 0,
      durationMs,
    };
    state.stepResults.push(result);
    this.emit("step:complete", result);

    // 병렬 실행 가능 여부 판단 — 의존성 없는 독립 step이 2개 이상이면 parallel
    const hasIndependentTasks =
      this.config.enableParallel &&
      plan.steps.length > 1 &&
      plan.steps.filter((s) => s.dependsOn.length === 0).length >= 2;

    if (hasIndependentTasks) {
      return {
        nextPhase: "parallel",
        updates: {
          plan,
          currentStepIndex: 0,
        },
        reason: `Plan has ${plan.steps.length} steps with independent tasks — using parallel execution`,
      };
    }

    return {
      nextPhase: "implement",
      updates: {
        plan,
        currentStepIndex: 0,
      },
      reason: `Plan has ${plan.steps.length} step(s) — using sequential execution`,
    };
  }

  /**
   * implement phase — step을 순차 실행한다.
   * 각 step 후: 복구 불가 에러 → fix, 모든 step 완료 → verify.
   */
  private async handleImplement(
    state: AgentState,
    ctx: StateMachineContext,
  ): Promise<PhaseTransition> {
    if (!state.plan) {
      return {
        nextPhase: "done",
        updates: {},
        reason: "No plan available — cannot implement",
      };
    }

    const { steps } = state.plan;

    for (let i = state.currentStepIndex; i < steps.length; i++) {
      // 중단 체크
      if (state.abortSignal?.aborted) {
        return {
          nextPhase: "done",
          updates: { currentStepIndex: i },
          reason: "Aborted during implementation",
        };
      }

      try {
        const stepResult = await ctx.executeFn(state.plan, i, state);
        state.stepResults.push(stepResult);
        state.currentStepIndex = i + 1;
        this.emit("step:complete", stepResult);

        // 토큰 추적
        state.tokenUsage.input += stepResult.tokensUsed;
        state.toolCalls++;

        if (!stepResult.success) {
          const stepError: StepError = {
            stepIndex: i,
            phase: "implement",
            error: stepResult.output,
            recoverable: true,
          };
          state.errors.push(stepError);
          this.emit("step:error", stepError);
        }

        // step 별 검증 (설정 시)
        if (this.config.verifyAfterEachStep && stepResult.success) {
          const verifyResult = await ctx.verifyFn(state);
          state.reflections.push(verifyResult);
          this.emit("verify:result", verifyResult);

          if (verifyResult.verdict === "fail") {
            return {
              nextPhase: "fix",
              updates: { currentStepIndex: i + 1 },
              reason: `Verification failed after step ${i}: ${verifyResult.issues.join(", ")}`,
            };
          }
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : String(err);
        const stepError: StepError = {
          stepIndex: i,
          phase: "implement",
          error: errorMessage,
          recoverable: false,
        };
        state.errors.push(stepError);
        this.emit("step:error", stepError);

        return {
          nextPhase: "fix",
          updates: { currentStepIndex: i },
          reason: `Non-recoverable error at step ${i}: ${errorMessage}`,
        };
      }
    }

    return {
      nextPhase: "verify",
      updates: {},
      reason: "All implementation steps completed",
    };
  }

  /**
   * parallel phase — 독립 태스크를 병렬 실행한다.
   * DAG 실행 후 verify로 이동.
   */
  private async handleParallel(
    state: AgentState,
    ctx: StateMachineContext,
  ): Promise<PhaseTransition> {
    if (!state.plan) {
      return {
        nextPhase: "done",
        updates: {},
        reason: "No plan available — cannot execute in parallel",
      };
    }

    const { steps } = state.plan;
    const errors: StepError[] = [];
    const results: StepResult[] = [];

    // 의존성 없는 step은 병렬, 의존성 있는 step은 순차
    const independent = steps.filter((s) => s.dependsOn.length === 0);
    const dependent = steps.filter((s) => s.dependsOn.length > 0);

    // 독립 step 병렬 실행
    const parallelPromises = independent.map(async (_, idx) => {
      const stepIdx = steps.indexOf(independent[idx]!);
      try {
        const stepResult = await ctx.executeFn(state.plan!, stepIdx, state);
        return { stepResult, stepIdx, error: null };
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : String(err);
        return { stepResult: null, stepIdx, error: errorMessage };
      }
    });

    const parallelResults = await Promise.all(parallelPromises);

    for (const pr of parallelResults) {
      if (pr.stepResult) {
        results.push(pr.stepResult);
        this.emit("step:complete", pr.stepResult);
        state.tokenUsage.input += pr.stepResult.tokensUsed;
        state.toolCalls++;
      }
      if (pr.error) {
        const stepError: StepError = {
          stepIndex: pr.stepIdx,
          phase: "parallel",
          error: pr.error,
          recoverable: true,
        };
        errors.push(stepError);
        this.emit("step:error", stepError);
      }
    }

    // 의존 step 순차 실행
    for (const step of dependent) {
      const stepIdx = steps.indexOf(step);
      try {
        const stepResult = await ctx.executeFn(state.plan, stepIdx, state);
        results.push(stepResult);
        this.emit("step:complete", stepResult);
        state.tokenUsage.input += stepResult.tokensUsed;
        state.toolCalls++;
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : String(err);
        const stepError: StepError = {
          stepIndex: stepIdx,
          phase: "parallel",
          error: errorMessage,
          recoverable: true,
        };
        errors.push(stepError);
        this.emit("step:error", stepError);
      }
    }

    return {
      nextPhase: "verify",
      updates: {
        stepResults: [...state.stepResults, ...results],
        errors: [...state.errors, ...errors],
        currentStepIndex: steps.length,
      },
      reason: `Parallel execution complete: ${results.length} succeeded, ${errors.length} failed`,
    };
  }

  /**
   * delegate phase — 사용자에게 질문/승인을 요청한다.
   * 피드백에 따라 analyze 또는 plan으로 전이.
   */
  private async handleDelegate(
    state: AgentState,
    ctx: StateMachineContext,
  ): Promise<PhaseTransition> {
    // 접근법 선택 위임인 경우 질문 생성
    let question = "Please provide guidance on how to proceed.";
    if (state.approaches.length > 0 && state.selectedApproach < 0) {
      const optionsList = state.approaches
        .map(
          (a) =>
            `[${a.id}] ${a.name} (${a.estimatedComplexity}): ${a.description}`,
        )
        .join("\n");
      question = `Multiple approaches available. Please select one:\n${optionsList}`;
    }

    const startMs = Date.now();
    const feedback = await ctx.delegateFn(question);
    const durationMs = Date.now() - startMs;

    state.userFeedback.push(feedback);

    const result: StepResult = {
      stepIndex: state.stepResults.length,
      phase: "delegate",
      success: true,
      output: `User feedback received: ${feedback}`,
      changedFiles: [],
      tokensUsed: 0,
      durationMs,
    };
    state.stepResults.push(result);
    this.emit("step:complete", result);

    // 피드백에서 접근법 번호 추출 시도
    const approachId = parseInt(feedback.trim(), 10);
    if (
      !isNaN(approachId) &&
      state.approaches.some((a) => a.id === approachId)
    ) {
      const idx = state.approaches.findIndex((a) => a.id === approachId);
      return {
        nextPhase: "plan",
        updates: { selectedApproach: idx },
        reason: `User selected approach: ${state.approaches[idx]!.name}`,
      };
    }

    // 특정 접근법 선택이 아니면 새로운 컨텍스트로 re-analyze
    return {
      nextPhase: "analyze",
      updates: {},
      reason: `User provided general feedback — re-analyzing`,
    };
  }

  /**
   * verify phase — 실행 결과를 검증한다.
   * pass → done, concern + fixAttempts < max → fix, fail → replan.
   */
  private async handleVerify(
    state: AgentState,
    ctx: StateMachineContext,
  ): Promise<PhaseTransition> {
    const startMs = Date.now();
    const verifyResult = await ctx.verifyFn(state);
    const durationMs = Date.now() - startMs;

    state.reflections.push(verifyResult);
    this.emit("verify:result", verifyResult);

    const result: StepResult = {
      stepIndex: state.stepResults.length,
      phase: "verify",
      success: verifyResult.verdict === "pass",
      output: `Verdict: ${verifyResult.verdict} (confidence: ${verifyResult.confidence}). Issues: ${verifyResult.issues.length}`,
      changedFiles: [],
      tokensUsed: 0,
      durationMs,
    };
    state.stepResults.push(result);
    this.emit("step:complete", result);

    if (verifyResult.verdict === "pass") {
      return {
        nextPhase: "done",
        updates: {},
        reason: `Verification passed (confidence: ${verifyResult.confidence})`,
      };
    }

    if (
      verifyResult.verdict === "concern" &&
      state.fixAttempts < state.maxFixAttempts
    ) {
      return {
        nextPhase: "fix",
        updates: {},
        reason: `Verification found concerns: ${verifyResult.issues.join("; ")}`,
      };
    }

    if (verifyResult.verdict === "fail") {
      return {
        nextPhase: "replan",
        updates: {},
        reason: `Verification failed: ${verifyResult.issues.join("; ")}`,
      };
    }

    // concern but fix attempts exhausted — done with warning
    return {
      nextPhase: "done",
      updates: {},
      reason: `Verification has concerns but fix attempts exhausted (${state.fixAttempts}/${state.maxFixAttempts})`,
    };
  }

  /**
   * fix phase — 에러를 자동 수정한다.
   * fixAttempts를 증가시키고 verify로 복귀.
   */
  private async handleFix(
    state: AgentState,
    ctx: StateMachineContext,
  ): Promise<PhaseTransition> {
    // 수정 대상 에러 수집 (최근 에러 + 검증 이슈)
    const errorsToFix: StepError[] = [];

    // 실행 중 발생한 에러
    const recentErrors = state.errors.filter((e) => e.recoverable);
    errorsToFix.push(...recentErrors);

    // 검증에서 발견된 이슈를 StepError로 변환
    const lastReflection = state.reflections[state.reflections.length - 1];
    if (lastReflection) {
      for (const issue of lastReflection.issues) {
        errorsToFix.push({
          stepIndex: state.currentStepIndex,
          phase: "verify",
          error: issue,
          recoverable: true,
        });
      }
    }

    if (errorsToFix.length === 0) {
      // 수정할 에러 없음 — done으로
      return {
        nextPhase: "done",
        updates: {},
        reason: "No fixable errors found",
      };
    }

    const startMs = Date.now();
    const fixResult = await ctx.fixFn(errorsToFix, state);
    const durationMs = Date.now() - startMs;

    state.stepResults.push(fixResult);
    state.fixAttempts++;
    this.emit("step:complete", fixResult);

    state.tokenUsage.input += fixResult.tokensUsed;
    state.toolCalls++;

    return {
      nextPhase: "verify",
      updates: {
        fixAttempts: state.fixAttempts,
      },
      reason: `Fix attempt ${state.fixAttempts}/${state.maxFixAttempts} — re-verifying`,
    };
  }

  /**
   * replan phase — 실패 후 재계획을 수립한다.
   * maxReplanAttempts 초과 시 done으로 (경고 포함).
   */
  private async handleReplan(
    state: AgentState,
    ctx: StateMachineContext,
  ): Promise<PhaseTransition> {
    this.replanCount++;

    if (this.replanCount > this.config.maxReplanAttempts) {
      return {
        nextPhase: "done",
        updates: {},
        reason: `Replan attempts exhausted (${this.replanCount - 1}/${this.config.maxReplanAttempts}). Stopping with partial results.`,
      };
    }

    const startMs = Date.now();
    const newPlan = await ctx.replanFn(state);
    const durationMs = Date.now() - startMs;

    const result: StepResult = {
      stepIndex: state.stepResults.length,
      phase: "replan",
      success: true,
      output: `Replanned with ${newPlan.steps.length} step(s) (attempt ${this.replanCount}/${this.config.maxReplanAttempts})`,
      changedFiles: [],
      tokensUsed: 0,
      durationMs,
    };
    state.stepResults.push(result);
    this.emit("step:complete", result);

    // 수정 시도 카운터 리셋 (새 계획이므로)
    return {
      nextPhase: "implement",
      updates: {
        plan: newPlan,
        currentStepIndex: 0,
        fixAttempts: 0,
        errors: [],
      },
      reason: `Replanned (attempt ${this.replanCount}/${this.config.maxReplanAttempts})`,
    };
  }

  // ─── Internal ───

  /**
   * phase 전이를 수행한다.
   * phase:exit → 상태 업데이트 → transition 이벤트 → phase:enter.
   */
  private async transition(next: PhaseTransition): Promise<void> {
    const from = this.state.phase;
    const to = next.nextPhase;

    // Exit 이벤트
    this.emit("phase:exit", from, this.state);

    // 상태 업데이트 (Partial<AgentState> 적용)
    for (const [key, value] of Object.entries(next.updates)) {
      // Map은 특수 처리 (shallow merge 하지 않음)
      (this.state as unknown as Record<string, unknown>)[key] = value;
    }

    // Phase 전이
    this.state.phase = to;

    // 전이 이벤트
    this.emit("transition", from, to, next.reason);

    // Enter 이벤트
    this.emit("phase:enter", to, this.state);
  }

  /**
   * 초기 상태를 생성한다.
   */
  private createInitialState(goal: string): AgentState {
    return {
      phase: "idle",
      goal,
      plan: null,
      currentStepIndex: 0,
      approaches: [],
      selectedApproach: -1,
      stepResults: [],
      errors: [],
      reflections: [],
      fixAttempts: 0,
      maxFixAttempts: this.config.maxFixAttempts,
      workingMemory: new Map(),
      tokenUsage: { input: 0, output: 0 },
      toolCalls: 0,
      iterationCount: 0,
      startTime: Date.now(),
      userFeedback: [],
    };
  }

  /**
   * 터미널 phase인지 확인한다.
   */
  private isTerminal(phase: AgentPhase): boolean {
    return TERMINAL_PHASES.has(phase);
  }
}
