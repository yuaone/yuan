/**
 * @module reasoning-adapter
 * @description ReasoningProgressAdapter — LLM reasoning delta를 실시간 progress 이벤트로 변환.
 *
 * 흐름:
 * 1. LLM 스트리밍에서 reasoning delta 수신
 * 2. thinking 원문은 항상 progress:thinking으로 발행
 * 3. 버퍼 축적 + 1초 디바운스로 상태 변화 감지
 * 4. 의미 있는 상태 변화 시 progress:status 발행
 *
 * 패턴 매칭으로 에이전트의 현재 활동을 추론:
 * - planning: 계획, 설계, 구조 분석
 * - coding: 코드 작성, 수정, 생성
 * - reviewing: 검토, 확인, 검증
 * - testing: 테스트, 빌드, 실행
 * - waiting: 대기, 승인, 입력
 */

import type {
  ProgressStatusEvent,
  ProgressThinkingEvent,
  FixedAgentRole,
  AgentRole,
} from "./types.js";

// ─── Status Inference Types ───

/** 추론된 상태 정보 */
interface InferredStatus {
  status: ProgressStatusEvent["status"];
  detail: string;
}

// ─── Status Pattern Definitions ───

/** 상태 추론 패턴 (우선순위 순서) */
const STATUS_PATTERNS: Array<{
  status: ProgressStatusEvent["status"];
  pattern: RegExp;
}> = [
  // testing이 coding보다 우선 (검증 단계가 더 구체적)
  {
    status: "testing",
    pattern: /test|검증|확인|verify|빌드|build|실행|run|assert|expect/i,
  },
  // reviewing
  {
    status: "reviewing",
    pattern: /review|검토|리뷰|점검|살펴|분석.*결과|code.*quality/i,
  },
  // coding
  {
    status: "coding",
    pattern: /write|edit|수정|추가|생성|create|implement|구현|작성|fix|고치/i,
  },
  // planning
  {
    status: "planning",
    pattern: /plan|계획|설계|구조|architect|design|분석|파일.*확인|read|import|살펴보/i,
  },
  // waiting
  {
    status: "waiting",
    pattern: /wait|대기|승인|approval|input|입력/i,
  },
];

/** detail에서 사용할 최대 문자 수 */
const MAX_DETAIL_LENGTH = 80;

// ─── Emit Callback Types ───

/** progress:thinking 이벤트 콜백 */
export interface OnThinkingCallback {
  (event: ProgressThinkingEvent): void;
}

/** progress:status 이벤트 콜백 */
export interface OnStatusCallback {
  (event: ProgressStatusEvent): void;
}

/** ReasoningProgressAdapter 생성 설정 */
export interface ReasoningAdapterConfig {
  /** 에이전트 ID */
  agentId: string;
  /** 에이전트 역할 */
  role: AgentRole;
  /** progress:thinking 이벤트 콜백 */
  onThinking: OnThinkingCallback;
  /** progress:status 이벤트 콜백 */
  onStatus: OnStatusCallback;
  /** 디바운스 간격 (ms, 기본 1000) */
  debounceMs?: number;
}

// ─── ReasoningProgressAdapter ───

/**
 * LLM의 reasoning/thinking delta를 실시간 progress 이벤트로 변환하는 어댑터.
 *
 * - 모든 delta는 즉시 `progress:thinking` 이벤트로 발행
 * - 버퍼에 축적된 텍스트를 패턴 매칭으로 분석
 * - 1초 디바운스로 `progress:status` 이벤트 발행 (노이즈 방지)
 *
 * @example
 * ```typescript
 * const adapter = new ReasoningProgressAdapter({
 *   agentId: "coder-1",
 *   role: "coder",
 *   onThinking: (event) => bus.emit(sessionId, event),
 *   onStatus: (event) => bus.emit(sessionId, event),
 *   debounceMs: 1000,
 * });
 *
 * // LLM 스트리밍 콜백에서
 * for await (const chunk of llmStream) {
 *   if (chunk.reasoning) {
 *     adapter.onDelta(chunk.reasoning);
 *   }
 * }
 *
 * // 스트리밍 종료 시
 * adapter.flush();
 * ```
 */
