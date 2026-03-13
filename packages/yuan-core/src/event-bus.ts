/**
 * @module event-bus
 * @description HybridEventBus — 3계층 이벤트 전파 시스템.
 *
 * Layer 1: Process EventEmitter (CLI/Desktop, 0ms 레이턴시)
 * Layer 2: Session EventBus (Web/Mobile, ~1ms)
 * Layer 3: Team Broadcast (팀 모드, Redis Pub/Sub, ~5ms)
 *
 * 기능:
 * - EventEmitter 기반 로컬 이벤트 (Layer 1+2)
 * - 선택적 Redis 연동 (Layer 3, 팀 모드)
 * - 시퀀스 번호 기반 이벤트 버퍼링 (SSE replay)
 * - subscribe/emit/replay/broadcast
 * - 최대 버퍼 500 이벤트
 * - 팀 이벤트 필터 (progress:* 와 team:* 만 Redis로 전파)
 */

import { EventEmitter } from "node:events";
import type { BusEvent } from "./types.js";

// ─── Public Types ───

/** HybridEventBus 생성 설정 */
export interface EventBusConfig {
  /** 세션별 이벤트 버퍼 최대 크기 (기본 500) */
  maxBuffer?: number;
  /** Redis URL (팀 모드에서만 필요, 미지정 시 로컬 전용) */
  redisUrl?: string;
}

/** 시퀀스 번호 + 타임스탬프가 추가된 이벤트 */
export type StampedEvent = BusEvent & {
  /** 세션 내 순서 번호 (1부터 시작) */
  seq: number;
  /** 이벤트 발행 시각 (epoch ms) */
  ts: number;
};

/** 이벤트 리스너 함수 시그니처 */
export interface EventListener {
  (event: StampedEvent): void;
}

/** 구독 해제 함수 */
export type Unsubscribe = () => void;

// ─── Redis 추상 인터페이스 (ioredis 없이 동작하기 위해) ───

/** Redis Pub/Sub 래퍼 인터페이스 — 실제 ioredis를 느슨하게 연결 */
interface RedisPubSubAdapter {
  /** 채널에 메시지 발행 */
  publish(channel: string, message: string): Promise<void>;
  /** 채널 구독 + 리스너 등록 */
  subscribe(channel: string, listener: (message: string) => void): Unsubscribe;
  /** 연결 해제 */
  disconnect(): Promise<void>;
}

// ─── Redis 팩토리 (동적 import) ───

/**
 * ioredis가 설치된 환경에서만 Redis 어댑터를 생성.
 * 설치되지 않은 경우 null을 반환하며, 팀 모드는 비활성화된다.
 */
async function createRedisAdapter(
  redisUrl: string,
): Promise<RedisPubSubAdapter | null> {
  try {
    const ioredis = await import("ioredis");
    // ioredis exports vary between CJS/ESM — handle both shapes
    const RedisClass = (
      typeof ioredis.default === "function"
        ? ioredis.default
        : ioredis
    ) as unknown as new (url: string) => {
      publish(channel: string, message: string): Promise<number>;
      subscribe(channel: string): Promise<number>;
      unsubscribe(channel: string): Promise<number>;
      on(event: string, listener: (...args: string[]) => void): void;
      off(event: string, listener: (...args: string[]) => void): void;
      quit(): Promise<"OK">;
    };

    const pub = new RedisClass(redisUrl);
    const sub = new RedisClass(redisUrl);
    const subscriptions = new Map<string, (channel: string, message: string) => void>();

    return {
      async publish(channel: string, message: string): Promise<void> {
        await pub.publish(channel, message);
      },

      subscribe(
        channel: string,
        listener: (message: string) => void,
      ): Unsubscribe {
const handler = (ch: string, msg: string) => {
  if (ch === channel) listener(msg);
};

subscriptions.set(channel, handler);

sub.subscribe(channel);
sub.on("message", handler);

return () => {
  sub.off("message", handler);
  subscriptions.delete(channel);
  sub.unsubscribe(channel);
};
      },

      async disconnect(): Promise<void> {
        subscriptions.clear();
        await Promise.all([pub.quit(), sub.quit()]);
      },
    };
  } catch {
    // ioredis가 설치되지 않은 환경 — 팀 모드 비활성화
    return null;
  }
}

// ─── 팀 이벤트 필터 ───

/** Redis로 전파할 이벤트 종류 prefix 목록 */
const TEAM_EVENT_PREFIXES = [
  "progress:",
  "team:",
  "agent:completed",
  "agent:error",
] as const;

