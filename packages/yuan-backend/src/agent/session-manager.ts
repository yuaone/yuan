/**
 * SessionManager — In-memory agent session tracking with event buffering
 * for SSE replay.
 *
 * Each session owns an EventEmitter for live subscribers and a capped
 * `eventBuffer` so that reconnecting SSE clients can replay missed events
 * via `getEventsSince(sessionId, lastSeq)`.
 *
 * @module
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionStatus =
  | "initializing"
  | "running"
  | "waiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "stopped";

export type AgentEventKind =
  | "agent:text_delta"
  | "agent:tool_call"
  | "agent:tool_result"
  | "agent:approval_needed"
  | "agent:approval_resolved"
  | "agent:iteration_start"
  | "agent:iteration_end"
  | "agent:thinking"
  | "agent:reasoning"
  | "agent:decision"
  | "agent:layer_enter"
  | "agent:error"
  | "agent:status_change"
  | "agent:done"
  | "agent:log";

export interface AgentEvent {
  kind: AgentEventKind;
  sessionId: string;
  runId: string;
  /** Monotonically increasing sequence number — used for SSE replay. */
  seq: number;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface PendingApproval {
  id: string;
  action: string;
  description: string;
  risk: "low" | "medium" | "high" | "critical";
  createdAt: number;
  timeoutMs: number;
}

export interface AgentSession {
  id: string;
  runId: string;
  userId: number;
  status: SessionStatus;
  goal: string;
  model: string;
  provider: string;
  workDir: string;
  createdAt: number;
  updatedAt: number;
  iterations: number;
  maxIterations: number;
  tokenUsage: { input: number; output: number };
  filesChanged: string[];
  pendingApproval: PendingApproval | null;
  error: string | null;
  /** Per-session EventEmitter — live SSE subscribers listen here. */
  emitter: EventEmitter;
  /** Capped ring-buffer of past events for SSE replay. */
  eventBuffer: AgentEvent[];
  /** Next sequence number to assign. */
  eventSeqCounter: number;
}

