/**
 * InputBox — fixed bottom input with prompt, history, slash commands.
 * When "/" is typed, notifies parent to open SlashMenu.
 * Arrow up/down in slash mode → navigate menu (not history).
 * Tab → autocomplete selected slash command.
 * Esc → close slash menu or interrupt agent.
 */

import React, { useState, useCallback } from "react";
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
          updateValue(value + cleaned);
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
    <Box width={columns} height={1} flexDirection="column" flexShrink={0}>
      <Box>
        <Text dimColor>{prompt} </Text>
        {isSlash ? (
          <>
            <Text dimColor={cmdRecognized} color={cmdRecognized ? undefined : "red"}>
              {cmdToken}
            </Text>
            <Text>{cmdRest}</Text>
          </>
        ) : (
          <Text>{displayValue}</Text>
        )}
        {!isRunning && <Text dimColor>█</Text>}
      </Box>
    </Box>
  );
}