/** 해당 이벤트가 팀 채널로 전파되어야 하는지 판별 */
function isTeamEvent(kind: string): boolean {
  return TEAM_EVENT_PREFIXES.some((prefix) => kind.startsWith(prefix));
}

// ─── HybridEventBus ───

/**
 * 3계층 하이브리드 이벤트 버스.
 *
 * - 로컬 EventEmitter로 Layer 1+2 처리 (0ms)
 * - 선택적 Redis Pub/Sub로 Layer 3 팀 브로드캐스트 (~5ms)
 * - 세션별 이벤트 버퍼로 SSE 재연결 시 replay 지원
 *
 * @example
 * ```typescript
 * const bus = new HybridEventBus({ maxBuffer: 500 });
 * await bus.init();
 *
 * const unsub = bus.subscribe("session-1", (event) => {
 *   console.log(event.kind, event.seq);
 * });
 *
 * bus.emit("session-1", { kind: "agent:start", goal: "Fix bug" });
 *
 * // SSE 재연결 시 replay
 * const missed = bus.replay("session-1", 5); // seq > 5인 이벤트
 *
 * unsub(); // 구독 해제
 * await bus.destroy();
 * ```
 */
export class HybridEventBus {
  private readonly local = new EventEmitter();
  private redis: RedisPubSubAdapter | null = null;
  private readonly redisUrl: string | undefined;
  private readonly maxBuffer: number;

  /** 세션별 이벤트 버퍼 (replay용) */
  private readonly buffers = new Map<string, StampedEvent[]>();
  /** 세션별 시퀀스 카운터 */
  private readonly seqCounters = new Map<string, number>();

  private initialized = false;

  constructor(config: EventBusConfig = {}) {
    this.maxBuffer = config.maxBuffer ?? 500;
    this.redisUrl = config.redisUrl;

    // EventEmitter 리스너 한도를 넉넉하게 설정 (세션별 구독자)
    this.local.setMaxListeners(100);
  }

  // ─── Lifecycle ───

  /**
   * 이벤트 버스 초기화.
   * Redis URL이 설정된 경우 연결을 시도한다.
   * Redis 연결 실패 시에도 로컬 모드로 동작한다.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    if (this.redisUrl) {
      this.redis = await createRedisAdapter(this.redisUrl);
    }

    this.initialized = true;
  }

  /**
   * 이벤트 버스 종료.
   * Redis 연결 해제 + 버퍼 클리어.
   */
  async destroy(): Promise<void> {
    if (this.redis) {
      await this.redis.disconnect();
      this.redis = null;
    }

    this.buffers.clear();
    this.seqCounters.clear();
    this.local.removeAllListeners();
    this.initialized = false;
  }

  /** 팀 모드(Redis) 활성화 여부 */
  get isTeamMode(): boolean {
    return this.redis !== null;
  }

  // ─── Emit ───

  /**
   * 세션에 이벤트를 발행한다.
   *
   * 1. 시퀀스 번호 + 타임스탬프 부여
   * 2. 로컬 EventEmitter로 즉시 전파 (Layer 1+2)
   * 3. 버퍼에 저장 (SSE replay용)
   * 4. 팀 이벤트 필터 통과 시 Redis 발행 (Layer 3)
   *
   * @param sessionId 세션 ID
   * @param event 발행할 BusEvent
   * @returns 부여된 시퀀스 번호
   */
  emit(sessionId: string, event: BusEvent): number {
  if (!this.initialized) {
    throw new Error("HybridEventBus not initialized. Call init() first.");
  }
    const seq = this.nextSeq(sessionId);
    const stamped: StampedEvent = {
      ...event,
      seq,
      ts: Date.now(),
    } as StampedEvent;

    // Layer 1+2: 로컬 즉시 전파
    this.local.emit(`session:${sessionId}`, stamped);

    // 버퍼에 저장
    this.bufferEvent(sessionId, stamped);

    // Layer 3: 팀 모드 — 필터된 이벤트만 Redis로
    if (this.redis && isTeamEvent(event.kind)) {
      // fire-and-forget (Redis 발행 실패가 로컬 전파를 막지 않음)
      this.redis.publish(
        `team:${sessionId}`,
        JSON.stringify(stamped),
      ).catch(() => {
        // Redis 발행 실패는 무시 (로컬 전파는 이미 완료)
      });
    }

    return seq;
  }

  // ─── Subscribe ───

