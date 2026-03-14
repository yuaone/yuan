/**
 * @module trace-pattern-extractor
 * @description Reads TraceRecorder JSONL files from ~/.yuan/traces/, detects repeated
 * successful tool sequences, and produces Playbook proposals.
 *
 * Pattern detection rules:
 * - A sequence = ordered list of tool names from tool_call events in a session
 * - A pattern is a contiguous sub-sequence of 3..8 tools
 * - Significant if: appears in 3+ distinct sessions AND success rate >= 60%
 *   AND not already proposed (tracked by patternHash)
 *
 * Storage: ~/.yuan/proposals/playbook-proposals.json — array of PlaybookProposal, atomic write
 * Events: emits on single "event" channel like all other modules
 */

import { createHash, randomUUID } from "crypto";
import { EventEmitter } from "events";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";

// ─── Types ───

export interface PlaybookProposal {
  id: string;
  taskType: string;
  toolSequence: string[];
  patternHash: string;
  sessionCount: number;
  successRate: number;
  sourceSessionIds: string[];
  proposedAt: string; // ISO
}

interface TraceEvent {
  kind: "session_start" | "tool_call" | "tool_result" | "session_end";
  sessionId: string;
  goal?: string;
  tool?: string;
  args?: unknown;
  success?: boolean;
  iterations?: number;
  timestamp: number | string;
}

interface SessionData {
  sessionId: string;
  goal: string;
  toolCalls: string[];
  success: boolean;
  ended: boolean;
}

export interface TracePatternExtractorConfig {
  tracesDir?: string;
  storageDir?: string;
  minSessions?: number;
  minSuccessRate?: number;
}

// ─── Helpers ───

/**
 * Infer task type from goal text using keyword matching.
 * Mirrors PlaybookLibrary's classifier for consistency.
 */
function inferTaskType(goal: string): string {
  const g = goal.toLowerCase();
  if (/fix|bug|error|crash|fail/.test(g)) return "ts-bugfix";
  if (/refactor|rename|reorganize|restructure|clean/.test(g)) return "refactor";
  if (/add|implement|create|build|feature|new/.test(g)) return "feature-add";
  if (/test|spec|coverage|jest|vitest/.test(g)) return "test-gen";
  if (/security|vuln|cve|inject|xss|csrf/.test(g)) return "security-fix";
  if (/doc|readme|comment|jsdoc/.test(g)) return "docs";
  if (/migrat|upgrade|version|convert/.test(g)) return "migration";
  if (/perf|optim|speed|slow|latency/.test(g)) return "performance";
  return "general";
}

/**
 * Compute a short SHA-256 hash of the tool sequence for deduplication.
 */
