/**
 * @module checkpoint-manager
 * @description Task-level Checkpoint / Rollback / Resume Manager (Phase 6).
 *
 * Saves git-backed snapshots at key task milestones so that interrupted tasks
 * can be resumed or rolled back mid-execution.  Complements session-persistence
 * (which handles session-level replay) — this module focuses on intra-task
 * rollback using git stash as a workspace snapshot mechanism.
 *
 * Storage: ~/.yuan/checkpoints/{taskId}.json  (array of TaskCheckpoint)
 * All writes are atomic (write to .tmp then renameSync).
 * All git operations are wrapped in try/catch — git failures are non-fatal.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TaskCheckpoint {
  /** UUID */
  id: string;
  taskId: string;
  sessionId: string;
  /** Human-readable label, e.g. "after_plan", "pre_verification" */
  label: string;
  iteration: number;
  completedSteps: string[];
  pendingSteps: string[];
  /** git stash hash or tag captured at save time, if git is available */
  gitRef?: string;
  /** Serializable agent state snapshot */
  agentState: Record<string, unknown>;
  tokenUsed: number;
  createdAt: string;
}

export interface RollbackResult {
  success: boolean;
  restoredTo: string; // checkpoint label
  gitRestored: boolean;
  error?: string;
}

// ─── CheckpointManager ────────────────────────────────────────────────────────

export interface CheckpointManagerConfig {
  /** Directory where checkpoint files are stored. Default: ~/.yuan/checkpoints */
  storageDir?: string;
  /** Project root used for git operations. Default: process.cwd() */
  projectPath?: string;
  /** Max checkpoints kept per task (oldest removed first). Default: 5 */
  maxCheckpoints?: number;
}

export class CheckpointManager extends EventEmitter {
  private readonly storageDir: string;
  private readonly projectPath: string;
  private readonly maxCheckpoints: number;

