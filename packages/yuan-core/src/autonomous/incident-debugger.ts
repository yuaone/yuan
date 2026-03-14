/**
 * @module autonomous/incident-debugger
 * @description Incident Debug Mode — analyzes failures using logs, trace history,
 * and recent commits to produce a structured debug report.
 *
 * Input sources:
 * 1. Trace JSONL files from ~/.yuan/traces/
 * 2. Git log + git blame for suspected files
 * 3. Process logs passed in (from caller)
 *
 * Output:
 * { rootCause, suspectedFiles, fixStrategy, confidence }
 *
 * Design:
 * - Pure analysis — does NOT call LLM (deterministic)
 * - All output via agent:debug_report event
 * - Reads trace files via TraceEntry format
 * - Goes through OverheadGovernor (caller checks shouldRunDebugMode())
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { ToolExecutor, AgentEvent } from "../types.js";
import type { TraceEntry } from "../trace-recorder.js";
import { BOUNDS, truncate } from "../safe-bounds.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DebugReport {
  taskId: string;
  /** Most likely root cause description */
  rootCause: string;
  /** Files most likely involved in the failure */
  suspectedFiles: string[];
  /** Recommended fix strategy */
  fixStrategy: string;
  /** 0.0–1.0 confidence in this diagnosis */
  confidence: number;
  /** Evidence used to form this report */
  evidence: DebugEvidence[];
  timestamp: number;
}

export interface DebugEvidence {
  kind: "trace" | "git_log" | "git_blame" | "log_line";
  content: string;
  weight: number; // 0.0–1.0
}

export interface IncidentDebuggerConfig {
  tracesDir?: string;
  projectPath?: string;
  /** Max trace entries to analyze */
  maxTraceEntries?: number;
  /** Max git log lines */
  maxGitLogLines?: number;
}

// ─── IncidentDebugger ─────────────────────────────────────────────────────────

export class IncidentDebugger extends EventEmitter {
  private readonly tracesDir: string;
  private readonly maxTraceEntries: number;
  private readonly maxGitLogLines: number;

  constructor(
    private readonly toolExecutor: ToolExecutor,
    private readonly projectPath: string,
    config: IncidentDebuggerConfig = {},
  ) {
    super();
    this.tracesDir = config.tracesDir ?? join(homedir(), ".yuan", "traces");
    this.maxTraceEntries = config.maxTraceEntries ?? 200;
    this.maxGitLogLines = config.maxGitLogLines ?? 30;
  }

  /**
   * Analyze a failure and produce a debug report.
   *
   * @param errorMessage   The error message or stack trace
   * @param sessionId      Optional: limit trace analysis to this session
   * @param logs           Optional: additional log lines to analyze
   * @param taskId         Optional: task ID for correlation
   */
  async analyze(
    errorMessage: string,
    sessionId?: string,
    logs?: string[],
    taskId?: string,
  ): Promise<DebugReport> {
    const resolvedTaskId = taskId ?? randomUUID();
    const evidence: DebugEvidence[] = [];

    // 1. Analyze trace history
    const traceEvidence = this.analyzeTraces(errorMessage, sessionId);
    evidence.push(...traceEvidence);

    // 2. Analyze git log
    const gitEvidence = await this.analyzeGitLog(errorMessage);
    evidence.push(...gitEvidence);

    // 3. Analyze provided log lines
    if (logs && logs.length > 0) {
      const logEvidence = this.analyzeLogs(logs, errorMessage);
      evidence.push(...logEvidence);
    }

    // 4. Synthesize: extract suspected files + root cause
    const suspectedFiles = this.extractSuspectedFiles(evidence, errorMessage);
    const rootCause = this.inferRootCause(evidence, errorMessage);
    const fixStrategy = this.inferFixStrategy(rootCause, suspectedFiles);
    const confidence = this.computeConfidence(evidence);

    // 5. Git blame on suspected files (best-effort)
    if (suspectedFiles.length > 0) {
      const blameEvidence = await this.analyzeGitBlame(suspectedFiles.slice(0, 3));
      evidence.push(...blameEvidence);
    }

    const report: DebugReport = {
      taskId: resolvedTaskId,
      rootCause,
      suspectedFiles,
      fixStrategy,
      confidence,
      evidence: evidence.slice(0, 50), // cap for storage
      timestamp: Date.now(),
    };

    this.emitReport(report);
    return report;
  }

  // ─── private — Trace Analysis ──────────────────────────────────────────────

