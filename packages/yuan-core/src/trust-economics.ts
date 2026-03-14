/**
 * @module trust-economics
 * @description Trust/Approval Economics — tracks trust scores per action class.
 * Produces trust RECOMMENDATIONS but never auto-relaxes approval thresholds.
 *
 * Storage: ~/.yuan/trust-scores/{projectHash}.json
 *
 * Safety: Trust scores are informational only. ApprovalManager thresholds
 * are NOT modified automatically. No action class is ever auto-approved.
 */

import { EventEmitter } from "events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type ActionClass =
  | "file_read"
  | "file_write"
  | "file_edit"
  | "file_delete"
  | "shell_exec_safe"    // read-only shell: ls, cat, grep
  | "shell_exec_risky"   // write/install/network shell
  | "git_read"
  | "git_write"
  | "network_fetch"
  | "mcp_call";

export interface TrustRecord {
  actionClass: ActionClass;
  successCount: number;
  failCount: number;
  lastSuccess: string | null;
  lastFail: string | null;
  /** Never decremented below 0. A single high-risk failure resets to 0. */
  trustScore: number;          // 0–1
}

export interface TrustRecommendation {
  actionClass: ActionClass;
  currentTrustScore: number;
  recommendation: "auto_approve_candidate" | "require_review" | "require_explicit_approval";
  reasoning: string;
}

export interface TrustEconomicsConfig {
  projectPath?: string;
  storageDir?: string;    // default ~/.yuan/trust-scores/
}

// ─── Helpers ───

function stableHash(projectPath: string): string {
  return Buffer.from(projectPath)
    .toString("base64")
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 8);
}

function makeRecommendation(record: TrustRecord): TrustRecommendation["recommendation"] {
  if (record.trustScore >= 0.85 && record.successCount >= 20) {
    return "auto_approve_candidate";
  }
  if (record.trustScore >= 0.5) {
    return "require_review";
  }
  return "require_explicit_approval";
}

function makeReasoning(record: TrustRecord, rec: TrustRecommendation["recommendation"]): string {
  const total = record.successCount + record.failCount;
  if (rec === "auto_approve_candidate") {
    return `Trust score ${record.trustScore.toFixed(2)} with ${record.successCount} successes qualifies as auto-approve candidate (informational only — thresholds not modified).`;
  }
  if (rec === "require_review") {
    return `Trust score ${record.trustScore.toFixed(2)} (${record.successCount}/${total} success) — review required before proceeding.`;
  }
  return `Trust score ${record.trustScore.toFixed(2)} (${record.successCount}/${total} success) — explicit approval required.`;
}

// ─── Class ───

export class TrustEconomics extends EventEmitter {
  private readonly storageFile: string;
  private records: Map<ActionClass, TrustRecord>;

  constructor(config: TrustEconomicsConfig = {}) {
    super();
    const projectPath = config.projectPath ?? process.cwd();
    const storageDir = config.storageDir ?? join(homedir(), ".yuan", "trust-scores");

    const hash = stableHash(projectPath);
    this.storageFile = join(storageDir, `${hash}.json`);
    this.records = this._load(storageDir);
  }

  // ─── Public API ───

  /** Record an action outcome. High-risk failure resets trust to 0. */
  record(actionClass: ActionClass, success: boolean, isHighRisk = false): void {
    const now = new Date().toISOString();
    const existing = this.records.get(actionClass) ?? {
      actionClass,
      successCount: 0,
      failCount: 0,
      lastSuccess: null,
      lastFail: null,
      trustScore: 0.5, // start neutral
    };

    if (success) {
      existing.successCount += 1;
      existing.lastSuccess = now;
      existing.trustScore = Math.min(existing.trustScore + 0.05, 1.0);
    } else {
      existing.failCount += 1;
      existing.lastFail = now;
      if (isHighRisk) {
        existing.trustScore = 0;
      } else {
        existing.trustScore = Math.max(existing.trustScore - 0.1, 0);
      }
    }

    this.records.set(actionClass, existing);
    this._save();

    const rec = makeRecommendation(existing);
    this.emit("agent:trust_update", {
      kind: "agent:trust_update",
      actionClass,
      trustScore: existing.trustScore,
      recommendation: rec,
      timestamp: Date.now(),
    });
  }

  /**
   * Get trust recommendations (read-only, never modifies approval thresholds).
   * Emits agent:trust_update.
   */
  getRecommendations(): TrustRecommendation[] {
    const result: TrustRecommendation[] = [];
    for (const record of this.records.values()) {
      const rec = makeRecommendation(record);
      result.push({
        actionClass: record.actionClass,
        currentTrustScore: record.trustScore,
        recommendation: rec,
        reasoning: makeReasoning(record, rec),
      });
    }
    return result;
  }

  /** Get trust record for a specific action class. */
  getTrust(actionClass: ActionClass): TrustRecord | null {
    return this.records.get(actionClass) ?? null;
  }

  /** Get all trust records. */
  getAll(): TrustRecord[] {
    return Array.from(this.records.values());
  }

  // ─── Internal ───

  private _load(storageDir: string): Map<ActionClass, TrustRecord> {
    try {
      if (!existsSync(storageDir)) {
        mkdirSync(storageDir, { recursive: true });
      }
      if (!existsSync(this.storageFile)) return new Map();
      const raw = readFileSync(this.storageFile, "utf8");
      const arr = JSON.parse(raw) as TrustRecord[];
      const map = new Map<ActionClass, TrustRecord>();
      for (const rec of arr) {
        map.set(rec.actionClass, rec);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  private _save(): void {
    const tmpFile = `${this.storageFile}.tmp`;
    try {
      const arr = Array.from(this.records.values());
      writeFileSync(tmpFile, JSON.stringify(arr, null, 2), "utf8");
      renameSync(tmpFile, this.storageFile);
    } catch {
      // Non-fatal: storage failures should not crash the agent loop
    }
  }
}
