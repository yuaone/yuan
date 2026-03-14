/**
 * @module strategy-market
 * @description Competitive playbook ecosystem — multiple playbooks compete per task type.
 * Champion is tracked per task type. Low-performing playbooks are retired.
 * New challenger playbooks can enter.
 *
 * Storage: ~/.yuan/strategy/market-state.json
 * Atomic writes (.tmp → renameSync).
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Types ───

export interface PlaybookContender {
  playbookId: string;
  taskType: string;
  wins: number;
  losses: number;
  draws: number;
  avgTokenCost: number;    // average tokens used
  avgLatencyMs: number;    // average time to complete
  retirementScore: number; // 0..1 — higher = closer to retirement
  isChampion: boolean;
  isRetired: boolean;
  addedAt: string;
  lastCompetedAt?: string;
}

export interface MarketResult {
  taskType: string;
  champion: PlaybookContender | null;
  contenders: PlaybookContender[];
  recentlyRetired: string[]; // playbookIds retired this session
}

// ─── Internal state shape stored to disk ───

interface MarketState {
  contenders: PlaybookContender[];
}

// ─── Score helper ───

function scoreContender(c: PlaybookContender): number {
  const winRate = c.wins / (c.wins + c.losses + 1);
  const tokenPenalty = (c.avgTokenCost / 100_000) * 0.2;
  const latencyPenalty = (c.avgLatencyMs / 60_000) * 0.2;
  return winRate * 0.6 - tokenPenalty - latencyPenalty;
}

function computeRetirementScore(wins: number, losses: number): number {
  return losses / (wins + losses + 1);
}

// ─── StrategyMarket ───

export class StrategyMarket extends EventEmitter {
  private readonly storageDir: string;
  private readonly storageFile: string;
  private state: MarketState;

  constructor(storageDir?: string) {
    super();
    this.storageDir = storageDir ?? join(homedir(), ".yuan", "strategy");
    this.storageFile = join(this.storageDir, "market-state.json");
    this.state = this._load();
  }

  // ─── Public API ───

  /**
   * Register a playbook as a contender for a task type.
   * No-op if already registered (non-retired) for that taskType.
   */
  register(playbookId: string, taskType: string): void {
    const existing = this.state.contenders.find(
      (c) => c.playbookId === playbookId && c.taskType === taskType,
    );
    if (existing) return; // already registered

    const now = new Date().toISOString();
    const contender: PlaybookContender = {
      playbookId,
      taskType,
      wins: 0,
      losses: 0,
      draws: 0,
      avgTokenCost: 0,
      avgLatencyMs: 0,
      retirementScore: 0,
      isChampion: false,
      isRetired: false,
      addedAt: now,
    };
    this.state.contenders.push(contender);
    this._save();
  }

  /**
   * Record a competition result after a task run.
   * Updates win/loss/draw, running averages, and retirementScore.
   * Auto-retires if threshold met.
   */
  recordResult(
    playbookId: string,
    taskType: string,
    outcome: { success: boolean; tokenCost: number; latencyMs: number },
  ): void {
    const contender = this._findActive(playbookId, taskType);
    if (!contender) return;

    const total = contender.wins + contender.losses + contender.draws;
    const n = total + 1;

    // Update running averages
    contender.avgTokenCost = (contender.avgTokenCost * total + outcome.tokenCost) / n;
    contender.avgLatencyMs = (contender.avgLatencyMs * total + outcome.latencyMs) / n;

    // Update win/loss
    if (outcome.success) {
      contender.wins += 1;
    } else {
      contender.losses += 1;
    }

    contender.retirementScore = computeRetirementScore(contender.wins, contender.losses);
    contender.lastCompetedAt = new Date().toISOString();

    // Check retirement threshold: retirementScore >= 0.75 AND (wins+losses) >= 5
    const competed = contender.wins + contender.losses;
    if (contender.retirementScore >= 0.75 && competed >= 5) {
      contender.isRetired = true;
      contender.isChampion = false;
      this.emit("agent:playbook_retired", {
        kind: "agent:playbook_retired",
        taskType,
        playbookId,
        retirementScore: contender.retirementScore,
        timestamp: Date.now(),
      });
    }

    this._save();
  }

  /**
   * Get the current champion for a task type.
   */
  getChampion(taskType: string): PlaybookContender | null {
    return (
      this.state.contenders.find(
        (c) => c.taskType === taskType && c.isChampion && !c.isRetired,
      ) ?? null
    );
  }

  /**
   * Run competition: compare all non-retired contenders for a task type,
   * elect a new champion by score.
   * Emits agent:champion_elected if champion changed.
   */
  compete(taskType: string): MarketResult {
    const active = this.state.contenders.filter(
      (c) => c.taskType === taskType && !c.isRetired,
    );

    const recentlyRetired: string[] = [];

    if (active.length === 0) {
      return { taskType, champion: null, contenders: [], recentlyRetired };
    }

    // Score and sort
    const scored = active
      .map((c) => ({ contender: c, score: scoreContender(c) }))
      .sort((a, b) => b.score - a.score);

    const topEntry = scored[0];
    const newChampionId = topEntry.contender.playbookId;
    const oldChampion = this.getChampion(taskType);
    const championChanged = oldChampion?.playbookId !== newChampionId;

    // Reset all champions for this taskType, then set new one
    for (const c of active) {
      c.isChampion = c.playbookId === newChampionId;
    }

    if (championChanged) {
      this.emit("agent:champion_elected", {
        kind: "agent:champion_elected",
        taskType,
        playbookId: newChampionId,
        score: topEntry.score,
        timestamp: Date.now(),
      });
    }

    this._save();

    return {
      taskType,
      champion: topEntry.contender,
      contenders: active,
      recentlyRetired,
    };
  }

  /**
   * Get all non-retired contenders for a task type.
   */
  getContenders(taskType: string): PlaybookContender[] {
    return this.state.contenders.filter(
      (c) => c.taskType === taskType && !c.isRetired,
    );
  }

  /**
   * Get a summary of the market across all task types.
   */
  getMarketStatus(): Record<string, MarketResult> {
    const taskTypes = [
      ...new Set(this.state.contenders.map((c) => c.taskType)),
    ];

    const result: Record<string, MarketResult> = {};
    for (const taskType of taskTypes) {
      const active = this.getContenders(taskType);
      const champion = this.getChampion(taskType);
      result[taskType] = {
        taskType,
        champion,
        contenders: active,
        recentlyRetired: [],
      };
    }
    return result;
  }

  // ─── Internal ───

  private _findActive(
    playbookId: string,
    taskType: string,
  ): PlaybookContender | undefined {
    return this.state.contenders.find(
      (c) => c.playbookId === playbookId && c.taskType === taskType && !c.isRetired,
    );
  }

  private _load(): MarketState {
    try {
      if (!existsSync(this.storageDir)) {
        mkdirSync(this.storageDir, { recursive: true });
      }
      if (!existsSync(this.storageFile)) return { contenders: [] };
      const raw = readFileSync(this.storageFile, "utf-8");
      return JSON.parse(raw) as MarketState;
    } catch {
      return { contenders: [] };
    }
  }

  private _save(): void {
    const tmpFile = `${this.storageFile}.tmp`;
    try {
      writeFileSync(tmpFile, JSON.stringify(this.state, null, 2), "utf-8");
      renameSync(tmpFile, this.storageFile);
    } catch {
      // Non-fatal: storage failures should not crash the agent loop
    }
  }
}
