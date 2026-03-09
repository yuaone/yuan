/**
 * @module agent-logger
 * @description YUAN Agent Logger — Structured, layered logging for agent execution.
 *
 * Provides:
 * - Layer-transition logging (fires ONCE per layer entry)
 * - Internal reasoning/decision tracking
 * - Parallel agent log separation
 * - Formatted human-readable output with tree-drawing characters
 * - JSONL file output for machine parsing
 * - Query and summary APIs for debugging
 *
 * Only depends on Node builtins (fs, path, crypto).
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ══════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════

/** Log severity level */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** Log category — classifies the nature of the log entry */
export type LogCategory =
  | "input"
  | "layer"
  | "reasoning"
  | "decision"
  | "tool"
  | "parallel"
  | "conflict"
  | "reflection"
  | "context"
  | "error"
  | "system";

/** A single structured log entry */
export interface LogEntry {
  /** Unique log entry ID */
  id: string;
  /** Epoch milliseconds */
  timestamp: number;
  /** Severity level */
  level: LogLevel;
  /** Category tag */
  category: LogCategory;

  // ─── Session tracking ───
  /** Session this log belongs to */
  sessionId: string;
  /** Agent ID (for parallel agents) */
  agentId?: string;
  /** Parent orchestrator agent ID */
  parentAgentId?: string;

  // ─── Content ───
  /** Human-readable message */
  message: string;
  /** Arbitrary structured data */
  data?: Record<string, unknown>;

  // ─── Layer tracking ───
  /** Layer name: "input" | "analyze" | "plan" | "implement" | "verify" | "output" */
  layer?: string;
  /** Nesting level (0 = top-level, 1 = sub-agent, etc.) */
  layerDepth?: number;

  // ─── Reasoning tracking ───
  reasoning?: {
    /** What the agent is thinking */
    thought: string;
    /** Options considered */
    options?: string[];
    /** Option chosen */
    chosen?: string;
    /** Confidence 0–1 */
    confidence?: number;
    /** Why this choice was made */
    why?: string;
  };

  // ─── Parallel tracking ───
  parallel?: {
    /** DAG execution group ID */
    groupId: string;
    /** Agent index within the group */
    agentIndex: number;
    /** Total agents in the group */
    totalAgents: number;
    /** Task description */
    task: string;
    /** Lifecycle status */
    status: "spawned" | "running" | "completed" | "failed";
  };

  /** Duration in milliseconds (for completed layers/operations) */
  durationMs?: number;
  /** Token usage for this entry */
  tokens?: { input: number; output: number };
}

/** Output destination for log entries */
export type LogOutput =
  | { type: "memory" }
  | { type: "file"; path: string }
  | { type: "console"; colorize: boolean }
  | { type: "callback"; fn: (entry: LogEntry) => void };

/** Logger configuration */
export interface LoggerConfig {
  /** Session ID */
  sessionId: string;
  /** Agent ID (for parallel agents) */
  agentId?: string;
  /** Parent orchestrator ID */
  parentAgentId?: string;

  /** Minimum log level (default: "info") */
  level?: LogLevel;
  /** Output destinations (default: [{ type: "memory" }]) */
  outputs?: LogOutput[];

  /** Fire layer-entry log only once per layer (default: true) */
  fireOncePerLayer?: boolean;
  /** Include reasoning entries (default: true) */
  includeReasoning?: boolean;
  /** Include parallel entries (default: true) */
  includeParallel?: boolean;
  /** Max entries kept in memory (default: 5000) */
  maxLogSize?: number;

  /** Directory for log files */
  logDir?: string;
  /** Separate log file per parallel agent (default: true) */
  separateParallelLogs?: boolean;
}

/** Query filter for reading back log entries */
export interface LogQuery {
  sessionId?: string;
  agentId?: string;
  category?: LogCategory;
  level?: LogLevel;
  layer?: string;
  fromTimestamp?: number;
  toTimestamp?: number;
  limit?: number;
  offset?: number;
}

