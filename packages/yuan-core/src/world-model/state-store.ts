/**
 * @module world-model/state-store
 * @description Richer WorldState with per-file tracking and history.
 * Uses an immutable base + delta patch architecture instead of full deep clones.
 * History stores only what changed (StatePatch) rather than full WorldState copies.
 */

import type { WorldStateSnapshot } from "../world-state.js";

// ─── World State Interfaces ───

export interface FileState {
  path: string;
  exists: boolean;
  /** SHA-256 hex digest of file content */
  hash: string;
  lines: number;
  lastModified: number;
}

export interface BuildState {
  status: "pass" | "fail" | "unknown" | "running";
  errors: string[];
  /** Epoch ms of last run */
  lastRun: number;
  buildTool: string;
}

export interface TestState {
  status: "pass" | "fail" | "unknown" | "running";
  failingTests: string[];
  /** Epoch ms of last run */
  lastRun: number;
  testRunner: string;
}

export interface GitState {
  branch: string;
  dirty: boolean;
  stagedFiles: string[];
  uncommittedFiles: string[];
  /** Short commit hash */
  lastCommit: string;
}

export interface DepsState {
  packageManager: string;
  missing: string[];
  outdated: string[];
}

export interface WorldState {
  files: Map<string, FileState>;
  build: BuildState;
  test: TestState;
  git: GitState;
  deps: DepsState;
  timestamp: number;
}

// ─── Delta Patch Types ───

/** A patch entry for the files map — describes a single file add/update or removal */
export interface FilePatch {
  type: "set" | "delete";
  path: string;
  /** Present when type === "set" */
  state?: FileState;
}

/** A minimal delta — only the sub-trees that actually changed */
export interface StatePatch {
  files?: FilePatch[];
  build?: Partial<BuildState>;
  test?: Partial<TestState>;
  git?: Partial<GitState>;
  deps?: Partial<DepsState>;
}

/** History entry stores a patch, not a full state copy */
export interface PatchHistoryEntry {
  action: string;
  timestamp: number;
  patch: StatePatch;
  /** Estimated size of this patch in bytes */
  memorySizeBytes: number;
}

/**
 * @deprecated Use PatchHistoryEntry instead.
 * Kept for backward-compatibility with any code that imports StateHistoryEntry.
 */
export type StateHistoryEntry = PatchHistoryEntry;

export interface MemoryStats {
  baseSnapshotBytes: number;
  totalPatchBytes: number;
  totalBytes: number;
  entryCount: number;
  largestPatchBytes: number;
}

// ─── Internal Helpers ───

/**
 * Estimate the memory footprint of a patch in bytes.
 * Not exact — used for trimming heuristics.
 */
function estimatePatchSize(patch: StatePatch): number {
  let bytes = 0;
  if (patch.files) {
    bytes += patch.files.length * 200; // avg FileState JSON ~200 bytes
  }
  if (patch.build) bytes += JSON.stringify(patch.build).length;
  if (patch.test) bytes += JSON.stringify(patch.test).length;
  if (patch.git) bytes += JSON.stringify(patch.git).length;
  if (patch.deps) bytes += JSON.stringify(patch.deps).length;
  return bytes;
}

/**
 * Estimate the base snapshot size in bytes.
 * Approximates by counting Map entries + scalar fields.
 */
function estimateSnapshotSize(state: WorldState): number {
  let bytes = 200; // scalar fields overhead
  bytes += state.files.size * 200;
  bytes += JSON.stringify(state.build).length;
  bytes += JSON.stringify(state.test).length;
  bytes += JSON.stringify(state.git).length;
  bytes += JSON.stringify(state.deps).length;
  return bytes;
}

/**
 * Apply a patch to produce a NEW WorldState (never mutates the input).
 * Uses structural sharing — unchanged Map/objects are not cloned.
 */
function applyPatch(state: WorldState, patch: StatePatch): WorldState {
  const next: WorldState = { ...state, timestamp: Date.now() };

  if (patch.files) {
    // Clone the Map only when files actually change
    next.files = new Map(state.files);
    for (const fp of patch.files) {
      if (fp.type === "set" && fp.state !== undefined) {
        next.files.set(fp.path, fp.state);
      } else if (fp.type === "delete") {
        next.files.delete(fp.path);
      }
    }
  }

  if (patch.build !== undefined) next.build = { ...state.build, ...patch.build };
  if (patch.test !== undefined) next.test = { ...state.test, ...patch.test };
  if (patch.git !== undefined) next.git = { ...state.git, ...patch.git };
  if (patch.deps !== undefined) next.deps = { ...state.deps, ...patch.deps };

  return next;
}

