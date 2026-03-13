/**
 * @module world-model/simulation-engine
 * @description Simulates the execution of a HierarchicalPlan against the current WorldState.
 * Predicts failure probabilities and risk factors for each step before actual execution.
 */

import type { HierarchicalPlan, TacticalTask } from "../hierarchical-planner.js";
import type { StateStore, WorldState } from "./state-store.js";
import type { TransitionModel } from "./transition-model.js";

// ─── Interfaces ───

export interface SimulationStep {
  taskId: string;
  taskDescription: string;
  predictedState: WorldState;
  /** Probability that this specific step fails (0.0 – 1.0) */
  failureProbability: number;
  /** Probability that ANY step up to and including this one fails */
  cumulativeFailureProbability: number;
  riskFactors: string[];
  estimatedIterations: number;
}

export interface SimulationResult {
  planId: string;
  steps: SimulationStep[];
  /** 1 – P(any step fails) */
  overallSuccessProbability: number;
  /** taskIds where failureProbability > 0.3 */
  criticalSteps: string[];
  /** Sum of task.estimatedIterations * 2000 */
  estimatedTotalTokens: number;
  warnings: string[];
  simulatedAt: number;
}

// ─── SimulationEngine ───

export class SimulationEngine {
  constructor(
    private transitionModel: TransitionModel,
    private stateStore: StateStore,
  ) {}

  /**
   * Simulate the entire plan — call this after createHierarchicalPlan().
   * Walks tactical tasks in order, predicting failure and state at each step.
   */
  async simulate(plan: HierarchicalPlan): Promise<SimulationResult> {
    let currentState = this.stateStore.getState();
    const steps: SimulationStep[] = [];

    // Cumulative survival probability: starts at 1.0 (no failures yet)
    let survivalProbability = 1.0;

    for (const task of plan.tactical) {
      const step = this.simulateTask(task, currentState);

      // Cumulative: P(all previous steps succeed AND this one fails)
      survivalProbability *= 1 - step.failureProbability;
      step.cumulativeFailureProbability = 1 - survivalProbability;

      steps.push(step);
      // Advance state for the next step's simulation
      currentState = step.predictedState;
    }

    const overallSuccessProbability = survivalProbability;
    const criticalSteps = steps
      .filter((s) => s.failureProbability > 0.3)
      .map((s) => s.taskId);

    const estimatedTotalTokens = plan.tactical.reduce(
      (sum, t) => sum + t.estimatedIterations * 2000,
      0,
    );

    const warnings: string[] = [];

    if (overallSuccessProbability < 0.5) {
      warnings.push("High risk plan: less than 50% chance of full success");
    }

    for (const step of steps) {
      if (step.predictedState.build.status === "fail") {
        warnings.push(`Build may break at step ${step.taskId}`);
      }
    }

    return {
      planId: plan.id,
      steps,
      overallSuccessProbability,
      criticalSteps,
      estimatedTotalTokens,
      warnings,
      simulatedAt: Date.now(),
    };
  }

