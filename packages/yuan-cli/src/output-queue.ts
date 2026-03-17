/**
 * Output Queue — Content-Aware Pacer
 *
 * Central output queue with priority, aging, idempotency, and flush scheduling.
 * All rendered output flows through this queue before reaching the terminal.
 *
 * Key properties:
 *   - Priority + aging sort: older entries get promoted to avoid starvation
 *   - Reentrancy guard: flush() during flush() is a no-op
 *   - Idempotency: same key can't be flushed twice
 *   - Stable sort: same effective priority preserves enqueue order
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type EntryState = "queued" | "flushing" | "flushed" | "cancelled";

export type PacingMode =
  | "immediate"
  | "sentence_stream"
  | "collect_flush"
  | "block_buffer"
  | "line_stream";

export interface QueueEntry {
  id: number;
  idempotencyKey: string;
  contentType: string;
  pacingMode: PacingMode;
  content: string;
  state: EntryState;
  scheduledAt: number;
  enqueuedAt: number;
  priority: number;
}

export interface QueueMetrics {
  totalEnqueued: number;
  totalFlushed: number;
  totalCancelled: number;
  flushAllCount: number;
  agingPromotions: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Entries waiting longer than this (ms) get a priority boost of 1. */
const AGING_THRESHOLD_MS = 3000;

/** Priority floor — effective priority never goes below this. */
const MIN_PRIORITY = 0;

// ─── Queue ───────────────────────────────────────────────────────────────────

export class OutputQueue {
  private readonly _entries: Map<number, QueueEntry> = new Map();
  private readonly _flushedKeys: Set<string> = new Set();
  private readonly _writeFn: (content: string, useSyncOutput: boolean) => void;

  private _nextId = 1;
  private _flushing = false;
  private _flushedAll = false;
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;

  private _metrics: QueueMetrics = {
    totalEnqueued: 0,
    totalFlushed: 0,
    totalCancelled: 0,
    flushAllCount: 0,
    agingPromotions: 0,
  };

