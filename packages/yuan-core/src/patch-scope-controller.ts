/**
 * @module patch-scope-controller
 * @description Hard limits on modification scope per run.
 * Prevents "silent large-scale changes" — the #1 agent safety risk.
 * Tracks cumulative state in-memory per session.
 * Role: SCOPE LIMITER only. Does NOT check code quality or path safety.
 */

import type { AgentComplexity } from "./agent-decision-types.js";

export type RepoLifecycle = "existing" | "greenfield" | "migration";

export interface PatchScopeLimit {
  maxFilesPerRun: number;
  maxDiffLinesPerRun: number;
  maxProtectedFilesPerRun: number;
  maxCrossPackageTouches: number;
}

export interface PatchScopeState {
  touchedFiles: Set<string>;
  totalInserted: number;
  totalDeleted: number;
  protectedFilesTouched: Set<string>;
  packagesTouched: Set<string>;
}

export interface ScopeCheckResult {
  allowed: boolean;
  reason?: string;
  currentUsage: { files: number; diffLines: number; protectedFiles: number; packages: number };
  limits: PatchScopeLimit;
}

const LIMITS: Record<AgentComplexity, PatchScopeLimit> = {
  trivial:  { maxFilesPerRun: 3, maxDiffLinesPerRun: 100, maxProtectedFilesPerRun: 0, maxCrossPackageTouches: 1 },
  simple:   { maxFilesPerRun: 5, maxDiffLinesPerRun: 300, maxProtectedFilesPerRun: 1, maxCrossPackageTouches: 1 },
  moderate: { maxFilesPerRun: 10, maxDiffLinesPerRun: 800, maxProtectedFilesPerRun: 2, maxCrossPackageTouches: 2 },
  complex:  { maxFilesPerRun: 20, maxDiffLinesPerRun: 2000, maxProtectedFilesPerRun: 3, maxCrossPackageTouches: 3 },
  massive:  { maxFilesPerRun: 40, maxDiffLinesPerRun: 5000, maxProtectedFilesPerRun: 5, maxCrossPackageTouches: 5 },
};

const GREENFIELD_MULTIPLIER = 5;
const MIGRATION_MULTIPLIER = 3;

export function deriveScopeLimit(complexity: AgentComplexity, lifecycle: RepoLifecycle): PatchScopeLimit {
  const base = LIMITS[complexity];
  const mult = lifecycle === "greenfield" ? GREENFIELD_MULTIPLIER : lifecycle === "migration" ? MIGRATION_MULTIPLIER : 1;
  return {
    maxFilesPerRun: base.maxFilesPerRun * mult,
    maxDiffLinesPerRun: base.maxDiffLinesPerRun * mult,
    maxProtectedFilesPerRun: base.maxProtectedFilesPerRun * mult,
    maxCrossPackageTouches: base.maxCrossPackageTouches * mult,
  };
}

export function detectRepoLifecycle(projectPath: string): RepoLifecycle {
  try {
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const { execSync } = require("node:child_process") as typeof import("node:child_process");

    if (!existsSync(join(projectPath, ".git"))) return "greenfield";

    try {
      const commitCount = execSync("git rev-list --count HEAD", { cwd: projectPath, timeout: 3000 }).toString().trim();
      if (parseInt(commitCount) <= 1) return "greenfield";
    } catch { /* git error */ }

    // Check for migration signals
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      const pkg = JSON.parse(fs.readFileSync(join(projectPath, "package.json"), "utf-8")) as Record<string, Record<string, unknown>>;
      if (pkg.scripts?.migrate || pkg.scripts?.migration) return "migration";
    } catch { /* no package.json */ }

    return "existing";
  } catch {
    return "existing";
  }
}

export class PatchScopeController {
  private state: PatchScopeState;
  private limit: PatchScopeLimit;

  constructor(complexity: AgentComplexity, lifecycle: RepoLifecycle) {
    this.state = {
      touchedFiles: new Set(),
      totalInserted: 0,
      totalDeleted: 0,
      protectedFilesTouched: new Set(),
      packagesTouched: new Set(),
    };
    this.limit = deriveScopeLimit(complexity, lifecycle);
  }

  recordChange(filePath: string, insertedLines: number, deletedLines: number, isProtected: boolean): void {
    this.state.touchedFiles.add(filePath);
    this.state.totalInserted += insertedLines;
    this.state.totalDeleted += deletedLines;
    if (isProtected) this.state.protectedFilesTouched.add(filePath);

    // Package detection (monorepo)
    const pkgMatch = filePath.match(/^(?:packages|apps|libs)\/([^/]+)\//);
    if (pkgMatch) this.state.packagesTouched.add(pkgMatch[1]!);
  }

  check(): ScopeCheckResult {
    const usage = {
      files: this.state.touchedFiles.size,
      diffLines: this.state.totalInserted + this.state.totalDeleted,
      protectedFiles: this.state.protectedFilesTouched.size,
      packages: this.state.packagesTouched.size,
    };

    if (usage.files > this.limit.maxFilesPerRun) {
      return { allowed: false, reason: `File count ${usage.files} exceeds limit ${this.limit.maxFilesPerRun}`, currentUsage: usage, limits: this.limit };
    }
    if (usage.diffLines > this.limit.maxDiffLinesPerRun) {
      return { allowed: false, reason: `Diff lines ${usage.diffLines} exceeds limit ${this.limit.maxDiffLinesPerRun}`, currentUsage: usage, limits: this.limit };
    }
    if (usage.protectedFiles > this.limit.maxProtectedFilesPerRun) {
      return { allowed: false, reason: `Protected files ${usage.protectedFiles} exceeds limit ${this.limit.maxProtectedFilesPerRun}`, currentUsage: usage, limits: this.limit };
    }
    if (usage.packages > this.limit.maxCrossPackageTouches) {
      return { allowed: false, reason: `Cross-package touches ${usage.packages} exceeds limit ${this.limit.maxCrossPackageTouches}`, currentUsage: usage, limits: this.limit };
    }

    return { allowed: true, currentUsage: usage, limits: this.limit };
  }

  reset(): void {
    this.state.touchedFiles.clear();
    this.state.totalInserted = 0;
    this.state.totalDeleted = 0;
    this.state.protectedFilesTouched.clear();
    this.state.packagesTouched.clear();
  }
}
