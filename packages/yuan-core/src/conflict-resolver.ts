/**
 * @module conflict-resolver
 * @description Detects and resolves conflicts when multiple agents modify related files.
 * Supports same-file edits, import breaks, type mismatches, and test regressions.
 *
 * Includes a pure-TypeScript LCS-based 3-way merge algorithm (no external deps).
 */

// ─── Types ───

/** Classification of conflict types between agent modifications. */
export type ConflictType =
  | "SAME_FILE_EDIT"
  | "IMPORT_BREAK"
  | "TYPE_MISMATCH"
  | "TEST_REGRESSION";

/** Describes a conflict between two file modifications. */
export interface FileConflict {
  /** Kind of conflict */
  type: ConflictType;
  /** First file involved */
  fileA: { path: string; agentId: string; diff: string };
  /** Second file involved */
  fileB: { path: string; agentId: string; diff: string };
  /** Severity of the conflict */
  severity: "low" | "medium" | "high" | "critical";
}

/** Resolution strategy for a conflict. */
export type ConflictResolution =
  | { strategy: "AUTO_MERGE"; mergedDiff: string }
  | { strategy: "PRIORITY"; winner: string }
  | { strategy: "RE_RUN"; taskId: string }
  | { strategy: "USER_APPROVAL"; options: string[] };

/** A task result with changed files, used for conflict detection. */
interface TaskResultLike {
  taskId: string;
  agentId: string;
  changedFiles: { path: string; diff: string }[];
}

/** A hunk representing a diff operation (equal, insert, or delete). */
export interface DiffHunk {
  /** Type of diff operation */
  type: "equal" | "insert" | "delete";
  /** Lines involved in this hunk */
  lines: string[];
  /** Starting line index in the base (for delete/equal) or modified (for insert) */
  baseStart: number;
  /** Starting line index in the modified version */
  modifiedStart: number;
}

/** A region where two modifications conflict. */
export interface ConflictHunk {
  /** Starting line number in the merged output (0-based) */
  lineStart: number;
  /** Lines from "ours" (agent A) */
  ours: string[];
  /** Lines from "theirs" (agent B) */
  theirs: string[];
  /** Lines from the base (original) */
  base: string[];
}

/** Result of a three-way merge attempt. */
export interface MergeResult {
  /** Whether the merge succeeded without conflicts */
  success: boolean;
  /** Merged content (with conflict markers if !success) */
  merged: string;
  /** Conflict regions, if any */
  conflicts: ConflictHunk[];
  /** Merge statistics */
  stats: { added: number; removed: number; conflicted: number };
}

// ─── Regex for detecting export changes ───

const EXPORT_CHANGE_RE =
  /^[+-]\s*export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|interface|type|enum)\s+(\w+)/gm;

const EXPORT_LIST_CHANGE_RE = /^[+-]\s*export\s+\{([^}]*)\}/gm;

const IMPORT_RE =
  /^[+-]\s*import\s+(?:type\s+)?(?:\{([^}]*)\}|(\w+)|\*\s+as\s+(\w+))\s+from\s+["']([^"']+)["']/gm;

// ─── LCS-based Diff Algorithm (pure TypeScript, no deps) ───

/**
 * Compute the Longest Common Subsequence table for two string arrays.
 *
 * Returns a 2D table where `table[i][j]` is the length of the LCS
 * of `a[0..i-1]` and `b[0..j-1]`.
 *
 * @param a - First array of lines
 * @param b - Second array of lines
 * @returns LCS length table (dimensions: (a.length+1) x (b.length+1))
 */
export function lcs(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const table: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        table[i][j] = table[i - 1][j - 1] + 1;
      } else {
        table[i][j] = Math.max(table[i - 1][j], table[i][j - 1]);
      }
    }
  }

  return table;
}

/**
 * Compute a line-level diff between base and modified text using LCS.
 *
 * Produces a sequence of DiffHunks representing equal, insert, and delete operations
 * that transform `base` into `modified`.
 *
 * @param base - Original lines
 * @param modified - Modified lines
 * @returns Array of DiffHunks in order
 */
