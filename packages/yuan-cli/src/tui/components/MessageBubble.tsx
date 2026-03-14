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
import type { TUIMessage, TUIToolCall, TUIPhaseEvent, ParsedDiff, ParsedDiffHunk } from "../types.js";

export interface MessageBubbleProps {
  message: TUIMessage;
  width: number;
  isLatest?: boolean;
}
const BANNER_TITLE_PREFIX = "YUAN v";
const BANNER_SUBTITLE = "Autonomous Coding Agent";
const BANNER_META_SEP = "---META---";

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

// ─── Phase 3: Autonomous Event Tree ─────────────────────────────────────────

const PHASE_ICONS: Record<TUIPhaseEvent["kind"], string> = {
  research:   "◎",
  plan:       "☰",
  tournament: "⚡",
  task:       "◈",
  debug:      "⊘",
};
const PHASE_COLORS: Record<TUIPhaseEvent["status"], string> = {
  running: "yellow",
  done:    "#3a7d44",
  error:   "red",
};

function PhaseEventTree({ events, width }: { events: TUIPhaseEvent[]; width: number }): React.JSX.Element {
  const maxItemW = Math.max(20, width - 8);
  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={1}>
      {events.map((ev) => {
        const icon = PHASE_ICONS[ev.kind] ?? "◇";
        const color = PHASE_COLORS[ev.status] ?? "#888888";
        const titleTrunc = ev.title.length > width - 6 ? ev.title.slice(0, width - 9) + "…" : ev.title;
        return (
          <Box key={ev.id} flexDirection="column">
            {/* Header row: ◎ Research  confidence:72%  12 sources */}
            <Box>
              <Text color={color}>{icon} </Text>
              <Text bold color="white">{titleTrunc}</Text>
            </Box>
            {/* Tree items */}
            {ev.items.map((item, i) => {
              const isLast = i === ev.items.length - 1;
              const connector = isLast ? TOKENS.tree.last : TOKENS.tree.branch;
              const label = item.length > maxItemW ? item.slice(0, maxItemW - 1) + "…" : item;
              return (
                <Box key={i} paddingLeft={2}>
                  <Text dimColor>{connector} </Text>
                  <Text dimColor>{label}</Text>
                </Box>
              );
            })}
          </Box>
        );
      })}
    </Box>
  );
}

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

