/**
 * DiffView — Claude Code style rectangular diff with full-width colored background lines.
 */

import React from "react";
import { Box, Text } from "ink";
import type { ParsedDiff } from "../types.js";
import { truncate } from "../lib/truncate.js";
import stringWidth from "string-width";
import path from "path";

export interface DiffViewProps {
  diff: ParsedDiff;
  width: number;
}

export function DiffView({ diff, width }: DiffViewProps): React.JSX.Element {
  const boxWidth = Math.max(20, width - 6);
  const lineNumWidth = 4;
  // sign(1) + space(1) + lineNum(lineNumWidth) + space(2) + content
  const prefixWidth = 1 + 1 + lineNumWidth + 2;
  const contentWidth = boxWidth - prefixWidth;

  const shortPath = diff.filePath
    ? path.basename(diff.filePath)
    : "";

  function padLine(raw: string): string {
    const rawWidth = stringWidth(raw);
    const padding = Math.max(0, boxWidth - rawWidth);
    return raw + " ".repeat(padding);
  }

  return (
    <Box flexDirection="column">
      {/* File path header — dimmed, no border */}
      <Text dimColor>{"  "}{shortPath}</Text>

      {/* Hunks */}
      {diff.hunks.map((hunk, hi) => (
        <Box key={hi} flexDirection="column">
          {diff.hunks.length > 1 && (
            <Text color="cyan">
              {"  "}@@ -{hunk.startOld} +{hunk.startNew} @@
            </Text>
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

            // Build raw string for width calculation: "sign lineNo  content"
            const rawLine = `${sign} ${lineNo}  ${content}`;

            if (line.type === "add") {
              return (
                <Text key={`${hi}-${li}`} backgroundColor="green" color="black">
                  {padLine(rawLine)}
                </Text>
              );
            } else if (line.type === "delete") {
              return (
                <Text key={`${hi}-${li}`} backgroundColor="red" color="black">
                  {padLine(rawLine)}
                </Text>
              );
            } else {
              return (
                <Text key={`${hi}-${li}`} dimColor>
                  {rawLine}
                </Text>
              );
            }
          })}
        </Box>
      ))}

      {/* Stats */}
      <Box paddingLeft={2}>
        <Text color="green">+{diff.additions}</Text>
        <Text> </Text>
        <Text color="red">-{diff.deletions}</Text>
      </Box>
    </Box>
  );
}