  private analyzeTraces(errorMessage: string, sessionId?: string): DebugEvidence[] {
    const evidence: DebugEvidence[] = [];
    try {
      // Find most recent trace files (last 3)
      const files = this.listTraceFiles()
        .filter(f => !sessionId || basename(f).includes(sessionId))
        .slice(0, 3);

      for (const file of files) {
        const entries = this.readTraceFile(file);
        // Find error events and the tool calls that preceded them
        const errorEntries = entries.filter(e =>
          e.event.kind === "agent:error" ||
          (e.event.kind === "agent:tool_result" && !(e.event as { output?: string }).output?.includes("success"))
        ).slice(-10);

        for (const entry of errorEntries) {
          evidence.push({
            kind: "trace",
            content: truncate(JSON.stringify(entry.event), 300),
            weight: 0.7,
          });
        }

        // Find the last phase_transition before error
        const phaseEntries = entries.filter(e => e.event.kind === "agent:phase_transition").slice(-3);
        for (const entry of phaseEntries) {
          evidence.push({
            kind: "trace",
            content: truncate(JSON.stringify(entry.event), 200),
            weight: 0.4,
          });
        }
      }
    } catch { /* non-fatal */ }

    return evidence;
  }

  private listTraceFiles(): string[] {
    try {
      return readdirSync(this.tracesDir)
        .filter(f => f.endsWith(".jsonl"))
        .map(f => join(this.tracesDir, f))
        .sort((a, b) => {
          try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; }
        });
    } catch { return []; }
  }

  private readTraceFile(filePath: string): TraceEntry[] {
    try {
      const raw = readFileSync(filePath, "utf-8");
      return raw.split("\n")
        .filter(Boolean)
        .slice(-this.maxTraceEntries)
        .map(line => {
          try { return JSON.parse(line) as TraceEntry; } catch { return null; }
        })
        .filter((e): e is TraceEntry => e !== null);
    } catch { return []; }
  }

  // ─── private — Git Analysis ────────────────────────────────────────────────

  private async analyzeGitLog(errorMessage: string): Promise<DebugEvidence[]> {
    const evidence: DebugEvidence[] = [];
    try {
      const result = await this.toolExecutor.execute({
        id: `debug-gitlog-${Date.now()}`,
        name: "shell_exec",
        arguments: JSON.stringify({
          command: `git log --oneline -${this.maxGitLogLines} 2>/dev/null`,
          cwd: this.projectPath,
          timeout: 5000,
        }),
      });
      if (result.success && result.output) {
        // Find commits that mention files or keywords from error message
        const keywords = this.extractKeywords(errorMessage);
        const relevantLines = result.output.split("\n")
          .filter(line => keywords.some(kw => line.toLowerCase().includes(kw.toLowerCase())))
          .slice(0, 5);
        for (const line of relevantLines) {
          evidence.push({ kind: "git_log", content: line, weight: 0.6 });
        }
        // Always include the last 3 commits (recent changes = likely culprits)
        const recentLines = result.output.split("\n").filter(Boolean).slice(0, 3);
        for (const line of recentLines) {
          if (!relevantLines.includes(line)) {
            evidence.push({ kind: "git_log", content: line, weight: 0.3 });
          }
        }
      }
    } catch { /* non-fatal */ }
    return evidence;
  }

  private async analyzeGitBlame(files: string[]): Promise<DebugEvidence[]> {
    const evidence: DebugEvidence[] = [];
    for (const file of files) {
      try {
        const result = await this.toolExecutor.execute({
          id: `debug-blame-${Date.now()}`,
          name: "shell_exec",
          arguments: JSON.stringify({
            command: `git log --oneline -5 -- "${file}" 2>/dev/null`,
            cwd: this.projectPath,
            timeout: 5000,
          }),
        });
        if (result.success && result.output.trim()) {
          evidence.push({
            kind: "git_blame",
            content: `${file}:\n${truncate(result.output, 300)}`,
            weight: 0.5,
          });
        }
      } catch { /* non-fatal */ }
    }
    return evidence;
  }

  // ─── private — Log Analysis ────────────────────────────────────────────────

  private analyzeLogs(logs: string[], errorMessage: string): DebugEvidence[] {
    const keywords = this.extractKeywords(errorMessage);
    return logs
      .filter(line => keywords.some(kw => line.toLowerCase().includes(kw.toLowerCase()))
        || /error|exception|fail|crash|TypeError|SyntaxError/i.test(line))
      .slice(0, 20)
      .map(line => ({
        kind: "log_line" as const,
        content: truncate(line, 200),
        weight: /error|exception|fail/i.test(line) ? 0.8 : 0.4,
      }));
  }

  // ─── private — Synthesis ─────────────────────────────────────────────────

  private extractSuspectedFiles(evidence: DebugEvidence[], errorMessage: string): string[] {
    const filePattern = /([a-zA-Z0-9_/.-]+\.[a-zA-Z]{2,5})(?::\d+)?/g;
    const files = new Map<string, number>();

    const allText = [
      errorMessage,
      ...evidence.map(e => e.content),
    ].join("\n");

    let match: RegExpExecArray | null;
    while ((match = filePattern.exec(allText)) !== null) {
      const f = match[1];
      if (f && !f.includes("node_modules") && f.includes("/")) {
        files.set(f, (files.get(f) ?? 0) + 1);
      }
    }

    return [...files.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([f]) => f);
  }

  private inferRootCause(evidence: DebugEvidence[], errorMessage: string): string {
    const errLines = errorMessage.split("\n").filter(Boolean);
    const firstError = errLines[0] ?? "Unknown error";

    // Check for common patterns
    if (/TypeError|is not a function|Cannot read prop/i.test(errorMessage)) {
      return `Type error: ${truncate(firstError, 150)}`;
    }
    if (/SyntaxError|Unexpected token|Cannot parse/i.test(errorMessage)) {
      return `Syntax error: ${truncate(firstError, 150)}`;
    }
    if (/Cannot find module|Module not found/i.test(errorMessage)) {
      return `Missing module: ${truncate(firstError, 150)}`;
    }
    if (/ENOENT|No such file/i.test(errorMessage)) {
      return `Missing file: ${truncate(firstError, 150)}`;
    }
    if (/ECONNREFUSED|connection refused|timeout/i.test(errorMessage)) {
      return `Network/connection failure: ${truncate(firstError, 150)}`;
    }

    // High-weight trace evidence
    const highWeightEvidence = evidence
      .filter(e => e.weight >= 0.7)
      .map(e => e.content.slice(0, 100))
      .slice(0, 2);

    if (highWeightEvidence.length > 0) {
      return `${truncate(firstError, 100)} (from trace: ${highWeightEvidence[0]})`;
    }

    return truncate(firstError, 200);
  }

  private inferFixStrategy(rootCause: string, suspectedFiles: string[]): string {
    if (/type error/i.test(rootCause)) {
      return `Check type definitions in ${suspectedFiles[0] ?? "the failing file"}. Verify function signatures and null checks.`;
    }
    if (/syntax error/i.test(rootCause)) {
      return `Fix syntax in ${suspectedFiles[0] ?? "the failing file"}. Run: npx tsc --noEmit`;
    }
    if (/missing module/i.test(rootCause)) {
      return `Run: pnpm install. Check that all imports reference existing modules.`;
    }
    if (/missing file/i.test(rootCause)) {
      return `Verify ${suspectedFiles[0] ?? "referenced files"} exist. Check build output directory.`;
    }
    if (/network|connection/i.test(rootCause)) {
      return `Check service availability. Verify environment variables for API keys/URLs.`;
    }
    if (suspectedFiles.length > 0) {
      return `Investigate recent changes to: ${suspectedFiles.slice(0, 3).join(", ")}`;
    }
    return "Review recent commits with: git log --oneline -10. Check error stack trace.";
  }

  private computeConfidence(evidence: DebugEvidence[]): number {
    if (evidence.length === 0) return 0.1;
    const avgWeight = evidence.reduce((s, e) => s + e.weight, 0) / evidence.length;
    const coverageFactor = Math.min(evidence.length / 10, 1.0);
    return Math.round(avgWeight * coverageFactor * 100) / 100;
  }

  private extractKeywords(text: string): string[] {
    return text.split(/[\s:.()\n]/)
      .filter(t => t.length > 4 && !/^(error|Error|at|in|the|and|for|with)$/.test(t))
      .slice(0, 8);
  }

  private emitReport(report: DebugReport): void {
    const event: AgentEvent = {
      kind: "agent:debug_report",
      taskId: report.taskId,
      rootCause: truncate(report.rootCause, BOUNDS.toolResultPersistence),
      suspectedFiles: report.suspectedFiles,
      fixStrategy: truncate(report.fixStrategy, 500),
      confidence: report.confidence,
      timestamp: report.timestamp,
    };
    this.emit("event", event);
  }
}
