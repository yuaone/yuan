/**
 * @module continuous-reflection
 * @description Continuous Reflection — 설계 문서 섹션 20.2 구현.
 *
 * 1분 간격으로 3가지 자율 점검을 수행한다:
 *
 * 1. **Checkpoint**: 현재 상태를 SessionPersistence에 저장
 * 2. **Self-Verify**: 경량 LLM 호출(~200 토큰)로 방향 검증
 * 3. **Context Monitor**: 컨텍스트 사용량 체크, 80%→비상 체크포인트, 95%→새 세션 스폰
 *
 * ESC로 토글 가능 (pause/resume). 순수 실행 모드.
 * EventEmitter를 확장하여 reflection 이벤트를 외부에 전파.
 */

import { EventEmitter } from "node:events";
import type { ContinuationCheckpoint } from "./types.js";

// ─── Self-Verify Prompt ──────────────────────────────────────────

/**
 * 자기 검증 프롬프트 템플릿.
 *
 * 플레이스홀더는 실행 시 실제 값으로 치환된다:
 * - {goal}: 현재 에이전트 목표
 * - {iteration}: 현재 iteration 수
 * - {maxIteration}: 최대 iteration 수
 * - {changedFiles}: 변경된 파일 목록
 * - {recentToolCalls}: 최근 3개 도구 호출
 * - {errors}: 발생한 에러 목록
 */
export const SELF_VERIFY_PROMPT = `당신은 현재 실행 중인 에이전트의 진행 상황을 검증하는 역할입니다.

현재 상태:
- 목표: {goal}
- 완료된 이터레이션: {iteration}/{maxIteration}
- 변경된 파일: {changedFiles}
- 최근 3개 도구 호출: {recentToolCalls}
- 에러 발생: {errors}

다음을 판단하세요:
1. 올바른 방향으로 진행 중인가? (yes/no)
2. 삽질 패턴이 보이는가? (같은 파일 반복 수정, 같은 에러 반복 등)
3. 방향 전환이 필요한가?

JSON으로 응답:
{
  "onTrack": true/false,
  "needsCorrection": true/false,
  "issue": "문제 설명 (있으면)",
  "suggestion": "제안 (있으면)",
  "confidence": 0.0~1.0
}`;

// ─── Types ───────────────────────────────────────────────────────

/** Reflection 설정 */
export interface ReflectionConfig {
  /** 체크 간격 (ms). 기본 60_000 (1분). */
  intervalMs: number;
  /** Reflection 활성화 여부. ESC로 토글. */
  enabled: boolean;
  /** 체크포인트 저장 활성화 */
  checkpointEnabled: boolean;
  /** 자기 검증 (LLM 호출) 활성화 */
  selfVerifyEnabled: boolean;
  /** 컨텍스트 사용량 모니터 활성화 */
  contextMonitorEnabled: boolean;
}

/** 자기 검증 LLM 응답 */
export interface SelfVerifyVerdict {
  /** 올바른 방향인가 */
  onTrack: boolean;
  /** 방향 전환이 필요한가 */
  needsCorrection: boolean;
  /** 문제 설명 (있으면) */
  issue: string;
  /** 수정 제안 (있으면) */
  suggestion: string;
  /** 판단 확신도 (0.0~1.0) */
  confidence: number;
}

/** 에이전트 상태 스냅샷 — reflection이 접근하는 읽기 전용 정보 */
export interface AgentStateSnapshot {
  /** 현재 목표 */
  goal: string;
  /** 현재 iteration */
  iteration: number;
  /** 최대 iteration */
  maxIteration: number;
  /** 변경된 파일 목록 */
  changedFiles: string[];
  /** 최근 도구 호출 (최대 3개) */
  recentToolCalls: Array<{ tool: string; input: string; output: string }>;
  /** 발생한 에러 목록 */
  errors: string[];
  /** 컨텍스트 사용률 (0.0~1.0) */
  contextUsagePercent: number;
  /** 세션 ID */
  sessionId: string;
  /** 사용된 총 토큰 */
  totalTokensUsed: number;
  /** 작업 메모리 (압축 요약) */
  workingMemory: string;
  /** 완료된 태스크 목록 */
  completedTasks: string[];
  /** 현재 태스크 */
  currentTask: string;
  /** 남은 태스크 목록 */
  remainingTasks: string[];
  /** 현재 working hypothesis (LLM이 업데이트) */
  hypothesis?: string;
  /** 마지막 실패 시그니처 */
  failureSignature?: string;
  /** 마지막 검증 결과 */
  verifyState?: "pass" | "fail" | "pending";
  /** 압축된 월드 스테이트 요약 */
  worldStateSummary?: string;
}