/** Live elapsed timer — ticks every 1s while tool is running */
function LiveElapsed({ startedAt }: { startedAt: number }): React.JSX.Element {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = (now - startedAt) / 1000;
  return <Text color="#555555">  {elapsed.toFixed(1)}s</Text>;
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

const ToolCallLine = React.memo(function ToolCallLine({ tc, isLast, width }: { tc: TUIToolCall; isLast: boolean; width: number }): React.JSX.Element {
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
          // Running: blinking dot + bold tool verb + args + live elapsed timer
          <>
            <Text> </Text>
            <BlinkingDot />
            <Text bold color="white"> {toolVerb(tc.toolName)}</Text>
            {argsTruncated ? <Text dimColor> {argsTruncated}</Text> : null}
            {tc.startedAt != null ? <LiveElapsed startedAt={tc.startedAt} /> : null}
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
});

export const MessageBubble = React.memo(function MessageBubble({
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
    case "queued_user": {
      // Same layout as user bubble, but dimmed: ▶ prefix + dark bg + gray text
      const maxContentWidth = width - 5;
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
      const fillWidth = width - 2;
      return (
        <Box flexDirection="column" marginBottom={1}>
          {lines.map((line, i) => {
            const prefix = i === 0 ? "> " : "  ";
            const full = `${prefix}${line}`;
            const dispW = stringWidth(full);
            const pad = Math.max(0, fillWidth - dispW);
            return (
              <Text key={i} backgroundColor="#1a1a1a" color="#4b5563">{full}{" ".repeat(pad)}</Text>
            );
          })}
          <Text dimColor>  ⏸ queued</Text>
        </Box>
      );
    }

    case "user": {
      // Claude Code style: left-aligned, solid dark bg bar, > prefix
      // Use stringWidth for CJK-safe wrapping (Korean/Chinese chars = 2 terminal columns each)
      const maxContentWidth = width - 5; // "> " (2) + right pad (3)
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
            const prefix = i === 0 ? "> " : "  ";
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
      const hasThinking = !!msg.thinkingContent;
      const phaseEvents = msg.phaseEvents ?? [];
      const hasPhaseEvents = phaseEvents.length > 0;

      // Split content: first line inline with ●, rest below with indent
      const contentLines = hasText ? msg.content.split("\n") : [];
      const firstLine = contentLines[0] ?? "";
      const restContent = contentLines.slice(1).join("\n");
      const hasRest = restContent.length > 0;

      return (
        <Box flexDirection="column" marginBottom={1}>
          {/* ● <first line inline> */}
          <Box>
            <Text dimColor>● </Text>
            {hasText ? (
              <MarkdownRenderer content={firstLine} width={width - 4} />
            ) : null}
          </Box>
          {/* Remaining lines — indented */}
          {hasRest && (
            <Box paddingLeft={2}>
              <MarkdownRenderer content={restContent} width={width - 4} />
            </Box>
          )}
          {/* Thinking content — dim */}
          {hasThinking && (
            <Box paddingLeft={2} flexDirection="column">
              {msg.thinkingContent!.split("\n").map((line, i) => (
                <Text key={i} dimColor color="#555555">{line}</Text>
              ))}
            </Box>
          )}
          {/* Tool call tree */}
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
          {/* Phase 3: Autonomous event tree — inline below tools */}
          {hasPhaseEvents && (
            <PhaseEventTree events={phaseEvents} width={width - 2} />
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
        // Parse metadata embedded in banner content
        const metaIdx = msg.content.indexOf(BANNER_META_SEP);
        let meta: { model?: string; provider?: string; cwd?: string; version?: string } = {};
        let baseContent = msg.content;
        if (metaIdx >= 0) {
          try {
            meta = JSON.parse(msg.content.slice(metaIdx + BANNER_META_SEP.length + 1).trim()) as typeof meta;
          } catch { /* ignore */ }
          baseContent = msg.content.slice(0, metaIdx);
        }
        const lines = baseContent.split("\n");
        const title = lines.find((l) => l.startsWith(BANNER_TITLE_PREFIX)) ?? `YUAN v${meta.version ?? ""}`;
        const help = lines.find((l) => l.includes("/help")) ?? "Type /help for commands";
        const site = lines.find((l) => l.includes("yuaone.com")) ?? "yuaone.com";

        // What's new items for current version
        const borderColor = "#334155";
        const B = TOKENS.box;

 return (
   <Box flexDirection="column" paddingLeft={0}>
            {/* Top border */}
            <Text color={borderColor}>{B.topLeft}{B.horizontal.repeat(2)} {title} {B.horizontal.repeat(Math.max(0, width - stringWidth(title) - 6))}{B.topRight}</Text>

            {/* Content row: left (fox only) | right (info) */}
            <Box flexDirection="row">
              {/* Left column — pixel fox only */}
              <Box flexDirection="column" paddingLeft={2} flexGrow={0}>
                <PixelFoxSprite />
              </Box>

              {/* Vertical divider */}
              <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
                {Array.from({ length: FOX_PIXEL_SPRITE.length }).map((_, i) => (
                  <Text key={i} color={borderColor}>{B.vertical}</Text>
                ))}
              </Box>

              {/* Right column — info */}
              <Box flexDirection="column" flexGrow={1} paddingRight={2} justifyContent="center">
                <Box height={1} />
                {meta.model && (
                  <Box>
                    <Text dimColor>model  </Text>
                    <Text color="white">{meta.model}</Text>
                  </Box>
                )}
                {meta.provider && (
                  <Box>
                    <Text dimColor>via    </Text>
                    <Text dimColor>{meta.provider}</Text>
                  </Box>
                )}
                {meta.cwd && (
                  <Box>
                    <Text dimColor>dir    </Text>
                    <Text dimColor>{meta.cwd}</Text>
                  </Box>
                )}
                <Box height={1} />
                <Text dimColor>{help}</Text>
                <Text dimColor>{site}</Text>
              </Box>
            </Box>

            {/* Bottom border */}
            <Text color={borderColor}>{B.bottomLeft}{B.horizontal.repeat(Math.max(0, width - stringWidth("") - 2))}{B.bottomRight}</Text>
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
});
