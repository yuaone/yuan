/**
 * MessageBubble — renders a single message with role-based styling.
 * User: ● you
 * Assistant: ◆ yuan (with spinner when streaming)
 * Tool: └─ ✓/✗ toolName (duration)
 * System: dimmed text
 */

import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";
import { TOKENS } from "../lib/tokens.js";
import { MarkdownRenderer } from "./MarkdownRenderer.js";
import { DiffView } from "./DiffView.js";
import type { TUIMessage, TUIToolCall, ParsedDiff, ParsedDiffHunk } from "../types.js";

export interface MessageBubbleProps {
  message: TUIMessage;
  width: number;
  isLatest?: boolean;
}
const BANNER_TITLE_PREFIX = "YUAN v";
const BANNER_SUBTITLE = "Autonomous Coding Agent";

const FOX_PIXEL_PALETTE: Record<string, string | null> = {
  ".": null,
  "O": "#f97316",   // orange body
  "D": "#c2410c",   // dark orange (ears/outline)
  "W": "#f8fafc",   // white (face/chest)
  "N": "#1c1917",   // dark (eyes/nose)
  "T": "#fcd34d",   // tan/yellow (inner ear)
};

const FOX_PIXEL_SPRITE = [
  "....DOODD..DDOOD....",
  "...DOOOTD.DTOOD....",
  "...DOOOOOOOOOOOD...",
  "..DOOOOOOOOOOOOOD..",
  "..DOOWWWWWWWWWOOD..",
  "..DOOWNNOONNWOOD...",
  "..DOOWWWWWWWWWOOD..",
  "..DOOOWWNNWWWOOOD..",
  "...DOOOOOOOOOOOD...",
  "....DDDDDDDDDDDD...",
];

const DIFF_TOOL_NAMES = new Set(["file_write", "file_edit", "edit_file", "write_file"]);
const MAX_DIFF_LINES = 20;

/** Parse a unified diff string into ParsedDiff structure */
function parseUnifiedDiff(raw: string, filePath = ""): ParsedDiff | null {
  const lines = raw.split("\n");
  const hunks: ParsedDiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let currentHunk: ParsedDiffHunk | null = null;
  let oldLineNo = 0;
  let newLineNo = 0;
  let hasSignLines = false;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        currentHunk = {
          startOld: parseInt(m[1], 10),
          startNew: parseInt(m[2], 10),
          lines: [],
        };
        oldLineNo = currentHunk.startOld;
        newLineNo = currentHunk.startNew;
        hunks.push(currentHunk);
      }
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      hasSignLines = true;
      if (currentHunk) {
        currentHunk.lines.push({ type: "add", content: line.slice(1), newLineNo: newLineNo++ });
      }
      additions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      hasSignLines = true;
      if (currentHunk) {
        currentHunk.lines.push({ type: "delete", content: line.slice(1), oldLineNo: oldLineNo++ });
      }
      deletions++;
    } else if (line.startsWith(" ") && currentHunk) {
      currentHunk.lines.push({ type: "context", content: line.slice(1), oldLineNo: oldLineNo++, newLineNo: newLineNo++ });
    }
  }

  if (!hasSignLines || hunks.length === 0) return null;

  // Extract filePath from diff header if not provided
  if (!filePath) {
    const plusLine = lines.find(l => l.startsWith("+++ "));
    if (plusLine) filePath = plusLine.replace(/^\+\+\+ (b\/)?/, "");
  }

  return { filePath, hunks, additions, deletions };
}

/** Limit ParsedDiff to maxLines total diff lines for compact display */
function limitDiffLines(diff: ParsedDiff, maxLines: number): { diff: ParsedDiff; truncated: number } {
  let count = 0;
  let truncated = 0;
  const limitedHunks: ParsedDiffHunk[] = [];

  for (const hunk of diff.hunks) {
    if (count >= maxLines) {
      truncated += hunk.lines.length;
      continue;
    }
    const remaining = maxLines - count;
    if (hunk.lines.length <= remaining) {
      limitedHunks.push(hunk);
      count += hunk.lines.length;
    } else {
      truncated += hunk.lines.length - remaining;
      limitedHunks.push({ ...hunk, lines: hunk.lines.slice(0, remaining) });
      count = maxLines;
    }
  }

  return { diff: { ...diff, hunks: limitedHunks }, truncated };
}

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
/** White↔gray blinking dot for running tool calls */
function BlinkingDot(): React.JSX.Element {
  const [bright, setBright] = useState(true);
  useEffect(() => {
    const timer = setInterval(() => setBright((b) => !b), 500);
    return () => clearInterval(timer);
  }, []);
  return <Text color={bright ? "white" : "#555555"}>●</Text>;
}

/** Get a short "verb" label for the tool call header */
function toolVerb(toolName: string): string {
  const n = toolName.toLowerCase();
  if (n.includes("read")) return "read";
  if (n.includes("write")) return "write";
  if (n.includes("edit")) return "edit";
  if (n.includes("bash") || n.includes("shell") || n.includes("exec")) return "bash";
  if (n.includes("grep") || n.includes("search")) return "search";
  if (n.includes("glob") || n.includes("find")) return "find";
  if (n.includes("git")) return "git";
  return toolName;
}

