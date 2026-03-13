/**
 * @module session-persistence
 * @description 세션 영속성 — 설계 문서 섹션 7.5 구현.
 *
 * 에이전트 세션 상태를 디스크에 주기적으로 저장하고,
 * `yuan resume`으로 마지막 세션을 이어갈 수 있도록 지원.
 *
 * 저장 위치: ~/.yuan/sessions/<sessionId>/
 * 저장 항목:
 * - state.json: 세션 메타데이터 (id, 시작시간, workDir, provider, model)
 * - messages.json: 대화 히스토리
 * - plan.json: 현재 실행 계획
 * - checkpoint.json: 마지막 체크포인트 (iteration, token usage)
 * - plan-graph.json: PlanGraphManager 런타임 상태 (resume용)
 * - runtime-state.json: StateMachine phase + stepIndex (resume용)
 * - context-budget.json: ContextBudgetManager 스냅샷 (resume용)
 * - learnings.json: SelfReflection 학습 기록 (resume용)
 * - monologue.json: SelfReflection 내적 독백 (resume용)
 *
 * 체크포인트 주기: 매 iteration 완료 시
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Message, TokenUsage } from "./types.js";
import type { HierarchicalPlan } from "./hierarchical-planner.js";
import {
  YUAN_DIRNAME,
  YUAN_SESSIONS_DIRNAME,
  YUAN_LAST_SESSION_FILENAME,
} from "./constants.js";
// ─── Constants ────────────────────────────────────────────────────

const DEFAULT_BASE_DIR = path.join(os.homedir(), ".yuan", "sessions");
const LAST_SESSION_FILE = path.join(os.homedir(), ".yuan", "last-session");
const DEFAULT_MAX_AGE_DAYS = 30;

// ─── Types ────────────────────────────────────────────────────────

/** 세션 상태 (디스크 저장 기준) */
export type SessionStatus = "running" | "paused" | "completed" | "crashed";

/** 세션 스냅샷 — 경량 메타데이터 (목록 표시용) */
export interface SessionSnapshot {
  /** 세션 고유 ID */
  id: string;
  /** 생성 시각 (ISO 8601) */
  createdAt: string;
  /** 마지막 업데이트 시각 (ISO 8601) */
  updatedAt: string;
  /** 작업 디렉토리 */
  workDir: string;
  /** LLM 프로바이더 */
  provider: string;
  /** 사용 모델 */
  model: string;
  /** 세션 상태 */
  status: SessionStatus;
  /** 현재 iteration 수 */
  iteration: number;
  /** 토큰 사용량 */
  tokenUsage: { input: number; output: number };
  /** 대화 메시지 수 */
  messageCount: number;
  changedFiles?: string[];
  /** 작업 요약 (자동 생성) */
  summary?: string;
}

/** 세션 전체 데이터 — 복구에 필요한 모든 정보 */
export interface SessionData {
  /** 세션 메타데이터 */
  snapshot: SessionSnapshot;
  /** 대화 히스토리 */
  messages: Message[];
  /** 현재 실행 계획 (있으면) */
plan: HierarchicalPlan | null;
  /** 변경된 파일 목록 */
  changedFiles: string[];

  // ─── Runtime State for Resume (optional, new fields) ───

  /** PlanGraphManager.toJSON() 출력 — 계획 그래프의 런타임 상태 */
  planGraphState?: unknown;
  /** AgentPhase enum 값 — 상태 기계의 현재 단계 */
  stateMachinePhase?: string;
  /** 현재 실행 중인 step 인덱스 */
  stepIndex?: number;
  /** ContextBudgetManager.toJSON() 출력 — 컨텍스트 예산 상태 */
  contextBudgetState?: unknown;
  /** SelfReflection 학습 기록 */
  reflectionLearnings?: unknown[];
  /** SelfReflection 내적 독백 (최근 N개) */
  reflectionMonologue?: unknown[];
}

