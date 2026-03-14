/**
 * @module meta-learning-collector
 * @description Meta-Learning Collector — SHADOW mode statistics collection.
 * Collects task-type × policy-choice × outcome statistics.
 *
 * Storage: ~/.yuan/meta-stats/{projectHash}.json
 *
 * Safety: NEVER writes to policy.json. Produces recommendation reports only.
 * All stats are append-only (never modify history).
 */

import { EventEmitter } from "events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

export interface TaskRunStat {
  id: string;
  taskType: string;
  governorPolicies: Record<string, string>; // subsystem → "OFF"|"SHADOW"|"BLOCKING"
  toolSequence: string[];
  latencyMs: number;
  tokensUsed: number;
  success: boolean;
  iterationsUsed: number;
  timestamp: string;
}

export interface PolicyRecommendation {
  subsystem: string;           // e.g. "research", "tournament", "quickVerify"
  currentMode: string;
  recommendedMode: string;
  reasoning: string;
  supportingSamples: number;
  confidence: number;
}

export interface MetaLearningReport {
  generatedAt: string;
  totalSamples: number;
  recommendations: PolicyRecommendation[];
  taskTypeStats: Record<string, { total: number; success: number; avgLatencyMs: number }>;
}

export interface MetaLearningConfig {
  projectPath?: string;
  storageDir?: string;         // default ~/.yuan/meta-stats/
  minSamplesForRecommendation?: number; // default 10
}

// ─── Helpers ───

function stableHash(projectPath: string): string {
  return Buffer.from(projectPath)
    .toString("base64")
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 8);
}

// ─── Class ───

export class MetaLearningCollector extends EventEmitter {
  private readonly storageFile: string;
  private readonly minSamplesForRecommendation: number;
  private stats: TaskRunStat[];

  constructor(config: MetaLearningConfig = {}) {
    super();
    const projectPath = config.projectPath ?? process.cwd();
    const storageDir = config.storageDir ?? join(homedir(), ".yuan", "meta-stats");
    this.minSamplesForRecommendation = config.minSamplesForRecommendation ?? 10;

    const hash = stableHash(projectPath);
    this.storageFile = join(storageDir, `${hash}.json`);
    this.stats = this._load(storageDir);
  }

  // ─── Public API ───

  /** Record a task run stat (call after each run). */
  record(stat: Omit<TaskRunStat, "id" | "timestamp">): void {
    const full: TaskRunStat = {
      ...stat,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    };
    this.stats.push(full);
    this._save();
  }

  /**
   * Generate a recommendation report from collected stats.
   * Does NOT write to policy.json — returns report only.
   * Emits agent:meta_learning_report.
   */
  generateReport(): MetaLearningReport {
    const now = new Date().toISOString();

    // Build taskType stats
    const taskTypeStats: Record<string, { total: number; success: number; avgLatencyMs: number }> = {};
    for (const stat of this.stats) {
      const entry = taskTypeStats[stat.taskType] ?? { total: 0, success: 0, avgLatencyMs: 0 };
      entry.total += 1;
      if (stat.success) entry.success += 1;
      // running average
      entry.avgLatencyMs = (entry.avgLatencyMs * (entry.total - 1) + stat.latencyMs) / entry.total;
      taskTypeStats[stat.taskType] = entry;
    }

    // Collect all unique subsystems
    const subsystems = new Set<string>();
    for (const stat of this.stats) {
      for (const sub of Object.keys(stat.governorPolicies)) {
        subsystems.add(sub);
      }
    }

    const recommendations: PolicyRecommendation[] = [];

    for (const subsystem of subsystems) {
      // Group stats by the policy mode for this subsystem
      const byMode = new Map<string, TaskRunStat[]>();
      for (const stat of this.stats) {
        const mode = stat.governorPolicies[subsystem];
        if (!mode) continue;
        const arr = byMode.get(mode) ?? [];
        arr.push(stat);
        byMode.set(mode, arr);
      }

      const offStats = byMode.get("OFF") ?? [];
      const shadowStats = byMode.get("SHADOW") ?? [];
      const blockingStats = byMode.get("BLOCKING") ?? [];

      // OFF → SHADOW: if OFF has lower success rate than SHADOW
      if (offStats.length >= this.minSamplesForRecommendation && shadowStats.length >= this.minSamplesForRecommendation) {
        const offSuccessRate = offStats.filter((s) => s.success).length / offStats.length;
        const shadowSuccessRate = shadowStats.filter((s) => s.success).length / shadowStats.length;
        const delta = shadowSuccessRate - offSuccessRate;
        if (delta > 0) {
          const confidence = Math.min(delta / 0.5, 0.9);
          recommendations.push({
            subsystem,
            currentMode: "OFF",
            recommendedMode: "SHADOW",
            reasoning: `SHADOW mode shows ${(delta * 100).toFixed(1)}% higher success rate than OFF (${(shadowSuccessRate * 100).toFixed(1)}% vs ${(offSuccessRate * 100).toFixed(1)}%) across ${offStats.length + shadowStats.length} samples.`,
            supportingSamples: offStats.length + shadowStats.length,
            confidence,
          });
        }
      }

      // SHADOW → BLOCKING: if enabling correlates with >15% delta
      if (shadowStats.length >= this.minSamplesForRecommendation && blockingStats.length >= this.minSamplesForRecommendation) {
        const shadowSuccessRate = shadowStats.filter((s) => s.success).length / shadowStats.length;
        const blockingSuccessRate = blockingStats.filter((s) => s.success).length / blockingStats.length;
        const delta = blockingSuccessRate - shadowSuccessRate;
        if (delta > 0.15) {
          const confidence = Math.min(delta / 0.5, 0.9);
          recommendations.push({
            subsystem,
            currentMode: "SHADOW",
            recommendedMode: "BLOCKING",
            reasoning: `BLOCKING mode shows ${(delta * 100).toFixed(1)}% higher success rate than SHADOW (${(blockingSuccessRate * 100).toFixed(1)}% vs ${(shadowSuccessRate * 100).toFixed(1)}%) across ${shadowStats.length + blockingStats.length} samples.`,
            supportingSamples: shadowStats.length + blockingStats.length,
            confidence,
          });
        }
      }
    }

    const report: MetaLearningReport = {
      generatedAt: now,
      totalSamples: this.stats.length,
      recommendations,
      taskTypeStats,
    };

    this.emit("agent:meta_learning_report", {
      kind: "agent:meta_learning_report",
      totalSamples: this.stats.length,
      recommendations: recommendations.length,
      timestamp: Date.now(),
    });

    return report;
  }

  /** Get all recorded stats. */
  getStats(taskType?: string): TaskRunStat[] {
    if (!taskType) return [...this.stats];
    return this.stats.filter((s) => s.taskType === taskType);
  }

  // ─── Internal ───

  private _load(storageDir: string): TaskRunStat[] {
    try {
      if (!existsSync(storageDir)) {
        mkdirSync(storageDir, { recursive: true });
      }
      if (!existsSync(this.storageFile)) return [];
      const raw = readFileSync(this.storageFile, "utf8");
      return JSON.parse(raw) as TaskRunStat[];
    } catch {
      return [];
    }
  }

  private _save(): void {
    const tmpFile = `${this.storageFile}.tmp`;
    try {
      writeFileSync(tmpFile, JSON.stringify(this.stats, null, 2), "utf8");
      renameSync(tmpFile, this.storageFile);
    } catch {
      // Non-fatal: storage failures should not crash the agent loop
    }
  }
}