/**
 * Produce a StatePatch by comparing two WorldState values.
 * Only includes sub-trees that differ.
 */
function diffStates(before: WorldState, after: WorldState): StatePatch {
  const patch: StatePatch = {};

  // Files: find added/changed/deleted entries
  const filePatches: FilePatch[] = [];
  for (const [path, afterFile] of after.files) {
    const beforeFile = before.files.get(path);
    if (
      beforeFile === undefined ||
      beforeFile.hash !== afterFile.hash ||
      beforeFile.exists !== afterFile.exists ||
      beforeFile.lines !== afterFile.lines ||
      beforeFile.lastModified !== afterFile.lastModified
    ) {
      filePatches.push({ type: "set", path, state: afterFile });
    }
  }
  for (const path of before.files.keys()) {
    if (!after.files.has(path)) {
      filePatches.push({ type: "delete", path });
    }
  }
  if (filePatches.length > 0) patch.files = filePatches;

  // Build
  if (JSON.stringify(before.build) !== JSON.stringify(after.build)) {
    patch.build = { ...after.build };
  }

  // Test
  if (JSON.stringify(before.test) !== JSON.stringify(after.test)) {
    patch.test = { ...after.test };
  }

  // Git
  if (JSON.stringify(before.git) !== JSON.stringify(after.git)) {
    patch.git = { ...after.git };
  }

  // Deps
  if (JSON.stringify(before.deps) !== JSON.stringify(after.deps)) {
    patch.deps = { ...after.deps };
  }

  return patch;
}

/**
 * Replay all patches from a base state up to (and including) the entry at `index`.
 */
function replayPatches(base: WorldState, patches: PatchHistoryEntry[], upTo: number): WorldState {
  let state = base;
  for (let i = 0; i <= upTo && i < patches.length; i++) {
    state = applyPatch(state, patches[i].patch);
  }
  return state;
}

// ─── StateStore ───

export class StateStore {
  /** Immutable base — never mutated after construction */
  private readonly base: WorldState;
  /** Current materialized state (kept up to date on every update) */
  private current: WorldState;
  private patches: PatchHistoryEntry[];
  private readonly maxPatches: number;

  constructor(initial: WorldState, maxPatches = 20) {
    // Shallow-clone the initial state so callers can't mutate it from outside
    this.base = {
      ...initial,
      files: new Map(initial.files),
      build: { ...initial.build, errors: [...initial.build.errors] },
      test: { ...initial.test, failingTests: [...initial.test.failingTests] },
      git: {
        ...initial.git,
        stagedFiles: [...initial.git.stagedFiles],
        uncommittedFiles: [...initial.git.uncommittedFiles],
      },
      deps: {
        ...initial.deps,
        missing: [...initial.deps.missing],
        outdated: [...initial.deps.outdated],
      },
    };
    // current starts as the same value as base (structural sharing is fine here)
    this.current = this.base;
    this.patches = [];
    this.maxPatches = maxPatches;
  }

  /** Returns the current materialized state (already computed — O(1)). */
  getState(): WorldState {
    return this.current;
  }

  /**
   * Apply a StatePatch: saves patch to history, updates current in-place (structurally).
   * O(k) where k = number of file entries in the patch, not total file count.
   */
  update(patch: StatePatch, action: string): void {
    const memorySizeBytes = estimatePatchSize(patch);
    this.patches.push({ action, timestamp: Date.now(), patch, memorySizeBytes });

    // Trim oldest patches if over the limit
    if (this.patches.length > this.maxPatches) {
      this.patches.splice(0, this.patches.length - this.maxPatches);
    }

    // Advance current state
    this.current = applyPatch(this.current, patch);
  }

  /**
   * Compute a StatePatch by diffing before and after WorldState objects.
   * Useful for callers who already have the new state and want to store the delta.
   */
  static diffStates(before: WorldState, after: WorldState): StatePatch {
    return diffStates(before, after);
  }

