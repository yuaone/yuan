/**
 * useScrollPosition — virtual scroll state for MessageList.
 * Tracks scroll offset, auto-scroll behavior, and scroll indicators.
 */

import { useState, useCallback, useEffect } from "react";

export interface ScrollState {
  /** Index of the first visible message */
  offset: number;
  /** Total number of messages */
  total: number;
  /** Number of messages visible in viewport */
  viewportSize: number;
  /** Whether auto-scroll is engaged (scroll to bottom on new messages) */
  autoScroll: boolean;
  /** Number of messages above viewport */
  aboveCount: number;
  /** Number of messages below viewport */
  belowCount: number;
}

export interface ScrollActions {
  scrollUp: (amount?: number) => void;
  scrollDown: (amount?: number) => void;
  scrollToBottom: () => void;
  pageUp: () => void;
  pageDown: () => void;
}

export function useScrollPosition(
  totalMessages: number,
  viewportSize: number,
): [ScrollState, ScrollActions] {
  const [offset, setOffset] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);

  // Auto-scroll when new messages arrive and autoScroll is engaged
  useEffect(() => {
    if (autoScroll && totalMessages > viewportSize) {
      setOffset(Math.max(0, totalMessages - viewportSize));
    }
  }, [totalMessages, viewportSize, autoScroll]);

  const scrollUp = useCallback(
    (amount = 1) => {
      setOffset((prev) => {
        const next = Math.max(0, prev - amount);
        if (next < prev) setAutoScroll(false);
        return next;
      });
    },
    [],
  );

  const scrollDown = useCallback(
    (amount = 1) => {
      setOffset((prev) => {
        const maxOffset = Math.max(0, totalMessages - viewportSize);
        const next = Math.min(maxOffset, prev + amount);
        if (next >= maxOffset) setAutoScroll(true);
        return next;
      });
    },
    [totalMessages, viewportSize],
  );

  const scrollToBottom = useCallback(() => {
    setOffset(Math.max(0, totalMessages - viewportSize));
    setAutoScroll(true);
  }, [totalMessages, viewportSize]);

  const pageUp = useCallback(() => {
    scrollUp(Math.max(1, viewportSize - 2));
  }, [scrollUp, viewportSize]);

  const pageDown = useCallback(() => {
    scrollDown(Math.max(1, viewportSize - 2));
  }, [scrollDown, viewportSize]);

  const aboveCount = offset;
  const belowCount = Math.max(0, totalMessages - viewportSize - offset);

  const state: ScrollState = {
    offset,
    total: totalMessages,
    viewportSize,
    autoScroll,
    aboveCount,
    belowCount,
  };

  return [state, { scrollUp, scrollDown, scrollToBottom, pageUp, pageDown }];
}
