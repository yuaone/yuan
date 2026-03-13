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
import type { TUIToolCall, ReasoningNode } from "../types.js";
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
  let durationStr = "";
  if (tc.duration != null) {
    durationStr = ` ${tc.duration.toFixed(2)}s`;
  }

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
        {args && <Text dimColor>({args})</Text>}
      </Box>

      <Box paddingLeft={2}>
        <Text dimColor>{continuation} </Text>
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
  const batches = groupBatches(toolCalls);

  return (
    <Box flexDirection="column">
      {batches.map((batch, batchIndex) => {
        const isParallel = batch.length > 1;

        if (isParallel) {
          const batchRunning = batch.some((tc) => tc.status === "running");
          return (
            <Box key={`batch-${batchIndex}`} flexDirection="column">
              <Box>
                <Text dimColor>{batchRunning ? "running tools..." : "tool batch."}</Text>
                <Text> </Text>
                {batchRunning ? <Spinner /> : <Text dimColor>done.</Text>}
              </Box>
              {batch.map((tc, i) => (
                <ToolCallNode
                  key={tc.id}
                  tc={tc}
                  isLast={i === batch.length - 1}
                  width={width}
                />
              ))}
            </Box>
          );
        }

        const tc = batch[0];
        if (!tc) return null;
        return (
          <ToolCallNode
            key={tc.id}
            tc={tc}
            isLast={batchIndex === batches.length - 1}
            width={width}
          />
        );
      })}
    </Box>
  );
}
function groupBatches(toolCalls: TUIToolCall[]): TUIToolCall[][] {
  const map = new Map<string, TUIToolCall[]>();

  for (const tc of toolCalls) {
    const key = tc.batchId ?? tc.id;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(tc);
  }

  return Array.from(map.values()).sort((a, b) => {
    const aStart = a[0]?.startedAt ?? 0;
    const bStart = b[0]?.startedAt ?? 0;
    return aStart - bStart;
  });
}

export function ReasoningTreeView({
  node,
  depth = 0,
}: {
  node: ReasoningNode;
  depth?: number;
}): React.JSX.Element {
  const prefix = depth === 0 ? "" : "  ".repeat(depth - 1) + "├─ ";

  return (
    <Box flexDirection="column">
      {depth > 0 && (
        <Text>
          {prefix}
          <Text bold>{node.label}</Text>
          {node.text && <Text dimColor> {node.text}</Text>}
        </Text>
      )}

      {node.children.map((child) => (
        <ReasoningTreeView key={child.id} node={child} depth={depth + 1} />
      ))}
    </Box>
  );
}