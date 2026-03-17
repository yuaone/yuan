/**
 * InputBox — fixed bottom input with prompt, history, slash commands.
 * When "/" is typed, notifies parent to open SlashMenu.
 * Arrow up/down in slash mode → navigate menu (not history).
 * Tab → autocomplete selected slash command.
 * Esc → close slash menu or interrupt agent.
 */

import React, { memo, useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import stringWidth from "string-width";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { useInputHistory } from "../hooks/useInputHistory.js";
import { isKnownCommand } from "../hooks/useSlashCommands.js";
import { TOKENS } from "../lib/tokens.js";

export interface InputBoxProps {
  onSubmit: (value: string) => void;
  onInterrupt?: () => void;
  onSlashCommand?: (cmd: string) => void;
  onInputChange?: (value: string) => void;
  /** When slash menu is open, arrow keys navigate the menu */
  slashMenuOpen?: boolean;
  onSlashNavigate?: (direction: "up" | "down") => void;
  /** Autocomplete: fill input with selected slash command */
  onSlashSelect?: () => string | null;
  onSlashClose?: () => void;
  isRunning?: boolean;
  disabled?: boolean;
  /** Called when user submits a message while agent is running (queue it) */
  onQueueMessage?: (value: string) => void;
  /** Queued pending message to display while agent is running */
  pendingMessage?: string;
  pendingCount?: number;
  queuedMessages?: string[];
  onQueueEdit?: (index: number) => string | null;
  onQueueDelete?: (index: number) => void;
  onQueueMove?: (from: number, to: number) => void;
  onQueueReplace?: (index: number, newContent: string) => void;
  /** Task panel is open — ↑↓ navigate tasks, enter expand, esc close */
  taskPanelOpen?: boolean;
  onTaskNavigate?: (direction: "up" | "down") => void;
  onTaskExpand?: () => void;
  onTaskPanelClose?: () => void;
  onTaskPanelOpen?: () => void;
  /** Whether there are background tasks (shows hint) */
  hasBackgroundTasks?: boolean;
}

export const InputBox = memo(function InputBox({
  onSubmit,
  onInterrupt,
  onSlashCommand,
  onInputChange,
  slashMenuOpen,
  onSlashNavigate,
  onSlashSelect,
  onSlashClose,
  isRunning,
  disabled,
  onQueueMessage,
  pendingMessage,
  pendingCount,
  queuedMessages,
  onQueueEdit,
  onQueueDelete,
  onQueueMove,
  onQueueReplace,
  taskPanelOpen,
  onTaskNavigate,
  onTaskExpand,
  onTaskPanelClose,
  onTaskPanelOpen,
  hasBackgroundTasks,
}: InputBoxProps): React.JSX.Element {
  const { columns } = useTerminalSize();
  const history = useInputHistory();
  // Combine value+cursor into single state → guaranteed single re-render per keypress
  const [inputState, setInputState] = useState({ value: "", cursor: 0 });
  const { value, cursor: cursorPos } = inputState;
  const [queueCursor, setQueueCursor] = useState<number>(0);
  const [queueMode, setQueueMode] = useState(false);
  // Saves input value before entering queue mode so we can restore it on cancel
  const savedInputRef = useRef("");
  const [pasteBadge, setPasteBadge] = useState<string | null>(null);
  const pasteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Debounce onInputChange to reduce parent re-renders while typing
  const inputChangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPasteBadge = useCallback(() => {
    if (pasteTimerRef.current) {
      clearTimeout(pasteTimerRef.current);
      pasteTimerRef.current = null;
    }
    setPasteBadge(null);
  }, []);

  const showPasteBadge = useCallback((rawLength: number) => {
    if (pasteTimerRef.current) {
      clearTimeout(pasteTimerRef.current);
    }

    const formatted =
      rawLength >= 1000
        ? `${(rawLength / 1000).toFixed(rawLength >= 10000 ? 0 : 1)}k`
        : String(rawLength);

    setPasteBadge(`[paste ${formatted}]`);
    pasteTimerRef.current = setTimeout(() => {
      setPasteBadge(null);
      pasteTimerRef.current = null;
    }, 1800);
  }, []);

  useEffect(() => {
    return () => {
      if (pasteTimerRef.current) {
        clearTimeout(pasteTimerRef.current);
      }
    };
  }, []);
  const updateValue = useCallback(
    (newValue: string, newCursor?: number) => {
      // Single state update → single re-render per keypress
      setInputState({ value: newValue, cursor: newCursor ?? newValue.length });
      // Debounce onInputChange to avoid parent re-render on every keystroke
      if (onInputChange) {
        if (inputChangeTimerRef.current) clearTimeout(inputChangeTimerRef.current);
        inputChangeTimerRef.current = setTimeout(() => {
          onInputChange(newValue);
          inputChangeTimerRef.current = null;
        }, 80);
      }
    },
    [onInputChange],
  );

  // ── Queue mode helpers ────────────────────────────────────────────────────
  const enterQueueMode = useCallback((msgs: string[]) => {
    if (!msgs.length) return;
    savedInputRef.current = value;
    const idx = msgs.length - 1; // start at most-recently-queued
    setQueueCursor(idx);
    setQueueMode(true);
    updateValue(msgs[idx] ?? "");
  }, [value, updateValue]);

  const exitQueueMode = useCallback((restoreInput = true) => {
    setQueueMode(false);
    if (restoreInput) updateValue(savedInputRef.current);
    else updateValue("");
    savedInputRef.current = "";
  }, [updateValue]);

  // Sync cursor + content when queuedMessages prop changes while in queue mode
  // (e.g. after delete, the parent re-renders with the new array — this corrects stale reads)
  // Use a content hash ref to prevent re-triggering when array reference changes but content is same
  const prevQueueHashRef = useRef("");
  const queueLen = queuedMessages?.length ?? 0;
  const queueHash = useMemo(() => {
    if (!queuedMessages?.length) return "";
    // Simple content hash: join lengths + first 20 chars of each item
    return queuedMessages.map((m) => `${m.length}:${m.slice(0, 20)}`).join("|");
  }, [queuedMessages]);

  useEffect(() => {
    if (!queueMode) return;
    // Skip if content hasn't actually changed
    if (queueHash === prevQueueHashRef.current && queueLen > 0) return;
    prevQueueHashRef.current = queueHash;

    const msgs = queuedMessages;
    if (!msgs?.length) {
      exitQueueMode(true);
      return;
    }
    const clamped = Math.min(queueCursor, msgs.length - 1);
    if (clamped !== queueCursor) setQueueCursor(clamped);
    updateValue(msgs[clamped] ?? "");
  }, [queueHash, queueLen, queueMode, queueCursor, exitQueueMode, updateValue, queuedMessages]);

  useInput(
    (input, key) => {
      if (disabled) return;

     // ---- terminal escape guard (mouse / wheel / ssh fragments) ----
   if (typeof input === "string") {
  // GCP Web SSH mouse fragments — must start with '[' or '<' to avoid catching ';' alone
  if (/^\[<[\d;]+[mM]?$/.test(input) || /^\[[\d;]+[mM]$/.test(input)) {
    return;
  }
  // residual SGR mouse fragments (Ink sometimes strips ESC): digits;digits;digitsM
  if (/^\d+;\d+;\d+[mM]$/.test(input)) {
    return;
  }
      // SGR mouse events (click / drag)
      if (
        input.startsWith("<") ||
        input.startsWith("\x1b[<") ||
        /\x1b\[\d+;\d+;\d+[mM]/.test(input)
      ) {
        return;
      }

      // mouse wheel scroll
      if (/\x1b\[<6[45];/.test(input)) {
        return;
      }

      // SSH broken arrow fragments
      if (/^\[\[?[ABCD]$/.test(input)) {
        return;
      }
    }

      // Raw ANSI arrow sequences — SSH environments where Ink doesn't parse key.leftArrow etc.
      // ESC gets consumed by Ink, leaving "[D"/["C"/["A"/["B" as the input string.
      if (input === "[D" || input === "\x1b[D") {
        if (!slashMenuOpen) setInputState(s => ({ ...s, cursor: Math.max(0, s.cursor - 1) }));
        return;
      }
      if (input === "[C" || input === "\x1b[C") {
        if (!slashMenuOpen) setInputState(s => ({ ...s, cursor: Math.min(s.value.length, s.cursor + 1) }));
        return;
      }
      if (input === "[A" || input === "\x1b[A") {
        if (slashMenuOpen && onSlashNavigate) {
          onSlashNavigate("up");
        } else if (queueMode && queuedMessages) {
          if (queueCursor > 0) {
            const next = queueCursor - 1;
            setQueueCursor(next);
            updateValue(queuedMessages[next] ?? "");
          }
          return;
        } else if (isRunning && !queueMode && queuedMessages?.length) {
          enterQueueMode(queuedMessages);
          return;
        } else {
          const prev = history.up(value);
          if (prev !== null) updateValue(prev);
        }
        return;
      }
      if (input === "[B" || input === "\x1b[B") {
        if (slashMenuOpen && onSlashNavigate) {
          onSlashNavigate("down");
        } else if (queueMode && queuedMessages) {
          if (queueCursor < queuedMessages.length - 1) {
            const next = queueCursor + 1;
            setQueueCursor(next);
            updateValue(queuedMessages[next] ?? "");
          } else {
            exitQueueMode(true);
          }
          return;
        } else {
          const next = history.down();
          if (next !== null) updateValue(next);
        }
        return;
      }

      // Esc → close task panel → close slash menu → exit queue mode → interrupt
      if (key.escape) {
        if (taskPanelOpen) {
          onTaskPanelClose?.();
          return;
        }
        if (slashMenuOpen) {
          onSlashClose?.();
          return;
        }
        if (queueMode) {
          exitQueueMode(true);
          return;
        }
        if (isRunning && onInterrupt) {
          onInterrupt();
        }
        return;
      }

      // Enter → task panel expand or submit
      if (key.return) {
        // If task panel is open in list mode → expand selected task
        if (taskPanelOpen && onTaskExpand) {
          onTaskExpand();
          return;
        }

        // Queue mode: save edited message at same position then exit
        if (queueMode) {
          const trimmed = value.trim();
          if (trimmed) {
            onQueueReplace?.(queueCursor, trimmed);
          } else {
            // Empty input → delete the item
            onQueueDelete?.(queueCursor);
          }
          exitQueueMode(false); // clear input after save
          return;
        }

        // If slash menu open and a command is selected, use it
        if (slashMenuOpen && onSlashSelect) {
          const selected = onSlashSelect();
          if (selected) {
            if (onSlashCommand) {
              onSlashCommand(selected);
            }
            updateValue("");
            onSlashClose?.();
            return;
          }
        }

        const trimmed = value.trim();
        if (!trimmed) return;

        if (trimmed.startsWith("/") && onSlashCommand) {
          onSlashCommand(trimmed);
          onSlashClose?.();
          history.push(trimmed);
          updateValue("");
        } else if (isRunning && onQueueMessage) {
          // Agent running → queue the message instead of sending
          onQueueMessage(trimmed);
          history.push(trimmed);
          updateValue("");
        } else {
          onSubmit(trimmed);
          history.push(trimmed);
          updateValue("");
        }
        return;
      }

      // Tab → autocomplete slash command
      if (key.tab && slashMenuOpen && onSlashSelect) {
        const selected = onSlashSelect();
        if (selected) {
          updateValue(selected + " ");
        }
        return;
      }

      // Left/Right arrow → move cursor inline
      if (key.leftArrow && !slashMenuOpen) {
        setInputState(s => ({ ...s, cursor: Math.max(0, s.cursor - 1) }));
        return;
      }
      if (key.rightArrow && !slashMenuOpen) {
        setInputState(s => ({ ...s, cursor: Math.min(s.value.length, s.cursor + 1) }));
        return;
      }

      // Ctrl+A → beginning, Ctrl+E → end
      if (key.ctrl && input === "a") {
        setInputState(s => ({ ...s, cursor: 0 }));
        return;
      }
      if (key.ctrl && input === "e") {
        setInputState(s => ({ ...s, cursor: s.value.length }));
        return;
      }

      // Arrow up/down — task panel > slash menu > queue mode > history/pending
      if (key.upArrow) {
        if (taskPanelOpen && onTaskNavigate) {
          onTaskNavigate("up");
        } else if (slashMenuOpen && onSlashNavigate) {
          onSlashNavigate("up");
        } else if (queueMode && queuedMessages) {
          // In queue mode: navigate to older (lower index = runs sooner)
          if (queueCursor > 0) {
            const next = queueCursor - 1;
            setQueueCursor(next);
            updateValue(queuedMessages[next] ?? "");
          }
        } else if (isRunning && queuedMessages?.length) {
          // Enter queue mode — start at most-recently-added item
          enterQueueMode(queuedMessages);
        } else if (!isRunning) {
          const prev = history.up(value);
          if (prev !== null) updateValue(prev);
        }
        return;
      }

      if (key.downArrow) {
        if (taskPanelOpen && onTaskNavigate) {
          onTaskNavigate("down");
        } else if (slashMenuOpen && onSlashNavigate) {
          onSlashNavigate("down");
        } else if (queueMode && queuedMessages) {
          // In queue mode: navigate to newer (higher index = runs later), or exit
          if (queueCursor < queuedMessages.length - 1) {
            const next = queueCursor + 1;
            setQueueCursor(next);
            updateValue(queuedMessages[next] ?? "");
          } else {
            exitQueueMode(true); // exit, restore original input
          }
        } else if (!value && !slashMenuOpen && hasBackgroundTasks && onTaskPanelOpen) {
          onTaskPanelOpen();
        } else if (!isRunning) {
          const next = history.down();
          if (next !== null) updateValue(next);
        }
        return;
      }

      // Backspace — delete char before cursor, or delete queue item when empty in queue mode
      if (key.backspace || key.delete) {
        if (queueMode && cursorPos === 0 && value === "") {
          // Delete the current queue item — useEffect will sync cursor + content after parent re-renders
          onQueueDelete?.(queueCursor);
          // Pre-adjust cursor so the effect lands on the right item
          if ((queuedMessages?.length ?? 0) <= 1) {
            exitQueueMode(true); // last item deleted
          } else {
            setQueueCursor((c) => Math.max(0, c - 1));
          }
          return;
        }
        // Functional update: each rapid backspace operates on the LATEST state,
        // not stale closure values. Fixes rapid-delete and text-reversal bugs.
        setInputState((s) => {
          if (s.cursor <= 0) return s;
          const nv = s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor);
          const nc = s.cursor - 1;
          if (onInputChange) {
            if (inputChangeTimerRef.current) clearTimeout(inputChangeTimerRef.current);
            inputChangeTimerRef.current = setTimeout(() => {
              onInputChange(nv);
              inputChangeTimerRef.current = null;
            }, 80);
          }
          return { value: nv, cursor: nc };
        });
        // Slash close: approximate with current render values (acceptable)
        if (cursorPos > 0) {
          const approxNew = value.slice(0, cursorPos - 1) + value.slice(cursorPos);
          if (!approxNew.startsWith("/") && slashMenuOpen) onSlashClose?.();
        }
        return;
      }

      // Regular character input — escape sequence 및 비인쇄 문자 필터링
      if (input && !key.ctrl && !key.meta) {
        // ANSI escape sequence, 마우스 이벤트, 제어 문자 차단
        // eslint-disable-next-line no-control-regex
        // Also filter residual [ABCD] from SSH (ESC consumed by Ink, leaving "[D" etc.)
        // Completely ignore residual mouse / wheel fragments
        // Common in GCP Web SSH where ESC gets stripped
        // Mouse fragment filter: requires digits (e.g. "64;3m") — standalone "m"/"M" must pass through
        if (/^[\[<;0-9mM]+$/.test(input) && /\d/.test(input)) {
          return;
        }

        const cleaned = input
          // control chars
          .replace(/[\x00-\x1f\x7f]/g, "")

          // ANSI escape sequences
          .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")

          // SGR mouse reporting
          .replace(/<\d+;\d+;\d+[mM]/g, "")

          // SSH arrow leftovers
          .replace(/^\[[ABCD]$/, "")

          // single stray bracket from xterm mouse
          .replace(/^\[$/, "");
        if (cleaned.length > 0) {
          const isPaste = cleaned.length > 10 || cleaned.includes("\n") || cleaned.includes("\t");
          const normalized = cleaned
            .replace(/\r/g, "")
            .replace(/\n+/g, " ")
            .replace(/\t/g, " ");

          if (isPaste) {
            showPasteBadge(cleaned.length);
          }

          // Functional update: each keypress inserts at the LATEST cursor,
          // not a stale closure value. Fixes text-reversal on rapid typing.
          const norm = normalized;
          setInputState((s) => {
            const nv = s.value.slice(0, s.cursor) + norm + s.value.slice(s.cursor);
            const nc = s.cursor + norm.length;
            if (onInputChange) {
              if (inputChangeTimerRef.current) clearTimeout(inputChangeTimerRef.current);
              inputChangeTimerRef.current = setTimeout(() => {
                onInputChange(nv);
                inputChangeTimerRef.current = null;
              }, 80);
            }
            return { value: nv, cursor: nc };
          });
        }
      }
    },
  );

  const prompt = TOKENS.brand.prompt;
  // Memoize separator to avoid recreating the string on every render
const separator = useMemo(() => {
  const w = columns - 1;
  return w > 0 ? TOKENS.box.horizontal.repeat(w) : "";
}, [columns]);
  // While running, show current typing (for pending queue). Cursor hidden while running.
  const displayValue = value;
  const clampedCursor = Math.min(cursorPos, displayValue.length);

  // Detect if input is a recognized slash command → show token in cyan/red
  const isSlash = displayValue.startsWith("/");
  const cmdToken = isSlash ? displayValue.split(" ")[0] : "";
  const cmdRest = isSlash ? displayValue.slice(cmdToken.length) : "";
  const cmdRecognized = isSlash && isKnownCommand(cmdToken);
  
  // Show cursor when idle, or when in queue mode (editing a queued message while agent runs)
  const showCursor = (!isRunning || queueMode) && !slashMenuOpen;

  /**
   * Build the input line as a SINGLE string with embedded ANSI codes for:
   * - cursor inverse highlight  (\x1b[7m ... \x1b[27m)
   * - slash command coloring    (\x1b[36m cyan / \x1b[31m red)
   *
   * Reason: Ink/Yoga calculates box widths by character count, not display
   * width. Splitting the line into multiple <Text> spans causes the cursor
   * block to be placed at the wrong column for CJK (Korean/Chinese/Japanese)
   * double-width characters. A single string lets the terminal handle layout.
   */
  const CURSOR_ON  = "\x1b[7m";
  const CURSOR_OFF = "\x1b[27m";
  const FG_CYAN    = "\x1b[36m";
  const FG_RED     = "\x1b[31m";
  const FG_RESET   = "\x1b[39m";

  let inputLine: string;
  if (showCursor) {
    const before = displayValue.slice(0, clampedCursor);
    const after  = displayValue.slice(clampedCursor);

    const cursor = `${CURSOR_ON} ${CURSOR_OFF}`;

    if (isSlash) {
      const color = cmdRecognized ? FG_CYAN : FG_RED;

      if (clampedCursor <= cmdToken.length) {
        const left = cmdToken.slice(0, clampedCursor);
        const right = cmdToken.slice(clampedCursor);

        inputLine =
          `${color}${left}${FG_RESET}${cursor}${color}${right}${FG_RESET}${cmdRest}`;
      } else {
        const restBefore = before.slice(cmdToken.length);

        inputLine =
          `${color}${cmdToken}${FG_RESET}${restBefore}${cursor}${after}`;
      }
    } else {
      inputLine = `${before}${cursor}${after}`;
    }
  } else {
    // No cursor (running or slash menu open)
    if (isSlash) {
      const color = cmdRecognized ? FG_CYAN : FG_RED;
      inputLine = `${color}${cmdToken}${FG_RESET}${cmdRest}`;
    } else {
      inputLine = displayValue;
    }
  }

  const boxTop = useMemo(() => {
    const w = Math.max(0, columns - 2);
    return `\u250C${"─".repeat(w)}\u2510`;
  }, [columns]);
  const boxBottom = useMemo(() => {
    const w = Math.max(0, columns - 2);
    return `\u2514${"─".repeat(w)}\u2518`;
  }, [columns]);

  return (
    <Box width={columns} flexDirection="column" flexShrink={0} height={4} overflow="hidden">
      {/* Queue nav header (queue mode) OR pending message hint — fixed 1 row */}
      <Box height={1}>
        {queueMode && queuedMessages ? (
          <Text>
            <Text color="#6366f1">[Queue {queueCursor + 1}/{queuedMessages.length}] </Text>
            <Text dimColor>↑↓ nav  </Text>
            <Text dimColor>⏎ save  </Text>
            <Text dimColor>⌫ del  </Text>
            <Text dimColor>Esc cancel</Text>
          </Text>
        ) : isRunning && pendingMessage ? (
          <>
            <Text dimColor color="#9a9a9a" wrap="truncate">
              {pendingMessage.length > columns - 18
                ? pendingMessage.slice(0, columns - 21) + "…"
                : pendingMessage}
            </Text>
            <Text dimColor>
              {pendingCount && pendingCount > 1
                ? ` (+${pendingCount - 1} more queued)`
                : " (queued)"}
            </Text>
          </>
        ) : null}
      </Box>
      {/* Top border */}
      <Text dimColor>{boxTop}</Text>
      {/* Input rows — multi-line support */}
      {(() => {
        // Calculate available content width:
        // columns - 2 (box borders "│") - 2 (spaces after/before "│") - prefix width
        // prefix = "│ " (2) already counted, then "> " or "✎ " (2) = 4 total overhead
        const prefixWidth = queueMode ? 2 : isSlash ? 0 : (prompt.length + 1); // "> " or "" for slash
        // "│ " left border (2) + prefix + " │" right border (2) = 4 + prefixWidth
        const contentWidth = Math.max(20, columns - 4 - prefixWidth);

        // Split displayValue into wrapped lines (CJK-aware via stringWidth)
        const wrappedLines: string[] = [];
        if (!displayValue) {
          wrappedLines.push("");
        } else {
          let remaining = displayValue;
          while (remaining.length > 0) {
            let cutAt = remaining.length;
            let w = 0;
            for (let i = 0; i < remaining.length; i++) {
              const charW = stringWidth(remaining[i] ?? "");
              if (w + charW > contentWidth) { cutAt = i; break; }
              w += charW;
            }
            if (cutAt === 0) cutAt = 1; // guard: always advance at least 1 char
            wrappedLines.push(remaining.slice(0, cutAt));
            remaining = remaining.slice(cutAt);
          }
        }

        return wrappedLines.map((line, lineIdx) => {
          const lineStart = wrappedLines.slice(0, lineIdx).reduce((s, l) => s + l.length, 0);
          const lineEnd = lineStart + line.length;
          const isFirstLine = lineIdx === 0;

          // Build line content with cursor inserted at correct position
          let lineContent: string;
          if (showCursor && clampedCursor >= lineStart && clampedCursor <= lineEnd) {
            const localCursor = clampedCursor - lineStart;
            if (isSlash) {
              // Re-apply slash coloring for this line segment
              const color = cmdRecognized ? FG_CYAN : FG_RED;
              const absStart = lineStart;
              const tokenEndInLine = Math.max(0, cmdToken.length - absStart);
              const localBefore = line.slice(0, localCursor);
              const cursorChar = line[localCursor] ?? " ";
              const localAfter = line.slice(localCursor + 1);
              if (localCursor <= tokenEndInLine) {
                // cursor is inside the command token portion
                const leftToken = localBefore;
                const rightToken = line.slice(localCursor, tokenEndInLine);
                const rest = line.slice(tokenEndInLine);
                lineContent = `${color}${leftToken}${CURSOR_OFF}${CURSOR_ON}${cursorChar}${CURSOR_OFF}${color}${rightToken}${FG_RESET}${rest}`;
              } else {
                lineContent = `${color}${line.slice(0, tokenEndInLine)}${FG_RESET}${localBefore.slice(tokenEndInLine)}${CURSOR_ON}${cursorChar}${CURSOR_OFF}${localAfter}`;
              }
            } else {
              const before = line.slice(0, localCursor);
              const cursorChar = line[localCursor] ?? " ";
              const after = line.slice(localCursor + 1);
              lineContent = `${before}${CURSOR_ON}${cursorChar}${CURSOR_OFF}${after}`;
            }
          } else {
            // No cursor on this line — apply slash coloring if needed
            if (isSlash && isFirstLine) {
              const color = cmdRecognized ? FG_CYAN : FG_RED;
              const tokenPart = line.slice(0, cmdToken.length);
              const restPart = line.slice(cmdToken.length);
              lineContent = `${color}${tokenPart}${FG_RESET}${restPart}`;
            } else {
              lineContent = line;
            }
          }

          return (
            <Box key={lineIdx} justifyContent="space-between">
              <Box flexShrink={1}>
                <Text dimColor>{"│"} </Text>
                {isFirstLine && queueMode && <Text color="#6366f1">✎ </Text>}
                {!isFirstLine && <Text>{"  "}</Text>}
                {isFirstLine && isRunning && !displayValue
                  ? <Text dimColor>Message YUAN...</Text>
                  : isFirstLine && !displayValue && !isRunning
                  ? (
                    <>
                      {!queueMode && <Text dimColor>{prompt} </Text>}
                      <Text dimColor>Message YUAN...</Text>
                    </>
                  )
                  : isFirstLine && !queueMode
                  ? (
                    <>
                      {!isSlash && <Text dimColor>{prompt} </Text>}
                      <Text>{lineContent}</Text>
                    </>
                  )
                  : <Text>{lineContent}</Text>
                }
              </Box>
              <Box flexShrink={0}>
                {isFirstLine && pasteBadge ? <Text dimColor>{pasteBadge} </Text> : null}
                <Text dimColor>{"│"}</Text>
              </Box>
            </Box>
          );
        });
      })()}
      {/* Bottom border */}
      <Text dimColor>{boxBottom}</Text>
    </Box>
  );
});
