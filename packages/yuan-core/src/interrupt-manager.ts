/**
 * @module interrupt-manager
 * @description 인터럽트 매니저 — 설계 문서 섹션 21.2 구현.
 *
 * CLI/Web/팀에서 에이전트에 전달되는 인터럽트를 처리한다.
 *
 * 인터럽트 유형:
 * - soft: 현재 도구 실행 취소 + 피드백 주입 → 에이전트 루프 계속
 * - hard: 모든 실행 즉시 중단 + 비상 체크포인트 + paused 상태
 * - pause: 에이전트 루프 일시 정지 (상태 유지)
 * - resume: 일시 정지된 에이전트 루프 재개
 *
 * EventEmitter를 확장하여 인터럽트 이벤트를 외부에 전파한다.
 */

import { EventEmitter } from "node:events";
import type { InterruptSignal, InterruptEvent, ContinuationCheckpoint } from "./types.js";

// ─── Event Types ─────────────────────────────────────────────────

/** InterruptManager가 발행하는 이벤트 맵 */
export interface InterruptManagerEvents {
  /** soft interrupt 발생 */
  "interrupt:soft": [signal: InterruptSignal];
  /** hard interrupt 발생 — 전체 중단 */
  "interrupt:hard": [signal: InterruptSignal];
  /** 일시 정지 */
  "interrupt:pause": [signal: InterruptSignal];
  /** 재개 */
  "interrupt:resume": [signal: InterruptSignal];
  /** 피드백 주입 요청 (agent loop이 수신) */
  "interrupt:feedback": [feedback: string];
  /** 비상 체크포인트 요청 (reflection/persistence가 수신) */
  "interrupt:emergency_checkpoint": [];
  /** 세션 상태 변경 요청 */
  "interrupt:status_change": [status: "paused" | "running"];
}

// ─── InterruptManager ────────────────────────────────────────────

/**
 * 인터럽트 매니저.
 *
 * 에이전트 실행 중 외부(CLI/Web/팀)에서 전달되는 인터럽트를 처리한다.
 * AbortController를 관리하여 현재 실행 중인 도구를 취소할 수 있다.
 *
 * @example
 * ```typescript
 * const im = new InterruptManager();
 *
 * // 도구 실행 시 AbortController 등록
 * const ac = new AbortController();
 * im.registerToolAbort(ac);
 * await shellExec(cmd, { signal: ac.signal });
 *
 * // soft interrupt: 현재 도구 취소 + 피드백 주입
 * im.interrupt({ type: "soft", feedback: "다른 방향으로", source: "cli" });
 *
 * // hard interrupt: 전체 중단
 * im.interrupt({ type: "hard", source: "web" });
 * ```
 */
export class InterruptManager extends EventEmitter {
  /** 현재 실행 중인 도구의 AbortController */
  private currentToolAbort: AbortController | null = null;

  /** 에이전트 루프 일시 정지 여부 */
  private paused = false;

  /** 인터럽트 히스토리 (디버깅/감사용, 최근 50개) */
  private readonly history: Array<{ signal: InterruptSignal; timestamp: number }> = [];
  private static readonly MAX_HISTORY = 50;

  /**
   * 인터럽트를 처리한다.
   *
   * @param signal - 인터럽트 시그널 (type, feedback, source, userId)
   */
  interrupt(signal: InterruptSignal): void {
    // 히스토리 기록
    this.recordHistory(signal);

    switch (signal.type) {
      case "soft":
        this.handleSoftInterrupt(signal);
        break;

      case "hard":
        this.handleHardInterrupt(signal);
        break;

      case "pause":
        this.handlePause(signal);
        break;

      case "resume":
        this.handleResume(signal);
        break;
    }
  }

  /**
   * 현재 실행 중인 도구의 AbortController를 등록한다.
   *
   * 도구 실행 시작 시 호출하여, soft/hard interrupt 시
   * 해당 도구를 취소할 수 있도록 한다.
   *
   * @param controller - 도구 실행에 사용되는 AbortController
   */
  registerToolAbort(controller: AbortController): void {
    this.currentToolAbort = controller;
  }

