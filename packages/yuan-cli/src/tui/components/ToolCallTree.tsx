/**
 * ToolCallTree — tree-style tool call display with ├─ └─ connectors.
 * Shows status indicators, durations, and expandable results.
 */

import React, { useState, useCallback } from "react";
import { Box, Text } from "ink";
import { TOKENS } from "../lib/tokens.js";
import { Spinner } from "./Spinner.js";
import { CollapsibleSection } from "./CollapsibleSection.js";
import { DiffView } from "./DiffView.js";
import { BashOutput } from "./BashOutput.js";
import type { TUIToolCall } from "../types.js";
import { truncate } from "../lib/truncate.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";

export interface ToolCallTreeProps {
  toolCalls: TUIToolCall[];
  width: number;
}

function ToolCallNode({
  tc,
  isLast,
  width,
}: {
  tc: TUIToolCall;
  isLast: boolean;
  width: number;
}): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(tc.isExpanded);
  const connector = isLast ? TOKENS.tree.last : TOKENS.tree.branch;
  const continuation = isLast ? "  " : TOKENS.tree.pipe;

  const toggleExpand = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  // Status icon
  let statusEl: React.JSX.Element;
  if (tc.status === "running") {
    statusEl = <Spinner />;
  } else {
    const icon = tc.status === "success" ? "✓" : "✗";
    const color = tc.status === "success" ? "green" : "red";
    statusEl = <Text color={color}>{icon}</Text>;
  }

  // Duration
  const durationStr = tc.duration != null ? ` ${tc.duration.toFixed(1)}s` : "";

  // Truncate args summary based on available width
  const { tier } = useTerminalSize();
  const maxArgWidth = tier === "compact" ? 20 : width - 30;
  const args = tc.argsSummary
    ? truncate(tc.argsSummary, maxArgWidth)
    : "";

  return (
    <Box flexDirection="column">
      {/* Main line: connector + toolName + args + status + duration */}
      <Box>
        <Text dimColor>{connector} </Text>
        <Text bold>{tc.toolName}</Text>
        {args && <Text dimColor>  {args}</Text>}
        <Text>  </Text>
        {statusEl}
        <Text dimColor>{durationStr}</Text>
      </Box>

      {/* Result (if exists and expandable) */}
      {tc.result && tc.result.lineCount > 0 && (
        <Box paddingLeft={2}>
          <Text dimColor>{continuation}</Text>
          <Box flexDirection="column" marginLeft={1}>
            {tc.result.kind === "diff" && tc.result.diff ? (
              <CollapsibleSection
                isExpanded={isExpanded}
                onToggle={toggleExpand}
                collapsedSummary={`${tc.result.diff.additions + tc.result.diff.deletions} changes`}
              >
                <DiffView diff={tc.result.diff} width={width - 6} />
              </CollapsibleSection>
            ) : tc.result.kind === "bash_output" ? (
              <CollapsibleSection
                isExpanded={isExpanded}
                onToggle={toggleExpand}
                collapsedSummary={`${tc.result.lineCount} lines of output`}
              >
                <BashOutput
                  command={tc.toolName}
                  output={tc.result.content}
                  width={width - 6}
                />
              </CollapsibleSection>
            ) : tc.result.lineCount > 10 ? (
              <CollapsibleSection
                isExpanded={isExpanded}
                onToggle={toggleExpand}
                collapsedSummary={`${tc.result.lineCount} lines`}
              >
                <Text dimColor>{tc.result.content}</Text>
              </CollapsibleSection>
            ) : (
              <Text dimColor>{tc.result.content}</Text>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}

export function ToolCallTree({
  toolCalls,
  width,
}: ToolCallTreeProps): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {toolCalls.map((tc, i) => (
        <ToolCallNode
          key={tc.id}
          tc={tc}
          isLast={i === toolCalls.length - 1}
          width={width}
        />
      ))}
    </Box>
  );
}
