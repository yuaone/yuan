/**
 * @module perf-optimizer
 * @description YUAN Performance Optimizer — monitors and optimizes agent execution performance.
 *
 * Provides:
 * - Execution timing per phase and tool call
 * - Token budget tracking and waste detection
 * - Parallelization hint generation from task dependency graphs
 * - Content-addressable caching for tool calls and LLM responses
 * - Human-readable performance reports with efficiency scoring
 *
 * Only depends on Node builtins (crypto for cache keys).
 */

import { createHash } from "node:crypto";

// ══════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════

/** A single performance metric sample */
export interface PerfMetric {
  name: string;
  category: "timing" | "tokens" | "cache" | "parallel";
  value: number;
  unit: string;
  timestamp: number;
}

/** Aggregated metrics for a single execution phase */
export interface PhaseMetrics {
  phase: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  tokensUsed: { input: number; output: number };
  toolCalls: number;
  cacheHits: number;
  cacheMisses: number;
}

/** Identified performance bottleneck with actionable suggestion */
export interface BottleneckInfo {
  phase: string;
  issue: string;
  impact: "high" | "medium" | "low";
  suggestion: string;
  estimatedSavingMs?: number;
}

/** A single entry in the tool/response cache */
export interface CacheEntry {
  key: string;
  value: unknown;
  hits: number;
  createdAt: number;
  lastAccessedAt: number;
  sizeBytes: number;
}

/** Suggestion for tasks that could benefit from parallel execution */
export interface ParallelHint {
  taskIds: string[];
  currentSequentialMs: number;
  estimatedParallelMs: number;
  speedupFactor: number;
}

/** Complete performance report for a session */
export interface PerfReport {
  sessionId: string;
  totalDurationMs: number;
  phases: PhaseMetrics[];
  bottlenecks: BottleneckInfo[];
  cacheStats: {
    hits: number;
    misses: number;
    hitRate: number;
    savedMs: number;
  };
  parallelHints: ParallelHint[];
  tokenSummary: {
    total: number;
    byPhase: Record<string, number>;
    wasteEstimate: number;
  };
  efficiencyScore: number;
  suggestions: string[];
}

/** Configuration for PerfOptimizer */
export interface PerfOptimizerConfig {
  /** Enable tool call caching (default: true) */
  enableCaching?: boolean;
  /** Maximum number of cache entries (default: 500) */
  maxCacheSize?: number;
  /** Maximum cache memory in bytes (default: 50MB) */
  maxCacheMemory?: number;
  /** Track parallelization opportunities (default: true) */
  trackParallelHints?: boolean;
  /** Phase is a bottleneck if it takes > X% of total time (default: 40) */
  bottleneckThresholdPercent?: number;
}

// ══════════════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════════════

const DEFAULT_MAX_CACHE_SIZE = 500;
const DEFAULT_MAX_CACHE_MEMORY = 50 * 1024 * 1024; // 50 MB
const DEFAULT_BOTTLENECK_THRESHOLD = 40; // percent
const MAX_METRICS = 10_000;
const MAX_TOOL_CALL_RECORDS = 5_000;
const MAX_SUGGESTIONS = 50;
const MAX_BOTTLENECKS = 50;
const MAX_PARALLEL_HINTS = 100;

/** Estimated average ms saved per cache hit (for reporting) */
const AVG_CACHE_HIT_SAVING_MS = 200;

// ══════════════════════════════════════════════════════════════════════
// Internal types
// ══════════════════════════════════════════════════════════════════════

interface ActivePhase {
  phase: string;
  startTime: number;
  tokens: { input: number; output: number };
  toolCalls: number;
  cacheHits: number;
  cacheMisses: number;
}

interface ToolCallRecord {
  tool: string;
  inputHash: string;
  durationMs: number;
  timestamp: number;
  cached: boolean;
}

// ══════════════════════════════════════════════════════════════════════
// PerfOptimizer
// ══════════════════════════════════════════════════════════════════════

/**
 * Monitors and optimizes agent execution performance.
 *
 * Tracks phase timing, token usage, tool call durations, and caching.
 * Generates actionable performance reports with bottleneck identification,
 * parallelization hints, and an overall efficiency score.
 */
export class PerfOptimizer {
  private readonly config: Required<PerfOptimizerConfig>;

