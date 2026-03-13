/**
 * InputBox — fixed bottom input with prompt, history, slash commands.
 * When "/" is typed, notifies parent to open SlashMenu.
 * Arrow up/down in slash mode → navigate menu (not history).
 * Tab → autocomplete selected slash command.
 * Esc → close slash menu or interrupt agent.
 */

import React, { useState, useCallback, useEffect, useRef } from "react";
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
}: InputBoxProps): React.JSX.Element {
  const { columns } = useTerminalSize();
  const history = useInputHistory();
  const [value, setValue] = useState("");
  const [cursorPos, setCursorPos] = useState(0);

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
      setValue(newValue);
      setCursorPos(newCursor ?? newValue.length);
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

  useInput(
    (input, key) => {
      if (disabled) return;

      // Raw ANSI arrow sequences — SSH environments where Ink doesn't parse key.leftArrow etc.
      // ESC gets consumed by Ink, leaving "[D"/["C"/["A"/["B" as the input string.
      if (input === "[D" || input === "\x1b[D") {
        if (!slashMenuOpen) setCursorPos((p) => Math.max(0, p - 1));
        return;
      }
      if (input === "[C" || input === "\x1b[C") {
        if (!slashMenuOpen) setCursorPos((p) => Math.min(value.length, p + 1));
        return;
      }
      if (input === "[A" || input === "\x1b[A") {
        if (slashMenuOpen && onSlashNavigate) {
          onSlashNavigate("up");
        } else {
          const prev = history.up(value);
          if (prev !== null) updateValue(prev);
        }
        return;
      }
      if (input === "[B" || input === "\x1b[B") {
        if (slashMenuOpen && onSlashNavigate) {
          onSlashNavigate("down");
        } else {
          const next = history.down();
          if (next !== null) updateValue(next);
        }
        return;
      }

      // Esc → close slash menu first, then interrupt
      if (key.escape) {
        if (slashMenuOpen) {
          onSlashClose?.();
          return;
        }
        if (isRunning && onInterrupt) {
          onInterrupt();
        }
        return;
      }

      // Enter → submit or execute slash command
      if (key.return) {
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
        setCursorPos(p => Math.max(0, p - 1));
        return;
      }
      if (key.rightArrow && !slashMenuOpen) {
        setCursorPos(p => Math.min(value.length, p + 1));
        return;
      }

      // Ctrl+A → beginning, Ctrl+E → end
      if (key.ctrl && input === "a") {
        setCursorPos(0);
        return;
      }
      if (key.ctrl && input === "e") {
        setCursorPos(value.length);
        return;
      }

      // Arrow up/down → slash menu navigation or history
      if (key.upArrow) {
        if (slashMenuOpen && onSlashNavigate) {
          onSlashNavigate("up");
        } else {
          const prev = history.up(value);
          if (prev !== null) {
            updateValue(prev);
          }
        }
        return;
      }

      if (key.downArrow) {
        if (slashMenuOpen && onSlashNavigate) {
          onSlashNavigate("down");
        } else {
          const next = history.down();
          if (next !== null) {
            updateValue(next);
          }
        }
        return;
      }

      // Backspace — delete char before cursor
      if (key.backspace || key.delete) {
        if (cursorPos > 0) {
          const newVal = value.slice(0, cursorPos - 1) + value.slice(cursorPos);
          updateValue(newVal, cursorPos - 1);
          // Close slash menu if we deleted the "/"
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
        const cleaned = input.replace(/[\x00-\x1f\x7f]|\x1b\[[^a-zA-Z]*[a-zA-Z]|\[[ABCD]$/g, "");
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
  // While running, show current typing (for pending queue). Cursor hidden while running.
  const displayValue = value;
  const clampedCursor = Math.min(cursorPos, displayValue.length);

  // Detect if input is a recognized slash command → show token in cyan/red
  const isSlash = displayValue.startsWith("/");
  const cmdToken = isSlash ? displayValue.split(" ")[0] : "";
  const cmdRest = isSlash ? displayValue.slice(cmdToken.length) : "";
  const cmdRecognized = isSlash && isKnownCommand(cmdToken);

  // Show cursor only when not running and not in slash menu
  const showCursor = !isRunning && !slashMenuOpen;

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
    const ch     = displayValue[clampedCursor] ?? " ";
    const after  = displayValue.slice(clampedCursor + 1);

    if (isSlash) {
      const color = cmdRecognized ? FG_CYAN : FG_RED;
      if (clampedCursor <= cmdToken.length) {
        // Cursor is inside the slash command token
        const tb = cmdToken.slice(0, clampedCursor);
        const ta = cmdToken.slice(clampedCursor + 1) + cmdRest.slice(1);
        inputLine = `${color}${tb}${CURSOR_ON}${ch}${CURSOR_OFF}${ta}${FG_RESET}`;
      } else {
        // Cursor is past the command token, in the args
        const restBefore = before.slice(cmdToken.length);
        inputLine = `${color}${cmdToken}${FG_RESET}${restBefore}${CURSOR_ON}${ch}${CURSOR_OFF}${after}`;
      }
    } else {
      inputLine = `${before}${CURSOR_ON}${ch}${CURSOR_OFF}${after}`;
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

  return (
    <Box width={columns} flexDirection="column" flexShrink={0}>
      <Text dimColor>{TOKENS.box.horizontal.repeat(Math.max(0, columns - 1))}</Text>
      {/* Pending queued message — shown above input when agent is running */}
      {isRunning && pendingMessage ? (
        <Box>
          <Text dimColor>⏸ </Text>
          <Text dimColor color="yellow">{pendingMessage.length > columns - 6 ? pendingMessage.slice(0, columns - 9) + "…" : pendingMessage}</Text>
          <Text dimColor> (queued)</Text>
        </Box>
      ) : null}
      <Box justifyContent="space-between">
        <Box flexShrink={1} overflow="hidden">
          {isRunning && !value ? (
            // Running with no typed input — show dim hint
            <Text dimColor>{prompt} type to queue next message…</Text>
          ) : (
            <>
              <Text dimColor>{prompt} </Text>
              <Text>{inputLine}</Text>
            </>
          )}
        </Box>

        <Box flexShrink={0}>
          {pasteBadge ? <Text dimColor>{pasteBadge}</Text> : null}
        </Box>
      </Box>
    </Box>
  );
}
