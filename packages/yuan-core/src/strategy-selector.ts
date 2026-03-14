/**
 * @module strategy-selector
 * @description Selects 2-3 execution strategies based on task type and mode.
 * Strategies tell the agent HOW to approach a task (execution pattern),
 * distinct from skills which provide domain knowledge.
 */

import type { StrategySummary, ExecutionMode } from "./system-prompt.js";

interface StrategyDef extends StrategySummary {
  taskTypes: string[]; // task types this applies to, ["*"] = always
  modes: string[]; // execution modes this applies to, ["*"] = always
  priority: number; // higher = selected first (max 3 total selected)
}

const STRATEGY_DEFS: StrategyDef[] = [
  {
    name: "Read Before Write",
    description:
      "Read the exact file content before writing any edit. The codebase is ground truth.",
    toolSequence: ["file_read", "edit"],
    taskTypes: ["*"],
    modes: ["*"],
    priority: 100, // always included
  },
  {
    name: "Test-Driven",
    description:
      "Write a failing test first. Verify it fails. Implement minimal code to pass. Verify green.",
    toolSequence: [
      "write_test",
      "shell_exec (expect FAIL)",
      "implement",
      "shell_exec (expect PASS)",
    ],
    taskTypes: ["feature", "debug", "refactor", "test"],
    modes: ["NORMAL", "DEEP", "SUPERPOWER"],
    priority: 90,
  },
  {
    name: "Trace First",
    description:
      "Follow the symptom to root cause before touching any code. Read the error, find the source, understand before fixing.",
    toolSequence: ["grep", "file_read", "understand", "fix"],
    taskTypes: ["debug", "security", "performance"],
    modes: ["NORMAL", "DEEP", "SUPERPOWER"],
    priority: 85,
  },
  {
    name: "Impact Radius",
    description:
      "Map all affected files before editing. Grep all references to the symbol being changed. Edit in dependency order.",
    toolSequence: ["grep_references", "file_read_all", "plan", "edit_dependency_order"],
    taskTypes: ["refactor", "migration"],
    modes: ["DEEP", "SUPERPOWER"],
    priority: 80,
  },
  {
    name: "Pattern Match First",
    description:
      "Find 2-3 existing similar implementations before writing new code. Match the established style.",
    toolSequence: ["glob", "file_read_examples", "implement_matching_style"],
    taskTypes: ["feature", "test", "documentation"],
    modes: ["NORMAL", "DEEP", "SUPERPOWER"],
    priority: 75,
  },
  {
    name: "Minimal Change",
    description: "Smallest correct fix only. Do not refactor surrounding code unless asked.",
    toolSequence: ["file_read", "targeted_edit", "verify"],
    taskTypes: ["debug", "config", "infra"],
    modes: ["FAST", "NORMAL"],
    priority: 70,
  },
  {
    name: "Verify Before Done",
    description:
      "Run build or tests after every meaningful change. Do not declare done without a passing verification step.",
    toolSequence: ["edit", "shell_build", "shell_test"],
    taskTypes: ["feature", "refactor", "migration", "test", "deploy"],
    modes: ["NORMAL", "DEEP", "SUPERPOWER"],
    priority: 65,
  },
];

const MAX_STRATEGIES = 3;

export class StrategySelector {
  select(taskType?: string, mode?: ExecutionMode): StrategySummary[] {
    const task = taskType?.toLowerCase() ?? "";
    const m = mode ?? "NORMAL";

    return STRATEGY_DEFS.filter((s) => {
      const taskMatch = s.taskTypes.includes("*") || s.taskTypes.includes(task);
      const modeMatch = s.modes.includes("*") || s.modes.includes(m);
      return taskMatch && modeMatch;
    })
      .sort((a, b) => b.priority - a.priority)
      .slice(0, MAX_STRATEGIES)
      .map(({ name, description, toolSequence }) => ({ name, description, toolSequence }));
  }
}