  /**
   * Simulate a single tactical task given the current WorldState.
   * Aggregates per-tool predictions across the task's toolStrategy.
   */
  simulateTask(task: TacticalTask, currentState: WorldState): SimulationStep {
    const targetFile = task.targetFiles[0];
    const argsForTool: Record<string, unknown> = targetFile ? { path: targetFile } : {};

    // Aggregate deltas and failure probabilities from all tools in the strategy
    const allFilesChanged: string[] = [];
    const allFilesCreated: string[] = [];
    const allFilesDeleted: string[] = [];
    let buildInvalidated = false;
    let testInvalidated = false;
    let gitDirty = false;

    // Product of (1 - p_i) — we'll convert to failure probability after the loop
    let survivalProduct = 1.0;
    const riskFactors: string[] = [];

    for (const toolName of task.toolStrategy) {
      const transition = this.transitionModel.predict(toolName, argsForTool, currentState);
      const delta = transition.expectedDelta;

      // Aggregate file changes
      allFilesChanged.push(...delta.filesChanged);
      allFilesCreated.push(...delta.filesCreated);
      allFilesDeleted.push(...delta.filesDeleted);

      if (delta.buildInvalidated) buildInvalidated = true;
      if (delta.testInvalidated) testInvalidated = true;
      if (delta.gitDirty) gitDirty = true;

      survivalProduct *= 1 - transition.failureProbability;

      if (transition.failureProbability > 0.1) {
        riskFactors.push(`${toolName}: ${transition.reasoning}`);
      }
    }

    // If toolStrategy is empty, default to 0 failure probability (no-op task)
    const failureProbability = task.toolStrategy.length > 0 ? 1 - survivalProduct : 0;

    // Build predicted state by applying the aggregated delta
    const predictedState = this._applyAggregateDelta(currentState, {
      filesChanged: [...new Set(allFilesChanged)],
      filesCreated: [...new Set(allFilesCreated)],
      filesDeleted: [...new Set(allFilesDeleted)],
      buildInvalidated,
      testInvalidated,
      gitDirty,
    });

    return {
      taskId: task.id,
      taskDescription: task.description,
      predictedState,
      failureProbability,
      cumulativeFailureProbability: 0, // will be set by simulate()
      riskFactors,
      estimatedIterations: task.estimatedIterations,
    };
  }

  /**
   * Predict the WorldState at a specific task index (0-based).
   * Replays simulation up to (and including) taskIndex.
   */
  predictStateAt(plan: HierarchicalPlan, taskIndex: number): WorldState {
    let currentState = this.stateStore.getState();

    for (let i = 0; i <= taskIndex && i < plan.tactical.length; i++) {
      const task = plan.tactical[i];
      const step = this.simulateTask(task, currentState);
      currentState = step.predictedState;
    }

    return currentState;
  }

  /**
   * Format the simulation result for injection into an LLM prompt.
   */
  formatForPrompt(result: SimulationResult): string {
    const lines = [
      `## Plan Simulation (${Math.round(result.overallSuccessProbability * 100)}% success probability)`,
    ];

    if (result.criticalSteps.length > 0) {
      lines.push(`⚠️ Critical steps (high risk): ${result.criticalSteps.join(", ")}`);
    }

    for (const w of result.warnings) {
      lines.push(`⚠️ ${w}`);
    }

    lines.push(`Estimated tokens: ~${result.estimatedTotalTokens.toLocaleString()}`);

    return lines.join("\n");
  }

  // ─── Private Helpers ───

  /** Apply an aggregated delta to produce a new WorldState. Never mutates input. */
  private _applyAggregateDelta(
    state: WorldState,
    delta: {
      filesChanged: string[];
      filesCreated: string[];
      filesDeleted: string[];
      buildInvalidated: boolean;
      testInvalidated: boolean;
      gitDirty: boolean;
    },
  ): WorldState {
    const nextFiles = new Map(state.files);
    const now = Date.now();

    for (const path of delta.filesChanged) {
      const existing = nextFiles.get(path);
      nextFiles.set(path, {
        path,
        exists: true,
        hash: "",
        lines: existing?.lines ?? 0,
        lastModified: now,
      });
    }

    for (const path of delta.filesCreated) {
      nextFiles.set(path, {
        path,
        exists: true,
        hash: "",
        lines: 0,
        lastModified: now,
      });
    }

    for (const path of delta.filesDeleted) {
      const existing = nextFiles.get(path);
      if (existing) {
        nextFiles.set(path, { ...existing, exists: false });
      }
    }

    const nextBuild = delta.buildInvalidated
      ? { ...state.build, status: "unknown" as const }
      : state.build;

    const nextTest = delta.testInvalidated
      ? { ...state.test, status: "unknown" as const }
      : state.test;

    let nextGit = state.git;
    if (delta.gitDirty && !state.git.dirty) {
      nextGit = { ...state.git, dirty: true };
    }

    return {
      ...state,
      files: nextFiles,
      build: nextBuild,
      test: nextTest,
      git: nextGit,
      timestamp: now,
    };
  }
}
