/**
 * @module reflexion
 * @description Reflexion Layer — structured self-reflection after each agent run.
 *
 * Based on the Reflexion paper (Shinn et al., 2023):
 * dynamic memory + self-reflection loop for continuous improvement.
 *
 * Key design decisions:
 * - `reflect()` is purely heuristic (no LLM calls) — analyzes tool results, counts failures, detects patterns
 * - `getGuidance()` uses keyword matching to find relevant past reflections
 * - Strategy confidence decays over time (0.95 per week)
 * - File-based persistence in `.yuan/memory/`
 * - Max 100 reflections (FIFO), max 50 strategies
 *
 * @example
 * ```typescript
 * const engine = new ReflexionEngine({ projectPath: "/my/project" });
 *
 * // After a run
 * const entry = engine.reflect({ goal, runId, termination, toolResults, ... });
 * await engine.store.saveReflection(entry);
 *
 * // Before a run
 * const guidance = await engine.getGuidance("fix the auth middleware");
 * const prompt = engine.formatForSystemPrompt(guidance);
 * ```
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Message, ToolResult, AgentTermination } from "./types.js";

// ─── Interfaces ───

/** A single reflection entry from an agent run */
export interface ReflexionEntry {
  /** UUID */
  id: string;
  /** Agent run identifier */
  runId: string;
  /** Epoch ms */
  timestamp: number;
  /** Original user goal */
  goal: string;
  /** Run outcome */
  outcome: "success" | "partial" | "failure";
  /** From AgentTermination.reason */
  terminationReason: string;

  /** Self-reflection analysis */
  reflection: {
    /** Successful strategies */
    whatWorked: string[];
    /** Failed strategies */
    whatFailed: string[];
    /** Root cause of failure (if applicable) */
    rootCause: string | null;
    /** What to try next time */
    alternativeApproach: string | null;
  };

  /** Tool usage analysis */
  toolAnalysis: {
    /** Which tools were called */
    toolsUsed: string[];
    /** Tools that failed */
    failedTools: Array<{ tool: string; error: string; count: number }>;
    /** Success rate 0–1 */
    successRate: number;
    /** Total tool calls */
    totalCalls: number;
    /** Average tool execution duration in ms */
    avgDurationMs: number;
  };

  /** Run metrics */
  metrics: {
    iterations: number;
    tokensUsed: number;
    durationMs: number;
    filesChanged: string[];
  };
}

/** A learned strategy from successful runs */
export interface StrategyRecord {
  /** UUID */
  id: string;
  /** Regex or keyword pattern that matches similar tasks */
  taskPattern: string;
  /** Description of what works */
  strategy: string;
  /** Proven tool ordering */
  toolSequence: string[];
  /** Number of times this strategy succeeded */
  successCount: number;
  /** Number of times this strategy failed */
  failureCount: number;
  /** success / (success + failure) */
  confidence: number;
  /** Last used timestamp */
  lastUsed: number;
  /** Example goals that used this strategy */
  examples: string[];
}

/** Guidance produced before an agent run */
export interface ReflexionGuidance {
  /** Relevant proven strategies */
  relevantStrategies: StrategyRecord[];
  /** Recent failures on similar tasks */
  recentFailures: ReflexionEntry[];
  /** Patterns that have failed before — things to avoid */
  avoidPatterns: string[];
  /** Suggested approach based on past success */
  suggestedApproach: string | null;
}

/** Configuration for the ReflexionEngine */
export interface ReflexionConfig {
  /** Project root path — stores data in `.yuan/memory/` */
  projectPath: string;
  /** Maximum stored reflections (FIFO). Default 100 */
  maxReflections?: number;
  /** Maximum stored strategies. Default 50 */
  maxStrategies?: number;
  /** Confidence decay multiplier per week. Default 0.95 */
  confidenceDecayPerWeek?: number;
}

// ─── Constants ───

