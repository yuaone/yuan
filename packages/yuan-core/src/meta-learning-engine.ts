/**
 * @module meta-learning-engine
 * @description Orchestrator that combines MetaLearningCollector + StrategyLearner
 * data to produce sophisticated `agent:policy_recommendation` events.
 *
 * ADVISORY ONLY — never writes to policy.json.
 * All output is proposals only, not commands.
 *
 * Storage: ~/.yuan/strategy/meta-learning-reports.json — last 10 reports.
 * Atomic writes (.tmp → renameSync).
 */

import { EventEmitter } from "events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { MetaLearningCollector } from "./meta-learning-collector.js";
import { StrategyLearner } from "./strategy-learner.js";

// ─── Types ───

export interface PolicyRecommendationDetail {
  id: string; // uuid
  type: "governor_tuning" | "playbook_preference" | "tool_ordering" | "iteration_budget";
  description: string;
  rationale: string;
  suggestedValue?: unknown; // e.g. { maxIterations: 12 } — PROPOSAL ONLY
  confidence: number; // 0..1
  supportingDataPoints: number;
  generatedAt: string; // ISO
}

export interface MetaLearningReport {
  generatedAt: string;
  totalTasksAnalyzed: number;
  recommendations: PolicyRecommendationDetail[];
  topPlaybooks: Array<{ playbookId: string; taskType: string; score: number }>;
  worstPerformingTaskTypes: string[];
  avgIterationsPerTaskType: Record<string, number>;
}

export interface MetaLearningEngineConfig {
  collector?: MetaLearningCollector;
  strategyLearner?: StrategyLearner;
  storageDir?: string;
  minDataPoints?: number; // default 10
}

// ─── Helpers ───

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ─── Class ───

export class MetaLearningEngine extends EventEmitter {
  private readonly collector: MetaLearningCollector;
  private readonly strategyLearner: StrategyLearner;
  private readonly storageFile: string;
  private readonly storageDir: string;
  private readonly minDataPoints: number;
  private lastReport: MetaLearningReport | null = null;

  constructor(config: MetaLearningEngineConfig = {}) {
    super();
    this.collector = config.collector ?? new MetaLearningCollector();
    this.strategyLearner = config.strategyLearner ?? new StrategyLearner();
    this.storageDir = config.storageDir ?? join(homedir(), ".yuan", "strategy");
    this.storageFile = join(this.storageDir, "meta-learning-reports.json");
    this.minDataPoints = config.minDataPoints ?? 10;
  }

  // ─── Public API ───

