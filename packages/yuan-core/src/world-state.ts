/**
 * @module world-state
 * @description Collects current project state (git, build, test, deps, files, errors)
 * for injection into the agent's system prompt. Pure data collector — no events emitted.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

// ─── Interfaces ───

export interface WorldStateSnapshot {
  git: {
    branch: string;
    status: "clean" | "dirty";
    uncommittedFiles: string[];
    recentCommits: Array<{ hash: string; message: string; date: string }>;
    hasConflicts: boolean;
  };
  build: {
    lastResult: "pass" | "fail" | "unknown";
    errors: string[];
    buildTool: "tsc" | "webpack" | "vite" | "esbuild" | "unknown";
  };
  test: {
    lastResult: "pass" | "fail" | "unknown";
    failingTests: string[];
    testRunner: "jest" | "vitest" | "mocha" | "node:test" | "unknown";
  };
  deps: {
    packageManager: "npm" | "pnpm" | "yarn" | "bun" | "unknown";
    outdated: string[];
    missing: string[];
  };
  files: {
    recentlyChanged: string[];
    totalFiles: number;
  };
  errors: {
    recentRuntimeErrors: string[];
  };
  collectedAt: string;
}

export interface WorldStateConfig {
  projectPath: string;
  maxRecentCommits?: number;
  maxRecentFiles?: number;
  skipBuild?: boolean;
  skipTest?: boolean;
  skipDeps?: boolean;
  timeoutMs?: number;
}

// ─── Defaults ───

const DEFAULT_MAX_RECENT_COMMITS = 10;
const DEFAULT_MAX_RECENT_FILES = 20;
const DEFAULT_TIMEOUT_MS = 10_000;

// ─── Helpers ───

/**
 * Run a command with timeout via Promise.race.
 * Returns stdout on success, null on any failure.
 */