/**
 * 자기 검증 LLM 호출 콜백.
 *
 * LLMClient를 직접 import하지 않고 의존성 주입으로 받는다.
 * 호출 측에서 경량 모델(~200 토큰)로 호출하도록 구현한다.
 *
 * @param prompt - 치환된 검증 프롬프트
 * @returns 검증 결과 JSON
 */
export type SelfVerifyFn = (prompt: string) => Promise<SelfVerifyVerdict>;

/**
 * 체크포인트 저장 콜백.
 *
 * SessionPersistence를 직접 import하지 않고 의존성 주입으로 받는다.
 *
 * @param state - 현재 에이전트 상태 스냅샷
 * @param emergency - 비상 체크포인트 여부 (80%+ 컨텍스트)
 */
export type CheckpointFn = (state: AgentStateSnapshot, emergency: boolean) => Promise<void>;

/**
 * 에이전트 상태 제공 콜백.
 *
 * AgentLoop의 현재 상태를 읽기 전용으로 가져온다.
 */
export type GetStateFn = () => AgentStateSnapshot;

/** ContinuousReflection 생성자 옵션 */
export interface ContinuousReflectionOptions {
  /** Reflection 설정 */
  config?: Partial<ReflectionConfig>;
  /** 자기 검증 LLM 호출 콜백 (DI) */
  selfVerify?: SelfVerifyFn;
  /** 체크포인트 저장 콜백 (DI) */
  checkpoint?: CheckpointFn;
  /** 에이전트 상태 제공 콜백 (DI) */
  getState: GetStateFn;
}

// ─── Event Types ─────────────────────────────────────────────────

/** ContinuousReflection이 발행하는 이벤트 맵 */
export interface ReflectionEvents {
  /** 체크포인트 저장 완료 */
  "reflection:checkpoint": [state: AgentStateSnapshot];
  /** 자기 검증 완료 */
  "reflection:self_verify": [verdict: SelfVerifyVerdict];
  /** 피드백 주입 요청 (방향 전환 필요 시) */
  "reflection:feedback": [feedback: string];
  /** 컨텍스트 80% 도달 — 비상 체크포인트 */
  "reflection:context_warning": [usagePercent: number];
  /** 컨텍스트 95% 도달 — 새 세션 스폰 요청 */
  "reflection:context_overflow": [checkpoint: ContinuationCheckpoint];
  /** Reflection 일시 정지 (ESC) */
  "reflection:paused": [];
  /** Reflection 재개 */
  "reflection:resumed": [];
  /** Reflection 에러 (비치명적, 다음 tick에서 재시도) */
  "reflection:error": [error: Error];
}

// ─── Constants ───────────────────────────────────────────────────

/** 기본 Reflection 설정 */
const DEFAULT_CONFIG: ReflectionConfig = {
  intervalMs: 60_000,
  enabled: true,
  checkpointEnabled: true,
  selfVerifyEnabled: true,
  contextMonitorEnabled: true,
};

/** 비상 체크포인트 트리거 임계값 */
const CONTEXT_WARNING_THRESHOLD = 0.80;

/** 새 세션 스폰 트리거 임계값 */
const CONTEXT_OVERFLOW_THRESHOLD = 0.95;

// ─── ContinuousReflection ────────────────────────────────────────

/**
 * Continuous Reflection.
 *
 * 1분 간격으로 체크포인트 저장, 자기 검증, 컨텍스트 모니터를 수행한다.
 * ESC로 토글 가능 (pause/resume).
 *
 * LLM 호출과 체크포인트 저장은 의존성 주입으로 받아 결합도를 낮춘다.
 * 컨텍스트 95% 도달 시 `reflection:context_overflow` 이벤트를 발행하며,
 * 실제 세션 스폰은 부모(AgentRunner)가 처리한다.
 *
 * @example
 * ```typescript
 * const reflection = new ContinuousReflection({
 *   getState: () => agentLoop.getStateSnapshot(),
 *   selfVerify: async (prompt) => llm.complete(prompt, { maxTokens: 200 }),
 *   checkpoint: async (state, emergency) => persistence.save(state, emergency),
 * });
 *
 * reflection.on("reflection:context_overflow", (cp) => {
 *   agentRunner.spawnContinuation(cp);
 * });
 *
 * reflection.on("reflection:feedback", (feedback) => {
 *   agentLoop.injectFeedback(feedback);
 * });
 *
 * reflection.start();
 * // ... agent loop runs ...
 * reflection.stop();
 * ```
 */