export interface CreateSessionConfig {
  userId: number;
  goal: string;
  model: string;
  provider: string;
  workDir: string;
  maxIterations: number;
  /** Optional pre-assigned session ID (e.g. from the client). */
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Plan limits
// ---------------------------------------------------------------------------

export interface PlanLimits {
  maxConcurrent: number;
  maxIterations: number;
  dailyRuns: number;
  maxTokensPerSession: number;
}

const PLAN_LIMITS: Record<string, PlanLimits> = {
  free: {
    maxConcurrent: 1,
    maxIterations: 25,
    dailyRuns: 10,
    maxTokensPerSession: 200_000,
  },
  pro: {
    maxConcurrent: 3,
    maxIterations: 100,
    dailyRuns: 100,
    maxTokensPerSession: 1_000_000,
  },
  team: {
    maxConcurrent: 5,
    maxIterations: 200,
    dailyRuns: 500,
    maxTokensPerSession: 2_000_000,
  },
  enterprise: {
    maxConcurrent: 10,
    maxIterations: 500,
    dailyRuns: 9999,
    maxTokensPerSession: 10_000_000,
  },
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum events kept in the per-session replay buffer. */
const MAX_EVENT_BUFFER = 500;

/** Sessions older than this with no activity are eligible for cleanup. */
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Daily run tracking
// ---------------------------------------------------------------------------

interface DailyRunEntry {
  count: number;
  /** UTC midnight timestamp after which the counter resets. */
  resetAt: number;
}

function nextMidnightUTC(): number {
  const now = new Date();
  const midnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  return midnight.getTime();
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private sessions = new Map<string, AgentSession>();
  private dailyRunCounts = new Map<string, DailyRunEntry>();

  // -----------------------------------------------------------------------
  // Create
  // -----------------------------------------------------------------------

  /** Create a new agent session and return it. */
  createSession(config: CreateSessionConfig): AgentSession {
    const id = config.sessionId ?? randomUUID();
    const now = Date.now();

    const session: AgentSession = {
      id,
      runId: randomUUID(),
      userId: config.userId,
      status: "initializing",
      goal: config.goal,
      model: config.model,
      provider: config.provider,
      workDir: config.workDir,
      createdAt: now,
      updatedAt: now,
      iterations: 0,
      maxIterations: config.maxIterations,
      tokenUsage: { input: 0, output: 0 },
      filesChanged: [],
      pendingApproval: null,
      error: null,
      emitter: new EventEmitter(),
      eventBuffer: [],
      eventSeqCounter: 0,
    };

    this.sessions.set(id, session);
    this.incrementDailyRun(config.userId);

    return session;
  }

  // -----------------------------------------------------------------------
  // Read
  // -----------------------------------------------------------------------

  /** Retrieve a session by ID. */
  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** List all sessions belonging to a user. */
  listSessions(userId: number): AgentSession[] {
    const result: AgentSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.userId === userId) {
        result.push(session);
      }
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // Update
  // -----------------------------------------------------------------------

  /**
   * Transition a session to a new status.
   *
   * Emits an `agent:status_change` event on the session's emitter.
   */
  updateStatus(sessionId: string, status: SessionStatus): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const prev = session.status;
    session.status = status;
    session.updatedAt = Date.now();

    this.emitEvent(sessionId, "agent:status_change", {
      prev,
      next: status,
    });
  }

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  /**
   * Push an event into the session's buffer and notify live listeners.
   *
   * The buffer is capped at {@link MAX_EVENT_BUFFER}; oldest events are
   * evicted when the cap is exceeded.
   */
  emitEvent(
    sessionId: string,
    kind: AgentEventKind,
    data: Record<string, unknown>,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const event: AgentEvent = {
      kind,
      sessionId,
      runId: session.runId,
      seq: session.eventSeqCounter++,
      timestamp: Date.now(),
      data,
    };

    // Append to buffer (ring-buffer eviction via batch splice — O(1) amortized)
    session.eventBuffer.push(event);
    if (session.eventBuffer.length > MAX_EVENT_BUFFER) {
      const excess = session.eventBuffer.length - MAX_EVENT_BUFFER;
      session.eventBuffer.splice(0, excess);
    }

    session.updatedAt = event.timestamp;

    // Notify live SSE subscribers
    session.emitter.emit("event", event);
  }

  /**
   * Return all buffered events whose `seq` is greater than `lastSeq`.
   *
   * Used by SSE clients reconnecting with `Last-Event-ID`.
   */
  getEventsSince(sessionId: string, lastSeq: number): AgentEvent[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return session.eventBuffer.filter((e) => e.seq > lastSeq);
  }

  // -----------------------------------------------------------------------
  // Stop / Approval
  // -----------------------------------------------------------------------

  /**
   * Mark a session as stopped.
   *
   * @returns `true` if the session existed and was stopped.
   */
  stopSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Only running/waiting sessions can be stopped
    if (
      session.status !== "running" &&
      session.status !== "waiting_approval" &&
      session.status !== "paused" &&
      session.status !== "initializing"
    ) {
      return false;
    }

    this.updateStatus(sessionId, "stopped");
    return true;
  }

  /**
   * Resolve a pending approval request.
   *
   * @returns `true` if the approval was resolved successfully.
   */
  resolveApproval(
    sessionId: string,
    approved: boolean,
    message?: string,
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.pendingApproval) return false;
    if (session.status !== "waiting_approval") return false;

    const approval = session.pendingApproval;
    session.pendingApproval = null;

    this.emitEvent(sessionId, "agent:approval_resolved", {
      approvalId: approval.id,
      approved,
      message: message ?? null,
    });

    if (approved) {
      this.updateStatus(sessionId, "running");
    } else {
      this.updateStatus(sessionId, "stopped");
    }