/** 체크포인트 데이터 — 매 iteration 완료 시 저장 */
export interface CheckpointData {
  /** 현재 iteration 인덱스 */
  iteration: number;
  /** 누적 토큰 사용량 */
  tokenUsage: { input: number; output: number };
  /** 체크포인트 시각 (ISO 8601) */
  timestamp: string;
  /** 변경된 파일 목록 */
  changedFiles: string[];
  /** 마지막 도구 호출 요약 */
  lastToolCall?: string;
}

// ─── SessionPersistence Class ─────────────────────────────────────

/**
 * SessionPersistence — 세션 저장/복구 엔진.
 *
 * 파일 구조:
 * ```
 * ~/.yuan/sessions/
 * ├── <sessionId>/
 * │   ├── state.json          ← SessionSnapshot
 * │   ├── messages.json       ← Message[]
 * │   ├── plan.json           ← ExecutionPlan | null
 * │   ├── checkpoint.json     ← CheckpointData
 * │   ├── plan-graph.json     ← PlanGraphManager 런타임 상태 (optional)
 * │   ├── runtime-state.json  ← StateMachine phase + stepIndex (optional)
 * │   ├── context-budget.json ← ContextBudgetManager 스냅샷 (optional)
 * │   ├── learnings.json      ← SelfReflection 학습 기록 (optional)
 * │   └── monologue.json      ← SelfReflection 내적 독백 (optional)
 * └── last-session            ← 마지막 세션 ID
 * ```
 */
export class SessionPersistence {
  private readonly baseDir: string;
 private readonly lastSessionFile: string;
  /**
+   * @param baseDir 세션 저장 기본 디렉토리
+   * @param workspaceDir workspace 루트 (미지정 시 process.cwd() 기준)
   */
  constructor(baseDir?: string, workspaceDir?: string) {
    const resolvedWorkspaceDir = workspaceDir ?? process.cwd();
    const yuanDir = path.join(resolvedWorkspaceDir, YUAN_DIRNAME);

    this.baseDir =
      baseDir ?? path.join(yuanDir, YUAN_SESSIONS_DIRNAME);
    this.lastSessionFile = path.join(yuanDir, YUAN_LAST_SESSION_FILENAME);
    this.ensureDir(this.baseDir);
    this.ensureDir(path.dirname(this.lastSessionFile));
  }

  // ─── Save ───

  /**
   * 세션 전체 데이터를 디스크에 저장.
   * state.json, messages.json, plan.json을 각각 저장하고
   * last-session 파일을 업데이트한다.
   *
   * @param sessionId 세션 ID
   * @param data 저장할 세션 데이터
   */
  async save(sessionId: string, data: SessionData): Promise<void> {
    const sessionDir = this.sessionDir(sessionId);
    this.ensureDir(sessionDir);

    // 업데이트 시각 갱신
    data.snapshot.updatedAt = new Date().toISOString();

    // 병렬 저장 — 기본 데이터
    const writes: Promise<void>[] = [
      this.writeJson(path.join(sessionDir, "state.json"), data.snapshot),
      this.writeJson(path.join(sessionDir, "messages.json"), data.messages),
      this.writeJson(path.join(sessionDir, "plan.json"), data.plan),
    ];

    // 런타임 상태 저장 (있는 경우에만)
    if (data.planGraphState !== undefined) {
      writes.push(
        this.writeJson(path.join(sessionDir, "plan-graph.json"), data.planGraphState),
      );
    }
    if (data.stateMachinePhase !== undefined || data.stepIndex !== undefined) {
      writes.push(
        this.writeJson(path.join(sessionDir, "runtime-state.json"), {
          stateMachinePhase: data.stateMachinePhase,
          stepIndex: data.stepIndex,
        }),
      );
    }
    if (data.contextBudgetState !== undefined) {
      writes.push(
        this.writeJson(path.join(sessionDir, "context-budget.json"), data.contextBudgetState),
      );
    }
    if (data.reflectionLearnings !== undefined) {
      writes.push(
        this.writeJson(path.join(sessionDir, "learnings.json"), data.reflectionLearnings),
      );
    }
    if (data.reflectionMonologue !== undefined) {
      writes.push(
        this.writeJson(path.join(sessionDir, "monologue.json"), data.reflectionMonologue),
      );
    }

    await Promise.all(writes);

    // 마지막 세션 ID 기록
    await this.setLastSessionId(sessionId);
  }

