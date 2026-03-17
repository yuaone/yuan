/**
 * pacer-metrics.ts — Content-Aware Pacer telemetry for YUAN CLI.
 *
 * Tracks classification distribution, latency, flush behavior, and fallback
 * activations.  Optionally appends JSONL entries to ~/.yuan/logs/ when
 * YUAN_DEBUG is set.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Data Shape ─────────────────────────────────────────────────────────────

export interface PacerMetricsData {
  classificationCounts: Record<string, number>;
  firstVisibleLatencyMs: number;
  totalHiddenCollectTimeMs: number;
  forcedFlushCount: number;
  flushAllCauses: Record<string, number>;
  partialFlushCount: number;
  averageBlockSizeByType: Record<string, number>;
  userInterruptDuringCollect: number;
  fallbackModeActivations: number;
}

// ─── Internal Accumulator ───────────────────────────────────────────────────

interface BlockSizeAccumulator {
  totalSize: number;
  count: number;
}

// ─── PacerMetrics ───────────────────────────────────────────────────────────

export class PacerMetrics {
  private classificationCounts: Record<string, number> = {};
  private firstVisibleLatencyMs = -1;
  private totalHiddenCollectTimeMs = 0;
  private forcedFlushCount = 0;
  private flushAllCauses: Record<string, number> = {};
  private partialFlushCount = 0;
  private blockSizes: Record<string, BlockSizeAccumulator> = {};
  private userInterruptDuringCollect = 0;
  private fallbackModeActivations = 0;

  recordClassification(type: string): void {
    this.classificationCounts[type] = (this.classificationCounts[type] ?? 0) + 1;
  }

  recordFirstVisibleOutput(turnStartTime: number): void {
    if (this.firstVisibleLatencyMs >= 0) return; // already recorded
    this.firstVisibleLatencyMs = Date.now() - turnStartTime;
  }

  recordFlushAll(cause: string): void {
    this.forcedFlushCount++;
    this.flushAllCauses[cause] = (this.flushAllCauses[cause] ?? 0) + 1;
  }

  recordPartialFlush(): void {
    this.partialFlushCount++;
  }

  recordBlockSize(type: string, size: number): void {
    if (!this.blockSizes[type]) {
      this.blockSizes[type] = { totalSize: 0, count: 0 };
    }
    this.blockSizes[type].totalSize += size;
    this.blockSizes[type].count++;
  }

  recordFallbackActivation(): void {
    this.fallbackModeActivations++;
  }

  getData(): PacerMetricsData {
    const averageBlockSizeByType: Record<string, number> = {};
    for (const [type, acc] of Object.entries(this.blockSizes)) {
      averageBlockSizeByType[type] =
        acc.count > 0 ? Math.round(acc.totalSize / acc.count) : 0;
    }

    return {
      classificationCounts: { ...this.classificationCounts },
      firstVisibleLatencyMs: this.firstVisibleLatencyMs,
      totalHiddenCollectTimeMs: this.totalHiddenCollectTimeMs,
      forcedFlushCount: this.forcedFlushCount,
      flushAllCauses: { ...this.flushAllCauses },
      partialFlushCount: this.partialFlushCount,
      averageBlockSizeByType,
      userInterruptDuringCollect: this.userInterruptDuringCollect,
      fallbackModeActivations: this.fallbackModeActivations,
    };
  }

  reset(): void {
    this.classificationCounts = {};
    this.firstVisibleLatencyMs = -1;
    this.totalHiddenCollectTimeMs = 0;
    this.forcedFlushCount = 0;
    this.flushAllCauses = {};
    this.partialFlushCount = 0;
    this.blockSizes = {};
    this.userInterruptDuringCollect = 0;
    this.fallbackModeActivations = 0;
  }

  /**
   * Append metrics snapshot to ~/.yuan/logs/pacer-metrics.jsonl.
   * Only writes when YUAN_DEBUG is set.  Failures are silently ignored
   * — metrics must never crash the CLI.
   */
  writeToLog(): void {
    if (!process.env.YUAN_DEBUG) return;

    try {
      const logDir = path.join(os.homedir(), ".yuan", "logs");
      fs.mkdirSync(logDir, { recursive: true });

      const logPath = path.join(logDir, "pacer-metrics.jsonl");
      const entry = {
        ts: new Date().toISOString(),
        ...this.getData(),
      };

      fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // Metrics logging must never throw
    }
  }
}
