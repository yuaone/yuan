/**
 * @module progress-renderer
 * @description Real-time agent execution progress display for CLI.
 *
 * Shows:
 * - Agent status (planning/coding/reviewing/testing)
 * - Current tool execution (file, command, etc.)
 * - Token usage bar
 * - Iteration progress
 * - Thinking stream (reasoning deltas)
 */

import { colors } from "./renderer.js";

// ─── ANSI Helpers ───

function c(color: string, text: string): string {
  return `${color}${text}${colors.reset}`;
}

function termWidth(): number {
  return process.stdout.columns || 80;
}

/** Truncate a string to fit within `max` columns, appending ellipsis if needed. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

/** Format a token count for display (e.g. 12400 -> "12.4k"). */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ─── Types ───

/** Agent execution phase. */
export type AgentPhase = "planning" | "coding" | "reviewing" | "testing" | "waiting";

/** Status change event consumed by `onStatus`. */
export interface StatusEvent {
  phase: AgentPhase;
  detail?: string;
}

/** Tool call event consumed by `onToolCall`. */
export interface ToolCallEvent {
  tool: string;
  input: string;
}

/** Tool result event consumed by `onToolResult`. */
export interface ToolResultEvent {
  tool: string;
  success: boolean;
  summary: string;
}

/** Approval request shown by `onApprovalNeeded`. */
export interface ApprovalEvent {
  id: string;
  tool: string;
  description: string;
  risk: "low" | "medium" | "high";
}

/** Completion summary shown by `onDone`. */
export interface DoneResult {
  filesChanged: string[];
  iterations: number;
  tokensUsed: number;
  durationMs: number;
  summary: string;
}

/** Configuration for `ProgressRenderer`. */
export interface ProgressRendererConfig {
  /** Maximum iterations the agent will attempt. */
  maxIterations: number;
  /** Maximum token budget for the run. */
  maxTokens: number;
  /** Whether to display the thinking (reasoning) stream. */
  showThinking: boolean;
}

// ─── Phase labels & colors ───

const PHASE_LABELS: Record<AgentPhase, { tag: string; color: string }> = {
  planning:  { tag: "[PLAN]",   color: colors.blue },
  coding:    { tag: "[CODE]",   color: colors.green },
  reviewing: { tag: "[REVIEW]", color: colors.yellow },
  testing:   { tag: "[TEST]",   color: colors.cyan },
  waiting:   { tag: "[WAIT]",   color: colors.gray },
};

// ─── Progress Bar ───

/**
 * Render a Unicode progress bar.
 *
 * @param current - Current value.
 * @param max     - Maximum value.
 * @param width   - Character width of the bar (filled + empty).
 * @returns Colored bar string, e.g. `████████░░░░░░░░`.
 */
export function renderBar(current: number, max: number, width = 20): string {
  const ratio = max > 0 ? Math.min(current / max, 1) : 0;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const pct = ratio * 100;

  let barColor: string;
  if (pct >= 80) barColor = colors.red;
  else if (pct >= 60) barColor = colors.yellow;
  else barColor = colors.green;

  return c(barColor, "\u2588".repeat(filled)) + c(colors.gray, "\u2591".repeat(empty));
}

// ─── ProgressRenderer ───

/**
 * Real-time CLI renderer for agent execution progress.
 *
 * Usage:
 * ```ts
 * const pr = new ProgressRenderer({ maxIterations: 25, maxTokens: 200_000, showThinking: true });
 * pr.onStatus({ phase: "planning", detail: "analyzing codebase" });
 * pr.onToolCall({ tool: "file_read", input: "src/index.ts" });
 * pr.onToolResult({ tool: "file_read", success: true, summary: "42 lines" });
 * pr.onIterationEnd(3, 25, 12400, 200000);
 * pr.onDone({ filesChanged: ["a.ts"], iterations: 3, tokensUsed: 12400, durationMs: 8200, summary: "Done" });
 * ```
 */
export class ProgressRenderer {
  private readonly config: ProgressRendererConfig;
  private thinkingBuffer = "";
  private thinkingTimer: ReturnType<typeof setTimeout> | null = null;
  private currentPhase: AgentPhase | null = null;
  private recentThinkingLines: string[] = [];
  private static readonly MAX_RECENT_THINKING_LINES = 24;
  constructor(config: ProgressRendererConfig) {
    this.config = config;
  }

  // ─── Status ───

  /** Display an agent phase transition. */
  onStatus(event: StatusEvent): void {
    const { tag, color } = PHASE_LABELS[event.phase];
    const detail = event.detail ? c(colors.dim, ` ${event.detail}`) : "";
    console.log(`${c(color + colors.bold, tag)}${detail}`);
    this.currentPhase = event.phase;
  }

