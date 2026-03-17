/**
 * YUAN CLI — Readline Input
 *
 * Native Node.js readline-based input handler for the CLI transcript.
 * No Ink, no React, no third-party input libs — just node:readline.
 *
 * Features:
 *   - Persistent history (~/.yuan/history, max 1000 lines)
 *   - Multiline input (backslash continuation + paste detection)
 *   - Slash command tab-completion
 *   - Ctrl+C handling (abort agent / clear input / exit)
 *   - Prompt lock/unlock for agent processing phases
 *   - CJK-safe (readline handles width when terminal: true)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const YUAN_DIR = path.join(os.homedir(), ".yuan");
const HISTORY_PATH = path.join(YUAN_DIR, "history");
const MAX_HISTORY = 1000;

const SLASH_COMMANDS = [
  "/help",
  "/exit",
  "/quit",
  "/clear",
  "/model",
  "/mode",
  "/compact",
  "/history",
  "/undo",
] as const;

const DEFAULT_PROMPT = "> ";
const CONTINUATION_PROMPT = ".. ";

/** Threshold in ms — lines arriving faster than this are treated as a paste. */
const PASTE_THRESHOLD_MS = 50;

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ReadlineInputOptions {
  /** Callback when user submits a message */
  onSubmit: (message: string) => void;
  /** Callback when user presses Ctrl+C during agent run */
  onAbort: () => void;
  /** Callback for slash commands (command without leading /, plus args) */
  onCommand: (command: string, args: string) => void;
 /** First Ctrl+C on empty prompt */
  onEmptyInterrupt?: () => void;
  /** Second Ctrl+C on empty prompt — caller should clean UI before exit */
  onDoubleInterruptExit?: () => void;
  /** Custom prompt string (default: '> ') */
  prompt?: string;
}

export class ReadlineInput {
  // -- Options --------------------------------------------------------------
  private readonly onSubmit: (message: string) => void;
  private readonly onAbort: () => void;
  private readonly onCommand: (command: string, args: string) => void;
  private readonly onEmptyInterrupt?: () => void;
  private readonly onDoubleInterruptExit?: () => void;
  private readonly promptStr: string;

  // -- Readline -------------------------------------------------------------
  private rl: readline.Interface | null = null;

  // -- State ----------------------------------------------------------------
  private locked = false;
  private started = false;

  /** Lines accumulated during a backslash-continuation sequence. */
  private continuationLines: string[] = [];

  /** Tracks whether we're in continuation mode (previous line ended with \). */
  private inContinuation = false;

  // -- Paste detection ------------------------------------------------------
  /** Timestamp of the last raw data chunk from stdin. */
  private lastDataTime = 0;
  /** Buffer for lines that arrived within the paste threshold. */
  private pasteBuffer: string[] = [];
  /** Timer handle for flushing the paste buffer. */
  private pasteTimer: ReturnType<typeof setTimeout> | null = null;

  // -- Ctrl+C double-tap ---------------------------------------------------
  private ctrlCPending = false;
  private ctrlCTimer: ReturnType<typeof setTimeout> | null = null;

  // -- Line handler (stored so we can remove/re-attach) ---------------------
  private lineHandler: ((line: string) => void) | null = null;
  private exitOnClose = true;
  // =========================================================================
  // Constructor
  // =========================================================================

  constructor(options: ReadlineInputOptions) {
    this.onSubmit = options.onSubmit;
    this.onAbort = options.onAbort;
    this.onCommand = options.onCommand;
    this.onEmptyInterrupt = options.onEmptyInterrupt;
    this.onDoubleInterruptExit = options.onDoubleInterruptExit;
    this.promptStr = options.prompt ?? DEFAULT_PROMPT;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /** Start accepting input. */
  start(): void {
    if (this.started) return;
    this.started = true;

    const history = this.loadHistory();

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      historySize: 500,
      history,
      completer: this.completer.bind(this),
      prompt: this.promptStr,
    });

    // Attach the line handler.
    this.lineHandler = this.handleLine.bind(this);
    this.rl.on("line", this.lineHandler);

    // Ctrl+C
    this.rl.on("SIGINT", this.handleSigint.bind(this));

