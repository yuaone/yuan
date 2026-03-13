/**
 * SlashMenu — autocomplete dropdown for slash commands.
 * Appears BELOW the input box  when user types "/".
 * Sliding window follows selectedIndex so all commands are reachable.
 */

import React from "react";
import { Box, Text } from "ink";
import { TOKENS } from "../lib/tokens.js";
import type { SlashCommand } from "../types.js";

export interface SlashMenuProps {
  commands: SlashCommand[];
  selectedIndex: number;
  isOpen: boolean;
  width: number;
}

export function SlashMenu({
  commands,
  selectedIndex,
  isOpen,
  width,
}: SlashMenuProps): React.JSX.Element | null {
  if (!isOpen || commands.length === 0) return null;

  const maxVisible = 8;
  const menuWidth = width;
  const nameWidth = Math.min(22, Math.max(16, Math.floor(menuWidth * 0.24)));
  const descWidth = Math.max(12, menuWidth - nameWidth - 6);

  // Sliding window: keep selectedIndex within the visible range
  let windowStart = 0;
  if (commands.length > maxVisible) {
    // Center the selection in the window, clamped to bounds
    windowStart = Math.max(0, Math.min(
      selectedIndex - Math.floor(maxVisible / 2),
      commands.length - maxVisible,
    ));
  }
  const windowEnd = Math.min(commands.length, windowStart + maxVisible);
  const visible = commands.slice(windowStart, windowEnd);

  const hasAbove = windowStart > 0;
  const hasBelow = windowEnd < commands.length;

  return (
<Box flexDirection="column" width={menuWidth} paddingLeft={1}>
      {hasAbove && (
        <Box marginBottom={0}>
          <Text dimColor>{`  ↑ ${windowStart} more`}</Text>
        </Box>
      )}
      {visible.map((cmd, i) => {
        const actualIdx = windowStart + i;
        const isSelected = actualIdx === selectedIndex;
        const name =
          cmd.name.length > nameWidth
            ? cmd.name.slice(0, nameWidth - 1) + "…"
            : cmd.name.padEnd(nameWidth);
        const desc =
          cmd.description.length > descWidth
            ? cmd.description.slice(0, descWidth - 1) + "…"
            : cmd.description;

        return (
          <Box key={cmd.name} paddingLeft={1}>
            {isSelected ? (
              <>
                <Text color="cyan">› </Text>
                <Text bold color="cyan">{name}</Text>
                <Text color="white"> {desc}</Text>
              </>
            ) : (
              <>
                <Text dimColor>{"  "}</Text>
                <Text color="white">{name}</Text>
                <Text dimColor> {desc}</Text>
              </>
            )}
          </Box>
        );
      })}
      {hasBelow && (
        <Box marginTop={0}>
          <Text dimColor>{`  ↓ ${commands.length - windowEnd} more`}</Text>
        </Box>
      )}
    </Box>
  );
}
