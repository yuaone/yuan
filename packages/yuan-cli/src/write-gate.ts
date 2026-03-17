/**
 * write-gate.ts — Single stdout owner for the YUAN CLI Content-Aware Pacer.
 *
 * ALL terminal output MUST go through WriteGate. No other code may call
 * process.stdout.write() directly.
 *
 * Features:
 *   - DEC Mode 2026 synchronized output — wraps multi-line blocks in
 *     \x1b[?2026h ... \x1b[?2026l to prevent tearing in capable terminals
 *   - Reentrancy guard — writes during an active write() are queued
 *   - Conservative capability detection — only enables sync output for
 *     known-good terminals (TTY, not CI, not dumb, known emulators)
 *   - Lock mechanism — prevents interleaved writes from dock/spinner/pacer
 */

// ─── DEC Private Mode 2026 (Synchronized Output) ────────────────────────────

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

// ─── Pending Write Entry ─────────────────────────────────────────────────────

interface PendingWrite {
  content: string;
  useSyncOutput: boolean;
}

// ─── Capability Detection ────────────────────────────────────────────────────

/**
 * Conservatively detect whether the terminal supports DEC Mode 2026
 * (synchronized output).
 *
 * Rules (all must pass):
 *   1. Must be a TTY
 *   2. Not a CI environment
 *   3. Not TERM=dumb
 *   4. Known terminal emulator that supports the mode
 *
 * When in doubt, returns false — the worst case is minor flicker,
 * never broken output.
 */
function detectSyncCapability(): boolean {
  // Must be a TTY
  if (!process.stdout.isTTY) return false;

  // Not CI
  if (process.env.CI || process.env.GITHUB_ACTIONS) return false;

  // Not dumb
  if (process.env.TERM === "dumb") return false;

  const termProgram = (process.env.TERM_PROGRAM ?? "").toLowerCase();

  // Known capable terminals
  if (termProgram === "ghostty") return true;
  if (termProgram === "wezterm") return true;
  if (termProgram === "iterm.app") return true;
  if (termProgram === "vscode") return true; // xterm.js

  // Windows Terminal
  if (process.env.WT_SESSION) return true;

  // tmux (Anthropic upstream PR confirms support)
  if (process.env.TMUX) return true;

  // Default: conservative — no sync output
  return false;
}

// ─── WriteGate ───────────────────────────────────────────────────────────────

/**
 * Single owner of process.stdout.write().
 *
 * Provides synchronized output (DEC Mode 2026), reentrancy protection,
 * and a lock mechanism for exclusive multi-step write sequences
 * (dock redraws, spinner frames, etc.).
 */
export class WriteGate {
  private locked = false;
  private draining = false;
  private pendingWrites: PendingWrite[] = [];
  private readonly syncCapable: boolean;

  constructor() {
    this.syncCapable = detectSyncCapability();
  }

  /**
   * The ONLY way to write to stdout.
   *
   * When `useSyncOutput` is true and the terminal supports DEC Mode 2026,
   * the content is wrapped in synchronized output escape sequences to
   * prevent tearing on multi-line updates.
   *
   * If called while another write() is in progress (reentrant call),
   * the content is queued and flushed after the current write completes.
   *
   * If the gate is locked, the write is queued until unlock.
   *
   * @param content - Raw string to write (may contain ANSI escapes)
   * @param useSyncOutput - Wrap in DEC 2026 sync sequences (default: false)
   */
  write(content: string, useSyncOutput = false): void {
    if (content.length === 0) return;

    // Queue if locked or already draining (reentrancy guard)
    if (this.locked || this.draining) {
      this.pendingWrites.push({ content, useSyncOutput });
      return;
    }

    this.rawWrite(content, useSyncOutput);
    this.drainQueue();
  }

  /**
   * Acquire exclusive write access.
   *
   * While locked, all write() calls are queued. Call unlock() to flush
   * the queue. Use this for multi-step sequences that must not be
   * interleaved (dock redraws, spinner frame + cursor restore, etc.).
   */
  lock(): void {
    this.locked = true;
  }

  /**
   * Release exclusive write access and flush any queued writes.
   */
  unlock(): void {
    this.locked = false;
    this.drainQueue();
  }

  /**
   * Check whether DEC Mode 2026 synchronized output is available.
   */
  isSyncCapable(): boolean {
    return this.syncCapable;
  }

  /**
   * Clean up. Flushes any remaining queued writes and resets state.
   * Safe to call multiple times.
   */
  dispose(): void {
    this.locked = false;
    this.drainQueue();
    this.pendingWrites.length = 0;
  }

  // ─── Private ─────────────────────────────────────────────────────────

  /** Write directly to stdout, optionally wrapped in sync sequences. */
  private rawWrite(content: string, useSyncOutput: boolean): void {
    if (useSyncOutput && this.syncCapable) {
      process.stdout.write(SYNC_START + content + SYNC_END);
    } else {
      process.stdout.write(content);
    }
  }

  /** Flush all pending writes. Reentrancy-safe via the draining flag. */
  private drainQueue(): void {
    if (this.locked || this.draining) return;

    this.draining = true;
    while (this.pendingWrites.length > 0) {
      const entry = this.pendingWrites.shift()!;
      this.rawWrite(entry.content, entry.useSyncOutput);
    }
    this.draining = false;
  }
}
