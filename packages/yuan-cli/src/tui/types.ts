/**
 * YUAN TUI — shared type definitions.
 */

import type { LayoutTier } from "./lib/tokens.js";

/** Connection status for the status bar */
export type ConnectionStatus = "connected" | "connecting" | "disconnected" | "error";

/** Terminal dimensions with computed tier */
export interface TerminalDimensions {
  columns: number;
  rows: number;
  tier: LayoutTier;
}

/** A message in the conversation */
export interface TUIMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: number;
  /** Tool calls attached to this assistant message */
  toolCalls?: TUIToolCall[];
  /** Whether the assistant is still generating this message */
  isStreaming?: boolean;
  /** Tool-specific fields */
  toolName?: string;
  toolSuccess?: boolean;
  toolDurationMs?: number;
}

/** A tool call within an assistant message */
export interface TUIToolCall {
  id: string;
  toolName: string;
  argsSummary: string;
  status: "running" | "success" | "error";
  duration?: number;
  result?: TUIToolResult;
  isExpanded: boolean;
}

/** The result of a tool call */
export interface TUIToolResult {
  kind: "text" | "diff" | "bash_output" | "file_content" | "error";
  content: string;
  diff?: ParsedDiff;
  lineCount: number;
}

/** Parsed diff structure */
export interface ParsedDiff {
  filePath: string;
  hunks: ParsedDiffHunk[];
  additions: number;
  deletions: number;
}

export interface ParsedDiffHunk {
  startOld: number;
  startNew: number;
  lines: ParsedDiffLine[];
}

export interface ParsedDiffLine {
  type: "add" | "delete" | "context";
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

/** Slash command definition */
export interface SlashCommand {
  name: string;
  description: string;
  aliases?: string[];
}

/** Agent stream state */
export interface AgentStreamState {
  status: "idle" | "thinking" | "streaming" | "tool_running" | "awaiting_approval";
  streamBuffer: string;
  messages: TUIMessage[];
  tokensPerSecond: number;
  totalTokensUsed: number;
}
