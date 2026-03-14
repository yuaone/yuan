/**
 * @module autonomous/task-memory
 * @description Long Horizon Task Memory — persists task-level state under .yuan/tasks/.
 *
 * Stores the full lifecycle of an engineering task: goal, phase, files touched,
 * evidence history, and final status. Designed for multi-session tasks that
 * span multiple agent runs (e.g. a multi-day refactor).
 *
 * Storage: .yuan/tasks/<taskId>.json (one file per task)
 * All writes are atomic (write to .tmp then rename).
 */

import { mkdirSync, writeFileSync, readFileSync, renameSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { EventEmitter } from "node:events";
import type { AgentEvent } from "../types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TaskStatus = "running" | "completed" | "failed" | "paused";
export type TaskPhase = "research" | "planning" | "implement" | "verify" | "finalize";

export interface EvidenceEntry {
  /** Unix ms */
  timestamp: number;
  filePath: string;
  diffStats: { added: number; removed: number } | null;
  syntax: "ok" | "error" | "skipped";
  source: "evidence_report" | "qa_result" | "manual";
}

export interface TaskState {
  taskId: string;
  goal: string;
  currentPhase: TaskPhase;
  filesTouched: string[];
  evidenceHistory: EvidenceEntry[];
  status: TaskStatus;
  /** ISO timestamp when task was created */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
  /** Optional: path to the plan file */
  planPath?: string;
  /** Optional: final summary on completion */
  summary?: string;
}

// ─── TaskMemory ──────────────────────────────────────────────────────────────

export class TaskMemory extends EventEmitter {
  private readonly tasksDir: string;

  constructor(tasksDir?: string) {
    super();
    this.tasksDir = tasksDir ?? join(homedir(), ".yuan", "tasks");
    mkdirSync(this.tasksDir, { recursive: true });
  }

  /** Create or overwrite a task. Emits agent:task_memory_update. */
  create(taskId: string, goal: string): TaskState {
    const state: TaskState = {
      taskId,
      goal,
      currentPhase: "research",
      filesTouched: [],
      evidenceHistory: [],
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.save(state);
    this.emitUpdate(state);
    return state;
  }

  /** Load task state. Returns null if not found. */
  load(taskId: string): TaskState | null {
    try {
      const raw = readFileSync(this.taskPath(taskId), "utf-8");
      return JSON.parse(raw) as TaskState;
    } catch {
      return null;
    }
  }

  /** Transition to a new phase. */
  setPhase(taskId: string, phase: TaskPhase): TaskState | null {
    const state = this.load(taskId);
    if (!state) return null;
    state.currentPhase = phase;
    state.updatedAt = new Date().toISOString();
    this.save(state);
    this.emitUpdate(state);
    return state;
  }

  /** Mark task complete or failed. */
  finish(taskId: string, status: "completed" | "failed", summary?: string): TaskState | null {
    const state = this.load(taskId);
    if (!state) return null;
    state.status = status;
    state.summary = summary;
    state.updatedAt = new Date().toISOString();
    this.save(state);
    this.emitUpdate(state);
    return state;
  }

  /** Append an evidence entry to the task history. */
  appendEvidence(taskId: string, entry: EvidenceEntry): TaskState | null {
    const state = this.load(taskId);
    if (!state) return null;
    state.evidenceHistory.push(entry);
    // Cap history at 500 entries to prevent unbounded growth
    if (state.evidenceHistory.length > 500) {
      state.evidenceHistory = state.evidenceHistory.slice(-500);
    }
    if (!state.filesTouched.includes(entry.filePath)) {
      state.filesTouched.push(entry.filePath);
    }
    state.updatedAt = new Date().toISOString();
    this.save(state);
    return state;
  }

  /** List all tasks, sorted by updatedAt descending. */
  list(): TaskState[] {
    try {
      return readdirSync(this.tasksDir)
        .filter(f => f.endsWith(".json"))
        .map(f => {
          try {
            return JSON.parse(readFileSync(join(this.tasksDir, f), "utf-8")) as TaskState;
          } catch { return null; }
        })
        .filter((s): s is TaskState => s !== null)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  }

  /** Remove a task file. */
  delete(taskId: string): boolean {
    try {
      unlinkSync(this.taskPath(taskId));
      return true;
    } catch {
      return false;
    }
  }

  // ─── private ───────────────────────────────────────────────────────────────

  private taskPath(taskId: string): string {
    // Sanitize taskId to prevent path traversal
    const safe = taskId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
    return join(this.tasksDir, `${safe}.json`);
  }

  private save(state: TaskState): void {
    const path = this.taskPath(state.taskId);
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    renameSync(tmp, path);
  }

  private emitUpdate(state: TaskState): void {
    const event: AgentEvent = {
      kind: "agent:task_memory_update",
      taskId: state.taskId,
      phase: state.currentPhase,
      status: state.status,
      timestamp: Date.now(),
    };
    this.emit("event", event);
  }
}
