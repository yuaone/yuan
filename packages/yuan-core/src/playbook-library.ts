/**
 * @module playbook-library
 * @description Strategy Library / Playbook — executable templates for task execution strategies.
 *
 * Storage: ~/.yuan/playbooks/{taskType}.json
 * Each playbook is versioned (version field incremented on update).
 *
 * Design:
 * - Playbooks are executable templates, not text summaries
 * - Task type classified by keyword matching from goal text + file types
 * - Retrieval returns the best matching playbook by confidence
 * - New playbooks can be proposed from trace data
 * - All writes atomic (.tmp + renameSync)
 */

import { EventEmitter } from "events";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

// ─── Types ───

export type PlaybookTaskType =
  | "ts-bugfix"
  | "refactor"
  | "feature-add"
  | "test-gen"
  | "security-fix"
  | "docs"
  | "migration"
  | "performance"
  | "unknown";

export interface Playbook {
  id: string;
  version: number;
  taskType: PlaybookTaskType;
  phaseOrder: string[];
  preferredTools: string[];
  cheapChecks: string[];
  escalationConditions: string[];
  evidenceRequirements: string[];
  stopConditions: string[];
  confidence: number;
  usageCount: number;
  successCount: number;
  sourceSessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PlaybookLibraryConfig {
  storageDir?: string;
}

// ─── Classifier ───

function classifyTaskType(goal: string): PlaybookTaskType {
  const g = goal.toLowerCase();
  if (/fix|bug|error|crash|fail/.test(g) && /ts|type|typescript/.test(g)) return "ts-bugfix";
  if (/fix|bug|error|crash|fail/.test(g)) return "ts-bugfix";
  if (/refactor|rename|reorganize|restructure|clean/.test(g)) return "refactor";
  if (/add|implement|create|build|feature|new/.test(g)) return "feature-add";
  if (/test|spec|coverage|jest|vitest/.test(g)) return "test-gen";
  if (/security|vuln|cve|inject|xss|csrf/.test(g)) return "security-fix";
  if (/doc|readme|comment|jsdoc/.test(g)) return "docs";
  if (/migrat|upgrade|version|convert/.test(g)) return "migration";
  if (/perf|optim|speed|slow|latency/.test(g)) return "performance";
  return "unknown";
}

// ─── Default playbooks ───

function buildDefaults(): Playbook[] {
  const now = new Date().toISOString();
  return [
    {
      id: randomUUID(),
      version: 1,
      taskType: "ts-bugfix",
      phaseOrder: ["research", "implement", "verify"],
      preferredTools: ["file_read", "grep", "file_edit", "shell_exec"],
      cheapChecks: ["tsc --noEmit"],
      escalationConditions: ["3+ failures", "risky file changed"],
      evidenceRequirements: ["build passes", "types compile"],
      stopConditions: ["build_success", "error_signature_disappears"],
      confidence: 0.6,
      usageCount: 0,
      successCount: 0,
      sourceSessionIds: [],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: randomUUID(),
      version: 1,
      taskType: "refactor",
      phaseOrder: ["research", "planning", "implement", "verify", "finalize"],
      preferredTools: ["file_read", "grep", "file_edit"],
      cheapChecks: ["tsc --noEmit", "eslint"],
      escalationConditions: ["impact > 10 files", "public API changed"],
      evidenceRequirements: ["build passes", "tests pass", "no regression"],
      stopConditions: ["tests_pass", "build_success"],
      confidence: 0.6,
      usageCount: 0,
      successCount: 0,
      sourceSessionIds: [],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: randomUUID(),
      version: 1,
      taskType: "feature-add",
      phaseOrder: ["research", "planning", "implement", "verify", "finalize"],
      preferredTools: ["file_read", "grep", "file_write", "file_edit", "shell_exec"],
      cheapChecks: ["tsc --noEmit", "eslint", "jest --testPathPattern"],
      escalationConditions: ["touching public API", "3+ failures"],
      evidenceRequirements: ["tests written", "build passes", "tests pass"],
      stopConditions: ["tests_pass", "build_success"],
      confidence: 0.5,
      usageCount: 0,
      successCount: 0,
      sourceSessionIds: [],
      createdAt: now,
      updatedAt: now,
    },
  ];
}

// ─── PlaybookLibrary ───

export class PlaybookLibrary extends EventEmitter {
  private storageDir: string;

