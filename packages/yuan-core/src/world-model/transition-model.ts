/**
 * @module world-model/transition-model
 * @description Predicts how each tool call will change the WorldState.
 * Uses rule-based heuristics with calibration via actual outcomes.
 */

import type { WorldState } from "./state-store.js";

// ─── Interfaces ───

export interface StateDelta {
  /** Files that will be modified */
  filesChanged: string[];
  /** Files that will be created */
  filesCreated: string[];
  /** Files that will be deleted */
  filesDeleted: string[];
  /** Does this action require a build re-run? */
  buildInvalidated: boolean;
  /** Does this action require a test re-run? */
  testInvalidated: boolean;
  /** Will git become dirty? */
  gitDirty: boolean;
}

export interface StateTransition {
  tool: string;
  args: Record<string, unknown>;
  expectedDelta: StateDelta;
  /** 0.0 to 1.0 */
  failureProbability: number;
  /** Explanation for this probability */
  reasoning: string;
}

/** Internal record for calibrating accuracy */
interface TransitionRecord {
  predicted: StateTransition;
  actual: StateDelta;
  success: boolean;
  timestamp: number;
}

/** Per-tool accuracy tracking for calibration */
interface ToolAccuracy {
  attempts: number;
  successes: number;
  /** Moving average multiplier applied to base failure probability */
  multiplier: number;
}

// ─── Helpers ───

function emptyDelta(): StateDelta {
  return {
    filesChanged: [],
    filesCreated: [],
    filesDeleted: [],
    buildInvalidated: false,
    testInvalidated: false,
    gitDirty: false,
  };
}

function getStringArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof args[key] === "string") return args[key] as string;
  }
  return undefined;
}

// ─── TransitionModel ───

export class TransitionModel {
  private history: TransitionRecord[];
  /** Per tool-type accuracy for calibration */
  private accuracy: Map<string, ToolAccuracy>;

  constructor() {
    this.history = [];
    this.accuracy = new Map();
  }

  /**
   * Predict what will happen when a tool is called with given args.
   * Uses rule-based heuristics + calibration multipliers.
   */
  predict(
    tool: string,
    args: Record<string, unknown>,
    currentState: WorldState,
  ): StateTransition {
    const delta = emptyDelta();
    let baseProbability = 0.10;
    let reasoning = "unknown tool — default failure probability";

    const toolLower = tool.toLowerCase();

    if (toolLower === "file_write" || toolLower === "file_edit") {
      const filePath = getStringArg(args, "path", "file_path");
      if (filePath) delta.filesChanged.push(filePath);
      delta.buildInvalidated = true;
      delta.testInvalidated = true;
      delta.gitDirty = true;
      baseProbability = 0.05;
      reasoning = "file write/edit — rarely fails, invalidates build and tests";
    } else if (toolLower === "shell_exec") {
      const command = getStringArg(args, "command", "cmd") ?? "";
      const cmdLower = command.toLowerCase();

      if (cmdLower.includes("tsc") || cmdLower.includes("build") || cmdLower.includes("compile")) {
        // This IS the build — not invalidated
        delta.buildInvalidated = false;
        delta.testInvalidated = false;
        // Count dirty files in currentState to scale failure probability
        let changedFilesCount = 0;
        for (const [, fileState] of currentState.files) {
          if (fileState.exists) changedFilesCount++;
        }
        baseProbability = 0.15 + 0.03 * changedFilesCount;
        reasoning = `build command — base 0.15 + 0.03 × ${changedFilesCount} changed files = ${baseProbability.toFixed(3)}`;
      } else if (
        cmdLower.includes("test") ||
        cmdLower.includes("jest") ||
        cmdLower.includes("vitest") ||
        cmdLower.includes("mocha")
      ) {
        // This IS the test run
        delta.testInvalidated = false;
        baseProbability = 0.20;
        reasoning = "test command — higher baseline failure probability (0.20)";
      } else {
        baseProbability = 0.10;
        reasoning = "shell command — default failure probability";
      }
    } else if (toolLower === "git_ops") {
      const operation = getStringArg(args, "operation", "op") ?? "";
      if (operation === "commit") {
        delta.gitDirty = false;
        baseProbability = 0.02;
        reasoning = "git commit — very unlikely to fail";
      } else {
        baseProbability = 0.05;
        reasoning = "git operation — low failure probability";
      }
    } else if (
      toolLower === "grep" ||
      toolLower === "glob" ||
      toolLower === "file_read" ||
      toolLower === "code_search"
    ) {
      // Read-only — no state changes
      baseProbability = 0.01;
      reasoning = "read-only tool — minimal failure probability";
    }

    // Apply calibration multiplier if available
    const acc = this.accuracy.get(toolLower);
    const calibratedProbability = acc
      ? Math.min(1.0, baseProbability * acc.multiplier)
      : baseProbability;

    if (acc && acc.multiplier !== 1.0) {
      reasoning += ` (calibrated ×${acc.multiplier.toFixed(2)})`;
    }

    return {
      tool,
      args,
      expectedDelta: delta,
      failureProbability: calibratedProbability,
      reasoning,
    };
  }

