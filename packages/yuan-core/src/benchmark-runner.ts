/**
 * @module benchmark-runner
 * @description Runs benchmarks against the YUAN coding agent to measure performance objectively.
 *
 * The BenchmarkRunner does NOT instantiate AgentLoop directly (avoiding circular dependencies).
 * Instead, it records task specs and validates results. The actual agent execution is performed
 * by the caller (CLI or test harness) which passes in AgentLoop results.
 */

import { mkdir, readdir, readFile, writeFile, rename, cp, rm } from "fs/promises";
import { join, basename } from "path";
import { exec } from "child_process";
import { randomUUID } from "crypto";
import { tmpdir } from "os";

// ─── Types ───

/** Benchmark task category */
export type BenchmarkCategory = "bug_fix" | "feature" | "refactor" | "test" | "docs";

/** Benchmark task difficulty */
export type BenchmarkDifficulty = "easy" | "medium" | "hard";

/** A single benchmark task definition */
export interface BenchmarkTask {
  id: string;
  name: string;
  description: string;
  category: BenchmarkCategory;
  difficulty: BenchmarkDifficulty;
  /** Path to test project directory */
  setupDir: string;
  /** User prompt to give the agent */
  prompt: string;
  /** Files that should be modified */
  expectedFiles?: string[];
  /** Shell command to validate result (exit 0 = pass) */
  validationScript?: string;
  /** Token budget for this task */
  maxTokens?: number;
  /** Timeout in ms (default 300000 = 5min) */
  timeoutMs?: number;
}

/** Result of running a single benchmark task */
export interface BenchmarkResult {
  taskId: string;
  taskName: string;
  success: boolean;
  tokensUsed: number;
  durationMs: number;
  filesChanged: string[];
  errors: string[];
  validationOutput?: string;
  terminationReason: string;
}

/** Aggregated summary of a benchmark suite run */
export interface BenchmarkSummary {
  totalTasks: number;
  passed: number;
  failed: number;
  /** Success rate 0-1 */
  successRate: number;
  avgTokensPerTask: number;
  avgDurationMs: number;
  totalCostEstimateUSD: number;
  byCategory: Record<string, { passed: number; total: number }>;
  byDifficulty: Record<string, { passed: number; total: number }>;
  /** Task IDs that previously passed but now fail */
  regressions: string[];
  /** Task IDs that previously failed but now pass */
  improvements: string[];
  timestamp: string;
  /** Individual task results */
  results: BenchmarkResult[];
}

/** Configuration for the BenchmarkRunner */
export interface BenchmarkRunnerConfig {
  /** Directory to store results (default ".yuan/benchmarks") */
  resultsDir: string;
  /** Max concurrent tasks (default 1 = sequential) */
  maxConcurrent?: number;
  /** Whether to save results to disk (default true) */
  saveResults?: boolean;
  /** Whether to compare against baseline (default true) */
  compareBaseline?: boolean;
}

// ─── Cost Constants ───

/** Approximate cost per 1M tokens for estimation (Claude Sonnet-class) */
const COST_PER_MILLION_INPUT = 3.0;
const COST_PER_MILLION_OUTPUT = 15.0;
/** Rough ratio: assume 70% input, 30% output */
const INPUT_RATIO = 0.7;
const OUTPUT_RATIO = 0.3;

// ─── Helpers ───

/**
 * Execute a shell command with timeout. Returns { stdout, stderr, exitCode }.
 */
function execWithTimeout(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = exec(command, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : "",
        exitCode: error ? (error as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0,
      });
    });

    // Safety: kill if still running after timeout + grace period
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // process already exited
      }
    }, timeoutMs + 5000);
  });
}

/**
 * Estimate USD cost from token count.
 */
function estimateCostUSD(tokens: number): number {
  const inputTokens = tokens * INPUT_RATIO;
  const outputTokens = tokens * OUTPUT_RATIO;
  return (inputTokens / 1_000_000) * COST_PER_MILLION_INPUT + (outputTokens / 1_000_000) * COST_PER_MILLION_OUTPUT;
}

/**
 * Atomic write: write to temp file then rename.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmpPath = filePath + `.tmp.${randomUUID().slice(0, 8)}`;
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, filePath);
}

/**
 * List files that changed between two directory snapshots (shallow compare by mtime/size).
 * Returns relative paths.
 */
