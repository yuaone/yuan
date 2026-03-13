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
        } else {
          onSubmit(trimmed);
        }

        history.push(trimmed);
        updateValue("");
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
        const cleaned = input.replace(/[\x00-\x1f\x7f]|\x1b\[[^a-zA-Z]*[a-zA-Z]/g, "");
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

  const prompt = isRunning ? " " : TOKENS.brand.prompt;
  const displayValue = isRunning ? "" : value;
  const clampedCursor = Math.min(cursorPos, displayValue.length);

  // Detect if input is a recognized slash command → show token in cyan/red
  const isSlash = displayValue.startsWith("/");
  const cmdToken = isSlash ? displayValue.split(" ")[0] : "";
  const cmdRest = isSlash ? displayValue.slice(cmdToken.length) : "";
  const cmdRecognized = isSlash && isKnownCommand(cmdToken);

  // Cursor rendering: chars before cursor | cursor block (inverted) | chars after
  const showCursor = !isRunning && !slashMenuOpen;
  const beforeCursor = displayValue.slice(0, clampedCursor);
  const cursorChar = displayValue[clampedCursor] ?? " ";
  const afterCursor = displayValue.slice(clampedCursor + 1);

  return (
    <Box width={columns} flexDirection="column" flexShrink={0}>
      <Text dimColor>{TOKENS.box.horizontal.repeat(Math.max(0, columns - 1))}</Text>
      <Box justifyContent="space-between">
        <Box flexShrink={1} overflow="hidden">
          <Text dimColor>{prompt} </Text>
          {showCursor ? (
            // Cursor-aware rendering
            isSlash ? (
              <>
                <Text color={cmdRecognized ? "cyan" : "red"}>{cmdToken}</Text>
                <Text>{beforeCursor.slice(cmdToken.length)}</Text>
                <Text inverse>{cursorChar}</Text>
                <Text>{afterCursor}</Text>
              </>
            ) : (
              <>
                <Text>{beforeCursor}</Text>
                <Text inverse>{cursorChar}</Text>
                <Text>{afterCursor}</Text>
              </>
            )
          ) : (
            isSlash ? (
              <>
                <Text color={cmdRecognized ? "cyan" : "red"}>{cmdToken}</Text>
                <Text>{cmdRest}</Text>
              </>
            ) : (
              <Text>{displayValue}</Text>
            )
          )}
        </Box>

        <Box flexShrink={0}>
          {pasteBadge ? <Text dimColor>{pasteBadge}</Text> : null}
        </Box>
      </Box>
    </Box>
  );
}
