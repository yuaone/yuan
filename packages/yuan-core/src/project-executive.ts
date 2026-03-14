/**
 * @module project-executive
 * @description Long-Horizon Project Executive — manages project-level goals, milestones,
 * stalled task detection, and resume points.
 *
 * Storage: ~/.yuan/projects/{projectId}/executive.json
 * projectId = stable 8-char hash of projectPath
 *
 * Design:
 * - Event-driven observer ONLY — does NOT mutate agent-loop state
 * - Reads from TaskMemory but does not write to it
 * - All persistence is atomic (.tmp + renameSync)
 * - Emits structured events for all state transitions
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type GoalStatus = "active" | "completed" | "abandoned";
export type GoalStrategy =
  | "bugfix"
  | "refactor"
  | "migration"
  | "feature"
  | "investigation";

export interface ProjectGoal {
  id: string;
  description: string;
  strategy: GoalStrategy;
  status: GoalStatus;
  childTaskIds: string[];
  estimatedIterations: number;
  createdAt: string;
  completedAt?: string;
}

export interface ProjectMilestone {
  id: string;
  description: string;
  goalId: string;
  targetIteration: number;
  status: "pending" | "reached" | "missed";
  reachedAt?: string;
}

export interface StalledTask {
  taskId: string;
  stallReason:
    | "iteration_overrun"
    | "repeated_errors"
    | "no_progress"
    | "patch_entropy";
  detectedAt: string;
  iterationsElapsed: number;
  estimatedIterations: number;
}

export interface ResumePoint {
  taskId: string;
  sessionId: string;
  checkpointPath: string;
  savedAt: string;
}

export interface ProjectExecutiveState {
  projectId: string;
  projectPath: string;
  goals: ProjectGoal[];
  milestones: ProjectMilestone[];
  activeTasks: string[];
  stalledTasks: StalledTask[];
  resumePoints: ResumePoint[];
  updatedAt: string;
}

export interface ProjectExecutiveConfig {
  /** defaults to ~/.yuan/projects/ */
  storageDir?: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeProjectId(projectPath: string): string {
  return Buffer.from(projectPath)
    .toString("base64")
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 8);
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function atomicWrite(filePath: string, data: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, filePath);
}

function emptyState(projectId: string, projectPath: string): ProjectExecutiveState {
  return {
    projectId,
    projectPath,
    goals: [],
    milestones: [],
    activeTasks: [],
    stalledTasks: [],
    resumePoints: [],
    updatedAt: new Date().toISOString(),
  };
}

// ─── ProjectExecutive ──────────────────────────────────────────────────────

export class ProjectExecutive extends EventEmitter {
  private state: ProjectExecutiveState;
  private storagePath: string;

