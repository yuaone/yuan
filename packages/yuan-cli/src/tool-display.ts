/**
 * @module tool-display
 * @description Inline tool-call progress display for the YUAN CLI transcript.
 *
 * Renders tool calls as single-line entries in the terminal transcript:
 *   - Active tool: braille spinner animation via `\r` rewrite
 *   - Completed tool: static line with duration
 *   - Failed tool: static line with red cross and duration
 *
 * Design constraints:
 *   - chalk only, no Ink/React
 *   - process.stdout.write() exclusively
 *   - Only the CURRENT line is ever modified (via `\r`)
 *   - Past transcript lines are never touched
 *   - Works in SSH, tmux, PowerShell, cmd, VSCode terminal
 */

import chalk from "chalk";
import type { WriteGate } from "./write-gate.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Braille spinner frames (80ms per frame). */
const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** ASCII fallback for TERM=dumb / non-unicode terminals. */
const ASCII_FRAMES = [".", "..", "..."] as const;

const SPINNER_INTERVAL_MS = 80;

/** Column widths for the fixed-width layout. */
const ICON_COL = 5;       // "  ⚙  " or "  ✓  "
const NAME_COL = 14;      // tool name, left-aligned
const ARGS_MAX = 40;      // arg summary, truncated
const DURATION_COL = 8;   // "  0.1s" right-aligned

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Clear the current line and move cursor to column 0. */
const CLEAR_LINE = "\x1b[2K\r";

/** Detect whether the terminal supports unicode glyphs. */
function detectUnicode(): boolean {
  const term = process.env.TERM ?? "";
  if (term === "dumb") return false;
  // Windows cmd often lacks unicode; modern terminals generally support it
  const lang = process.env.LANG ?? process.env.LC_ALL ?? "";
  if (/utf-?8/i.test(lang)) return true;
  // Default: assume unicode on non-Windows, ASCII on Windows without WT
  if (process.platform === "win32") {
    return !!process.env.WT_SESSION; // Windows Terminal supports unicode
  }
  return true;
}

/** Detect whether the terminal supports colors. */
function detectColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return process.stdout.isTTY === true;
}

/** Truncate a string to `max` characters, appending ellipsis if needed. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

/** Pad or truncate a string to exactly `width` characters, left-aligned. */
function padLeft(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  return text + " ".repeat(width - text.length);
}

/** Format milliseconds as seconds with one decimal: "0.1s", "12.3s". */
function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Extract a human-readable arg summary from a tool's arguments object.
 * Returns a short string suitable for display next to the tool name.
 */
function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  const normalized = toolName.toLowerCase().replace(/-/g, "_");

  switch (normalized) {
    case "file_read":
    case "read_file":
    case "file_write":
    case "write_file":
    case "file_edit":
    case "edit_file": {
      const p = (args.file_path ?? args.path ?? args.filePath ?? "") as string;
      return truncate(String(p), 50);
    }

    case "shell_exec": {
      const cmd = (args.command ?? args.cmd ?? "") as string;
      return truncate(String(cmd), ARGS_MAX);
    }

    case "web_search": {
      const q = (args.query ?? args.q ?? "") as string;
      return `"${truncate(String(q), ARGS_MAX - 2)}"`;
    }

    case "parallel_web_search": {
      const queries = args.queries;
      if (Array.isArray(queries)) {
        return `${queries.length} queries`;
      }
      return "";
    }

    case "glob": {
      const pattern = (args.pattern ?? args.glob ?? "") as string;
      return truncate(String(pattern), ARGS_MAX);
    }

    case "grep": {
      const pattern = (args.pattern ?? args.regex ?? args.query ?? "") as string;
      return truncate(String(pattern), ARGS_MAX);
    }

    default: {
      // First string-valued arg, truncated
      for (const val of Object.values(args)) {
        if (typeof val === "string" && val.length > 0) {
          return truncate(val, ARGS_MAX);
        }
      }
      return "";
    }
  }
}

// ─── ToolDisplay ─────────────────────────────────────────────────────────────

export interface ToolDisplayOptions {
  /** Whether to use unicode glyphs or ASCII fallback. */
  unicode: boolean;
  /** Whether to use colors. */
  color: boolean;
  /** Optional WriteGate for synchronized output. */
  writeGate: WriteGate;
}

interface ActiveTool {
  toolName: string;
  argsSummary: string;
  frameIndex: number;
}

export class ToolDisplay {
  private readonly unicode: boolean;
  private readonly useColor: boolean;
  private readonly frames: readonly string[];
  private _writeGate: WriteGate | null = null;