  /** Look up a single file's current state — O(1). */
  getFileState(path: string): FileState | undefined {
    return this.current.files.get(path);
  }

  /**
   * Reconstruct the historical state after applying the first `index + 1` patches.
   * O(index × avg_patch_size).
   */
  getStateAt(index: number): WorldState {
    if (index < 0 || index >= this.patches.length) {
      throw new RangeError(
        `getStateAt: index ${index} out of range [0, ${this.patches.length - 1}]`,
      );
    }
    return replayPatches(this.base, this.patches, index);
  }

  /**
   * Returns change history for a specific file path across all patch entries.
   * For each patch that touched the file, returns the before/after FileState.
   */
  getFileHistory(
    path: string,
  ): Array<{ action: string; before: FileState | undefined; after: FileState }> {
    const result: Array<{ action: string; before: FileState | undefined; after: FileState }> = [];

    // Walk patches; maintain a running "previous state" for this file
    let prevFileState: FileState | undefined = this.base.files.get(path);

    for (const entry of this.patches) {
      if (!entry.patch.files) continue;
      const fp = entry.patch.files.find((f) => f.path === path);
      if (!fp) continue;

      if (fp.type === "set" && fp.state !== undefined) {
        result.push({ action: entry.action, before: prevFileState, after: fp.state });
        prevFileState = fp.state;
      }
      // "delete" patches don't have an "after" FileState — skip for history purposes
    }

    return result;
  }

  /** Return memory usage stats for monitoring/debugging. */
  getMemoryStats(): MemoryStats {
    const baseSnapshotBytes = estimateSnapshotSize(this.base);
    let totalPatchBytes = 0;
    let largestPatchBytes = 0;
    for (const entry of this.patches) {
      totalPatchBytes += entry.memorySizeBytes;
      if (entry.memorySizeBytes > largestPatchBytes) {
        largestPatchBytes = entry.memorySizeBytes;
      }
    }
    return {
      baseSnapshotBytes,
      totalPatchBytes,
      totalBytes: baseSnapshotBytes + totalPatchBytes,
      entryCount: this.patches.length,
      largestPatchBytes,
    };
  }

  /**
   * Trim oldest patches if total patch memory exceeds `maxBytes`.
   * Returns the number of patches trimmed.
   * Default limit is 5 MB.
   */
  trimIfNeeded(maxBytes = 5 * 1024 * 1024): number {
    let trimmed = 0;
    while (this.patches.length > 0) {
      const stats = this.getMemoryStats();
      if (stats.totalBytes <= maxBytes) break;
      this.patches.shift();
      trimmed++;
    }
    return trimmed;
  }

  /**
   * Format current state as a string for injection into an LLM prompt.
   * Pass `compact = true` for a single-line summary.
   */
  formatForPrompt(compact = false): string {
    const s = this.current;
    const stats = this.getMemoryStats();

    if (compact) {
      return [
        `[World State] git:${s.git.branch}(${s.git.dirty ? "dirty" : "clean"})`,
        `build:${s.build.status} test:${s.test.status}`,
        `files_tracked:${s.files.size} history:${stats.entryCount}patches(${Math.round(stats.totalBytes / 1024)}KB)`,
      ].join(" | ");
    }

    const lines = [
      "## Current World State",
      `**Git**: branch=${s.git.branch}, ${s.git.dirty ? `dirty (${s.git.uncommittedFiles.length} files)` : "clean"}`,
      `**Build**: ${s.build.status}${s.build.errors.length ? ` — ${s.build.errors.length} errors` : ""}`,
      `**Tests**: ${s.test.status}${s.test.failingTests.length ? ` — failing: ${s.test.failingTests.join(", ")}` : ""}`,
      `**Files tracked**: ${s.files.size}`,
      `**State history**: ${stats.entryCount} patches, ${Math.round(stats.totalBytes / 1024)}KB`,
    ];

    if (s.git.uncommittedFiles.length > 0) {
      lines.push(
        `**Uncommitted**: ${s.git.uncommittedFiles.slice(0, 5).join(", ")}${s.git.uncommittedFiles.length > 5 ? " ..." : ""}`,
      );
    }
    if (s.build.errors.length > 0) {
      lines.push(`**Build errors**: ${s.build.errors.slice(0, 3).join("; ")}`);
    }

    return lines.join("\n");
  }