const DEFAULT_MAX_REFLECTIONS = 100;
const DEFAULT_MAX_STRATEGIES = 50;
const DEFAULT_CONFIDENCE_DECAY = 0.95;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
const REFLECTIONS_FILE = "reflections.json";
const STRATEGIES_FILE = "strategies.json";

// ─── ReflexionStore ───

/**
 * File-based persistence for reflections and strategies.
 *
 * Storage location: `<projectPath>/.yuan/memory/`
 */
export class ReflexionStore {
  private readonly memoryDir: string;

  constructor(projectPath: string) {
    this.memoryDir = join(projectPath, ".yuan", "memory");
  }

  // ─── Reflection CRUD ───

  /** Save a reflection entry. Appends to the list. */
  async saveReflection(entry: ReflexionEntry): Promise<void> {
    const entries = await this.loadReflectionsFile();
    entries.push(entry);
    // FIFO: keep only last maxReflections (caller can prune, but we cap at a safe limit)
    if (entries.length > DEFAULT_MAX_REFLECTIONS * 2) {
      entries.splice(0, entries.length - DEFAULT_MAX_REFLECTIONS);
    }
    await this.writeJsonFile(REFLECTIONS_FILE, entries);
  }

  /** Get most recent reflections, optionally limited. */
  async getReflections(limit?: number): Promise<ReflexionEntry[]> {
    const entries = await this.loadReflectionsFile();
    if (limit !== undefined && limit > 0) {
      return entries.slice(-limit);
    }
    return entries;
  }

  /** Get reflections filtered by outcome. */
  async getReflectionsByOutcome(outcome: string): Promise<ReflexionEntry[]> {
    const entries = await this.loadReflectionsFile();
    return entries.filter((e) => e.outcome === outcome);
  }

  // ─── Strategy management ───

  /** Save or update a strategy record. */
  async saveStrategy(strategy: StrategyRecord): Promise<void> {
    const strategies = await this.loadStrategiesFile();
    const existingIdx = strategies.findIndex((s) => s.id === strategy.id);
    if (existingIdx >= 0) {
      strategies[existingIdx] = strategy;
    } else {
      strategies.push(strategy);
    }
    // Cap at a safe limit
    if (strategies.length > DEFAULT_MAX_STRATEGIES * 2) {
      // Remove lowest confidence
      strategies.sort((a, b) => b.confidence - a.confidence);
      strategies.length = DEFAULT_MAX_STRATEGIES;
    }
    await this.writeJsonFile(STRATEGIES_FILE, strategies);
  }

