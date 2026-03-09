/**
 * FooterBar — bottom keybind hints.
 * Adapts to current state: running, slash menu open, or idle.
 */

import React from "react";
import { Box, Text } from "ink";
import { useTerminalSize } from "../hooks/useTerminalSize.js";

export interface FooterBarProps {
  isRunning?: boolean;
  slashMenuOpen?: boolean;
}

export function FooterBar({ isRunning, slashMenuOpen }: FooterBarProps): React.JSX.Element {
  const { columns } = useTerminalSize();

  if (isRunning) {
    return (
      <Box width={columns}>
        <Text dimColor>esc</Text>
        <Text dimColor> to interrupt</Text>
      </Box>
    );
  }

  if (slashMenuOpen) {
    return (
      <Box width={columns} justifyContent="space-between">
        <Box>
          <Text bold>↑↓</Text>
          <Text dimColor> navigate  </Text>
          <Text bold>tab</Text>
          <Text dimColor> complete  </Text>
          <Text bold>enter</Text>
          <Text dimColor> execute  </Text>
          <Text bold>esc</Text>
          <Text dimColor> close</Text>
        </Box>
        <Text dimColor>···</Text>
      </Box>
    );
  }

  return (
    <Box width={columns} justifyContent="space-between">
      <Box>
        <Text bold>/</Text>
        <Text dimColor> commands  </Text>
        <Text bold>↑↓</Text>
        <Text dimColor> history  </Text>
        <Text bold>ctrl+c</Text>
        <Text dimColor> exit</Text>
      </Box>
      <Text dimColor>···</Text>
    </Box>
  );
}
