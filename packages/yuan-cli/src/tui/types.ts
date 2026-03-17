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

/** Phase 3: Autonomous Engineering Loop — inline tree event */
export interface TUIPhaseEvent {
  id: string;
  /** Which autonomous component produced this */
  kind: "research" | "plan" | "tournament" | "task" | "debug";
  /** Bold headline e.g. "Research  confidence:72%" */
  title: string;
  /** One-line summary shown collapsed */
  summary: string;
  /** Tree items shown expanded (each is one tree leaf) */
  items: string[];
  status: "running" | "done" | "error";
  timestamp: number;
}

/** A message in the conversation */
export interface TUIMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool" | "queued_user";
  content: string;
  timestamp?: number;
  /** Tool calls attached to this assistant message */
  toolCalls?: TUIToolCall[];
  /** Whether the assistant is still generating this message */
  isStreaming?: boolean;
  /** Lane separation: narration (ephemeral thinking-aloud) vs final (structured output) */
  streamKind?: "narration" | "final";
  /** Extended thinking / reasoning content (shown dimmed below the main content) */
  thinkingContent?: string;
  /** Tool-specific fields */
  toolName?: string;
  toolSuccess?: boolean;
  toolDurationMs?: number;
  /** Phase 3 autonomous events rendered as inline tree below message content */
  phaseEvents?: TUIPhaseEvent[];
}

/** A tool call within an assistant message */
export interface TUIToolCall {
  id: string;
  callId?: string
  toolName: string;
  argsSummary: string;
  status: "running" | "success" | "error";
  duration?: number;
  result?: TUIToolResult;
  isExpanded: boolean;
  /** timestamp when tool started */
  startedAt?: number;
  /** timestamp when tool completed */
  completedAt?: number;
  /** parallel batch id (tools started in same tick share batch) */
  batchId?: string;
 }

/** The result of a tool call */
export interface TUIToolResult {
  kind: "text" | "diff" | "bash_output" | "grep_output" | "file_content" | "error";
  content: string;
  diff?: ParsedDiff;
  lineCount: number;
  /** Structured metadata for rich tree display */
  meta?: {
    exitCode?: number;    // bash: exit code from [exit N]
    matchCount?: number;  // grep: total matches found
    engine?: string;      // grep: "ripgrep" | "node"
  };
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

/** Agent status — extended for indicator */
export type AgentStatus =
  | "idle"
  | "thinking"
  | "streaming"
  | "tool_running"
  | "awaiting_approval"
  | "error"
  | "completed"
  | "interrupted";

/** A single step/event from a background agent */
export interface TUIBGStep {
  id: string;
  label: string;
  type: "info" | "success" | "warning" | "error";
  timestamp: number;
}

/** A background agent task tracked in the TUI */
export interface TUIBackgroundTask {
  id: string;
  label: string;
  /** "running" = has received at least one event in last 5 min, "idle" = quiet */
  status: "running" | "idle" | "error";
  /** Last 20 steps/events */
  steps: TUIBGStep[];
  lastUpdatedAt: number;
}

/** Agent stream state */
export interface AgentStreamState {
  status: AgentStatus;
  messages: TUIMessage[];
  tokensPerSecond: number;
  totalTokensUsed: number;
  /** Real-time elapsed ms since agent started (ticks while running) */
  elapsedMs: number;
  /** Frozen elapsed time from last completed run (persisted) */
  lastElapsedMs: number | null;
  /** Current tool name being executed */
  currentToolName: string | null;
  /** Current tool args summary */
  currentToolArgs: string | null;
  /** Error message (for error indicator) */
  lastError: string | null;
  /** Files changed count in this turn */
  filesChangedCount: number;
  reasoningTree?: ReasoningNode;
  /** ms since last event while agent is running (0 = not stalled) */
  stalledMs: number;
  /** Background agent tasks (type-checker, security-scan, etc.) */
  backgroundTasks: TUIBackgroundTask[];
  /** Fine-grained progress label from progress:status events (analyzing/searching/coding/etc.) */
  progressLabel?: string;
  /** Current task phase: explore → implement → verify → finalize */
  currentPhase?: "explore" | "implement" | "verify" | "finalize";
}
/** Hierarchical reasoning tree node */
export interface ReasoningNode {
  id: string;
  label: string;
  text?: string;
  children: ReasoningNode[];
}