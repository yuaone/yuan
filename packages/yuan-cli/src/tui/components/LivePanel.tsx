/**
 * LivePanel — renders the currently streaming assistant message and its tool calls.
 * Sits between HistoryPanel and InputBox, always at the bottom of the message area.
 * When idle (no message, not thinking), renders nothing (height 0).
 */

import React, { memo } from "react";
import { Box, Text } from "ink";
import { Spinner } from "./Spinner.js";
import { MessageBubble } from "./MessageBubble.js";
import type { TUIMessage } from "../types.js";

export interface LivePanelProps {
  message: TUIMessage | null;
  isThinking: boolean;
  width: number;
  maxHeight: number;
}

export const LivePanel = memo(function LivePanel({
  message,
  isThinking,
  width,
  maxHeight,
}: LivePanelProps): React.JSX.Element | null {
  // Nothing to show — render nothing (height 0)
  if (!message && !isThinking) return null;

  const separatorLine = "╌".repeat(Math.max(1, width - 2));

  return (
    <Box flexDirection="column" flexShrink={0} height={maxHeight} overflow="hidden">
      {/* Thin separator */}
      <Box flexShrink={0}>
        <Text dimColor>{separatorLine}</Text>
      </Box>

      {/* Thinking spinner — no message content yet */}
      {!message && isThinking && (
        <Box paddingLeft={1} flexShrink={0}>
          <Spinner label="YUAN ·····" />
        </Box>
      )}

      {/* Streaming message */}
      {message && (
        <MessageBubble message={message} width={width} isLatest />
      )}
    </Box>
  );
});