async function listChangedFiles(originalDir: string, modifiedDir: string): Promise<string[]> {
  const changed: string[] = [];

  async function walk(dir: string, base: string): Promise<void> {
    const { readdir: rd, stat } = await import("fs/promises");
    let entries;
    try {
      entries = await rd(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules, .git, etc.
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        await walk(fullPath, rel);
      } else if (entry.isFile()) {
        const origPath = join(originalDir, rel);
        try {
          const [origStat, modStat] = await Promise.all([stat(origPath), stat(fullPath)]);
          if (origStat.mtimeMs !== modStat.mtimeMs || origStat.size !== modStat.size) {
            changed.push(rel);
          }
        } catch {
          // File exists in modified but not original → new file
          changed.push(rel);
        }
      }
    }
  }

  await walk(modifiedDir, "");
  return changed;
}

// ─── BenchmarkRunner ───

export class BenchmarkRunner {
  private readonly config: Required<BenchmarkRunnerConfig>;

  constructor(config: BenchmarkRunnerConfig) {
    this.config = {
      resultsDir: config.resultsDir || ".yuan/benchmarks",
      maxConcurrent: config.maxConcurrent ?? 1,
      saveResults: config.saveResults ?? true,
      compareBaseline: config.compareBaseline ?? true,
    };
  }

  /**
   * Run a single benchmark task.
   *
   * This method prepares the working directory and validates the result,
   * but does NOT call AgentLoop itself. The caller is responsible for
   * actually running the agent between `runTask` setup and finalization.
   *
   * If `agentResult` is provided, it is used directly. Otherwise, a
   * placeholder result is returned indicating the task is ready for execution.
   */
  async runTask(
    task: BenchmarkTask,
    agentResult?: {
      tokensUsed: number;
      filesChanged: string[];
      errors: string[];
      terminationReason: string;
    },
  ): Promise<BenchmarkResult> {
    const startTime = Date.now();
    const timeoutMs = task.timeoutMs ?? 300_000;
    const errors: string[] = [];

    // If no agent result provided, return a placeholder indicating setup-only mode
    if (!agentResult) {
      return {
        taskId: task.id,
        taskName: task.name,
        success: false,
        tokensUsed: 0,
        durationMs: Date.now() - startTime,
        filesChanged: [],
        errors: ["no_agent_result: task prepared but agent was not executed"],
        terminationReason: "no_execution",
      };
    }

    // Validate with validation script if provided
    let validationOutput: string | undefined;
    let validationPassed = true;

    if (task.validationScript) {
      try {
        const result = await execWithTimeout(task.validationScript, task.setupDir, Math.min(timeoutMs, 60_000));
        validationOutput = result.stdout + (result.stderr ? `\n[stderr] ${result.stderr}` : "");
        if (result.exitCode !== 0) {
          validationPassed = false;
          errors.push(`validation_failed: exit code ${result.exitCode}`);
        }
      } catch (err) {
        validationPassed = false;
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`validation_error: ${msg}`);
      }
    }

    // Check expected files if specified
    if (task.expectedFiles && task.expectedFiles.length > 0) {
      const missing = task.expectedFiles.filter((f) => !agentResult.filesChanged.includes(f));
      if (missing.length > 0) {
        errors.push(`missing_expected_files: ${missing.join(", ")}`);
      }
    }

    // Merge agent errors
    errors.push(...agentResult.errors);

    // Determine success: no fatal errors and validation passed
    const success = validationPassed && agentResult.errors.length === 0;

    const durationMs = Date.now() - startTime;

