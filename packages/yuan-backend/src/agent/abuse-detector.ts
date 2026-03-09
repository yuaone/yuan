// src/agent/abuse-detector.ts
// YUAN Agent Backend — Abuse Detector
//
// Detects and prevents abuse patterns: rate-limiting, abnormal token usage,
// concurrent-session abuse, and content abuse.  All state is in-memory with
// bounded buffers.

/* ---------------------------------------------------------
 * Types
 * ------------------------------------------------------- */

export type AbuseType =
  | "rate_limit"
  | "token_abuse"
  | "concurrent_abuse"
  | "content_abuse"
  | "resource_abuse"
  | "api_key_sharing";

export interface AbuseEvent {
  userId: number;
  type: AbuseType;
  details: string;
  timestamp: number;
  severity: "warning" | "block" | "ban";
}

/* ---------------------------------------------------------
 * Sliding-window entry
 * ------------------------------------------------------- */

// (Per-user rate-limit windows use Map<number, number[]>)

/* ---------------------------------------------------------
 * AbuseDetector
 * ------------------------------------------------------- */

export class AbuseDetector {
  private events: AbuseEvent[] = [];
  private blockedUsers = new Set<number>();
  private warningCounts = new Map<number, number>();
  private requestWindows = new Map<number, number[]>();

  private static readonly MAX_WARNINGS = 5;
  private static readonly MAX_EVENTS = 1000;
  // (Per-user windows are self-trimming; no global cap needed)

  /* ---- Primary check ---- */

  /**
   * Determine whether a request from `userId` should be allowed.
   *
   * @param action  Human-readable action label (e.g. "create_session").
   * @param metadata  Optional key-value bag for contextual checks.
   */
  check(
    userId: number,
    action: string,
    metadata?: Record<string, unknown>,
  ): { allowed: boolean; reason?: string } {
    // Hard block
    if (this.isBlocked(userId)) {
      return { allowed: false, reason: "User is blocked due to prior abuse" };
    }

    // Rate-limit check (60 requests per minute)
    if (!this.checkRateLimit(userId, 60_000, 60)) {
      this.recordAbuse({
        userId,
        type: "rate_limit",
        details: `Rate limit exceeded on action: ${action}`,
        severity: "warning",
      });
      return { allowed: false, reason: "Rate limit exceeded — try again shortly" };
    }

    // Concurrent-session check (if metadata supplies count)
    if (typeof metadata?.["concurrentSessions"] === "number") {
      const maxConcurrent = (metadata["maxConcurrent"] as number | undefined) ?? 5;
      if ((metadata["concurrentSessions"] as number) >= maxConcurrent) {
        this.recordAbuse({
          userId,
          type: "concurrent_abuse",
          details: `Concurrent sessions: ${metadata["concurrentSessions"]}/${maxConcurrent}`,
          severity: "warning",
        });
        return { allowed: false, reason: "Too many concurrent sessions" };
      }
    }

    return { allowed: true };
  }

  /* ---- Record ---- */

  /** Record an abuse event. Auto-blocks after MAX_WARNINGS. */
  recordAbuse(event: Omit<AbuseEvent, "timestamp">): void {
    const full: AbuseEvent = { ...event, timestamp: Date.now() };
    this.events.push(full);

    // Evict oldest when buffer full
    if (this.events.length > AbuseDetector.MAX_EVENTS) {
      const drop = Math.ceil(AbuseDetector.MAX_EVENTS * 0.1);
      this.events = this.events.slice(drop);
    }

    // Auto-block logic (avoid recursion — never call blockUser() from here)
    if (event.severity === "warning") {
      const count = (this.warningCounts.get(event.userId) ?? 0) + 1;
      this.warningCounts.set(event.userId, count);

      if (count >= AbuseDetector.MAX_WARNINGS) {
        this.blockedUsers.add(event.userId);
      }
    } else if (event.severity === "block" || event.severity === "ban") {
      this.blockedUsers.add(event.userId);
    }
  }

  /* ---- Rate limiting (sliding window) ---- */

  /**
   * Returns `true` if within limit, `false` if exceeded.
   */
  checkRateLimit(
    userId: number,
    windowMs: number,
    maxRequests: number,
  ): boolean {
    const now = Date.now();
    const cutoff = now - windowMs;

    let window = this.requestWindows.get(userId);
    if (!window) {
      window = [];
      this.requestWindows.set(userId, window);
    }

    // Remove expired entries
    const firstValid = window.findIndex((t) => t >= cutoff);
    if (firstValid > 0) {
      window.splice(0, firstValid);
    } else if (firstValid === -1) {
      window.length = 0;
    }

    // Check BEFORE adding the current request
    if (window.length >= maxRequests) {
      return false;
    }

    // Record the current request
    window.push(now);
    return true;
  }

  /* ---- Token abuse ---- */

  /**
   * Returns `true` if usage looks normal, `false` if abnormal.
   * Flags when a single call uses > 10× the provided average.
   */
  checkTokenAbuse(
    userId: number,
    tokensUsed: number,
    averageTokens: number,
  ): boolean {
    if (averageTokens <= 0) return true;
    const ratio = tokensUsed / averageTokens;
    if (ratio > 10) {
      this.recordAbuse({
        userId,
        type: "token_abuse",
        details: `Token usage ${tokensUsed} is ${ratio.toFixed(1)}× average (${averageTokens})`,
        severity: "warning",
      });
      return false;
    }
    return true;
  }

  /* ---- Block / Unblock ---- */

  blockUser(userId: number, reason: string): void {
    this.blockedUsers.add(userId);
    // Record the block event directly (don't call recordAbuse to avoid recursion)
    this.events.push({
      userId,
      type: "rate_limit",
      details: `User blocked: ${reason}`,
      severity: "block",
      timestamp: Date.now(),
    });
    if (this.events.length > AbuseDetector.MAX_EVENTS) {
      const drop = Math.ceil(AbuseDetector.MAX_EVENTS * 0.1);
      this.events = this.events.slice(drop);
    }
  }

  unblockUser(userId: number): void {
    this.blockedUsers.delete(userId);
    this.warningCounts.delete(userId);
  }

  isBlocked(userId: number): boolean {
    return this.blockedUsers.has(userId);
  }

  /* ---- Admin report ---- */

  getReport(): {
    totalEvents: number;
    blockedUsers: number[];
    recentEvents: AbuseEvent[];
  } {
    return {
      totalEvents: this.events.length,
      blockedUsers: Array.from(this.blockedUsers),
      recentEvents: this.events.slice(-50),
    };
  }

  /* ---- Maintenance ---- */

  /** Remove events older than 24 hours and prune the request window. */
  cleanup(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.events = this.events.filter((e) => e.timestamp >= cutoff);
    for (const [uid, window] of this.requestWindows) {
      const filtered = window.filter((t) => t >= cutoff);
      if (filtered.length === 0) {
        this.requestWindows.delete(uid);
      } else {
        this.requestWindows.set(uid, filtered);
      }
    }
  }
}
