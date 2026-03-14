/**
 * Raw ANSI escape helpers for screen buffer and cursor control.
 */

export const ANSI = {
  /** Enter alternate screen buffer */
  altScreenEnter: "\x1b[?1049h",
  /** Exit alternate screen buffer */
  altScreenExit: "\x1b[?1049l",

  /** Hide cursor */
  cursorHide: "\x1b[?25l",
  /** Show cursor */
  cursorShow: "\x1b[?25h",

  /**
+   * Mouse tracking OFF
+   * Some terminals keep mouse mode enabled after previous apps (vim/less/tmux).
+   * Explicitly disabling prevents raw SGR mouse events leaking into stdin.
    */
  mouseDisable:
    "\x1b[?1000l" + // disable normal mouse tracking
    "\x1b[?1002l" + // disable button-event tracking
    "\x1b[?1003l" + // disable any-event tracking
    "\x1b[?1006l",  // disable SGR extended mouse mode

  /**
   * Bracketed paste OFF
   * Prevent terminals from wrapping paste with escape sequences.
   */
  pasteDisable: "\x1b[?2004l",

  /** Clear entire screen */
  clearScreen: "\x1b[2J\x1b[H",

  /** Move cursor to position */
  moveTo: (row: number, col: number) => `\x1b[${row};${col}H`,

  /** Clear line from cursor */
  clearLine: "\x1b[K",

  /** Scroll up N lines */
  scrollUp: (n: number) => `\x1b[${n}S`,

  /** Scroll down N lines */
  scrollDown: (n: number) => `\x1b[${n}T`,

  /** Set scroll region */
  setScrollRegion: (top: number, bottom: number) => `\x1b[${top};${bottom}r`,

  /** Reset scroll region */
  resetScrollRegion: "\x1b[r",
} as const;

/** Enter TUI mode: alt screen + hide cursor + mouse */
export function enterTUI(): void {
  process.stdout.write(
    ANSI.mouseDisable +
    ANSI.pasteDisable +
    ANSI.resetScrollRegion +
    ANSI.altScreenEnter +
    ANSI.clearScreen +
    ANSI.cursorHide
  );
}

/** Exit TUI mode: restore everything + clear residue */
export function exitTUI(): void {
  process.stdout.write(
    ANSI.mouseDisable +
    ANSI.pasteDisable +
    ANSI.cursorShow +
    ANSI.altScreenExit,
  );
  // Clear any residual lines from before TUI entered alternate screen
  process.stdout.write(ANSI.clearScreen);
  // Print a clean goodbye so terminal isn't blank
  process.stdout.write("\x1b[90mYUAN session ended.\x1b[0m\n");
}
