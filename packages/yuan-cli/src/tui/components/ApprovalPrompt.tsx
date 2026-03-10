/**
 * ApprovalPrompt — shows when agent needs user approval for a tool call.
 * Three options selectable by 1/2/3 keys or arrow keys + enter.
 *
 * Options:
 *   1. Allow — approve this action
 *   2. Allow always — approve and don't ask again for this tool
 *   3. Deny — reject this action
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export type ApprovalChoice = "allow" | "allow_always" | "deny";

export interface ApprovalPromptProps {
  toolName: string;
  toolArgs?: string;
  onSelect: (choice: ApprovalChoice) => void;
}

interface Option {
  key: string;
  label: string;
  description: string;
  choice: ApprovalChoice;
}

const OPTIONS: Option[] = [
  { key: "1", label: "허용", description: "이번만 실행", choice: "allow" },
  { key: "2", label: "항상 허용", description: "이 도구 자동승인", choice: "allow_always" },
  { key: "3", label: "거부", description: "실행 안 함", choice: "deny" },
];

export function ApprovalPrompt({
  toolName,
  toolArgs,
  onSelect,
}: ApprovalPromptProps): React.JSX.Element {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    // Arrow navigation
    if (key.upArrow) {
      setSelectedIndex((prev) => (prev <= 0 ? OPTIONS.length - 1 : prev - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => (prev >= OPTIONS.length - 1 ? 0 : prev + 1));
      return;
    }

    // Enter to confirm
    if (key.return) {
      onSelect(OPTIONS[selectedIndex].choice);
      return;
    }

    // Quick-select by number
    if (input === "1") {
      onSelect(OPTIONS[0].choice);
      return;
    }
    if (input === "2") {
      onSelect(OPTIONS[1].choice);
      return;
    }
    if (input === "3") {
      onSelect(OPTIONS[2].choice);
      return;
    }
  });

  const argsSummary = toolArgs ? toolArgs : "";

  return (
    <Box flexDirection="column" paddingLeft={2} paddingRight={2} marginTop={0} marginBottom={0}>
      {/* Header */}
      <Box>
        <Text color="yellow">{"  \u26A0 "}</Text>
        <Text bold color="white">{toolName}</Text>
        {argsSummary ? (
          <>
            <Text dimColor> wants to run: </Text>
            <Text color="white">{argsSummary}</Text>
          </>
        ) : (
          <Text dimColor> requires approval</Text>
        )}
      </Box>

      {/* Spacer */}
      <Text>{" "}</Text>

      {/* Options */}
      {OPTIONS.map((opt, i) => {
        const isSelected = i === selectedIndex;
        return (
          <Box key={opt.key} paddingLeft={2}>
            <Text dimColor>{opt.key}  </Text>
            {isSelected ? (
              <Text bold color="white">{opt.label.padEnd(12)}</Text>
            ) : (
              <Text dimColor>{opt.label.padEnd(12)}</Text>
            )}
            <Text dimColor>{" \u2014 "}{opt.description}</Text>
          </Box>
        );
      })}

      {/* Spacer */}
      <Text>{" "}</Text>
    </Box>
  );
}