  // ─── Restore ───

  /**
   * 세션을 디스크에서 복구.
   * state.json, messages.json, plan.json을 읽어 SessionData를 구성.
   *
   * @param sessionId 복구할 세션 ID
   * @returns 세션 데이터 (없거나 손상되면 null)
   */
  async restore(sessionId: string): Promise<SessionData | null> {
    const sessionDir = this.sessionDir(sessionId);

    if (!fs.existsSync(sessionDir)) {
      return null;
    }

    try {
      // 기본 데이터 + 런타임 상태를 병렬 로드
 const [
   snapshot,
   messages,
   plan,
   checkpoint,
   planGraphState,
   runtimeState,
   contextBudgetState,
   reflectionLearnings,
   reflectionMonologue,
 ] = await Promise.all([
   this.readJson<SessionSnapshot>(path.join(sessionDir, "state.json")),
   this.readJson<Message[]>(path.join(sessionDir, "messages.json")),
   this.readJson<HierarchicalPlan | null>(path.join(sessionDir, "plan.json")),
   this.readJson<CheckpointData>(path.join(sessionDir, "checkpoint.json")),
   this.readJson<unknown>(path.join(sessionDir, "plan-graph.json")),
   this.readJson<{ stateMachinePhase?: string; stepIndex?: number }>(path.join(sessionDir, "runtime-state.json")),
   this.readJson<unknown>(path.join(sessionDir, "context-budget.json")),
   this.readJson<unknown[]>(path.join(sessionDir, "learnings.json")),
   this.readJson<unknown[]>(path.join(sessionDir, "monologue.json")),
 ]);
      if (!snapshot) return null;

      const data: SessionData = {
        snapshot,
        messages: messages ?? [],
        plan: plan ?? null,
        changedFiles: checkpoint?.changedFiles ?? [],
      };
// reasoning replay protection
if ((globalThis as any).__yuan_reasoning_seen) {
  (globalThis as any).__yuan_reasoning_seen.clear();
}
      // 런타임 상태 복원 (파일이 없으면 undefined로 남음)
      if (planGraphState !== null) {
        data.planGraphState = planGraphState;
      }
      if (runtimeState !== null) {
        data.stateMachinePhase = runtimeState.stateMachinePhase;
        data.stepIndex = runtimeState.stepIndex;
      }
      if (contextBudgetState !== null) {
        data.contextBudgetState = contextBudgetState;
      }
      if (reflectionLearnings !== null) {
        data.reflectionLearnings = reflectionLearnings;
      }
      if (reflectionMonologue !== null) {
        data.reflectionMonologue = reflectionMonologue;
      }

      return data;
    } catch {
      // 손상된 세션 파일
      return null;
    }
  }

  // ─── Last Session ───

  /**
   * 마지막 세션 ID를 반환.
   *
   * @returns 마지막 세션 ID (없으면 null)
   */
  async getLastSessionId(): Promise<string | null> {
    try {
      if (fs.existsSync(this.lastSessionFile)) {
        const content = await fs.promises.readFile(
          this.lastSessionFile,
          "utf-8",
        );
        return content.trim() || null;
      }
    } catch {
      // Ignore
    }
    return null;
  }

  // ─── List Sessions ───

  /**
   * 저장된 세션 목록을 반환 (최근 순).
   *
   * @param limit 최대 반환 수 (기본 20)
   * @returns 세션 스냅샷 배열
   */
  async listSessions(limit = 20): Promise<SessionSnapshot[]> {
    const snapshots: SessionSnapshot[] = [];

    try {
      const entries = await fs.promises.readdir(this.baseDir, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const stateFile = path.join(
          this.baseDir,
          entry.name,
          "state.json",
        );
        const snapshot = await this.readJson<SessionSnapshot>(stateFile);
        if (snapshot) {
          snapshots.push(snapshot);
        }
      }
    } catch {
      // Sessions dir doesn't exist yet
    }

    // 최근 순 정렬
    snapshots.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    return snapshots.slice(0, limit);
  }

