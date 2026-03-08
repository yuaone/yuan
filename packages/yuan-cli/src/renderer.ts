/**
 * YUAN CLI — Terminal Renderer
 *
 * Handles styled terminal output: colors, spinners, markdown,
 * agent thinking display, and tool call rendering.
 */

// ─── ANSI color helpers (no external deps) ───

const ESC = "\x1b[";

export const colors = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  italic: `${ESC}3m`,
  underline: `${ESC}4m`,

  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  white: `${ESC}37m`,
  gray: `${ESC}90m`,

  bgRed: `${ESC}41m`,
  bgGreen: `${ESC}42m`,
  bgYellow: `${ESC}43m`,
  bgBlue: `${ESC}44m`,
} as const;

function c(color: string, text: string): string {
  return `${color}${text}${colors.reset}`;
}

// ─── Spinner ───

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private frameIndex = 0;
  private message: string;

  constructor(message: string) {
    this.message = message;
  }

  start(): void {
    this.frameIndex = 0;
    process.stdout.write("\x1b[?25l"); // hide cursor
    this.interval = setInterval(() => {
      const frame = SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length];
      process.stdout.write(
        `\r${c(colors.cyan, frame)} ${c(colors.dim, this.message)}`
      );
      this.frameIndex++;
    }, 80);
  }

  update(message: string): void {
    this.message = message;
  }

  stop(finalMessage?: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    process.stdout.write("\r\x1b[K"); // clear line
    process.stdout.write("\x1b[?25h"); // show cursor
    if (finalMessage) {
      console.log(`${c(colors.green, "✓")} ${finalMessage}`);
    }
  }
}

// ─── Terminal Renderer ───

export class TerminalRenderer {
  /** Print the YUAN banner */
  banner(): void {
    console.log(
      c(colors.bold + colors.cyan, "\n  YUAN") +
        c(colors.dim, " — Autonomous Coding Agent\n")
    );
  }

  /** Print an info line */
  info(message: string): void {
    console.log(`${c(colors.blue, "ℹ")} ${message}`);
  }

  /** Print a success line */
  success(message: string): void {
    console.log(`${c(colors.green, "✓")} ${message}`);
  }

  /** Print a warning line */
  warn(message: string): void {
    console.log(`${c(colors.yellow, "⚠")} ${message}`);
  }

  /** Print an error line */
  error(message: string): void {
    console.log(`${c(colors.red, "✗")} ${message}`);
  }

  /** Display agent thinking indicator */
  thinking(): Spinner {
    const spinner = new Spinner("thinking...");
    spinner.start();
    return spinner;
  }

  /** Display a tool call */
  toolCall(toolName: string, args?: string): void {
    const toolStr = c(colors.yellow, toolName);
    const argsStr = args ? c(colors.dim, ` ${args}`) : "";
    console.log(`  ${c(colors.dim, "🔧")} ${toolStr}${argsStr}`);
  }

  /** Display a tool result (truncated) */
  toolResult(result: string, maxLines = 5): void {
    const lines = result.split("\n");
    const display = lines.slice(0, maxLines);
    for (const line of display) {
      console.log(`  ${c(colors.dim, "│")} ${c(colors.dim, line)}`);
    }
    if (lines.length > maxLines) {
      console.log(
        `  ${c(colors.dim, "│")} ${c(colors.dim, `... (${lines.length - maxLines} more lines)`)}`
      );
    }
  }

  /** Render basic markdown to terminal (code blocks, bold, headers) */
  markdown(text: string): void {
    const lines = text.split("\n");
    let inCodeBlock = false;
    let codeLanguage = "";

    for (const line of lines) {
      // Code block start/end
      if (line.startsWith("```")) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeLanguage = line.slice(3).trim();
          const langLabel = codeLanguage ? ` ${codeLanguage}` : "";
          console.log(c(colors.dim, `  ┌──${langLabel}${"─".repeat(Math.max(0, 40 - langLabel.length))}`));
        } else {
          inCodeBlock = false;
          codeLanguage = "";
          console.log(c(colors.dim, `  └${"─".repeat(44)}`));
        }
        continue;
      }

      if (inCodeBlock) {
        console.log(`  ${c(colors.dim, "│")} ${c(colors.green, line)}`);
        continue;
      }

      // Headers
      if (line.startsWith("### ")) {
        console.log(c(colors.bold + colors.white, `  ${line.slice(4)}`));
        continue;
      }
      if (line.startsWith("## ")) {
        console.log(c(colors.bold + colors.cyan, `  ${line.slice(3)}`));
        continue;
      }
      if (line.startsWith("# ")) {
        console.log(c(colors.bold + colors.cyan, `  ${line.slice(2)}`));
        continue;
      }

      // Bold (**text**)
      let formatted = line.replace(
        /\*\*(.+?)\*\*/g,
        (_, content: string) => c(colors.bold, content)
      );

      // Inline code (`text`)
      formatted = formatted.replace(
        /`(.+?)`/g,
        (_, content: string) => c(colors.yellow, content)
      );

      console.log(`  ${formatted}`);
    }
  }

  /** Print a horizontal separator */
  separator(): void {
    console.log(c(colors.dim, "  " + "─".repeat(50)));
  }

  /** Print agent response text */
  agentResponse(text: string): void {
    console.log();
    this.markdown(text);
    console.log();
  }

  /** Print the prompt indicator for interactive mode */
  prompt(): void {
    process.stdout.write(c(colors.cyan + colors.bold, "\n❯ "));
  }

  /** Stream a token (no newline, real-time output) */
  streamToken(token: string): void {
    process.stdout.write(token);
  }

  /** End a streaming sequence (newline + reset) */
  endStream(): void {
    process.stdout.write("\n");
  }

  /** Create a spinner with custom message */
  spinner(message: string): Spinner {
    return new Spinner(message);
  }
}
