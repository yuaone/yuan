/**
 * @module planner/replanning-engine
 * @description Proactive replanning engine — evaluates plan health mid-execution
 * and triggers partial or full replanning when deviations are detected.
 */

import type {
  HierarchicalPlan,
  HierarchicalPlanner,
  TacticalTask,
  RePlanTrigger,
} from "../hierarchical-planner.js";
import type { BYOKClient } from "../llm-client.js";
import type { WorldState } from "../world-model/state-store.js";
import type { ToolResult } from "../types.js";
import type { PlanEvaluator, PlanHealth } from "./plan-evaluator.js";
import type { RiskEstimator, RiskScore } from "./risk-estimator.js";
import type { MilestoneChecker, MilestoneStatus, Milestone } from "./milestone-checker.js";

// ─── Types ───

export interface ReplanDecision {
  shouldReplan: boolean;
  scope: "none" | "operational" | "tactical" | "strategic";
  trigger: string;
  urgency: "low" | "medium" | "high" | "critical";
  reasoning: string;
}

export interface ProactiveReplanResult {
  triggered: boolean;
  decision: ReplanDecision;
  newPlan?: HierarchicalPlan;
  modifiedTasks?: TacticalTask[];
  message: string;
}

// ─── ReplanningEngine ───

export class ReplanningEngine {
  constructor(
    private planner: HierarchicalPlanner,
    private planEvaluator: PlanEvaluator,
    private riskEstimator: RiskEstimator,
    private milestoneChecker: MilestoneChecker,
  ) {}

  async evaluate(
    plan: HierarchicalPlan,
    currentState: WorldState,
    completedTaskIds: string[],
    toolResults: ToolResult[],
    tokensUsed: number,
    tokenBudget: number,
    changedFiles: string[],
    currentIteration: number,
    activeMilestones: Milestone[],
    llmClient: BYOKClient,
  ): Promise<ProactiveReplanResult> {
    const remainingTasks = plan.tactical.filter(t => !completedTaskIds.includes(t.id));
    const completedTasks = plan.tactical.filter(t => completedTaskIds.includes(t.id));

    // 1. Evaluate plan health
    const health = this.planEvaluator.evaluate(
      plan,
      completedTaskIds,
      toolResults,
      tokensUsed,
      tokenBudget,
    );

    // 2. Estimate risk
    const risk = await this.riskEstimator.estimate(
      currentState,
      remainingTasks,
      completedTasks,
      changedFiles,
      tokensUsed,
      tokenBudget,
    );

    // 3. Check milestones
    const milestoneStatus = this.milestoneChecker.check(
      activeMilestones,
      completedTaskIds,
      currentIteration,
    );

    // 4. Decide whether to replan
    const decision = this.shouldTrigger(health, risk, milestoneStatus);

    if (!decision.shouldReplan) {
      return { triggered: false, decision, message: "Plan on track" };
    }

    // 5. Execute replan
    try {
      const result = await this.executeReplan(plan, decision, currentState, llmClient);
      const message = `Proactive replan triggered (${decision.scope}): ${decision.trigger}`;
      return { triggered: true, decision, modifiedTasks: result, message };
    } catch (err) {
      return {
        triggered: false,
        decision,
        message: `Replan attempted but failed: ${String(err)}`,
      };
    }
  }

  private shouldTrigger(
    health: PlanHealth,
    risk: RiskScore,
    milestoneStatus: MilestoneStatus,
  ): ReplanDecision {
    // Critical: abort conditions
    if (health.recommendation === "abort") {
      return {
        shouldReplan: true,
        scope: "strategic",
        trigger: "Plan health critical",
        urgency: "critical",
        reasoning: `Health score ${health.score}/100, recommendation: abort`,
      };
    }

    // High risk → strategic replan
    if (risk.overall >= 85) {
      return {
        shouldReplan: true,
        scope: "strategic",
        trigger: `Risk score ${risk.overall}/100`,
        urgency: "critical",
        reasoning: risk.factors.join("; "),
      };
    }

    // Medium-high risk → tactical replan
    if (risk.overall >= 70) {
      return {
        shouldReplan: true,
        scope: "tactical",
        trigger: `Elevated risk: ${risk.overall}/100`,
        urgency: "high",
        reasoning: risk.factors.join("; "),
      };
    }

    // Major health issues → major replan
    if (health.recommendation === "replan_major") {
      return {
        shouldReplan: true,
        scope: "tactical",
        trigger: "Plan health deteriorated",
        urgency: "high",
        reasoning: health.deviations.map(d => d.description).join("; "),
      };
    }

    // Milestone misses
    if (milestoneStatus.consecutiveMisses >= 2) {
      return {
        shouldReplan: true,
        scope: "tactical",
        trigger: `${milestoneStatus.consecutiveMisses} consecutive milestone misses`,
        urgency: "high",
        reasoning: "Falling behind schedule",
      };
    }

    // Minor issues → minor replan
    if (health.recommendation === "replan_minor") {
      return {
        shouldReplan: true,
        scope: "operational",
        trigger: "Minor plan deviations",
        urgency: "medium",
        reasoning: health.deviations.map(d => d.description).join("; "),
      };
    }

    return {
      shouldReplan: false,
      scope: "none",
      trigger: "",
      urgency: "low",
      reasoning: "Plan healthy",
    };
  }

  private async executeReplan(
    plan: HierarchicalPlan,
    decision: ReplanDecision,
    _currentState: WorldState,
    llmClient: BYOKClient,
  ): Promise<TacticalTask[]> {
    const triggerType: RePlanTrigger["type"] =
      decision.scope === "strategic" ? "strategic" : "error";

    const severity: RePlanTrigger["severity"] =
      decision.urgency === "critical" ? "critical" :
      decision.urgency === "high" ? "major" :
      "minor";

    const trigger: RePlanTrigger = {
      type: triggerType,
      description: `[Proactive] ${decision.trigger}: ${decision.reasoning}`,
      affectedTaskIds: [],
      severity,
    };

    const result = await this.planner.replan(plan, trigger, llmClient);
    return result.modifiedTasks;
  }
}
