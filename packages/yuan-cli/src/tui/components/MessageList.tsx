/**
 * MessageList — render-from-bottom scroll model (Claude Code style).
 *
 * Scroll model:
 *   scrollUp = 0, pinned=true  → auto-follow bottom (show newest)
 *   scrollUp > 0, pinned=false → scrolled up by N lines (view frozen)
 *
 * Core idea: always render the LAST N messages that fit in the viewport.
 * scrollUp > 0 means "also include N extra lines above the viewport",
 * which pulls in older messages. The bottom is always accurate — only
 * the top can be clipped by overflow="hidden".
 *
 * ONE render path. All hooks called unconditionally.
 */

import React, { memo, useState, useCallback, useMemo, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { MessageBubble } from "./MessageBubble.js";
import { useMouseScroll } from "../hooks/useMouseScroll.js";
import type { TUIMessage } from "../types.js";
import stringWidth from "string-width";

export type { TUIMessage } from "../types.js";

// ─── Props ───────────────────────────────────────────────────────────────────

export interface MessageListProps {
  messages: TUIMessage[];
  isThinking?: boolean;
  width: number;
  /** Extra rows consumed by fixed elements above MessageList (e.g. banner). */
  reservedTopRows?: number;
}

// ─── Line estimation ─────────────────────────────────────────────────────────

const DIFF_TOOL_NAMES = new Set(["file_write", "file_edit", "edit_file", "write_file"]);

function countWrappedLines(text: string, maxWidth: number): number {
  if (!text || maxWidth <= 0) return 1;
  const hardLines = text.split("\n");
  let total = 0;
  for (const line of hardLines) {
    const w = stringWidth(line);
    if (w === 0) {
      total += 1;
    } else {
      total += Math.ceil(w / maxWidth);
    }
  }
  return Math.max(1, total);
}

function countMarkdownExtra(text: string): number {
  let extra = 0;
  const lines = text.split("\n");
  let inCodeBlock = false;
  for (const line of lines) {
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      extra += 1;
      continue;
    }
    if (inCodeBlock) continue;
    if (/^(\s*[-*+]|\s*\d+\.) /.test(line)) extra += 1;
    if (/^#{1,6} /.test(line)) extra += 1;
    if (/^[-*_]{3,}$/.test(line.trim())) extra += 1;
  }
  return extra;
}

function estimateMessageLines(msg: TUIMessage, columns: number): number {
  const content = msg.content ?? "";

  switch (msg.role) {
    case "user":
    case "queued_user": {
      const contentWidth = Math.max(20, columns - 5);
      return countWrappedLines(content, contentWidth) + 2; // +2 for marginBottom
    }
    case "assistant": {
      const contentWidth = Math.max(20, columns - 3);
      const toolCalls = msg.toolCalls ?? [];
      const visibleToolCalls = toolCalls.filter((tc) => tc.toolName !== "task_complete");
      const toolLines = visibleToolCalls.reduce((sum, tc) => {
        const hasDiff = DIFF_TOOL_NAMES.has(tc.toolName) && tc.status === "success";
        return sum + 2 + (hasDiff ? 20 : 0);
      }, 0);
      const mdExtra = content ? countMarkdownExtra(content) : 0;
      const baseLines = Math.max(1, countWrappedLines(content, contentWidth));
      return baseLines + mdExtra + toolLines + 2; // +2 for marginBottom
    }
    case "tool":
      return 2;
    case "system": {
      const newlines = (msg.content?.match(/\n/g) ?? []).length;
      return Math.max(1, newlines + 1) + 1; // +1 for marginBottom
    }
    default:
      return 2;
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

export const MessageList = memo(function MessageList({
  messages,
  width,
  reservedTopRows = 0,
}: MessageListProps): React.JSX.Element {
  const { columns, rows } = useTerminalSize();

  // scrollUp=0 → pinned to bottom (auto-follow)
  // scrollUp>0 → scrolled N logical lines above bottom
  const [scrollUp, setScrollUp] = useState(0);
  const pinned = scrollUp === 0;

  // Track last scroll interaction time for auto-repin
  const lastScrollAtRef = useRef(0);

  // Scroll accumulator for frame-throttled mouse scroll
  const scrollAccRef = useRef(0);
  const scrollRafRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ═══ VIEWPORT BUDGET ═══
  // Fixed rows below MessageList: StatusLine(1) + InputBox(4) + FooterBar(1) = 6
  // Banner rows above MessageList are passed in via reservedTopRows.
  const availableHeight = Math.max(1, rows - 6 - reservedTopRows);

  // Indicator takes 1 line when scrolled; content gets the rest.
  const indicatorLines = scrollUp > 0 ? 1 : 0;
  const contentHeight = Math.max(1, availableHeight - indicatorLines);

  // ═══ VISIBLE MESSAGES — render-from-bottom ═══
  const visibleMessages = useMemo(() => {
    // We want to show messages that fill contentHeight + scrollUp lines.
    // Start from the last message and work backwards.
    // With justifyContent="flex-end" + overflow="hidden", the content box clips at
    // the TOP (old messages), so including extra lines via scrollUp correctly reveals
    // older content without hiding newest messages.
    const targetLines = contentHeight + scrollUp;

    let totalLines = 0;
    let startIdx = messages.length;

    while (startIdx > 0) {
      const est = Math.max(1, estimateMessageLines(messages[startIdx - 1]!, columns));
      if (totalLines + est > targetLines) break;
      totalLines += est;
      startIdx--;
    }

    return messages.slice(startIdx);
  }, [messages, scrollUp, contentHeight, columns]);

  // ═══ AUTO-FOLLOW when pinned ═══
  // When pinned, new content arrives → scrollUp stays 0 → visibleMessages auto-updates.
  // Nothing to do here — the useMemo above handles it.

  // ═══ AUTO-REPIN after 3s of no scroll activity ═══
  const prevMsgCountRef = useRef(messages.length);
  useEffect(() => {
    const countChanged = messages.length !== prevMsgCountRef.current;
    prevMsgCountRef.current = messages.length;
    if (!pinned && countChanged) {
      const timeSinceScroll = Date.now() - lastScrollAtRef.current;
      if (timeSinceScroll > 3000) {
        setScrollUp(0);
      }
    }
  }, [messages.length, pinned]);

  // Cleanup scroll timer on unmount
  useEffect(() => {
    return () => {
      if (scrollRafRef.current) clearTimeout(scrollRafRef.current);
    };
  }, []);

  // ═══ KEYBOARD SCROLL ═══
  useInput((_input, key) => {
    if (key.pageUp || (key.ctrl && key.upArrow)) {
      lastScrollAtRef.current = Date.now();
      setScrollUp((prev) => prev + Math.floor(availableHeight / 2));
    } else if (key.pageDown) {
      lastScrollAtRef.current = Date.now();
      setScrollUp((prev) => Math.max(0, prev - Math.floor(availableHeight / 2)));
    } else if (key.ctrl && key.downArrow) {
      // Ctrl+Down → snap to bottom
      setScrollUp(0);
    } else if (key.downArrow && !key.ctrl && !key.shift) {
      // Plain down arrow while scrolled: nudge down 2 lines
      if (scrollUp > 0) {
        lastScrollAtRef.current = Date.now();
        setScrollUp((prev) => Math.max(0, prev - 2));
      }
    } else if (key.upArrow && !key.ctrl && !key.shift) {
      // Plain up arrow: nudge up 2 lines
      lastScrollAtRef.current = Date.now();
      setScrollUp((prev) => prev + 2);
    }
    // End key → snap to bottom
    if ((key as { name?: string }).name === "end") {
      setScrollUp(0);
    }
  });

  // ═══ MOUSE SCROLL — frame-throttled ═══
  const flushScroll = useCallback(() => {
    scrollRafRef.current = null;
    const delta = scrollAccRef.current;
    scrollAccRef.current = 0;
    if (delta === 0) return;
    lastScrollAtRef.current = Date.now();
    if (delta > 0) {
      // Wheel up → scroll up (see older content)
      setScrollUp((prev) => prev + delta);
    } else {
      // Wheel down → scroll down (see newer content)
      setScrollUp((prev) => Math.max(0, prev + delta));
    }
  }, []);

  const handleMouseUp = useCallback(() => {
    scrollAccRef.current += 2;
    if (!scrollRafRef.current) {
      scrollRafRef.current = setTimeout(flushScroll, 32);
    }
  }, [flushScroll]);

  const handleMouseDown = useCallback(() => {
    if (scrollUp === 0) return; // already at bottom
    scrollAccRef.current -= 2;
    if (!scrollRafRef.current) {
      scrollRafRef.current = setTimeout(flushScroll, 32);
    }
  }, [scrollUp, flushScroll]);

  useMouseScroll(handleMouseUp, handleMouseDown);

  // ═══ SINGLE JSX RETURN ═══
  return (
    <Box flexDirection="column" height={availableHeight}>
      {/* Scroll indicator — outside the scrollable area (doesn't participate in clip) */}
      {scrollUp > 0 && (
        <Box>
          <Text color="#555555">↑ {scrollUp} lines up  (End/↓ to return)</Text>
        </Box>
      )}

      {/* Content box:
          justifyContent="flex-end" → messages pinned to bottom.
          overflow="hidden"          → when content > contentHeight, clips at TOP (old msgs).
          This means scrollUp > 0 intentionally overflows old content at the top,
          revealing it while keeping newest messages always at the bottom. */}
      <Box
        flexDirection="column"
        flexGrow={1}
        overflow="hidden"
        justifyContent="flex-end"
      >
        {visibleMessages.map((msg, i) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            width={columns}
            isLatest={i === visibleMessages.length - 1}
          />
        ))}
      </Box>
    </Box>
  );
});

// Backward compat aliases
export const HistoryPanel = MessageList;
export type HistoryPanelProps = MessageListProps;