export function diff(base: string[], modified: string[]): DiffHunk[] {
  const table = lcs(base, modified);
  const hunks: DiffHunk[] = [];

  // Backtrack through LCS table to build diff
  let i = base.length;
  let j = modified.length;
  const ops: Array<{ type: "equal" | "insert" | "delete"; baseLine: string; modLine: string; bi: number; mi: number }> = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && base[i - 1] === modified[j - 1]) {
      ops.push({ type: "equal", baseLine: base[i - 1], modLine: modified[j - 1], bi: i - 1, mi: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || table[i][j - 1] >= table[i - 1][j])) {
      ops.push({ type: "insert", baseLine: "", modLine: modified[j - 1], bi: i, mi: j - 1 });
      j--;
    } else {
      ops.push({ type: "delete", baseLine: base[i - 1], modLine: "", bi: i - 1, mi: j });
      i--;
    }
  }

  ops.reverse();

  // Group consecutive operations of the same type into hunks
  let current: DiffHunk | null = null;

  for (const op of ops) {
    if (current && current.type === op.type) {
      current.lines.push(op.type === "insert" ? op.modLine : op.baseLine);
    } else {
      if (current) hunks.push(current);
      current = {
        type: op.type,
        lines: [op.type === "insert" ? op.modLine : op.baseLine],
        baseStart: op.bi,
        modifiedStart: op.mi,
      };
    }
  }

  if (current) hunks.push(current);

  return hunks;
}

/**
 * Perform a 3-way merge of two modifications against a common base.
 *
 * Algorithm:
 * 1. Split base, ours, theirs into lines
 * 2. Compute diff(base, ours) and diff(base, theirs)
 * 3. Walk through base lines, applying changes from both sides:
 *    - If only one side changed a region: take that change
 *    - If both sides made identical changes: take either
 *    - If both sides changed differently: mark as CONFLICT
 * 4. Return merged result or conflict markers
 *
 * @param base - Original file content
 * @param ours - Content after agent A's modifications
 * @param theirs - Content after agent B's modifications
 * @returns MergeResult with merged content and conflict details
 */
export function merge3way(base: string, ours: string, theirs: string): MergeResult {
  const baseLines = base.split("\n");
  const oursLines = ours.split("\n");
  const theirsLines = theirs.split("\n");

  // Build change maps: for each base line index, what did each side do?
  const oursChanges = buildChangeMap(baseLines, oursLines);
  const theirsChanges = buildChangeMap(baseLines, theirsLines);

  const mergedLines: string[] = [];
  const conflicts: ConflictHunk[] = [];
  let stats = { added: 0, removed: 0, conflicted: 0 };

  let baseIdx = 0;

  while (baseIdx <= baseLines.length) {
    const oursEntry = oursChanges.get(baseIdx);
    const theirsEntry = theirsChanges.get(baseIdx);

    const oursChanged = oursEntry !== undefined;
    const theirsChanged = theirsEntry !== undefined;

    if (!oursChanged && !theirsChanged) {
      // Neither side changed this line — keep base
      if (baseIdx < baseLines.length) {
        mergedLines.push(baseLines[baseIdx]);
      }
      baseIdx++;
      continue;
    }

    if (oursChanged && !theirsChanged) {
      // Only ours changed — take ours
      applyChange(oursEntry, mergedLines, stats);
      baseIdx = oursEntry.newBaseIdx;
      continue;
    }

    if (!oursChanged && theirsChanged) {
      // Only theirs changed — take theirs
      applyChange(theirsEntry, mergedLines, stats);
      baseIdx = theirsEntry.newBaseIdx;
      continue;
    }

    // Both sides changed — check if identical
    if (
      oursEntry!.removedLines.join("\n") === theirsEntry!.removedLines.join("\n") &&
      oursEntry!.insertedLines.join("\n") === theirsEntry!.insertedLines.join("\n")
    ) {
      // Identical changes — take either
      applyChange(oursEntry!, mergedLines, stats);
      baseIdx = Math.max(oursEntry!.newBaseIdx, theirsEntry!.newBaseIdx);
      continue;
    }

    // Conflict — both sides changed differently
    const conflictBase = oursEntry!.removedLines.length > 0
      ? oursEntry!.removedLines
      : theirsEntry!.removedLines;

    const conflict: ConflictHunk = {
      lineStart: mergedLines.length,
      ours: oursEntry!.insertedLines,
      theirs: theirsEntry!.insertedLines,
      base: conflictBase,
    };
    conflicts.push(conflict);
    stats.conflicted++;

    // Add conflict markers to merged output
    mergedLines.push("<<<<<<< ours");
    mergedLines.push(...oursEntry!.insertedLines);
    mergedLines.push("=======");
    mergedLines.push(...theirsEntry!.insertedLines);
    mergedLines.push(">>>>>>> theirs");

    baseIdx = Math.max(oursEntry!.newBaseIdx, theirsEntry!.newBaseIdx);
  }

  return {
    success: conflicts.length === 0,
    merged: mergedLines.join("\n"),
    conflicts,
    stats,
  };
}