  // ─── Tool Call / Result ───

  /** Display a tool invocation line. */
  onToolCall(event: ToolCallEvent): void {
    const maxInput = termWidth() - event.tool.length - 10;
    const input = truncate(event.input, Math.max(maxInput, 20));
    console.log(
      c(colors.dim, "  \u251C\u2500 ") +
        c(colors.yellow, event.tool) +
        c(colors.dim, ": ") +
        c(colors.white, input),
    );
  }

  /** Display a tool result line (success or error). */
  onToolResult(event: ToolResultEvent): void {
    const maxSummary = termWidth() - 10;
    if (event.success) {
      console.log(
        c(colors.dim, "  \u2514\u2500 ") +
          c(colors.green, "\u2713 ") +
          c(colors.dim, truncate(event.summary, maxSummary)),
      );
    } else {
      console.log(
        c(colors.dim, "  \u2514\u2500 ") +
          c(colors.red, "\u2717 ") +
          c(colors.red, truncate(event.summary, maxSummary)),
      );
    }
  }

  // ─── Thinking Stream ───

  /**
   * Stream a reasoning delta.
   * Output is debounced (200 ms) and rendered in dim gray,
   * word-wrapped to the terminal width.
   */
  onThinking(delta: string): void {
    if (!this.config.showThinking) return;

    const normalized = this.normalizeThinkingChunk(delta);
    if (!normalized) return;

    if (this.isRecentlyRendered(normalized)) {
      return;
    }

    this.thinkingBuffer += (this.thinkingBuffer ? " " : "") + normalized;
    // sentence boundary flush (Claude-style)
    const SENTENCE_BREAK = /[.!?。\n]\s*$/;

    if (SENTENCE_BREAK.test(this.thinkingBuffer)) {
      this.flushThinking();
      return;
    }
    if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
    this.thinkingTimer = setTimeout(() => {
      this.flushThinking();
    }, 200);
  }

  /** Flush any buffered thinking text to stdout. */
  private flushThinking(): void {
    if (this.thinkingBuffer.length > 4000) {
      this.thinkingBuffer = this.thinkingBuffer.slice(-2000);
    }
    if (!this.thinkingBuffer) return;
    const width = termWidth() - 4; // indent
    const text = this.normalizeThinkingChunk(this.thinkingBuffer);
    this.thinkingBuffer = "";
    this.thinkingTimer = null;
    if (!text) return;
    // detect subagent lifecycle
    const subagentMatch = text.match(/\[(\w+):(start|done)\]\s*(.*)/);
    if (subagentMatch) {
      const [, agent, phase, msg] = subagentMatch;
      const subagentLine = `[${agent}:${phase}] ${msg ?? ""}`.trim();

      if (this.isRecentlyRendered(subagentLine)) {
        return;
      }
      this.rememberThinkingLine(subagentLine);
      const color =
        phase === "start" ? colors.cyan :
        phase === "done" ? colors.green :
        colors.gray;

      console.log(
        c(color, `  ${agent}:${phase}`) +
        (msg ? c(colors.dim, ` ${msg}`) : "")
      );
      return;
    }
    const wrappedLines = this.wrapText(text, width);
    const dedupedLines: string[] = [];

    for (const line of wrappedLines) {
      const normalizedLine = this.normalizeThinkingChunk(line);
      if (!normalizedLine) continue;
      if (this.isRecentlyRendered(normalizedLine)) continue;
      dedupedLines.push(normalizedLine);
    }

    for (const line of dedupedLines) {
      this.rememberThinkingLine(line);
      console.log(c(colors.gray + colors.dim, `  ${line}`));
    }
  }

  /** Word-wrap text to a given width. */
  private wrapText(text: string, width: number): string[] {
    const result: string[] = [];
    const raw = text.replace(/\n/g, " ");
    let remaining = raw;

    while (remaining.length > 0) {
      if (remaining.length <= width) {
        result.push(remaining);
        break;
      }
      let breakIdx = remaining.lastIndexOf(" ", width);
      if (breakIdx <= 0) breakIdx = width;
      result.push(remaining.slice(0, breakIdx));
      remaining = remaining.slice(breakIdx).trimStart();
    }
    return result;
  }

