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

  return (
    <Box paddingLeft={2}>
      <Text dimColor>{connector} </Text>
      {tc.status === "running" ? (
        <Spinner label={tc.toolName} />
      ) : (
        <>
          <Text color={iconColor}>{icon}</Text>
          <Text dimColor> {tc.toolName}</Text>
          <Text dimColor>  {tc.argsSummary}</Text>
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
    case "user":
      return (
        <Box flexDirection="row" marginBottom={1}>
          <Text color="white" bold>{TOKENS.box.vertical}</Text>
          <Box flexDirection="column" paddingLeft={1}>
            <Text bold color="white">
              {TOKENS.brand.userPrefix} you
            </Text>
            <Text>{msg.content}</Text>
          </Box>
        </Box>
      );

    case "assistant":
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            {msg.isStreaming ? (
              <Spinner label={TOKENS.brand.name} />
            ) : (
              <Text bold color="white">
                {TOKENS.brand.prefix} {TOKENS.brand.name}
              </Text>
            )}
          </Box>
          {msg.content && (
            <Box paddingLeft={2}>
              <MarkdownRenderer content={msg.content} width={width - 4} />
            </Box>
          )}
          {msg.isStreaming && isLatest && (
            <Box paddingLeft={2}>
              <Text dimColor>█</Text>
            </Box>
          )}
          {msg.toolCalls && msg.toolCalls.length > 0 && (
            <Box flexDirection="column">
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