    return {
      taskId: task.id,
      taskName: task.name,
      success,
      tokensUsed: agentResult.tokensUsed,
      durationMs,
      filesChanged: agentResult.filesChanged,
      errors,
      validationOutput,
      terminationReason: agentResult.terminationReason,
    };
  }

  /**
   * Run all tasks in a benchmark suite.
   *
   * Tasks are run sequentially by default, or concurrently up to maxConcurrent.
   * Each task must be provided with an agent result via the `taskResults` map.
   */
  async runSuite(
    tasks: BenchmarkTask[],
    taskResults?: Map<
      string,
      {
        tokensUsed: number;
        filesChanged: string[];
        errors: string[];
        terminationReason: string;
      }
    >,
  ): Promise<BenchmarkSummary> {
    const results: BenchmarkResult[] = [];
    const maxConcurrent = this.config.maxConcurrent;

    if (maxConcurrent <= 1) {
      // Sequential execution
      for (const task of tasks) {
        const agentResult = taskResults?.get(task.id);
        const result = await this.runTask(task, agentResult);
        results.push(result);
      }
    } else {
      // Concurrent execution in batches
      for (let i = 0; i < tasks.length; i += maxConcurrent) {
        const batch = tasks.slice(i, i + maxConcurrent);
        const batchResults = await Promise.all(
          batch.map((task) => {
            const agentResult = taskResults?.get(task.id);
            return this.runTask(task, agentResult);
          }),
        );
        results.push(...batchResults);
      }
    }

    // Aggregate stats
    const passed = results.filter((r) => r.success).length;
    const failed = results.length - passed;
    const totalTokens = results.reduce((sum, r) => sum + r.tokensUsed, 0);
    const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);

    // Group by category
    const byCategory: Record<string, { passed: number; total: number }> = {};
    for (const task of tasks) {
      if (!byCategory[task.category]) {
        byCategory[task.category] = { passed: 0, total: 0 };
      }
      byCategory[task.category].total++;
      const result = results.find((r) => r.taskId === task.id);
      if (result?.success) {
        byCategory[task.category].passed++;
      }
    }

    // Group by difficulty
    const byDifficulty: Record<string, { passed: number; total: number }> = {};
    for (const task of tasks) {
      if (!byDifficulty[task.difficulty]) {
        byDifficulty[task.difficulty] = { passed: 0, total: 0 };
      }
      byDifficulty[task.difficulty].total++;
      const result = results.find((r) => r.taskId === task.id);
      if (result?.success) {
        byDifficulty[task.difficulty].passed++;
      }
    }

    // Compare with baseline if enabled
    let regressions: string[] = [];
    let improvements: string[] = [];

    if (this.config.compareBaseline) {
      const baseline = await this.loadBaseline();
      if (baseline) {
        const summary: BenchmarkSummary = {
          totalTasks: tasks.length,
          passed,
          failed,
          successRate: tasks.length > 0 ? passed / tasks.length : 0,
          avgTokensPerTask: tasks.length > 0 ? totalTokens / tasks.length : 0,
          avgDurationMs: tasks.length > 0 ? totalDuration / tasks.length : 0,
          totalCostEstimateUSD: estimateCostUSD(totalTokens),
          byCategory,
          byDifficulty,
          regressions: [],
          improvements: [],
          timestamp: new Date().toISOString(),
          results,
        };
        const comparison = this.compareWithBaseline(summary, baseline);
        regressions = comparison.regressions;
        improvements = comparison.improvements;
      }
    }

    const summary: BenchmarkSummary = {
      totalTasks: tasks.length,
      passed,
      failed,
      successRate: tasks.length > 0 ? passed / tasks.length : 0,
      avgTokensPerTask: tasks.length > 0 ? totalTokens / tasks.length : 0,
      avgDurationMs: tasks.length > 0 ? totalDuration / tasks.length : 0,
      totalCostEstimateUSD: estimateCostUSD(totalTokens),
      byCategory,
      byDifficulty,
      regressions,
      improvements,
      timestamp: new Date().toISOString(),
      results,
    };

    // Save results if configured
    if (this.config.saveResults) {
      await this.saveResults(summary);
    }

    return summary;
  }

  /**
   * Load the most recent baseline benchmark result from resultsDir.
   * Returns null if no previous results exist.
   */
  async loadBaseline(): Promise<BenchmarkSummary | null> {
    try {
      const files = await readdir(this.config.resultsDir);
      const benchmarkFiles = files
        .filter((f) => f.startsWith("benchmark-") && f.endsWith(".json"))
        .sort()
        .reverse();

      if (benchmarkFiles.length === 0) return null;

      const latestFile = join(this.config.resultsDir, benchmarkFiles[0]);
      const content = await readFile(latestFile, "utf-8");
      return JSON.parse(content) as BenchmarkSummary;
    } catch {
      return null;
    }
  }

  /**
   * Save benchmark results to disk with atomic write.
   * Returns the path to the saved file.
   */
  async saveResults(summary: BenchmarkSummary): Promise<string> {
    await mkdir(this.config.resultsDir, { recursive: true });

    // Format timestamp for filename: 2026-03-09T12-30-00Z
    const ts = summary.timestamp.replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
    const filename = `benchmark-${ts}.json`;
    const filePath = join(this.config.resultsDir, filename);

    const content = JSON.stringify(summary, null, 2);
    await atomicWrite(filePath, content);

    return filePath;
  }

  /**
   * Compare current results with a baseline.
   * Identifies regressions (was pass, now fail) and improvements (was fail, now pass).
   */
  compareWithBaseline(
    current: BenchmarkSummary,
    baseline: BenchmarkSummary,
  ): { regressions: string[]; improvements: string[] } {
    const regressions: string[] = [];
    const improvements: string[] = [];

    // Build lookup maps from results arrays
    const baselineMap = new Map<string, boolean>();
    for (const result of baseline.results ?? []) {
      baselineMap.set(result.taskId, result.success);
    }

    const currentMap = new Map<string, boolean>();
    for (const result of current.results ?? []) {
      currentMap.set(result.taskId, result.success);
    }

    // Compare tasks that exist in both runs
    for (const [taskId, currentSuccess] of currentMap) {
      const baselineSuccess = baselineMap.get(taskId);
      if (baselineSuccess === undefined) continue; // New task, skip

      if (baselineSuccess && !currentSuccess) {
        regressions.push(taskId);
      } else if (!baselineSuccess && currentSuccess) {
        improvements.push(taskId);
      }
    }

    return { regressions, improvements };
  }

  /**
   * Generate a Markdown report from benchmark summary.
   */
  generateReport(summary: BenchmarkSummary): string {
    const lines: string[] = [];

    lines.push("# YUAN Benchmark Report");
    lines.push("");
    lines.push(`**Date:** ${summary.timestamp}`);
    lines.push("");

    // ─── Overview ───
    lines.push("## Overview");
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    lines.push(`| Total Tasks | ${summary.totalTasks} |`);
    lines.push(`| Passed | ${summary.passed} |`);
    lines.push(`| Failed | ${summary.failed} |`);
    lines.push(`| Success Rate | ${(summary.successRate * 100).toFixed(1)}% |`);
    lines.push(`| Avg Tokens/Task | ${Math.round(summary.avgTokensPerTask).toLocaleString()} |`);
    lines.push(`| Avg Duration/Task | ${(summary.avgDurationMs / 1000).toFixed(1)}s |`);
    lines.push(`| Est. Total Cost | $${summary.totalCostEstimateUSD.toFixed(4)} |`);
    lines.push("");

    // ─── By Category ───
    lines.push("## Results by Category");
    lines.push("");
    lines.push("| Category | Passed | Total | Rate |");
    lines.push("|----------|--------|-------|------|");
    for (const [category, stats] of Object.entries(summary.byCategory)) {
      const rate = stats.total > 0 ? ((stats.passed / stats.total) * 100).toFixed(0) : "0";
      lines.push(`| ${category} | ${stats.passed} | ${stats.total} | ${rate}% |`);
    }
    lines.push("");

    // ─── By Difficulty ───
    lines.push("## Results by Difficulty");
    lines.push("");
    lines.push("| Difficulty | Passed | Total | Rate |");
    lines.push("|------------|--------|-------|------|");
    for (const [difficulty, stats] of Object.entries(summary.byDifficulty)) {
      const rate = stats.total > 0 ? ((stats.passed / stats.total) * 100).toFixed(0) : "0";
      lines.push(`| ${difficulty} | ${stats.passed} | ${stats.total} | ${rate}% |`);
    }
    lines.push("");

    // ─── Regressions & Improvements ───
    if (summary.regressions.length > 0) {
      lines.push("## Regressions");
      lines.push("");
      lines.push("Tasks that previously passed but now fail:");
      lines.push("");
      for (const id of summary.regressions) {
        lines.push(`- \`${id}\``);
      }
      lines.push("");
    }

    if (summary.improvements.length > 0) {
      lines.push("## Improvements");
      lines.push("");
      lines.push("Tasks that previously failed but now pass:");
      lines.push("");
      for (const id of summary.improvements) {
        lines.push(`- \`${id}\``);
      }
      lines.push("");
    }

    // ─── Individual Results ───
    if (summary.results && summary.results.length > 0) {
      lines.push("## Task Details");
      lines.push("");
      lines.push("| Task | Status | Tokens | Duration | Reason |");
      lines.push("|------|--------|--------|----------|--------|");
      for (const r of summary.results) {
        const status = r.success ? "PASS" : "FAIL";
        const tokens = r.tokensUsed.toLocaleString();
        const duration = `${(r.durationMs / 1000).toFixed(1)}s`;
        const reason = r.terminationReason.slice(0, 40);
        lines.push(`| ${r.taskName} | ${status} | ${tokens} | ${duration} | ${reason} |`);
      }
      lines.push("");

      // ─── Error Details ───
      const failedResults = summary.results.filter((r) => !r.success && r.errors.length > 0);
      if (failedResults.length > 0) {
        lines.push("## Error Details");
        lines.push("");
        for (const r of failedResults) {
          lines.push(`### ${r.taskName} (\`${r.taskId}\`)`);
          lines.push("");
          for (const err of r.errors) {
            lines.push(`- ${err}`);
          }
          if (r.validationOutput) {
            lines.push("");
            lines.push("**Validation output:**");
            lines.push("```");
            lines.push(r.validationOutput.slice(0, 500));
            lines.push("```");
          }
          lines.push("");
        }
      }
    }

    return lines.join("\n");
  }

  /**
   * Built-in sample tasks for quick testing.
   * These are simple tasks that can validate the benchmark infrastructure itself.
   */
  static getSampleTasks(): BenchmarkTask[] {
    return [
      {
        id: "fix-typo",
        name: "Fix Typo",
        description: "Fix a typo in a README file: 'recieve' should be 'receive'",
        category: "bug_fix",
        difficulty: "easy",
        setupDir: "",
        prompt: "Fix the typo in README.md: 'recieve' should be 'receive'",
        expectedFiles: ["README.md"],
        validationScript: "grep -q 'receive' README.md && ! grep -q 'recieve' README.md",
        maxTokens: 1000,
        timeoutMs: 60_000,
      },
      {
        id: "add-function",
        name: "Add Function",
        description: "Add a simple utility function that returns the sum of two numbers",
        category: "feature",
        difficulty: "easy",
        setupDir: "",
        prompt:
          "Add an exported function 'add(a: number, b: number): number' to src/utils.ts that returns the sum of a and b",
        expectedFiles: ["src/utils.ts"],
        validationScript: "grep -q 'export function add' src/utils.ts",
        maxTokens: 2000,
        timeoutMs: 60_000,
      },
      {
        id: "rename-variable",
        name: "Rename Variable",
        description: "Rename all occurrences of 'data' to 'payload' in src/handler.ts",
        category: "refactor",
        difficulty: "medium",
        setupDir: "",
        prompt: "Rename the variable 'data' to 'payload' in src/handler.ts (all occurrences)",
        expectedFiles: ["src/handler.ts"],
        validationScript: "grep -q 'payload' src/handler.ts && ! grep -q 'const data' src/handler.ts",
        maxTokens: 5000,
        timeoutMs: 120_000,
      },
      {
        id: "add-unit-test",
        name: "Add Unit Test",
        description: "Add unit tests for the multiply function in src/math.ts",
        category: "test",
        difficulty: "medium",
        setupDir: "",
        prompt:
          "Write unit tests for the multiply(a, b) function in src/math.ts. Create src/__tests__/math.test.ts with at least 3 test cases including edge cases (zero, negative numbers).",
        expectedFiles: ["src/__tests__/math.test.ts"],
        validationScript: "test -f src/__tests__/math.test.ts && grep -c 'test\\|it(' src/__tests__/math.test.ts",
        maxTokens: 8000,
        timeoutMs: 180_000,
      },
      {
        id: "multi-file-refactor",
        name: "Multi-File Refactor",
        description:
          "Extract a shared interface from two files that define similar types, and update both files to import from the shared module",
        category: "refactor",
        difficulty: "hard",
        setupDir: "",
        prompt:
          "Both src/user-service.ts and src/admin-service.ts define a 'UserRecord' interface with the same fields. Extract it to src/types/user.ts and update both files to import from there.",
        expectedFiles: ["src/types/user.ts", "src/user-service.ts", "src/admin-service.ts"],
        validationScript:
          'test -f src/types/user.ts && grep -q "import.*UserRecord.*from" src/user-service.ts && grep -q "import.*UserRecord.*from" src/admin-service.ts',
        maxTokens: 15000,
        timeoutMs: 300_000,
      },
    ];
  }
}
