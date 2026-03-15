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
const velocityRef = useRef(0);
const inertiaTimerRef = useRef<NodeJS.Timeout | null>(null);

// scroll inertia (Ink / Node safe)
const runInertia = useCallback(function runInertia() {
  if (Math.abs(velocityRef.current) < 0.2) {
    velocityRef.current = 0;
    if (inertiaTimerRef.current) {
      clearTimeout(inertiaTimerRef.current);
      inertiaTimerRef.current = null;
    }
    return;
  }

  setLineOffset((prev) => Math.max(0, prev + velocityRef.current));

  velocityRef.current *= 0.85; // friction

inertiaTimerRef.current = setTimeout(() => runInertia(), 16);
}, []);

  const prevMsgCountRef = useRef(messages.length);
// anchor scroll
const anchorMsgIdRef = useRef<string | null>(null);
const anchorOffsetRef = useRef<number>(0);
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

  // Line counts: track actual content size for streaming messages too.
  // Uses content length so the viewport doesn't over-reserve space and jump.
  // Streaming messages get a minimum of 4 lines to avoid a too-small reservation.
  const lineCounts = useMemo(
    () => messages.map((m) => {
      const est = estimateLines(m, columns);
      return m.isStreaming ? Math.max(est, 4) : est;
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, columns],
  );

  const totalLines = useMemo(
    () => lineCounts.reduce((a, b) => a + b, 0),
    [lineCounts],
  );
// restore anchor scroll: keep anchor message at same relative position when not pinned
// lineOffset is "lines from bottom", so offset = totalLines - linesBefore - anchorMsgLines
useEffect(() => {
  if (pinned) return;

  const anchorId = anchorMsgIdRef.current;
  if (!anchorId) return;

  const idx = messages.findIndex(m => m.id === anchorId);
  if (idx === -1) return;

  let linesBefore = 0;
  for (let i = 0; i < idx; i++) {
    linesBefore += lineCounts[i] ?? 2;
  }

  // Convert top-based position to bottom-based offset
  const linesAfterAnchor = totalLines - linesBefore - (lineCounts[idx] ?? 2);
  const newOffset = Math.max(0, linesAfterAnchor);
  setLineOffset(newOffset);

}, [messages, lineCounts, pinned, totalLines]);
  // Viewport budget (reserve 2 lines for indicators)
  const budget = Math.max(4, height - 2);

  // Compute visible message indices from line-based offset.
  // Walk newest→oldest (posFromBottom accumulates upward from 0).
  // Visible window: [lineOffset, lineOffset+budget) lines from bottom.
  const visibleIndices = useMemo(() => {

    const maxOffset = Math.max(0, totalLines - budget);
    const clampedOffset = Math.min(lineOffset, maxOffset);

    const windowStart = clampedOffset;       // bottom edge of visible area
    const windowEnd = clampedOffset + budget; // top edge of visible area

    const indices: number[] = [];
    let posFromBottom = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msgLines = lineCounts[i] ?? 2;
      const msgBottom = posFromBottom;          // distance of msg start from chat bottom
      const msgTop    = posFromBottom + msgLines; // distance of msg end from chat bottom

      posFromBottom += msgLines;

      // Message is entirely BELOW the visible window → skip (keep walking up)
      if (msgTop <= windowStart) continue;

      // Message is entirely ABOVE the visible window → we've passed the window → stop
      if (msgBottom >= windowEnd) break;

      // Message overlaps the window → include
      indices.unshift(i);
    }

    return indices;
  }, [lineCounts, lineOffset, messages.length, totalLines, budget]);

  const startIdx = visibleIndices[0] ?? 0;

  const visibleMessages = useMemo(
    () => visibleIndices.map((i) => messages[i]!),
    [visibleIndices, messages],
  );
// capture anchor
useEffect(() => {
  if (!visibleIndices.length) return;

  const firstVisibleIdx = visibleIndices[0];
  const msg = messages[firstVisibleIdx];

  if (msg) {
    anchorMsgIdRef.current = msg.id;
    anchorOffsetRef.current = lineOffset;
  }

}, [visibleIndices, messages, lineOffset]);
  // Compute visible line total for top-spacer decision
  const visibleLineTotal = useMemo(
    () => visibleIndices.reduce((sum, i) => sum + (lineCounts[i] ?? 2), 0),
    [visibleIndices, lineCounts],
  );

  // Bottom-aligned chat: add spacer only when actual conversation messages exist
  // (avoids banner appearing at bottom on fresh start)
  const hasConversationMessages = messages.some(m => m.role === "user" || m.role === "assistant");
  const addTopSpacer = pinned && totalLines < budget && hasConversationMessages;

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
  velocityRef.current += 3;

  if (!inertiaTimerRef.current) {
    inertiaTimerRef.current = setTimeout(runInertia, 16);
  }
  },[runInertia]);

  const handleMouseDown = useCallback(() => {
  velocityRef.current -= 3;

  if (!inertiaTimerRef.current) {
    inertiaTimerRef.current = setTimeout(runInertia, 16);
  }
}, [runInertia]);



  useMouseScroll(handleMouseUp, handleMouseDown);
useEffect(() => {
  return () => {
    if (inertiaTimerRef.current) {
      clearTimeout(inertiaTimerRef.current);
    }
  };
}, []);
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