  constructor(config: CheckpointManagerConfig = {}) {
    super();
    this.storageDir =
      config.storageDir ?? path.join(os.homedir(), ".yuan", "checkpoints");
    this.projectPath = config.projectPath ?? process.cwd();
    this.maxCheckpoints = config.maxCheckpoints ?? 5;
    fs.mkdirSync(this.storageDir, { recursive: true });
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Save a checkpoint at current state.
   * Attempts a git stash to capture workspace state; falls back gracefully if
   * git is unavailable or the working tree is clean.
   */
  async save(
    taskId: string,
    sessionId: string,
    label: string,
    state: {
      iteration: number;
      completedSteps: string[];
      pendingSteps: string[];
      agentState: Record<string, unknown>;
      tokenUsed: number;
    },
  ): Promise<TaskCheckpoint> {
    const gitRef = this.tryGitStash();

    const checkpoint: TaskCheckpoint = {
      id: randomUUID(),
      taskId,
      sessionId,
      label,
      iteration: state.iteration,
      completedSteps: [...state.completedSteps],
      pendingSteps: [...state.pendingSteps],
      agentState: { ...state.agentState },
      tokenUsed: state.tokenUsed,
      createdAt: new Date().toISOString(),
      ...(gitRef !== undefined ? { gitRef } : {}),
    };

    // Load existing, append, cap, and write back atomically.
    const existing = this.loadFile(taskId);
    existing.push(checkpoint);
    if (existing.length > this.maxCheckpoints) {
      existing.splice(0, existing.length - this.maxCheckpoints);
    }
    this.writeFile(taskId, existing);

    this.emit("event", {
      kind: "agent:checkpoint_saved",
      checkpointId: checkpoint.id,
      taskId,
      label,
      iteration: state.iteration,
      timestamp: Date.now(),
    });

    return checkpoint;
  }

  /**
   * List all checkpoints for a task, oldest first.
   */
  list(taskId: string): TaskCheckpoint[] {
    return this.loadFile(taskId);
  }

  /**
   * Return the most recent checkpoint for a task, or null if none.
   */
  latest(taskId: string): TaskCheckpoint | null {
    const checkpoints = this.loadFile(taskId);
    if (checkpoints.length === 0) return null;
    return checkpoints[checkpoints.length - 1];
  }

  /**
   * Roll back workspace to the state captured in a checkpoint.
   * If `gitRef` is present, applies the stash via `git stash apply`.
   */
  async rollback(checkpointId: string): Promise<RollbackResult> {
    // Search all task files for the checkpoint.
    const found = this.findCheckpoint(checkpointId);
    if (!found) {
      return {
        success: false,
        restoredTo: "",
        gitRestored: false,
        error: `Checkpoint ${checkpointId} not found`,
      };
    }

    const { checkpoint } = found;
    let gitRestored = false;
    let error: string | undefined;

    if (checkpoint.gitRef) {
      try {
        execSync(`git stash apply ${checkpoint.gitRef}`, {
          cwd: this.projectPath,
          stdio: "pipe",
        });
        gitRestored = true;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }

    this.emit("event", {
      kind: "agent:checkpoint_restored",
      checkpointId,
      taskId: checkpoint.taskId,
      label: checkpoint.label,
      gitRestored,
      timestamp: Date.now(),
    });

    return {
      success: true,
      restoredTo: checkpoint.label,
      gitRestored,
      ...(error !== undefined ? { error } : {}),
    };
  }

  /**
   * Delete all checkpoints for a task (call after successful completion).
   */
  clear(taskId: string): void {
    const filePath = this.checkpointFilePath(taskId);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Non-fatal: best-effort cleanup.
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Attempt `git stash` and return the stash ref (e.g. "stash@{0}").
   * Returns undefined if git is unavailable, not a repo, or the tree is clean.
   */
  private tryGitStash(): string | undefined {
    try {
      const output = execSync("git stash", {
        cwd: this.projectPath,
        stdio: "pipe",
        encoding: "utf-8",
      });
      // "No local changes to save" means nothing was stashed.
      if (output.includes("No local changes to save")) return undefined;
      // git stash outputs "Saved working directory and index state ..."
      // The most recent stash is always stash@{0}.
      return "stash@{0}";
    } catch {
      return undefined;
    }
  }

  private checkpointFilePath(taskId: string): string {
    // Sanitize taskId to prevent path traversal.
    const safe = taskId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
    return path.join(this.storageDir, `${safe}.json`);
  }

  private loadFile(taskId: string): TaskCheckpoint[] {
    const filePath = this.checkpointFilePath(taskId);
    try {
      if (!fs.existsSync(filePath)) return [];
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as TaskCheckpoint[]) : [];
    } catch {
      return [];
    }
  }

  private writeFile(taskId: string, checkpoints: TaskCheckpoint[]): void {
    const filePath = this.checkpointFilePath(taskId);
    const tmpPath = `${filePath}.${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(checkpoints), "utf-8");
    fs.renameSync(tmpPath, filePath);
  }

  /**
   * Scan all checkpoint files to find a checkpoint by its ID.
   * Returns the checkpoint and its taskId, or undefined if not found.
   */
  private findCheckpoint(
    checkpointId: string,
  ): { checkpoint: TaskCheckpoint; taskId: string } | undefined {
    let files: string[];
    try {
      files = fs
        .readdirSync(this.storageDir)
        .filter((f) => f.endsWith(".json"));
    } catch {
      return undefined;
    }

    for (const file of files) {
      try {
        const raw = fs.readFileSync(
          path.join(this.storageDir, file),
          "utf-8",
        );
        const checkpoints: TaskCheckpoint[] = JSON.parse(raw);
        if (!Array.isArray(checkpoints)) continue;
        const match = checkpoints.find((c) => c.id === checkpointId);
        if (match) {
          return { checkpoint: match, taskId: match.taskId };
        }
      } catch {
        continue;
      }
    }

    return undefined;
  }
}