export class ReasoningProgressAdapter {
  private readonly agentId: string;
  private readonly role: AgentRole;
  private readonly onThinking: OnThinkingCallback;
  private readonly onStatus: OnStatusCallback;
  private readonly debounceMs: number;

  /** 상태 추론용 텍스트 버퍼 */
  private buffer = "";
  /** 마지막 status 이벤트 발행 시각 */
  private lastEmitTs = 0;
  /** 마지막으로 발행한 상태 (중복 방지) */
  private lastStatus: ProgressStatusEvent["status"] | null = null;

  constructor(config: ReasoningAdapterConfig) {
    this.agentId = config.agentId;
    this.role = config.role;
    this.onThinking = config.onThinking;
    this.onStatus = config.onStatus;
    this.debounceMs = config.debounceMs ?? 1000;
  }

  /**
   * LLM에서 수신된 reasoning delta를 처리한다.
   *
   * 1. 즉시 `progress:thinking` 이벤트 발행 (원문 스트리밍)
   * 2. 버퍼에 축적
   * 3. 디바운스 간격 경과 시 상태 추론 + `progress:status` 발행
   *
   * @param delta reasoning/thinking 텍스트 조각
   */
  onDelta(delta: string): void {
    // 1. thinking 원문은 항상 즉시 스트리밍
    const thinkingEvent: ProgressThinkingEvent = {
      kind: "progress:thinking",
      agentId: this.agentId,
      delta,
    };
    this.onThinking(thinkingEvent);

    // 2. 버퍼 축적
    this.buffer += delta;

    // 3. 디바운스 체크 — 간격 미충족 시 스킵
    const now = Date.now();
    if (now - this.lastEmitTs < this.debounceMs) return;

    // 4. 상태 추론 시도
    this.tryEmitStatus(now);
  }

  /**
   * 스트리밍 종료 시 버퍼에 남은 내용으로 마지막 상태를 발행한다.
   * 디바운스를 무시하고 즉시 발행한다.
   */
  flush(): void {
    if (this.buffer.length === 0) return;
    this.tryEmitStatus(Date.now(), /* force */ true);
  }

  /**
   * 어댑터 상태를 초기화한다.
   * 새로운 LLM 호출 시작 시 호출한다.
   */
  reset(): void {
    this.buffer = "";
    this.lastEmitTs = 0;
    this.lastStatus = null;
  }

  // ─── Private ───

  /**
   * 버퍼 텍스트에서 상태를 추론하고 변경된 경우 이벤트를 발행한다.
   *
   * @param now 현재 시각 (epoch ms)
   * @param force 디바운스 무시 여부
   */
  private tryEmitStatus(now: number, force = false): void {
    const inferred = this.inferStatus(this.buffer);
    if (!inferred) return;

    // 같은 상태의 반복 발행 방지 (force 모드에서는 허용)
    if (!force && inferred.status === this.lastStatus) return;

    this.lastEmitTs = now;
    this.lastStatus = inferred.status;
    this.buffer = "";

    const statusEvent: ProgressStatusEvent = {
      kind: "progress:status",
      agentId: this.agentId,
      role: this.role,
      status: inferred.status,
      detail: inferred.detail,
    };

    this.onStatus(statusEvent);
  }

  /**
   * 텍스트에서 에이전트의 현재 활동 상태를 패턴 매칭으로 추론한다.
   *
   * @param text 분석할 텍스트
   * @returns 추론된 상태 또는 null (매칭 실패 시)
   */
  private inferStatus(text: string): InferredStatus | null {
    if (text.length === 0) return null;

    for (const { status, pattern } of STATUS_PATTERNS) {
      if (pattern.test(text)) {
        return {
          status,
          detail: text.slice(-MAX_DETAIL_LENGTH).trim(),
        };
      }
    }

    return null;
  }
}
