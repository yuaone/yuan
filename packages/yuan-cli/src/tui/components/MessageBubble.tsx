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
    <Box flexDirection="column">
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


/** Sky-blue blinking dot for running tool calls */
function BlinkingDot(): React.JSX.Element {
  const [bright, setBright] = useState(true);
  useEffect(() => {
    const timer = setInterval(() => setBright((b) => !b), 500);
    return () => clearInterval(timer);
  }, []);
  return <Text color={bright ? "#87CEEB" : "#2a6e8a"}>●</Text>;
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

/** Display name for a tool call — uses actual tool name, no hardcoded mappings */
function toolVerb(toolName: string): string {
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

  // bash: extract exit code for subline
  const bashExitCode = tc.result?.kind === "bash_output" ? tc.result.meta?.exitCode : undefined;
  const bashFailed = bashExitCode !== undefined && bashExitCode !== 0;

  // grep: extract match count for subline
  const grepMatchCount = tc.result?.kind === "grep_output" ? tc.result.meta?.matchCount : undefined;

  // subline gutter (aligns under args)
  const subGutter = isLast ? "    " : `${TOKENS.tree.pipe}   `;

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
            <Text color={bashFailed ? "red" : "#3a7d44"}> ✓</Text>
            <Text dimColor> {toolVerb(tc.toolName)}</Text>
            {argsTruncated ? <Text dimColor> {argsTruncated}</Text> : null}
            {tc.duration != null ? (
              <Text color="#555555">  {tc.duration.toFixed(1)}s</Text>
            ) : null}
          </>
        )}
      </Box>

      {/* bash: exit code — only shown when exitCode is known, no output preview */}
      {tc.status === "success" && tc.result?.kind === "bash_output" && bashExitCode !== undefined && (
        <Box paddingLeft={subGutter.length}>
          <Text dimColor>{subGutter}</Text>
          <Text color={bashFailed ? "red" : "#3a7d44"}>exit {bashExitCode}</Text>
        </Box>
      )}

      {/* grep: match count */}
      {tc.status === "success" && tc.result?.kind === "grep_output" && (
        <Box paddingLeft={subGutter.length}>
          <Text dimColor>{subGutter}</Text>
          {grepMatchCount !== undefined ? (
            <Text dimColor>{grepMatchCount} match{grepMatchCount !== 1 ? "es" : ""}</Text>
          ) : (
            <Text dimColor>no matches</Text>
          )}
        </Box>
      )}

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
        for (let word of words) {
          let wordW = stringWidth(word);
          // Handle unbreakable words (URLs, hashes) that exceed column width
          if (wordW > maxContentWidth) {
            word = word.slice(0, maxContentWidth - 1) + "…";
            wordW = maxContentWidth;
          }
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
        <Box flexDirection="column" marginBottom={2}>
          {lines.map((line, i) => {
            const prefix = i === 0 ? "> " : "  ";
            const full = `${prefix}${line}`;
            const dispW = stringWidth(full);
            const pad = Math.max(0, fillWidth - dispW);
            return (
              <Text key={i} backgroundColor="#222222" color="#9a9a9a">{full}{" ".repeat(pad)}</Text>
            );
          })}
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
        for (let word of words) {
          let wordW = stringWidth(word);
          /* M12 fix: force-break single words exceeding maxContentWidth */
          if (wordW > maxContentWidth) {
            // Flush current line first
            if (currentLine) { lines.push(currentLine); currentLine = ""; currentWidth = 0; }
            // Break character by character
            let chunk = "";
            let chunkW = 0;
            for (const ch of word) {
              const cw = stringWidth(ch);
              if (chunkW + cw > maxContentWidth) {
                lines.push(chunk);
                chunk = ch;
                chunkW = cw;
              } else {
                chunk += ch;
                chunkW += cw;
              }
            }
            word = chunk;
            wordW = chunkW;
          }
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
        <Box flexDirection="column" marginBottom={2}>
          {lines.map((line, i) => {
            const prefix = i === 0 ? "> " : "  ";
            const full = `${prefix}${line}`;
            // Pad with spaces to fillWidth using display width (handles CJK)
            const dispW = stringWidth(full);
            const pad = Math.max(0, fillWidth - dispW);
            return (
              <Text key={i} backgroundColor="#222222" color="white">{full}{" ".repeat(pad)}</Text>
            );
          })}
        </Box>
      );
    }

    case "assistant": {
      const toolCalls = msg.toolCalls ?? [];
      // Filter out task_complete for display purposes
      const visibleTools = toolCalls.filter(tc => tc.toolName !== "task_complete");
      const hasTools = visibleTools.length > 0;
      const hasText = !!msg.content?.trim();
      const hasThinking = !!msg.thinkingContent;
      const phaseEvents = msg.phaseEvents ?? [];
      const hasPhaseEvents = phaseEvents.length > 0;
      const assistantContentWidth = Math.max(12, width - 3);

      // ── Empty bubble prevention (use empty Box, not null — avoids React hooks mismatch) ──
      if (!hasText && !hasTools && !hasPhaseEvents && !hasThinking) {
        return <Box />;
      }

      // ── Narration bubble — falls through to final bubble rendering ──
      // narration and final are visually identical; no separate branch needed.

      // ── Final / default assistant bubble (full markdown) ──────────────
      const hasRenderableBody = hasText || hasTools || hasPhaseEvents;

      // Reasoning: only show while streaming, max 3 lines (keeps it out of the way)
      const showThinking = hasThinking && msg.isStreaming;
      const thinkingLines = showThinking
        ? msg.thinkingContent!.split("\n").filter(Boolean).slice(-3)
        : [];

      if (!hasRenderableBody && thinkingLines.length === 0) {
        return <Box />;
      }

      return (
        <Box flexDirection="column" marginBottom={2}>
          {/* Inline reasoning — dim, before main content, only while thinking */}
          {thinkingLines.map((line, i) => (
            <Box key={`think-${i}`} paddingLeft={2} width={assistantContentWidth}>
              <Text dimColor color="#555555" wrap="truncate">~ {line}</Text>
            </Box>
          ))}
          {hasRenderableBody && (
            <Box
              flexDirection="row"
              alignItems="flex-start"
              marginTop={thinkingLines.length > 0 ? 1 : 0}
            >
              <Box width={2} flexShrink={0}>
                <Text color="#888888">●</Text>
              </Box>
              <Box flexDirection="column" flexGrow={1}>
                {/* Full content — no firstLine/restContent split (breaks Korean particles) */}
                {hasText && (
                  <MarkdownRenderer content={msg.content} width={assistantContentWidth} />
                )}
                {/* Tool call tree */}
                {hasTools && (
                  <Box flexDirection="column" marginTop={0}>
                    {visibleTools.map((tc, i) => (
                      <ToolCallLine
                        key={tc.id}
                        tc={tc}
                        isLast={i === visibleTools.length - 1}
                        width={assistantContentWidth}
                      />
                    ))}
                  </Box>
                )}
                {/* Phase 3: Autonomous event tree — inline below tools */}
                {hasPhaseEvents && (
                  <Box marginTop={hasText || hasTools ? 1 : 0}>
                    <PhaseEventTree events={phaseEvents} width={assistantContentWidth} />
                  </Box>
                )}
              </Box>
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

    case "system": {
      return (
        <Box marginBottom={1}>
          <Text dimColor>{msg.content}</Text>
        </Box>
      );
    }

    default:
      return <Box />;
  }
}, (prev, next) => {
  // Custom equality: skip re-render if message content/toolCalls/streaming haven't changed
  if (prev.width !== next.width) return false;
  if (prev.isLatest !== next.isLatest) return false;
  const pm = prev.message;
  const nm = next.message;
  if (pm.id !== nm.id) return false;
  if (pm.content !== nm.content) return false;
  if (pm.isStreaming !== nm.isStreaming) return false;
  if (pm.streamKind !== nm.streamKind) return false;
  if (pm.thinkingContent !== nm.thinkingContent) return false;
  // Compare toolCalls by content (id + status), not reference
  const prevToolIds = pm.toolCalls?.map(tc => `${tc.id}-${tc.status}`).join(',') ?? '';
  const nextToolIds = nm.toolCalls?.map(tc => `${tc.id}-${tc.status}`).join(',') ?? '';
  if (prevToolIds !== nextToolIds) return false;
  // Check if any tool call duration changed
  if (pm.toolCalls && nm.toolCalls) {
    for (let i = 0; i < pm.toolCalls.length; i++) {
      if (pm.toolCalls[i]?.duration !== nm.toolCalls[i]?.duration) return false;
    }
  }
  if ((pm.phaseEvents?.length ?? 0) !== (nm.phaseEvents?.length ?? 0)) return false;
  // Check if any phase event status changed (e.g. running → done)
  if (pm.phaseEvents && nm.phaseEvents) {
    for (let i = 0; i < pm.phaseEvents.length; i++) {
      if (pm.phaseEvents[i]?.status !== nm.phaseEvents[i]?.status) return false;
    }
  }
  return true;
});