  // ─── Checkpoint ───

  /**
   * 체크포인트를 저장 (매 iteration 완료 시 호출).
   * 경량 저장 — checkpoint.json과 state.json만 업데이트.
   *
   * @param sessionId 세션 ID
   * @param checkpoint 체크포인트 데이터
   */
  async checkpoint(
    sessionId: string,
    checkpoint: CheckpointData,
  ): Promise<void> {
    const sessionDir = this.sessionDir(sessionId);
    this.ensureDir(sessionDir);

    // 체크포인트 저장
    await this.writeJson(
      path.join(sessionDir, "checkpoint.json"),
      checkpoint,
    );

    // state.json의 iteration과 tokenUsage도 업데이트
    const stateFile = path.join(sessionDir, "state.json");
    const snapshot = await this.readJson<SessionSnapshot>(stateFile);
    if (snapshot) {
      snapshot.iteration = checkpoint.iteration;
      snapshot.tokenUsage = checkpoint.tokenUsage;
      snapshot.updatedAt = checkpoint.timestamp;
if (checkpoint.changedFiles) {
  snapshot.changedFiles = checkpoint.changedFiles;
}
      await this.writeJson(stateFile, snapshot);
    }
  }

  // ─── Runtime State Checkpoint ───

  /**
   * 런타임 상태를 부분 저장한다 (매 step 완료 시 호출 가능).
   * 기존 저장된 데이터와 병합하여 새로운 필드만 업데이트한다.
   * 기본 checkpoint.json도 함께 업데이트한다.
   *
   * @param sessionId 세션 ID
   * @param partial 저장할 런타임 상태 (SessionData의 부분 집합)
   */
  async saveRuntimeState(
    sessionId: string,
    partial: Partial<SessionData>,
  ): Promise<void> {
    const sessionDir = this.sessionDir(sessionId);
    this.ensureDir(sessionDir);

    const writes: Promise<void>[] = [];

    if (partial.planGraphState !== undefined) {
      writes.push(
        this.writeJson(path.join(sessionDir, "plan-graph.json"), partial.planGraphState),
      );
    }
    if (partial.stateMachinePhase !== undefined || partial.stepIndex !== undefined) {
      // 기존 runtime-state.json을 읽어 병합
      const existing = await this.readJson<Record<string, unknown>>(
        path.join(sessionDir, "runtime-state.json"),
      );
      const merged = {
        ...(existing ?? {}),
        ...(partial.stateMachinePhase !== undefined
          ? { stateMachinePhase: partial.stateMachinePhase }
          : {}),
        ...(partial.stepIndex !== undefined ? { stepIndex: partial.stepIndex } : {}),
      };
      writes.push(
        this.writeJson(path.join(sessionDir, "runtime-state.json"), merged),
      );
    }
    if (partial.contextBudgetState !== undefined) {
      writes.push(
        this.writeJson(path.join(sessionDir, "context-budget.json"), partial.contextBudgetState),
      );
    }
    if (partial.reflectionLearnings !== undefined) {
      writes.push(
        this.writeJson(path.join(sessionDir, "learnings.json"), partial.reflectionLearnings),
      );
    }
    if (partial.reflectionMonologue !== undefined) {
      writes.push(
        this.writeJson(path.join(sessionDir, "monologue.json"), partial.reflectionMonologue),
      );
    }
    if (partial.messages !== undefined) {
      writes.push(
        this.writeJson(path.join(sessionDir, "messages.json"), partial.messages),
      );
    }
    if (partial.plan !== undefined) {
      writes.push(
        this.writeJson(path.join(sessionDir, "plan.json"), partial.plan),
      );
    }

    if (writes.length > 0) {
      await Promise.all(writes);
    }

    // state.json의 updatedAt 갱신
    const stateFile = path.join(sessionDir, "state.json");
    const snapshot = await this.readJson<SessionSnapshot>(stateFile);
    if (snapshot) {
      snapshot.updatedAt = new Date().toISOString();
      await this.writeJson(stateFile, snapshot);
    }
  }