function hashSequence(seq: string[]): string {
  return createHash("sha256")
    .update(seq.join(","))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Extract all contiguous sub-sequences of length minLen..maxLen from an array.
 */
function subSequences(
  arr: string[],
  minLen: number,
  maxLen: number,
): string[][] {
  const results: string[][] = [];
  for (let start = 0; start < arr.length; start++) {
    for (let len = minLen; len <= maxLen && start + len <= arr.length; len++) {
      results.push(arr.slice(start, start + len));
    }
  }
  return results;
}

// ─── TracePatternExtractor ───

export class TracePatternExtractor extends EventEmitter {
  private readonly tracesDir: string;
  private readonly storageDir: string;
  private readonly storageFile: string;
  private readonly minSessions: number;
  private readonly minSuccessRate: number;

  /** patternHashes of proposals already produced — prevents re-proposing */
  private readonly proposedPatterns: Set<string>;
  /** proposalIds marked as applied — excluded from getProposals() */
  private readonly appliedProposals: Set<string>;

  private proposals: PlaybookProposal[];

  constructor(config?: TracePatternExtractorConfig) {
    super();
    this.tracesDir =
      config?.tracesDir ?? join(homedir(), ".yuan", "traces");
    this.storageDir =
      config?.storageDir ?? join(homedir(), ".yuan", "proposals");
    this.storageFile = join(this.storageDir, "playbook-proposals.json");
    this.minSessions = config?.minSessions ?? 3;
    this.minSuccessRate = config?.minSuccessRate ?? 0.6;

    this.proposedPatterns = new Set();
    this.appliedProposals = new Set();
    this.proposals = this._loadProposals();

    // Seed proposedPatterns from already-stored proposals
    for (const p of this.proposals) {
      this.proposedPatterns.add(p.patternHash);
    }

    mkdirSync(this.storageDir, { recursive: true });
  }

  // ─── Public API ───

  /**
   * Main: scan all JSONL files in tracesDir, extract significant patterns,
   * persist and return newly discovered proposals.
   */
  async extract(): Promise<PlaybookProposal[]> {
    const sessions = this._parseSessions();
    if (sessions.size === 0) return [];

    // Build sub-sequence frequency maps
    // Map<patternHash, { seq, sessions: Set<sessionId>, successCount }>
    const patternMap = new Map<
      string,
      { seq: string[]; sessions: Set<string>; successCount: number }
    >();

    for (const [sessionId, data] of sessions.entries()) {
      if (!data.ended) continue; // skip incomplete sessions

      const subSeqs = subSequences(data.toolCalls, 3, 8);
      const seenInSession = new Set<string>();

      for (const seq of subSeqs) {
        const hash = hashSequence(seq);

        // Count each pattern at most once per session
        if (seenInSession.has(hash)) continue;
        seenInSession.add(hash);

        if (!patternMap.has(hash)) {
          patternMap.set(hash, { seq, sessions: new Set(), successCount: 0 });
        }
        const entry = patternMap.get(hash)!;
        entry.sessions.add(sessionId);
        if (data.success) entry.successCount++;
      }
    }

    // Filter for significant patterns not yet proposed
    const newProposals: PlaybookProposal[] = [];

    for (const [hash, entry] of patternMap.entries()) {
      if (this.proposedPatterns.has(hash)) continue;

      const sessionCount = entry.sessions.size;
      if (sessionCount < this.minSessions) continue;

      const successRate = entry.successCount / sessionCount;
      if (successRate < this.minSuccessRate) continue;

      // Infer task type from majority goal of source sessions
      const taskType = this._inferDominantTaskType(
        entry.sessions,
        sessions,
      );

      const proposal: PlaybookProposal = {
        id: randomUUID(),
        taskType,
        toolSequence: entry.seq,
        patternHash: hash,
        sessionCount,
        successRate,
        sourceSessionIds: [...entry.sessions],
        proposedAt: new Date().toISOString(),
      };

      newProposals.push(proposal);
      this.proposedPatterns.add(hash);

      // Emit event for each new proposal
      this.emit("event", {
        kind: "agent:playbook_learned",
        proposalId: proposal.id,
        taskType: proposal.taskType,
        toolSequence: proposal.toolSequence,
        successRate: proposal.successRate,
        sessionCount: proposal.sessionCount,
        timestamp: Date.now(),
      });
    }

    if (newProposals.length > 0) {
      // Merge into stored proposals and persist
      this.proposals = [...this.proposals, ...newProposals];
      this._saveProposals();
    }

    return newProposals;
  }

  /**
   * Get all stored proposals, excluding applied ones.
   */
  getProposals(): PlaybookProposal[] {
    return this.proposals.filter((p) => !this.appliedProposals.has(p.id));
  }

  /**
   * Mark a proposal as applied so it won't be returned by getProposals().
   * Applied state is in-memory only — not persisted.
   */
  markApplied(proposalId: string): void {
    this.appliedProposals.add(proposalId);
  }

  // ─── Internal ───

  /**
   * Parse all JSONL files in tracesDir into per-session SessionData.
   */
  private _parseSessions(): Map<string, SessionData> {
    const sessions = new Map<string, SessionData>();

    if (!existsSync(this.tracesDir)) return sessions;

    let files: string[];
    try {
      files = readdirSync(this.tracesDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return sessions;
    }

    for (const file of files) {
      const filePath = join(this.tracesDir, file);
      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let event: TraceEvent;
        try {
          event = JSON.parse(trimmed) as TraceEvent;
        } catch {
          continue; // skip malformed lines
        }

        if (!event.kind || !event.sessionId) continue;

        switch (event.kind) {
          case "session_start": {
            sessions.set(event.sessionId, {
              sessionId: event.sessionId,
              goal: event.goal ?? "",
              toolCalls: [],
              success: false,
              ended: false,
            });
            break;
          }
          case "tool_call": {
            if (!event.tool) break;
            let session = sessions.get(event.sessionId);
            if (!session) {
              // Handle orphaned tool_call (session_start missed)
              session = {
                sessionId: event.sessionId,
                goal: "",
                toolCalls: [],
                success: false,
                ended: false,
              };
              sessions.set(event.sessionId, session);
            }
            session.toolCalls.push(event.tool);
            break;
          }
          case "session_end": {
            const sess = sessions.get(event.sessionId);
            if (sess) {
              sess.success = event.success ?? false;
              sess.ended = true;
            }
            break;
          }
          // tool_result: not needed for sequence extraction
          default:
            break;
        }
      }
    }

    return sessions;
  }

  /**
   * Infer the most common task type across a set of session IDs.
   * Falls back to "general" if no goals found.
   */
  private _inferDominantTaskType(
    sessionIds: Set<string>,
    allSessions: Map<string, SessionData>,
  ): string {
    const typeCounts = new Map<string, number>();

    for (const sid of sessionIds) {
      const sess = allSessions.get(sid);
      if (!sess || !sess.goal) continue;
      const t = inferTaskType(sess.goal);
      typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    }

    if (typeCounts.size === 0) return "general";

    let best = "general";
    let bestCount = 0;
    for (const [type, count] of typeCounts.entries()) {
      if (count > bestCount) {
        bestCount = count;
        best = type;
      }
    }
    return best;
  }

  /**
   * Load persisted proposals from disk.
   */
  private _loadProposals(): PlaybookProposal[] {
    try {
      if (!existsSync(this.storageFile)) return [];
      const raw = readFileSync(this.storageFile, "utf-8");
      return JSON.parse(raw) as PlaybookProposal[];
    } catch {
      return [];
    }
  }

  /**
   * Atomic write of proposals array to disk.
   */
  private _saveProposals(): void {
    const tmpFile = `${this.storageFile}.tmp`;
    try {
      mkdirSync(this.storageDir, { recursive: true });
      writeFileSync(tmpFile, JSON.stringify(this.proposals, null, 2), "utf-8");
      renameSync(tmpFile, this.storageFile);
    } catch {
      // Non-fatal: storage failures should not crash the agent loop
    }
  }
}
