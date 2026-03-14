/**
 * @module trace-recorder
 * @description Lightweight append-only session trace recorder.
 *
 * Records every observable agent loop event to `.yuan/traces/<sessionId>.jsonl`.
 * Format: one JSON object per line (JSONL), allowing step-by-step replay.
 *
 * Design constraints:
 * - Never blocks the main loop (all writes are fire-and-forget)
 * - Never throws (all errors are swallowed silently)
 * - File handle stays open during session, closed on stop()
 */

import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { AgentEvent } from "./types.js";

/** One line in a trace file */
export interface TraceEntry {
  /** ISO timestamp */
  ts: string;
  /** Sequence number within session */
  seq: number;
  /** The agent event payload */
  event: AgentEvent;
}

/** Events worth recording — filter out noisy deltas */
const TRACE_KINDS = new Set<string>([
  "agent:phase_transition",
  "agent:tool_start",
  "agent:tool_result",
  "agent:file_change",
  "agent:qa_result",
  "agent:evidence_report",
  "agent:iteration",
  "agent:completed",
  "agent:error",
  "agent:approval_needed",
  "agent:bg_update",
]);

export class TraceRecorder {
  private stream: WriteStream | null = null;
  private seq = 0;
  private readonly tracePath: string;
  private opened = false;

  constructor(private readonly sessionId: string, traceDir?: string) {
    const base = traceDir ?? join(homedir(), ".yuan", "traces");
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    this.tracePath = join(base, `${date}-${sessionId}.jsonl`);
  }

  /** Path to the trace file for this session */
  get path(): string {
    return this.tracePath;
  }

  /** Record an agent event. Fire-and-forget — never throws. */
  record(event: AgentEvent): void {
    if (!TRACE_KINDS.has(event.kind)) return;
    try {
      if (!this.opened) this.open();
      if (!this.stream) return;
      const entry: TraceEntry = {
        ts: new Date().toISOString(),
        seq: this.seq++,
        event,
      };
      this.stream.write(JSON.stringify(entry) + "\n");
    } catch {
      // never block the main loop
    }
  }

  /** Close the trace file. Safe to call multiple times. */
  stop(): void {
    try {
      if (this.stream) {
        this.stream.end();
        this.stream = null;
        // Reset so record() can reopen if needed after dispose/restart
        this.opened = false;
      }
    } catch {
      // swallow
    }
  }

  private open(): void {
    try {
      mkdirSync(dirname(this.tracePath), { recursive: true });
      this.stream = createWriteStream(this.tracePath, { flags: "a", encoding: "utf8" });
      this.stream.on("error", () => {
        this.stream = null;
      });
      this.opened = true;
    } catch {
      this.opened = true; // prevent retry storms
    }
  }
}