  // ─── Cleanup ───

  /**
   * 오래된 세션을 정리.
   *
   * @param maxAgeDays 최대 보존 기간 (일, 기본 30)
   * @returns 삭제된 세션 수
   */
  async cleanup(maxAgeDays = DEFAULT_MAX_AGE_DAYS): Promise<number> {
    let deleted = 0;
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    try {
      const entries = await fs.promises.readdir(this.baseDir, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const stateFile = path.join(
          this.baseDir,
          entry.name,
          "state.json",
        );
        const snapshot = await this.readJson<SessionSnapshot>(stateFile);

        if (!snapshot) {
          // 손상된 세션 디렉토리 — 삭제
          await fs.promises.rm(
            path.join(this.baseDir, entry.name),
            { recursive: true, force: true },
          );
          deleted++;
          continue;
        }

        const updatedAt = new Date(snapshot.updatedAt).getTime();
        if (updatedAt < cutoff) {
          await fs.promises.rm(
            path.join(this.baseDir, entry.name),
            { recursive: true, force: true },
          );
          deleted++;
        }
      }
    } catch {
      // Ignore
    }

    return deleted;
  }

  // ─── Status Management ───

  /**
   * 세션 상태를 업데이트.
   *
   * @param sessionId 세션 ID
   * @param status 새 상태
   */
  async updateStatus(
    sessionId: string,
    status: SessionStatus,
  ): Promise<void> {
    const stateFile = path.join(this.sessionDir(sessionId), "state.json");
    const snapshot = await this.readJson<SessionSnapshot>(stateFile);
    if (snapshot) {
      snapshot.status = status;
      snapshot.updatedAt = new Date().toISOString();
      await this.writeJson(stateFile, snapshot);
    }
  }

  /**
   * 크래시된 세션을 감지.
   * status가 'running'이면서 마지막 업데이트가 5분 이상 전인 세션.
   *
   * @returns 크래시로 판단되는 세션 목록
   */
  async detectCrashedSessions(): Promise<SessionSnapshot[]> {
    const crashed: SessionSnapshot[] = [];
    const threshold = Date.now() - 5 * 60 * 1000; // 5분

    const sessions = await this.listSessions(100);
    for (const session of sessions) {
      if (
        session.status === "running" &&
        new Date(session.updatedAt).getTime() < threshold
      ) {
        crashed.push(session);
      }
    }

    return crashed;
  }

  // ─── Helpers ───

  private sessionDir(sessionId: string): string {
    if (!/^[a-zA-Z0-9\-_]+$/.test(sessionId)) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }
    return path.join(this.baseDir, sessionId);
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private async setLastSessionId(sessionId: string): Promise<void> {
    const dir = path.dirname(this.lastSessionFile);
    this.ensureDir(dir);
   await fs.promises.writeFile(this.lastSessionFile, sessionId, "utf-8");
  }

  private async writeJson(filePath: string, data: unknown): Promise<void> {
    // Ensure parent directory exists before writing
    const dir = path.dirname(filePath);
    this.ensureDir(dir);
    // Atomic write: write to unique temp file then rename.
    // Use random suffix to prevent race conditions when multiple saves run concurrently.
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tmpPath = `${filePath}.${suffix}.tmp`;
    await fs.promises.writeFile(
      tmpPath,
      JSON.stringify(data, null, 2),
      "utf-8",
    );
    await fs.promises.rename(tmpPath, filePath);
  }

  private async readJson<T>(filePath: string): Promise<T | null> {
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = await fs.promises.readFile(filePath, "utf-8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
}
