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

  const [pasteBadge, setPasteBadge] = useState<string | null>(null);
  const pasteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    (newValue: string) => {
      setValue(newValue);
      onInputChange?.(newValue);
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

      // Backspace
      if (key.backspace || key.delete) {
        if (value.length > 0) {
          const newVal = value.slice(0, -1);
          updateValue(newVal);
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

          updateValue(value + normalized);
        }
      }
    },
  );

  const prompt = isRunning ? " " : TOKENS.brand.prompt;
  const displayValue = isRunning ? "" : value;

  // Detect if input is a recognized slash command → show token in dim
  const isSlash = displayValue.startsWith("/");
  const cmdToken = isSlash ? displayValue.split(" ")[0] : "";
  const cmdRest = isSlash ? displayValue.slice(cmdToken.length) : "";
  const cmdRecognized = isSlash && isKnownCommand(cmdToken);

  return (
    <Box width={columns} flexDirection="column" flexShrink={0}>
      <Text dimColor>{TOKENS.box.horizontal.repeat(Math.max(0, columns - 1))}</Text>
      <Box justifyContent="space-between">
        <Box>
          <Text dimColor>{prompt} </Text>
          {isSlash ? (
            <>
              <Text color={cmdRecognized ? "cyan" : "red"}>
                {cmdToken}
              </Text>
              <Text>{cmdRest}</Text>
            </>
          ) : (
            <Text>{displayValue}</Text>
          )}
          {!isRunning && !slashMenuOpen && <Text dimColor>█</Text>}
        </Box>

        <Box>
          {pasteBadge ? <Text dimColor>{pasteBadge}</Text> : null}
        </Box>
      </Box>
    </Box>
  );
}
