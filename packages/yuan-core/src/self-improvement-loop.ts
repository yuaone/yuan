/**
 * @module self-improvement-loop
 * @description Self-Improvement Loop — records strategy outcomes and produces
 * improvement PROPOSALS (never auto-applies policy changes).
 *
 * Storage: ~/.yuan/improvement-proposals/{projectHash}.json
 *
 * Safety: proposals are suggestions only. Human must approve before policy adoption.
 * Does NOT write to policy.json or governor config.
 */

import { EventEmitter } from "events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

export interface StrategyOutcome {
  id: string;
  taskType: string;            // e.g. "ts-bugfix", "refactor"
  strategy: string;            // e.g. "direct-fix", "test-first"
  toolSequence: string[];
  success: boolean;
  iterationsUsed: number;
  tokensUsed: number;
  durationMs: number;
  errorSignatures: string[];
  timestamp: string;
}

export interface ImprovementProposal {
  id: string;
  title: string;
  confidence: number;          // 0–1
  evidence: StrategyOutcome[]; // supporting outcomes
  affectedTaskTypes: string[];
  suggestion: string;          // human-readable recommendation
  proposedAt: string;
  status: "pending" | "accepted" | "rejected";
}

export interface SelfImprovementConfig {
  projectPath?: string;
  storageDir?: string;         // default ~/.yuan/improvement-proposals/
  minOutcomesForProposal?: number; // default 5
  minConfidence?: number;      // default 0.6
}

// ─── Helpers ───

function stableHash(projectPath: string): string {
  return Buffer.from(projectPath)
    .toString("base64")
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 8);
}

interface StorageData {
  outcomes: StrategyOutcome[];
  proposals: ImprovementProposal[];
}

// ─── Class ───

export class SelfImprovementLoop extends EventEmitter {
  private readonly storageFile: string;
  private readonly minOutcomesForProposal: number;
  private readonly minConfidence: number;
  private outcomes: StrategyOutcome[];
  private proposals: ImprovementProposal[];

  constructor(config: SelfImprovementConfig = {}) {
    super();
    const projectPath = config.projectPath ?? process.cwd();
    const storageDir = config.storageDir ?? join(homedir(), ".yuan", "improvement-proposals");
    this.minOutcomesForProposal = config.minOutcomesForProposal ?? 5;
    this.minConfidence = config.minConfidence ?? 0.6;

    const hash = stableHash(projectPath);
    this.storageFile = join(storageDir, `${hash}.json`);
    const loaded = this._load(storageDir);
    this.outcomes = loaded.outcomes;
    this.proposals = loaded.proposals;
  }

  // ─── Public API ───

  /** Record a strategy outcome after task completion. */
  recordOutcome(outcome: Omit<StrategyOutcome, "id" | "timestamp">): void {
    const full: StrategyOutcome = {
      ...outcome,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    };
    this.outcomes.push(full);
    this._save();
  }

  /**
   * Analyze recorded outcomes and generate improvement proposals.
   * Returns new proposals (does NOT auto-apply anything).
   * Emits agent:improvement_proposal for each new proposal.
   */
  generateProposals(): ImprovementProposal[] {
    // Group outcomes by taskType + strategy
    const groups = new Map<string, StrategyOutcome[]>();
    for (const o of this.outcomes) {
      const key = `${o.taskType}::${o.strategy}`;
      const arr = groups.get(key) ?? [];
      arr.push(o);
      groups.set(key, arr);
    }

    const newProposals: ImprovementProposal[] = [];
    const now = new Date().toISOString();

    for (const [key, group] of groups) {
      if (group.length < this.minOutcomesForProposal) continue;

      const successCount = group.filter((o) => o.success).length;
      const total = group.length;
      const confidence = successCount / total;

      if (confidence < this.minConfidence) continue;

      // Check if proposal already exists for this key
      const alreadyProposed = this.proposals.some(
        (p) =>
          p.affectedTaskTypes.includes(group[0]!.taskType) &&
          p.title.includes(group[0]!.strategy),
      );
      if (alreadyProposed) continue;

      const [taskType, strategy] = key.split("::");
      if (!taskType || !strategy) continue;

      const proposal: ImprovementProposal = {
        id: randomUUID(),
        title: `Prefer '${strategy}' for ${taskType} tasks`,
        confidence,
        evidence: group,
        affectedTaskTypes: [taskType],
        suggestion: `Strategy '${strategy}' succeeded ${successCount}/${total} times for '${taskType}'. Consider setting it as preferred in playbook.`,
        proposedAt: now,
        status: "pending",
      };

      this.proposals.push(proposal);
      newProposals.push(proposal);

      this.emit("agent:improvement_proposal", {
        kind: "agent:improvement_proposal",
        proposalId: proposal.id,
        title: proposal.title,
        confidence: proposal.confidence,
        affectedTaskTypes: proposal.affectedTaskTypes,
        timestamp: Date.now(),
      });
    }

    if (newProposals.length > 0) {
      this._save();
    }

    return newProposals;
  }

  /** Mark a proposal as accepted or rejected (human decision). */
  reviewProposal(proposalId: string, decision: "accepted" | "rejected"): void {
    const proposal = this.proposals.find((p) => p.id === proposalId);
    if (!proposal) return;
    proposal.status = decision;
    this._save();
  }

  /** Get all pending proposals. */
  getPendingProposals(): ImprovementProposal[] {
    return this.proposals.filter((p) => p.status === "pending");
  }

  /** Get all outcomes for a task type. */
  getOutcomes(taskType?: string): StrategyOutcome[] {
    if (!taskType) return [...this.outcomes];
    return this.outcomes.filter((o) => o.taskType === taskType);
  }

  // ─── Internal ───

  private _load(storageDir: string): StorageData {
    try {
      if (!existsSync(storageDir)) {
        mkdirSync(storageDir, { recursive: true });
      }
      if (!existsSync(this.storageFile)) return { outcomes: [], proposals: [] };
      const raw = readFileSync(this.storageFile, "utf8");
      return JSON.parse(raw) as StorageData;
    } catch {
      return { outcomes: [], proposals: [] };
    }
  }

  private _save(): void {
    const tmpFile = `${this.storageFile}.tmp`;
    try {
      const data: StorageData = { outcomes: this.outcomes, proposals: this.proposals };
      writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf8");
      renameSync(tmpFile, this.storageFile);
    } catch {
      // Non-fatal: storage failures should not crash the agent loop
    }
  }
}