  /**
   * Convert to WorldStateSnapshot for backward compatibility with existing code.
   */
  toSnapshot(): WorldStateSnapshot {
    const { build, test, git, deps, files, timestamp } = this.current;

    const buildLastResult: "pass" | "fail" | "unknown" =
      build.status === "running" ? "unknown" : build.status;

    type BuildTool = "tsc" | "webpack" | "vite" | "esbuild" | "unknown";
    const knownBuildTools: BuildTool[] = ["tsc", "webpack", "vite", "esbuild"];
    const buildTool: BuildTool = (knownBuildTools as string[]).includes(build.buildTool)
      ? (build.buildTool as BuildTool)
      : "unknown";

    const testLastResult: "pass" | "fail" | "unknown" =
      test.status === "running" ? "unknown" : test.status;

    type TestRunner = "jest" | "vitest" | "mocha" | "node:test" | "unknown";
    const knownTestRunners: TestRunner[] = ["jest", "vitest", "mocha", "node:test"];
    const testRunner: TestRunner = (knownTestRunners as string[]).includes(test.testRunner)
      ? (test.testRunner as TestRunner)
      : "unknown";

    type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";
    const knownPMs: PackageManager[] = ["npm", "pnpm", "yarn", "bun"];
    const packageManager: PackageManager = (knownPMs as string[]).includes(deps.packageManager)
      ? (deps.packageManager as PackageManager)
      : "unknown";

    const recentlyChanged: string[] = [];
    for (const [path, fileState] of files) {
      if (fileState.exists) recentlyChanged.push(path);
    }

    return {
      git: {
        branch: git.branch,
        status: git.dirty ? "dirty" : "clean",
        uncommittedFiles: [...git.uncommittedFiles],
        recentCommits: [],
        hasConflicts: false,
      },
      build: {
        lastResult: buildLastResult,
        errors: [...build.errors],
        buildTool,
      },
      test: {
        lastResult: testLastResult,
        failingTests: [...test.failingTests],
        testRunner,
      },
      deps: {
        packageManager,
        outdated: [...deps.outdated],
        missing: [...deps.missing],
      },
      files: {
        recentlyChanged,
        totalFiles: files.size,
      },
      errors: { recentRuntimeErrors: [] },
      collectedAt: new Date(timestamp).toISOString(),
    };
  }

  /**
   * Create StateStore from an existing WorldStateSnapshot.
   * The files Map starts empty since snapshots don't carry per-file info.
   */
  static fromSnapshot(snapshot: WorldStateSnapshot, _projectPath: string): StateStore {
    const buildStatus: BuildState["status"] =
      snapshot.build.lastResult === "unknown" ? "unknown" : snapshot.build.lastResult;

    const testStatus: TestState["status"] =
      snapshot.test.lastResult === "unknown" ? "unknown" : snapshot.test.lastResult;

    const initial: WorldState = {
      files: new Map(),
      build: {
        status: buildStatus,
        errors: [...snapshot.build.errors],
        lastRun: 0,
        buildTool: snapshot.build.buildTool,
      },
      test: {
        status: testStatus,
        failingTests: [...snapshot.test.failingTests],
        lastRun: 0,
        testRunner: snapshot.test.testRunner,
      },
      git: {
        branch: snapshot.git.branch,
        dirty: snapshot.git.status === "dirty",
        stagedFiles: [],
        uncommittedFiles: [...snapshot.git.uncommittedFiles],
        lastCommit:
          snapshot.git.recentCommits.length > 0 ? snapshot.git.recentCommits[0].hash : "",
      },
      deps: {
        packageManager: snapshot.deps.packageManager,
        missing: [...snapshot.deps.missing],
        outdated: [...snapshot.deps.outdated],
      },
      timestamp: new Date(snapshot.collectedAt).getTime(),
    };

    return new StateStore(initial);
  }

  /**
   * Get last N patch history entries (most recent last).
   */
  getHistory(limit?: number): PatchHistoryEntry[] {
    if (limit === undefined) return [...this.patches];
    return this.patches.slice(-limit);
  }
}