  constructor(writeFn: (content: string, useSyncOutput: boolean) => void) {
    this._writeFn = writeFn;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Add an entry to the queue. Returns the assigned entry id.
   * Automatically schedules a flush at the entry's scheduledAt time.
   */
  enqueue(entry: {
    idempotencyKey: string;
    contentType: string;
    pacingMode: PacingMode;
    content: string;
    scheduledAt: number;
    priority: number;
  }): number {
    const id = this._nextId++;
    const now = Date.now();

    const queueEntry: QueueEntry = {
      id,
      idempotencyKey: entry.idempotencyKey,
      contentType: entry.contentType,
      pacingMode: entry.pacingMode,
      content: entry.content,
      state: "queued",
      scheduledAt: entry.scheduledAt,
      enqueuedAt: now,
      priority: entry.priority,
    };

    this._entries.set(id, queueEntry);
    this._metrics.totalEnqueued++;

    this._scheduleFlush(queueEntry.scheduledAt);

    return id;
  }

  /**
   * Flush all entries whose scheduledAt has passed, in priority + enqueue order.
   * Reentrancy-safe: if called during an active flush, returns immediately.
   */
  flush(): void {
    if (this._flushing) return;

    this._flushing = true;
    try {
      const now = Date.now();
      const ready = this._getReadyEntries(now);

      for (const entry of ready) {
        this._flushEntry(entry);
      }
    } finally {
      this._flushing = false;
    }
  }

  /**
   * Flush ALL queued entries regardless of scheduledAt.
   * Used at turn boundaries and shutdown to drain the queue.
   * Idempotent: calling flushAll() twice without new enqueues is a no-op.
   */
  flushAll(): void {
    if (this._flushing) return;

    // Reset flushedAll so consecutive flushAll() calls after new enqueues work
    this._flushedAll = false;

    this._flushing = true;
    this._flushedAll = true;
    this._metrics.flushAllCount++;

    try {
      this._clearFlushTimer();

      const all = this._getSortedQueued(Date.now());

      for (const entry of all) {
        this._flushEntry(entry);
      }
    } finally {
      this._flushing = false;
    }
  }

  /** Cancel a queued entry by id. No-op if already flushed or cancelled. */
  cancel(id: number): void {
    const entry = this._entries.get(id);
    if (!entry || entry.state !== "queued") return;

    entry.state = "cancelled";
    this._metrics.totalCancelled++;
  }

  /** Clear the entire queue and reset state. Does not reset metrics. */
  clear(): void {
    this._clearFlushTimer();
    this._entries.clear();
    this._flushedKeys.clear();
    this._flushedAll = false;
  }

  /** Number of entries still in "queued" state. */
  get pendingCount(): number {
    let count = 0;
    for (const entry of this._entries.values()) {
      if (entry.state === "queued") count++;
    }
    return count;
  }

  /** Snapshot of queue metrics. */
  get metrics(): QueueMetrics {
    return { ...this._metrics };
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /**
   * Compute effective priority with aging bonus.
   * Entries waiting longer than AGING_THRESHOLD_MS get promoted by 1.
   */
  private _effectivePriority(entry: QueueEntry, now: number): number {
    const waitMs = now - entry.enqueuedAt;
    const agingBonus = waitMs > AGING_THRESHOLD_MS ? 1 : 0;

    if (agingBonus > 0) {
      this._metrics.agingPromotions++;
    }

    return Math.max(MIN_PRIORITY, entry.priority - agingBonus);
  }

  /**
   * Get queued entries whose scheduledAt <= now, sorted by effective
   * priority (ascending) then by id (ascending) for stable ordering.
   */
  private _getReadyEntries(now: number): QueueEntry[] {
    const ready: QueueEntry[] = [];

    for (const entry of this._entries.values()) {
      if (entry.state === "queued" && entry.scheduledAt <= now) {
        ready.push(entry);
      }
    }

    return this._sortByPriority(ready, now);
  }

  /**
   * Get ALL queued entries sorted by effective priority + id.
   * Used by flushAll() — ignores scheduledAt.
   */
  private _getSortedQueued(now: number): QueueEntry[] {
    const queued: QueueEntry[] = [];

    for (const entry of this._entries.values()) {
      if (entry.state === "queued") {
        queued.push(entry);
      }
    }

    return this._sortByPriority(queued, now);
  }

  /** Sort entries by effective priority (asc), then by id (asc) for stability. */
  private _sortByPriority(entries: QueueEntry[], now: number): QueueEntry[] {
    // Pre-compute effective priorities to avoid counting aging promotions
    // multiple times during sort comparisons.
    const priorities = new Map<number, number>();
    for (const entry of entries) {
      priorities.set(entry.id, this._effectivePriority(entry, now));
    }

    return entries.sort((a, b) => {
      const pa = priorities.get(a.id)!;
      const pb = priorities.get(b.id)!;
      if (pa !== pb) return pa - pb;
      return a.id - b.id;
    });
  }

  /** Flush a single entry: check idempotency, transition state, write. */
  private _flushEntry(entry: QueueEntry): void {
    // Idempotency: skip if this key was already flushed
    if (this._flushedKeys.has(entry.idempotencyKey)) {
      entry.state = "cancelled";
      this._metrics.totalCancelled++;
      return;
    }

    // State transition: queued -> flushing -> flushed
    entry.state = "flushing";
    this._flushedKeys.add(entry.idempotencyKey);

    const useSyncOutput = entry.pacingMode === "block_buffer";
    this._writeFn(entry.content, useSyncOutput);

    entry.state = "flushed";
    this._metrics.totalFlushed++;
  }

  /** Schedule a flush at the given timestamp if it's in the future. */
  private _scheduleFlush(scheduledAt: number): void {
    const now = Date.now();
    const delay = Math.max(0, scheduledAt - now);

    if (delay === 0) {
      // Ready now — flush on next microtask to batch concurrent enqueues
      if (!this._flushTimer) {
        this._flushTimer = setTimeout(() => {
          this._flushTimer = null;
          this._flushedAll = false;
          this.flush();
        }, 0);
      }
      return;
    }

    // Future entry — schedule if no earlier timer exists.
    // We use a simple approach: always schedule, let flush() filter by time.
    // clearTimeout of old timer only if the new one fires sooner.
    if (this._flushTimer) {
      // Already have a pending timer; it will trigger flush() which handles
      // all ready entries. No need to reschedule unless we want tighter timing.
      // For simplicity, let the existing timer run — flush() is cheap when
      // nothing is ready.
      return;
    }

    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flushedAll = false;
      this.flush();
    }, delay);
  }

  /** Cancel the pending flush timer. */
  private _clearFlushTimer(): void {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
  }
}
