/**
 * DiffView — inline diff with red/green highlighting and line numbers.
 */

import React from "react";
import { Box, Text } from "ink";
import { TOKENS } from "../lib/tokens.js";
import type { ParsedDiff } from "../types.js";
import { truncate } from "../lib/truncate.js";

export interface DiffViewProps {
  diff: ParsedDiff;
  width: number;
}

export function DiffView({ diff, width }: DiffViewProps): React.JSX.Element {
  const boxWidth = Math.max(20, width - 4);
  const lineNumWidth = 4;
  const contentWidth = boxWidth - lineNumWidth - 5; // borders, padding, sign

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Text dimColor>
        {TOKENS.box.topLeft}{TOKENS.box.horizontal.repeat(boxWidth - 2)}{TOKENS.box.topRight}
      </Text>

      {/* Hunks */}
      {diff.hunks.map((hunk, hi) => (
        <Box key={hi} flexDirection="column">
          {diff.hunks.length > 1 && (
            <Box>
              <Text dimColor>{TOKENS.box.vertical} </Text>
              <Text color="cyan">
                @@ -{hunk.startOld} +{hunk.startNew} @@
              </Text>
            </Box>
          )}
          {hunk.lines.map((line, li) => {
            const lineNo =
              line.type === "delete"
                ? String(line.oldLineNo ?? "").padStart(lineNumWidth)
                : line.type === "add"
                  ? String(line.newLineNo ?? "").padStart(lineNumWidth)
                  : String(line.oldLineNo ?? "").padStart(lineNumWidth);

            const sign = line.type === "add" ? "+" : line.type === "delete" ? "-" : " ";
            const content = truncate(line.content, contentWidth);

            return (
              <Box key={`${hi}-${li}`}>
                <Text dimColor>{TOKENS.box.vertical} </Text>
                <Text dimColor>{lineNo} </Text>
                <Text dimColor>{TOKENS.box.vertical} </Text>
                {line.type === "add" ? (
                  <Text color="green" bold>{sign}</Text>
                ) : line.type === "delete" ? (
                  <Text color="red" bold>{sign}</Text>
                ) : (
                  <Text dimColor>{sign}</Text>
                )}
                {line.type === "add" ? (
                  <Text color="green"> {content}</Text>
                ) : line.type === "delete" ? (
                  <Text color="red"> {content}</Text>
                ) : (
                  <Text dimColor> {content}</Text>
                )}
              </Box>
            );
          })}
        </Box>
      ))}

      {/* Bottom border with stats */}
      <Box justifyContent="space-between">
        <Text dimColor>
          {TOKENS.box.bottomLeft}{TOKENS.box.horizontal.repeat(boxWidth - 2)}{TOKENS.box.bottomRight}
        </Text>
      </Box>
      <Box paddingLeft={2}>
        <Text color="green">+{diff.additions}</Text>
        <Text> </Text>
        <Text color="red">-{diff.deletions}</Text>
      </Box>
    </Box>
  );
}