/** A single change region: lines removed from base and lines inserted. */
interface ChangeEntry {
  /** Base line index where the change starts */
  baseIdx: number;
  /** Lines removed from base (may be empty for pure insertions) */
  removedLines: string[];
  /** Lines inserted in place */
  insertedLines: string[];
  /** New base index after consuming this change */
  newBaseIdx: number;
}

/**
 * Build a map of base line indices to change regions.
 *
 * Compares base to modified using the LCS diff, then groups consecutive
 * non-equal operations into ChangeEntry objects keyed by their starting
 * base index.
 *
 * @param baseLines - Original lines
 * @param modifiedLines - Modified lines
 * @returns Map from base line index to ChangeEntry
 */
function buildChangeMap(
  baseLines: string[],
  modifiedLines: string[],
): Map<number, ChangeEntry> {
  const hunks = diff(baseLines, modifiedLines);
  const changeMap = new Map<number, ChangeEntry>();

  // Group consecutive non-equal hunks into change entries
  let i = 0;
  while (i < hunks.length) {
    const hunk = hunks[i];
    if (hunk.type === "equal") {
      i++;
      continue;
    }

    // Start of a change region — collect consecutive non-equal hunks
    const startBaseIdx = hunk.baseStart;
    const removed: string[] = [];
    const inserted: string[] = [];
    let endBaseIdx = startBaseIdx;

    while (i < hunks.length && hunks[i].type !== "equal") {
      const h = hunks[i];
      if (h.type === "delete") {
        removed.push(...h.lines);
        endBaseIdx = h.baseStart + h.lines.length;
      } else if (h.type === "insert") {
        inserted.push(...h.lines);
      }
      i++;
    }

    changeMap.set(startBaseIdx, {
      baseIdx: startBaseIdx,
      removedLines: removed,
      insertedLines: inserted,
      newBaseIdx: endBaseIdx,
    });
  }

  return changeMap;
}

/**
 * Apply a ChangeEntry to the merged output lines.
 *
 * @param entry - The change to apply
 * @param mergedLines - Output array to append to
 * @param stats - Stats object to update
 */
function applyChange(
  entry: ChangeEntry,
  mergedLines: string[],
  stats: { added: number; removed: number; conflicted: number },
): void {
  stats.removed += entry.removedLines.length;
  stats.added += entry.insertedLines.length;
  mergedLines.push(...entry.insertedLines);
}

// ─── ConflictResolver ───

/**
 * Detects and resolves conflicts when multiple agents modify related files.
 *
 * Supports automatic three-way merging for non-overlapping edits
 * using a pure-TypeScript LCS-based diff algorithm,
 * and escalates to user approval when automatic resolution fails.
 */
