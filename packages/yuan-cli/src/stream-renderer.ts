/**
 * stream-renderer.ts — Core integration layer for YUAN CLI rendering.
 *
 * Ties together startup-banner, tool-display, readline-input, agent-bridge,
 * and bottom-dock into a single linear scrollback transcript.
 *
 * Design constraints:
 *   - NO React, NO Ink, NO Yoga — pure process.stdout.write() + readline
 *   - Terminal scrollback handles scrolling — we never implement scroll
 *   - Only ONE active line updated via \r (the tool spinner) in plain mode
 *   - Past transcript lines are NEVER modified
 *   - Resize: read process.stdout.columns at render time, never cache
 *   - When BottomDock is active (tmux/VSCode), DECSTBM scroll regions are
 *     used to pin status + input at the bottom. All transcript writes go
 *     through dock.appendTranscript() instead of raw stdout.
 */

import chalk from "chalk";
import { printStartupBanner } from "./startup-banner.js";
import { ToolDisplay } from "./tool-display.js";
import { ReadlineInput } from "./readline-input.js";
import { BottomDock, isBottomDockCapable } from "./bottom-dock.js";
import { sanitizeDelta, isInternalLeak } from "./output-contract.js";
import { TurnState } from "./turn-state.js";
import { MarkdownRenderer } from "./markdown-renderer.js";
import { ToolTree } from "./tool-tree.js";
import { WriteGate } from "./write-gate.js";
import { IncrementalClassifier } from "./incremental-classifier.js";
import { PacingStrategy, PACING_CONFIG } from "./pacing-strategy.js";
import { OutputQueue } from "./output-queue.js";
import type { PacingOutput } from "./pacing-strategy.js";
import type { AgentBridge } from "./tui/agent-bridge.js";
import type { ConfigManager, Provider } from "./config.js";
import type { AgentEvent, ApprovalRequest, ApprovalResponse } from "@yuaone/core";

// ─── Public Interface ────────────────────────────────────────────────────────

export interface StreamRendererConfig {
  version: string;
  model: string;
  provider: string;
  bridge: AgentBridge;
  configManager: ConfigManager;
  onExit: () => void;
}


/**
 * Launch the stream renderer — the main interactive loop of the CLI.
 *
 * This function never returns during normal operation (it blocks on readline).
 * Call `config.onExit()` to shut down.
 */
