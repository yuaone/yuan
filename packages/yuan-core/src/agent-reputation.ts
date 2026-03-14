/**
 * @module agent-reputation
 * @description Agent Reputation / Trust Layer for role agents.
 * Tracks performance of specialized role agents and enables AgentCoordinator
 * to route tasks to the best-performing agent for each context.
 *
 * Storage: ~/.yuan/reputation/agent-reputation.json
 *
 * Wilson score lower bound (95% CI) is used as reputationScore for robustness
 * against small sample sizes.
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Types ───

export type RoleAgentType =
  | "planner"
  | "researcher"
  | "coder"
  | "reviewer"
  | "verifier"
  | "incident";

export interface AgentPerformanceRecord {
  agentType: RoleAgentType;
  taskType: string;         // e.g. "bugfix", "refactor", "feature"
  environment?: string;     // e.g. "typescript", "python"
  successes: number;
  failures: number;
  avgLatencyMs: number;
  avgTokenCost: number;
  /** Wilson score confidence interval lower bound — robust to small samples. 0..1 */
  reputationScore: number;
  lastUpdated: string;
}

export interface RoutingRecommendation {
  taskType: string;
  environment?: string;
  recommended: RoleAgentType;
  score: number;
  alternatives: Array<{ agentType: RoleAgentType; score: number }>;
  reason: string;
}

// ─── Storage key ───

interface StoredRecords {
  records: AgentPerformanceRecord[];
}

// ─── Helpers ───

const Z = 1.96; // 95% confidence interval

/**
 * Wilson score lower bound (confidence-correct success rate).
 * Falls back to 0.5 when n < 3 (insufficient data).
 */
function wilsonLowerBound(successes: number, failures: number): number {
  const n = successes + failures;
  if (n < 3) return 0.5;

  const p = successes / n;
  const z2 = Z * Z;
  const numerator = p + z2 / (2 * n) - Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const denominator = 1 + z2 / n;
  return Math.max(0, Math.min(1, numerator / denominator));
}

/**
 * Running average helper: update avg with a new value given prior count.
 */
function updatedAvg(currentAvg: number, currentCount: number, newValue: number): number {
  return (currentAvg * currentCount + newValue) / (currentCount + 1);
}

/**
 * Default agent routing when no performance data exists.
 */
function defaultAgent(taskType: string): RoleAgentType {
  const lower = taskType.toLowerCase();
  if (lower === "bugfix" || lower === "feature" || lower === "refactor") return "coder";
  if (lower === "research" || lower === "analysis") return "researcher";
  if (lower === "review" || lower === "qa") return "reviewer";
  if (lower === "incident" || lower === "debug") return "incident";
  if (lower === "plan" || lower === "design") return "planner";
  return "coder";
}

const ALL_AGENT_TYPES: RoleAgentType[] = [
  "planner",
  "researcher",
  "coder",
  "reviewer",
  "verifier",
  "incident",
];

// ─── Class ───

export class AgentReputation extends EventEmitter {
  private readonly storageFile: string;
  private records: AgentPerformanceRecord[];

  constructor(storageDir?: string) {
    super();
    const dir = storageDir ?? join(homedir(), ".yuan", "reputation");
    this.storageFile = join(dir, "agent-reputation.json");
    this.records = this._load(dir);
  }

  // ─── Public API ───

  /**
   * Record a task outcome for a role agent.
   * Updates avgLatencyMs, avgTokenCost, and reputationScore (Wilson lower bound).
   */
  record(
    agentType: RoleAgentType,
    taskType: string,
    outcome: {
      success: boolean;
      latencyMs: number;
      tokenCost: number;
      environment?: string;
    }
  ): void {
    const now = new Date().toISOString();
    const key = this._key(agentType, taskType, outcome.environment);
    let existing = this.records.find((r) => this._keyOf(r) === key);

    if (!existing) {
      existing = {
        agentType,
        taskType,
        environment: outcome.environment,
        successes: 0,
        failures: 0,
        avgLatencyMs: 0,
        avgTokenCost: 0,
        reputationScore: 0.5,
        lastUpdated: now,
      };
      this.records.push(existing);
    }

    const prevCount = existing.successes + existing.failures;

    // Update running averages
    existing.avgLatencyMs = updatedAvg(existing.avgLatencyMs, prevCount, outcome.latencyMs);
    existing.avgTokenCost = updatedAvg(existing.avgTokenCost, prevCount, outcome.tokenCost);

    if (outcome.success) {
      existing.successes += 1;
    } else {
      existing.failures += 1;
    }

    existing.reputationScore = wilsonLowerBound(existing.successes, existing.failures);
    existing.lastUpdated = now;

    this._save();

    this.emit("agent:reputation_updated", {
      kind: "agent:reputation_updated",
      agentType,
      taskType,
      reputationScore: existing.reputationScore,
      successes: existing.successes,
      failures: existing.failures,
      timestamp: Date.now(),
    });
  }