export class ConflictResolver {
  /**
   * Detect conflicts between completed task results.
   *
   * Checks for:
   * - SAME_FILE_EDIT: Two agents modified the same file
   * - IMPORT_BREAK: One agent changed exports that another agent imports
   *
   * @param results - Array of task results from different agents
   * @returns Array of detected conflicts
   */
  detectConflicts(results: TaskResultLike[]): FileConflict[] {
    const conflicts: FileConflict[] = [];

    // Index: path → list of { taskId, agentId, diff }
    const fileIndex = new Map<
      string,
      { taskId: string; agentId: string; diff: string }[]
    >();

    for (const result of results) {
      for (const changed of result.changedFiles) {
        let list = fileIndex.get(changed.path);
        if (!list) {
          list = [];
          fileIndex.set(changed.path, list);
        }
        list.push({
          taskId: result.taskId,
          agentId: result.agentId,
          diff: changed.diff,
        });
      }
    }

    // 1. Detect SAME_FILE_EDIT conflicts
    for (const [path, editors] of fileIndex) {
      if (editors.length < 2) continue;

      for (let i = 0; i < editors.length; i++) {
        for (let j = i + 1; j < editors.length; j++) {
          const a = editors[i];
          const b = editors[j];
          const severity = this.assessSameFileSeverity(a.diff, b.diff);
          conflicts.push({
            type: "SAME_FILE_EDIT",
            fileA: { path, agentId: a.agentId, diff: a.diff },
            fileB: { path, agentId: b.agentId, diff: b.diff },
            severity,
          });
        }
      }
    }

    // 2. Detect IMPORT_BREAK conflicts
    for (let i = 0; i < results.length; i++) {
      const exporterResult = results[i];
      const changedExports = this.extractChangedExports(exporterResult);

      if (changedExports.length === 0) continue;

      for (let j = 0; j < results.length; j++) {
        if (i === j) continue;
        const importerResult = results[j];
        const importedSymbols = this.extractImportedSymbols(importerResult);

        for (const exp of changedExports) {
          for (const imp of importedSymbols) {
            if (
              imp.symbols.some((s) => exp.symbols.includes(s)) &&
              imp.fromPath.includes(
                exp.filePath.replace(/\.[tj]sx?$/, ""),
              )
            ) {
              const exportFile = exporterResult.changedFiles.find(
                (f) => f.path === exp.filePath,
              );
              const importFile = importerResult.changedFiles[0];
              if (exportFile && importFile) {
                conflicts.push({
                  type: "IMPORT_BREAK",
                  fileA: {
                    path: exp.filePath,
                    agentId: exporterResult.agentId,
                    diff: exportFile.diff,
                  },
                  fileB: {
                    path: importFile.path,
                    agentId: importerResult.agentId,
                    diff: importFile.diff,
                  },
                  severity: "high",
                });
              }
            }
          }
        }
      }
    }

    return conflicts;
  }

  /**
   * Resolve detected conflicts using automatic strategies.
   *
   * Strategy per conflict type:
   * - SAME_FILE_EDIT: attempt 3-way merge via LCS diff; auto-resolve if clean, escalate if conflicts
   * - IMPORT_BREAK: RE_RUN the dependent (importing) task
   * - TYPE_MISMATCH: RE_RUN the dependent task
   * - TEST_REGRESSION: RE_RUN the causing task
   *
   * @param conflicts - Array of detected conflicts
   * @param baseContents - Optional map of file path to base (original) content for 3-way merge
   * @returns Resolution for each conflict
   */
  async resolveConflicts(
    conflicts: FileConflict[],
    baseContents?: Map<string, string>,
  ): Promise<ConflictResolution[]> {
    const resolutions: ConflictResolution[] = [];

    for (const conflict of conflicts) {
      switch (conflict.type) {
        case "SAME_FILE_EDIT": {
          const base = baseContents?.get(conflict.fileA.path) ?? "";
          const mergeResult = merge3way(
            base,
            conflict.fileA.diff,
            conflict.fileB.diff,
          );

          if (mergeResult.success) {
            resolutions.push({
              strategy: "AUTO_MERGE",
              mergedDiff: mergeResult.merged,
            });
          } else {
            resolutions.push({
              strategy: "USER_APPROVAL",
              options: [
                `Accept changes from agent ${conflict.fileA.agentId}`,
                `Accept changes from agent ${conflict.fileB.agentId}`,
                "Manually merge both changes",
                ...mergeResult.conflicts.map(
                  (c) =>
                    `Conflict at line ${c.lineStart}: ${c.ours.length} ours vs ${c.theirs.length} theirs lines`,
                ),
              ],
            });
          }
          break;
        }

        case "IMPORT_BREAK":
        case "TYPE_MISMATCH": {
          resolutions.push({
            strategy: "RE_RUN",
            taskId: conflict.fileB.agentId,
          });
          break;
        }

        case "TEST_REGRESSION": {
          resolutions.push({
            strategy: "RE_RUN",
            taskId: conflict.fileA.agentId,
          });
          break;
        }

        default: {
          resolutions.push({
            strategy: "USER_APPROVAL",
            options: ["Review conflict manually"],
          });
        }
      }
    }

    return resolutions;
  }

