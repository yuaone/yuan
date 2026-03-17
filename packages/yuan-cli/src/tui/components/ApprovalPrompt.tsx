/**
 * ApprovalPrompt — shows when agent needs user approval for a tool call.
 *
 * Layout (Claude Code style):
 *   <ToolName>
 *     <args>
 *     <description>
 *
 *   Do you want to allow this action?
 *   > 1. Yes
 *     2. Yes, and don't ask again for <toolName>
 *     3. No  (esc)
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export type ApprovalChoice = "allow" | "allow_always" | "deny";
export const APPROVAL_PROMPT_HEIGHT = 7;

export interface ApprovalPromptProps {
  toolName: string;
  toolArgs?: string;
  onSelect: (choice: ApprovalChoice) => void;
}

function toolDescription(toolName: string, args: string): string {
  const n = toolName.toLowerCase();
  if (n.includes("shell") || n.includes("exec") || n.includes("bash")) return `YUAN wants to run this command`;
  if (n.includes("write")) return `YUAN wants to write to this file`;
  if (n.includes("edit")) return `YUAN wants to edit this file`;
  if (n.includes("read")) return `YUAN wants to read this file`;
  if (n.includes("fetch") || n.includes("web")) return `YUAN wants to fetch this URL`;
  if (n.includes("git")) return `YUAN wants to run a git operation`;
  return `YUAN wants to use ${toolName}`;
}

export function ApprovalPrompt({
  toolName,
  toolArgs,
  onSelect,
}: ApprovalPromptProps): React.JSX.Element {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const options = [
    { key: "1", label: "Yes", choice: "allow" as ApprovalChoice },
    { key: "2", label: `Yes, and don't ask again for ${toolName}`, choice: "allow_always" as ApprovalChoice },
    { key: "3", label: "No  (esc)", choice: "deny" as ApprovalChoice },
  ];

  useInput((input, key) => {
    if (key.escape || input === "n") { onSelect("deny"); return; }
    if (input === "y") { onSelect("allow"); return; }
    if (key.upArrow) { setSelectedIndex((p) => (p <= 0 ? options.length - 1 : p - 1)); return; }
    if (key.downArrow) { setSelectedIndex((p) => (p >= options.length - 1 ? 0 : p + 1)); return; }
    if (key.return) { onSelect(options[selectedIndex].choice); return; }
    if (input === "1") { onSelect("allow"); return; }
    if (input === "2") { onSelect("allow_always"); return; }
    if (input === "3") { onSelect("deny"); return; }
  });

  const args = toolArgs ?? "";
  const desc = toolDescription(toolName, args);

  return (
    <Box
      flexDirection="column"
      height={APPROVAL_PROMPT_HEIGHT}
      flexShrink={0}
      overflow="hidden"
      paddingLeft={2}
      paddingRight={2}
    >
      {/* Tool name header */}
    <Text bold color="white" wrap="truncate">{toolName}</Text>

      {/* Args */}
      {args && (
        <Box paddingLeft={2}>
          <Text color="cyan" wrap="truncate">{args}</Text>
        </Box>
      )}

      {/* Description */}
      <Box paddingLeft={2}>
        <Text dimColor wrap="truncate">{desc}</Text>
      </Box>

      {/* Prompt row */}
      <Box height={1}>
        <Text dimColor>Do you want to allow this action?</Text>
      </Box>

      {/* Options */}
      <Box flexDirection="column" flexShrink={0} overflow="hidden">
        {options.map((opt, i) => {
          const isSelected = i === selectedIndex;
          return (
            <Box key={opt.key}>
              <Text color={isSelected ? "white" : undefined} dimColor={!isSelected}>
                {isSelected ? "> " : "  "}
              </Text>
              <Text dimColor={!isSelected}>{opt.key}. </Text>
              <Text bold={isSelected} color={isSelected ? "white" : undefined} dimColor={!isSelected}>
                {opt.label}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