    return true;
  }

  /**
   * Set a pending approval on a session, transitioning it to
   * `waiting_approval`.
   */
  requestApproval(
    sessionId: string,
    approval: Omit<PendingApproval, "id" | "createdAt">,
  ): PendingApproval | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const pending: PendingApproval = {
      id: randomUUID(),
      action: approval.action,
      description: approval.description,
      risk: approval.risk,
      createdAt: Date.now(),
      timeoutMs: approval.timeoutMs,
    };

    session.pendingApproval = pending;
    this.updateStatus(sessionId, "waiting_approval");

    this.emitEvent(sessionId, "agent:approval_needed", {
      approvalId: pending.id,
      action: pending.action,
      description: pending.description,
      risk: pending.risk,
      timeoutMs: pending.timeoutMs,
    });

    return pending;
  }

  // -----------------------------------------------------------------------
  // Accounting
  // -----------------------------------------------------------------------

  /** Number of active (running/waiting/initializing) sessions for a user. */
  getActiveCount(userId: number): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (
        session.userId === userId &&
        (session.status === "running" ||
          session.status === "waiting_approval" ||
          session.status === "initializing" ||
          session.status === "paused")
      ) {
        count += 1;
      }
    }
    return count;
  }

  /** Number of runs started today (UTC) by a user. */
  getDailyRunCount(userId: number): number {
    const key = String(userId);
    const entry = this.dailyRunCounts.get(key);
    if (!entry) return 0;
    if (Date.now() >= entry.resetAt) {
      this.dailyRunCounts.delete(key);
      return 0;
    }
    return entry.count;
  }

  /** Return plan limits for a given plan name. Falls back to `free`. */
  getPlanLimits(plan: string): PlanLimits {
    return PLAN_LIMITS[plan] ?? PLAN_LIMITS["free"]!;
  }

  // -----------------------------------------------------------------------
  // Serialization
  // -----------------------------------------------------------------------

  /**
   * Serialize a session for API responses.
   *
   * Strips the EventEmitter and the full event buffer (clients should use
   * the SSE endpoint to stream events).
   */
  serialize(session: AgentSession): Record<string, unknown> {
    return {
      id: session.id,
      runId: session.runId,
      userId: session.userId,
      status: session.status,
      goal: session.goal,
      model: session.model,
      provider: session.provider,
      workDir: session.workDir,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      iterations: session.iterations,
      maxIterations: session.maxIterations,
      tokenUsage: { ...session.tokenUsage },
      filesChanged: [...session.filesChanged],
      pendingApproval: session.pendingApproval
        ? { ...session.pendingApproval }
        : null,
      error: session.error,
      eventBufferSize: session.eventBuffer.length,
      lastSeq:
        session.eventBuffer.length > 0
          ? session.eventBuffer[session.eventBuffer.length - 1]!.seq
          : -1,
    };
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /**
   * Remove sessions that have been inactive for more than 24 hours and are
   * in a terminal state (completed / failed / stopped).
   */
  cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      const inactive = now - session.updatedAt > SESSION_EXPIRY_MS;
      const terminal =
        session.status === "completed" ||
        session.status === "failed" ||
        session.status === "stopped";

      if (inactive && terminal) {
        session.emitter.removeAllListeners();
        this.sessions.delete(id);
      }
    }

    // Also purge stale daily-run entries
    for (const [key, entry] of this.dailyRunCounts) {
      if (now >= entry.resetAt) {
        this.dailyRunCounts.delete(key);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private incrementDailyRun(userId: number): void {
    const key = String(userId);
    const existing = this.dailyRunCounts.get(key);
    const now = Date.now();

    if (existing && now < existing.resetAt) {
      existing.count += 1;
    } else {
      this.dailyRunCounts.set(key, {
        count: 1,
        resetAt: nextMidnightUTC(),
      });
    }
  }
}