export class ContinuousReflection extends EventEmitter {
  /** 주기적 타이머 */
  private timer: NodeJS.Timeout | null = null;

  /** 현재 설정 */
  private config: ReflectionConfig;

  /** 자기 검증 LLM 호출 콜백 */
  private readonly selfVerifyFn: SelfVerifyFn | null;

  /** 체크포인트 저장 콜백 */
  private readonly checkpointFn: CheckpointFn | null;

  /** 에이전트 상태 제공 콜백 */
  private readonly getStateFn: GetStateFn;

  /** tick 실행 중 여부 (중복 방지) */
  private ticking = false;

  /** 컨텍스트 overflow가 이미 트리거됐는지 (중복 스폰 방지) */
  private overflowTriggered = false;

  constructor(options: ContinuousReflectionOptions) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this.selfVerifyFn = options.selfVerify ?? null;
    this.checkpointFn = options.checkpoint ?? null;
    this.getStateFn = options.getState;
  }

  /**
   * Reflection 루프를 시작한다.
   *
   * config.intervalMs 간격으로 체크포인트, 자기 검증, 컨텍스트 모니터를 수행.
   */
  start(): void {
    if (this.timer) return; // 이미 실행 중

    this.overflowTriggered = false;

  const run = async () => {
    await this.tick();
    if (this.timer) {
      this.timer = setTimeout(run, this.config.intervalMs) as unknown as NodeJS.Timeout;
    }
  };

  this.timer = setTimeout(run, this.config.intervalMs) as unknown as NodeJS.Timeout;
  }

  /**
   * Reflection을 일시 정지한다 (ESC 토글).
   *
   * 타이머는 유지되지만 tick 내부에서 enabled=false이면 스킵.
   */
  pause(): void {
    if (!this.config.enabled) return;

    this.config.enabled = false;
    this.emit("reflection:paused");
  }

  /**
   * Reflection을 재개한다.
   */
  resume(): void {
    if (this.config.enabled) return;

    this.config.enabled = true;
    this.emit("reflection:resumed");
  }

  /**
   * Reflection 루프를 완전히 중지한다.
   *
   * 세션 종료 시 호출.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.ticking = false;
  }

  /**
   * Reflection이 현재 활성 상태인지 반환한다.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Reflection 루프가 실행 중인지 반환한다 (타이머 존재 여부).
   */
  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * 비상 체크포인트를 즉시 수행한다.
   *
   * Hard interrupt 시 InterruptManager가 호출한다.
   */
  async emergencyCheckpoint(): Promise<void> {
    const state = this.getStateFn();

    if (this.checkpointFn) {
      await this.checkpointFn(state, true);
    }

    this.emit("reflection:checkpoint", state);
  }

  /**
   * 현재 설정을 반환한다.
   */
  getConfig(): Readonly<ReflectionConfig> {
    return { ...this.config };
  }

  /**
   * 설정을 부분 업데이트한다.
   */
  updateConfig(partial: Partial<ReflectionConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  // ─── Private ─────────────────────────────────────────────────

  /**
   * 1회 tick 실행.
   *
   * 중복 실행 방지 (이전 tick이 아직 진행 중이면 스킵).
   * 각 단계에서 에러가 발생해도 다음 단계는 실행한다 (비치명적).
   */
  private async tick(): Promise<void> {
    if (!this.config.enabled) return;
    if (this.ticking) return; // 이전 tick 진행 중

    this.ticking = true;

    try {
      const state = this.getStateFn();

      // [1] Checkpoint
      if (this.config.checkpointEnabled) {
        await this.performCheckpoint(state);
      }

      // [2] Self-Verify
      if (this.config.selfVerifyEnabled) {
        await this.performSelfVerify(state);
      }

      // [3] Context Monitor
      if (this.config.contextMonitorEnabled) {
        await this.performContextMonitor(state);
      }
    } catch (error) {
      // 비치명적 에러 — 로그 후 다음 tick에서 재시도
      this.emit(
        "reflection:error",
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      this.ticking = false;
    }
  }

  /**
   * [1] 체크포인트 저장.
   *
   * 현재 상태를 SessionPersistence에 저장한다.
   */
  private async performCheckpoint(state: AgentStateSnapshot): Promise<void> {
    if (!this.checkpointFn) return;

    try {
      await this.checkpointFn(state, false);
      this.emit("reflection:checkpoint", state);
    } catch (error) {
      this.emit(
        "reflection:error",
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  /**
   * [2] 자기 검증.
   *
   * 경량 LLM 호출(~200 토큰)로 현재 방향을 검증한다.
   * 방향 전환이 필요하면 피드백을 에이전트 루프에 주입한다.
   */
  private async performSelfVerify(state: AgentStateSnapshot): Promise<void> {
    if (!this.selfVerifyFn) return;

    try {
      const prompt = this.buildSelfVerifyPrompt(state);
      const verdict = await this.selfVerifyFn(prompt);

      this.emit("reflection:self_verify", verdict);

      if (verdict.needsCorrection) {
        const feedback = `[자기검증] ${verdict.issue}. 방향 전환: ${verdict.suggestion}`;
        this.emit("reflection:feedback", feedback);
      }
    } catch (error) {
      this.emit(
        "reflection:error",
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  /**
   * [3] 컨텍스트 사용량 모니터.
   *
   * - 80%: 비상 체크포인트
   * - 95%: 새 세션 스폰 요청 (1회만)
   */
  private async performContextMonitor(state: AgentStateSnapshot): Promise<void> {
    const usage = state.contextUsagePercent;

if (usage >= CONTEXT_OVERFLOW_THRESHOLD) {
  if (this.overflowTriggered) return;
  this.overflowTriggered = true;
      // 95%+: 새 세션 스폰 요청 (중복 방지)
      this.overflowTriggered = true;

      // 비상 체크포인트 먼저
      if (this.checkpointFn) {
        await this.checkpointFn(state, true);
      }

      // ContinuationCheckpoint 생성
      const checkpoint: ContinuationCheckpoint = {
        sessionId: state.sessionId,
        goal: state.goal,
        progress: {
          completedTasks: state.completedTasks,
          currentTask: state.currentTask,
          remainingTasks: state.remainingTasks,
        },
 changedFiles: state.changedFiles.map((f) => ({
   path: f,
   diff: "",
 })),
        workingMemory: state.workingMemory,
        yuanMdUpdates: [],
        errors: state.errors,
        contextUsageAtSave: usage,
        totalTokensUsed: state.totalTokensUsed,
        iterationsCompleted: state.iteration,
        createdAt: new Date(),
      };

      // 부모(AgentRunner)에게 새 세션 스폰 위임
      this.emit("reflection:context_overflow", checkpoint);
    } else if (usage >= CONTEXT_WARNING_THRESHOLD) {
      // 80%+: 비상 체크포인트
      this.emit("reflection:context_warning", usage);

      if (this.checkpointFn) {
        try {
          await this.checkpointFn(state, true);
        } catch (error) {
          this.emit(
            "reflection:error",
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
    }
  }

  /**
   * 자기 검증 프롬프트를 빌드한다.
   *
   * SELF_VERIFY_PROMPT 템플릿의 플레이스홀더를 실제 값으로 치환한다.
   */
  private buildSelfVerifyPrompt(state: AgentStateSnapshot): string {
    const recentCalls = state.recentToolCalls
      .map((c) => `${c.tool}(${c.input}) → ${(c.output ?? "").slice(0, 100)}`)
      .join("\n");

return SELF_VERIFY_PROMPT
  .replaceAll("{goal}", state.goal)
  .replaceAll("{iteration}", String(state.iteration))
  .replaceAll("{maxIteration}", String(state.maxIteration))
  .replaceAll("{changedFiles}", state.changedFiles.join(", ") || "없음")
  .replaceAll("{recentToolCalls}", recentCalls || "없음")
  .replaceAll("{errors}", state.errors.join(", ") || "없음");
  }
}
