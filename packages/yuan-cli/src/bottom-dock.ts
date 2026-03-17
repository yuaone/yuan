/**
 * bottom-dock.ts — Fixed bottom area manager using ANSI scroll regions (DECSTBM).
 *
 * Splits the terminal into two zones:
 *   1. Scroll region (rows 1..N) — transcript content that scrolls naturally
 *   2. Fixed dock (rows N+1..end) — status, input prompt, hints (never scrolls)
 *
 * Activation: Only in tmux ($TMUX) or VSCode ($TERM_PROGRAM === "vscode").
 * Fallback: When not capable, all methods are safe no-ops (appendTranscript
 * still writes to stdout).
 *
 * ANSI sequences used:
 *   DECSTBM  \x1b[{top};{bottom}r   — set scroll region
 *   CUP      \x1b[{row};{col}H      — move cursor
 *   EL       \x1b[2K                 — erase entire line
 *   SC/RC    \x1b7 / \x1b8           — save/restore cursor
 *   DECTCEM  \x1b[?25h / \x1b[?25l   — show/hide cursor
 *   SM       \x1b[r                  — reset scroll region (full screen)
 */

import chalk from "chalk";
import type { WriteGate } from "./write-gate.js";

// ─── ANSI Escape Helpers ────────────────────────────────────────────────────

const CSI = "\x1b[";

function setScrollRegion(top: number, bottom: number): string {
  return `${CSI}${top};${bottom}r`;
}

function resetScrollRegion(): string {
  return `${CSI}r`;
}

function moveTo(row: number, col: number): string {
  return `${CSI}${row};${col}H`;
}

function eraseLine(): string {
  return `${CSI}2K`;
}

function saveCursor(): string {
  return "\x1b7";
}

function restoreCursor(): string {
  return "\x1b8";
}

const SHOW_CURSOR = `${CSI}?25h`;
const HIDE_CURSOR = `${CSI}?25l`;

// ─── Capability Detection ───────────────────────────────────────────────────

/**
 * Detect whether the current terminal supports the bottom dock.
 *
 * DECSTBM is universally supported in all modern terminal emulators.
 * Claude Code uses it on all TTY terminals (confirmed via screenshot).
 * Only disable for non-TTY (pipe/CI) and TERM=dumb.
 */
