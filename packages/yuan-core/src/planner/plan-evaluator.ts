/**
 * @module planner/plan-evaluator
 * @description Evaluates the health of a running HierarchicalPlan.
 * Detects deviations, predicts token overruns, and recommends corrective actions.
 */

import type { HierarchicalPlan } from "../hierarchical-planner.js";
import type { StateStore } from "../world-model/state-store.js";
import type { SimulationEngine } from "../world-model/simulation-engine.js";
import type { ToolResult } from "../types.js";

// ─── Types ───

export type DeviantType =
  | "unexpected_file"
  | "scope_creep"
  | "blocked_dependency"
  | "token_overrun"
  | "quality_regression";

export interface PlanDeviation {
  type: DeviantType;
  description: string;
  severity: "low" | "medium" | "high";
  affectedTaskIds: string[];
}

export interface PlanHealth {
  score: number;               // 0-100 (higher = healthier)
  completedTasks: number;
  totalTasks: number;
  progressRatio: number;       // 0-1
  tokensUsed: number;
  tokensRemaining: number;
  deviations: PlanDeviation[];
  recommendation: "continue" | "replan_minor" | "replan_major" | "abort";
}

// ─── PlanEvaluator ───

export class PlanEvaluator {
  constructor(
    private stateStore: StateStore,
    private simulationEngine: SimulationEngine,
  ) {}

  evaluate(
    plan: HierarchicalPlan,
    completedTaskIds: string[],
    toolResults: ToolResult[],
    tokensUsed: number,
    tokenBudget: number,
  ): PlanHealth {
    const completedSet = new Set(completedTaskIds);
    const totalTasks = plan.tactical.length;
    const completedTasks = completedTaskIds.length;
    const progressRatio = totalTasks > 0 ? completedTasks / totalTasks : 0;
    const tokensRemaining = tokenBudget - tokensUsed;

    const deviations: PlanDeviation[] = [];

    // 1. Detect unexpected file changes
    // ToolResult has no args field — callers should pass changedFiles separately.
    // We collect tool names that indicate file writes for quality assessment only.
    const writeToolCount = toolResults
      .filter(r => r.success && (r.name === "file_write" || r.name === "file_edit"))
      .length;
    void writeToolCount; // available for future heuristics
    deviations.push(...this.detectUnexpectedChanges(plan, []));

    // 2. Detect token overrun risk
    if (this.predictTokenOverrun(plan, tokensUsed, progressRatio)) {
      deviations.push({
        type: "token_overrun",
        description: `Token usage on pace to exceed budget (used ${Math.round(tokensUsed / 1000)}K / ${Math.round(tokenBudget / 1000)}K at ${Math.round(progressRatio * 100)}% completion)`,
        severity: tokensUsed / tokenBudget > 0.9 ? "high" : "medium",
        affectedTaskIds: plan.tactical.slice(completedTasks).map(t => t.id),
      });
    }

    // 3. Check for failed tool results
    const failedCount = toolResults.filter(r => !r.success).length;
    if (failedCount > 2) {
      deviations.push({
        type: "quality_regression",
        description: `${failedCount} tool executions failed`,
        severity: failedCount > 5 ? "high" : "medium",
        affectedTaskIds: [],
      });
    }

    // 4. Compute health score (100 = perfect)
    let score = 100;
    for (const d of deviations) {
      score -= d.severity === "high" ? 25 : d.severity === "medium" ? 10 : 5;
    }
    // Penalize low progress ratio relative to tokens used
    const efficiency = progressRatio / Math.max(tokensUsed / tokenBudget, 0.01);
    if (efficiency < 0.5) score -= 15;

    score = Math.max(0, Math.min(100, score));

    const recommendation: PlanHealth["recommendation"] =
      score < 20 ? "abort" :
      score < 45 ? "replan_major" :
      score < 65 ? "replan_minor" :
      "continue";

    return {
      score,
      completedTasks,
      totalTasks,
      progressRatio,
      tokensUsed,
      tokensRemaining,
      deviations,
      recommendation,
    };
  }

  detectUnexpectedChanges(
    plan: HierarchicalPlan,
    actualChangedFiles: string[],
  ): PlanDeviation[] {
    const plannedFiles = new Set(
      plan.tactical.flatMap(t => [...t.targetFiles, ...t.readFiles]),
    );
    const unexpected = actualChangedFiles.filter(f => !plannedFiles.has(f));
    if (unexpected.length === 0) return [];

    return [{
      type: "unexpected_file",
      description: `${unexpected.length} files modified outside plan: ${unexpected.slice(0, 3).join(", ")}${unexpected.length > 3 ? " ..." : ""}`,
      severity: unexpected.length > 5 ? "high" : unexpected.length > 2 ? "medium" : "low",
      affectedTaskIds: [],
    }];
  }

  predictTokenOverrun(
    plan: HierarchicalPlan,
    tokensUsed: number,
    completedRatio: number,
  ): boolean {
    if (completedRatio < 0.1) return false; // too early to predict
    const projectedTotal = tokensUsed / completedRatio;
    return projectedTotal > plan.estimatedTokenBudget * 1.3; // 30% over budget
  }
}
