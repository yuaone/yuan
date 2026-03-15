/**
 * MessageList — scrollable message area.
 *
 * Layout: web-page feel (content starts at top, grows down).
 * Banner: first RenderItem — permanent transcript header, scrolls up naturally.
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
import stringWidth from "string-width";

// Re-export for backward compat with App.tsx
export type { TUIMessage } from "../types.js";

// ─── RenderItem union ────────────────────────────────────────────────────────

type BannerItem = {
  kind: "banner";
  id: "__welcome_banner__";
};

type RenderItem = BannerItem | TUIMessage;

// ─── Props ───────────────────────────────────────────────────────────────────

export interface MessageListProps {
  messages: TUIMessage[];
  isThinking?: boolean;
  maxHeight?: number;
  pendingMessage?: string;
  hasConversationMessages?: boolean;
  welcomeBanner?: React.ReactNode;
  welcomeBannerRows?: number;
}

// ─── Line estimation ─────────────────────────────────────────────────────────

const DIFF_TOOL_NAMES = new Set(["file_write", "file_edit", "edit_file", "write_file"]);

/**
 * Count how many terminal lines a string occupies, accounting for:
 * - Hard newlines (\n) in the text
 * - CJK double-width characters (using string-width)
 * - Word wrapping at maxWidth columns
 */
function countWrappedLines(text: string, maxWidth: number): number {
  if (!text || maxWidth <= 0) return 1;
  const hardLines = text.split("\n");
  let total = 0;
  for (const line of hardLines) {
    const w = stringWidth(line);
    if (w === 0) {
      total += 1; // empty line still occupies one row
    } else {
      total += Math.ceil(w / maxWidth);
    }
  }
  return Math.max(1, total);
}

/**
 * Estimate how many terminal lines a message will occupy.
 * Uses real word-wrap line counting (CJK-aware) for accuracy.
 */