/** Summary overview of a logging session */
export interface LogSummary {
  sessionId: string;
  totalEntries: number;
  duration: number;

  layers: {
    name: string;
    enteredAt: number;
    exitedAt?: number;
    duration?: number;
    entriesCount: number;
  }[];

  decisions: {
    question: string;
    chosen: string;
    confidence: number;
  }[];

  parallelGroups: {
    groupId: string;
    agents: number;
    completed: number;
    failed: number;
  }[];

  errors: LogEntry[];
  tokenUsage: { input: number; output: number };
}

// ══════════════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════════════

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
  trace: "TRACE",
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
  fatal: "FATAL",
};

/** ANSI color codes for console output */
const COLORS: Record<string, string> = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgRed: "\x1b[41m",
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  trace: COLORS.dim,
  debug: COLORS.cyan,
  info: COLORS.green,
  warn: COLORS.yellow,
  error: COLORS.red,
  fatal: COLORS.bgRed + COLORS.white,
};

// ══════════════════════════════════════════════════════════════════════
// AgentLogger
// ══════════════════════════════════════════════════════════════════════

/**
 * Structured logger for YUAN agent execution.
 *
 * Tracks layer transitions (firing once per entry), internal reasoning,
 * decisions, tool calls, parallel agent lifecycles, and conflicts.
 * Supports memory, file (JSONL), console, and callback outputs.
 *
 * @example
 * ```ts
 * const logger = new AgentLogger({ sessionId: "sess-1" });
 * logger.logInput("Add OAuth to CLI");
 * const exit = logger.enterLayer("analyze");
 * logger.logReasoning("Need to check existing auth...");
 * exit(); // logs duration
 * console.log(logger.getFormattedLog());
 * ```
 */
export class AgentLogger {
  private readonly sessionId: string;
  private readonly agentId: string | undefined;
  private readonly parentAgentId: string | undefined;

  private readonly level: LogLevel;
  private readonly outputs: LogOutput[];
  private readonly fireOncePerLayer: boolean;
  private readonly includeReasoning: boolean;
  private readonly includeParallel: boolean;
  private readonly maxLogSize: number;
  private readonly logDir: string | undefined;
  private readonly separateParallelLogs: boolean;

  /** In-memory log storage */
  private entries: LogEntry[] = [];
  /** Number of entries already flushed to file (prevents duplicate writes) */
  private flushedCount = 0;
  /** Layers that have already emitted an "entered" log */
  private enteredLayers: Set<string> = new Set();
  /** Current layer nesting stack */
  private layerStack: string[] = [];
  /** Child loggers (parallel agents) keyed by agentId */
  private children: Map<string, AgentLogger> = new Map();
  /** Monotonic counter for ordering */
  private idCounter = 0;

  constructor(config: LoggerConfig) {
    this.sessionId = config.sessionId;
    this.agentId = config.agentId;
    this.parentAgentId = config.parentAgentId;
    this.level = config.level ?? "info";
    this.outputs = config.outputs ?? [{ type: "memory" }];
    this.fireOncePerLayer = config.fireOncePerLayer ?? true;
    this.includeReasoning = config.includeReasoning ?? true;
    this.includeParallel = config.includeParallel ?? true;
    this.maxLogSize = config.maxLogSize ?? 5000;
    this.logDir = config.logDir;
    this.separateParallelLogs = config.separateParallelLogs ?? true;
  }

  // ════════════════════════════════════════════════════════════════════
  // Core Level Methods
  // ════════════════════════════════════════════════════════════════════

  /** Log at trace level */
  trace(category: LogCategory, message: string, data?: Record<string, unknown>): void {
    this.log("trace", category, message, data);
  }

  /** Log at debug level */
  debug(category: LogCategory, message: string, data?: Record<string, unknown>): void {
    this.log("debug", category, message, data);
  }

  /** Log at info level */
  info(category: LogCategory, message: string, data?: Record<string, unknown>): void {
    this.log("info", category, message, data);
  }