  // Phase tracking
  private activePhases: Map<string, ActivePhase> = new Map();
  private completedPhases: PhaseMetrics[] = [];

  // Tool call tracking
  private toolCallRecords: ToolCallRecord[] = [];

  // Metrics
  private metrics: PerfMetric[] = [];

  // Cache
  private cache: Map<string, CacheEntry> = new Map();
  private totalCacheMemory = 0;
  private globalCacheHits = 0;
  private globalCacheMisses = 0;

  // Historical data for comparison
  private previousRunDurations: number[] = [];

  constructor(config?: PerfOptimizerConfig) {
    this.config = {
      enableCaching: config?.enableCaching ?? true,
      maxCacheSize: config?.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE,
      maxCacheMemory: config?.maxCacheMemory ?? DEFAULT_MAX_CACHE_MEMORY,
      trackParallelHints: config?.trackParallelHints ?? true,
      bottleneckThresholdPercent:
        config?.bottleneckThresholdPercent ?? DEFAULT_BOTTLENECK_THRESHOLD,
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // Tracking
  // ────────────────────────────────────────────────────────────────────

  /**
   * Mark the start of an execution phase.
   * @param phase - Phase name (e.g. "analyze", "plan", "implement", "verify", "fix")
   */
  startPhase(phase: string): void {
    if (this.activePhases.has(phase)) return;
    this.activePhases.set(phase, {
      phase,
      startTime: Date.now(),
      tokens: { input: 0, output: 0 },
      toolCalls: 0,
      cacheHits: 0,
      cacheMisses: 0,
    });

    this.addMetric({
      name: `phase.${phase}.start`,
      category: "timing",
      value: Date.now(),
      unit: "epoch_ms",
      timestamp: Date.now(),
    });
  }

  /**
   * Mark the end of an execution phase.
   * @param phase - Phase name that was previously started
   * @param tokens - Optional token usage for this phase
   */
  endPhase(
    phase: string,
    tokens?: { input: number; output: number },
  ): void {
    const active = this.activePhases.get(phase);
    if (!active) return;

    const endTime = Date.now();
    const durationMs = endTime - active.startTime;

    if (tokens) {
      active.tokens.input += tokens.input;
      active.tokens.output += tokens.output;
    }

    const completed: PhaseMetrics = {
      phase: active.phase,
      startTime: active.startTime,
      endTime,
      durationMs,
      tokensUsed: { ...active.tokens },
      toolCalls: active.toolCalls,
      cacheHits: active.cacheHits,
      cacheMisses: active.cacheMisses,
    };

    this.completedPhases.push(completed);
    this.activePhases.delete(phase);

    this.addMetric({
      name: `phase.${phase}.duration`,
      category: "timing",
      value: durationMs,
      unit: "ms",
      timestamp: endTime,
    });
  }

  /**
   * Record a tool call with its duration.
   * Automatically tracks cache hits/misses for the active phase.
   * @param tool - Tool name
   * @param input - Tool input (used for cache key generation)
   * @param durationMs - How long the tool call took
   */
  recordToolCall(tool: string, input: unknown, durationMs: number): void {
    const inputHash = this.hashInput(tool, input);
    const cached = this.cache.has(inputHash);

    if (this.toolCallRecords.length < MAX_TOOL_CALL_RECORDS) {
      this.toolCallRecords.push({
        tool,
        inputHash,
        durationMs,
        timestamp: Date.now(),
        cached,
      });
    }

    // Update active phase counters
    for (const active of this.activePhases.values()) {
      active.toolCalls++;
      if (cached) {
        active.cacheHits++;
      } else {
        active.cacheMisses++;
      }
    }

    this.addMetric({
      name: `tool.${tool}.duration`,
      category: "timing",
      value: durationMs,
      unit: "ms",
      timestamp: Date.now(),
    });
  }

  /**
   * Record token usage for a specific phase.
   * @param phase - Phase name
   * @param input - Input tokens consumed
   * @param output - Output tokens generated
   */
  recordTokenUsage(phase: string, input: number, output: number): void {
    const active = this.activePhases.get(phase);
    if (active) {
      active.tokens.input += input;
      active.tokens.output += output;
    }

    // Also update completed phase if it exists (for late-arriving token counts)
    const completed = this.completedPhases.find((p) => p.phase === phase);
    if (completed) {
      completed.tokensUsed.input += input;
      completed.tokensUsed.output += output;
    }

    this.addMetric({
      name: `tokens.${phase}`,
      category: "tokens",
      value: input + output,
      unit: "tokens",
      timestamp: Date.now(),
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // Caching
  // ────────────────────────────────────────────────────────────────────

  /**
   * Retrieve a cached tool call result.
   * @param tool - Tool name
   * @param input - Tool input
   * @returns Cached result or undefined if not found
   */
  getCached(tool: string, input: unknown): unknown | undefined {
    if (!this.config.enableCaching) return undefined;

    const key = this.hashInput(tool, input);
    const entry = this.cache.get(key);
    if (!entry) {
      this.globalCacheMisses++;
      return undefined;
    }

    entry.hits++;
    entry.lastAccessedAt = Date.now();
    this.globalCacheHits++;
    return entry.value;
  }

  /**
   * Store a tool call result in the cache.
   * Automatically evicts LRU entries when limits are exceeded.
   * @param tool - Tool name
   * @param input - Tool input
   * @param result - Result to cache
   */
  setCached(tool: string, input: unknown, result: unknown): void {
    if (!this.config.enableCaching) return;

    const key = this.hashInput(tool, input);
 let serialized: string;
 try {
   serialized = JSON.stringify(result);
 } catch {
   return; // skip caching circular objects
 }
    const sizeBytes = Buffer.byteLength(serialized, "utf8");

    // Don't cache if single entry exceeds half the memory limit
    if (sizeBytes > this.config.maxCacheMemory / 2) return;

    // Evict if needed
    this.evictIfNeeded(sizeBytes);

    // Remove old entry if updating
    const existing = this.cache.get(key);
    if (existing) {
      this.totalCacheMemory -= existing.sizeBytes;
    }

    const now = Date.now();
    this.cache.set(key, {
      key,
      value: result,
      hits: 0,
      createdAt: now,
      lastAccessedAt: now,
      sizeBytes,
    });
    this.totalCacheMemory += sizeBytes;
  }

  /**
   * Clear all cached entries.
   */
  clearCache(): void {
    this.cache.clear();
    this.totalCacheMemory = 0;
  }

  // ────────────────────────────────────────────────────────────────────
  // Analysis
  // ────────────────────────────────────────────────────────────────────

  /**
   * Identify execution bottlenecks based on phase timing and token usage.
   * @returns Array of bottleneck descriptions with suggestions
   */
  getBottlenecks(): BottleneckInfo[] {
    const bottlenecks: BottleneckInfo[] = [];
    const totalMs = this.getTotalDuration();
    if (totalMs === 0) return bottlenecks;

    const threshold = this.config.bottleneckThresholdPercent;

    for (const phase of this.completedPhases) {
      const pct = (phase.durationMs / totalMs) * 100;

      // Phase taking too long
      if (pct > threshold) {
        bottlenecks.push({
          phase: phase.phase,
          issue: `Phase "${phase.phase}" consumed ${pct.toFixed(1)}% of total time (${phase.durationMs}ms)`,
          impact: pct > 60 ? "high" : "medium",
          suggestion: `Consider breaking "${phase.phase}" into smaller sub-phases or parallelizing tool calls within it`,
          estimatedSavingMs: Math.round(
            phase.durationMs * (1 - threshold / pct),
          ),
        });
      }

      // High cache miss rate with many tool calls
      const totalCacheOps = phase.cacheHits + phase.cacheMisses;
      if (
        totalCacheOps > 5 &&
        phase.cacheMisses / totalCacheOps > 0.8
      ) {
        bottlenecks.push({
          phase: phase.phase,
          issue: `Phase "${phase.phase}" has ${((phase.cacheMisses / totalCacheOps) * 100).toFixed(0)}% cache miss rate across ${totalCacheOps} operations`,
          impact: "medium",
          suggestion: "Enable or increase cache size to avoid repeated identical tool calls",
          estimatedSavingMs: Math.round(
            phase.cacheMisses * AVG_CACHE_HIT_SAVING_MS * 0.5,
          ),
        });
      }

      // Token waste: high output tokens relative to input
      const totalTokens = phase.tokensUsed.input + phase.tokensUsed.output;
      if (
        totalTokens > 10_000 &&
        phase.tokensUsed.output > phase.tokensUsed.input * 3
      ) {
        bottlenecks.push({
          phase: phase.phase,
          issue: `Phase "${phase.phase}" has disproportionate output tokens (${phase.tokensUsed.output} out vs ${phase.tokensUsed.input} in)`,
          impact: "low",
          suggestion: "Consider requesting more concise LLM responses or summarizing intermediate outputs",
        });
      }
    }

    // Detect repeated tool calls (same tool + input)
    const callCounts = new Map<string, number>();
    for (const rec of this.toolCallRecords) {
      const count = (callCounts.get(rec.inputHash) ?? 0) + 1;
      callCounts.set(rec.inputHash, count);
    }
    for (const [hash, count] of callCounts) {
      if (count >= 3) {
        const sample = this.toolCallRecords.find((r) => r.inputHash === hash);
        if (sample) {
          bottlenecks.push({
            phase: "global",
            issue: `Tool "${sample.tool}" called ${count} times with identical input`,
            impact: count >= 5 ? "high" : "medium",
            suggestion: `Cache results for "${sample.tool}" to avoid redundant calls`,
            estimatedSavingMs: Math.round(
              (count - 1) * sample.durationMs,
            ),
          });
        }
      }
    }

    // Historical comparison
    if (this.previousRunDurations.length > 0) {
      const avg =
        this.previousRunDurations.reduce((a, b) => a + b, 0) /
        this.previousRunDurations.length;
      if (totalMs > avg * 1.5) {
        bottlenecks.push({
          phase: "global",
          issue: `This run (${totalMs}ms) is ${((totalMs / avg - 1) * 100).toFixed(0)}% slower than average (${Math.round(avg)}ms)`,
          impact: totalMs > avg * 2 ? "high" : "medium",
          suggestion: "Check for new bottlenecks or increased task complexity",
          estimatedSavingMs: Math.round(totalMs - avg),
        });
      }
    }

    return bottlenecks.slice(0, MAX_BOTTLENECKS);
  }

  /**
   * Analyze a task dependency graph and identify parallelization opportunities.
   * @param taskDeps - Map of taskId → array of dependency taskIds
   * @returns Array of parallelization hints with estimated speedup
   */
  getParallelHints(
    taskDeps: Map<string, string[]>,
  ): ParallelHint[] {
    if (!this.config.trackParallelHints) return [];

    const hints: ParallelHint[] = [];

    // Find groups of tasks with the same dependencies (can run in parallel)
    const depSignatures = new Map<string, string[]>();
    for (const [taskId, deps] of taskDeps) {
      const sig = [...deps].sort().join(",");
      const group = depSignatures.get(sig) ?? [];
      group.push(taskId);
      depSignatures.set(sig, group);
    }

    // Build duration map from tool call records
    const taskDurations = new Map<string, number>();
    for (const rec of this.toolCallRecords) {
      // Use tool name as rough proxy for task duration
      const current = taskDurations.get(rec.tool) ?? 0;
      taskDurations.set(rec.tool, current + rec.durationMs);
    }

    for (const [_sig, group] of depSignatures) {
      if (group.length < 2) continue;

      // Estimate durations: use recorded data or default 1000ms
      const durations = group.map(
        (id) => taskDurations.get(id) ?? 1000,
      );
      const sequentialMs = durations.reduce((a, b) => a + b, 0);
      const parallelMs = Math.max(...durations);
      const speedup = parallelMs > 0 ? sequentialMs / parallelMs : 1;

      if (speedup > 1.2) {
        hints.push({
          taskIds: group,
          currentSequentialMs: sequentialMs,
          estimatedParallelMs: parallelMs,
          speedupFactor: Math.round(speedup * 100) / 100,
        });
      }
    }

    // Also check for independent tasks (no deps at all)
    const noDeps: string[] = [];
    for (const [taskId, deps] of taskDeps) {
      if (deps.length === 0) noDeps.push(taskId);
    }
    if (noDeps.length >= 2) {
      const durations = noDeps.map(
        (id) => taskDurations.get(id) ?? 1000,
      );
      const sequentialMs = durations.reduce((a, b) => a + b, 0);
      const parallelMs = Math.max(...durations);
      const speedup = parallelMs > 0 ? sequentialMs / parallelMs : 1;

      if (speedup > 1.2) {
        // Avoid duplicate if already added via signature grouping
        const alreadyAdded = hints.some(
          (h) =>
            h.taskIds.length === noDeps.length &&
            h.taskIds.every((id) => noDeps.includes(id)),
        );
        if (!alreadyAdded) {
          hints.push({
            taskIds: noDeps,
            currentSequentialMs: sequentialMs,
            estimatedParallelMs: parallelMs,
            speedupFactor: Math.round(speedup * 100) / 100,
          });
        }
      }
    }

    return hints.slice(0, MAX_PARALLEL_HINTS);
  }

  /**
   * Calculate an overall efficiency score (0-100) based on multiple factors.
   * @returns Efficiency score where 100 is optimal
   */
  getEfficiencyScore(): number {
    let score = 100;
    const totalMs = this.getTotalDuration();
    if (totalMs === 0) return score;

    // Penalty: bottlenecks
    const bottlenecks = this.getBottlenecks();
    for (const b of bottlenecks) {
      switch (b.impact) {
        case "high":
          score -= 15;
          break;
        case "medium":
          score -= 8;
          break;
        case "low":
          score -= 3;
          break;
      }
    }

    // Bonus: good cache hit rate
    const totalCacheOps = this.globalCacheHits + this.globalCacheMisses;
    if (totalCacheOps > 0) {
      const hitRate = this.globalCacheHits / totalCacheOps;
      if (hitRate > 0.5) score += 5;
      if (hitRate > 0.7) score += 5;
    }

    // Penalty: token waste (repeated identical tool calls)
    const duplicateToolCalls = this.countDuplicateToolCalls();
    const totalToolCalls = this.toolCallRecords.length;
    if (totalToolCalls > 0) {
      const wasteRatio = duplicateToolCalls / totalToolCalls;
      if (wasteRatio > 0.3) score -= 10;
      else if (wasteRatio > 0.1) score -= 5;
    }

    // Penalty: slower than historical average
    if (this.previousRunDurations.length > 0) {
      const avg =
        this.previousRunDurations.reduce((a, b) => a + b, 0) /
        this.previousRunDurations.length;
      if (totalMs > avg * 2) score -= 10;
      else if (totalMs > avg * 1.5) score -= 5;
    }

    return Math.max(0, Math.min(100, score));
  }

  // ────────────────────────────────────────────────────────────────────
  // Reporting
  // ────────────────────────────────────────────────────────────────────

  /**
   * Generate a complete performance report for the session.
   * @param sessionId - Session identifier
   * @returns Structured performance report
   */
  generateReport(sessionId: string): PerfReport {
    const totalDurationMs = this.getTotalDuration();
    const bottlenecks = this.getBottlenecks();
    const parallelHints: ParallelHint[] = [];

    // Token summary
    const byPhase: Record<string, number> = {};
    let totalTokens = 0;
    for (const phase of this.completedPhases) {
      const phaseTotal =
        phase.tokensUsed.input + phase.tokensUsed.output;
      byPhase[phase.phase] = phaseTotal;
      totalTokens += phaseTotal;
    }

    const wasteEstimate = this.estimateTokenWaste();

    // Cache stats
    const totalCacheOps = this.globalCacheHits + this.globalCacheMisses;
    const hitRate =
      totalCacheOps > 0 ? this.globalCacheHits / totalCacheOps : 0;
    const savedMs = this.globalCacheHits * AVG_CACHE_HIT_SAVING_MS;

    const suggestions = this.generateSuggestions(bottlenecks);

    return {
      sessionId,
      totalDurationMs,
      phases: [...this.completedPhases],
      bottlenecks,
      cacheStats: {
        hits: this.globalCacheHits,
        misses: this.globalCacheMisses,
        hitRate: Math.round(hitRate * 1000) / 1000,
        savedMs,
      },
      parallelHints,
      tokenSummary: {
        total: totalTokens,
        byPhase,
        wasteEstimate,
      },
      efficiencyScore: this.getEfficiencyScore(),
      suggestions,
    };
  }

  /**
   * Format a performance report as a human-readable string.
   * @param report - Report to format
   * @returns Multi-line formatted string
   */
  formatReport(report: PerfReport): string {
    const lines: string[] = [];

    lines.push("═══════════════════════════════════════════════════");
    lines.push(`  YUAN Performance Report — Session: ${report.sessionId}`);
    lines.push("═══════════════════════════════════════════════════");
    lines.push("");

    // Overview
    lines.push(`Total Duration: ${this.formatMs(report.totalDurationMs)}`);
    lines.push(`Efficiency Score: ${report.efficiencyScore}/100`);
    lines.push(`Total Tokens: ${report.tokenSummary.total.toLocaleString()}`);
    lines.push("");

    // Phase breakdown
    lines.push("── Phase Breakdown ──────────────────────────────");
    for (const phase of report.phases) {
      const pct =
        report.totalDurationMs > 0
          ? ((phase.durationMs / report.totalDurationMs) * 100).toFixed(1)
          : "0.0";
      const tokens =
        phase.tokensUsed.input + phase.tokensUsed.output;
      lines.push(
        `  ${phase.phase.padEnd(15)} ${this.formatMs(phase.durationMs).padStart(10)} (${pct}%)  tokens: ${tokens.toLocaleString().padStart(8)}  tools: ${phase.toolCalls}  cache: ${phase.cacheHits}/${phase.cacheHits + phase.cacheMisses}`,
      );
    }
    lines.push("");

    // Cache stats
    lines.push("── Cache Statistics ─────────────────────────────");
    lines.push(
      `  Hits: ${report.cacheStats.hits}  Misses: ${report.cacheStats.misses}  Rate: ${(report.cacheStats.hitRate * 100).toFixed(1)}%  Saved: ~${this.formatMs(report.cacheStats.savedMs)}`,
    );
    lines.push("");

    // Bottlenecks
    if (report.bottlenecks.length > 0) {
      lines.push("── Bottlenecks ──────────────────────────────────");
      for (const b of report.bottlenecks) {
        const icon =
          b.impact === "high"
            ? "[HIGH]"
            : b.impact === "medium"
              ? "[MED] "
              : "[LOW] ";
        lines.push(`  ${icon} ${b.issue}`);
        lines.push(`         -> ${b.suggestion}`);
        if (b.estimatedSavingMs) {
          lines.push(
            `         -> Potential saving: ~${this.formatMs(b.estimatedSavingMs)}`,
          );
        }
      }
      lines.push("");
    }

    // Parallel hints
    if (report.parallelHints.length > 0) {
      lines.push("── Parallelization Opportunities ────────────────");
      for (const h of report.parallelHints) {
        lines.push(
          `  Tasks [${h.taskIds.join(", ")}]: ${this.formatMs(h.currentSequentialMs)} -> ${this.formatMs(h.estimatedParallelMs)} (${h.speedupFactor}x speedup)`,
        );
      }
      lines.push("");
    }

    // Token waste
    if (report.tokenSummary.wasteEstimate > 0) {
      lines.push("── Token Waste ──────────────────────────────────");
      lines.push(
        `  Estimated waste: ~${report.tokenSummary.wasteEstimate.toLocaleString()} tokens`,
      );
      lines.push("");
    }

    // Suggestions
    if (report.suggestions.length > 0) {
      lines.push("── Suggestions ──────────────────────────────────");
      for (const s of report.suggestions) {
        lines.push(`  * ${s}`);
      }
      lines.push("");
    }

    lines.push("═══════════════════════════════════════════════════");
    return lines.join("\n");
  }

  // ────────────────────────────────────────────────────────────────────
  // Reset & Utility
  // ────────────────────────────────────────────────────────────────────

  /**
   * Store current run duration for future historical comparison, then reset all state.
   */
  reset(): void {
    const totalMs = this.getTotalDuration();
    if (totalMs > 0) {
      this.previousRunDurations.push(totalMs);
      // Keep bounded
      if (this.previousRunDurations.length > 100) {
        this.previousRunDurations = this.previousRunDurations.slice(-50);
      }
    }

    this.activePhases.clear();
    this.completedPhases = [];
    this.toolCallRecords = [];
    this.metrics = [];
    this.clearCache();
    this.globalCacheHits = 0;
    this.globalCacheMisses = 0;
  }

  // ────────────────────────────────────────────────────────────────────
  // Private helpers
  // ────────────────────────────────────────────────────────────────────

  /** Add a metric, bounded by MAX_METRICS */
  private addMetric(metric: PerfMetric): void {
    if (this.metrics.length < MAX_METRICS) {
      this.metrics.push(metric);
    }
  }

  /** Compute total duration from completed phases */
  private getTotalDuration(): number {
    if (this.completedPhases.length === 0) return 0;
    const start = Math.min(...this.completedPhases.map((p) => p.startTime));
    const end = Math.max(...this.completedPhases.map((p) => p.endTime));
    return end - start;
  }

  /** Generate a content-addressable hash for tool+input */
  private hashInput(tool: string, input: unknown): string {
 let json: string;
 try {
   json = JSON.stringify(input);
 } catch {
   json = "[unserializable]";
 }
 const content = `${tool}:${json}`;
    return createHash("sha256").update(content).digest("hex").slice(0, 32);
  }

  /** Evict LRU cache entries until there's room */
  private evictIfNeeded(newEntrySize: number): void {
    // Evict by count
    while (this.cache.size >= this.config.maxCacheSize) {
      this.evictLRU();
    }

    // Evict by memory
    while (
      this.totalCacheMemory + newEntrySize > this.config.maxCacheMemory &&
      this.cache.size > 0
    ) {
      this.evictLRU();
    }
  }

  /** Remove the least recently used cache entry */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.cache.get(oldestKey);
      if (entry) {
        this.totalCacheMemory -= entry.sizeBytes;
      }
      this.cache.delete(oldestKey);
    }
  }

  /** Count tool calls with duplicate inputs */
  private countDuplicateToolCalls(): number {
    const seen = new Set<string>();
    let dupes = 0;
    for (const rec of this.toolCallRecords) {
      if (seen.has(rec.inputHash)) {
        dupes++;
      } else {
        seen.add(rec.inputHash);
      }
    }
    return dupes;
  }

  /** Estimate wasted tokens from redundant tool calls */
  private estimateTokenWaste(): number {
    // Each redundant tool call wastes ~input description + output tokens
    const dupes = this.countDuplicateToolCalls();
    // Rough estimate: 500 tokens per redundant call (tool description + result)
    return dupes * 500;
  }

  /** Generate actionable suggestions from bottleneck analysis */
  private generateSuggestions(bottlenecks: BottleneckInfo[]): string[] {
    const suggestions: string[] = [];

    // From bottlenecks
    for (const b of bottlenecks) {
      if (b.impact === "high") {
        suggestions.push(b.suggestion);
      }
    }

    // Cache suggestions
    const totalCacheOps = this.globalCacheHits + this.globalCacheMisses;
    if (totalCacheOps > 10) {
      const hitRate = this.globalCacheHits / totalCacheOps;
      if (hitRate < 0.3) {
        suggestions.push(
          "Cache hit rate is below 30%. Consider enabling caching or increasing cache size.",
        );
      }
    } else if (totalCacheOps === 0 && this.toolCallRecords.length > 10) {
      suggestions.push(
        "No cache usage detected. Enable caching to avoid redundant tool calls.",
      );
    }

    // Token suggestions
    let totalTokens = 0;
    for (const phase of this.completedPhases) {
      totalTokens +=
        phase.tokensUsed.input + phase.tokensUsed.output;
    }
    if (totalTokens > 200_000) {
      suggestions.push(
        "Token usage exceeds 200k. Consider context compression or summarizing intermediate results.",
      );
    }

    // Phase balance
    if (this.completedPhases.length > 1) {
      const totalMs = this.getTotalDuration();
      const implementPhase = this.completedPhases.find(
        (p) => p.phase === "implement",
      );
      if (
        implementPhase &&
        totalMs > 0 &&
        implementPhase.durationMs / totalMs < 0.3
      ) {
        suggestions.push(
          "Implementation phase is less than 30% of total time. Analysis/planning may be over-scoped.",
        );
      }
    }

    return suggestions.slice(0, MAX_SUGGESTIONS);
  }

  /** Format milliseconds as human-readable string */
  private formatMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}m`;
  }
}
