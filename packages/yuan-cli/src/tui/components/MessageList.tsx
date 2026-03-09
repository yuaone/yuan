/**
 * MessageList — scrollable message area with virtual scroll.
 * Uses MessageBubble for individual message rendering.
 * Supports PageUp/PageDown scroll, auto-scroll on new messages.
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { useScrollPosition } from "../hooks/useScrollPosition.js";
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

export function MessageList({
  messages,
  isThinking,
  maxHeight,
}: MessageListProps): React.JSX.Element {
  const { columns, rows } = useTerminalSize();
  const height = maxHeight ?? rows - 4;

  // Approximate: each message takes ~3 lines on average
  const viewportMsgCount = Math.max(3, Math.floor(height / 3));

  const [scroll, scrollActions] = useScrollPosition(
    messages.length,
    viewportMsgCount,
  );

  // Key handling for scroll
  useInput((_input, key) => {
    if (key.pageUp) {
      scrollActions.pageUp();
    } else if (key.pageDown) {
      scrollActions.pageDown();
    }
  });

  // Compute visible slice
  const startIdx = scroll.offset;
  const endIdx = Math.min(messages.length, startIdx + viewportMsgCount);
  const visibleMessages = messages.slice(startIdx, endIdx);

  const hasAbove = scroll.aboveCount > 0;
  const hasBelow = scroll.belowCount > 0;

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {/* Scroll-up indicator */}
      {hasAbove && (
        <Box justifyContent="center">
          <Text dimColor>↑ {scroll.aboveCount} more</Text>
        </Box>
      )}

      {/* Messages */}
      {visibleMessages.length === 0 && !isThinking && (
        <Box justifyContent="center" marginTop={Math.floor(height / 3)}>
          <Text dimColor>Type a message to start...</Text>
        </Box>
      )}

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
        <Box marginTop={0}>
          <Text>  </Text>
          <Spinner label={`${TOKENS.brand.name} ·····`} />
        </Box>
      )}

      {/* Scroll-down indicator */}
      {hasBelow && (
        <Box justifyContent="center">
          <Text dimColor>↓ {scroll.belowCount} more</Text>
        </Box>
      )}
    </Box>
  );
}
