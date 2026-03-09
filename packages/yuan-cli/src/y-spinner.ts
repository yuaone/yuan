/**
 * @module y-spinner
 * @description Y spinner animation for CLI.
 * Uses ANSI 256 colors for a glowing Y logo effect.
 */

/** ANSI 256-color palette for the Y spinner */
const COLORS = {
  dim: "\x1b[38;5;240m",
  normal: "\x1b[38;5;33m",
  bright: "\x1b[38;5;39m",
  glow: "\x1b[38;5;51m",
  accent: "\x1b[38;5;220m",
  green: "\x1b[38;5;82m",
  red: "\x1b[38;5;196m",
  reset: "\x1b[0m",
} as const;

/** Hide/show cursor ANSI sequences */
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K\r";

/**
 * Animation frames — 8 frames cycling through dim → normal → bright → glow.
 * Each frame applies a different color to the Y character.
 */
const FRAMES: readonly string[] = [
  `${COLORS.dim}Y${COLORS.reset}`,
  `${COLORS.dim}Y${COLORS.reset}`,
  `${COLORS.normal}Y${COLORS.reset}`,
  `${COLORS.normal}Y${COLORS.reset}`,
  `${COLORS.bright}Y${COLORS.reset}`,
  `${COLORS.bright}Y${COLORS.reset}`,
  `${COLORS.glow}Y${COLORS.reset}`,
  `${COLORS.accent}Y${COLORS.reset}`,
] as const;

const FRAME_INTERVAL = 100;

/**
 * YSpinner — Terminal spinner with a glowing Y logo animation.
 *
 * @example
 * ```ts
 * const spinner = new YSpinner();
 * spinner.start("Authenticating...");
 * // ... async work ...
 * spinner.success("Logged in!");
 * ```
 */
export class YSpinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frameIndex = 0;
  private message = "";

  /** Start the spinner with an initial message. */
  start(message: string): void {
    this.message = message;
    this.frameIndex = 0;

    process.stderr.write(CURSOR_HIDE);
    this.render();

    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % FRAMES.length;
      this.render();
    }, FRAME_INTERVAL);
  }

  /** Update the spinner message without stopping it. */
  update(message: string): void {
    this.message = message;
  }

  /** Stop the spinner and show a success message. */
  success(message: string): void {
    this.stop();
    const icon = `${COLORS.green}Y\u2713${COLORS.reset}`;
    process.stderr.write(`${CLEAR_LINE}${icon} ${message}\n`);
  }

  /** Stop the spinner and show a failure message. */
  fail(message: string): void {
    this.stop();
    const icon = `${COLORS.red}Y\u2717${COLORS.reset}`;
    process.stderr.write(`${CLEAR_LINE}${icon} ${message}\n`);
  }

  /** Stop the spinner and restore the cursor. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    process.stderr.write(CLEAR_LINE);
    process.stderr.write(CURSOR_SHOW);
  }

  /** Render the current frame to stderr. */
  private render(): void {
    const frame = FRAMES[this.frameIndex];
    process.stderr.write(`${CLEAR_LINE}${frame} ${this.message}`);
  }
}
