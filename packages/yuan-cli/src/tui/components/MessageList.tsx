/**
 * MessageList — scrollable message area.
 *
 * Layout: bottom-aligned chat (latest messages at bottom, like Claude.ai).
 * Scroll: line-based (not message-based) — smooth without jumps.
 * Stable: estimateLines is frozen during streaming to prevent startIdx jitter.
 */

import React, { memo, useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { MessageBubble } from "./MessageBubble.js";
import { Spinner } from "./Spinner.js";
import { TOKENS } from "../lib/tokens.js";
import { useMouseScroll } from "../hooks/useMouseScroll.js";
import type { TUIMessage } from "../types.js";

// Re-export for backward compat with App.tsx
export type { TUIMessage } from "../types.js";

export interface MessageListProps {
  messages: TUIMessage[];
  isThinking?: boolean;
  maxHeight?: number;
  pendingMessage?: string;
}

const DIFF_TOOL_NAMES = new Set(["file_write", "file_edit", "edit_file", "write_file"]);

/**
 * Estimate how many terminal lines a message will occupy.
 * Conservative (overestimates) to guarantee no overflow.
 */
function estimateLines(msg: TUIMessage, columns: number): number {
  const contentWidth = Math.max(20, columns - 12);
  const textLen = msg.content?.length ?? 0;
  const contentLines = textLen === 0 ? 0 : Math.ceil(textLen / contentWidth) + 1;

  switch (msg.role) {
    case "user":
      return Math.max(1, contentLines) + 2;
    case "assistant": {
      const toolCalls = msg.toolCalls ?? [];
      const toolLines = toolCalls.reduce((sum, tc) => {
        const hasDiff = DIFF_TOOL_NAMES.has(tc.toolName) && tc.status === "success";
        return sum + 2 + (hasDiff ? 24 : 0);
      }, 0);
      return Math.max(2, contentLines) + toolLines + 2;
    }
    case "tool":
      return 2;
    case "system": {
      const isBanner = msg.content?.includes("YUAN v") && msg.content?.includes("Autonomous Coding Agent");
      if (isBanner) return 16;
      const newlines = (msg.content?.match(/\n/g) ?? []).length;
      return Math.max(1, newlines + 2);
    }
    default:
      return 2;
  }
}

export const MessageList = memo(function MessageList({
  messages,
  isThinking,
  maxHeight,
  pendingMessage,
}: MessageListProps): React.JSX.Element {
  const { columns, rows } = useTerminalSize();
  const height = maxHeight ?? rows - 4;

  // Line-based scroll offset: 0 = pinned to bottom (latest), N = scrolled up N lines
  const [lineOffset, setLineOffset] = useState(0);
  const [pinned, setPinned] = useState(true);
  const prevMsgCountRef = useRef(messages.length);

  // Auto-scroll when new messages arrive (only if pinned)
  useEffect(() => {
    if (messages.length > prevMsgCountRef.current && pinned) {
      setLineOffset(0);
    }
    prevMsgCountRef.current = messages.length;
  }, [messages.length, pinned]);

  // Whether any message is currently streaming
  const isStreaming = useMemo(
    () => messages.some((m) => m.isStreaming),
    [messages],
  );

  // Line counts: FROZEN during streaming to prevent startIdx jitter.
  // Streaming message gets a fixed 30-line estimate.
  // Recomputed only when: message count changes, streaming stops, or columns changes.
  const lineCounts = useMemo(
    () => messages.map((m) => (m.isStreaming ? 30 : estimateLines(m, columns))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages.length, isStreaming, columns],
  );

  const totalLines = useMemo(
    () => lineCounts.reduce((a, b) => a + b, 0),
    [lineCounts],
  );

  // Viewport budget (reserve 2 lines for indicators)
  const budget = Math.max(4, height - 2);

  // Compute visible message indices from line-based offset
  // lineOffset=0: show last `budget` lines; lineOffset=N: scroll up N lines
  const visibleIndices = useMemo(() => {
    const maxOffset = Math.max(0, totalLines - budget);
    const clampedOffset = Math.min(lineOffset, maxOffset);

    // Window in "lines from bottom" coordinates
    // windowStart = bottom of visible window (closest to end of chat)
    // windowEnd = top of visible window
    const windowStart = clampedOffset;
    const windowEnd = clampedOffset + budget;

    const indices: number[] = [];
    let posFromBottom = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msgLines = lineCounts[i] ?? 2;
      const msgBottom = posFromBottom;
      const msgTop = posFromBottom + msgLines;

      // Message entirely above visible window → stop walking
      if (msgBottom >= windowEnd) {
        posFromBottom += msgLines;
        continue;
      }

      // Message entirely below visible window → stop
      if (msgTop <= windowStart) {
        break;
      }

      // Message overlaps → include
      indices.unshift(i);
      posFromBottom += msgLines;
    }

    return indices;
  }, [lineCounts, lineOffset, messages.length, totalLines, budget]);

  const startIdx = visibleIndices[0] ?? 0;

  const visibleMessages = useMemo(
    () => visibleIndices.map((i) => messages[i]!),
    [visibleIndices, messages],
  );

  // Compute visible line total for top-spacer decision
  const visibleLineTotal = useMemo(
    () => visibleIndices.reduce((sum, i) => sum + (lineCounts[i] ?? 2), 0),
    [visibleIndices, lineCounts],
  );

  // Bottom-aligned chat: add top spacer when pinned and content doesn't fill viewport
  const addTopSpacer = pinned && lineOffset === 0 && visibleLineTotal < budget;

  // Keyboard scroll
  useInput((_input, key) => {
    if (key.pageUp || (key.ctrl && key.upArrow)) {
      setPinned(false);
      setLineOffset((prev) => prev + Math.floor(height / 2));
    } else if (key.pageDown || (key.ctrl && key.downArrow)) {
      setLineOffset((prev) => {
        const next = Math.max(0, prev - Math.floor(height / 2));
        if (next === 0) setPinned(true);
        return next;
      });
    }
  });

  // Mouse wheel: 3 lines per tick
  const handleMouseUp = useCallback(() => {
    setPinned(false);
    setLineOffset((prev) => prev + 3);
  }, []);

  const handleMouseDown = useCallback(() => {
    setLineOffset((prev) => {
      const next = Math.max(0, prev - 3);
      if (next === 0) setPinned(true);
      return next;
    });
  }, []);

  useMouseScroll(handleMouseUp, handleMouseDown);

  const hasScrolledUp = lineOffset > 0;

  return (
    <Box flexDirection="column" height={height} flexShrink={0}>
      {/* Top spacer — pushes messages to bottom when viewport isn't full (chat feel) */}
      {addTopSpacer && <Box flexGrow={1} />}

      {/* Empty state */}
      {visibleMessages.length === 0 && !isThinking && (
        <Box justifyContent="center" flexGrow={1}>
          <Text dimColor>Type a message to start...</Text>
        </Box>
      )}

      {/* Scroll-up indicator */}
      {hasScrolledUp && startIdx > 0 && (
        <Box flexShrink={0}>
          <Text dimColor>  ↑ pgup/wheel for older messages</Text>
        </Box>
      )}

      {/* Messages */}
      {visibleMessages.map((msg, i) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          width={columns}
          isLatest={visibleIndices[i] === messages.length - 1}
        />
      ))}

      {/* Pending queued message bubble */}
      {pendingMessage && (
        <Box flexShrink={0} marginBottom={1}>
          <Text color="#4b5563">▶ </Text>
          <Text color="#4b5563" wrap="truncate">
            {pendingMessage.length > columns - 14
              ? pendingMessage.slice(0, columns - 17) + "…"
              : pendingMessage}
          </Text>
          <Text color="#374151"> ⏸queued</Text>
        </Box>
      )}

      {/* Thinking indicator */}
      {isThinking && !messages.some((m) => m.isStreaming) && (
        <Box marginTop={0} flexShrink={0}>
          <Text>  </Text>
          <Spinner label={`${TOKENS.brand.name} ·····`} />
        </Box>
      )}
    </Box>
  );
});