  /**
   * Perform a standalone 3-way merge for external callers.
   *
   * @param base - Original file content
   * @param ours - Agent A's modified content
   * @param theirs - Agent B's modified content
   * @returns MergeResult with merged content, conflict details, and stats
   */
  merge(base: string, ours: string, theirs: string): MergeResult {
    return merge3way(base, ours, theirs);
  }

  // ─── Private helpers ───

  /**
   * Assess severity of a same-file edit conflict by checking
   * whether the two diffs touch the same lines.
   */
  private assessSameFileSeverity(
    diffA: string,
    diffB: string,
  ): "low" | "medium" | "high" | "critical" {
    const aLines = diffA.split("\n");
    const bLines = diffB.split("\n");

    // Quick heuristic: compute which base line indices each diff touches
    const touchedA = this.extractTouchedLines(aLines);
    const touchedB = this.extractTouchedLines(bLines);

    if (touchedA.size === 0 || touchedB.size === 0) {
      return "low";
    }

    let overlapping = 0;
    for (const line of touchedA) {
      if (touchedB.has(line)) overlapping++;
    }

    if (overlapping === 0) return "low";
    if (overlapping < 3) return "medium";
    if (overlapping < 10) return "high";
    return "critical";
  }

  /**
   * Extract base line indices touched by a diff (from unified diff format).
   */
  private extractTouchedLines(lines: string[]): Set<number> {
    const touched = new Set<number>();
    let currentLine = 0;
    const hunkHeaderRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

    for (const line of lines) {
      const hunkMatch = hunkHeaderRe.exec(line);
      if (hunkMatch) {
        currentLine = parseInt(hunkMatch[1], 10) - 1;
        continue;
      }

      if (line.startsWith("-") && !line.startsWith("---")) {
        touched.add(currentLine);
        currentLine++;
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        touched.add(currentLine);
      } else if (!line.startsWith("\\")) {
        currentLine++;
      }
    }

    return touched;
  }

  /**
   * Extract symbols that were added/removed from export statements
   * across all changed files in a result.
   */
  private extractChangedExports(
    result: TaskResultLike,
  ): { filePath: string; symbols: string[] }[] {
    const exports: { filePath: string; symbols: string[] }[] = [];

    for (const changed of result.changedFiles) {
      const symbols: string[] = [];

      let match: RegExpExecArray | null;

      // Named export changes
      const namedRe = new RegExp(EXPORT_CHANGE_RE.source, "gm");
      while ((match = namedRe.exec(changed.diff)) !== null) {
        symbols.push(match[1]);
      }

      // Export list changes
      const listRe = new RegExp(EXPORT_LIST_CHANGE_RE.source, "gm");
      while ((match = listRe.exec(changed.diff)) !== null) {
        const names = match[1]
          .split(",")
          .map((s) => s.trim().split(/\s+as\s+/)[0])
          .filter(Boolean);
        symbols.push(...names);
      }

      if (symbols.length > 0) {
        exports.push({ filePath: changed.path, symbols: [...new Set(symbols)] });
      }
    }

    return exports;
  }

  /**
   * Extract symbols imported by changed files in a result.
   */
  private extractImportedSymbols(
    result: TaskResultLike,
  ): { symbols: string[]; fromPath: string }[] {
    const imports: { symbols: string[]; fromPath: string }[] = [];

    for (const changed of result.changedFiles) {
      let match: RegExpExecArray | null;
      const importRe = new RegExp(IMPORT_RE.source, "gm");

      while ((match = importRe.exec(changed.diff)) !== null) {
        const namedGroup = match[1];
        const defaultImport = match[2];
        const namespaceImport = match[3];
        const fromPath = match[4];

        const symbols: string[] = [];
        if (namedGroup) {
          symbols.push(
            ...namedGroup
              .split(",")
              .map((s) => s.trim().split(/\s+as\s+/)[0])
              .filter(Boolean),
          );
        }
        if (defaultImport) symbols.push(defaultImport);
        if (namespaceImport) symbols.push(namespaceImport);

        if (symbols.length > 0) {
          imports.push({ symbols, fromPath });
        }
      }
    }

    return imports;
  }
}