export function launchStreamRenderer(config: StreamRendererConfig): void {
  const { bridge, configManager, onExit } = config;

  // ── Mutable state ────────────────────────────────────────────────────────

  /** Whether the last character written to stdout was a newline. */
  let lastCharNewline = true;

  /** Turn lifecycle state machine — replaces ad-hoc streamingText boolean. */
  const turnState = new TurnState();

  /** Whether compact mode is active (suppress reasoning output). */
  let compactMode = false;

  /** Accumulated token counts for the current turn. */
  let turnTokens = { input: 0, output: 0 };

  /** Turn start timestamp (ms). */
  let turnStartMs = 0;

  /** Track per-tool timing for tool_result duration fallback. */
  const toolStartTimes = new Map<string, number>();

  /** Saved tool args from tool_call for use in tool_result rendering. */
  const lastToolArgs = new Map<string, Record<string, unknown>>();

  /** Metrics update interval during agent runs (dock mode only). */
  let metricsInterval: ReturnType<typeof setInterval> | null = null;

  /** Error dedup: last error message and timestamp to suppress duplicates. */
  let lastErrorMsg = "";
  let lastErrorTime = 0;

  // ── Code block state ──────────────────────────────────────────────────
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeLineBuffer = "";

  // Token colors from yua-web dark theme
  const CODE_COLORS = {
    bg: "#1e1e1e",
    keyword: "#c4b5fd",
    function: "#a5b4fc",
    string: "#34d399",
    number: "#fbbf24",
    comment: "#8b949e",
    operator: "#8b949e",
    className: "#93c5fd",
    plain: "#e6e6e6",
  } as const;

  const KEYWORDS = new Set([
    "const", "let", "var", "function", "class", "return", "if", "else",
    "for", "while", "do", "switch", "case", "break", "continue", "new",
    "this", "import", "export", "from", "default", "async", "await",
    "try", "catch", "finally", "throw", "typeof", "instanceof", "in",
    "of", "yield", "void", "delete", "true", "false", "null", "undefined",
    "interface", "type", "enum", "extends", "implements", "abstract",
    "public", "private", "protected", "static", "readonly", "as",
    "def", "self", "None", "True", "False", "lambda", "with", "assert",
    "raise", "except", "pass", "elif", "fn", "mut", "pub", "use", "mod",
    "struct", "impl", "trait", "where", "match", "loop",
  ]);

  /** Highlight a single line of code with terminal colors */
  function highlightCodeLine(line: string): string {
    if (!line.trim()) return line;

    // Comment detection (// or # at start after optional whitespace)
    const commentMatch = line.match(/^(\s*)(\/\/.*|#.*)$/);
    if (commentMatch) {
      return commentMatch[1] + chalk.hex(CODE_COLORS.comment)(commentMatch[2]);
    }

    // Token-by-token highlighting using regex
    let result = "";
    let remaining = line;

    while (remaining.length > 0) {
      // String literals (single, double, backtick)
      const strMatch = remaining.match(/^(["'`])(?:\\.|(?!\1)[^\\])*\1/);
      if (strMatch) {
        result += chalk.hex(CODE_COLORS.string)(strMatch[0]);
        remaining = remaining.slice(strMatch[0].length);
        continue;
      }

      // Numbers
      const numMatch = remaining.match(/^\b\d+(\.\d+)?\b/);
      if (numMatch) {
        result += chalk.hex(CODE_COLORS.number)(numMatch[0]);
        remaining = remaining.slice(numMatch[0].length);
        continue;
      }

      // Words (keywords, identifiers)
      const wordMatch = remaining.match(/^\b[a-zA-Z_$]\w*\b/);
      if (wordMatch) {
        const word = wordMatch[0];
        if (KEYWORDS.has(word)) {
          result += chalk.hex(CODE_COLORS.keyword)(word);
        } else if (remaining.slice(word.length).match(/^\s*\(/)) {
          // Followed by ( → function call
          result += chalk.hex(CODE_COLORS.function)(word);
        } else if (word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase()) {
          // PascalCase → class name
          result += chalk.hex(CODE_COLORS.className)(word);
        } else {
          result += chalk.hex(CODE_COLORS.plain)(word);
        }
        remaining = remaining.slice(word.length);
        continue;
      }

      // Operators and punctuation
      const opMatch = remaining.match(/^[=+\-*/<>!&|^~%?:;,.{}()\[\]@#]+/);
      if (opMatch) {
        result += chalk.hex(CODE_COLORS.operator)(opMatch[0]);
        remaining = remaining.slice(opMatch[0].length);
        continue;
      }

      // Whitespace and anything else
      result += remaining[0];
      remaining = remaining.slice(1);
    }

    return result;
  }

  /** Buffer for the current line being streamed (for line-level markdown) */
  let lineBuffer = "";

  /** Apply inline markdown formatting to a complete line of normal text */
  function renderMarkdownLine(line: string): string {
    // Bold: **text** or __text__
    let result = line.replace(/\*\*(.+?)\*\*/g, (_, t: string) => chalk.bold(t));
    result = result.replace(/__(.+?)__/g, (_, t: string) => chalk.bold(t));
    // Inline code: `text`
    result = result.replace(/`([^`]+)`/g, (_, t: string) =>
      chalk.bgHex("#2a2a2a").hex("#e6e6e6")(` ${t} `));
    // Italic: *text* (but not inside **)
    result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, t: string) =>
      chalk.italic(t));
    return result;
  }

  /** Flush the line buffer — render markdown via MarkdownRenderer and write */
  function flushLineBuffer(): void {
    if (lineBuffer.length === 0) return;
    if (isInternalLeak(lineBuffer)) {
      lineBuffer = "";
      return;
    }
    // Use markdown renderer for line-level formatting
    const rendered = mdRenderer.pushLine(lineBuffer);
    if (rendered !== null) {
      directWrite(rendered);
    }
    lineBuffer = "";
  }

  /** Process text for code block detection, highlighting, and inline markdown */
  function writeWithCodeHighlight(text: string): void {
    let i = 0;
    while (i < text.length) {
      if (!inCodeBlock) {
        // Check for code fence opening: ``` at start of line
        if (text[i] === "`" && text.slice(i).startsWith("```") && (lineBuffer.trim() === "")) {
          const fenceMatch = text.slice(i).match(/^```(\w*)\n?/);
          if (fenceMatch) {
            // Flush any buffered text before the fence
            flushLineBuffer();
            inCodeBlock = true;
            codeBlockLang = fenceMatch[1] || "";
            codeLineBuffer = "";
            const langLabel = codeBlockLang ? ` ${codeBlockLang}` : "";
            directWrite(chalk.bgHex(CODE_COLORS.bg)(chalk.hex(CODE_COLORS.comment)(`  \`\`\`${langLabel}`)) + "\n");
            i += fenceMatch[0].length;
            continue;
          }
        }

        // Buffer text character by character; flush on newline
        if (text[i] === "\n") {
          flushLineBuffer();
          directWrite("\n");
          i++;
        } else {
          lineBuffer += text[i];
          i++;
        }
      } else {
        // Inside code block — check for closing fence
        if (text[i] === "`" && text.slice(i).startsWith("```") && codeLineBuffer.trim() === "") {
          if (codeLineBuffer) {
             directWrite(chalk.bgHex(CODE_COLORS.bg)("  " + highlightCodeLine(codeLineBuffer)) + "\n");
             codeLineBuffer = "";
          }
          directWrite(chalk.bgHex(CODE_COLORS.bg)(chalk.hex(CODE_COLORS.comment)("  ```")) + "\n");
          inCodeBlock = false;
          codeBlockLang = "";
          i += 3;
          if (i < text.length && text[i] === "\n") i++;
          continue;
        }

        if (text[i] === "\n") {
          directWrite(chalk.bgHex(CODE_COLORS.bg)("  " + highlightCodeLine(codeLineBuffer)) + "\n");
          codeLineBuffer = "";
          i++;
        } else {
          codeLineBuffer += text[i];
          i++;
        }
      }
    }
  }

  // ── WriteGate + Content-Aware Pacer ─────────────────────────────────────

  const writeGate = new WriteGate();

  /** Unique key counter for output queue idempotency. */
  let pacerKeyCounter = 0;

  const outputQueue = new OutputQueue((content: string, _useSyncOutput: boolean) => {
    // The output queue delivers classified+paced content.
    // Route it through writeWithCodeHighlight for proper rendering
    // (code block detection, syntax highlighting, inline markdown).
    // Each content piece from the pacer is a line with trailing newline.
   write(content);
  });

  const pacingStrategy = new PacingStrategy(PACING_CONFIG, (output: PacingOutput) => {
    const now = Date.now();
    outputQueue.enqueue({
      idempotencyKey: `p-${++pacerKeyCounter}`,
      contentType: output.pacingMode,
      pacingMode: output.pacingMode,
      content: output.content + "\n",
      scheduledAt: now + output.scheduledDelay,
      priority: output.priority,
    });
  });

  const classifier = new IncrementalClassifier();

  /**
   * Ingest text through the Content-Aware Pacer pipeline.
   * Flow: text -> classifier.ingest() -> strategy.route() -> queue -> writeGate
   *
   * The pacer classifies content (code, prose, narration, etc.) and applies
   * appropriate pacing (buffering, sentence-level streaming, block collection).
   * The writeWithCodeHighlight() function is used as the final renderer, called
   * from the queue's output path via the write() helper.
   */
  function pacerIngest(text: string): void {
    try {
      pacingStrategy.notifyDelta();
      const classified = classifier.ingest(text);
      for (const item of classified) {
        pacingStrategy.route(item);
      }
    } catch (err) {
      // Fallback: if classifier/strategy crashes, write directly
      // This prevents the entire stream from breaking on unexpected input
      writeWithCodeHighlight(text);
    }
  }

  /**
   * Flush all pacer buffers synchronously — call before tool_call,
   * error, completed handlers to ensure all buffered content is rendered.
   */
  function pacerFlushAll(): void {
classifier.flushIncomplete(); // 결과 무시 (이미 처리됨)
    // Flush strategy buffers
    pacingStrategy.flushAll();
    // Flush output queue
    outputQueue.flushAll();
  }
  function directWrite(text: string): void {
    if (text.length === 0) return;

    const emit = (): void => {
      if (dock?.active) {
        dock.appendTranscript(text);
      } else {
        writeGate.write(text);
      }
      lastCharNewline = text.endsWith("\n");
    };

    if (dock?.active) {
      emit();
      return;
    }

    input.runAbovePrompt(emit);
  }

  /**
   * Reset pacer state for a new turn.
   */
  function pacerReset(): void {
    classifier.reset();
    pacingStrategy.reset();
    outputQueue.clear();
    pacerKeyCounter = 0;
  }

  function cleanup(closeInput = true): void {
    // Reset scroll region FIRST to prevent terminal corruption on exit
    dock?.dispose();
    if (metricsInterval) { clearInterval(metricsInterval); metricsInterval = null; }
    pacerFlushAll();
    showCursor();
    toolDisplay.dispose();
    writeGate.dispose();
    if (closeInput) {
      input.close({ exitProcess: false });
    }
  }

  function clearPlainInputFrame(): void {
    // Cursor is on prompt line:
    //   line -1: top separator
    //   line  0: prompt line
    //   line +1: bottom separator
    writeGate.write(
      "\x1b[1A" +    // move to top separator
      "\x1b[2K\r" +  // clear top separator
      "\x1b[1B" +    // back to prompt line
      "\x1b[2K\r" +  // clear prompt line
      "\n" +         // move to bottom separator line
      "\x1b[2K\r" +  // clear bottom separator
      "\n"           // move to a clean line below the frame
    );
    lastCharNewline = true;
  }
  // ── Cursor hide/show + cleanup ───────────────────────────────────────────

  const HIDE_CURSOR = "\x1b[?25l";
  const SHOW_CURSOR = "\x1b[?25h";

  function showCursor(): void {
    process.stdout.write(SHOW_CURSOR);
  }

  function hideCursor(): void {
    process.stdout.write(HIDE_CURSOR);
  }


  // Ensure cursor is restored on any exit path.
  process.on("exit", showCursor);
  process.on("SIGINT", () => {
    // Dispose dock first to reset DECSTBM scroll region before any output
    dock?.dispose();
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    dock?.dispose();
    cleanup();
    process.exit(143);
  });
  process.on("uncaughtException", (err) => {
    dock?.dispose();
    cleanup();
    process.stderr.write(`\nFatal: ${err.message}\n`);
    process.exit(1);
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Get current terminal width — always fresh, never cached. */
  function cols(): number {
    return process.stdout.columns ?? 80;
  }

  /**
   * Write raw text to stdout (or through dock), tracking the last character.
   *
   * When the dock is active, all transcript writes are routed through
   * dock.appendTranscript() which handles scroll region coordination.
   * When the dock is inactive, writes go through WriteGate for synchronized
   * output and reentrancy protection.
   */
  function write(text: string): void {
    if (text.length === 0) return;
writeWithCodeHighlight(text);
  }

  /** Write a line followed by newline. */
  function writeln(text: string = ""): void {
    write(text + "\n");
  }

  /** Ensure we're on a fresh line (write \n if last char wasn't \n). */
  function ensureNewline(): void {
    if (!lastCharNewline) {
      write("\n");
    }
  }

 function getSeparatorLine(): string {
    const width = cols();
    return chalk.hex("#3a3a3a")("─".repeat(Math.min(width, 120)));
  }

  /** Print a gray horizontal separator spanning the terminal width. */
  function printSeparator(): void {
directWrite(getSeparatorLine() + "\n");
  }

  function renderIdleInputFrame(): void {
    if (dock?.active) {
      // Dock draws the visual "> " — suppress readline's own prompt to avoid double "> "
      input.suppressPrompt();
      // Position cursor at dock's input row (after the "> " drawn by dock)
      const row = dock.inputRow;
      const promptLen = 2; // "> " is 2 chars
      process.stdout.write(`\x1b[${row};${promptLen + 1}H`);
      input.prompt();
      return;
    }

    if (!lastCharNewline) {
      writeGate.write("\n");
      lastCharNewline = true;
    }

    // top separator
    writeGate.write(getSeparatorLine() + "\n");

    // prompt line
     input.prompt();

    // draw bottom separator below the prompt, then restore cursor to prompt line
    writeGate.write("\x1b7");              // save cursor (on prompt line)
    writeGate.write("\n");                 // move to line below prompt
    writeGate.write("\x1b[2K\r");          // clear that line
    writeGate.write(getSeparatorLine());   // bottom separator
    writeGate.write("\x1b8");              // restore cursor to prompt line

    // cursor is back on prompt line, not at a newline
    lastCharNewline = false;
  }

  /** Format a token count compactly: 1234 -> "1.2k", 56789 -> "56.8k". */
  function formatTokens(n: number): string {
    if (n < 1000) return String(n);
    return (n / 1000).toFixed(1) + "k";
  }

  /** Format milliseconds as seconds: "3.8s". */
  function formatDuration(ms: number): string {
    return (ms / 1000).toFixed(1) + "s";
  }

  /**
   * Summarize tool arguments into a short one-line string for dock status.
   * Shows the most relevant argument (file path, command, pattern, etc.).
   */
  function summarizeToolArgs(toolName: string, args: Record<string, unknown>): string {
    // Extract the most meaningful argument value
    const candidates = ["file_path", "path", "command", "cmd", "pattern", "query", "content"];
    for (const key of candidates) {
      const val = args[key];
      if (typeof val === "string" && val.length > 0) {
        // Truncate long values
        const maxLen = Math.max(40, cols() - toolName.length - 20);
        return val.length > maxLen ? val.slice(0, maxLen - 3) + "..." : val;
      }
    }
    // Fallback: show first string argument
    for (const val of Object.values(args)) {
      if (typeof val === "string" && val.length > 0) {
        const maxLen = 50;
        return val.length > maxLen ? val.slice(0, maxLen - 3) + "..." : val;
      }
    }
    return "";
  }

  // ── Print startup banner ─────────────────────────────────────────────────

  printStartupBanner({
    version: config.version,
    model: config.model,
    provider: config.provider,
    cwd: process.cwd(),
  });

  // ── Initialize BottomDock (after banner, before input) ─────────────────

  const dockEnabled = isBottomDockCapable();
  const dock = dockEnabled ? new BottomDock({ model: config.model }) : null;
  if (dock) {
    dock.setWriteGate(writeGate);
    dock.init();
  }

  // Resize is handled by BottomDock internally (registered in init()).

  // ── Create P1 renderers (markdown + tool tree) ─────────────────────────

  const mdRenderer = new MarkdownRenderer(() => cols());
  const toolTree = new ToolTree({ getWidth: () => cols() });

  // ── Create ToolDisplay ───────────────────────────────────────────────────

  const toolDisplay = new ToolDisplay({ writeGate });

  // ── Create ReadlineInput ─────────────────────────────────────────────────

  const input = new ReadlineInput({
    onSubmit(message: string): void {
      // Lock input while agent processes.
      input.lock();
      hideCursor();

      // Reset turn tracking.
      turnState.transition("submitting");
      turnState.transition("thinking");
      lastCharNewline = true;
      turnTokens = { input: 0, output: 0 };
      turnStartMs = Date.now();
      toolStartTimes.clear();
      // Reset code block + line buffer state.
      inCodeBlock = false;
      codeBlockLang = "";
      codeLineBuffer = "";
      lineBuffer = "";
      mdRenderer.reset();
      pacerReset();

      // Prepare for agent response.
      // NOTE: readline already echoes "> {message}" — no need to render user message again.
      if (dock?.active) {
        dock.setMode("thinking");

        // Start metrics update interval (1s)
        metricsInterval = setInterval(() => {
          const elapsed = Date.now() - turnStartMs;
          const tokens = turnTokens.input + turnTokens.output;
          dock.updateMetrics(elapsed, tokens);
        }, 1000);
      } else {
        // Plain mode: blank line before agent response
        writeln();
      }

      // Send to agent — streaming events will arrive via bridge.onEvent.
      bridge.sendMessage(message).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        ensureNewline();
        writeln(chalk.red(`  Error: ${msg}`));
        finishTurn();
      });
    },

    onAbort(): void {
      // CRITICAL: Reset scroll region BEFORE any output to prevent ^C corruption
      if (dock?.active) {
        dock.dispose();
      }
      bridge.interrupt();
      turnState.transition("interrupted");
      turnState.transition("idle");
      ensureNewline();
      writeln(chalk.yellow("\n  Interrupted."));
      finishTurn();
    },

    onCommand(command: string, args: string): void {
      handleCommand(command, args);
    },
    onEmptyInterrupt(): void {
      if (dock?.active) {
        // Claude Code-style: print ^C into transcript, then re-open clean idle dock
        dock.appendTranscript("^C\n");
        dock.setMode("idle");
        renderIdleInputFrame();
        return;
      }

      clearPlainInputFrame();
      writeGate.write("^C\n");
      lastCharNewline = true;
      renderIdleInputFrame();
    },

    onDoubleInterruptExit(): void {
      if (dock?.active) {
        dock.dispose();
        process.stdout.write("^C\n");
      } else {
        clearPlainInputFrame();
        writeGate.write("^C\n");
      }
      cleanup(false);
    },
   });

  // ── Finish turn helper ───────────────────────────────────────────────────

  function finishTurn(): void {
    if (metricsInterval) { clearInterval(metricsInterval); metricsInterval = null; }
    pacerFlushAll();
    toolDisplay.flushActive();
    if (dock?.active) dock.setMode("idle");
    turnState.reset(); // back to idle
    pacerReset();
    showCursor();
    // When dock is active, suppress readline's own "> " — the dock draws it instead.
    input.unlock({ suppressPrompt: dock?.active === true });
    renderIdleInputFrame();
  }

  // ── Wire bridge events ───────────────────────────────────────────────────

  bridge.onEvent((event: AgentEvent) => {
    const kind = event.kind;

    switch (kind) {
      case "agent:start": {
        turnState.transition("thinking");
        if (dock?.active) dock.setMode("thinking");
        break;
      }

      case "agent:text_delta": {
        // Flush any active tool spinner before streaming text.
        if (turnState.phase !== "streaming") {
          toolDisplay.flushActive();
          turnState.transition("streaming");
          if (dock?.active) dock.setMode("streaming");
          // Assistant message prefix
          write(chalk.yellow("● "));
          // Signal classifier that we're starting fresh text after a tool
          classifier.setEventContext({ recentToolCall: false, betweenTools: false });
        }
        const rawText = (event as { text?: string }).text ?? "";
        const text = sanitizeDelta(rawText);
        if (!text) break;
        // Route through Content-Aware Pacer pipeline:
        // text -> classifier -> strategy -> queue -> writeGate
        // The pacer classifies content and applies pacing. When it's
        // ready to output, it calls writeWithCodeHighlight via the
        // output queue's write function.
        pacerIngest(text);
        break;
      }

      case "agent:reasoning_delta": {
        // Reasoning tokens are internal chain-of-thought.
        // Suppressed from transcript to prevent interleaving with response text.
        break;
      }

      case "agent:thinking": {
        // Show a brief thinking indicator.
        if (compactMode) break;
        const content = (event as { content?: string }).content ?? "";
        if (content.length === 0) break;

        // Filter internal system messages
        if (content.startsWith("[shadow]") ||
            content.startsWith("Token budget warning") ||
            content.startsWith("Mode \u2192") ||
            content.startsWith("Context compaction") ||
            content.startsWith("rollback executed")) break;

        const firstLine = content.split("\n")[0].slice(0, cols() - 10);

        if (dock?.active) {
          // Update dock status line only — no transcript pollution
          dock.updateStatus(firstLine);
        } else {
          // Plain mode: dim indicator in transcript
          if (turnState.phase === "streaming") {
            ensureNewline();
          }
          toolDisplay.flushActive();
          writeln(chalk.dim(`  \u2026 ${firstLine}`));
        }
        break;
      }

      case "agent:tool_call": {
        // Flush pacer buffers before tool
        pacerFlushAll();

        // Flush markdown buffer before tool
        const mdFlush = mdRenderer.flush();
        if (mdFlush) write(mdFlush);

        flushLineBuffer();
        if (turnState.phase === "streaming") {
          ensureNewline();
        }
        turnState.transition("tool_running");

        // Signal classifier for context-aware narration detection
        classifier.setEventContext({ recentToolCall: true, betweenTools: true });

        const toolName = (event as { tool?: string }).tool ?? "unknown";
        const rawArgs = (event as { arguments?: string; input?: unknown }).arguments
          ?? (event as { input?: unknown }).input;

        let parsedArgs: Record<string, unknown> = {};
        if (typeof rawArgs === "string") {
          try {
            parsedArgs = JSON.parse(rawArgs) as Record<string, unknown>;
          } catch {
            parsedArgs = { raw: rawArgs };
          }
        } else if (rawArgs && typeof rawArgs === "object") {
          parsedArgs = rawArgs as Record<string, unknown>;
        }

        // Save args for tool_result rendering
        lastToolArgs.set(toolName, parsedArgs);
        toolStartTimes.set(toolName, Date.now());

        if (dock?.active) {
          dock.setMode("tool");
          const argsSummary = summarizeToolArgs(toolName, parsedArgs);
          dock.updateStatus(`\u2699  ${toolName}  ${argsSummary}`);
        } else {
          toolDisplay.startTool(toolName, parsedArgs);
        }
        break;
      }

      case "agent:tool_result": {
        const toolName = (event as { tool?: string }).tool ?? "unknown";
        const success = (event as { success?: boolean }).success !== false;
        const output = (event as { output?: string }).output ?? "";
        const durationMs = (event as { durationMs?: number }).durationMs
          ?? (toolStartTimes.has(toolName)
            ? Date.now() - toolStartTimes.get(toolName)!
            : 0);

        toolStartTimes.delete(toolName);

        // Get the parsed args from when tool_call was received
        const args = lastToolArgs.get(toolName) ?? {};
        lastToolArgs.delete(toolName);

        if (dock?.active) {
          // Tree-style rendering to transcript
          const rendered = toolTree.renderToolResult(toolName, args, output, success, durationMs);
          write(rendered);
          dock.setMode("thinking");
        } else {
          // Plain mode: also use tree rendering
          toolDisplay.flushActive();
          const rendered = toolTree.renderToolResult(toolName, args, output, success, durationMs);
          write(rendered);
        }

        turnState.transition("thinking");
        // Signal classifier that we're between tools (narration likely)
        classifier.setEventContext({ recentToolCall: true, betweenTools: true });
        break;
      }

      case "agent:search_start": {
        if (turnState.phase === "streaming") {
          ensureNewline();
        }
        toolDisplay.flushActive();

        const queries = (event as { queries?: string[] }).queries ?? [];
        for (const q of queries) {
          writeln(chalk.dim(`  \u{1F50D} searching: "${q}"`));
        }
        break;
      }

      case "agent:search_result": {
        const query = (event as { query?: string }).query ?? "";
        const source = (event as { source?: string }).source ?? "";
        const count = (event as { resultCount?: number }).resultCount ?? 0;
        writeln(chalk.dim(`  \u{1F50D} ${source}: ${count} results for "${query}"`));
        break;
      }

      case "agent:token_usage": {
        const usage = event as { input?: number; output?: number };
        if (usage.input) turnTokens.input += usage.input;
        if (usage.output) turnTokens.output += usage.output;
        break;
      }

      case "agent:completed": {
        // Flush pacer buffers before completion
        pacerFlushAll();

        // Flush markdown renderer
        const mdFlushCompleted = mdRenderer.flush();
        if (mdFlushCompleted) write(mdFlushCompleted);
        // Flush any remaining tool/text/code/line state.
        flushLineBuffer();
        if (codeLineBuffer) {
          write(chalk.bgHex(CODE_COLORS.bg)("  " + highlightCodeLine(codeLineBuffer)) + "\n");
          codeLineBuffer = "";
        }
        inCodeBlock = false;
        codeBlockLang = "";
        if (turnState.phase === "streaming") {
          ensureNewline();
        }
        turnState.transition("completed");
        turnState.transition("idle");
        toolDisplay.flushActive();

        // Extract token usage from event if present (overrides accumulated).
        const completedEvent = event as {
          tokenUsage?: { input: number; output: number };
          duration?: number;
        };
        if (completedEvent.tokenUsage) {
          turnTokens.input = completedEvent.tokenUsage.input;
          turnTokens.output = completedEvent.tokenUsage.output;
        }

        // Calculate duration.
        const duration = completedEvent.duration
          ?? (turnStartMs > 0 ? Date.now() - turnStartMs : 0);

        // Print done summary line.
        const totalTokens = turnTokens.input + turnTokens.output;
        const tokenStr = totalTokens > 0 ? `  ${formatTokens(totalTokens)} tokens` : "";
        const durStr = duration > 0 ? `  ${formatDuration(duration)}` : "";

        const doneLine = chalk.green("\u2713") + chalk.dim(` done${tokenStr}${durStr}`);
        writeln();
        writeln(doneLine);

        finishTurn();
        break;
      }

      case "agent:error": {
        // Flush pacer buffers before error handling
        pacerFlushAll();

        if (turnState.phase === "streaming") {
          ensureNewline();
        }
        turnState.transition("failed");
        turnState.transition("idle");
        toolDisplay.flushActive();

        const errorMsg = (event as { message?: string; error?: string }).message
          ?? (event as { error?: string }).error
          ?? "Unknown error";

        // Dedup: skip if same error within 2 seconds (agent-loop may emit twice on retry)
        if (errorMsg === lastErrorMsg && Date.now() - lastErrorTime < 2000) {
          finishTurn();
          break;
        }
        lastErrorMsg = errorMsg;
        lastErrorTime = Date.now();

        writeln();
        writeln(chalk.red(`  \u2717 Error: ${errorMsg}`));

        finishTurn();
        break;
      }

      case "agent:interaction_mode": {
        const mode = (event as { mode: string }).mode;

        // Adjust pacer timing based on interaction mode
        if (mode === "CHAT") {
          // CHAT: everything immediate, no collect delay
          pacingStrategy.updateConfig({
            prose: { firstVisibleDeadline: 0, idleTimeout: 500, maxCollectTime: 1000, paragraphFlushThreshold: 1 },
            narration: { delayPerSentence: 0, firstSentenceDelay: 0, maxBuffer: 100 },
          });
        } else if (mode === "AGENT") {
          // AGENT: full pacing — collect, narrate, buffer
          pacingStrategy.updateConfig({
            prose: { firstVisibleDeadline: 2000, idleTimeout: 3000, maxCollectTime: 8000, paragraphFlushThreshold: 2 },
            narration: { delayPerSentence: 120, firstSentenceDelay: 0, maxBuffer: 600 },
          });
        } else {
          // HYBRID: moderate pacing
          pacingStrategy.updateConfig({
            prose: { firstVisibleDeadline: 1000, idleTimeout: 2000, maxCollectTime: 5000, paragraphFlushThreshold: 2 },
            narration: { delayPerSentence: 80, firstSentenceDelay: 0, maxBuffer: 500 },
          });
        }

        // Update dock hint
        if (dock?.active) {
          if (mode === "CHAT") dock.setMode("streaming");
          else if (mode === "AGENT") dock.setMode("thinking");
        }
        break;
      }

      case "agent:decision": {
        const decision = (event as { decision: { intent: string; complexity: string; taskStage: string; planRequired: boolean; nextAction: string } }).decision;

        // Trivial complexity: bypass pacer entirely (immediate output)
        if (decision.complexity === "trivial") {
          pacingStrategy.updateConfig({
            prose: { firstVisibleDeadline: 0, idleTimeout: 300, maxCollectTime: 500, paragraphFlushThreshold: 1 },
            narration: { delayPerSentence: 0, firstSentenceDelay: 0, maxBuffer: 100 },
          });
        }

        // Massive complexity: longer collect time for higher-quality output
        if (decision.complexity === "massive") {
          pacingStrategy.updateConfig({
            prose: { firstVisibleDeadline: 2500, idleTimeout: 3000, maxCollectTime: 10000, paragraphFlushThreshold: 3 },
          });
        }
        break;
      }

      case "agent:budget_warning": {
        const { tool, used, limit } = event as { tool: string; used: number; limit: number };
        if (dock?.active) {
          dock.updateStatus(`\u26A0 ${tool} ${used}/${limit}`);
        }
        break;
      }

      case "agent:budget_exceeded": {
        const { tool } = event as { tool: string };
        if (dock?.active) {
          dock.updateStatus(`\u2717 ${tool} budget exceeded`);
        }
        break;
      }

      case "agent:rollback_point_created": {
        if (dock?.active) {
          dock.updateStatus("\uD83D\uDCCC rollback point saved");
        }
        break;
      }

      case "agent:dependency_change_detected": {
        if (dock?.active) {
          dock.updateStatus("\uD83D\uDCE6 dependency change detected");
        }
        break;
      }

      default:
        // Silently ignore unknown event types — forward compatibility.
        break;
    }
  });

  // ── Wire approval handler ────────────────────────────────────────────────

  bridge.onApproval(async (request: ApprovalRequest): Promise<ApprovalResponse> => {
    // Flush any active tool/text state.
    if (turnState.phase === "streaming") {
      ensureNewline();
    }
    toolDisplay.flushActive();

    if (dock?.active) {
      // Dock mode: show approval in the fixed bottom dock area
      const detail = extractApprovalDetail(request);
      dock.showApproval(request.toolName, detail, request.riskLevel);

      const response = await readSingleKey();

      dock.hideApproval();

      // Log approval result to transcript as permanent record
      const resultIcon = response === "approve" || response === "always_approve"
        ? chalk.green("\u2713")
        : chalk.red("\u2717");
      const resultLabel = response === "approve" ? "approved"
        : response === "always_approve" ? "always approve"
        : "rejected";
      write(chalk.dim(`  ${resultIcon} ${request.toolName} \u2014 ${resultLabel}\n`));

      return response;
    }

    // Plain mode: approval block in transcript
    const borderWidth = Math.min(cols(), 50);
    const border = "\u2501".repeat(borderWidth);

    writeln();
    writeln(chalk.yellow(border));
    writeln(chalk.yellow(`  \u26A0  ${request.toolName} requires approval`));
    writeln();

    // Show relevant details from arguments.
    if (request.arguments) {
      const cmd = request.arguments.command ?? request.arguments.cmd;
      if (cmd) {
        writeln(`  Command: ${chalk.bold(String(cmd))}`);
      }
      const filePath = request.arguments.file_path ?? request.arguments.path;
      if (filePath) {
        writeln(`  File: ${chalk.bold(String(filePath))}`);
      }
    }

    writeln(`  Risk: ${formatRisk(request.riskLevel)}`);

    if (request.reason) {
      writeln(`  Reason: ${chalk.dim(request.reason)}`);
    }

    if (request.diff) {
      writeln();
      // Show a truncated diff preview.
      const diffLines = request.diff.split("\n").slice(0, 10);
      for (const line of diffLines) {
        if (line.startsWith("+")) {
          writeln(chalk.green(`  ${line}`));
        } else if (line.startsWith("-")) {
          writeln(chalk.red(`  ${line}`));
        } else {
          writeln(chalk.dim(`  ${line}`));
        }
      }
      if (request.diff.split("\n").length > 10) {
        writeln(chalk.dim(`  ... (${request.diff.split("\n").length - 10} more lines)`));
      }
    }

    writeln();
    writeln(`  ${chalk.green("[y]")} Yes  ${chalk.red("[n]")} No  ${chalk.cyan("[a]")} Always  ${chalk.dim("[s]")} Skip`);
    writeln(chalk.yellow(border));

    // Wait for single keypress.
    const response = await readSingleKey();
    return response;
  });

  // ── Wire termination handler ─────────────────────────────────────────────

  bridge.onTermination((result: { reason: string }) => {
    // agent:completed already handles turn cleanup (finishTurn).
    // Only show message for actual ERROR terminations.
    if (result.reason === "ERROR") {
      const errText = (result as { error?: string }).error ?? result.reason;
      // Skip if already shown by agent:error handler (dedup)
      if (errText === lastErrorMsg && Date.now() - lastErrorTime < 5000) return;
      ensureNewline();
      writeln(chalk.red(`  Session error: ${errText}`));
    }
    // All other reasons (GOAL_ACHIEVED, COMPLETE, OK, BUDGET_EXHAUSTED, etc.) — silent.
  });

  // ── Extract approval detail string from request ──────────────────────────

  function extractApprovalDetail(request: ApprovalRequest): string {
    if (!request.arguments) return "";
    const cmd = request.arguments.command ?? request.arguments.cmd;
    if (cmd) return `Command: ${String(cmd)}`;
    const filePath = request.arguments.file_path ?? request.arguments.path;
    if (filePath) return `File: ${String(filePath)}`;
    return "";
  }

  // ── Single keypress reader for approval prompts ──────────────────────────

  function readSingleKey(): Promise<ApprovalResponse> {
    return new Promise((resolve) => {
      const wasRaw = process.stdin.isRaw;

      // Enter raw mode to capture single keypress.
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();

      const onData = (data: Buffer): void => {
        const key = data.toString().toLowerCase();

        // Restore stdin state.
        process.stdin.removeListener("data", onData);
        if (process.stdin.isTTY && wasRaw !== undefined) {
          process.stdin.setRawMode(wasRaw);
        }

        // Map key to response.
        switch (key) {
          case "y":
            writeln(chalk.green("  \u2713 Approved"));
            resolve("approve");
            break;
          case "a":
            writeln(chalk.cyan("  \u2713 Always approve this tool"));
            resolve("always_approve");
            break;
          case "n":
            writeln(chalk.red("  \u2717 Rejected"));
            resolve("reject");
            break;
          case "s":
            writeln(chalk.dim("  \u2192 Skipped"));
            resolve("reject");
            break;
          case "\x03": // Ctrl+C
            writeln(chalk.red("  \u2717 Rejected (interrupted)"));
            resolve("reject");
            break;
          default:
            // Unrecognized key — treat as "no" for safety.
            writeln(chalk.dim(`  (unrecognized key "${key.replace(/[\x00-\x1f]/g, "")}" \u2014 treating as No)`));
            resolve("reject");
            break;
        }
      };

      process.stdin.on("data", onData);

      // Timeout: auto-reject after the request's timeout period.
      const timeoutMs = 60_000; // 60s default
      const timer = setTimeout(() => {
        process.stdin.removeListener("data", onData);
        if (process.stdin.isTTY && wasRaw !== undefined) {
          process.stdin.setRawMode(wasRaw);
        }
        writeln(chalk.dim("  (timed out \u2014 auto-rejected)"));
        resolve("reject");
      }, timeoutMs);

      // Clean up timer when resolved.
      const origResolve = resolve;
      resolve = ((val: ApprovalResponse) => {
        clearTimeout(timer);
        origResolve(val);
      }) as typeof resolve;
    });
  }

  // ── Format risk level with color ─────────────────────────────────────────

  function formatRisk(level: string): string {
    switch (level) {
      case "critical":
        return chalk.bgRed.white.bold(" CRITICAL ");
      case "high":
        return chalk.red.bold("HIGH");
      case "medium":
        return chalk.yellow("MEDIUM");
      default:
        return chalk.dim(level);
    }
  }

  // ── Slash command handler ────────────────────────────────────────────────

  function handleCommand(command: string, args: string): void {
    switch (command) {
      case "help":
        printHelp();
        break;

      case "exit":
      case "quit":
        cleanup();
        onExit();
        break;

      case "clear":
        // Reset scroll region BEFORE clearing, then reprint banner, then re-establish dock
        if (dock) {
          process.stdout.write("\x1b[r"); // reset scroll region first
        }
        process.stdout.write("\x1b[2J\x1b[H"); // clear screen
        printStartupBanner({
          version: config.version,
          model: configManager.getModel(),
          provider: configManager.get().provider,
          cwd: process.cwd(),
        });
        if (dock) {
          dock.handleResize(); // re-establish scroll region + dock
        }
        break;

      case "model": {
        if (!args) {
          writeln(chalk.dim(`  Current model: ${configManager.getModel()} (${configManager.get().provider})`));
          writeln(chalk.dim("  Usage: /model <provider>/<model>  or  /model <model>"));
          writeln(chalk.dim("  Examples: /model anthropic/claude-sonnet-4-6"));
          writeln(chalk.dim("           /model gpt-4o"));
          break;
        }

        // Parse provider/model format.
        let newProvider: string;
        let newModel: string;

        if (args.includes("/")) {
          const parts = args.split("/", 2);
          newProvider = parts[0];
          newModel = parts[1];
        } else {
          // Infer provider from model name.
          newModel = args;
          newProvider = inferProvider(newModel);
        }

        // Validate provider has an API key.
        const key = configManager.getKey(newProvider as Provider);
        if (!key) {
          writeln(chalk.red(`  No API key configured for ${newProvider}.`));
          writeln(chalk.dim(`  Run: yuan config --provider ${newProvider} --key <your-key>`));
          break;
        }

        // Apply the switch.
        bridge.updateModel(newProvider, newModel);
        configManager.setModel(newModel);
        writeln(chalk.green(`  \u2713 Switched to ${newProvider}/${newModel}`));
        break;
      }

      case "mode": {
        if (!args) {
          writeln(chalk.dim(`  Current mode: ${bridge.currentMode}`));
          writeln(chalk.dim("  Available: code, review, security, debug, refactor, test, plan, architect, report"));
          break;
        }
        const validModes = ["code", "review", "security", "debug", "refactor", "test", "plan", "architect", "report"];
        if (!validModes.includes(args)) {
          writeln(chalk.red(`  Unknown mode: ${args}`));
          writeln(chalk.dim(`  Available: ${validModes.join(", ")}`));
          break;
        }
        bridge.setMode(args);
        writeln(chalk.green(`  \u2713 Mode set to ${args}`));
        break;
      }

      case "compact":
        compactMode = !compactMode;
        writeln(chalk.dim(`  Compact mode: ${compactMode ? "ON" : "OFF"} (reasoning ${compactMode ? "hidden" : "shown"})`));
        break;

      case "history":
        writeln(chalk.dim("  History is managed by readline. Press \u2191/\u2193 to navigate."));
        break;

      case "undo": {
        const removed = bridge.removeLastChangedFile();
        if (removed) {
          writeln(chalk.dim(`  Removed last tracked change: ${removed}`));
          writeln(chalk.dim("  Note: file content was NOT reverted. Use git to revert if needed."));
        } else {
          writeln(chalk.dim("  No file changes to undo."));
        }
        break;
      }

      case "config":
        writeln(configManager.show());
        break;

      case "reset":
        bridge.resetSession();
        writeln(chalk.green("  \u2713 Session reset. Conversation history cleared."));
        break;

      default:
        writeln(chalk.red(`  Unknown command: /${command}`));
        writeln(chalk.dim("  Type /help for available commands."));
        break;
    }
  }

  // ── Help text ────────────────────────────────────────────────────────────

  function printHelp(): void {
    const lines = [
      "",
      chalk.bold("  YUAN CLI Commands"),
      "",
      `  ${chalk.cyan("/help")}              Show this help`,
      `  ${chalk.cyan("/exit")}, ${chalk.cyan("/quit")}       Exit the CLI`,
      `  ${chalk.cyan("/clear")}             Clear screen and reprint banner`,
      `  ${chalk.cyan("/model")} ${chalk.dim("<p/model>")}  Switch LLM model (e.g. /model anthropic/claude-sonnet-4-6)`,
      `  ${chalk.cyan("/mode")} ${chalk.dim("<mode>")}      Set agent mode (code, review, security, debug, plan, ...)`,
      `  ${chalk.cyan("/compact")}           Toggle compact mode (hide reasoning)`,
      `  ${chalk.cyan("/config")}            Show current configuration`,
      `  ${chalk.cyan("/reset")}             Reset conversation (clear history)`,
      `  ${chalk.cyan("/undo")}              Remove last tracked file change`,
      `  ${chalk.cyan("/history")}           Readline history info`,
      "",
      chalk.dim("  Multiline: end a line with \\ to continue on the next line."),
      chalk.dim("  Ctrl+C: interrupt agent / clear input / double-tap to exit."),
      "",
    ];
    for (const line of lines) {
      writeln(line);
    }
  }

  // ── Provider inference from model name ───────────────────────────────────

  function inferProvider(model: string): string {
    const lower = model.toLowerCase();
    if (lower.startsWith("gpt") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4")) return "openai";
    if (lower.startsWith("claude")) return "anthropic";
    if (lower.startsWith("gemini")) return "google";
    if (lower.startsWith("yua")) return "yua";
    // Default to current provider.
    return configManager.get().provider;
  }

  // ── Start input loop ─────────────────────────────────────────────────────

  input.start();
renderIdleInputFrame();
}