  /**
   * Get routing recommendation for a task type (and optional environment).
   * Sorts candidates by Wilson score. Falls back to default routing if no data.
   */
  recommend(taskType: string, environment?: string): RoutingRecommendation {
    // Collect records matching taskType (exact match, env-aware)
    const candidates = this.records.filter(
      (r) =>
        r.taskType === taskType &&
        (environment === undefined || r.environment === environment || r.environment === undefined)
    );

    if (candidates.length === 0) {
      // No data — use default routing
      const recommended = defaultAgent(taskType);
      return {
        taskType,
        environment,
        recommended,
        score: 0.5,
        alternatives: ALL_AGENT_TYPES.filter((t) => t !== recommended).map((agentType) => ({
          agentType,
          score: 0.5,
        })),
        reason: `No performance data for task "${taskType}". Using default routing.`,
      };
    }

    // Aggregate by agentType (pick best record per agent if multiple envs match)
    const agentBestScore = new Map<RoleAgentType, number>();
    for (const c of candidates) {
      const current = agentBestScore.get(c.agentType) ?? -1;
      if (c.reputationScore > current) {
        agentBestScore.set(c.agentType, c.reputationScore);
      }
    }

    // Sort descending by score
    const sorted = Array.from(agentBestScore.entries()).sort((a, b) => b[1] - a[1]);

    const [topAgent, topScore] = sorted[0];
    const alternatives = sorted.slice(1).map(([agentType, score]) => ({ agentType, score }));

    const total = candidates.reduce((s, r) => s + r.successes + r.failures, 0);

    return {
      taskType,
      environment,
      recommended: topAgent,
      score: topScore,
      alternatives,
      reason: `Based on ${total} recorded tasks. ${topAgent} leads with Wilson score ${topScore.toFixed(3)}.`,
    };
  }

  /**
   * Get all performance records for a given agent type.
   */
  getRecords(agentType: RoleAgentType): AgentPerformanceRecord[] {
    return this.records.filter((r) => r.agentType === agentType);
  }

  /**
   * Get a summary of average reputation scores and total task counts per agent type.
   */
  getSummary(): Record<RoleAgentType, { avgScore: number; totalTasks: number }> {
    const result = {} as Record<RoleAgentType, { avgScore: number; totalTasks: number }>;

    for (const agentType of ALL_AGENT_TYPES) {
      const recs = this.records.filter((r) => r.agentType === agentType);
      if (recs.length === 0) {
        result[agentType] = { avgScore: 0.5, totalTasks: 0 };
      } else {
        const totalTasks = recs.reduce((s, r) => s + r.successes + r.failures, 0);
        const avgScore = recs.reduce((s, r) => s + r.reputationScore, 0) / recs.length;
        result[agentType] = { avgScore, totalTasks };
      }
    }

    return result;
  }

  // ─── Internal ───

  private _key(agentType: RoleAgentType, taskType: string, environment?: string): string {
    return `${agentType}::${taskType}::${environment ?? ""}`;
  }

  private _keyOf(record: AgentPerformanceRecord): string {
    return this._key(record.agentType, record.taskType, record.environment);
  }

  private _load(storageDir: string): AgentPerformanceRecord[] {
    try {
      if (!existsSync(storageDir)) {
        mkdirSync(storageDir, { recursive: true });
      }
      if (!existsSync(this.storageFile)) return [];
      const raw = readFileSync(this.storageFile, "utf8");
      const parsed = JSON.parse(raw) as StoredRecords;
      return Array.isArray(parsed.records) ? parsed.records : [];
    } catch {
      return [];
    }
  }

  private _save(): void {
    const tmpFile = `${this.storageFile}.tmp`;
    try {
      const data: StoredRecords = { records: this.records };
      writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf8");
      renameSync(tmpFile, this.storageFile);
    } catch {
      // Non-fatal: storage failures should not crash the agent loop
    }
  }
}
