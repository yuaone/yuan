/**
 * MessageList — scrollable message area.
 * Uses MessageBubble for individual message rendering.
 * Supports PageUp/PageDown scroll, auto-pins to bottom on new content.
 *
 * Anti-overlap strategy: estimate each message's line count and only
 * render enough messages to fill the container height. This prevents
 * Ink's unreliable overflow="hidden" from causing messages to bleed
 * into adjacent components.
 */

import React, { memo, useState, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { MessageBubble } from "./MessageBubble.js";
import { Spinner } from "./Spinner.js";
import { TOKENS } from "../lib/tokens.js";
import type { TUIMessage } from "../types.js";

// Re-export for backward compat with App.tsx
export type { TUIMessage } from "../types.js";

export interface MessageListProps {
  messages: TUIMessage[];
  isThinking?: boolean;
  maxHeight?: number;
}

const DIFF_TOOL_NAMES = new Set(["file_write", "file_edit", "edit_file", "write_file"]);

/**
 * Estimate how many terminal lines a message will occupy.
 * Conservative (overestimates) to guarantee no overflow.
 */
function estimateLines(msg: TUIMessage, columns: number): number {
  const contentWidth = Math.max(20, columns - 8);
  const textLen = msg.content?.length ?? 0;
  const contentLines = textLen === 0 ? 0 : Math.ceil(textLen / contentWidth);

  switch (msg.role) {
    case "user":
      return Math.max(1, contentLines) + 1;
    case "assistant": {
      const toolCalls = msg.toolCalls ?? [];
      // Each tool call: 1 status line + up to 22 diff lines if file write/edit
      const toolLines = toolCalls.reduce((sum, tc) => {
        const hasDiff = DIFF_TOOL_NAMES.has(tc.toolName) && tc.status === "success";
        return sum + 1 + (hasDiff ? 22 : 0);
      }, 0);
      return 1 + Math.max(0, contentLines) + toolLines + 1;
    }
    case "tool":
      return 1;
    case "system": {
      // Banner message with 16×10 fox sprite = 10 sprite rows + 4 text lines
      const isBanner = msg.content?.includes("YUAN v") && msg.content?.includes("Autonomous Coding Agent");
      if (isBanner) return 14;
      const newlines = (msg.content?.match(/\n/g) ?? []).length;
      return Math.max(1, newlines + 1);
    }
    default:
      return 1;
  }
}

export const MessageList = memo(function MessageList({
  messages,
  isThinking,
  maxHeight,
}: MessageListProps): React.JSX.Element {
  const { columns, rows } = useTerminalSize();
  const height = maxHeight ?? rows - 4;

  // Pinned = auto-scroll mode (show newest). false = user browsing history.
  const [pinned, setPinned] = useState(true);
  // Manual offset from the end (0 = latest, positive = scrolled up)
  const [scrollBack, setScrollBack] = useState(0);
  const prevMsgCountRef = useRef(messages.length);

  // Auto-pin when new messages arrive (if already pinned)
  useEffect(() => {
    if (messages.length > prevMsgCountRef.current && pinned) {
      setScrollBack(0);
    }
    prevMsgCountRef.current = messages.length;
  }, [messages.length, pinned]);

  // Key handling for scroll (PageUp/PageDown + Ctrl+Up/Down)
  useInput((_input, key) => {
    if (key.pageUp || (key.ctrl && key.upArrow)) {
      setPinned(false);
      setScrollBack((prev) => Math.min(prev + 5, Math.max(0, messages.length - 1)));
    } else if (key.pageDown || (key.ctrl && key.downArrow)) {
      setScrollBack((prev) => {
        const next = Math.max(0, prev - 5);
        if (next === 0) setPinned(true);
        return next;
      });
    }
  });

  // Compute visible slice — fit messages within height budget
  const endIdx = Math.max(0, messages.length - scrollBack);

  // Walk backwards from endIdx, accumulating estimated lines until we hit the height budget
  const reservedLines = 2; // scroll indicators + thinking
  let budget = height - reservedLines;
  let startIdx = endIdx;
  for (let i = endIdx - 1; i >= 0 && budget > 0; i--) {
    const lines = estimateLines(messages[i]!, columns);
    if (budget - lines < 0 && startIdx < endIdx) break; // don't add if it overflows (unless it's the first)
    budget -= lines;
    startIdx = i;
  }

  const visibleMessages = messages.slice(startIdx, endIdx);
  const hasAbove = startIdx > 0;
  const hasBelow = scrollBack > 0;

  return (
    <Box flexDirection="column" height={height} overflow="hidden" justifyContent="flex-end">
      {/* Scroll-up indicator */}
      {hasAbove && (
        <Box justifyContent="center" flexShrink={0}>
          <Text dimColor>--- {startIdx} more (PgUp) ---</Text>
        </Box>
      )}

      {/* Empty state */}
      {visibleMessages.length === 0 && !isThinking && (
        <Box justifyContent="center" flexGrow={1}>
          <Text dimColor>Type a message to start...</Text>
        </Box>
      )}

      {/* Messages */}
      {visibleMessages.map((msg, i) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          width={columns}
          isLatest={startIdx + i === messages.length - 1}
        />
      ))}

      {/* Thinking indicator */}
      {isThinking && !messages.some((m) => m.isStreaming) && (
        <Box marginTop={0} flexShrink={0}>
          <Text>  </Text>
          <Spinner label={`${TOKENS.brand.name} ·····`} />
        </Box>
      )}

      {/* Scroll-down indicator */}
      {hasBelow && (
        <Box justifyContent="center" flexShrink={0}>
          <Text dimColor>--- {scrollBack} more (PgDn) ---</Text>
        </Box>
      )}
    </Box>
  );
});
