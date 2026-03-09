/**
 * BashOutput — shell command output in a bordered box.
 */

import React from "react";
import { Box, Text } from "ink";
import { TOKENS } from "../lib/tokens.js";
import { truncate } from "../lib/truncate.js";

export interface BashOutputProps {
  command: string;
  output: string;
  exitCode?: number;
  width: number;
}

export function BashOutput({
  command: _command,
  output,
  exitCode,
  width,
}: BashOutputProps): React.JSX.Element {
  const boxWidth = Math.max(20, width - 6);
  const contentWidth = boxWidth - 4; // borders + padding
  const lines = output.split("\n");
  const maxLines = 20;
  const truncatedLines = lines.length > maxLines;
  const visibleLines = truncatedLines ? lines.slice(0, maxLines) : lines;

  const headerColor = exitCode != null && exitCode !== 0 ? "red" : undefined;
  const headerText = exitCode != null && exitCode !== 0
    ? `output (exit ${exitCode})`
    : "output";

  const headerLine = `${TOKENS.box.topLeft}${TOKENS.box.horizontal} ${headerText} ${TOKENS.box.horizontal.repeat(Math.max(0, boxWidth - headerText.length - 5))}${TOKENS.box.topRight}`;

  return (
    <Box flexDirection="column">
      <Text dimColor color={headerColor}>{headerLine}</Text>
      {visibleLines.map((line, i) => (
        <Box key={i}>
          <Text dimColor>{TOKENS.box.vertical}  </Text>
          <Text>{truncate(line, contentWidth)}</Text>
        </Box>
      ))}
      {truncatedLines && (
        <Box>
          <Text dimColor>{TOKENS.box.vertical}  ... ({lines.length - maxLines} more lines)</Text>
        </Box>
      )}
      <Text dimColor>
        {TOKENS.box.bottomLeft}{TOKENS.box.horizontal.repeat(boxWidth - 2)}{TOKENS.box.bottomRight}
      </Text>
    </Box>
  );
}
