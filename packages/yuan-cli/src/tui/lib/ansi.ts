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
   * Mouse tracking disabled — Ink의 useInput이 SGR 마우스 이벤트를 파싱 못해서
   * 입력창에 escape sequence가 그대로 노출됨. 텍스트 선택은 터미널 기본 동작으로 가능.
   */
  mouseEnable: "",
  mouseDisable: "",

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
    ANSI.altScreenEnter + ANSI.cursorHide + ANSI.mouseEnable,
  );
}

/** Exit TUI mode: restore everything */
export function exitTUI(): void {
  process.stdout.write(
    ANSI.mouseDisable + ANSI.cursorShow + ANSI.altScreenExit,
  );
}
