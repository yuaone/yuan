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
const BANNER_TITLE_PREFIX = "YUAN v";
const BANNER_SUBTITLE = "Autonomous Coding Agent";

const FOX_PIXEL_PALETTE: Record<string, string | null> = {
  ".": null,
  "S": "#dbeafe",
  "W": "#f8fafc",
  "G": "#e5e7eb",
  "N": "#111827",
};

const FOX_PIXEL_SPRITE = [
  "..SWWWS.",
  ".SWWWWWS",
  "SWWNNWWS",
  "SWWWWWW.",
  ".SWWWWW.",
  "..SWWW..",
  "..SWW...",
  "...S....",
];

function truncateArgs(args: string | undefined, maxLen: number): string {
  if (!args) return "";
  return args.length > maxLen ? args.slice(0, maxLen) + "…" : args;
}

function PixelFoxSprite(): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {FOX_PIXEL_SPRITE.map((row, rowIndex) => (
        <Box key={`fox-row-${rowIndex}`}>
          {row.split("").map((cell, colIndex) => {
            const color = FOX_PIXEL_PALETTE[cell] ?? null;

            if (!color) {
              return (
                <Text key={`fox-px-${rowIndex}-${colIndex}`}>
                  {"  "}
                </Text>
              );
            }

            return (
              <Text
                key={`fox-px-${rowIndex}-${colIndex}`}
                color={color}
              >
                {"██"}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
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
          <Text color="#f59e0b">{TOKENS.brand.prefix} </Text>
          <Text bold color="white">{tc.toolName}</Text>
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
  const isBannerMessage =
    msg.role === "system" &&
    msg.content.includes(BANNER_TITLE_PREFIX) &&
    msg.content.includes(BANNER_SUBTITLE);

  switch (msg.role) {
    case "user": {
      // Claude Code style: left-aligned, solid dark bg bar, ▶ prefix
      const maxContentWidth = width - 5; // "▶ " (2) + right pad (3)
      const lines: string[] = [];
      const rawLines = msg.content.split("\n");
      for (const rawLine of rawLines) {
        if (!rawLine) { lines.push(""); continue; }
        const words = rawLine.split(" ");
        let currentLine = "";
        for (const word of words) {
          if (currentLine.length + word.length + 1 > maxContentWidth) {
            if (currentLine) lines.push(currentLine);
            currentLine = word;
          } else {
            currentLine = currentLine ? `${currentLine} ${word}` : word;
          }
        }
        if (currentLine) lines.push(currentLine);
      }
      if (lines.length === 0) lines.push("");
      const fillWidth = width - 1;
      return (
        <Box flexDirection="column" marginBottom={1}>
          {lines.map((line, i) => {
            const prefix = i === 0 ? "▶ " : "  ";
            const full = `${prefix}${line}`.padEnd(fillWidth);
            return (
              <Text key={i} backgroundColor="#2a2a2a" color="white">{full}</Text>
            );
          })}
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
      if (isBannerMessage) {
        const lines = msg.content.split("\n");
        const title =
          lines.find((line) => line.startsWith(BANNER_TITLE_PREFIX)) ?? "";
        const subtitle =
          lines.find((line) => line.includes(BANNER_SUBTITLE)) ?? "";
        const help =
          lines.find((line) => line.includes("Type /help")) ?? "";
        const site =
          lines.find((line) => line.includes("yuaone.com")) ?? "";

        return (
          <Box
            flexDirection="row"
            alignItems="flex-start"
            marginBottom={1}
            paddingLeft={1}
          >
            <Box marginRight={2}>
              <PixelFoxSprite />
            </Box>

            <Box flexDirection="column">
              <Text bold color="white">
                {title}
              </Text>
              <Text color="#cbd5e1">{subtitle}</Text>

              <Box height={1} />

              <Text dimColor>{help}</Text>
              <Text dimColor>{site}</Text>
            </Box>
          </Box>
        );
      }

      return (
        <Box marginBottom={1}>
          <Text dimColor>{msg.content}</Text>
        </Box>
      );

    default:
      return <Box />;
  }
}