  /**
   * Run analysis and produce recommendations.
   * Emits `agent:policy_recommendation` event.
   * ADVISORY ONLY — does not write to policy.json.
   */
  async analyze(): Promise<MetaLearningReport> {
    const now = new Date().toISOString();
    const reportId = randomUUID();

    const allStats = this.collector.getStats();

    // Collect unique task types
    const taskTypes = [...new Set(allStats.map((s) => s.taskType))];

    // Compute avgIterations per taskType
    const avgIterationsPerTaskType: Record<string, number> = {};
    const iterationsByTaskType: Record<string, number[]> = {};

    for (const stat of allStats) {
      const arr = iterationsByTaskType[stat.taskType] ?? [];
      arr.push(stat.iterationsUsed);
      iterationsByTaskType[stat.taskType] = arr;
    }
    for (const taskType of taskTypes) {
      avgIterationsPerTaskType[taskType] = mean(iterationsByTaskType[taskType] ?? []);
    }

    // Collect base report from collector (for taskTypeStats / success rates)
    const collectorReport = this.collector.generateReport();

    // Worst performing task types: success rate < 50%
    const worstPerformingTaskTypes: string[] = [];
    for (const [taskType, stats] of Object.entries(collectorReport.taskTypeStats)) {
      const successRate = stats.total > 0 ? stats.success / stats.total : 0;
      if (successRate < 0.5 && stats.total >= this.minDataPoints) {
        worstPerformingTaskTypes.push(taskType);
      }
    }

    const recommendations: PolicyRecommendationDetail[] = [];

    // ── 1. Governor Tuning Recommendations ──
    for (const taskType of taskTypes) {
      const iterations = iterationsByTaskType[taskType] ?? [];
      const count = iterations.length;
      if (count < this.minDataPoints) continue;

      const avg = avgIterationsPerTaskType[taskType];

      if (avg > 15) {
        recommendations.push({
          id: randomUUID(),
          type: "governor_tuning",
          description: `Reduce maxIterations for taskType "${taskType}"`,
          rationale: `Average iterations (${avg.toFixed(1)}) exceeds 15 — reducing to 12 may cut cost without losing quality.`,
          suggestedValue: { maxIterations: 12, taskType },
          confidence: Math.min(0.9, (avg - 15) / 10 + 0.5),
          supportingDataPoints: count,
          generatedAt: now,
        });
      } else if (avg < 5) {
        recommendations.push({
          id: randomUUID(),
          type: "governor_tuning",
          description: `Increase maxIterations for taskType "${taskType}" to allow more exploration`,
          rationale: `Average iterations (${avg.toFixed(1)}) is below 5 — the agent may be under-exploring. Increasing budget may improve quality.`,
          suggestedValue: { maxIterations: 20, taskType },
          confidence: Math.min(0.8, (5 - avg) / 5 + 0.4),
          supportingDataPoints: count,
          generatedAt: now,
        });
      }
    }

    // ── 2. Playbook Preference Recommendations ──
    const topPlaybooks: Array<{ playbookId: string; taskType: string; score: number }> = [];

    for (const taskType of taskTypes) {
      const rankings = this.strategyLearner.rankPlaybooks(taskType);
      if (rankings.length === 0) continue;

      const top = rankings[0];
      topPlaybooks.push({ playbookId: top.playbookId, taskType: top.taskType, score: top.score });

      // Get the metric for confidence check
      const metric = this.strategyLearner.getMetric(top.playbookId);
      const confidence = metric?.confidence ?? 0;
      const totalRuns = (metric?.successCount ?? 0) + (metric?.failureCount ?? 0);

      if (confidence > 0.7 && totalRuns >= this.minDataPoints) {
        recommendations.push({
          id: randomUUID(),
          type: "playbook_preference",
          description: `Prefer playbook "${top.playbookId}" for taskType "${taskType}"`,
          rationale: `Playbook "${top.playbookId}" has confidence ${(confidence * 100).toFixed(1)}% over ${totalRuns} runs (score: ${top.score.toFixed(2)}).`,
          suggestedValue: { playbookId: top.playbookId, taskType },
          confidence,
          supportingDataPoints: totalRuns,
          generatedAt: now,
        });
      }
    }

    // ── 3. Tool Ordering Recommendations ──
    for (const taskType of taskTypes) {
      const successfulStats = allStats.filter((s) => s.taskType === taskType && s.success);
      const totalSuccessful = successfulStats.length;
      if (totalSuccessful < this.minDataPoints) continue;

      // Count tool appearances in successful runs
      const toolCounts = new Map<string, number>();
      for (const stat of successfulStats) {
        const seen = new Set<string>();
        for (const tool of stat.toolSequence) {
          if (!seen.has(tool)) {
            toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
            seen.add(tool);
          }
        }
      }

      for (const [tool, count] of toolCounts.entries()) {
        const rate = count / totalSuccessful;
        if (rate > 0.8) {
          recommendations.push({
            id: randomUUID(),
            type: "tool_ordering",
            description: `Always use tool "${tool}" early for taskType "${taskType}"`,
            rationale: `Tool "${tool}" appears in ${(rate * 100).toFixed(1)}% of successful runs for "${taskType}" (${count}/${totalSuccessful}). Using it early may improve outcomes.`,
            suggestedValue: { tool, taskType, position: "early" },
            confidence: Math.min(0.95, rate),
            supportingDataPoints: totalSuccessful,
            generatedAt: now,
          });
        }
      }
    }

    // ── 4. Iteration Budget Recommendations ──
    for (const taskType of taskTypes) {
      const iterations = iterationsByTaskType[taskType] ?? [];
      if (iterations.length < this.minDataPoints) continue;

      const sd = stddev(iterations);
      if (sd > 8) {
        const avg = avgIterationsPerTaskType[taskType];
        recommendations.push({
          id: randomUUID(),
          type: "iteration_budget",
          description: `Use adaptive iteration budget for taskType "${taskType}"`,
          rationale: `High variance in iteration counts (stddev: ${sd.toFixed(1)}, mean: ${avg.toFixed(1)}) across ${iterations.length} runs suggests a fixed budget is suboptimal. An adaptive budget (e.g. range ${Math.max(1, Math.round(avg - sd))}–${Math.round(avg + sd)}) may reduce wasted compute.`,
          suggestedValue: {
            taskType,
            minIterations: Math.max(1, Math.round(avg - sd)),
            maxIterations: Math.round(avg + sd),
            adaptive: true,
          },
          confidence: Math.min(0.85, sd / 20 + 0.4),
          supportingDataPoints: iterations.length,
          generatedAt: now,
        });
      }
    }

    const report: MetaLearningReport = {
      generatedAt: now,
      totalTasksAnalyzed: allStats.length,
      recommendations,
      topPlaybooks,
      worstPerformingTaskTypes,
      avgIterationsPerTaskType,
    };

    this.lastReport = report;
    this._saveReport(report);

    // Emit advisory event — PROPOSALS ONLY, not commands
    this.emit("event", {
      kind: "agent:policy_recommendation",
      recommendations,
      reportId,
      timestamp: Date.now(),
    });

    return report;
  }

  /** Get last report without re-analyzing. */
  getLastReport(): MetaLearningReport | null {
    return this.lastReport;
  }

  // ─── Internal ───

  private _saveReport(report: MetaLearningReport): void {
    const tmpFile = `${this.storageFile}.tmp`;
    try {
      if (!existsSync(this.storageDir)) {
        mkdirSync(this.storageDir, { recursive: true });
      }

      // Load existing reports (keep last 10)
      let existing: MetaLearningReport[] = [];
      if (existsSync(this.storageFile)) {
        try {
          const raw = readFileSync(this.storageFile, "utf-8");
          existing = JSON.parse(raw) as MetaLearningReport[];
        } catch {
          existing = [];
        }
      }

      existing.push(report);
      if (existing.length > 10) {
        existing = existing.slice(existing.length - 10);
      }

      writeFileSync(tmpFile, JSON.stringify(existing, null, 2), "utf-8");
      renameSync(tmpFile, this.storageFile);
    } catch {
      // Non-fatal: storage failures should not crash the agent loop
    }
  }
}
