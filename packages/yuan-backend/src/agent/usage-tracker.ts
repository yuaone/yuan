// src/agent/usage-tracker.ts
// YUAN Agent Backend — Usage Tracker
//
// Tracks model usage per user for billing, monitoring, and plan-limit enforcement.
// All data is held in memory; a future iteration may persist to PostgreSQL.

import { SessionManager } from "./session-manager.js";

/* ---------------------------------------------------------
 * Types
 * ------------------------------------------------------- */

export interface UsageRecord {
  userId: number;
  sessionId: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  timestamp: number;
  durationMs: number;
}

export interface UsageSummary {
  daily: {
    tokensUsed: number;
    sessionsRun: number;
    limit: number;
    percentage: number;
  };
  monthly: {
    tokensUsed: number;
    sessionsRun: number;
  };
  byModel: ModelUsage[];
}

export interface ModelUsage {
  model: string;
  provider: string;
  tokensUsed: number;
  /** Percentage of total user usage */
  percentage: number;
  sessions: number;
}

/* ---------------------------------------------------------
 * Plan Limits — derived from SessionManager (SSOT)
 *
 * SessionManager.getPlanLimits() is the single source of truth for plan
 * tier definitions. We derive the usage-specific limits from it to avoid
 * maintaining a duplicate constants table.
 * ------------------------------------------------------- */

interface UsagePlanLimits {
  dailyTokens: number;
  dailySessions: number;
  concurrentSessions: number;
}

const _sessionManager = new SessionManager();

function getUsageLimits(plan: string): UsagePlanLimits {
  const base = _sessionManager.getPlanLimits(plan);
  return {
    // maxTokensPerSession × dailyRuns gives a reasonable daily token budget
    dailyTokens: base.maxTokensPerSession * Math.min(base.dailyRuns, 10),
    dailySessions: base.dailyRuns,
    concurrentSessions: base.maxConcurrent,
  };
}

/* ---------------------------------------------------------
 * Helpers
 * ------------------------------------------------------- */

function dateKey(ts?: number): string {
  const d = ts ? new Date(ts) : new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function monthKey(ts?: number): string {
  const d = ts ? new Date(ts) : new Date();
  return d.toISOString().slice(0, 7); // YYYY-MM
}

/* ---------------------------------------------------------
 * UsageTracker
 * ------------------------------------------------------- */

export class UsageTracker {
  private records: UsageRecord[] = [];
  private static readonly MAX_RECORDS = 10_000;
  private static readonly RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

  /* ---- Record ---- */

  /** Append a usage record. Older records are evicted when MAX_RECORDS is hit. */
  record(usage: UsageRecord): void {
    this.records.push(usage);
    if (this.records.length > UsageTracker.MAX_RECORDS) {
      // Drop oldest 10 %
      const drop = Math.ceil(UsageTracker.MAX_RECORDS * 0.1);
      this.records = this.records.slice(drop);
    }
  }

  /* ---- Summaries ---- */

  /** Full usage summary for a user (today + this month + per-model). */
  getSummary(userId: number, plan = "free"): UsageSummary {
    const daily = this.getDailyUsage(userId);
    const monthly = this.getMonthlyUsage(userId);
    const byModel = this.getModelBreakdown(userId);
    const limits = getUsageLimits(plan);

    return {
      daily: {
        tokensUsed: daily.tokens,
        sessionsRun: daily.sessions,
        limit: limits.dailyTokens,
        percentage:
          limits.dailyTokens > 0
            ? Math.round((daily.tokens / limits.dailyTokens) * 10000) / 100
            : 0,
      },
      monthly: {
        tokensUsed: monthly.tokens,
        sessionsRun: monthly.sessions,
      },
      byModel,
    };
  }

  /** Per-model token breakdown for a user. */
  getModelBreakdown(userId: number): ModelUsage[] {
    const userRecords = this.records.filter((r) => r.userId === userId);

    const totalTokens = userRecords.reduce(
      (sum, r) => sum + r.inputTokens + r.outputTokens,
      0,
    );

    const map = new Map<
      string,
      { model: string; provider: string; tokens: number; sessionIds: Set<string> }
    >();

    for (const r of userRecords) {
      const key = `${r.provider}/${r.model}`;
      let entry = map.get(key);
      if (!entry) {
        entry = { model: r.model, provider: r.provider, tokens: 0, sessionIds: new Set() };
        map.set(key, entry);
      }
      entry.tokens += r.inputTokens + r.outputTokens;
      entry.sessionIds.add(r.sessionId);
    }

    return Array.from(map.values()).map((e) => ({
      model: e.model,
      provider: e.provider,
      tokensUsed: e.tokens,
      percentage:
        totalTokens > 0
          ? Math.round((e.tokens / totalTokens) * 10000) / 100
          : 0,
      sessions: e.sessionIds.size,
    }));
  }

  /** Tokens and session count for a user on a given day. */
  getDailyUsage(
    userId: number,
    date?: string,
  ): { tokens: number; sessions: number } {
    const day = date ?? dateKey();
    const sessionIds = new Set<string>();
    let tokens = 0;

    for (const r of this.records) {
      if (r.userId !== userId) continue;
      if (dateKey(r.timestamp) !== day) continue;
      tokens += r.inputTokens + r.outputTokens;
      sessionIds.add(r.sessionId);
    }

    return { tokens, sessions: sessionIds.size };
  }

  /** Tokens and session count for a user in a given month. */
  getMonthlyUsage(
    userId: number,
    month?: string,
  ): { tokens: number; sessions: number } {
    const m = month ?? monthKey();
    const sessionIds = new Set<string>();
    let tokens = 0;

    for (const r of this.records) {
      if (r.userId !== userId) continue;
      if (monthKey(r.timestamp) !== m) continue;
      tokens += r.inputTokens + r.outputTokens;
      sessionIds.add(r.sessionId);
    }

    return { tokens, sessions: sessionIds.size };
  }

  /* ---- Limits ---- */

  /**
   * Check whether a user is within their plan limits.
   *
   * @returns `{ allowed: true }` or `{ allowed: false, reason }`.
   */
  checkLimits(
    userId: number,
    plan: string,
  ): { allowed: boolean; reason?: string } {
    const limits = getUsageLimits(plan);
    const daily = this.getDailyUsage(userId);

    if (daily.tokens >= limits.dailyTokens) {
      return {
        allowed: false,
        reason: `Daily token limit reached (${daily.tokens}/${limits.dailyTokens})`,
      };
    }

    if (daily.sessions >= limits.dailySessions) {
      return {
        allowed: false,
        reason: `Daily session limit reached (${daily.sessions}/${limits.dailySessions})`,
      };
    }

    return { allowed: true };
  }

  /* ---- Maintenance ---- */

  /** Remove records older than 90 days. */
  cleanup(): void {
    const cutoff = Date.now() - UsageTracker.RETENTION_MS;
    this.records = this.records.filter((r) => r.timestamp >= cutoff);
  }
}