 private normalizeThinkingChunk(text: string): string {
    return text
      .replace(/\r/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim();
  }

  private isRecentlyRendered(text: string): boolean {
    const normalized = this.normalizeThinkingChunk(text);
    if (!normalized) return true;
    return this.recentThinkingLines.includes(normalized);
  }

  private rememberThinkingLine(text: string): void {
    const normalized = this.normalizeThinkingChunk(text);
    if (!normalized) return;

    this.recentThinkingLines.push(normalized);
    if (
      this.recentThinkingLines.length >
      ProgressRenderer.MAX_RECENT_THINKING_LINES
    ) {
      this.recentThinkingLines.splice(
        0,
        this.recentThinkingLines.length -
          ProgressRenderer.MAX_RECENT_THINKING_LINES,
      );
    }
  }

  // ─── Iteration Progress ───

  /**
   * Render an iteration progress line with bar and token usage.
   *
   * Example output:
   * ```
   * [3/25] ████████░░░░░░░░ 32% | tokens: 12.4k/200k
   * ```
   */
  onIterationEnd(
    iteration: number,
    maxIteration: number,
    tokensUsed: number,
    maxTokens: number,
  ): void {
    // Flush any pending thinking text before the progress line.
    this.flushThinking();

    const pct = maxIteration > 0 ? Math.round((iteration / maxIteration) * 100) : 0;
    const iterLabel = c(colors.bold, `[${iteration}/${maxIteration}]`);
    const bar = renderBar(iteration, maxIteration, 16);
    const pctStr = `${String(pct).padStart(3)}%`;
    const tokenStr = `${formatTokens(tokensUsed)}/${formatTokens(maxTokens)}`;

    console.log(
      `${iterLabel} ${bar} ${pctStr} ${c(colors.dim, "|")} ${c(colors.dim, "tokens:")} ${tokenStr}`,
    );
  }

  // ─── Approval ───

  /** Display an approval-needed prompt box. */
  onApprovalNeeded(approval: ApprovalEvent): void {
    this.flushThinking();

    const riskColor =
      approval.risk === "high"
        ? colors.bgRed
        : approval.risk === "medium"
          ? colors.bgYellow
          : colors.green;

    const riskLabel = c(
      riskColor + colors.bold,
      ` ${approval.risk.toUpperCase()} `,
    );
    const border = c(colors.yellow, "\u250C" + "\u2500".repeat(termWidth() - 4) + "\u2510");
    const bottom = c(colors.yellow, "\u2514" + "\u2500".repeat(termWidth() - 4) + "\u2518");

    console.log();
    console.log(border);
    console.log(
      c(colors.yellow, "\u2502") +
        c(colors.bold + colors.yellow, " APPROVAL NEEDED ") +
        riskLabel +
        " ".repeat(Math.max(0, termWidth() - 22 - approval.risk.length - 4)) +
        c(colors.yellow, "\u2502"),
    );
    console.log(
      c(colors.yellow, "\u2502") +
        ` Tool: ${c(colors.cyan, approval.tool)}` +
        " ".repeat(Math.max(0, termWidth() - 10 - approval.tool.length - 2)) +
        c(colors.yellow, "\u2502"),
    );
    console.log(
      c(colors.yellow, "\u2502") +
        ` ${truncate(approval.description, termWidth() - 4)}` +
        " ".repeat(Math.max(0, termWidth() - 3 - Math.min(approval.description.length, termWidth() - 4) - 1)) +
        c(colors.yellow, "\u2502"),
    );
    console.log(bottom);
    console.log();
  }

  // ─── Done ───

  /** Display a completion summary. */
  onDone(result: DoneResult): void {
    this.flushThinking();
    console.log();
    console.log(c(colors.green + colors.bold, "  COMPLETED"));
    console.log(c(colors.dim, "  " + "\u2500".repeat(50)));

    const durationSec = (result.durationMs / 1000).toFixed(1);
    console.log(
      `  ${c(colors.dim, "Files changed:")} ${c(colors.white, String(result.filesChanged.length))}`,
    );
    for (const f of result.filesChanged) {
      console.log(`    ${c(colors.dim, "\u2022")} ${f}`);
    }
    console.log(
      `  ${c(colors.dim, "Iterations:")}    ${c(colors.white, `${result.iterations}/${this.config.maxIterations}`)}`,
    );
    console.log(
      `  ${c(colors.dim, "Tokens:")}        ${c(colors.white, `${formatTokens(result.tokensUsed)}/${formatTokens(this.config.maxTokens)}`)}`,
    );
    console.log(
      `  ${c(colors.dim, "Duration:")}      ${c(colors.white, `${durationSec}s`)}`,
    );

    if (result.summary) {
      console.log();
      console.log(`  ${c(colors.dim, result.summary)}`);
    }
    console.log();
  }

  // ─── Error ───

  /** Display an error message in red. */
  onError(error: string): void {
    this.flushThinking();
    console.log(c(colors.red + colors.bold, `  ERROR: `) + c(colors.red, error));
  }

  // ─── Clear ───

  /** Clear the current progress display area. */
  clear(): void {
    this.flushThinking();
    process.stdout.write("\x1b[2J\x1b[H"); // clear screen + move cursor home
  }
}
