/**
 * CollapsibleSection — generic expand/collapse wrapper.
 * Used by ToolCallTree for file reads, diffs, bash output.
 */

import React from "react";
import { Box, Text } from "ink";

export interface CollapsibleSectionProps {
  isExpanded: boolean;
  onToggle: () => void;
  collapsedSummary: string;
  expandHint?: string;
  children: React.ReactNode;
}

export function CollapsibleSection({
  isExpanded,
  onToggle: _onToggle,
  collapsedSummary,
  expandHint,
  children,
}: CollapsibleSectionProps): React.JSX.Element {
  const hint = expandHint ?? (isExpanded ? "(ctrl+o to collapse)" : "(ctrl+o to expand)");

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text dimColor>{collapsedSummary}</Text>
        <Text dimColor>{hint}</Text>
      </Box>
      {isExpanded && (
        <Box flexDirection="column" marginLeft={2}>
          {children}
        </Box>
      )}
    </Box>
  );
}
