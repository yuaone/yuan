/**
 * SlashMenu — autocomplete dropdown for slash commands.
 * Appears above the input box when user types "/".
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

  const maxVisible = Math.min(commands.length, 8);
  const visible = commands.slice(0, maxVisible);
  const boxWidth = Math.min(width - 4, 50);

  return (
    <Box flexDirection="column" width={boxWidth}>
      <Text dimColor>
        {TOKENS.box.topLeft}{TOKENS.box.horizontal.repeat(boxWidth - 2)}{TOKENS.box.topRight}
      </Text>
      {visible.map((cmd, i) => {
        const isSelected = i === selectedIndex;
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
      {commands.length > maxVisible && (
        <Box>
          <Text dimColor>
            {TOKENS.box.vertical} ... {commands.length - maxVisible} more
          </Text>
        </Box>
      )}
      <Text dimColor>
        {TOKENS.box.bottomLeft}{TOKENS.box.horizontal.repeat(boxWidth - 2)}{TOKENS.box.bottomRight}
      </Text>
    </Box>
  );
}
