/**
 * MessageBubble — renders a single message with role-based styling.
 * User: ● you
 * Assistant: ◆ yuan (with spinner when streaming)
 * Tool: └─ ✓/✗ toolName (duration)
 * System: dimmed text
 */

import React from "react";
import { Box, Text } from "ink";
import { TOKENS } from "../lib/tokens.js";
import { Spinner } from "./Spinner.js";
import { MarkdownRenderer } from "./MarkdownRenderer.js";
import type { TUIMessage, TUIToolCall } from "../types.js";

export interface MessageBubbleProps {
  message: TUIMessage;
  width: number;
  isLatest?: boolean;
}

function truncateArgs(args: string | undefined, maxLen: number): string {
  if (!args) return "";
  return args.length > maxLen ? args.slice(0, maxLen) + "…" : args;
}

function ToolCallLine({ tc, isLast }: { tc: TUIToolCall; isLast: boolean }): React.JSX.Element {
  const connector = isLast ? TOKENS.tree.last : TOKENS.tree.branch;
  const icon =
    tc.status === "running" ? null :
    tc.status === "success" ? "✓" :
    "✗";
  const iconColor =
    tc.status === "success" ? "green" :
    tc.status === "error" ? "red" :
    undefined;
  const duration = tc.duration != null ? ` (${tc.duration.toFixed(1)}s)` : "";
  const argsTruncated = truncateArgs(tc.argsSummary, 40);

  return (
    <Box paddingLeft={2}>
      {tc.status === "running" ? (
        <>
          <Text dimColor>{TOKENS.brand.prefix} </Text>
          <Text bold>{tc.toolName}</Text>
          {argsTruncated ? <Text dimColor>({argsTruncated})</Text> : null}
          <Text> </Text>
          <Spinner />
        </>
      ) : (
        <>
          <Text dimColor>{connector} </Text>
          <Text color={iconColor}>{icon}</Text>
          <Text color="white"> {tc.toolName}</Text>
          {argsTruncated ? <Text dimColor>  {argsTruncated}</Text> : null}
          <Text dimColor>{duration}</Text>
        </>
      )}
    </Box>
  );
}

export function MessageBubble({
  message,
  width,
  isLatest,
}: MessageBubbleProps): React.JSX.Element {
  const msg = message;

  switch (msg.role) {
    case "user": {
      // Wrap long text into lines, pad each line to same width for uniform bg
      const maxContentWidth = width - 4; // 2 padding each side
      const lines: string[] = [];
      const words = msg.content.split(" ");
      let currentLine = "";
      for (const word of words) {
        if (currentLine.length + word.length + 1 > maxContentWidth) {
          if (currentLine) lines.push(currentLine);
          currentLine = word;
        } else {
          currentLine = currentLine ? currentLine + " " + word : word;
        }
      }
      if (currentLine) lines.push(currentLine);
      // Find the longest line for uniform padding
      const longestLine = Math.max(...lines.map((l) => l.length), 1);
      const paddedLines = lines.map((l) => ` ${l.padEnd(longestLine)} `);

      return (
        <Box flexDirection="column" marginBottom={1}>
          {paddedLines.map((line, i) => (
            <Text key={i} backgroundColor="#2a2a2a" color="white">{line}</Text>
          ))}
        </Box>
      );
    }

    case "assistant":
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            {msg.isStreaming ? (
              <Spinner label={TOKENS.brand.name} />
            ) : (
              <>
                <Text dimColor>{TOKENS.brand.prefix}</Text>
                <Text bold color="white"> {TOKENS.brand.name}</Text>
              </>
            )}
          </Box>
          {msg.content && (
            <Box paddingLeft={3} marginTop={0}>
              <MarkdownRenderer content={msg.content} width={width - 6} />
            </Box>
          )}
          {msg.isStreaming && isLatest && (
            <Box paddingLeft={3}>
              <Text dimColor>█</Text>
            </Box>
          )}
          {msg.toolCalls && msg.toolCalls.length > 0 && (
            <Box flexDirection="column" marginTop={0}>
              {msg.toolCalls.map((tc, i) => (
                <ToolCallLine
                  key={tc.id}
                  tc={tc}
                  isLast={i === msg.toolCalls!.length - 1}
                />
              ))}
            </Box>
          )}
        </Box>
      );

    case "tool": {
      const icon = msg.toolSuccess ? "✓" : "✗";
      const iconColor = msg.toolSuccess ? "green" : "red";
      const duration = msg.toolDurationMs
        ? ` (${(msg.toolDurationMs / 1000).toFixed(1)}s)`
        : "";
      return (
        <Box paddingLeft={2}>
          <Text dimColor>{TOKENS.tree.last} </Text>
          <Text color={iconColor}>{icon}</Text>
          <Text dimColor>
            {" "}
            {msg.toolName}{duration}
          </Text>
        </Box>
      );
    }

    case "system":
      return (
        <Box>
          <Text dimColor>  {msg.content}</Text>
        </Box>
      );

    default:
      return <Box />;
  }
}
