/**
 * @module patch-transaction
 * @description Patch transaction journal for atomic file modifications.
 * Records before/after snapshots of all file mutations.
 * Enables deterministic rollback on failure.
 * NO LLM, pure file I/O.
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

export interface PatchJournalEntry {
  id: string;
  tool: string;
  path: string;
  beforeSnapshot: string;  // file content before mutation (empty for new files)
  timestamp: number;
  wasNewFile: boolean;
}

export interface RollbackPoint {
  id: string;
  entries: PatchJournalEntry[];
  reason: string;
  createdAt: number;
}

export class PatchTransactionJournal {
  private entries: PatchJournalEntry[] = [];
  private rollbackPoints: RollbackPoint[] = [];
  private journalPath: string;
  private entryCounter = 0;

  constructor(projectPath: string, sessionId: string) {
    const sessionDir = join(projectPath, ".yuan", "sessions", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    this.journalPath = join(sessionDir, "patch-journal.jsonl");
  }

  /**
   * Record a file's state BEFORE mutation.
   * Call this before every file_edit / file_write.
   */
  recordBefore(tool: string, filePath: string): string {
    const id = `patch-${++this.entryCounter}-${Date.now()}`;
    let beforeSnapshot = "";
    let wasNewFile = true;

    try {
      beforeSnapshot = readFileSync(filePath, "utf-8");
      wasNewFile = false;
    } catch {
      // File doesn't exist yet (new file creation)
      beforeSnapshot = "";
      wasNewFile = true;
    }

    const entry: PatchJournalEntry = {
      id,
      tool,
      path: filePath,
      beforeSnapshot,
      timestamp: Date.now(),
      wasNewFile,
    };

    this.entries.push(entry);

    // Persist to JSONL
    try {
      appendFileSync(this.journalPath, JSON.stringify(entry) + "\n");
    } catch { /* non-fatal */ }

    return id;
  }

  /**
   * Create a rollback point — snapshot of all mutations so far.
   * Called when patchRisk >= threshold or changedFiles >= threshold.
   */
  createRollbackPoint(reason: string): RollbackPoint {
    const point: RollbackPoint = {
      id: `rollback-${Date.now()}`,
      entries: [...this.entries],
      reason,
      createdAt: Date.now(),
    };

    this.rollbackPoints.push(point);
    return point;
  }

  /**
   * Execute rollback — restore all files to their before state.
   * Processes entries in reverse order (last modified first).
   */
  rollback(pointId?: string): { restored: number; errors: string[] } {
    const point = pointId
      ? this.rollbackPoints.find(p => p.id === pointId)
      : this.rollbackPoints[this.rollbackPoints.length - 1];

    if (!point) {
      return { restored: 0, errors: ["No rollback point found"] };
    }

    let restored = 0;
    const errors: string[] = [];

    // Reverse order — undo last change first
    for (const entry of [...point.entries].reverse()) {
      try {
        if (entry.wasNewFile) {
          // File was newly created — delete it
          const { unlinkSync } = require("node:fs") as typeof import("node:fs");
          try { unlinkSync(entry.path); } catch { /* may already be gone */ }
        } else {
          // File existed — restore original content
          mkdirSync(dirname(entry.path), { recursive: true });
          writeFileSync(entry.path, entry.beforeSnapshot);
        }
        restored++;
      } catch (err) {
        errors.push(`Failed to restore ${entry.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { restored, errors };
  }

  /** Get total number of recorded mutations */
  get size(): number {
    return this.entries.length;
  }

  /** Reset for new run */
  reset(): void {
    this.entries = [];
    this.rollbackPoints = [];
    this.entryCounter = 0;
  }

  /** Check if a rollback point should be created (deterministic rule) */
  shouldCreateRollbackPoint(
    patchRisk: number,
    changedFilesCount: number,
  ): boolean {
    return patchRisk >= 0.7 || changedFilesCount >= 5;
  }
}