async function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      execFileAsync(cmd, args, {
        cwd,
        maxBuffer: 1024 * 1024, // 1 MB
        timeout: timeoutMs,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    return result.stdout;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Check if a file exists at the given path.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Safely read and parse a JSON file. Returns null on failure.
 */
async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── WorldStateCollector ───

export class WorldStateCollector {
  private readonly projectPath: string;
  private readonly maxRecentCommits: number;
  private readonly maxRecentFiles: number;
  private readonly skipBuild: boolean;
  private readonly skipTest: boolean;
  private readonly skipDeps: boolean;
  private readonly timeoutMs: number;

  constructor(config: WorldStateConfig) {
    this.projectPath = config.projectPath;
    this.maxRecentCommits = config.maxRecentCommits ?? DEFAULT_MAX_RECENT_COMMITS;
    this.maxRecentFiles = config.maxRecentFiles ?? DEFAULT_MAX_RECENT_FILES;
    this.skipBuild = config.skipBuild ?? false;
    this.skipTest = config.skipTest ?? true;
    this.skipDeps = config.skipDeps ?? false;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Collect all project state. Never throws — failed collectors return defaults.
   */
  async collect(): Promise<WorldStateSnapshot> {
    const [git, build, test, deps, files] = await Promise.all([
      this.collectGit(),
      this.skipBuild ? defaultBuild() : this.collectBuild(),
      this.skipTest ? defaultTest() : this.collectTest(),
      this.skipDeps ? defaultDeps() : this.collectDeps(),
      this.collectFiles(),
    ]);

    return {
      git,
      build,
      test,
      deps,
      files,
      errors: { recentRuntimeErrors: [] },
      collectedAt: new Date().toISOString(),
    };
  }

  /**
   * Format snapshot as compact markdown for system prompt injection.
   */
  formatForPrompt(state: WorldStateSnapshot): string {
    const lines: string[] = ["## Project State"];

    // Git
    const uncommittedCount = state.git.uncommittedFiles.length;
    const branchInfo = uncommittedCount > 0
      ? `${state.git.branch} (${state.git.status}, ${uncommittedCount} uncommitted file${uncommittedCount !== 1 ? "s" : ""})`
      : `${state.git.branch} (${state.git.status})`;
    lines.push(`- **Branch:** ${branchInfo}`);

    // Build
    if (state.build.buildTool !== "unknown" || state.build.lastResult !== "unknown") {
      const buildStr = state.build.buildTool !== "unknown"
        ? `${state.build.buildTool} — last: ${state.build.lastResult}`
        : `last: ${state.build.lastResult}`;
      lines.push(`- **Build:** ${buildStr}`);
      if (state.build.errors.length > 0) {
        lines.push(`  - Errors: ${state.build.errors.length} (${state.build.errors.slice(0, 3).join("; ")}${state.build.errors.length > 3 ? "…" : ""})`);
      }
    }

    // Tests
    const testSuffix = state.test.lastResult === "unknown" ? " (not run)" : "";
    if (state.test.testRunner !== "unknown" || state.test.lastResult !== "unknown") {
      const testStr = state.test.testRunner !== "unknown"
        ? `${state.test.testRunner} — last: ${state.test.lastResult}${testSuffix}`
        : `last: ${state.test.lastResult}${testSuffix}`;
      lines.push(`- **Tests:** ${testStr}`);
      if (state.test.failingTests.length > 0) {
        lines.push(`  - Failing: ${state.test.failingTests.slice(0, 5).join(", ")}${state.test.failingTests.length > 5 ? "…" : ""}`);
      }
    }

    // Deps
    if (state.deps.packageManager !== "unknown") {
      let depStr = state.deps.packageManager;
      if (state.deps.outdated.length > 0) {
        depStr += ` — ${state.deps.outdated.length} outdated`;
      }
      if (state.deps.missing.length > 0) {
        depStr += ` — ${state.deps.missing.length} missing`;
      }
      lines.push(`- **Deps:** ${depStr}`);
    }

    // Files
    if (state.files.recentlyChanged.length > 0) {
      lines.push(
        `- **Recent changes:** ${state.files.recentlyChanged.length} file${state.files.recentlyChanged.length !== 1 ? "s" : ""} changed in last 5 commits`,
      );
    }

    // Conflicts
    if (state.git.hasConflicts) {
      lines.push("- **Conflicts:** YES — resolve before proceeding");
    } else {
      lines.push("- **Conflicts:** none");
    }

    // Runtime errors
    if (state.errors.recentRuntimeErrors.length > 0) {
      lines.push(`- **Runtime errors:** ${state.errors.recentRuntimeErrors.length}`);
    }

    return lines.join("\n");
  }

  // ─── Individual Collectors ───

  async collectGit(): Promise<WorldStateSnapshot["git"]> {
    try {
      // Run all git commands in parallel
      const [branchOut, statusOut, logOut, conflictOut] = await Promise.all([
        runCmd("git", ["rev-parse", "--abbrev-ref", "HEAD"], this.projectPath, this.timeoutMs),
        runCmd("git", ["status", "--porcelain"], this.projectPath, this.timeoutMs),
        runCmd(
          "git",
          ["log", `--oneline`, `--format=%H|%s|%aI`, `-${this.maxRecentCommits}`],
          this.projectPath,
          this.timeoutMs,
        ),
        runCmd("git", ["diff", "--name-only", "--diff-filter=U"], this.projectPath, this.timeoutMs),
      ]);

      // Branch
      const branch = branchOut?.trim() || "unknown";

      // Uncommitted files from porcelain status
      const uncommittedFiles: string[] = [];
      if (statusOut) {
        for (const line of statusOut.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length > 0) {
            // porcelain format: XY filename (first 3 chars are status + space)
            const file = line.length > 3 ? line.substring(3).trim() : trimmed;
            uncommittedFiles.push(file);
          }
        }
      }

      const status: "clean" | "dirty" = uncommittedFiles.length > 0 ? "dirty" : "clean";

      // Recent commits
      const recentCommits: Array<{ hash: string; message: string; date: string }> = [];
      if (logOut) {
        for (const line of logOut.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const parts = trimmed.split("|");
          if (parts.length >= 3) {
            recentCommits.push({
              hash: parts[0].substring(0, 12),
              message: parts[1],
              date: parts[2],
            });
          }
        }
      }

      // Merge conflicts
      const hasConflicts = conflictOut != null && conflictOut.trim().length > 0;

      return { branch, status, uncommittedFiles, recentCommits, hasConflicts };
    } catch {
      return {
        branch: "unknown",
        status: "clean",
        uncommittedFiles: [],
        recentCommits: [],
        hasConflicts: false,
      };
    }
  }

  async collectBuild(): Promise<WorldStateSnapshot["build"]> {
    try {
      const buildTool = await this.detectBuildTool();
      const { lastResult, errors } = await this.checkBuildArtifacts(buildTool);
      return { lastResult, errors, buildTool };
    } catch {
      return defaultBuild();
    }
  }

  async collectTest(): Promise<WorldStateSnapshot["test"]> {
    try {
      const testRunner = await this.detectTestRunner();
      return { lastResult: "unknown", failingTests: [], testRunner };
    } catch {
      return defaultTest();
    }
  }

  async collectDeps(): Promise<WorldStateSnapshot["deps"]> {
    try {
      const packageManager = await this.detectPackageManager();
      const missing = await this.findMissingDeps();
      return { packageManager, outdated: [], missing };
    } catch {
      return defaultDeps();
    }
  }

  async collectFiles(): Promise<WorldStateSnapshot["files"]> {
    try {
      const [diffOut, countOut] = await Promise.all([
        runCmd(
          "git",
          ["diff", "--name-only", `HEAD~5..HEAD`],
          this.projectPath,
          this.timeoutMs,
        ),
        runCmd("git", ["ls-files"], this.projectPath, this.timeoutMs),
      ]);

      const recentlyChanged: string[] = [];
      if (diffOut) {
        for (const line of diffOut.split("\n")) {
          const trimmed = line.trim();
          if (trimmed && recentlyChanged.length < this.maxRecentFiles) {
            recentlyChanged.push(trimmed);
          }
        }
      }

      // Count tracked files
      let totalFiles = 0;
      if (countOut) {
        totalFiles = countOut.split("\n").filter((l) => l.trim().length > 0).length;
      }

      return { recentlyChanged, totalFiles };
    } catch {
      return { recentlyChanged: [], totalFiles: 0 };
    }
  }

  // ─── Detection Helpers ───

  private async detectBuildTool(): Promise<WorldStateSnapshot["build"]["buildTool"]> {
    const checks = await Promise.all([
      fileExists(join(this.projectPath, "tsconfig.json")),
      fileExists(join(this.projectPath, "vite.config.ts")).then((r) =>
        r ? r : fileExists(join(this.projectPath, "vite.config.js")),
      ),
      fileExists(join(this.projectPath, "webpack.config.js")).then((r) =>
        r ? r : fileExists(join(this.projectPath, "webpack.config.ts")),
      ),
      fileExists(join(this.projectPath, "esbuild.config.js")).then((r) =>
        r ? r : fileExists(join(this.projectPath, "esbuild.config.mjs")),
      ),
    ]);

    const [hasTsConfig, hasVite, hasWebpack, hasEsbuild] = checks;

    // Prefer more specific build tool over tsc
    if (hasVite) return "vite";
    if (hasWebpack) return "webpack";
    if (hasEsbuild) return "esbuild";
    if (hasTsConfig) return "tsc";
    return "unknown";
  }

  /**
   * Check common build output locations for errors without running a build.
   * Looks for tsbuildinfo, .next/error, dist/.error, etc.
   */
  private async checkBuildArtifacts(
    buildTool: WorldStateSnapshot["build"]["buildTool"],
  ): Promise<{ lastResult: "pass" | "fail" | "unknown"; errors: string[] }> {
    const errors: string[] = [];

    // Check tsconfig.tsbuildinfo for last tsc run
    if (buildTool === "tsc") {
      const tsBuildInfo = join(this.projectPath, "tsconfig.tsbuildinfo");
      if (await fileExists(tsBuildInfo)) {
        // tsbuildinfo exists means last incremental build passed
        return { lastResult: "pass", errors: [] };
      }
    }

    // Check .next directory for Next.js build errors
    const nextBuildId = join(this.projectPath, ".next", "BUILD_ID");
    if (await fileExists(nextBuildId)) {
      return { lastResult: "pass", errors: [] };
    }

    // Check for dist directory as sign of successful build
    const distDir = join(this.projectPath, "dist");
    if (await fileExists(distDir)) {
      return { lastResult: "pass", errors: [] };
    }

    // Try running a quick tsc --noEmit to check types (only for tsc)
    if (buildTool === "tsc") {
      const tscOut = await runCmd(
        "npx",
        ["tsc", "--noEmit", "--pretty", "false"],
        this.projectPath,
        this.timeoutMs,
      );
      if (tscOut === null) {
        // tsc failed or timed out — try to get error output
        return { lastResult: "unknown", errors: [] };
      }
      if (tscOut.trim().length === 0) {
        return { lastResult: "pass", errors: [] };
      }
      // Parse tsc errors (first 10)
      const errLines = tscOut
        .split("\n")
        .filter((l) => l.includes("error TS"))
        .slice(0, 10);
      return {
        lastResult: errLines.length > 0 ? "fail" : "pass",
        errors: errLines,
      };
    }

    return { lastResult: "unknown", errors };
  }

  private async detectTestRunner(): Promise<WorldStateSnapshot["test"]["testRunner"]> {
    const pkgJson = await readJson(join(this.projectPath, "package.json"));
    if (!pkgJson) return "unknown";

    // Check scripts.test
    const scripts = pkgJson.scripts as Record<string, string> | undefined;
    if (scripts?.test) {
      const testScript = scripts.test.toLowerCase();
      if (testScript.includes("vitest")) return "vitest";
      if (testScript.includes("jest")) return "jest";
      if (testScript.includes("mocha")) return "mocha";
      if (testScript.includes("node --test") || testScript.includes("node:test")) return "node:test";
    }

    // Check devDependencies
    const devDeps = (pkgJson.devDependencies ?? {}) as Record<string, string>;
    const deps = (pkgJson.dependencies ?? {}) as Record<string, string>;
    const allDeps = { ...deps, ...devDeps };

    if ("vitest" in allDeps) return "vitest";
    if ("jest" in allDeps) return "jest";
    if ("mocha" in allDeps) return "mocha";

    return "unknown";
  }

  private async detectPackageManager(): Promise<WorldStateSnapshot["deps"]["packageManager"]> {
    // 1. Check package.json packageManager field
    const pkgJson = await readJson(join(this.projectPath, "package.json"));
    if (pkgJson?.packageManager) {
      const pm = (pkgJson.packageManager as string).toLowerCase();
      if (pm.startsWith("pnpm")) return "pnpm";
      if (pm.startsWith("yarn")) return "yarn";
      if (pm.startsWith("npm")) return "npm";
      if (pm.startsWith("bun")) return "bun";
    }

    // 2. Check lock files
    const lockChecks = await Promise.all([
      fileExists(join(this.projectPath, "pnpm-lock.yaml")),
      fileExists(join(this.projectPath, "yarn.lock")),
      fileExists(join(this.projectPath, "package-lock.json")),
      fileExists(join(this.projectPath, "bun.lockb")),
    ]);

    if (lockChecks[0]) return "pnpm";
    if (lockChecks[1]) return "yarn";
    if (lockChecks[2]) return "npm";
    if (lockChecks[3]) return "bun";

    return "unknown";
  }

  /**
   * Quick scan for missing dependencies by checking node_modules existence.
   * Does NOT parse imports — that would be too slow for a state snapshot.
   */
  private async findMissingDeps(): Promise<string[]> {
    const missing: string[] = [];

    const nodeModulesPath = join(this.projectPath, "node_modules");
    if (!(await fileExists(nodeModulesPath))) {
      missing.push("(node_modules missing — run install)");
      return missing;
    }

    // Check a few key deps from package.json
    const pkgJson = await readJson(join(this.projectPath, "package.json"));
    if (!pkgJson) return missing;

    const deps = (pkgJson.dependencies ?? {}) as Record<string, string>;
    const depNames = Object.keys(deps).slice(0, 20); // Check first 20

    const checks = await Promise.all(
      depNames.map(async (name) => {
        const depPath = join(nodeModulesPath, name);
        const exists = await fileExists(depPath);
        return exists ? null : name;
      }),
    );

    for (const name of checks) {
      if (name) missing.push(name);
    }

    return missing;
  }
}

// ─── Default State Factories ───

function defaultBuild(): WorldStateSnapshot["build"] {
  return { lastResult: "unknown", errors: [], buildTool: "unknown" };
}

function defaultTest(): WorldStateSnapshot["test"] {
  return { lastResult: "unknown", failingTests: [], testRunner: "unknown" };
}

function defaultDeps(): WorldStateSnapshot["deps"] {
  return { packageManager: "unknown", outdated: [], missing: [] };
}