  constructor(config?: PlaybookLibraryConfig) {
    super();
    this.storageDir =
      config?.storageDir ?? join(homedir(), ".yuan", "playbooks");
    mkdirSync(this.storageDir, { recursive: true });
    this.seedDefaults();
  }

  // ─── Seed defaults on first use ───

  private seedDefaults(): void {
    const files = readdirSync(this.storageDir).filter(f => f.endsWith(".json"));
    if (files.length === 0) {
      for (const pb of buildDefaults()) {
        this.saveRaw(pb);
      }
    }
  }

  // ─── Atomic write helper ───

  private saveRaw(playbook: Playbook): void {
    const filePath = join(this.storageDir, `${playbook.taskType}.json`);
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(playbook, null, 2), "utf-8");
    renameSync(tmpPath, filePath);
  }

  // ─── Load by taskType ───

  private load(taskType: PlaybookTaskType): Playbook | null {
    const filePath = join(this.storageDir, `${taskType}.json`);
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(readFileSync(filePath, "utf-8")) as Playbook;
    } catch {
      return null;
    }
  }

  // ─── Public API ───

  /**
   * Query for matching playbook by goal text.
   * Classifies task type via keyword matching, then loads matching playbook.
   * Returns null if no playbook found or confidence < 0.3.
   * Emits agent:playbook_activated when returning a match.
   */
  query(goal: string): Playbook | null {
    const taskType = classifyTaskType(goal);
    const playbook = this.load(taskType);
    if (!playbook || playbook.confidence < 0.3) return null;

    this.emit("agent:playbook_activated", {
      kind: "agent:playbook_activated",
      playbookId: playbook.id,
      taskType: playbook.taskType,
      confidence: playbook.confidence,
      timestamp: Date.now(),
    });

    return playbook;
  }

  /**
   * Record the outcome of a task run for a given task type.
   * Updates usageCount and successCount, recomputes confidence = successCount/usageCount.
   * Saves the updated playbook.
   */
  recordOutcome(taskType: PlaybookTaskType, success: boolean): void {
    const playbook = this.load(taskType);
    if (!playbook) return;

    playbook.usageCount += 1;
    if (success) playbook.successCount += 1;
    playbook.confidence = playbook.usageCount > 0
      ? playbook.successCount / playbook.usageCount
      : 0;
    playbook.version += 1;
    playbook.updatedAt = new Date().toISOString();

    this.saveRaw(playbook);
  }

  /**
   * Propose a new playbook draft from trace/run data.
   * Does NOT auto-save — returns a proposed Playbook for human review.
   * Emits agent:playbook_proposed.
   */
  propose(
    taskType: PlaybookTaskType,
    traceData: { toolSequence: string[]; phases: string[]; sessionId: string },
  ): Playbook {
    const now = new Date().toISOString();
    const playbook: Playbook = {
      id: randomUUID(),
      version: 1,
      taskType,
      phaseOrder: traceData.phases,
      preferredTools: traceData.toolSequence,
      cheapChecks: [],
      escalationConditions: [],
      evidenceRequirements: [],
      stopConditions: [],
      confidence: 0.3,
      usageCount: 0,
      successCount: 0,
      sourceSessionIds: [traceData.sessionId],
      createdAt: now,
      updatedAt: now,
    };

    this.emit("agent:playbook_proposed", {
      kind: "agent:playbook_proposed",
      playbookId: playbook.id,
      taskType: playbook.taskType,
      confidence: playbook.confidence,
      timestamp: Date.now(),
    });

    return playbook;
  }

  /**
   * Save a proposed playbook to disk (call after human approval or high confidence).
   */
  save(playbook: Playbook): void {
    playbook.updatedAt = new Date().toISOString();
    this.saveRaw(playbook);
  }

  /**
   * Get all playbooks sorted by confidence desc.
   */
  getAll(): Playbook[] {
    const results: Playbook[] = [];
    try {
      const files = readdirSync(this.storageDir).filter(f => f.endsWith(".json"));
      for (const file of files) {
        try {
          const pb = JSON.parse(
            readFileSync(join(this.storageDir, file), "utf-8"),
          ) as Playbook;
          results.push(pb);
        } catch {
          // skip corrupt files
        }
      }
    } catch {
      // storageDir unreadable
    }
    return results.sort((a, b) => b.confidence - a.confidence);
  }
}