  constructor(projectPath: string, config?: ProjectExecutiveConfig) {
    super();

    const projectId = makeProjectId(projectPath);
    const storageDir =
      config?.storageDir ?? join(homedir(), ".yuan", "projects");
    this.storagePath = join(storageDir, projectId, "executive.json");

    // Load existing state or create empty
    if (existsSync(this.storagePath)) {
      try {
        const raw = readFileSync(this.storagePath, "utf8");
        this.state = JSON.parse(raw) as ProjectExecutiveState;
      } catch {
        this.state = emptyState(projectId, projectPath);
      }
    } else {
      this.state = emptyState(projectId, projectPath);
    }
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  private persist(): void {
    this.state.updatedAt = new Date().toISOString();
    atomicWrite(this.storagePath, JSON.stringify(this.state, null, 2));
  }

  private emitStateUpdate(): void {
    this.emit("event", {
      kind: "agent:project_state_update",
      projectId: this.state.projectId,
      goals: this.state.goals.length,
      activeTasks: this.state.activeTasks.length,
      stalledTasks: this.state.stalledTasks.length,
      timestamp: Date.now(),
    });
  }

  // ── Goals ─────────────────────────────────────────────────────────────────

  /**
   * Add a new goal. Returns the created goal. Emits agent:project_state_update.
   */
  addGoal(
    description: string,
    strategy: GoalStrategy,
    estimatedIterations: number = 20
  ): ProjectGoal {
    const goal: ProjectGoal = {
      id: makeId(),
      description,
      strategy,
      status: "active",
      childTaskIds: [],
      estimatedIterations,
      createdAt: new Date().toISOString(),
    };
    this.state.goals.push(goal);
    this.persist();
    this.emitStateUpdate();
    return goal;
  }

  /**
   * Mark a goal as completed or abandoned. Emits agent:project_state_update.
   */
  completeGoal(goalId: string, status: "completed" | "abandoned"): void {
    const goal = this.state.goals.find((g) => g.id === goalId);
    if (!goal) return;
    goal.status = status;
    goal.completedAt = new Date().toISOString();
    this.persist();
    this.emitStateUpdate();
  }

  // ── Milestones ────────────────────────────────────────────────────────────

  /** Add a milestone to a goal. */
  addMilestone(
    goalId: string,
    description: string,
    targetIteration: number
  ): ProjectMilestone {
    const milestone: ProjectMilestone = {
      id: makeId(),
      description,
      goalId,
      targetIteration,
      status: "pending",
    };
    this.state.milestones.push(milestone);
    this.persist();
    return milestone;
  }

  /**
   * Check and possibly mark a milestone as reached.
   * Emits agent:milestone_reached if reached.
   */
  checkMilestone(milestoneId: string, currentIteration: number): boolean {
    const ms = this.state.milestones.find((m) => m.id === milestoneId);
    if (!ms || ms.status !== "pending") return false;

    if (currentIteration >= ms.targetIteration) {
      ms.status = "reached";
      ms.reachedAt = new Date().toISOString();
      this.persist();
      this.emit("event", {
        kind: "agent:milestone_reached",
        milestoneId: ms.id,
        goalId: ms.goalId,
        description: ms.description,
        timestamp: Date.now(),
      });
      return true;
    }
    return false;
  }

  // ── Stall Tracking ────────────────────────────────────────────────────────

  /** Register a stalled task. Emits agent:task_stalled. */
  recordStall(
    taskId: string,
    reason: StalledTask["stallReason"],
    iterationsElapsed: number,
    estimatedIterations: number
  ): void {
    // Avoid duplicates
    const existing = this.state.stalledTasks.find((s) => s.taskId === taskId);
    if (existing) {
      existing.stallReason = reason;
      existing.detectedAt = new Date().toISOString();
      existing.iterationsElapsed = iterationsElapsed;
      existing.estimatedIterations = estimatedIterations;
    } else {
      this.state.stalledTasks.push({
        taskId,
        stallReason: reason,
        detectedAt: new Date().toISOString(),
        iterationsElapsed,
        estimatedIterations,
      });
    }
    this.persist();
    this.emit("event", {
      kind: "agent:task_stalled",
      taskId,
      stallReason: reason,
      iterationsElapsed,
      estimatedIterations,
      timestamp: Date.now(),
    });
  }

  /** Clear a stall (task resumed or resolved). */
  clearStall(taskId: string): void {
    this.state.stalledTasks = this.state.stalledTasks.filter(
      (s) => s.taskId !== taskId
    );
    this.persist();
  }

  // ── Resume Points ─────────────────────────────────────────────────────────

  /** Save a resume point for a task. */
  addResumePoint(
    taskId: string,
    sessionId: string,
    checkpointPath: string
  ): void {
    // Replace existing resume point for same taskId
    this.state.resumePoints = this.state.resumePoints.filter(
      (r) => r.taskId !== taskId
    );
    this.state.resumePoints.push({
      taskId,
      sessionId,
      checkpointPath,
      savedAt: new Date().toISOString(),
    });
    this.persist();
  }

  // ── Active Task Tracking ──────────────────────────────────────────────────

  /** Mark a task as active. */
  activateTask(taskId: string): void {
    if (!this.state.activeTasks.includes(taskId)) {
      this.state.activeTasks.push(taskId);
      this.persist();
    }
  }

  /** Mark a task as no longer active. */
  deactivateTask(taskId: string): void {
    this.state.activeTasks = this.state.activeTasks.filter(
      (id) => id !== taskId
    );
    this.persist();
  }

  // ── State Access ──────────────────────────────────────────────────────────

  /** Get current state snapshot. */
  getState(): ProjectExecutiveState {
    return JSON.parse(JSON.stringify(this.state)) as ProjectExecutiveState;
  }
}
