/**
 * @module planner/milestone-checker
 * @description Tracks milestone progress within a HierarchicalPlan execution.
 * Milestones are checkpoints derived from tactical tasks that indicate overall
 * plan health and schedule adherence.
 */

import type { HierarchicalPlan } from "../hierarchical-planner.js";

// ─── Types ───

export interface Milestone {
  id: string;
  description: string;
  targetTaskIds: string[];      // milestone achieved when ALL these tasks complete
  expectedByIteration: number; // should be done by this iteration number
  priority: "must" | "should" | "could";
}

export interface MilestoneStatus {
  achieved: Milestone[];
  missed: Milestone[];
  pending: Milestone[];
  behindSchedule: boolean;      // any "must" milestone behind expectedByIteration
  consecutiveMisses: number;    // how many "must" milestones missed in a row
  overallProgress: number;      // 0-1, ratio of achieved/total
}

// ─── MilestoneChecker ───

export class MilestoneChecker {
  private milestones: Milestone[] = [];
  private consecutiveMisses = 0;
  private lastStatus: MilestoneStatus | null = null;

  /**
   * Extract milestones from a HierarchicalPlan.
   * Groups tactical tasks into milestones:
   * - Independent tasks (no dependsOn) → first "should" milestone
   * - Every 3 tasks → one "should" milestone
   * - Last task → one "must" milestone (completion)
   */
  extractMilestones(plan: HierarchicalPlan): Milestone[] {
    const tasks = plan.tactical;
    if (tasks.length === 0) return [];

    const milestones: Milestone[] = [];
    const totalIterations = plan.totalEstimatedIterations;

    // Milestone 1: Initial exploration (first batch of independent tasks)
    const independentFirst = tasks
      .filter((t) => t.dependsOn.length === 0)
      .map((t) => t.id);
    if (independentFirst.length > 0) {
      milestones.push({
        id: "milestone:initial",
        description: "Initial exploration and file reading complete",
        targetTaskIds: independentFirst.slice(0, Math.min(3, independentFirst.length)),
        expectedByIteration: Math.floor(totalIterations * 0.2),
        priority: "should",
      });
    }

    // Middle milestones: every 3 tasks
    for (let i = 0; i < tasks.length - 1; i += 3) {
      const batch = tasks.slice(i, i + 3).map((t) => t.id);
      milestones.push({
        id: `milestone:batch-${Math.floor(i / 3)}`,
        description: `Tasks ${i + 1}–${Math.min(i + 3, tasks.length)} complete`,
        targetTaskIds: batch,
        expectedByIteration: Math.floor(totalIterations * ((i + 3) / tasks.length)),
        priority: "should",
      });
    }

    // Final milestone: all tasks done
    milestones.push({
      id: "milestone:complete",
      description: "All planned tasks completed",
      targetTaskIds: tasks.map((t) => t.id),
      expectedByIteration: totalIterations,
      priority: "must",
    });

    this.milestones = milestones;
    return milestones;
  }

  /**
   * Evaluate current milestone status given completed tasks and current iteration.
   */
  check(
    milestones: Milestone[],
    completedTaskIds: string[],
    currentIteration: number,
  ): MilestoneStatus {
    const completedSet = new Set(completedTaskIds);
    const achieved: Milestone[] = [];
    const missed: Milestone[] = [];
    const pending: Milestone[] = [];

    for (const m of milestones) {
      const allDone = m.targetTaskIds.every((id) => completedSet.has(id));
      if (allDone) {
        achieved.push(m);
      } else if (currentIteration > m.expectedByIteration) {
        missed.push(m);
      } else {
        pending.push(m);
      }
    }

    // Track consecutive misses for "must" milestones
    const mustMissed = missed.filter((m) => m.priority === "must").length;
    if (mustMissed > 0) {
      this.consecutiveMisses++;
    } else if (achieved.length > 0) {
      this.consecutiveMisses = 0;
    }

    const status: MilestoneStatus = {
      achieved,
      missed,
      pending,
      behindSchedule: missed.some((m) => m.priority === "must"),
      consecutiveMisses: this.consecutiveMisses,
      overallProgress: milestones.length > 0 ? achieved.length / milestones.length : 1,
    };

    this.lastStatus = status;
    return status;
  }

  /**
   * Register externally defined milestones.
   */
  setMilestones(milestones: Milestone[]): void {
    this.milestones = milestones;
  }

  /**
   * Get milestones at risk: pending milestones past their expectedByIteration.
   */
  getAtRisk(currentIteration: number): Milestone[] {
    return this.milestones.filter(
      (m) =>
        currentIteration > m.expectedByIteration &&
        !this.lastStatus?.achieved.some((a) => a.id === m.id),
    );
  }
}
