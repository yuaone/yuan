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
  const boxWidth = Math.min(width - 4, 50);

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
    <Box flexDirection="column" width={boxWidth}>
      <Text dimColor>
        {TOKENS.box.topLeft}{TOKENS.box.horizontal.repeat(boxWidth - 2)}{TOKENS.box.topRight}
      </Text>
      {hasAbove && (
        <Box>
          <Text dimColor>
            {TOKENS.box.vertical}  ↑ {windowStart} more
          </Text>
        </Box>
      )}
      {visible.map((cmd, i) => {
        const actualIdx = windowStart + i;
        const isSelected = actualIdx === selectedIndex;
        const nameWidth = 12;
        const name = cmd.name.padEnd(nameWidth);
        const descWidth = boxWidth - nameWidth - 6;
        const desc =
          cmd.description.length > descWidth
            ? cmd.description.slice(0, descWidth - 1) + "…"
            : cmd.description;

        return (
          <Box key={cmd.name}>
            <Text dimColor>{TOKENS.box.vertical} </Text>
            {isSelected ? (
              <>
                <Text bold color="white">{name}</Text>
                <Text color="white"> {desc}</Text>
              </>
            ) : (
              <>
                <Text>{name}</Text>
                <Text dimColor> {desc}</Text>
              </>
            )}
          </Box>
        );
      })}
      {hasBelow && (
        <Box>
          <Text dimColor>
            {TOKENS.box.vertical}  ↓ {commands.length - windowEnd} more
          </Text>
        </Box>
      )}
      <Text dimColor>
        {TOKENS.box.bottomLeft}{TOKENS.box.horizontal.repeat(boxWidth - 2)}{TOKENS.box.bottomRight}
      </Text>
    </Box>
  );
}
