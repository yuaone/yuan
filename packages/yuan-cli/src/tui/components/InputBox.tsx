/**
 * InputBox — fixed bottom input with prompt, history, slash commands.
 * When "/" is typed, notifies parent to open SlashMenu.
 * Arrow up/down in slash mode → navigate menu (not history).
 * Tab → autocomplete selected slash command.
 * Esc → close slash menu or interrupt agent.
 */

import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Box, Text, useInput } from "ink";
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

export function InputBox({
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
  useEffect(() => {
    if (!queueMode) return;
    const msgs = queuedMessages;
    if (!msgs?.length) {
      exitQueueMode(true);
      return;
    }
    const clamped = Math.min(queueCursor, msgs.length - 1);
    if (clamped !== queueCursor) setQueueCursor(clamped);
    updateValue(msgs[clamped] ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuedMessages]); // intentionally only on queuedMessages change

  useInput(
    (input, key) => {
      if (disabled) return;

     // ---- terminal escape guard (mouse / wheel / ssh fragments) ----
   if (typeof input === "string") {
  // GCP Web SSH mouse fragments
  if (/^[\[<;0-9mM]+$/.test(input)) {
    return;
  }
  // residual SGR mouse fragments (Ink sometimes strips ESC)
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
        if (cursorPos > 0) {
          const newVal = value.slice(0, cursorPos - 1) + value.slice(cursorPos);
          updateValue(newVal, cursorPos - 1);
          if (!newVal.startsWith("/") && slashMenuOpen) {
            onSlashClose?.();
          }
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
        if (/^[\[<;0-9mM]+$/.test(input)) {
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

          // Insert at cursor position
          const newVal = value.slice(0, cursorPos) + normalized + value.slice(cursorPos);
          updateValue(newVal, cursorPos + normalized.length);
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
    <Box width={columns} flexDirection="column" flexShrink={0}>
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
      {/* Input row inside box */}
      <Box justifyContent="space-between">
        <Box flexShrink={1}>
          <Text dimColor>{"\u2502"} </Text>
          {queueMode ? (
            <>
              <Text color="#6366f1">✎ </Text>
              <Text wrap="truncate">{inputLine}</Text>
            </>
          ) : isRunning && !value ? (
            <Text dimColor wrap="truncate">Message YUAN...</Text>
          ) : !value && !isRunning ? (
            <>
              <Text dimColor>{prompt} </Text>
              <Text wrap="truncate">{inputLine}</Text>
              {!inputLine && <Text dimColor wrap="truncate">Message YUAN...</Text>}
            </>
          ) : (
            <>
              <Text dimColor>{prompt} </Text>
              <Text wrap="truncate">{inputLine}</Text>
            </>
          )}
        </Box>
        <Box flexShrink={0}>
          {pasteBadge ? <Text dimColor>{pasteBadge} </Text> : null}
          <Text dimColor>{"\u2502"}</Text>
        </Box>
      </Box>
      {/* Bottom border */}
      <Text dimColor>{boxBottom}</Text>
    </Box>
  );
}