function estimateLines(msg: TUIMessage, columns: number): number {
  const content = msg.content ?? "";

  switch (msg.role) {
    case "user": {
      // MessageBubble user: "> " prefix + right pad = width - 5 effective content width
      const contentWidth = Math.max(20, columns - 5);
      return countWrappedLines(content, contentWidth) + 2; // +2 for marginBottom={2}
    }
    case "assistant": {
      // MessageBubble assistant: assistantContentWidth = width - 3
      const contentWidth = Math.max(20, columns - 3);
      const toolCalls = msg.toolCalls ?? [];
      // Filter out task_complete — it's hidden from UI
      const visibleToolCalls = toolCalls.filter((tc) => tc.toolName !== "task_complete");
      const toolLines = visibleToolCalls.reduce((sum, tc) => {
        const hasDiff = DIFF_TOOL_NAMES.has(tc.toolName) && tc.status === "success";
        return sum + 2 + (hasDiff ? 24 : 0);
      }, 0);
      return Math.max(2, countWrappedLines(content, contentWidth)) + toolLines + 2;
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

// ─── Component ───────────────────────────────────────────────────────────────

export const MessageList = memo(function MessageList({
  messages,
  isThinking,
  maxHeight,
  pendingMessage,
  hasConversationMessages = false,
  welcomeBanner,
  welcomeBannerRows = 0,
}: MessageListProps): React.JSX.Element {
  const { columns, rows } = useTerminalSize();
  const height = maxHeight ?? rows - 4;

  // Line-based scroll offset: 0 = pinned to bottom (latest), N = scrolled up N lines
  const [lineOffset, setLineOffset] = useState(0);
  const [pinned, setPinned] = useState(true);

  // Inertia scroll
  const velocityRef = useRef(0);
  const inertiaTimerRef = useRef<NodeJS.Timeout | null>(null);

  const runInertia = useCallback(function runInertia() {
    if (Math.abs(velocityRef.current) < 0.5) {  // was 0.2, stop sooner
      velocityRef.current = 0;
      if (inertiaTimerRef.current) {
        clearTimeout(inertiaTimerRef.current);
        inertiaTimerRef.current = null;
      }
      return;
    }

    let hitBottom = false;
    setLineOffset((prev) => {
      const next = prev + velocityRef.current;
      if (next <= 0) {
        hitBottom = true;
        return 0;
      }
      return next;
    });

    if (hitBottom) {
      // Stop inertia immediately when hitting the bottom — prevents banner push jitter
      velocityRef.current = 0;
      if (inertiaTimerRef.current) {
        clearTimeout(inertiaTimerRef.current);
        inertiaTimerRef.current = null;
      }
      return;
    }

    velocityRef.current *= 0.82;  // was 0.85, more friction = less overshooting
    inertiaTimerRef.current = setTimeout(() => runInertia(), 16);
  }, []);

  // Anchor scroll refs
  const anchorMsgIdRef = useRef<string | null>(null);
  const anchorOffsetRef = useRef<number>(0);

  // ─── renderItems: banner (if provided) + messages ─────────────────────────
  const renderItems = useMemo<RenderItem[]>(() => {
    if (!welcomeBanner) return messages;
    return [{ kind: "banner", id: "__welcome_banner__" } as BannerItem, ...messages];
  }, [messages, welcomeBanner]);

  // ─── lineCounts: one entry per renderItem ─────────────────────────────────
  const lineCounts = useMemo(() => {
    const msgCounts = messages.map((m) => {
      const est = estimateLines(m, columns);
      return m.isStreaming ? Math.max(est, 4) : est;
    });
    return welcomeBanner ? [welcomeBannerRows, ...msgCounts] : msgCounts;
  }, [messages, columns, welcomeBanner, welcomeBannerRows]);

  const totalLines = useMemo(
    () => lineCounts.reduce((a, b) => a + b, 0),
    [lineCounts],
  );

  // ─── Web-page feel: no synthetic top spacer ────────────────────────────────
  const addTopSpacer = false;

  // ─── Follow newest while pinned (streaming-aware) ─────────────────────────
  useEffect(() => {
    if (!pinned) return;
    if (!hasConversationMessages) return;
    setLineOffset(0);
  }, [pinned, totalLines, hasConversationMessages]);

  // ─── Restore anchor scroll when not pinned and content grows ─────────────
  useEffect(() => {
    if (pinned) return;

    const anchorId = anchorMsgIdRef.current;
    if (!anchorId) return;

    const idx = renderItems.findIndex((item) =>
      "kind" in item ? item.id === anchorId : item.id === anchorId,
    );
    if (idx < 0) return;

    let linesBefore = 0;
    for (let i = 0; i < idx; i++) {
      linesBefore += lineCounts[i] ?? 2;
    }

    // lineOffset is "lines from bottom"; convert top-based position to bottom-based
    const anchorLines = lineCounts[idx] ?? 2;
    const linesAfterAnchor = Math.max(0, totalLines - linesBefore - anchorLines);
    setLineOffset(linesAfterAnchor);
  }, [renderItems, lineCounts, totalLines, pinned]);

  // ─── Viewport budget (reserve 2 lines for indicators) ────────────────────
  const budget = Math.max(4, height - 2);

  // ─── Windowing: walk newest→oldest (posFromBottom accumulates upward) ─────
  const visibleIndices = useMemo(() => {
    const maxOffset = Math.max(0, totalLines - budget);
    const clampedOffset = Math.min(lineOffset, maxOffset);

    const windowStart = clampedOffset;        // bottom edge of visible area
    const windowEnd = clampedOffset + budget; // top edge of visible area

    const indices: number[] = [];
    let posFromBottom = 0;

    for (let i = renderItems.length - 1; i >= 0; i--) {
      const itemLines = lineCounts[i] ?? 2;
      const itemBottom = posFromBottom;
      const itemTop = posFromBottom + itemLines;

      posFromBottom += itemLines;

      // Item is entirely BELOW the visible window → skip
      if (itemTop <= windowStart) continue;

      // Item is entirely ABOVE the visible window → stop
      if (itemBottom >= windowEnd) break;

      // Item overlaps the window → include
      indices.unshift(i);
    }

    return indices;
  }, [lineCounts, lineOffset, renderItems.length, totalLines, budget]);

  const startIdx = visibleIndices[0] ?? 0;

  // ─── Capture anchor for stable scroll ─────────────────────────────────────
  useEffect(() => {
    if (!visibleIndices.length) return;
    const firstVisibleIdx = visibleIndices[0];
    const item = renderItems[firstVisibleIdx];
    if (item) {
      anchorMsgIdRef.current = "kind" in item ? item.id : item.id;
      anchorOffsetRef.current = lineOffset;
    }
  }, [visibleIndices, renderItems, lineOffset]);

  // ─── Keyboard scroll ──────────────────────────────────────────────────────
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

  // ─── Mouse wheel: 4 lines per tick ────────────────────────────────────────
  const handleMouseUp = useCallback(() => {
    setPinned(false);
    velocityRef.current += 4;   // was 3, increase for faster response
    if (!inertiaTimerRef.current) {
      inertiaTimerRef.current = setTimeout(runInertia, 16);
    }
  }, [runInertia]);

  const handleMouseDown = useCallback(() => {
    if (pinned) return; // already at bottom, scroll-down does nothing
    velocityRef.current -= 4;   // was -3
    if (!inertiaTimerRef.current) {
      inertiaTimerRef.current = setTimeout(runInertia, 16);
    }
  }, [runInertia, pinned]);

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
      {/* Top spacer — disabled (web-page feel: content starts at top) */}
      {addTopSpacer && <Box flexGrow={1} />}

      {/* Empty state */}
      {visibleIndices.length === 0 && !isThinking && (
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

      {/* Messages (and banner) */}
      {visibleIndices.map((idx) => {
        const item = renderItems[idx];
        if (!item) return null;

        // Banner item
        if ("kind" in item && item.kind === "banner") {
          return (
            <Box key={item.id} marginBottom={1}>
              {welcomeBanner}
            </Box>
          );
        }

        // Regular message
        const msg = item as TUIMessage;
        return (
          <MessageBubble
            key={msg.id}
            message={msg}
            width={columns}
            isLatest={idx === renderItems.length - 1}
          />
        );
      })}

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
