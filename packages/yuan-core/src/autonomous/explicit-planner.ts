/**
 * @module autonomous/explicit-planner
 * @description ExplicitPlanningEngine — generates an explicit numbered plan before coding
 * and persists it to .yuan/tasks/<taskId>/plan.json.
 *
 * Wraps HierarchicalPlanner: uses its TacticalTask list as plan steps,
 * adds task-level persistence and event emission.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  HierarchicalPlanner,
  type HierarchicalPlannerConfig,
  type TacticalTask,
} from "../hierarchical-planner.js";
import type { BYOKClient } from "../llm-client.js";
import type { AgentEvent } from "../types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AutonomousPlanStep {
  index: number;
  description: string;
  /** 0-based indices of steps this depends on */
  dependsOn: number[];
  /** Files to be modified */
  targetFiles?: string[];
}

export interface ExplicitPlan {
  taskId: string;
  goal: string;
  steps: AutonomousPlanStep[];
  /** ISO timestamp */
  createdAt: string;
  /** Path to this plan file */
  storedAt: string;
}

export interface ExplicitPlannerConfig {
  plannerConfig?: Partial<HierarchicalPlannerConfig>;
  tasksDir?: string;
  projectPath?: string;
}

// ─── ExplicitPlanningEngine ──────────────────────────────────────────────────

export class ExplicitPlanningEngine extends EventEmitter {
  private readonly tasksDir: string;
  private readonly projectPath: string;

  constructor(config: ExplicitPlannerConfig = {}) {
    super();
    this.projectPath = config.projectPath ?? process.cwd();
    this.tasksDir = config.tasksDir ?? join(homedir(), ".yuan", "tasks");
    mkdirSync(this.tasksDir, { recursive: true });
  }

  /**
   * Generate an explicit plan for a goal using HierarchicalPlanner.
   * Persists to .yuan/tasks/<taskId>/plan.json and emits agent:plan_generated.
   */
  async plan(
    goal: string,
    llmClient: BYOKClient,
    taskId?: string,
    context?: string,
  ): Promise<ExplicitPlan> {
    const resolvedTaskId = taskId ?? randomUUID();

    // Build planner config with required projectPath
    const planner = new HierarchicalPlanner({
      projectPath: this.projectPath,
      maxSubGoals: 10,
      maxTasksPerGoal: 20,
    });

    // Get tactical plan from HierarchicalPlanner
    let tacticalTasks: TacticalTask[] = [];
    try {
      const strategic = await planner.planStrategic(goal, llmClient, context);
      tacticalTasks = await planner.planTactical(strategic, llmClient);
    } catch {
      // Fallback: single-step plan if LLM fails
      tacticalTasks = [{
        id: "task-0",
        goalId: "goal-0",
        description: goal,
        targetFiles: [],
        readFiles: [],
        toolStrategy: ["file_read", "file_edit"],
        order: 0,
        dependsOn: [],
        estimatedIterations: 3,
      }];
    }

    // Convert TacticalTask[] to AutonomousPlanStep[] (ordered by .order)
    const sorted = [...tacticalTasks].sort((a, b) => a.order - b.order);
    const steps: AutonomousPlanStep[] = sorted.map((t, i) => ({
      index: i,
      description: t.description,
      dependsOn: t.dependsOn
        .map(depId => sorted.findIndex(s => s.id === depId))
        .filter((idx): idx is number => idx !== -1),
      targetFiles: t.targetFiles,
    }));

    // Persist to .yuan/tasks/<taskId>/plan.json
    const taskDir = join(this.tasksDir, resolvedTaskId);
    mkdirSync(taskDir, { recursive: true });
    const storedAt = join(taskDir, "plan.json");
    const plan: ExplicitPlan = {
      taskId: resolvedTaskId,
      goal,
      steps,
      createdAt: new Date().toISOString(),
      storedAt,
    };
    writeFileSync(storedAt, JSON.stringify(plan, null, 2), "utf-8");

    // Emit event
    this.emitPlanGenerated(plan);
    return plan;
  }

  // ─── private ───────────────────────────────────────────────────────────────

  private emitPlanGenerated(plan: ExplicitPlan): void {
    const event: AgentEvent = {
      kind: "agent:plan_generated",
      taskId: plan.taskId,
      steps: plan.steps.map(s => ({
        index: s.index,
        description: s.description,
        dependsOn: s.dependsOn,
      })),
      storedAt: plan.storedAt,
      timestamp: Date.now(),
    };
    this.emit("event", event);
  }
}
