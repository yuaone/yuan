/**
 * @module evidence-chain
 * @description Provenance layer for YUAN agent decisions.
 *
 * Tracks WHY decisions were made: what evidence influenced each decision,
 * which patch/playbook was selected and why, which search/doc result led
 * to the strategy. Enables debugging, replay, and trust verification.
 *
 * Design constraints:
 * - Never blocks the main loop (all writes are fire-and-forget)
 * - Never throws (all errors are swallowed silently)
 * - Atomic writes (.tmp → renameSync)
 * - Circular buffer of last N records (default 1000)
 */

import { EventEmitter } from "node:events";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// ─── Public Types ─────────────────────────────────────────────────────────────

export type EvidenceSource =
  | "search_result"
  | "doc_finding"
  | "test_result"
  | "playbook"
  | "failure_memory"
  | "trace_pattern"
  | "human_input";

export interface EvidenceItem {
  id: string;
  source: EvidenceSource;
  /** Snippet or summary of the evidence */
  content: string;
  /** 0..1 relevance to the decision */
  relevanceScore: number;
  /** Decision ID this evidence supported */
  usedInDecision: string;
  timestamp: string;
}

export interface ProvenanceRecord {
  /** Decision ID (also used as lookup key) */
  id: string;
  sessionId: string;
  taskId?: string;
  decisionType:
    | "strategy_selected"
    | "patch_selected"
    | "playbook_activated"
    | "tool_called"
    | "approval_granted"
    | "milestone_reached";
  /** Human-readable description of what was decided */
  decision: string;
  evidence: EvidenceItem[];
  outcome?: "success" | "failure" | "pending";
  outcomeNote?: string;
  recordedAt: string;
}

export interface EvidenceChainConfig {
  /** Defaults to ~/.yuan/evidence/ */
  storageDir?: string;
  /** Circular buffer size, default 1000 */
  maxRecords?: number;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

const DEFAULT_MAX_RECORDS = 1000;

function atomicWrite(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, filePath);
}

// ─── EvidenceChain ────────────────────────────────────────────────────────────

export class EvidenceChain extends EventEmitter {
  private readonly chainPath: string;
  private readonly maxRecords: number;

  /**
   * In-memory map for O(1) lookup by record ID.
   * Ordered insertion preserved via insertion order of Map.
   */
  private records: Map<string, ProvenanceRecord> = new Map();

  constructor(config?: EvidenceChainConfig) {
    super();
    const storageDir =
      config?.storageDir ?? join(homedir(), ".yuan", "evidence");
    this.chainPath = join(storageDir, "chain.json");
    this.maxRecords = config?.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.loadFromDisk();
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Start a new provenance record for a decision being made.
   * Returns the record ID.
   */
  beginDecision(
    sessionId: string,
    decisionType: ProvenanceRecord["decisionType"],
    decision: string,
    taskId?: string
  ): string {
    const id = randomUUID();
    const record: ProvenanceRecord = {
      id,
      sessionId,
      taskId,
      decisionType,
      decision,
      evidence: [],
      outcome: "pending",
      recordedAt: new Date().toISOString(),
    };
    this.records.set(id, record);
    this.enforceCircularBuffer();
    this.persistToDisk();
    return id;
  }

  /**
   * Add evidence that influenced the decision.
   * No-op if recordId is unknown.
   */
  addEvidence(
    recordId: string,
    source: EvidenceSource,
    content: string,
    relevanceScore: number
  ): void {
    const record = this.records.get(recordId);
    if (!record) return;

    const item: EvidenceItem = {
      id: randomUUID(),
      source,
      content,
      relevanceScore: Math.max(0, Math.min(1, relevanceScore)),
      usedInDecision: recordId,
      timestamp: new Date().toISOString(),
    };
    record.evidence.push(item);
    this.persistToDisk();
  }

  /**
   * Finalize the decision with outcome.
   * Emits `agent:evidence_chain_recorded`.
   */
  finalizeDecision(
    recordId: string,
    outcome: "success" | "failure" | "pending",
    note?: string
  ): void {
    const record = this.records.get(recordId);
    if (!record) return;

    record.outcome = outcome;
    if (note !== undefined) record.outcomeNote = note;
    this.persistToDisk();

    try {
      this.emit("agent:evidence_chain_recorded", {
        kind: "agent:evidence_chain_recorded" as const,
        recordId,
        sessionId: record.sessionId,
        decisionType: record.decisionType,
        evidenceCount: record.evidence.length,
        outcome,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // non-fatal
    }
  }

  /**
   * Query all provenance records for a session.
   */
  getSession(sessionId: string): ProvenanceRecord[] {
    const result: ProvenanceRecord[] = [];
    for (const record of this.records.values()) {
      if (record.sessionId === sessionId) result.push(record);
    }
    return result;
  }

  /**
   * Query by decision type.
   */
  getByType(
    decisionType: ProvenanceRecord["decisionType"]
  ): ProvenanceRecord[] {
    const result: ProvenanceRecord[] = [];
    for (const record of this.records.values()) {
      if (record.decisionType === decisionType) result.push(record);
    }
    return result;
  }

  /**
   * Get the full chain for a task (all decisions leading to outcome).
   */
  getTaskChain(taskId: string): ProvenanceRecord[] {
    const result: ProvenanceRecord[] = [];
    for (const record of this.records.values()) {
      if (record.taskId === taskId) result.push(record);
    }
    // Sort by recordedAt ascending
    result.sort(
      (a, b) =>
        new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime()
    );
    return result;
  }

  // ─── Internal helpers ───────────────────────────────────────────────────────

  /**
   * Enforce circular buffer: drop oldest records when maxRecords is exceeded.
   * "Oldest" = earliest recordedAt.
   */
  private enforceCircularBuffer(): void {
    if (this.records.size <= this.maxRecords) return;

    // Collect entries sorted by recordedAt ascending
    const sorted = Array.from(this.records.values()).sort(
      (a, b) =>
        new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime()
    );

    const toRemove = this.records.size - this.maxRecords;
    for (let i = 0; i < toRemove; i++) {
      this.records.delete(sorted[i].id);
    }
  }

  /**
   * Load records from disk into the in-memory map.
   * Silently ignores all errors.
   */
  private loadFromDisk(): void {
    try {
      if (!existsSync(this.chainPath)) return;
      const raw = readFileSync(this.chainPath, "utf8");
      const parsed: ProvenanceRecord[] = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const record of parsed) {
        if (record && typeof record.id === "string") {
          this.records.set(record.id, record);
        }
      }
      // Apply buffer limit after load
      this.enforceCircularBuffer();
    } catch {
      // non-fatal
    }
  }

  /**
   * Persist current records to disk using an atomic write.
   * Silently ignores all errors.
   */
  private persistToDisk(): void {
    try {
      mkdirSync(dirname(this.chainPath), { recursive: true });
      const data = JSON.stringify(
        Array.from(this.records.values()),
        null,
        2
      );
      atomicWrite(this.chainPath, data);
    } catch {
      // non-fatal
    }
  }
}
