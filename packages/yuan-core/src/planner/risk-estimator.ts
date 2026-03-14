/**
 * @module planner/risk-estimator
 * @description Estimates execution risk across multiple dimensions:
 * build, test, scope, dependency, and token budget.
 * Used by the autonomous planner to decide when to pause, re-plan, or alert.
 */

import type { ImpactAnalyzer } from "../impact-analyzer.js";
import type { TransitionModel } from "../world-model/transition-model.js";
import type { WorldState } from "../world-model/state-store.js";
import type { TacticalTask } from "../hierarchical-planner.js";

// ─── Types ───

export interface RiskComponents {
  buildRisk: number;        // 0-100: probability build will break
  testRisk: number;         // 0-100: probability tests will fail
  scopeRisk: number;        // 0-100: probability of unexpected scope expansion
  dependencyRisk: number;   // 0-100: probability of breaking dependent code
  tokenRisk: number;        // 0-100: probability of token budget overrun
}

export interface RiskScore {
  overall: number;          // 0-100 weighted average
  components: RiskComponents;
  factors: string[];        // human-readable risk explanations
  mitigations: string[];    // suggested mitigations
  level: "low" | "medium" | "high" | "critical";
}

// ─── RiskEstimator ───

export class RiskEstimator {
  constructor(
    private transitionModel: TransitionModel,
    private impactAnalyzer: ImpactAnalyzer,
  ) {}

  /**
   * Estimate overall risk given current world state, remaining tasks, and resource usage.
   */
  async estimate(
    currentState: WorldState,
    remainingTasks: TacticalTask[],
    completedTasks: TacticalTask[],
    changedFiles: string[],
    tokensUsed: number,
    tokenBudget: number,
    cachedImpact?: import("../impact-analyzer.js").ImpactReport,
  ): Promise<RiskScore> {
    const factors: string[] = [];
    const mitigations: string[] = [];

    // 1. Build risk: if build is already failing or many files changed
    let buildRisk = currentState.build.status === "fail" ? 80 : 10;
    buildRisk += Math.min(changedFiles.length * 3, 40);
    if (currentState.build.status === "fail") {
      factors.push("Build is currently failing");
      mitigations.push("Fix build errors before proceeding");
    }

    // 2. Test risk: if tests failing or many test files in remaining tasks
    let testRisk = currentState.test.status === "fail" ? 70 : 10;
    const testFilesInPlan = remainingTasks
      .flatMap((t) => t.targetFiles)
      .filter((f) => f.includes(".test.") || f.includes(".spec.")).length;
    testRisk += Math.min(testFilesInPlan * 5, 30);

    // 3. Scope risk: unexpected files being modified vs plan
    const plannedFiles = new Set(completedTasks.flatMap((t) => t.targetFiles));
    const unplannedChanges = changedFiles.filter((f) => !plannedFiles.has(f)).length;
    const scopeRisk = Math.min(unplannedChanges * 15, 80);
    if (unplannedChanges > 0) {
      factors.push(`${unplannedChanges} files modified outside original plan`);
    }

    // 4. Dependency risk: how many remaining tasks have complex dependency chains
    const avgDepsPerTask =
      remainingTasks.reduce((s, t) => s + t.dependsOn.length, 0) /
      Math.max(remainingTasks.length, 1);
    let dependencyRisk = Math.min(avgDepsPerTask * 15, 60);

    // If a pre-computed ImpactReport is provided, use it to refine dependency/build risk
    const impact = cachedImpact ?? await this.impactAnalyzer.analyzeChanges(changedFiles).catch(() => null);
    if (impact) {
      // Cascade file count raises dependency risk
      dependencyRisk = Math.min(dependencyRisk + impact.affectedFiles.length * 2, 80);
      if (impact.riskLevel === "critical" || impact.riskLevel === "high") {
        buildRisk = Math.min(buildRisk + 20, 100);
        factors.push(`Impact analysis: ${impact.riskLevel} risk, ${impact.breakingChanges.length} breaking changes`);
        if (impact.breakingChanges.length > 0) {
          mitigations.push("Review breaking changes before merging");
        }
      }
    }

    // 5. Token risk: extrapolate current usage to completion
    const completionRatio =
      completedTasks.length /
      Math.max(completedTasks.length + remainingTasks.length, 1);
    let tokenRisk = 0;
    if (completionRatio > 0.1) {
      const projectedTotal = tokensUsed / completionRatio;
      const overrunRatio = projectedTotal / tokenBudget;
      tokenRisk = Math.min(Math.max((overrunRatio - 0.7) * 200, 0), 100);
      if (tokenRisk > 50) {
        factors.push(`Projected token usage ${Math.round(overrunRatio * 100)}% of budget`);
        mitigations.push("Consider reducing scope or compacting context");
      }
    }

    const components: RiskComponents = {
      buildRisk: Math.round(Math.min(buildRisk, 100)),
      testRisk: Math.round(Math.min(testRisk, 100)),
      scopeRisk: Math.round(Math.min(scopeRisk, 100)),
      dependencyRisk: Math.round(Math.min(dependencyRisk, 100)),
      tokenRisk: Math.round(Math.min(tokenRisk, 100)),
    };

    // Weighted average: build and test are most important
    const overall = Math.round(
      components.buildRisk * 0.3 +
        components.testRisk * 0.25 +
        components.scopeRisk * 0.2 +
        components.dependencyRisk * 0.15 +
        components.tokenRisk * 0.1,
    );

    const level: RiskScore["level"] =
      overall >= 85
        ? "critical"
        : overall >= 70
          ? "high"
          : overall >= 40
            ? "medium"
            : "low";

    return { overall, components, factors, mitigations, level };
  }

  /**
   * Estimate risk for a single task given the current world state.
   * Returns a 0-100 score.
   */
  async estimateTaskRisk(task: TacticalTask, state: WorldState): Promise<number> {
    let risk = 0;

    // Build status contributes heavily
    if (state.build.status === "fail") risk += 40;
    else if (state.build.status === "unknown") risk += 10;

    // Test status
    if (state.test.status === "fail") risk += 25;

    // Number of target files (more files = more risk)
    risk += Math.min(task.targetFiles.length * 5, 20);

    // Number of dependencies
    risk += Math.min(task.dependsOn.length * 5, 15);

    return Math.min(risk, 100);
  }

  /**
   * Returns true if the risk score's overall value meets or exceeds the threshold.
   * Default threshold is 70 ("high").
   */
  isHighRisk(score: RiskScore, threshold = 70): boolean {
    return score.overall >= threshold;
  }
}