export function isBottomDockCapable(): boolean {
  if (!process.stdout.isTTY) return false;
  if (process.env.TERM === "dumb") return false;
  return true;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type DockMode = "idle" | "thinking" | "streaming" | "tool" | "approval";

export interface DockConfig {
  /** Model name displayed in the hint bar (right-aligned). */
  model: string;
  /** Input prompt string. Default: "> " */
  promptStr?: string;
}

// ─── Dock Height Constants ──────────────────────────────────────────────────

/** Dock heights by mode (number of terminal rows reserved at the bottom). */
const DOCK_HEIGHTS: Record<DockMode, number> = {
  idle: 3,       // separator + input + hint
  thinking: 4,   // separator + status + input + hint
  streaming: 4,
  tool: 4,
  approval: 8,   // separator + title + blank + detail + risk + blank + options + separator
};

// ─── BottomDock Class ───────────────────────────────────────────────────────

export class BottomDock {
  private readonly config: DockConfig;
  private readonly promptStr: string;

  private _active = false;
  private _mode: DockMode = "idle";
  private _statusText = "";
  private _elapsedMs = 0;
  private _tokens = 0;

  // Approval state
  private _approvalToolName = "";
  private _approvalDetail = "";
  private _approvalRisk = "";

  // Cached terminal dimensions (refreshed on resize and before every draw)
  private _rows = 0;
  private _cols = 0;

  // WriteGate integration (optional — when set, transcript writes go through it)
  private _writeGate: WriteGate | null = null;

  // Resize listener reference for cleanup
  private readonly _onResizeBound: () => void;
  private readonly _onExitBound: () => void;
  private _disposed = false;

  constructor(config: DockConfig) {
    this.config = config;
    this.promptStr = config.promptStr ?? "> ";
    this._onResizeBound = () => this.handleResize();
    this._onExitBound = () => this.dispose();
  }

  // ── WriteGate ──────────────────────────────────────────────────────────

  /**
   * Set a WriteGate instance for synchronized output.
   * When set, appendTranscript() routes content writes through the gate
   * instead of raw process.stdout.write().
   */
  setWriteGate(gate: WriteGate): void {
    this._writeGate = gate;
  }

  // ── Public Getters ──────────────────────────────────────────────────────

  /** Whether the dock is currently active (scroll region set). */
  get active(): boolean {
    return this._active;
  }

  /** The row number where the scroll region ends. Content should be written above this. */
  get scrollEndRow(): number {
    if (!this._active) return this._rows;
    return this._rows - this.currentDockHeight;
  }

  /**
   * The terminal row where the input prompt "> " is drawn.
   * Readline's cursor should be positioned here so typed text appears in the dock.
   *
   * Layout:  dockStart = rows - dockHeight + 1
   *   idle:    input is at dockStart + 1  (separator, INPUT, hint)
   *   active:  input is at dockStart + 2  (separator, status, INPUT, hint)
   */
  get inputRow(): number {
    if (!this._active) return this._rows;
    this.refreshDimensions();
    const dockStart = this._rows - this.currentDockHeight + 1;
    if (this._mode === "idle") {
      return dockStart + 1; // separator, then input
    }
    // thinking/streaming/tool: separator, status, then input
    return dockStart + 2;
  }

  // ── Initialization ──────────────────────────────────────────────────────

  /**
   * Initialize the bottom dock — set scroll region and draw.
   * Call once after the startup banner has been printed.
   *
   * If the terminal is not capable, this is a no-op and `active` remains false.
   */
  init(): void {
    if (!isBottomDockCapable()) return;
    if (this._disposed) return;

    this.refreshDimensions();

    // Minimum terminal height to avoid clobbering content
    if (this._rows < 12) return;

    this._active = true;
    this._mode = "idle";

    // Set scroll region: rows 1 through (total - dockHeight)
    const scrollBottom = this._rows - this.currentDockHeight;
    this.rawWrite(setScrollRegion(1, scrollBottom));

    // Move cursor to the bottom of the scroll region so the next append starts there
    this.rawWrite(moveTo(scrollBottom, 1));

    // Draw the dock area
    this.drawDock();

    // Listen for resize
    process.stdout.on("resize", this._onResizeBound);

    // Ensure cleanup on exit
    process.on("exit", this._onExitBound);
  }

  // ── Mode Control ────────────────────────────────────────────────────────

  /**
   * Switch the dock mode. This may change dock height and triggers a redraw.
   *
   * Mode heights:
   *   idle=3, thinking/streaming/tool=4, approval=8
   */
  setMode(mode: DockMode): void {
    if (!this._active) return;

    const prevHeight = this.currentDockHeight;
    this._mode = mode;
    const newHeight = this.currentDockHeight;

    // If dock height changed, re-set the scroll region
    if (prevHeight !== newHeight) {
      this.refreshDimensions();
      const scrollBottom = this._rows - newHeight;
      this.rawWrite(setScrollRegion(1, scrollBottom));
      // Move cursor into scroll region to avoid orphan writes
      this.rawWrite(moveTo(scrollBottom, 1));
    }

    this.drawDock();
  }

  // ── Status Updates ──────────────────────────────────────────────────────

  /**
   * Update the status line text. Only meaningful when mode is
   * thinking/streaming/tool. The text is displayed between the two separators.
   *
   * Example: "thinking...", "streaming...", "file_read src/app.ts"
   */
  updateStatus(text: string): void {
    if (!this._active) return;
    this._statusText = text;

    // Only redraw the status line (1 row), not the entire dock
    if (this._mode !== "idle" && this._mode !== "approval") {
      this.drawStatusLine();
    }
  }

  /**
   * Update real-time metrics displayed alongside the status text.
   *
   * @param elapsedMs - Elapsed time in milliseconds
   * @param tokens - Accumulated token count
   */
  updateMetrics(elapsedMs: number, tokens: number): void {
    if (!this._active) return;
    this._elapsedMs = elapsedMs;
    this._tokens = tokens;

    // Redraw status line with updated metrics
    if (this._mode !== "idle" && this._mode !== "approval") {
      this.drawStatusLine();
    }
  }

  // ── Transcript Append ───────────────────────────────────────────────────

  /**
   * Safely append content to the transcript (scroll region).
   *
   * Protocol:
   *   1. Save cursor position
   *   2. Move cursor to the end of the scroll region
   *   3. Write content (causes natural scrolling within the region)
   *   4. Redraw the dock area (it may have been overwritten by scroll)
   *   5. Restore cursor position
   *
   * When the dock is not active, this simply writes to stdout.
   */
  appendTranscript(content: string): void {
    if (!this._active) {
      // Fallback: direct write
      process.stdout.write(content);
      return;
    }

    this.rawWrite(HIDE_CURSOR);
    this.rawWrite(saveCursor());

    // Move to the last row of the scroll region
    const scrollEnd = this.scrollEndRow;
    this.rawWrite(moveTo(scrollEnd, 1));

    // Write content — terminal handles scrolling within the region.
    // Use WriteGate if available for synchronized output, otherwise
    // fall through to raw stdout.
    if (this._writeGate) {
      this._writeGate.write(content);
    } else {
      process.stdout.write(content);
    }

    // Redraw dock (content may have pushed into the dock area visually)
    this.drawDock();

    this.rawWrite(restoreCursor());
    this.rawWrite(SHOW_CURSOR);
  }

  /**
   * Append a user message to the transcript with a dark background bar.
   *
   * The message is displayed with bgHex("#333333") spanning the full terminal
   * width for visual separation from assistant content.
   */
  appendUserMessage(message: string): void {
    if (!this._active) {
      // Fallback: write with background
      const width = process.stdout.columns ?? 80;
      const lines = message.split("\n");
      for (const line of lines) {
        const bar = chalk.hex("#888")("> ");
        const padded = ` ${line}`.padEnd(width - 2);
        process.stdout.write(bar + chalk.bgHex("#333333").white(padded) + "\n");
      }
      return;
    }

    this.refreshDimensions();
    const lines = message.split("\n");
    const formatted = lines
      .map((line) => {
        const bar = chalk.hex("#888")("> ");
        const padded = ` ${line}`.padEnd(this._cols - 2);
        return bar + chalk.bgHex("#333333").white(padded);
      })
      .join("\n");

    this.appendTranscript(formatted + "\n");
  }

  // ── Approval ────────────────────────────────────────────────────────────

  /**
   * Show an approval block in the dock area.
   * Expands the dock height to 8 rows and resets the scroll region.
   *
   * @param toolName - Name of the tool requesting approval
   * @param detail - Detail string (command, file path, etc.)
   * @param risk - Risk level string ("critical", "high", "medium", "low")
   */
  showApproval(toolName: string, detail: string, risk: string): void {
    if (!this._active) return;

    this._approvalToolName = toolName;
    this._approvalDetail = detail;
    this._approvalRisk = risk;

    this.setMode("approval");
  }

  /**
   * Hide the approval block and restore normal dock (idle mode).
   */
  hideApproval(): void {
    if (!this._active) return;

    this._approvalToolName = "";
    this._approvalDetail = "";
    this._approvalRisk = "";

    this.setMode("idle");
  }

  // ── Redraw ──────────────────────────────────────────────────────────────

  /**
   * Redraw the entire dock area.
   * Called after resize, mode change, or transcript append.
   */
  redraw(): void {
    if (!this._active) return;
    this.drawDock();
  }

  // ── Resize ──────────────────────────────────────────────────────────────

  /**
   * Handle terminal resize.
   * Re-reads dimensions, re-sets the scroll region, and redraws the dock.
   */
  handleResize(): void {
    if (this._disposed) return;

    this.refreshDimensions();

    // If terminal is too small, temporarily deactivate (not dispose)
    if (this._rows < 12) {
      if (this._active) {
        this._active = false;
        this.rawWrite(resetScrollRegion());
      }
      return;
    }

    // Re-activate if was temporarily deactivated due to small size
    if (!this._active) {
      this._active = true;
    }

    const scrollBottom = this._rows - this.currentDockHeight;
    this.rawWrite(setScrollRegion(1, scrollBottom));
    this.drawDock();
  }

  // ── Dispose ─────────────────────────────────────────────────────────────

  /**
   * Clean up — reset scroll region to full screen, show cursor, remove listeners.
   *
   * Safe to call multiple times.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    if (this._active) {
      this._active = false;

      // Reset scroll region to full terminal
      this.rawWrite(resetScrollRegion());

      // Move cursor to bottom of terminal to prevent ^C flooding into banner area
      this.refreshDimensions();
      this.rawWrite(moveTo(this._rows, 1));

      // Show cursor (may have been hidden)
      this.rawWrite(SHOW_CURSOR);

      // Remove listeners
      process.stdout.removeListener("resize", this._onResizeBound);
      process.removeListener("exit", this._onExitBound);
    }
  }

  // ── Private: Drawing ────────────────────────────────────────────────────

  /** Get the current dock height based on mode. */
  private get currentDockHeight(): number {
    return DOCK_HEIGHTS[this._mode];
  }

  /** Refresh cached terminal dimensions. */
  private refreshDimensions(): void {
    this._rows = process.stdout.rows ?? 24;
    this._cols = process.stdout.columns ?? 80;
  }

  /** Raw write to stdout — no tracking, no processing. */
  private rawWrite(data: string): void {
    process.stdout.write(data);
  }

  /**
   * Draw the entire dock area at the bottom of the terminal.
   * Saves and restores cursor position to avoid disrupting content.
   */
  private drawDock(): void {
    this.refreshDimensions();

    const dockHeight = this.currentDockHeight;
    const dockStart = this._rows - dockHeight + 1;

    // NOTE: No saveCursor/restoreCursor here — DECSC is single-slot.
    // Callers (appendTranscript, updateStatus) manage cursor save/restore
    // at the outer level to avoid nesting conflicts.

    if (this._mode === "approval") {
      this.drawApprovalDock(dockStart);
    } else if (this._mode === "idle") {
      this.drawIdleDock(dockStart);
    } else {
      this.drawActiveDock(dockStart);
    }
  }

  /**
   * Draw the idle dock (3 rows):
   *   Row 1: separator
   *   Row 2: > [input area]  (readline cursor lives here)
   *   Row 3: hint bar (? for shortcuts)
   */
  private drawIdleDock(startRow: number): void {
    // Row 1: Separator
    this.rawWrite(moveTo(startRow, 1));
    this.rawWrite(eraseLine());
    this.rawWrite(chalk.gray("\u2500".repeat(Math.min(this._cols, 120))));

    // Row 2: Input prompt — dock draws "> ", readline has prompt suppressed
    this.rawWrite(moveTo(startRow + 1, 1));
    this.rawWrite(eraseLine());
    this.rawWrite(this.promptStr);

    // Row 3: Hint bar
    this.rawWrite(moveTo(startRow + 2, 1));
    this.rawWrite(eraseLine());
    this.drawHintBar("? for shortcuts");
  }

  /**
   * Draw the active dock (4 rows — thinking/streaming/tool):
   *   Row 1: separator
   *   Row 2: status line (ABOVE input)
   *   Row 3: > [input area]  (readline cursor lives here)
   *   Row 4: hint bar (esc to interrupt)
   */
  private drawActiveDock(startRow: number): void {
    // Row 1: Separator
    this.rawWrite(moveTo(startRow, 1));
    this.rawWrite(eraseLine());
    this.rawWrite(chalk.gray("\u2500".repeat(Math.min(this._cols, 120))));

    // Row 2: Status line (above input, like Claude Code)
    this.rawWrite(moveTo(startRow + 1, 1));
    this.rawWrite(eraseLine());
    this.rawWrite(this.formatStatusLine());

    // Row 3: Input prompt — dock draws "> ", readline has prompt suppressed
    this.rawWrite(moveTo(startRow + 2, 1));
    this.rawWrite(eraseLine());
    this.rawWrite(this.promptStr);

    // Row 4: Hint bar
    this.rawWrite(moveTo(startRow + 3, 1));
    this.rawWrite(eraseLine());
    this.drawHintBar("esc to interrupt");
  }

  /**
   * Draw the approval dock (8 rows):
   *   Row 1: separator
   *   Row 2: warning title
   *   Row 3: blank
   *   Row 4: detail (command/file)
   *   Row 5: risk level
   *   Row 6: blank
   *   Row 7: key options
   *   Row 8: separator
   */
  private drawApprovalDock(startRow: number): void {
    // Row 1: separator
    this.rawWrite(moveTo(startRow, 1));
    this.rawWrite(eraseLine());
    this.rawWrite(chalk.gray("\u2500".repeat(Math.min(this._cols, 120))));

    // Row 2: warning title
    this.rawWrite(moveTo(startRow + 1, 1));
    this.rawWrite(eraseLine());
    this.rawWrite(chalk.yellow(`\u26A0 ${this._approvalToolName} requires approval`));

    // Row 3: blank
    this.rawWrite(moveTo(startRow + 2, 1));
    this.rawWrite(eraseLine());

    // Row 4: detail
    this.rawWrite(moveTo(startRow + 3, 1));
    this.rawWrite(eraseLine());
    if (this._approvalDetail) {
      const truncated = this._approvalDetail.length > this._cols - 4
        ? this._approvalDetail.slice(0, this._cols - 7) + "..."
        : this._approvalDetail;
      this.rawWrite(`  ${chalk.bold(truncated)}`);
    }

    // Row 5: risk
    this.rawWrite(moveTo(startRow + 4, 1));
    this.rawWrite(eraseLine());
    this.rawWrite(`  Risk: ${this.formatRisk(this._approvalRisk)}`);

    // Row 6: blank
    this.rawWrite(moveTo(startRow + 5, 1));
    this.rawWrite(eraseLine());

    // Row 7: key options
    this.rawWrite(moveTo(startRow + 6, 1));
    this.rawWrite(eraseLine());
    this.rawWrite(
      `  ${chalk.green("[y]")} Yes  ` +
      `${chalk.red("[n]")} No  ` +
      `${chalk.cyan("[a]")} Always  ` +
      `${chalk.dim("[s]")} Skip`
    );

    // Row 8: separator
    this.rawWrite(moveTo(startRow + 7, 1));
    this.rawWrite(eraseLine());
    this.rawWrite(chalk.gray("\u2500".repeat(Math.min(this._cols, 120))));
  }

  /**
   * Draw only the status line (row 2 in active dock).
   * Used for efficient single-line updates without redrawing the entire dock.
   */
  private drawStatusLine(): void {
    this.refreshDimensions();

    const dockStart = this._rows - this.currentDockHeight + 1;
    const statusRow = dockStart + 1; // Second row in the dock

    this.rawWrite(saveCursor());
    this.rawWrite(moveTo(statusRow, 1));
    this.rawWrite(eraseLine());
    this.rawWrite(this.formatStatusLine());
    this.rawWrite(restoreCursor());
  }

  /**
   * Format the status line content based on current state.
   *
   * Examples:
   *   "\u00B7\u00B7 thinking... (12s \u00B7 \u2193 1.2k)"
   *   "\u00B7\u00B7 streaming... (3.8s \u00B7 \u2193 47.2k)"
   *   "\u00B7\u00B7 \u2699 file_read src/app.ts"
   */
  private formatStatusLine(): string {
    const prefix = chalk.dim("\u00B7\u00B7 ");
    const statusText = this._statusText || this.defaultStatusText();
    const metrics = this.formatMetrics();

    if (metrics) {
      return `${prefix}${statusText} ${chalk.dim(`(${metrics})`)}`;
    }
    return `${prefix}${statusText}`;
  }

  /** Get default status text based on current mode. */
  private defaultStatusText(): string {
    switch (this._mode) {
      case "thinking":
        return "thinking...";
      case "streaming":
        return "streaming...";
      case "tool":
        return "running tool...";
      default:
        return "";
    }
  }

  /**
   * Get a context-aware hint for the dock hint bar.
   * Returns mode-specific hints: "generating code...", "preparing changes...", etc.
   */
  getContextHint(contentHint?: string): string {
    if (contentHint) return contentHint;
    switch (this._mode) {
      case "streaming":
        return "generating code...";
      case "tool":
        return "preparing changes...";
      case "thinking":
        return "esc to interrupt";
      default:
        return "? for shortcuts";
    }
  }

  /**
   * Format elapsed time and token metrics.
   *
   * Returns empty string if no metrics available.
   * Example: "12s \u00B7 \u2193 1.2k"
   */
  private formatMetrics(): string {
    const parts: string[] = [];

    if (this._elapsedMs > 0) {
      const seconds = Math.round(this._elapsedMs / 1000);
      parts.push(`${seconds}s`);
    }

    if (this._tokens > 0) {
      parts.push(`\u2193 ${this.formatTokenCount(this._tokens)}`);
    }

    return parts.join(" \u00B7 ");
  }

  /** Format a token count compactly: 1234 -> "1.2k", 56789 -> "56.8k". */
  private formatTokenCount(n: number): string {
    if (n < 1000) return String(n);
    return (n / 1000).toFixed(1) + "k";
  }

  /**
   * Draw the hint bar with left + right aligned content.
   *
   * Left side: hint text (e.g., "? for shortcuts" or "esc to interrupt")
   * Right side: model name
   */
  private drawHintBar(leftHint: string): void {
    const left = `  ${leftHint}`;
    const right = this.config.model;

    // Calculate padding between left and right
    const gap = Math.max(1, this._cols - left.length - right.length - 2);
    const line = left + " ".repeat(gap) + right;

    this.rawWrite(chalk.dim(line));
  }

  /**
   * Format risk level with appropriate color.
   */
  private formatRisk(level: string): string {
    switch (level.toLowerCase()) {
      case "critical":
        return chalk.bgRed.white.bold(" CRITICAL ");
      case "high":
        return chalk.red.bold("HIGH");
      case "medium":
        return chalk.yellow("MEDIUM");
      case "low":
        return chalk.dim("LOW");
      default:
        return chalk.dim(level);
    }
  }
}