  /**
   * 세션의 이벤트를 구독한다 (Layer 1+2 로컬).
   *
   * @param sessionId 구독할 세션 ID
   * @param listener 이벤트 리스너
   * @returns 구독 해제 함수
   */
  subscribe(sessionId: string, listener: EventListener): Unsubscribe {
    this.local.on(`session:${sessionId}`, listener);
    return () => {
      this.local.off(`session:${sessionId}`, listener);
    };
  }

  // ─── Replay ───

  /**
   * SSE 재연결 시 놓친 이벤트를 재전송한다.
   *
   * @param sessionId 세션 ID
   * @param fromSeq 이 시퀀스 이후의 이벤트만 반환 (exclusive)
   * @returns 놓친 이벤트 배열
   */
  replay(sessionId: string, fromSeq: number): StampedEvent[] {
    const buffer = this.buffers.get(sessionId);
    if (!buffer) return [];
    return [...buffer].filter((e) => e.seq > fromSeq);
  }

  // ─── Team Broadcast (Layer 3) ───

  /**
   * 워크스페이스 채널을 구독한다 (팀 모드, Redis 기반).
   *
   * @param workspaceId 워크스페이스 ID
   * @param listener 이벤트 리스너
   * @returns 구독 해제 함수
   * @throws Redis가 활성화되지 않은 경우 에러
   */
  subscribeWorkspace(
    workspaceId: string,
    listener: EventListener,
  ): Unsubscribe {
    if (!this.redis) {
      throw new Error("Team mode requires Redis — provide redisUrl in config");
    }

    return this.redis.subscribe(
      `workspace:${workspaceId}`,
      (message: string) => {
        try {
          const event = JSON.parse(message) as StampedEvent;
          listener(event);
        } catch {
          // 파싱 실패한 메시지는 무시
        }
      },
    );
  }

  /**
   * 팀 채널로 이벤트를 브로드캐스트한다 (Redis Pub/Sub).
   * 로컬 세션 이벤트와 별도로, 워크스페이스 전체에 발행.
   *
   * @param workspaceId 워크스페이스 ID
   * @param event 브로드캐스트할 이벤트
   */
  async broadcast(workspaceId: string, event: BusEvent): Promise<void> {
    if (!this.redis) {
      throw new Error("Team mode requires Redis — provide redisUrl in config");
    }

    const stamped: StampedEvent = {
      ...event,
      seq: 0, // 워크스페이스 브로드캐스트는 세션 seq 없음
      ts: Date.now(),
    } as StampedEvent;

    await this.redis.publish(
      `workspace:${workspaceId}`,
      JSON.stringify(stamped),
    );
  }

  // ─── Session Cleanup ───

  /**
   * 세션의 버퍼와 시퀀스 카운터를 정리한다.
   * 세션 종료 시 호출하여 메모리를 해제한다.
   *
   * @param sessionId 정리할 세션 ID
   */
  clearSession(sessionId: string): void {
    this.buffers.delete(sessionId);
    this.seqCounters.delete(sessionId);
    this.local.removeAllListeners(`session:${sessionId}`);
  }

  /**
   * 현재 버퍼에 저장된 세션의 이벤트 수를 반환한다.
   *
   * @param sessionId 세션 ID
   * @returns 버퍼된 이벤트 수
   */
  getBufferSize(sessionId: string): number {
    return this.buffers.get(sessionId)?.length ?? 0;
  }

  /**
   * 세션의 현재 시퀀스 번호를 반환한다.
   *
   * @param sessionId 세션 ID
   * @returns 현재 시퀀스 번호 (이벤트가 없으면 0)
   */
  getCurrentSeq(sessionId: string): number {
    return this.seqCounters.get(sessionId) ?? 0;
  }

  // ─── Private Helpers ───

  /** 세션의 다음 시퀀스 번호를 발급한다 */
  private nextSeq(sessionId: string): number {
    const current = this.seqCounters.get(sessionId) ?? 0;
    const next = current + 1;
    this.seqCounters.set(sessionId, next);
    return next;
  }

  /** 이벤트를 세션 버퍼에 저장한다 (maxBuffer 초과 시 오래된 이벤트 삭제) */
  private bufferEvent(sessionId: string, event: StampedEvent): void {
    let buffer = this.buffers.get(sessionId);
    if (!buffer) {
      buffer = [];
      this.buffers.set(sessionId, buffer);
    }

    buffer.push(event);

    // 버퍼 크기 제한 — 초과분 앞에서 삭제
    if (buffer.length > this.maxBuffer) {
      const excess = buffer.length - this.maxBuffer;
      buffer.splice(0, excess);
    }
  }
}
