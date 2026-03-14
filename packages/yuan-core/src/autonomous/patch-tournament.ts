/**
 * @module autonomous/patch-tournament
 * @description Patch Tournament Executor — generates N candidate patches for a goal,
 * scores each with the QA pipeline, and selects the best.
 *
 * Design:
 * - Takes a "run agent" callback (injected from CLI — keeps this module pure)
 * - Runs candidates sequentially (not parallel) to avoid file conflicts
 * - Scores via QAPipeline + diff stats from evidence history
 * - Emits agent:tournament_result with winner index
 *
 * Constraints:
 * - Does NOT touch the main agent loop (deterministic)
 * - All scoring goes through QAPipeline (no bypass)
 * - Goes through OverheadGovernor (caller must check shouldRunTournament())
 * - Emits events at every candidate + final result
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { QAPipeline, type QAPipelineResult, type QAPipelineConfig } from "../qa-pipeline.js";
import type { AgentEvent } from "../types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CandidatePatch {
  /** 0-based index */
  index: number;
  /** Strategy hint passed to the agent run */
  strategy: string;
  /** Files changed by this candidate */
  filesChanged: string[];
  /** QA result */
  qaResult: QAPipelineResult | null;
  /** Composite score 0.0–1.0 (higher = better) */
  score: number;
  /** Human-readable explanation */
  reason: string;
}

export interface TournamentResult {
  taskId: string;
  goal: string;
  /** 0-based index of the winner */
  winner: number;
  candidates: CandidatePatch[];
  /** Quality score of winner */
  qualityScore: number;
  timestamp: number;
}

/**
 * Callback the CLI provides to run a single agent attempt.
 * Returns the list of files changed by this run.
 */
export type RunAgentCallback = (
  goal: string,
  strategy: string,
  candidateIndex: number,
) => Promise<string[]>;

export interface PatchTournamentConfig {
  /** Number of candidate patches to generate (default: 3) */
  candidates?: number;
  /** Strategies to use for each candidate (must match candidates count) */
  strategies?: string[];
  /** QA config for scoring */
  qaConfig?: Partial<QAPipelineConfig>;
  /** Project path for QA pipeline */
  projectPath?: string;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

function scoreQAResult(qa: QAPipelineResult | null): number {
  if (!qa) return 0;
  const base = qa.overall === "pass" ? 1.0 : qa.overall === "warn" ? 0.6 : 0.2;
  const passRatio = qa.totalChecks > 0 ? qa.passed / qa.totalChecks : 0;
  const failPenalty = qa.failures * 0.1;
  return Math.max(0, Math.min(1, base * passRatio - failPenalty));
}

// ─── PatchTournamentExecutor ─────────────────────────────────────────────────

export class PatchTournamentExecutor extends EventEmitter {
  private readonly config: Required<PatchTournamentConfig>;

  constructor(config: PatchTournamentConfig = {}) {
    super();
    const n = config.candidates ?? 3;
    this.config = {
      candidates: n,
      strategies: config.strategies ?? this.defaultStrategies(n),
      qaConfig: config.qaConfig ?? {},
      projectPath: config.projectPath ?? process.cwd(),
    };
  }

  /**
   * Run the tournament. For each candidate:
   * 1. Call runAgent() to generate a patch
   * 2. Score with QAPipeline
   * 3. Track best
   *
   * Returns TournamentResult with winner index.
   * Emits agent:tournament_result at completion.
   *
   * NOTE: The CLI is responsible for:
   * - Stashing current git state before the first candidate
   * - Restoring baseline between candidates (git stash pop + git stash)
   * - Applying the winner's patch after selection
   */
  async run(
    goal: string,
    runAgent: RunAgentCallback,
    taskId?: string,
  ): Promise<TournamentResult> {
    const resolvedTaskId = taskId ?? randomUUID();
    const timestamp = Date.now();
    const candidates: CandidatePatch[] = [];

    for (let i = 0; i < this.config.candidates; i++) {
      const strategy = this.config.strategies[i] ?? `strategy-${i}`;
      this.emitProgress(resolvedTaskId, i, "running", strategy);

      let filesChanged: string[] = [];
      let qaResult: QAPipelineResult | null = null;

      try {
        filesChanged = await runAgent(goal, strategy, i);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emitProgress(resolvedTaskId, i, "failed", `${strategy}: ${msg}`);
      }

      // Score with QA pipeline if files were changed
      if (filesChanged.length > 0) {
        try {
          const qa = new QAPipeline({
            projectPath: this.config.projectPath,
            level: "quick",
            ...this.config.qaConfig,
          });
          qaResult = await qa.run(filesChanged);
        } catch { /* QA failure is non-fatal */ }
      }

      const score = scoreQAResult(qaResult);
      const reason = this.describeScore(qaResult, score, filesChanged.length);

      candidates.push({ index: i, strategy, filesChanged, qaResult, score, reason });
      this.emitProgress(resolvedTaskId, i, "scored", reason);
    }

    // Select winner (highest score; tie-break by fewer files changed)
    let winner = 0;
    for (let i = 1; i < candidates.length; i++) {
      const curr = candidates[i];
      const best = candidates[winner];
      if (
        curr.score > best.score ||
        (curr.score === best.score && curr.filesChanged.length < best.filesChanged.length)
      ) {
        winner = i;
      }
    }

    const result: TournamentResult = {
      taskId: resolvedTaskId,
      goal,
      winner,
      candidates,
      qualityScore: candidates[winner]?.score ?? 0,
      timestamp,
    };

    this.emitResult(result);
    return result;
  }

  // ─── private ───────────────────────────────────────────────────────────────

  private defaultStrategies(n: number): string[] {
    const base = [
      "direct-fix",
      "minimal-change",
      "refactor-first",
      "test-driven",
      "defensive",
    ];
    return base.slice(0, n);
  }

  private describeScore(qa: QAPipelineResult | null, score: number, fileCount: number): string {
    if (!qa) return `no QA result (${fileCount} files)`;
    return `${qa.overall}: ${qa.passed}/${qa.totalChecks} checks, score=${score.toFixed(2)} (${fileCount} files)`;
  }

  private emitProgress(taskId: string, candidateIdx: number, state: string, detail: string): void {
    const event: AgentEvent = {
      kind: "agent:bg_update",
      agentId: `tournament-${taskId}`,
      agentLabel: `Tournament[${candidateIdx}]`,
      eventType: state === "failed" ? "warning" : "info",
      message: `candidate ${candidateIdx} ${state}: ${detail}`,
      timestamp: Date.now(),
    };
    this.emit("event", event);
  }

  private emitResult(result: TournamentResult): void {
    const event: AgentEvent = {
      kind: "agent:tournament_result",
      taskId: result.taskId,
      winner: result.winner,
      candidates: result.candidates.length,
      qualityScore: result.qualityScore,
      timestamp: result.timestamp,
    };
    this.emit("event", event);
  }
}