  /**
   * 현재 등록된 AbortController를 해제한다.
   *
   * 도구 실행 완료 후 호출하여, 다음 도구와 혼선을 방지한다.
   */
  clearToolAbort(): void {
    this.currentToolAbort = null;
  }

  /**
   * 에이전트 루프가 일시 정지 상태인지 확인한다.
   *
   * 에이전트 루프는 매 iteration 시작 시 이 값을 확인하고,
   * true이면 resume될 때까지 대기해야 한다.
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * 인터럽트 히스토리를 반환한다 (디버깅/감사용).
   *
   * @returns 최근 인터럽트 기록 (최대 50개)
   */
  getHistory(): ReadonlyArray<{ signal: InterruptSignal; timestamp: number }> {
    return this.history;
  }

  /**
   * 상태를 초기화한다.
   *
   * 새 세션 시작 시 호출하여 이전 상태를 정리한다.
   */
  reset(): void {
    this.currentToolAbort = null;
    this.paused = false;
    this.history.length = 0;
  }

  // ─── Private Handlers ────────────────────────────────────────

  /**
   * Soft interrupt 처리.
   *
   * 1. 현재 도구 실행 취소 (AbortController.abort())
   * 2. 피드백이 있으면 에이전트 컨텍스트에 주입
   * 3. 이벤트 발행 → 에이전트 루프는 계속 진행
   */
  private handleSoftInterrupt(signal: InterruptSignal): void {
    // 1. 현재 도구 실행 취소
    if (this.currentToolAbort && !this.currentToolAbort.signal.aborted) {
      this.currentToolAbort.abort();
    }
    this.currentToolAbort = null;

    // 2. 피드백 주입 요청
    if (signal.feedback) {
      this.emit("interrupt:feedback", `[유저 Interrupt] ${signal.feedback}`);
    }

    // 3. 이벤트 발행
    this.emit("interrupt:soft", signal);
  }

  /**
   * Hard interrupt 처리.
   *
   * 1. 모든 실행 즉시 중단 (도구 취소)
   * 2. 비상 체크포인트 요청 발행
   * 3. 세션 상태 → paused
   * 4. 이벤트 발행
   */
  private handleHardInterrupt(signal: InterruptSignal): void {
    // 1. 현재 도구 실행 취소
    if (this.currentToolAbort && !this.currentToolAbort.signal.aborted) {
      this.currentToolAbort.abort();
    }
    this.currentToolAbort = null;

    // 2. paused 상태로 전환
    this.paused = true;

    // 3. 비상 체크포인트 요청
    this.emit("interrupt:emergency_checkpoint");

    // 4. 세션 상태 변경 요청
    this.emit("interrupt:status_change", "paused");

    // 5. 이벤트 발행
    this.emit("interrupt:hard", signal);
  }

  /**
   * Pause 처리.
   *
   * 에이전트 루프를 일시 정지한다.
   * 상태는 유지되며, 현재 진행 중인 도구 실행은 완료될 수 있다.
   */
  private handlePause(signal: InterruptSignal): void {
    if (this.paused) return; // 이미 정지 상태

    this.paused = true;
    this.emit("interrupt:status_change", "paused");
    this.emit("interrupt:pause", signal);
  }

  /**
   * Resume 처리.
   *
   * 일시 정지된 에이전트 루프를 재개한다.
   */
  private handleResume(signal: InterruptSignal): void {
    if (!this.paused) return; // 이미 실행 중

    this.paused = false;
    this.emit("interrupt:status_change", "running");
    this.emit("interrupt:resume", signal);
  }

  /**
   * 인터럽트를 히스토리에 기록한다.
   * 최대 MAX_HISTORY개까지 유지하며, 초과 시 오래된 것부터 제거.
   */
  private recordHistory(signal: InterruptSignal): void {
    this.history.push({ signal, timestamp: Date.now() });
    if (this.history.length > InterruptManager.MAX_HISTORY) {
      this.history.shift();
    }
  }
}