  /**
   * After actual execution, calibrate the model's accuracy for this tool type.
   * Uses a simple exponential moving average on the multiplier.
   */
  calibrate(predicted: StateTransition, actual: StateDelta, success: boolean): void {
    const toolLower = predicted.tool.toLowerCase();

    // Record outcome
    this.history.push({
      predicted,
      actual,
      success,
      timestamp: Date.now(),
    });

    // Update per-tool accuracy
    const existing = this.accuracy.get(toolLower) ?? {
      attempts: 0,
      successes: 0,
      multiplier: 1.0,
    };

    existing.attempts++;
    if (success) existing.successes++;

    // Adjust multiplier: if actual failure rate differs from predicted, nudge multiplier
    // Use EMA with alpha = 0.2
    if (existing.attempts >= 3) {
      const actualFailRate = 1 - existing.successes / existing.attempts;
      const predictedFailRate = predicted.failureProbability;

      if (predictedFailRate > 0) {
        const ratio = actualFailRate / predictedFailRate;
        const alpha = 0.2;
        existing.multiplier = existing.multiplier * (1 - alpha) + ratio * alpha;
        // Clamp multiplier to reasonable range
        existing.multiplier = Math.max(0.1, Math.min(5.0, existing.multiplier));
      }
    }

    this.accuracy.set(toolLower, existing);
  }

  /**
   * Predict the final WorldState after executing a sequence of tool calls.
   * Applies each transition's expected delta to produce the final state.
   */
  predictSequence(
    tools: Array<{ tool: string; args: Record<string, unknown> }>,
    initialState: WorldState,
  ): WorldState {
    // Build a lightweight mutable copy of the state for prediction
    let state: WorldState = {
      files: new Map(initialState.files),
      build: { ...initialState.build, errors: [...initialState.build.errors] },
      test: { ...initialState.test, failingTests: [...initialState.test.failingTests] },
      git: {
        ...initialState.git,
        stagedFiles: [...initialState.git.stagedFiles],
        uncommittedFiles: [...initialState.git.uncommittedFiles],
      },
      deps: {
        ...initialState.deps,
        missing: [...initialState.deps.missing],
        outdated: [...initialState.deps.outdated],
      },
      timestamp: initialState.timestamp,
    };

    for (const { tool, args } of tools) {
      const transition = this.predict(tool, args, state);
      const delta = transition.expectedDelta;

      // Apply file changes
      for (const path of delta.filesChanged) {
        const existing = state.files.get(path);
        state.files.set(path, {
          path,
          exists: true,
          hash: "",
          lines: existing?.lines ?? 0,
          lastModified: Date.now(),
        });
        // Mark git dirty
        if (delta.gitDirty && !state.git.uncommittedFiles.includes(path)) {
          state.git.uncommittedFiles.push(path);
        }
      }

      for (const path of delta.filesCreated) {
        state.files.set(path, {
          path,
          exists: true,
          hash: "",
          lines: 0,
          lastModified: Date.now(),
        });
        if (delta.gitDirty && !state.git.uncommittedFiles.includes(path)) {
          state.git.uncommittedFiles.push(path);
        }
      }

      for (const path of delta.filesDeleted) {
        const existing = state.files.get(path);
        if (existing) {
          state.files.set(path, { ...existing, exists: false });
        }
      }

      // Apply build/test invalidation
      if (delta.buildInvalidated) {
        state.build = { ...state.build, status: "unknown" };
      }
      if (delta.testInvalidated) {
        state.test = { ...state.test, status: "unknown" };
      }

      // Apply git dirty
      if (delta.gitDirty) {
        state.git = { ...state.git, dirty: true };
      } else if (tool.toLowerCase() === "git_ops") {
        // git commit clears dirty
        const operation = typeof args["operation"] === "string" ? args["operation"] : "";
        if (operation === "commit") {
          state.git = {
            ...state.git,
            dirty: false,
            uncommittedFiles: [],
            stagedFiles: [],
          };
        }
      }
    }

    return state;
  }
}
