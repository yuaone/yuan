/**
 * @module strategy-learner
 * @description Tracks playbook performance metrics and ranks strategies.
 * Complements PlaybookLibrary (which stores templates) by tracking runtime metrics.
 *
 * Differentiation from SelfImprovementLoop:
 *   SelfImprovementLoop → strategy outcome proposals
 *   StrategyLearner     → playbook performance metrics + ranking
 *
 * Storage: ~/.yuan/strategy/strategy-metrics.json
 * Atomic writes (.tmp → renameSync).
 */

import { EventEmitter } from "events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ─── Types ───

export interface StrategyMetric {
  playbookId: string;
  taskType: string;
  successCount: number;
  failureCount: number;
  avgIterations: number;  // running average
  avgTokensUsed: number;  // running average - cost awareness
  lastUsedAt: string;     // ISO
  confidence: number;     // successCount / (successCount + failureCount + 1) Laplace
}

export interface StrategyRanking {
  playbookId: string;
  taskType: string;
  rank: number;           // 1 = best
  score: number;          // composite: confidence * (1 / normalized avgIterations)
  recommendation: string; // human-readable
}

export interface StrategyLearnerConfig {
  storageDir?: string;    // default ~/.yuan/strategy/
}

// ─── Helpers ───

function computeConfidence(successCount: number, failureCount: number): number {
  // Laplace smoothing
  return successCount / (successCount + failureCount + 1);
}

function computeScore(confidence: number, avgIterations: number): number {
  // Penalizes high iteration count; normalizing by 20
  return confidence * (1 / (avgIterations / 20 + 0.1));
}

function buildRecommendation(ranking: Omit<StrategyRanking, "recommendation">): string {
  if (ranking.score >= 5) return `Highly recommended (score: ${ranking.score.toFixed(2)})`;
  if (ranking.score >= 2) return `Good candidate (score: ${ranking.score.toFixed(2)})`;
  if (ranking.score >= 0.5) return `Use with caution (score: ${ranking.score.toFixed(2)})`;
  return `Low confidence — consider alternatives (score: ${ranking.score.toFixed(2)})`;
}

// ─── Class ───

export class StrategyLearner extends EventEmitter {
  private readonly storageFile: string;
  private readonly storageDir: string;
  private metrics: StrategyMetric[];

  constructor(config?: StrategyLearnerConfig) {
    super();
    this.storageDir = config?.storageDir ?? join(homedir(), ".yuan", "strategy");
    this.storageFile = join(this.storageDir, "strategy-metrics.json");
    this.metrics = this._load();
  }

  /** Record a successful playbook run. Updates avgIterations with running avg. */
  recordSuccess(
    playbookId: string,
    taskType: string,
    iterations: number,
    tokensUsed: number,
  ): void {
    const metric = this._getOrCreate(playbookId, taskType);
    const n = metric.successCount + metric.failureCount + 1;
    metric.avgIterations = (metric.avgIterations * (n - 1) + iterations) / n;
    metric.avgTokensUsed = (metric.avgTokensUsed * (n - 1) + tokensUsed) / n;
    metric.successCount += 1;
    metric.confidence = computeConfidence(metric.successCount, metric.failureCount);
    metric.lastUsedAt = new Date().toISOString();
    this._save();
  }

  /** Record a failed playbook run. */
  recordFailure(
    playbookId: string,
    taskType: string,
    iterations: number,
    tokensUsed: number,
  ): void {
    const metric = this._getOrCreate(playbookId, taskType);
    const n = metric.successCount + metric.failureCount + 1;
    metric.avgIterations = (metric.avgIterations * (n - 1) + iterations) / n;
    metric.avgTokensUsed = (metric.avgTokensUsed * (n - 1) + tokensUsed) / n;
    metric.failureCount += 1;
    metric.confidence = computeConfidence(metric.successCount, metric.failureCount);
    metric.lastUsedAt = new Date().toISOString();
    this._save();
  }

  /**
   * Rank playbooks for a task type by composite score.
   * Score = confidence * (1 / (normalizedAvgIter + 0.1))
   * Emits agent:strategy_metric_update.
   */
  rankPlaybooks(taskType?: string): StrategyRanking[] {
    const candidates = taskType
      ? this.metrics.filter((m) => m.taskType === taskType)
      : [...this.metrics];

    if (candidates.length === 0) return [];

    // Compute scores
    const scored = candidates.map((m) => ({
      playbookId: m.playbookId,
      taskType: m.taskType,
      score: computeScore(m.confidence, m.avgIterations),
    }));

    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);

    const rankings: StrategyRanking[] = scored.map((s, idx) => {
      const partial = { playbookId: s.playbookId, taskType: s.taskType, rank: idx + 1, score: s.score };
      return {
        ...partial,
        recommendation: buildRecommendation(partial),
      };
    });

    // Emit event for the top metric in the ranking
    if (rankings.length > 0) {
      const top = rankings[0];
      const topMetric = this.metrics.find((m) => m.playbookId === top.playbookId);
      this.emit("event", {
        kind: "agent:strategy_metric_update",
        playbookId: top.playbookId,
        taskType: top.taskType,
        confidence: topMetric?.confidence ?? 0,
        avgIterations: topMetric?.avgIterations ?? 0,
        timestamp: Date.now(),
      });
    }

    return rankings;
  }

  /** Get metric for a specific playbook. */
  getMetric(playbookId: string): StrategyMetric | null {
    return this.metrics.find((m) => m.playbookId === playbookId) ?? null;
  }

  /** Get all metrics. */
  getAll(): StrategyMetric[] {
    return [...this.metrics];
  }

  // ─── Internal ───

  private _getOrCreate(playbookId: string, taskType: string): StrategyMetric {
    let metric = this.metrics.find((m) => m.playbookId === playbookId);
    if (!metric) {
      metric = {
        playbookId,
        taskType,
        successCount: 0,
        failureCount: 0,
        avgIterations: 0,
        avgTokensUsed: 0,
        lastUsedAt: new Date().toISOString(),
        confidence: 0,
      };
      this.metrics.push(metric);
    }
    return metric;
  }

  private _load(): StrategyMetric[] {
    try {
      if (!existsSync(this.storageDir)) {
        mkdirSync(this.storageDir, { recursive: true });
      }
      if (!existsSync(this.storageFile)) return [];
      const raw = readFileSync(this.storageFile, "utf-8");
      return JSON.parse(raw) as StrategyMetric[];
    } catch {
      return [];
    }
  }

  private _save(): void {
    const tmpFile = `${this.storageFile}.tmp`;
    try {
      writeFileSync(tmpFile, JSON.stringify(this.metrics, null, 2), "utf-8");
      renameSync(tmpFile, this.storageFile);
    } catch {
      // Non-fatal: storage failures should not crash the agent loop
    }
  }
}