    // Handle close (Ctrl+D or EOF).
    this.rl.on("close", () => {
      this.started = false;
        if (this.exitOnClose) {
        process.exit(0);
      }
    });
  }

  /** Lock input — agent is processing. Ctrl+C still works for abort. */
  lock(): void {
    if (this.locked) return;
    this.locked = true;

    if (this.rl && this.lineHandler) {
      this.rl.removeListener("line", this.lineHandler);
      this.rl.setPrompt("");
    }
  }

  /**
   * Unlock input and re-show prompt.
   * @param options.suppressPrompt - When true, don't restore the "> " prompt
   *   (used when BottomDock draws the prompt instead of readline).
   */
  unlock(options?: { suppressPrompt?: boolean }): void {
    if (!this.locked) return;
    this.locked = false;

    // Reset continuation state — any partial input is discarded on unlock.
    this.continuationLines = [];
    this.inContinuation = false;

    if (this.rl && this.lineHandler) {
      this.rl.on("line", this.lineHandler);
      if (options?.suppressPrompt) {
        this.rl.setPrompt("");
      } else {
        this.rl.setPrompt(this.promptStr);
      }
    }
  }

  /** Close readline and clean up. */
 close(options?: { exitProcess?: boolean }): void {
    this.clearTimers();
    this.exitOnClose = options?.exitProcess ?? false;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    this.started = false;
  }

  /** Whether input is currently locked. */
  get isLocked(): boolean {
    return this.locked;
  }

  /** Hide the readline prompt (when dock renders the prompt instead). */
  suppressPrompt(): void {
    if (this.rl) this.rl.setPrompt("");
  }
  /** Render the prompt at the current cursor position. */
  prompt(): void {
    if (!this.rl || this.locked) return;
    this.rl.setPrompt(this.promptStr);
    this.refreshLine();
  }

  /**
   * Write transcript output above the current prompt, then redraw the prompt/input.
   * This prevents the input line from shaking or duplicating while stdout is written.
   */
  runAbovePrompt(writer: () => void): void {
    if (!this.rl || this.locked) {
      writer();
      return;
    }

    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    writer();
    this.refreshLine();
  }

  // =========================================================================
  // Completer — slash commands
  // =========================================================================

  private completer(
    partial: string,
  ): [completions: string[], matched: string] {
    if (!partial.startsWith("/")) {
      return [[], partial];
    }
    const hits = SLASH_COMMANDS.filter((c) => c.startsWith(partial));
    return [hits.length ? [...hits] : [...SLASH_COMMANDS], partial];
  }

  // =========================================================================
  // Line handling
  // =========================================================================

  private handleLine(line: string): void {
    // If we detected a paste (rapid multi-line input), accumulate and defer.
    if (this.isPasteInProgress()) {
      this.pasteBuffer.push(line);
      this.schedulePasteFlush();
      return;
    }

    this.processLine(line);
  }

  /**
   * Core line processing — handles continuation, slash commands, and submit.
   */
  private processLine(line: string): void {
    // Check for backslash continuation.
    if (line.endsWith("\\")) {
      const content = line.slice(0, -1); // strip trailing backslash
      this.continuationLines.push(content);
      this.inContinuation = true;
      if (this.rl) {
        this.rl.setPrompt(CONTINUATION_PROMPT);
        this.rl.prompt();
      }
      return;
    }

    // If we were in continuation, this is the final line.
    if (this.inContinuation) {
      this.continuationLines.push(line);
      const fullMessage = this.continuationLines.join("\n");
      this.resetContinuation();
      this.submitInput(fullMessage);
      return;
    }

    // Single-line input.
    const trimmed = line.trim();

    // Empty line — just re-prompt (don't submit empty).
    if (trimmed.length === 0) {
      if (this.rl) this.rl.prompt();
      return;
    }

    // Slash command check.
    if (trimmed.startsWith("/")) {
      this.handleSlashCommand(trimmed);
      return;
    }

    this.submitInput(trimmed);
  }

  /**
   * Submit the final user input — append to history and invoke callback.
   */
  private submitInput(message: string): void {
    if (message.trim().length === 0) {
      if (this.rl) this.rl.prompt();
      return;
    }

    // Append to persistent history.
    this.appendHistory(message);

    this.onSubmit(message);
    // Caller is expected to call lock() after this if agent starts.
  }

  /**
   * Handle a slash command line.
   */
  private handleSlashCommand(input: string): void {
    // Split into command and args: "/model gpt-4" → command="model", args="gpt-4"
    const spaceIdx = input.indexOf(" ");
    let command: string;
    let args: string;
    if (spaceIdx === -1) {
      command = input.slice(1); // strip leading /
      args = "";
    } else {
      command = input.slice(1, spaceIdx);
      args = input.slice(spaceIdx + 1).trim();
    }

    this.onCommand(command, args);
    // Re-prompt after command handling.
    if (this.rl && !this.locked) {
      this.rl.prompt();
    }
  }

  // =========================================================================
  // Ctrl+C handling
  // =========================================================================

  private handleSigint(): void {
    // 1. If locked (agent running) → abort.
    if (this.locked) {
      this.onAbort();
      return;
    }

    // 2. If in continuation mode → cancel continuation and re-prompt.
    if (this.inContinuation) {
      this.resetContinuation();
      process.stdout.write("\n");
      if (this.rl) {
        this.rl.setPrompt(this.promptStr);
        this.rl.prompt();
      }
      return;
    }

    // 3. If current line has text → clear it.
    if (this.rl) {
      const rlAny = this.rl as readline.Interface & {
        line?: string;
        cursor?: number;
      };
      const currentLine = rlAny.line ?? "";
      if (currentLine.length > 0) {
        rlAny.line = "";
        rlAny.cursor = 0;
        this.ctrlCPending = false;
        if (this.ctrlCTimer) {
          clearTimeout(this.ctrlCTimer);
          this.ctrlCTimer = null;
        }
        this.refreshLine();
        return;
      }
    }

    // 4. Empty line — double-tap to exit.
    if (this.ctrlCPending) {
      // Second Ctrl+C — exit.
      this.clearTimers();
      this.onDoubleInterruptExit?.();
      this.close({ exitProcess: false });
      process.exit(130);
    }

    // First Ctrl+C on empty line.
    this.ctrlCPending = true;
    this.onEmptyInterrupt?.();

    this.ctrlCTimer = setTimeout(() => {
      this.ctrlCPending = false;
      this.ctrlCTimer = null;
    }, 2000);
  }

  // =========================================================================
  // Paste detection
  // =========================================================================

  /**
   * Raw stdin data listener — used purely for timing to detect pastes.
   * Arrow function so `this` is bound and we can cleanly remove the listener.
   */
  private handleRawData = (_chunk: Buffer): void => {
    this.lastDataTime = Date.now();
  };

  /** Returns true if recent data arrived within the paste threshold. */
  private isPasteInProgress(): boolean {
    return Date.now() - this.lastDataTime < PASTE_THRESHOLD_MS;
  }

  /** Schedule a deferred flush for the paste buffer. */
  private schedulePasteFlush(): void {
    if (this.pasteTimer) clearTimeout(this.pasteTimer);
    this.pasteTimer = setTimeout(() => {
      this.flushPasteBuffer();
      this.pasteTimer = null;
    }, PASTE_THRESHOLD_MS + 10);
  }

  /** Flush accumulated paste lines as a single multiline submission. */
  private flushPasteBuffer(): void {
    if (this.pasteBuffer.length === 0) return;
    const combined = this.pasteBuffer.join("\n");
    this.pasteBuffer = [];
    this.submitInput(combined);
  }

 /** Safely redraw current prompt + input buffer. */
  private refreshLine(): void {
    if (!this.rl) return;

    const rlAny = this.rl as readline.Interface & {
      _refreshLine?: () => void;
    };

    if (typeof rlAny._refreshLine === "function") {
      rlAny._refreshLine();
      return;
    }

    this.rl.prompt(true);
  }

  // =========================================================================
  // Continuation helpers
  // =========================================================================

  private resetContinuation(): void {
    this.continuationLines = [];
    this.inContinuation = false;
    if (this.rl) {
      this.rl.setPrompt(this.promptStr);
    }
  }

  // =========================================================================
  // History persistence (~/.yuan/history)
  // =========================================================================

  /** Load history lines from disk. Returns array for readline's `history` option. */
  private loadHistory(): string[] {
    try {
      if (!fs.existsSync(HISTORY_PATH)) return [];
      const raw = fs.readFileSync(HISTORY_PATH, "utf-8");
      const lines = raw
        .split("\n")
        .filter((l) => l.length > 0 && !l.startsWith("#"));
      // readline expects most-recent-first.
      return lines.slice(-MAX_HISTORY).reverse();
    } catch {
      return [];
    }
  }

  /** Append a single entry to the history file. */
  private appendHistory(line: string): void {
    try {
      if (!fs.existsSync(YUAN_DIR)) {
        fs.mkdirSync(YUAN_DIR, { recursive: true, mode: 0o700 });
      }

      // If the file doesn't exist yet, write the header.
      if (!fs.existsSync(HISTORY_PATH)) {
        fs.writeFileSync(HISTORY_PATH, "# YUAN CLI History\n", {
          encoding: "utf-8",
          mode: 0o600,
        });
      }

      // Append (replace any embedded newlines with escaped form for safety).
      const safe = line.replace(/\n/g, "\\n");
      fs.appendFileSync(HISTORY_PATH, safe + "\n", { encoding: "utf-8" });

      // Trim if over limit.
      this.trimHistory();
    } catch {
      // Non-fatal — history is best-effort.
    }
  }

  /** Trim the history file to MAX_HISTORY lines. */
  private trimHistory(): void {
    try {
      const raw = fs.readFileSync(HISTORY_PATH, "utf-8");
      const lines = raw.split("\n");
      // Keep the header comment and the last MAX_HISTORY non-empty lines.
      const header = lines.filter((l) => l.startsWith("#"));
      const entries = lines.filter((l) => l.length > 0 && !l.startsWith("#"));
      if (entries.length <= MAX_HISTORY) return;

      const trimmed = entries.slice(entries.length - MAX_HISTORY);
      const content = [...header, ...trimmed, ""].join("\n");
      fs.writeFileSync(HISTORY_PATH, content, {
        encoding: "utf-8",
        mode: 0o600,
      });
    } catch {
      // Non-fatal.
    }
  }

  // =========================================================================
  // Cleanup helpers
  // =========================================================================

  private clearTimers(): void {
    if (this.ctrlCTimer) {
      clearTimeout(this.ctrlCTimer);
      this.ctrlCTimer = null;
    }
    if (this.pasteTimer) {
      clearTimeout(this.pasteTimer);
      this.pasteTimer = null;
    }
    this.ctrlCPending = false;
  }
}