  private activeTool: ActiveTool | null = null;
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options?: Partial<ToolDisplayOptions>) {
    this.unicode = options?.unicode ?? detectUnicode();
    this.useColor = options?.color ?? detectColor();
    this.frames = this.unicode ? BRAILLE_FRAMES : ASCII_FRAMES;
    if (options?.writeGate) this._writeGate = options.writeGate;
  }

  /** Set a WriteGate instance for synchronized output. */
  setWriteGate(gate: WriteGate): void {
    this._writeGate = gate;
  }

  // ─── Public API ──────────────────────────────────────────────────────

  /** Start showing a tool in progress (shows spinner on current line). */
  startTool(toolName: string, args: Record<string, unknown>): void {
    // If another tool is already spinning, finalize it first
    this.flushActive();

    const argsSummary = summarizeArgs(toolName, args);

    this.activeTool = {
      toolName,
      argsSummary,
      frameIndex: 0,
    };

    // Render first frame immediately
    this.renderSpinner();

    // Start animation interval
    this.spinnerInterval = setInterval(() => {
      if (!this.activeTool) return;
      this.activeTool.frameIndex =
        (this.activeTool.frameIndex + 1) % this.frames.length;
      this.renderSpinner();
    }, SPINNER_INTERVAL_MS);
  }

  /** Mark the current tool as completed (success or failure). */
  completeTool(toolName: string, success: boolean, durationMs: number): void {
    // Clear the spinner interval
    this.clearInterval();

    // Build the final static line
    const line = this.buildFinalLine(toolName, success, durationMs);

    // Overwrite current line and finalize with newline
    this.output(`${CLEAR_LINE}${line}\n`);

    this.activeTool = null;
  }

  /**
   * Force-finalize any active spinner.
   * Call this before emitting text output (e.g. text_delta) to ensure
   * the transcript stays coherent.
   */
  flushActive(): void {
    if (!this.activeTool) return;

    this.clearInterval();

    // Write whatever the spinner was showing as a static line, then newline
    const { toolName, argsSummary } = this.activeTool;
    const icon = this.colorize("dim", this.unicode ? "⚙" : "*");
    const name = this.colorize("dim", padLeft(toolName, NAME_COL));
    const args = this.colorize("white", truncate(argsSummary, ARGS_MAX));
    const line = `  ${icon}  ${name}${args}`;

    this.output(`${CLEAR_LINE}${line}\n`);
    this.activeTool = null;
  }

  /** Clean up spinner interval. Call on shutdown. */
  dispose(): void {
    this.clearInterval();
    this.activeTool = null;
  }

  // ─── Private ─────────────────────────────────────────────────────────

  /** Write to stdout through WriteGate if available, otherwise direct. */
  private output(text: string): void {
    if (this._writeGate) {
      this._writeGate.write(text);
    } else {
      process.stdout.write(text);
    }
  }

  /** Render the current spinner frame to stdout (overwrites current line). */
  private renderSpinner(): void {
    if (!this.activeTool) return;

    const { toolName, argsSummary, frameIndex } = this.activeTool;
    const spinner = this.frames[frameIndex];

    const icon = this.colorize("dim", this.unicode ? "⚙" : "*");
    const name = this.colorize("dim", padLeft(toolName, NAME_COL));
    const args = this.colorize("white", padLeft(truncate(argsSummary, ARGS_MAX), ARGS_MAX));
    const trail = this.colorize("dim", spinner);

    const line = `  ${icon}  ${name}${args}  ${trail}`;
    this.output(`${CLEAR_LINE}${line}`);
  }

  /** Build the final (static) line for a completed tool call. */
  private buildFinalLine(
    toolName: string,
    success: boolean,
    durationMs: number,
  ): string {
    // Use the stored arg summary if it matches, otherwise empty
    const argsSummary =
      this.activeTool?.toolName === toolName
        ? this.activeTool.argsSummary
        : "";

    let icon: string;
    if (success) {
      icon = this.colorize("green", this.unicode ? "✓" : "v");
    } else {
      icon = this.colorize("red", this.unicode ? "✗" : "x");
    }

    const name = this.colorize(
      success ? "reset" : "red",
      padLeft(toolName, NAME_COL),
    );
    const args = this.colorize("white", padLeft(truncate(argsSummary, ARGS_MAX), ARGS_MAX));
    const dur = this.colorize("dim", formatDuration(durationMs).padStart(DURATION_COL));

    return `  ${icon}  ${name}${args}${dur}`;
  }

  /** Clear the spinner interval if active. */
  private clearInterval(): void {
    if (this.spinnerInterval !== null) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }
  }

  /**
   * Apply color to text. When color is disabled, returns plain text.
   * Supported roles: dim, green, red, white, reset.
   */
  private colorize(
    role: "dim" | "green" | "red" | "white" | "reset",
    text: string,
  ): string {
    if (!this.useColor) return text;

    switch (role) {
      case "dim":
        return chalk.dim(text);
      case "green":
        return chalk.green(text);
      case "red":
        return chalk.red(text);
      case "white":
        return chalk.white(text);
      case "reset":
        return text;
    }
  }
}