  /** Find strategies relevant to a goal using keyword matching. */
  async findRelevantStrategies(goal: string, limit?: number): Promise<StrategyRecord[]> {
    const strategies = await this.loadStrategiesFile();
    const keywords = extractKeywords(goal);
    const maxResults = limit ?? 5;

    const scored = strategies.map((s) => {
      let score = 0;

      // Check taskPattern as regex or keywords
      try {
        const re = new RegExp(s.taskPattern, "i");
        if (re.test(goal)) score += 10;
      } catch {
        // If not valid regex, treat as keywords
        const patternWords = extractKeywords(s.taskPattern);
        const overlap = patternWords.filter((pw) => keywords.includes(pw)).length;
        score += overlap * 3;
      }

      // Check examples
      for (const example of s.examples) {
        const exWords = extractKeywords(example);
        const overlap = exWords.filter((ew) => keywords.includes(ew)).length;
        score += overlap;
      }

      // Weight by confidence
      score *= s.confidence;

      return { strategy: s, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((s) => s.strategy);
  }

  /** Update success/failure stats for a strategy. */
  async updateStrategyStats(strategyId: string, success: boolean): Promise<void> {
    const strategies = await this.loadStrategiesFile();
    const strategy = strategies.find((s) => s.id === strategyId);
    if (!strategy) return;

    if (success) {
      strategy.successCount++;
    } else {
      strategy.failureCount++;
    }
    strategy.confidence =
      strategy.successCount / (strategy.successCount + strategy.failureCount);
    strategy.lastUsed = Date.now();

    await this.writeJsonFile(STRATEGIES_FILE, strategies);
  }

  // ─── Cleanup ───

  /** Remove reflections older than maxAge (ms). Returns count removed. */
  async pruneOldReflections(maxAge: number): Promise<number> {
    const entries = await this.loadReflectionsFile();
    const cutoff = Date.now() - maxAge;
    const filtered = entries.filter((e) => e.timestamp > cutoff);
    const removed = entries.length - filtered.length;
    if (removed > 0) {
      await this.writeJsonFile(REFLECTIONS_FILE, filtered);
    }
    return removed;
  }

  // ─── Private I/O ───

  private async ensureDir(): Promise<void> {
    await mkdir(this.memoryDir, { recursive: true });
  }

  private async readJsonFile<T>(filename: string): Promise<T | null> {
    try {
      const raw = await readFile(join(this.memoryDir, filename), "utf-8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private async writeJsonFile(filename: string, data: unknown): Promise<void> {
    await this.ensureDir();
    const filePath = join(this.memoryDir, filename);
    const tmpPath = filePath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    await rename(tmpPath, filePath);
  }

  private async loadReflectionsFile(): Promise<ReflexionEntry[]> {
    return (await this.readJsonFile<ReflexionEntry[]>(REFLECTIONS_FILE)) ?? [];
  }

  private async loadStrategiesFile(): Promise<StrategyRecord[]> {
    return (await this.readJsonFile<StrategyRecord[]>(STRATEGIES_FILE)) ?? [];
  }
}

// ─── ReflexionEngine ───

/** Parameters for the `reflect()` method */
export interface ReflectParams {
  goal: string;
  runId: string;
  termination: AgentTermination;
  toolResults: ToolResult[];
  messages: Message[];
  tokensUsed: number;
  durationMs: number;
  changedFiles: string[];
}

/**
 * ReflexionEngine — heuristic-based self-reflection after agent runs.
 *
 * No LLM calls. Analyzes tool results, detects failure patterns,
 * extracts strategies from successful runs, and provides guidance
 * for future runs.
 */
export class ReflexionEngine {
  readonly store: ReflexionStore;
  private readonly maxReflections: number;
  private readonly maxStrategies: number;
  private readonly confidenceDecayPerWeek: number;

  constructor(config: ReflexionConfig) {
    this.store = new ReflexionStore(config.projectPath);
    this.maxReflections = config.maxReflections ?? DEFAULT_MAX_REFLECTIONS;
    this.maxStrategies = config.maxStrategies ?? DEFAULT_MAX_STRATEGIES;
    this.confidenceDecayPerWeek = config.confidenceDecayPerWeek ?? DEFAULT_CONFIDENCE_DECAY;
  }

  /**
   * After an agent run: analyze what happened and produce a ReflexionEntry.
   *
   * Purely heuristic — no LLM call. Analyzes:
   * - Tool success/failure rates
   * - Error patterns
   * - Termination reason
   * - Duration and resource usage
   */
  reflect(params: ReflectParams): ReflexionEntry {
    const {
      goal,
      runId,
      termination,
      toolResults,
      messages,
      tokensUsed,
      durationMs,
      changedFiles,
    } = params;

    // ── Determine outcome ──
    const outcome = this.determineOutcome(termination, toolResults);
    const terminationReason = termination.reason;

    // ── Analyze tools ──
    const toolAnalysis = this.analyzeTools(toolResults);

    // ── Build reflection ──
    const reflection = this.buildReflection(
      outcome,
      termination,
      toolResults,
      toolAnalysis,
      messages,
    );

    // ── Count iterations from messages ──
    const iterations = messages.filter((m) => m.role === "assistant").length;

    return {
      id: randomUUID(),
      runId,
      timestamp: Date.now(),
      goal,
      outcome,
      terminationReason,
      reflection,
      toolAnalysis,
      metrics: {
        iterations,
        tokensUsed,
        durationMs,
        filesChanged: changedFiles,
      },
    };
  }

  /**
   * Before an agent run: retrieve relevant past reflections for context injection.
   *
   * Searches reflections and strategies by keyword matching against the goal.
   */
  async getGuidance(goal: string): Promise<ReflexionGuidance> {
    const keywords = extractKeywords(goal);

    // Find relevant strategies (with time-decayed confidence)
    const rawStrategies = await this.store.findRelevantStrategies(goal, 5);
    const relevantStrategies = rawStrategies.map((s) =>
      this.applyConfidenceDecay(s),
    );

    // Find recent failures on similar goals
    const allReflections = await this.store.getReflections();
    const recentFailures = allReflections
      .filter((r) => {
        if (r.outcome === "success") return false;
        const rKeywords = extractKeywords(r.goal);
        return keywords.some((kw) => rKeywords.includes(kw));
      })
      .slice(-5); // Last 5 relevant failures

    // Extract avoid patterns from failures
    const avoidPatterns: string[] = [];
    for (const failure of recentFailures) {
      for (const failed of failure.reflection.whatFailed) {
        if (!avoidPatterns.includes(failed)) {
          avoidPatterns.push(failed);
        }
      }
      if (failure.reflection.rootCause) {
        const rc = `Root cause: ${failure.reflection.rootCause}`;
        if (!avoidPatterns.includes(rc)) {
          avoidPatterns.push(rc);
        }
      }
    }

    // Suggest approach from best strategy
    let suggestedApproach: string | null = null;
    if (relevantStrategies.length > 0) {
      const best = relevantStrategies[0];
      if (best.confidence >= 0.5) {
        suggestedApproach = best.strategy;
      }
    }

    return {
      relevantStrategies,
      recentFailures,
      avoidPatterns,
      suggestedApproach,
    };
  }

  /**
   * Extract a StrategyRecord from a successful run.
   *
   * Only creates a strategy if the run used 3+ tool calls (nontrivial).
   */
  extractStrategy(entry: ReflexionEntry, goal: string): StrategyRecord | null {
    // Only extract from successful or partially successful runs
    if (entry.outcome === "failure") return null;

    // Require at least 3 tool calls for a meaningful strategy
    if (entry.toolAnalysis.totalCalls < 3) return null;

    // Build tool sequence (unique, in order of first appearance)
    const toolSequence = entry.toolAnalysis.toolsUsed;

    // Build strategy description from what worked
    const strategyParts = entry.reflection.whatWorked;
    if (strategyParts.length === 0) return null;

    const strategy = strategyParts.join("; ");

    // Extract task pattern: take significant keywords from goal
    const keywords = extractKeywords(goal);
    const taskPattern = keywords.slice(0, 5).join("|");

    if (!taskPattern) return null;

    return {
      id: randomUUID(),
      taskPattern,
      strategy,
      toolSequence,
      successCount: 1,
      failureCount: 0,
      confidence: 1.0,
      lastUsed: Date.now(),
      examples: [goal],
    };
  }

  /**
   * Format guidance for injection into a system prompt.
   *
   * Returns empty string if no relevant guidance found.
   */
  formatForSystemPrompt(guidance: ReflexionGuidance): string {
    const sections: string[] = [];

    if (
      guidance.relevantStrategies.length === 0 &&
      guidance.recentFailures.length === 0 &&
      guidance.avoidPatterns.length === 0
    ) {
      return "";
    }

    sections.push("<reflexion-guidance>");

    // Suggested approach
    if (guidance.suggestedApproach) {
      sections.push(`<suggested-approach>${guidance.suggestedApproach}</suggested-approach>`);
    }

    // Proven strategies
    if (guidance.relevantStrategies.length > 0) {
      sections.push("<proven-strategies>");
      for (const s of guidance.relevantStrategies) {
        const conf = (s.confidence * 100).toFixed(0);
        sections.push(
          `- [${conf}% confidence] ${s.strategy} (tools: ${s.toolSequence.join(" → ")})`,
        );
      }
      sections.push("</proven-strategies>");
    }

    // Avoid patterns
    if (guidance.avoidPatterns.length > 0) {
      sections.push("<avoid-patterns>");
      for (const p of guidance.avoidPatterns) {
        sections.push(`- ${p}`);
      }
      sections.push("</avoid-patterns>");
    }

    // Recent failures
    if (guidance.recentFailures.length > 0) {
      sections.push("<recent-failures>");
      for (const f of guidance.recentFailures) {
        const rootCause = f.reflection.rootCause
          ? ` (root cause: ${f.reflection.rootCause})`
          : "";
        sections.push(
          `- Goal: "${f.goal}" → ${f.outcome}${rootCause}`,
        );
      }
      sections.push("</recent-failures>");
    }

    sections.push("</reflexion-guidance>");

    return sections.join("\n");
  }

  // ─── Private helpers ───

  /** Determine outcome from termination reason and tool results */
  private determineOutcome(
    termination: AgentTermination,
    toolResults: ToolResult[],
  ): "success" | "partial" | "failure" {
    switch (termination.reason) {
      case "GOAL_ACHIEVED":
        return "success";
      case "ERROR":
        return "failure";
      case "USER_CANCELLED":
        // If some tools succeeded, it's partial
        return toolResults.some((r) => r.success) ? "partial" : "failure";
      case "MAX_ITERATIONS":
      case "BUDGET_EXHAUSTED":
        // If some tools succeeded and files were changed, partial
        return toolResults.some((r) => r.success) ? "partial" : "failure";
      case "NEEDS_APPROVAL":
        return "partial";
      default:
        return "failure";
    }
  }

  /** Analyze tool usage from results */
  private analyzeTools(toolResults: ToolResult[]): ReflexionEntry["toolAnalysis"] {
    if (toolResults.length === 0) {
      return {
        toolsUsed: [],
        failedTools: [],
        successRate: 0,
        totalCalls: 0,
        avgDurationMs: 0,
      };
    }

    // Unique tools in order of first appearance
    const toolsUsed: string[] = [];
    for (const r of toolResults) {
      if (!toolsUsed.includes(r.name)) {
        toolsUsed.push(r.name);
      }
    }

    // Failed tools aggregation
    const failMap = new Map<string, { error: string; count: number }>();
    for (const r of toolResults) {
      if (!r.success) {
        const existing = failMap.get(r.name);
        if (existing) {
          existing.count++;
        } else {
          failMap.set(r.name, {
            error: truncate(r.output, 200),
            count: 1,
          });
        }
      }
    }
    const failedTools = Array.from(failMap.entries()).map(([tool, info]) => ({
      tool,
      error: info.error,
      count: info.count,
    }));

    const successCount = toolResults.filter((r) => r.success).length;
    const successRate = successCount / toolResults.length;

    const totalDuration = toolResults.reduce((sum, r) => sum + r.durationMs, 0);
    const avgDurationMs = Math.round(totalDuration / toolResults.length);

    return {
      toolsUsed,
      failedTools,
      successRate,
      totalCalls: toolResults.length,
      avgDurationMs,
    };
  }

  /** Build reflection heuristically from run data */
  private buildReflection(
    outcome: "success" | "partial" | "failure",
    termination: AgentTermination,
    toolResults: ToolResult[],
    toolAnalysis: ReflexionEntry["toolAnalysis"],
    _messages: Message[],
  ): ReflexionEntry["reflection"] {
    const whatWorked: string[] = [];
    const whatFailed: string[] = [];
    let rootCause: string | null = null;
    let alternativeApproach: string | null = null;

    // ── What worked ──

    // Successful tools
    const successfulTools = new Set<string>();
    for (const r of toolResults) {
      if (r.success) successfulTools.add(r.name);
    }
    if (successfulTools.size > 0) {
      whatWorked.push(`Tools succeeded: ${[...successfulTools].join(", ")}`);
    }

    // High success rate
    if (toolAnalysis.successRate >= 0.8 && toolAnalysis.totalCalls >= 3) {
      whatWorked.push("High tool success rate (>=80%)");
    }

    // Fast execution
    if (toolAnalysis.avgDurationMs < 500 && toolAnalysis.totalCalls > 0) {
      whatWorked.push("Fast tool execution (<500ms avg)");
    }

    if (outcome === "success") {
      whatWorked.push("Goal achieved successfully");
    }

    // ── What failed ──

    // Failed tools
    for (const ft of toolAnalysis.failedTools) {
      whatFailed.push(
        `Tool "${ft.tool}" failed ${ft.count} time(s): ${ft.error}`,
      );
    }

    // Low success rate
    if (toolAnalysis.successRate < 0.5 && toolAnalysis.totalCalls >= 3) {
      whatFailed.push("Low tool success rate (<50%)");
    }

    // Repeated failures on same tool
    const repeatedFailures = toolAnalysis.failedTools.filter(
      (ft) => ft.count >= 3,
    );
    if (repeatedFailures.length > 0) {
      whatFailed.push(
        `Repeated failures: ${repeatedFailures.map((f) => f.tool).join(", ")}`,
      );
    }

    // ── Root cause analysis ──

    switch (termination.reason) {
      case "ERROR":
        rootCause = `Error: ${termination.error}`;
        alternativeApproach =
          "Consider breaking the task into smaller steps or using different tools";
        break;
      case "MAX_ITERATIONS":
        rootCause = "Ran out of iterations — task may be too complex or agent got stuck in a loop";
        alternativeApproach =
          "Break task into smaller sub-goals; check for infinite retry loops";
        break;
      case "BUDGET_EXHAUSTED":
        rootCause = `Token budget exhausted (${termination.tokensUsed} tokens used)`;
        alternativeApproach =
          "Use more focused context; avoid reading large files; use grep instead of reading entire files";
        break;
      case "USER_CANCELLED":
        rootCause = "User cancelled the run";
        break;
      case "NEEDS_APPROVAL":
        rootCause = "Blocked on approval — consider auto-approve for low-risk actions";
        break;
    }

    // Additional heuristic: if many tool failures are the same error
    if (toolAnalysis.failedTools.length > 0) {
      const topFailure = toolAnalysis.failedTools.reduce(
        (max, ft) => (ft.count > max.count ? ft : max),
        toolAnalysis.failedTools[0],
      );
      if (topFailure.count >= 3 && !rootCause) {
        rootCause = `Tool "${topFailure.tool}" repeatedly failed: ${topFailure.error}`;
        alternativeApproach = `Avoid "${topFailure.tool}" or fix the underlying issue before retrying`;
      }
    }

    return { whatWorked, whatFailed, rootCause, alternativeApproach };
  }

  /** Apply time-based confidence decay to a strategy */
  private applyConfidenceDecay(strategy: StrategyRecord): StrategyRecord {
    const now = Date.now();
    const weeksSinceLastUse = (now - strategy.lastUsed) / MS_PER_WEEK;
    if (weeksSinceLastUse <= 0) return strategy;

    const decayFactor = Math.pow(this.confidenceDecayPerWeek, weeksSinceLastUse);
    return {
      ...strategy,
      confidence: strategy.confidence * decayFactor,
    };
  }
}

// ─── Utility Functions ───

/** Extract meaningful keywords from text, removing stop words */
function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be",
    "to", "of", "and", "in", "that", "have", "it",
    "for", "not", "on", "with", "as", "do", "at",
    "this", "but", "from", "or", "by", "will", "my",
    "all", "can", "had", "her", "one", "our", "out",
    "should", "would", "could", "has", "its", "into",
    "then", "than", "been", "some", "when", "what",
  ]);

  // CJK 문자를 개별 토큰으로 추출 (한국어/일본어/중국어 지원)
  const cjkMatches = text.match(/[\u3000-\u9fff\uac00-\ud7af]{2,}/g) ?? [];

  const asciiWords = text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  return [...asciiWords, ...cjkMatches];
}

/** Truncate a string to maxLen, appending "..." if truncated */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}