function ToolCallLine({ tc, isLast, width }: { tc: TUIToolCall; isLast: boolean; width: number }): React.JSX.Element {
  const argsTruncated = truncateArgs(tc.argsSummary, 38);

  // Resolve diff
  let resolvedDiff: ParsedDiff | null = null;
  if (tc.status === "success" && DIFF_TOOL_NAMES.has(tc.toolName) && tc.result) {
    if (tc.result.diff) {
      resolvedDiff = tc.result.diff;
    } else if (tc.result.content && tc.result.content.includes("@@")) {
      resolvedDiff = parseUnifiedDiff(tc.result.content, tc.argsSummary);
    }
  }

  let displayDiff: ParsedDiff | null = null;
  let truncatedLines = 0;
  if (resolvedDiff) {
    const limited = limitDiffLines(resolvedDiff, MAX_DIFF_LINES);
    displayDiff = limited.diff;
    truncatedLines = limited.truncated;
  }

  // Tree connector: ├─ for non-last, └─ for last tool
  const connector = isLast ? TOKENS.tree.last : TOKENS.tree.branch;
  // Left continuation gutter for diff (aligns under tool args)
  const diffGutter = isLast ? "   " : `${TOKENS.tree.pipe} `;

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{connector}</Text>
        {tc.status === "running" ? (
          // Running: blinking dot + bold tool verb + args
          <>
            <Text> </Text>
            <BlinkingDot />
            <Text bold color="white"> {toolVerb(tc.toolName)}</Text>
            {argsTruncated ? <Text dimColor> {argsTruncated}</Text> : null}
          </>
        ) : tc.status === "error" ? (
          // Error: red ✗ + dim tool verb + args
          <>
            <Text color="red"> ✗</Text>
            <Text dimColor> {toolVerb(tc.toolName)}</Text>
            {argsTruncated ? <Text dimColor> {argsTruncated}</Text> : null}
          </>
        ) : (
          // Success: dim ✓ + dim verb + args + duration
          <>
            <Text color="#3a7d44"> ✓</Text>
            <Text dimColor> {toolVerb(tc.toolName)}</Text>
            {argsTruncated ? <Text dimColor> {argsTruncated}</Text> : null}
            {tc.duration != null ? (
              <Text color="#555555">  {tc.duration.toFixed(1)}s</Text>
            ) : null}
          </>
        )}
      </Box>
      {displayDiff && (
        <Box flexDirection="column" paddingLeft={4}>
          <DiffView diff={displayDiff} width={width - 6} />
          {truncatedLines > 0 && (
            <Text dimColor>  … {truncatedLines} more line{truncatedLines === 1 ? "" : "s"}</Text>
          )}
        </Box>
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
      // Use stringWidth for CJK-safe wrapping (Korean/Chinese chars = 2 terminal columns each)
      const maxContentWidth = width - 5; // "▶ " (2) + right pad (3)
      const lines: string[] = [];
      const rawLines = msg.content.split("\n");
      for (const rawLine of rawLines) {
        if (!rawLine) { lines.push(""); continue; }
        const words = rawLine.split(" ");
        let currentLine = "";
        let currentWidth = 0;
        for (const word of words) {
          const wordW = stringWidth(word);
          if (currentWidth > 0 && currentWidth + 1 + wordW > maxContentWidth) {
            lines.push(currentLine);
            currentLine = word;
            currentWidth = wordW;
          } else {
            currentLine = currentWidth > 0 ? `${currentLine} ${word}` : word;
            currentWidth = currentWidth > 0 ? currentWidth + 1 + wordW : wordW;
          }
        }
        if (currentLine) lines.push(currentLine);
      }
      if (lines.length === 0) lines.push("");
      const fillWidth = width - 2; // leave 2-col right margin
      return (
        <Box flexDirection="column" marginBottom={1}>
          {lines.map((line, i) => {
            const prefix = i === 0 ? "▶ " : "  ";
            const full = `${prefix}${line}`;
            // Pad with spaces to fillWidth using display width (handles CJK)
            const dispW = stringWidth(full);
            const pad = Math.max(0, fillWidth - dispW);
            return (
              <Text key={i} backgroundColor="#2a2a2a" color="white">{full}{" ".repeat(pad)}</Text>
            );
          })}
        </Box>
      );
    }

    case "assistant": {
      const toolCalls = msg.toolCalls ?? [];
      const hasTools = toolCalls.length > 0;
      const hasText = !!msg.content;
      return (
        <Box flexDirection="column" marginBottom={1}>
          {/* ● yuan — header row (always visible) */}
          <Box>
            {msg.isStreaming && isLatest ? (
              <>
                <BlinkingDot />
                <Text dimColor> yuan</Text>
              </>
            ) : (
              <Text dimColor>● yuan</Text>
            )}
          </Box>
          {/* Streamed/completed assistant text — white, readable */}
          {hasText && (
            <Box paddingLeft={2}>
              <MarkdownRenderer content={msg.content} width={width - 4} />
            </Box>
          )}
          {/* Cursor block while streaming with no text yet */}
          {msg.isStreaming && isLatest && !hasText && (
            <Box paddingLeft={2}>
              <Text dimColor>█</Text>
            </Box>
          )}
          {/* Tool call tree — dimmer, smaller visual weight than text */}
          {hasTools && (
            <Box flexDirection="column" paddingLeft={2} marginTop={hasText ? 1 : 0}>
              {toolCalls.map((tc, i) => (
                <ToolCallLine
                  key={tc.id}
                  tc={tc}
                  isLast={i === toolCalls.length - 1}
                  width={width - 2}
                />
              ))}
            </Box>
          )}
        </Box>
      );
    }

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
