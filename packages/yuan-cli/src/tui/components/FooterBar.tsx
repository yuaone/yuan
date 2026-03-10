/**
 * FooterBar — bottom status indicator (left) + keybind hints (right).
 * Real-time elapsed timer, status-based icons, tool info display.
 *
 * Layout:  [indicator + timer]                    [keybind hints]
 *
 * States:
 *   idle          ▸ ready                         / commands  ↑↓ history  ^C exit
 *   thinking      ⠋ thinking  4.2s                esc interrupt
 *   streaming     ◆ streaming  12.3s              esc interrupt
 *   tool_running  ⚙ reading src/index.ts  8.1s    esc interrupt
 *   approval      ⚠ approval — file_write         y approve  n deny  esc skip
 *   completed     ✓ done  3 files  1.2k tok  14.2s  / commands  ↑↓ history  ^C exit
 *   error         ✗ error  API rate limit  5.1s   / commands  ↑↓ history  ^C exit
 *   interrupted   ✗ interrupted  3.4s             / commands  ↑↓ history  ^C exit
 */

import React, { memo } from "react";
import { Box, Text } from "ink";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import type { AgentStreamState } from "../types.js";

// Spinner frames for thinking state
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface FooterBarProps {
  agentState: AgentStreamState;
  slashMenuOpen?: boolean;
}

/** Format milliseconds to human-readable elapsed time */
function formatElapsed(ms: number): string {
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remainSec = sec % 60;
  return `${min}m ${remainSec.toFixed(0)}s`;
}

/** Format token count: 1234 → 1.2k */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

/** Get tool action verb from tool name */
function getToolVerb(toolName: string): string {
  const name = toolName.toLowerCase();
  if (name.includes("read") || name.includes("file_read")) return "reading";
  if (name.includes("write") || name.includes("file_write")) return "writing";
  if (name.includes("edit") || name.includes("file_edit")) return "editing";
  if (name.includes("bash") || name.includes("shell") || name.includes("exec")) return "running";
  if (name.includes("grep") || name.includes("search")) return "searching";
  if (name.includes("glob") || name.includes("find")) return "finding";
  if (name.includes("git")) return "git";
  return "tool";
}

function Indicator({ agentState }: { agentState: AgentStreamState }): React.JSX.Element {
  const { status, elapsedMs, lastElapsedMs, currentToolName, currentToolArgs, lastError, totalTokensUsed, filesChangedCount } = agentState;
  const elapsed = formatElapsed(elapsedMs);

  // Spinner frame — derived from elapsed seconds (stable with 1s timer tick)
  const spinnerIdx = Math.floor(elapsedMs / 1000) % SPINNER_FRAMES.length;
  const spinner = SPINNER_FRAMES[spinnerIdx];

  switch (status) {
    case "idle": {
      // After completion: show frozen time permanently
      if (lastElapsedMs != null) {
        const frozenTime = formatElapsed(lastElapsedMs);
        const tokens = formatTokens(totalTokensUsed);
        const files = filesChangedCount > 0 ? `  ${filesChangedCount} files` : "";
        return (
          <Text dimColor>
            <Text color="green">✓</Text> done{files}  {tokens} tok  {frozenTime}
          </Text>
        );
      }
      return <Text dimColor>▸ ready</Text>;
    }

    case "thinking":
      return (
        <Text dimColor>
          <Text color="yellow">{spinner}</Text> thinking  {elapsed}
        </Text>
      );

    case "streaming":
      return (
        <Text>
          <Text color="white" bold>●</Text>
          <Text dimColor> streaming  {elapsed}</Text>
        </Text>
      );

    case "tool_running": {
      const verb = currentToolName ? getToolVerb(currentToolName) : "tool";
      const detail = currentToolArgs || currentToolName || "";
      // Truncate detail to 40 chars
      const truncDetail = detail.length > 40 ? detail.slice(0, 39) + "…" : detail;
      return (
        <Text dimColor>
          <Text color="cyan">⚙</Text> {verb}  {truncDetail}  {elapsed}
        </Text>
      );
    }

    case "awaiting_approval": {
      const toolHint = currentToolName ? ` — ${currentToolName}` : "";
      return (
        <Text bold color="yellow">
          ⚠ approval needed{toolHint}
        </Text>
      );
    }

    case "completed": {
      const frozenTime = formatElapsed(lastElapsedMs ?? elapsedMs);
      const tokens = formatTokens(totalTokensUsed);
      const files = filesChangedCount > 0 ? `  ${filesChangedCount} files` : "";
      return (
        <Text dimColor>
          <Text color="green">✓</Text> done{files}  {tokens} tok  {frozenTime}
        </Text>
      );
    }

    case "error": {
      const errSummary = lastError
        ? lastError.length > 30 ? lastError.slice(0, 29) + "…" : lastError
        : "";
      const frozenTime = formatElapsed(lastElapsedMs ?? elapsedMs);
      return (
        <Text>
          <Text color="red">✗</Text>
          <Text dimColor> error  {errSummary}  {frozenTime}</Text>
        </Text>
      );
    }

    case "interrupted": {
      const frozenTime = formatElapsed(lastElapsedMs ?? elapsedMs);
      return (
        <Text>
          <Text color="red">✗</Text>
          <Text dimColor> interrupted  {frozenTime}</Text>
        </Text>
      );
    }

    default:
      return <Text dimColor>▸ ready</Text>;
  }
}

function KeybindHints({ agentState, slashMenuOpen }: { agentState: AgentStreamState; slashMenuOpen?: boolean }): React.JSX.Element {
  const { status } = agentState;

  if (slashMenuOpen) {
    return (
      <Box>
        <Text bold>↑↓</Text>
        <Text dimColor> navigate  </Text>
        <Text bold>tab</Text>
        <Text dimColor> complete  </Text>
        <Text bold>enter</Text>
        <Text dimColor> execute  </Text>
        <Text bold>esc</Text>
        <Text dimColor> close</Text>
      </Box>
    );
  }

  if (status === "awaiting_approval") {
    return (
      <Box>
        <Text bold color="green">y</Text>
        <Text dimColor> approve  </Text>
        <Text bold color="red">n</Text>
        <Text dimColor> deny  </Text>
        <Text bold>esc</Text>
        <Text dimColor> skip</Text>
      </Box>
    );
  }

  // Running states: thinking, streaming, tool_running
  if (status === "thinking" || status === "streaming" || status === "tool_running") {
    return (
      <Box>
        <Text bold>esc</Text>
        <Text dimColor> interrupt</Text>
      </Box>
    );
  }

  // idle, completed, error, interrupted
  return (
    <Box>
      <Text bold>/</Text>
      <Text dimColor> commands  </Text>
      <Text bold>↑↓</Text>
      <Text dimColor> history  </Text>
      <Text bold>ctrl+c</Text>
      <Text dimColor> exit</Text>
    </Box>
  );
}

export const FooterBar = memo(function FooterBar({ agentState, slashMenuOpen }: FooterBarProps): React.JSX.Element {
  const { columns } = useTerminalSize();

  return (
    <Box width={columns} height={1} flexShrink={0} justifyContent="space-between">
      <Box minWidth={35}>
        <Indicator agentState={agentState} />
      </Box>
      <Box minWidth={30}>
        <KeybindHints agentState={agentState} slashMenuOpen={slashMenuOpen} />
      </Box>
    </Box>
  );
});