  /** Log at warn level */
  warn(category: LogCategory, message: string, data?: Record<string, unknown>): void {
    this.log("warn", category, message, data);
  }

  /** Log at error level */
  error(category: LogCategory, message: string, data?: Record<string, unknown>): void {
    this.log("error", category, message, data);
  }

  /** Log at fatal level */
  fatal(category: LogCategory, message: string, data?: Record<string, unknown>): void {
    this.log("fatal", category, message, data);
  }

  // ════════════════════════════════════════════════════════════════════
  // Layer Tracking
  // ════════════════════════════════════════════════════════════════════

  /**
   * Enter a layer. Logs the entry ONCE (if fireOncePerLayer is true).
   * Returns an exit function that logs duration when called.
   *
   * @param layer - Layer name (e.g., "analyze", "plan", "implement", "verify")
   * @param message - Optional entry message
   * @returns Exit function — call it when the layer completes
   */
  enterLayer(layer: string, message?: string): () => void {
    const startTime = Date.now();
    const depth = this.layerStack.length;
    this.layerStack.push(layer);

    // Fire entry log only once per layer (unless disabled)
    if (!this.fireOncePerLayer || !this.enteredLayers.has(layer)) {
      this.enteredLayers.add(layer);

      const entry = this.createEntry(
        "info",
        "layer",
        message ?? `${layer.toUpperCase()} (entered)`,
      );
      entry.layer = layer;
      entry.layerDepth = depth;
      this.emit(entry);
    }

    // Return exit function
    return () => {
      const durationMs = Date.now() - startTime;

      // Pop the layer from stack
      const idx = this.layerStack.lastIndexOf(layer);
      if (idx !== -1) this.layerStack.splice(idx, 1);

      const exitEntry = this.createEntry(
        "info",
        "layer",
        `${layer.toUpperCase()} (${(durationMs / 1000).toFixed(2)}s)`,
      );
      exitEntry.layer = layer;
      exitEntry.layerDepth = depth;
      exitEntry.durationMs = durationMs;
      this.emit(exitEntry);
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // Reasoning & Decisions
  // ════════════════════════════════════════════════════════════════════

  /**
   * Log internal reasoning — what the agent is thinking.
   *
   * @param thought - The reasoning text
   * @param options - Options being considered
   * @param chosen - Which option was chosen
   * @param confidence - Confidence level 0–1
   * @param why - Explanation for the choice
   */
  logReasoning(
    thought: string,
    options?: string[],
    chosen?: string,
    confidence?: number,
    why?: string,
  ): void {
    if (!this.includeReasoning) return;

    const entry = this.createEntry("debug", "reasoning", `Thinking: "${thought}"`);
    entry.reasoning = { thought, options, chosen, confidence, why };
    this.emit(entry);
  }

  /**
   * Log a decision point — a fork where the agent chose one path.
   *
   * @param question - What decision was made
   * @param options - Available options
   * @param chosen - Selected option
   * @param why - Rationale
   * @param confidence - Confidence level 0–1
   */
  logDecision(
    question: string,
    options: string[],
    chosen: string,
    why: string,
    confidence?: number,
  ): void {
    const entry = this.createEntry("info", "decision", `Decision: "${chosen}"`);
    entry.reasoning = {
      thought: question,
      options,
      chosen,
      confidence: confidence ?? 0.5,
      why,
    };
    this.emit(entry);
  }

  // ════════════════════════════════════════════════════════════════════
  // Parallel Agent Tracking
  // ════════════════════════════════════════════════════════════════════

  /**
   * Create a child logger for a parallel agent.
   * The child has its own in-memory buffer and optionally a separate log file.
   *
   * @param agentId - Unique ID for the child agent
   * @param task - What this agent is doing
   * @param groupId - DAG execution group ID
   * @param agentIndex - Agent index within the group
   * @param totalAgents - Total agents in the group
   * @returns A new AgentLogger for the child agent
   */
  createChildLogger(
    agentId: string,
    task: string,
    groupId: string,
    agentIndex: number,
    totalAgents: number,
  ): AgentLogger {
    const childOutputs: LogOutput[] = [{ type: "memory" }];

    // Add file output if logDir is set and separateParallelLogs is on
    if (this.logDir && this.separateParallelLogs) {
      const filePath = join(this.logDir, `agent-${agentId}.jsonl`);
      childOutputs.push({ type: "file", path: filePath });
    }

    // Forward callbacks from parent
    for (const output of this.outputs) {
      if (output.type === "callback") {
        childOutputs.push(output);
      }
      if (output.type === "console") {
        childOutputs.push(output);
      }
    }

    const child = new AgentLogger({
      sessionId: this.sessionId,
      agentId,
      parentAgentId: this.agentId ?? this.sessionId,
      level: this.level,
      outputs: childOutputs,
      fireOncePerLayer: this.fireOncePerLayer,
      includeReasoning: this.includeReasoning,
      includeParallel: this.includeParallel,
      maxLogSize: this.maxLogSize,
      logDir: this.logDir,
      separateParallelLogs: this.separateParallelLogs,
    });

    this.children.set(agentId, child);

    // Log spawn on the parent
    this.logParallelSpawn(groupId, agentId, task, agentIndex, totalAgents);

    return child;
  }

  /**
   * Log parallel agent spawning.
   */
  logParallelSpawn(
    groupId: string,
    agentId: string,
    task: string,
    index: number,
    total: number,
  ): void {
    if (!this.includeParallel) return;

    const entry = this.createEntry(
      "info",
      "parallel",
      `Agent[${index}]: "${task}"`,
    );
    entry.parallel = {
      groupId,
      agentIndex: index,
      totalAgents: total,
      task,
      status: "spawned",
    };
    entry.agentId = agentId;
    this.emit(entry);
  }

  /**
   * Log parallel agent completion.
   */
  logParallelComplete(
    groupId: string,
    agentId: string,
    result: string,
    tokens?: { input: number; output: number },
  ): void {
    if (!this.includeParallel) return;

    const totalTokens = tokens ? tokens.input + tokens.output : 0;
    const entry = this.createEntry(
      "info",
      "parallel",
      `Agent ${agentId}: completed (${totalTokens.toLocaleString()} tokens)`,
    );
    entry.parallel = {
      groupId,
      agentIndex: 0,
      totalAgents: 0,
      task: result,
      status: "completed",
    };
    entry.agentId = agentId;
    if (tokens) entry.tokens = tokens;
    this.emit(entry);
  }

  /**
   * Log parallel agent failure.
   */
  logParallelFailed(groupId: string, agentId: string, error: string): void {
    if (!this.includeParallel) return;

    const entry = this.createEntry(
      "error",
      "parallel",
      `Agent ${agentId}: FAILED — ${error}`,
    );
    entry.parallel = {
      groupId,
      agentIndex: 0,
      totalAgents: 0,
      task: error,
      status: "failed",
    };
    entry.agentId = agentId;
    this.emit(entry);
  }

  // ════════════════════════════════════════════════════════════════════
  // Input / Output
  // ════════════════════════════════════════════════════════════════════

  /**
   * Log user input — the very first thing on every request.
   *
   * @param goal - The user's goal
   * @param mode - Agent mode (e.g., "code", "architect")
   * @param model - Model being used
   */
  logInput(goal: string, mode?: string, model?: string): void {
    const parts = [`Goal: "${goal}"`];
    if (mode) parts.push(`mode=${mode}`);
    if (model) parts.push(`model=${model}`);

    const entry = this.createEntry("info", "input", parts.join(", "));
    entry.data = { goal, mode, model };
    this.emit(entry);
  }

  /**
   * Log final output — the last entry for a request.
   *
   * @param result - Summary of the result
   * @param success - Whether the agent succeeded
   * @param tokens - Total token usage
   */
  logOutput(
    result: string,
    success: boolean,
    tokens?: { input: number; output: number },
  ): void {
    const totalTokens = tokens ? tokens.input + tokens.output : 0;
    const status = success ? "Success" : "Failed";
    const msg = `Output: ${status} (${totalTokens.toLocaleString()} tokens)`;

    const entry = this.createEntry("info", "input", msg);
    entry.data = { result, success };
    if (tokens) entry.tokens = tokens;
    this.emit(entry);
  }

  // ════════════════════════════════════════════════════════════════════
  // Tool Tracking
  // ════════════════════════════════════════════════════════════════════

  /** Log a tool call (before execution) */
  logToolCall(toolName: string, input: Record<string, unknown>): void {
    const entry = this.createEntry(
      "info",
      "tool",
      `Calling ${toolName}`,
    );
    entry.data = { toolName, input };
    this.emit(entry);
  }

  /** Log a tool result (after execution) */
  logToolResult(
    toolName: string,
    output: string,
    durationMs: number,
    success: boolean,
  ): void {
    const status = success ? "OK" : "FAILED";
    const entry = this.createEntry(
      success ? "info" : "error",
      "tool",
      `${toolName} ${status} (${durationMs}ms)`,
    );
    entry.data = { toolName, output: output.slice(0, 500), success };
    entry.durationMs = durationMs;
    this.emit(entry);
  }

  // ════════════════════════════════════════════════════════════════════
  // Conflict Tracking
  // ════════════════════════════════════════════════════════════════════

  /** Log a detected conflict between agents/files */
  logConflict(type: string, fileA: string, fileB: string, severity: string): void {
    const entry = this.createEntry(
      severity === "critical" ? "error" : "warn",
      "conflict",
      `Conflict [${type}]: ${fileA} <-> ${fileB} (${severity})`,
    );
    entry.data = { type, fileA, fileB, severity };
    this.emit(entry);
  }

  /** Log conflict resolution */
  logConflictResolved(strategy: string, result: string): void {
    const entry = this.createEntry(
      "info",
      "conflict",
      `Resolved via ${strategy}: ${result}`,
    );
    entry.data = { strategy, result };
    this.emit(entry);
  }

  // ════════════════════════════════════════════════════════════════════
  // Reflection Tracking
  // ════════════════════════════════════════════════════════════════════

  /** Log self-reflection result */
  logReflection(verdict: string, score: number, issues: string[]): void {
    const entry = this.createEntry(
      "info",
      "reflection",
      `Verdict: ${verdict} (score: ${score})`,
    );
    entry.data = { verdict, score, issues };
    this.emit(entry);
  }

  // ════════════════════════════════════════════════════════════════════
  // Query & Read Back
  // ════════════════════════════════════════════════════════════════════

  /**
   * Get log entries, optionally filtered by a query.
   *
   * @param query - Filter criteria
   * @returns Matching log entries
   */
  getEntries(query?: LogQuery): LogEntry[] {
    let result = this.entries;

    if (query) {
      result = result.filter((e) => {
        if (query.sessionId && e.sessionId !== query.sessionId) return false;
        if (query.agentId && e.agentId !== query.agentId) return false;
        if (query.category && e.category !== query.category) return false;
        if (query.level && LOG_LEVEL_ORDER[e.level] < LOG_LEVEL_ORDER[query.level]) return false;
        if (query.layer && e.layer !== query.layer) return false;
        if (query.fromTimestamp && e.timestamp < query.fromTimestamp) return false;
        if (query.toTimestamp && e.timestamp > query.toTimestamp) return false;
        return true;
      });

      const offset = query.offset ?? 0;
      const limit = query.limit ?? result.length;
      result = result.slice(offset, offset + limit);
    }

    return result;
  }

  /**
   * Get formatted, human-readable text output.
   * Uses tree-drawing characters to visualize layer nesting.
   *
   * @param query - Optional filter
   * @returns Formatted multi-line string
   */
  getFormattedLog(query?: LogQuery): string {
    const entries = this.getEntries(query);
    return entries.map((e) => this.formatEntry(e)).join("\n");
  }

  /**
   * Get a summary overview of the logging session.
   */
  getSummary(): LogSummary {
    const layerMap = new Map<string, {
      name: string;
      enteredAt: number;
      exitedAt?: number;
      duration?: number;
      entriesCount: number;
    }>();

    const decisions: LogSummary["decisions"] = [];
    const parallelMap = new Map<string, { agents: number; completed: number; failed: number }>();
    const errors: LogEntry[] = [];
    let totalInput = 0;
    let totalOutput = 0;

    for (const entry of this.entries) {
      // Layer tracking
      if (entry.layer) {
        const existing = layerMap.get(entry.layer);
        if (!existing) {
          layerMap.set(entry.layer, {
            name: entry.layer,
            enteredAt: entry.timestamp,
            exitedAt: entry.durationMs != null ? entry.timestamp : undefined,
            duration: entry.durationMs,
            entriesCount: 1,
          });
        } else {
          existing.entriesCount++;
          if (entry.durationMs != null) {
            existing.exitedAt = entry.timestamp;
            existing.duration = entry.durationMs;
          }
        }
      }

      // Decision tracking
      if (entry.category === "decision" && entry.reasoning) {
        decisions.push({
          question: entry.reasoning.thought,
          chosen: entry.reasoning.chosen ?? "",
          confidence: entry.reasoning.confidence ?? 0,
        });
      }

      // Parallel tracking
      if (entry.parallel) {
        const gid = entry.parallel.groupId;
        if (!parallelMap.has(gid)) {
          parallelMap.set(gid, { agents: 0, completed: 0, failed: 0 });
        }
        const pg = parallelMap.get(gid)!;
        if (entry.parallel.status === "spawned") pg.agents++;
        if (entry.parallel.status === "completed") pg.completed++;
        if (entry.parallel.status === "failed") pg.failed++;
      }

      // Errors
      if (entry.level === "error" || entry.level === "fatal") {
        errors.push(entry);
      }

      // Tokens
      if (entry.tokens) {
        totalInput += entry.tokens.input;
        totalOutput += entry.tokens.output;
      }
    }

    const firstTs = this.entries.length > 0 ? this.entries[0].timestamp : Date.now();
    const lastTs = this.entries.length > 0 ? this.entries[this.entries.length - 1].timestamp : Date.now();

    return {
      sessionId: this.sessionId,
      totalEntries: this.entries.length,
      duration: lastTs - firstTs,
      layers: Array.from(layerMap.values()),
      decisions,
      parallelGroups: Array.from(parallelMap.entries()).map(([groupId, v]) => ({
        groupId,
        ...v,
      })),
      errors,
      tokenUsage: { input: totalInput, output: totalOutput },
    };
  }

  /**
   * Get only decision-type log entries (the decision trail).
   */
  getDecisionTrail(): LogEntry[] {
    return this.entries.filter((e) => e.category === "decision");
  }

  /**
   * Get parallel agent log entries from this logger and all children.
   *
   * @param groupId - Optional filter by group ID
   */
  getParallelLogs(groupId?: string): LogEntry[] {
    const ownParallel = this.entries.filter((e) => {
      if (e.category !== "parallel") return false;
      if (groupId && e.parallel?.groupId !== groupId) return false;
      return true;
    });

    // Collect from children
    const childEntries: LogEntry[] = [];
    for (const child of this.children.values()) {
      const childAll = child.getEntries();
      for (const entry of childAll) {
        if (groupId && entry.parallel?.groupId !== groupId) continue;
        childEntries.push(entry);
      }
    }

    return [...ownParallel, ...childEntries].sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get error and fatal entries only.
   */
  getErrors(): LogEntry[] {
    return this.entries.filter(
      (e) => e.level === "error" || e.level === "fatal",
    );
  }

  // ════════════════════════════════════════════════════════════════════
  // File Output
  // ════════════════════════════════════════════════════════════════════

  /**
   * Flush all in-memory entries to file outputs.
   * Appends JSONL to file outputs defined in the config.
   */
  async flush(): Promise<void> {
    // Only flush entries that haven't been flushed yet
    const unflushed = this.entries.slice(this.flushedCount);
    if (unflushed.length === 0 && this.children.size === 0) return;

    for (const output of this.outputs) {
      if (output.type === "file" && unflushed.length > 0) {
        this.ensureDir(dirname(output.path));
        const lines = unflushed.map((e) => JSON.stringify(e)).join("\n") + "\n";
        appendFileSync(output.path, lines, "utf-8");
      }
    }

    this.flushedCount = this.entries.length;

    // Flush children
    for (const child of this.children.values()) {
      await child.flush();
    }
  }

  /**
   * Write the full session log to a specific file path.
   * Writes both JSONL (machine) and .txt (human-readable) versions.
   *
   * @param filePath - Base file path (will create .jsonl and .txt)
   */
  async writeToFile(filePath: string): Promise<void> {
    this.ensureDir(dirname(filePath));

    // JSONL version
    const jsonl = this.entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(filePath, jsonl, "utf-8");

    // Human-readable text version
    const txtPath = filePath.replace(/\.\w+$/, ".txt");
    if (txtPath !== filePath) {
      const formatted = this.getFormattedLog();
      writeFileSync(txtPath, formatted, "utf-8");
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // Cleanup
  // ════════════════════════════════════════════════════════════════════

  /** Clear all log entries and reset layer tracking */
  clear(): void {
    this.entries = [];
    this.enteredLayers.clear();
    this.layerStack = [];
    this.idCounter = 0;

    for (const child of this.children.values()) {
      child.clear();
    }
    this.children.clear();
  }

  /**
   * Prune entries to keep only the most recent N.
   *
   * @param keepLast - Number of entries to keep (default: maxLogSize / 2)
   * @returns Number of entries pruned
   */
  prune(keepLast?: number): number {
    const keep = keepLast ?? Math.floor(this.maxLogSize / 2);
    if (this.entries.length <= keep) return 0;

    const pruned = this.entries.length - keep;
    this.entries = this.entries.slice(-keep);
    return pruned;
  }

  // ════════════════════════════════════════════════════════════════════
  // Private
  // ════════════════════════════════════════════════════════════════════

  /**
   * Core log method — creates an entry and emits to all outputs.
   */
  private log(
    level: LogLevel,
    category: LogCategory,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    if (!this.shouldLog(level)) return;

    const entry = this.createEntry(level, category, message);
    if (data) entry.data = data;
    this.emit(entry);
  }

  /**
   * Create a new LogEntry with session/agent metadata.
   */
  private createEntry(
    level: LogLevel,
    category: LogCategory,
    message: string,
  ): LogEntry {
    const entry: LogEntry = {
      id: `log-${this.idCounter++}-${randomUUID().slice(0, 8)}`,
      timestamp: Date.now(),
      level,
      category,
      sessionId: this.sessionId,
      message,
    };

    if (this.agentId) entry.agentId = this.agentId;
    if (this.parentAgentId) entry.parentAgentId = this.parentAgentId;

    // Attach current layer context
    if (this.layerStack.length > 0) {
      entry.layer = this.layerStack[this.layerStack.length - 1];
      entry.layerDepth = this.layerStack.length - 1;
    }

    return entry;
  }

  /**
   * Check if a given level meets the minimum threshold.
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[this.level];
  }

  /**
   * Emit a log entry to all configured outputs.
   */
  private emit(entry: LogEntry): void {
    // Store in memory
    const hasMemory = this.outputs.some((o) => o.type === "memory");
    if (hasMemory) {
      this.entries.push(entry);

      // Enforce max size
      if (this.entries.length > this.maxLogSize) {
        this.entries = this.entries.slice(-Math.floor(this.maxLogSize * 0.8));
      }
    }

    // Send to other outputs
    for (const output of this.outputs) {
      switch (output.type) {
        case "memory":
          // Already handled above
          break;
        case "file":
          try {
            this.ensureDir(dirname(output.path));
            appendFileSync(output.path, JSON.stringify(entry) + "\n", "utf-8");
          } catch {
            // Silently fail file writes to avoid crashing the agent
          }
          break;
        case "console":
          process.stderr.write(
            (output.colorize ? this.formatEntryColor(entry) : this.formatEntry(entry)) + "\n",
          );
          break;
        case "callback":
          try {
            output.fn(entry);
          } catch {
            // Silently fail callbacks
          }
          break;
      }
    }
  }

  /**
   * Format a single log entry as a human-readable line with tree characters.
   */
  private formatEntry(entry: LogEntry): string {
    const time = this.formatTime(entry.timestamp);
    const level = LOG_LEVEL_LABELS[entry.level].padEnd(5);
    const cat = entry.category;

    // Determine prefix based on category and content
    let prefix = "";
    let body = entry.message;

    if (entry.category === "input") {
      // Input/output markers
      if (entry.message.startsWith("Output:")) {
        prefix = "\u25C0 ";
      } else {
        prefix = "\u25B6 ";
      }
    } else if (entry.category === "layer") {
      // Layer entry/exit with box-drawing
      if (entry.durationMs != null) {
        prefix = "\u2514\u2500 ";
      } else {
        prefix = "\u250C\u2500 ";
      }
    } else if (entry.category === "parallel") {
      if (entry.parallel?.status === "spawned" && entry.message.includes("Agent[0]")) {
        prefix = "\u2502 \u250C\u2500 ";
      } else if (entry.parallel?.status === "completed" || entry.parallel?.status === "failed") {
        const icon = entry.parallel.status === "completed" ? "\u2705" : "\u274C";
        prefix = `\u2502 \u2502 ${icon} `;
      } else {
        prefix = "\u2502 \u2502 ";
      }
    } else if (entry.category === "decision" && entry.reasoning) {
      // Decision with indented details
      const opts = entry.reasoning.options?.join(", ") ?? "";
      const conf = entry.reasoning.confidence != null
        ? ` (confidence: ${entry.reasoning.confidence.toFixed(2)})`
        : "";
      body = `Decision: "${entry.reasoning.chosen}"`;
      const lines = [
        `[${time}] [${level}] [${cat}] \u2502 ${body}`,
        `\u2502   Options: [${opts}]`,
        `\u2502   Chosen: ${entry.reasoning.chosen}${conf}`,
      ];
      if (entry.reasoning.why) {
        lines.push(`\u2502   Why: "${entry.reasoning.why}"`);
      }
      return lines.join("\n");
    } else {
      // Inside a layer — use pipe prefix
      if (this.layerStack.length > 0 || entry.layer) {
        prefix = "\u2502 ";
      }
    }

    return `[${time}] [${level}] [${cat}] ${prefix}${body}`;
  }

  /**
   * Format a log entry with ANSI colors for console output.
   */
  private formatEntryColor(entry: LogEntry): string {
    const plain = this.formatEntry(entry);
    const color = LEVEL_COLORS[entry.level] ?? "";
    return `${color}${plain}${COLORS.reset}`;
  }

  /**
   * Format epoch ms to HH:MM:SS.mmm
   */
  private formatTime(timestamp: number): string {
    const d = new Date(timestamp);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return `${h}:${m}:${s}.${ms}`;
  }

  /**
   * Ensure a directory exists, creating it recursively if needed.
   */
  private ensureDir(dir: string): void {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Ignore — directory may already exist
    }
  }

  /**
   * Get the log file path for a given agent ID.
   */
  private getLogFilePath(agentId?: string): string {
    const dir = this.logDir ?? "/tmp/yuan-logs";
    const name = agentId ? `agent-${agentId}` : `session-${this.sessionId}`;
    return join(dir, `${name}.jsonl`);
  }
}
