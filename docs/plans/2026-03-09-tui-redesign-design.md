# YUAN CLI Terminal UI Redesign — Design Document

> **Date:** 2026-03-09
> **Package:** `@yuaone/cli` (`packages/yuan-cli/`)
> **Status:** Draft
> **Author:** Auto-generated design specification

---

## 1. Overview

### Goal

Replace the current readline-based REPL (`interactive.ts`) with a full-screen terminal UI inspired by Claude Code. The new TUI occupies the entire alternate screen buffer, providing an immersive IDE-like experience with structured panels, collapsible tool call sections, inline diff viewing, and a dedicated input area.

### Why

The current implementation uses a simple `readline.Interface` REPL with `console.log` output. This has several limitations:

- No scroll management — long output pushes input off-screen
- No structured layout — tool calls, diffs, and messages mix into a single stream
- No expandable/collapsible sections — large file reads flood the terminal
- No responsive layout — renders identically at 60 and 200 columns
- No input history beyond what readline provides natively
- No visual hierarchy between user messages, agent responses, and system events

### Framework Choice

**Hybrid approach: `ink` (React for CLI) + raw ANSI escape codes.**

- `ink` v5 provides a React component model for structured layout, flexbox-based positioning, and state management via hooks.
- Raw ANSI escapes handle performance-critical paths: alternate screen buffer enter/exit, cursor positioning for the spinner animation, and high-throughput streaming token display.
- This matches the architecture used by Claude Code, Warp, and other modern terminal tools.

### Alternate Screen Buffer

The TUI enters the alternate screen buffer on startup (`\x1b[?1049h`) and restores the original buffer on exit (`\x1b[?1049l`). This means:

- The user's existing terminal content is preserved and restored on exit.
- The full terminal window is available for layout.
- Scrollback does not pollute the user's shell history.

### Current State (What Exists)

The following files in `packages/yuan-cli/src/` are relevant to the redesign:

| File | Role | Redesign Impact |
|------|------|-----------------|
| `interactive.ts` | REPL loop, slash commands, event handling | **Replace entirely** with `App.tsx` + hooks |
| `renderer.ts` | `TerminalRenderer` class, ANSI colors, `Spinner`, markdown | **Extract** colors/ANSI to `lib/ansi.ts`; replace rendering with ink components |
| `diff-renderer.ts` | `DiffRenderer` class, unified diff display | **Migrate** to `DiffView.tsx` component |
| `y-spinner.ts` | `YSpinner` with glowing Y animation | **Migrate** to `Spinner.tsx` ink component |
| `progress-renderer.ts` | Progress bars for file operations | **Migrate** to ink component |
| `design-renderer.ts` | Design document rendering | Keep as-is (non-interactive) |
| `cli.ts` | Commander entry point | Add `--tui` flag, default to TUI in interactive mode |
| `session.ts` | Session persistence | Reuse unchanged |
| `config.ts` | Config management | Reuse unchanged |
| `cloud-client.ts` | Cloud mode SSE streaming | Reuse unchanged; wire to `useAgentStream` hook |

---

## 2. Screen Layout

The terminal is divided into four fixed zones. The message area is the only scrollable region.

### Layout Diagram (Normal: 80-119 columns)

```
╭─────────────────────────────────────────────────────────────────────────────╮
│  YUAN v0.1.3  │  anthropic/claude-sonnet-4  │  42.3 tok/s  │  ● connected │
╰─────────────────────────────────────────────────────────────────────────────╯
│                                                                             │
│  ● you                                                                      │
│  Fix the auth middleware to handle expired tokens gracefully                │
│                                                                             │
│  ✻ yuan                                                                     │
│  I'll fix the auth middleware. Let me first read the current implementation │
│  and then make the necessary changes.                                       │
│                                                                             │
│  ├─ Read  src/middleware/auth.ts                                    ✓ 0.2s  │
│  ├─ Read  src/utils/token.ts                                       ✓ 0.1s  │
│  ╰─ Reading 2 files...                              (ctrl+o to expand)     │
│                                                                             │
│  ├─ Edit  src/middleware/auth.ts                                            │
│  │  ╭──────────────────────────────────────────────────────────────╮        │
│  │  │  23  │ -  if (!token) throw new AuthError('missing');        │        │
│  │  │  23  │ +  if (!token) {                                     │        │
│  │  │  24  │ +    throw new AuthError('missing', 401);            │        │
│  │  │  25  │ +  }                                                 │        │
│  │  │  26  │ -  const decoded = verify(token);                    │        │
│  │  │  26  │ +  const decoded = verifyWithExpiry(token);          │        │
│  │  ╰──────────────────────────────────────────────────────────────╯        │
│  │                                                                          │
│  ╰─ Bash  npm test -- --grep "auth"                                ✓ 1.4s  │
│     ╭─ output ──────────────────────────────────╮                           │
│     │  PASS  src/__tests__/auth.test.ts         │                           │
│     │    ✓ handles expired tokens (23ms)        │                           │
│     │    ✓ handles missing tokens (4ms)         │                           │
│     │  Tests: 2 passed, 2 total                 │                           │
│     ╰───────────────────────────────────────────╯                           │
│                                                                         ... │
╭─────────────────────────────────────────────────────────────────────────────╮
│ >  _                                                                        │
╰─────────────────────────────────────────────────────────────────────────────╯
  esc to interrupt  │  /help for commands  │  ctrl+c to exit
```

### Compact Layout (< 80 columns)

```
╭──────────────────────────────────────────────────────╮
│ YUAN v0.1.3 │ sonnet-4 │ ● connected                │
╰──────────────────────────────────────────────────────╯
│                                                       │
│ ● you                                                 │
│ Fix the auth middleware                               │
│                                                       │
│ ✻ yuan                                                │
│ I'll fix the auth middleware...                       │
│                                                       │
│ ├─ Read  auth.ts                             ✓ 0.2s  │
│ ╰─ Read  token.ts                            ✓ 0.1s  │
│                                                   ... │
╭──────────────────────────────────────────────────────╮
│ >  _                                                  │
╰──────────────────────────────────────────────────────╯
  esc │ /help │ ctrl+c
```

### Wide Layout (>= 120 columns)

Same as Normal, but:

- Diff view can show side-by-side (old | new) when width >= 140
- Tool call tree shows full file paths instead of truncated
- Status bar shows additional info: session ID, elapsed time, iteration count

### Zone Breakdown

| Zone | Position | Height | Scrollable | Content |
|------|----------|--------|------------|---------|
| **StatusBar** | Top, row 0 | 1 line | No | Version, model, tokens/s, connection |
| **MessageArea** | Rows 1 to (H-4) | Dynamic | Yes (virtual) | Conversation history |
| **InputBox** | Row (H-3) to (H-2) | 2 lines (expandable) | No | User input with prompt |
| **FooterBar** | Row (H-1) | 1 line | No | Keybind hints |

`H` = terminal height in rows.

---

## 3. Component Architecture

### Directory Structure

```
yuan-cli/src/tui/
  App.tsx                    — ink root, alternate screen, layout manager
  components/
    StatusBar.tsx            — top bar (model, tokens, status)
    MessageList.tsx          — scrollable message area with virtual scroll
    MessageBubble.tsx        — single message (user/agent/system)
    ToolCallTree.tsx         — tree-style tool call display with ├─ └─
    DiffView.tsx             — inline diff with red/green highlighting
    CollapsibleSection.tsx   — ctrl+o expand/collapse wrapper
    BashOutput.tsx           — shell command output with box
    InputBox.tsx             — bottom input with history, multiline
    SlashMenu.tsx            — / command autocomplete dropdown
    FooterBar.tsx            — bottom keybind hints
    Spinner.tsx              — braille dot spinner animation
    ThinkingDots.tsx         — "..." corner indicator
    MarkdownRenderer.tsx     — markdown to terminal rendering
  hooks/
    useTerminalSize.ts       — SIGWINCH responsive, returns { width, height, tier }
    useInputHistory.ts       — arrow up/down history stack
    useKeyHandler.ts         — Esc interrupt, ctrl+o expand, raw key dispatch
    useAgentStream.ts        — agent event -> UI state bridge
    useScrollPosition.ts     — virtual scroll state for MessageList
    useSlashCommands.ts      — slash command registry and matching
  lib/
    ansi.ts                  — raw ANSI escape helpers (extracted from renderer.ts)
    box-drawing.ts           — box rendering utilities
    diff-formatter.ts        — diff string -> structured DiffLine[] parser
    layout.ts                — responsive tier calculation
    screen-buffer.ts         — alternate screen buffer enter/exit
    truncate.ts              — Unicode-aware string truncation
  types.ts                   — shared TUI type definitions
```

### Component Dependency Graph

```
App.tsx
  ├── StatusBar.tsx
  ├── MessageList.tsx
  │     ├── MessageBubble.tsx
  │     │     ├── MarkdownRenderer.tsx
  │     │     ├── ToolCallTree.tsx
  │     │     │     ├── CollapsibleSection.tsx
  │     │     │     ├── DiffView.tsx
  │     │     │     └── BashOutput.tsx
  │     │     ├── Spinner.tsx
  │     │     └── ThinkingDots.tsx
  │     └── useScrollPosition.ts
  ├── InputBox.tsx
  │     ├── useInputHistory.ts
  │     └── SlashMenu.tsx
  │           └── useSlashCommands.ts
  ├── FooterBar.tsx
  ├── useTerminalSize.ts
  ├── useKeyHandler.ts
  └── useAgentStream.ts
```

---

## 4. Shared Type Definitions

```typescript
// tui/types.ts

/** Responsive layout tier */
export type LayoutTier = "compact" | "normal" | "wide";

/** Terminal dimensions with computed tier */
export interface TerminalDimensions {
  width: number;
  height: number;
  tier: LayoutTier;
}

/** Connection status for the status bar */
export type ConnectionStatus = "connected" | "connecting" | "disconnected" | "error";

/** A message in the conversation */
export interface TUIMessage {
  id: string;
  role: "user" | "agent" | "system";
  content: string;
  timestamp: number;
  /** Tool calls attached to this agent message */
  toolCalls?: TUIToolCall[];
  /** Whether the agent is still generating this message */
  isStreaming?: boolean;
}

/** A tool call within an agent message */
export interface TUIToolCall {
  id: string;
  toolName: string;
  /** Abbreviated argument display */
  argsSummary: string;
  status: "running" | "success" | "error";
  /** Duration in seconds */
  duration?: number;
  /** The result content */
  result?: TUIToolResult;
  /** Whether this tool call section is expanded */
  isExpanded: boolean;
}

/** The result of a tool call */
export interface TUIToolResult {
  kind: "text" | "diff" | "bash_output" | "file_content" | "error";
  content: string;
  /** Parsed diff data (when kind === 'diff') */
  diff?: ParsedDiff;
  /** Line count for collapse threshold */
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
  handler: () => void | Promise<void>;
}

/** Agent stream state (managed by useAgentStream) */
export interface AgentStreamState {
  status: "idle" | "thinking" | "streaming" | "tool_running" | "awaiting_approval";
  /** Current streaming text buffer */
  streamBuffer: string;
  /** Current thinking message */
  thinkingMessage: string;
  /** Messages accumulated in current session */
  messages: TUIMessage[];
  /** Token usage stats */
  tokensPerSecond: number;
  totalTokensUsed: number;
  /** Approval request if status === 'awaiting_approval' */
  approvalRequest?: {
    actionId: string;
    toolName: string;
    description: string;
    riskLevel: string;
    diff?: string;
  };
}
```

---

## 5. Component Specifications

### 5.1 App.tsx — Root Component

**Purpose:** Entry point for the ink render tree. Manages alternate screen buffer, global key handlers, and top-level layout.

```typescript
interface AppProps {
  /** Session data from SessionManager */
  session: SessionData;
  /** Config from ConfigManager */
  config: YuanConfig;
  /** Whether to use cloud mode */
  cloudMode: boolean;
  /** Cloud client instance (if cloud mode) */
  cloudClient?: CloudClient;
}
```

**Render Description:**

```
<Box flexDirection="column" height="100%">
  <StatusBar />
  <MessageList />
  <InputBox />
  <FooterBar />
</Box>
```

**Key Behaviors:**

1. On mount: enter alternate screen buffer (`\x1b[?1049h`), hide cursor.
2. On unmount: exit alternate screen buffer (`\x1b[?1049l`), show cursor, print "Session saved" to original buffer.
3. Registers global key handler via `useKeyHandler` for Esc (interrupt), Ctrl+C (exit).
4. Passes `AgentStreamState` down via React context to avoid prop drilling.
5. Handles SIGWINCH via `useTerminalSize` and re-renders layout.

**Responsive Variations:**

- All tiers use the same 4-zone layout; individual components adapt internally.

---

### 5.2 StatusBar.tsx

**Purpose:** Single-line top bar showing session metadata.

```typescript
interface StatusBarProps {
  version: string;
  model: string;
  tokensPerSecond: number;
  connectionStatus: ConnectionStatus;
  /** Only shown in wide tier */
  sessionId?: string;
  elapsedTime?: number;
  iterationCount?: number;
}
```

**Render Description:**

Uses box-drawing characters for a bordered single-line bar. Content is split into segments separated by `│`.

```
Compact:  ╭── YUAN v0.1.3 │ sonnet-4 │ ● connected ──╮
Normal:   ╭── YUAN v0.1.3 │ anthropic/claude-sonnet-4 │ 42.3 tok/s │ ● connected ──╮
Wide:     ╭── YUAN v0.1.3 │ anthropic/claude-sonnet-4 │ 42.3 tok/s │ ● connected │ abc123 │ 2m31s │ iter 3 ──╮
```

**Key Behaviors:**

- `tokensPerSecond` updates live during streaming (debounced to every 500ms).
- `connectionStatus` shows colored dot: green = connected, yellow = connecting, red = error, dim = disconnected.
- Model name is truncated in compact tier (removes provider prefix).

---

### 5.3 MessageList.tsx

**Purpose:** Scrollable container for all conversation messages. Implements virtual scrolling for performance.

```typescript
interface MessageListProps {
  messages: TUIMessage[];
  /** Whether agent is currently generating */
  isAgentActive: boolean;
}
```

**Render Description:**

Vertical list of `MessageBubble` components. New messages auto-scroll to bottom. Manual scroll via PageUp/PageDown disengages auto-scroll until user scrolls back to bottom.

**Key Behaviors:**

1. **Virtual scroll:** Only renders messages visible in the viewport plus a 5-message buffer above and below. This prevents performance degradation with long conversations.
2. **Auto-scroll:** When a new message arrives or streaming content updates, scrolls to bottom — unless the user has manually scrolled up.
3. **Scroll indicator:** Shows `↑ 23 more` at top if scrolled down, `↓ 5 more` at bottom if scrolled up.
4. **Empty state:** Shows `"Type a message to start..."` centered and dimmed.

**Responsive Variations:**

- Compact: messages use full width minus 2 (border padding).
- Normal/Wide: messages are indented 2 chars from each edge.

---

### 5.4 MessageBubble.tsx

**Purpose:** Renders a single message with appropriate styling based on role.

```typescript
interface MessageBubbleProps {
  message: TUIMessage;
  /** Terminal width for wrapping */
  width: number;
  /** Whether this is the most recent message (may be streaming) */
  isLatest: boolean;
}
```

**Render Description:**

**User message:**
```
● you
Fix the auth middleware to handle expired tokens gracefully
```
- `●` prefix in white/default, bold.
- `you` label in white/default, bold.
- Content in default color, word-wrapped to terminal width.

**Agent message:**
```
✻ yuan
I'll fix the auth middleware. Let me first read the current implementation.
```
- `✻` prefix in cyan. During streaming, this character animates (see Spinner).
- `yuan` label in cyan, bold.
- Content in default color, with markdown rendering (bold, inline code, headers, code blocks).
- If `isStreaming`, shows cursor block `█` at end of current text.
- Tool calls render as `ToolCallTree` below the text content.

**System message:**
```
ℹ Session restored from abc12345
```
- `ℹ` prefix in blue.
- Content in dim.

**Key Behaviors:**

1. Markdown is rendered inline using `MarkdownRenderer`.
2. Code blocks use bordered boxes with language labels.
3. Content is word-wrapped respecting ANSI escape sequences (via `wrap-ansi`).

---

### 5.5 ToolCallTree.tsx

**Purpose:** Displays tool calls in a tree structure with expand/collapse, status indicators, and nested results.

```typescript
interface ToolCallTreeProps {
  toolCalls: TUIToolCall[];
  /** Terminal width for content sizing */
  width: number;
}
```

**Render Description:**

```
├─ Read  src/middleware/auth.ts                                    ✓ 0.2s
├─ Read  src/utils/token.ts                                       ✓ 0.1s
╰─ Reading 2 files...                              (ctrl+o to expand)
```

When expanded:
```
├─ Read  src/middleware/auth.ts                                    ✓ 0.2s
│  ╭─ src/middleware/auth.ts ──────────────────────────────────────────╮
│  │   1 │ import { verify } from '../utils/token';                   │
│  │   2 │ import { AuthError } from '../errors';                     │
│  │   3 │                                                            │
│  │   4 │ export async function authMiddleware(req, res, next) {     │
│  │  ...│ (42 more lines)                                            │
│  ╰──────────────────────────────────────────────────────────────────╯
├─ Read  src/utils/token.ts                                       ✓ 0.1s
│  ╭─ src/utils/token.ts ─────────────────────────────────────────────╮
│  │  ...                                                             │
│  ╰──────────────────────────────────────────────────────────────────╯
╰─ (2 files read)
```

**Tree characters:**

- `├─` for non-last items
- `╰─` for last item
- `│` for continuation lines under a non-last item

**Status indicators:**

- Running: spinner animation (braille dots) in cyan
- Success: `✓` in green
- Error: `✗` in red

**Key Behaviors:**

1. When multiple sequential Read calls occur, they are grouped: `"Reading N files... (ctrl+o to expand)"`.
2. Tool results with > 10 lines are auto-collapsed. User can toggle with Ctrl+O.
3. Diff results use `DiffView` instead of plain text.
4. Bash results use `BashOutput` with a bordered output box.
5. Duration is right-aligned to the terminal edge.

**Responsive Variations:**

- Compact: file paths are truncated to basename only. Duration omitted if width < 60.
- Normal: file paths relative to project root.
- Wide: full paths shown.

---

### 5.6 DiffView.tsx

**Purpose:** Renders inline diffs with red/green highlighting and line numbers.

```typescript
interface DiffViewProps {
  diff: ParsedDiff;
  /** Terminal width for box sizing */
  width: number;
  /** Whether to show side-by-side (only in wide tier >= 140) */
  sideBySide?: boolean;
}
```

**Render Description (unified, default):**

```
╭──────────────────────────────────────────────────────────────╮
│  23  │ -  if (!token) throw new AuthError('missing');        │
│  23  │ +  if (!token) {                                     │
│  24  │ +    throw new AuthError('missing', 401);            │
│  25  │ +  }                                                 │
│  26  │ -  const decoded = verify(token);                    │
│  26  │ +  const decoded = verifyWithExpiry(token);          │
╰──────────────────────────────────────────────────────────────╯
```

**Coloring:**

- Deletion lines: red foreground, dim red background (`\x1b[31m` text, `\x1b[48;5;52m` background).
- Addition lines: green foreground, dim green background (`\x1b[32m` text, `\x1b[48;5;22m` background).
- Context lines: dim foreground, no background.
- Line numbers: dim, right-aligned in a 4-char column.
- `+` / `-` prefix: bold, in respective color.

**Key Behaviors:**

1. Shows hunk headers (`@@ -23,4 +23,5 @@`) in cyan between non-contiguous hunks.
2. Context lines are shown (3 lines before/after changes, matching git defaults).
3. Stats summary at bottom: `+3 -2` in green/red.
4. If diff exceeds 30 lines, auto-collapses with `"N changes (ctrl+o to expand)"`.

**Responsive Variations:**

- Compact (< 80): reduces line number column to 3 chars, truncates long lines with `...`.
- Normal (80-119): standard unified view.
- Wide (>= 140): optional side-by-side mode with old file on left, new file on right.

---

### 5.7 CollapsibleSection.tsx

**Purpose:** Generic wrapper that can expand/collapse its children. Used by ToolCallTree for file reads, diff views, and bash output.

```typescript
interface CollapsibleSectionProps {
  /** Whether currently expanded */
  isExpanded: boolean;
  /** Callback when expand/collapse is toggled */
  onToggle: () => void;
  /** Summary text shown when collapsed */
  collapsedSummary: string;
  /** Hint text for how to expand */
  expandHint?: string;  // default: "(ctrl+o to expand)"
  /** Content to show when expanded */
  children: React.ReactNode;
}
```

**Render Description:**

Collapsed:
```
Reading 2 files...                              (ctrl+o to expand)
```

Expanded:
```
Reading 2 files...                              (ctrl+o to collapse)
  [children rendered here]
```

**Key Behaviors:**

1. The `expandHint` text is right-aligned and rendered in dim.
2. Toggling is handled by the parent's Ctrl+O key handler, which finds the focused/nearest collapsible section and toggles it.
3. When multiple collapsible sections exist, Ctrl+O cycles through them in order. Pressing Ctrl+O when all are expanded collapses all.

---

### 5.8 BashOutput.tsx

**Purpose:** Renders shell command output in a bordered box.

```typescript
interface BashOutputProps {
  /** The command that was executed */
  command: string;
  /** The output text */
  output: string;
  /** Exit code */
  exitCode?: number;
  /** Terminal width for box sizing */
  width: number;
}
```

**Render Description:**

```
╭─ output ──────────────────────────────────────╮
│  PASS  src/__tests__/auth.test.ts             │
│    ✓ handles expired tokens (23ms)            │
│    ✓ handles missing tokens (4ms)             │
│  Tests: 2 passed, 2 total                     │
╰───────────────────────────────────────────────╯
```

**Key Behaviors:**

1. Output > 20 lines is truncated with `"... (N more lines)"` and wrapped in `CollapsibleSection`.
2. Exit code 0 shows green header; non-zero shows red header with exit code.
3. Content is syntax-highlighted for common patterns: `PASS`/`FAIL`, file paths, error messages.

---

### 5.9 InputBox.tsx

**Purpose:** Fixed-position input area at bottom of screen. Supports multiline editing, history navigation, and slash command triggering.

```typescript
interface InputBoxProps {
  /** Called when user submits input */
  onSubmit: (text: string) => void;
  /** Whether input is disabled (agent is running) */
  disabled: boolean;
  /** Slash commands for autocomplete */
  slashCommands: SlashCommand[];
  /** Input history from useInputHistory */
  history: string[];
}
```

**Render Description:**

Single-line mode (default):
```
╭─────────────────────────────────────────────────────────────────╮
│ >  Fix the auth middleware_                                      │
╰─────────────────────────────────────────────────────────────────╯
```

Multiline mode (after Shift+Enter):
```
╭─────────────────────────────────────────────────────────────────╮
│ >  Fix the following files:                                      │
│ .  - src/auth.ts                                                 │
│ .  - src/token.ts_                                               │
╰─────────────────────────────────────────────────────────────────╯
```

Disabled state (agent running):
```
╭─────────────────────────────────────────────────────────────────╮
│    waiting for agent...                                          │
╰─────────────────────────────────────────────────────────────────╯
```

**Key Behaviors:**

1. `>` prompt in bright green for first line. `.` continuation indicator for subsequent lines.
2. `Enter` sends the message. `Shift+Enter` inserts a newline.
3. `Up Arrow` on empty input cycles through history. `Down Arrow` cycles forward.
4. When input starts with `/`, opens `SlashMenu` dropdown above the input box.
5. When `disabled`, input field is grayed out and shows "waiting for agent...".
6. Input box expands vertically (up to 10 lines) as content grows, shrinking the message area.
7. Cursor blinking is handled natively by the terminal.

**Responsive Variations:**

- All tiers: input spans full width minus 2 (border chars). Behavior is identical.

---

### 5.10 SlashMenu.tsx

**Purpose:** Autocomplete dropdown that appears above InputBox when user types `/`.

```typescript
interface SlashMenuProps {
  /** Filtered list of matching commands */
  commands: SlashCommand[];
  /** Currently highlighted index */
  selectedIndex: number;
  /** Callback when a command is selected */
  onSelect: (command: SlashCommand) => void;
  /** Callback when menu is dismissed */
  onDismiss: () => void;
}
```

**Render Description:**

```
  ╭───────────────────────────────────────╮
  │  /help      — show available commands │
  │▸ /config    — show/edit configuration │
  │  /clear     — clear conversation      │
  │  /compact   — toggle compact view     │
  ╰───────────────────────────────────────╯
╭─────────────────────────────────────────────────╮
│ >  /con_                                         │
╰─────────────────────────────────────────────────╯
```

**Key Behaviors:**

1. Appears when user types `/` on an empty input or at the start of input.
2. Filters commands as user types (fuzzy match on command name).
3. `Up`/`Down` arrows navigate the list. `Enter` selects. `Esc` dismisses.
4. Selected item has `▸` prefix and is highlighted (inverse colors).
5. Menu renders above the input box, overlaying the message area.
6. Maximum 8 items visible; scrolls if more match.

---

### 5.11 FooterBar.tsx

**Purpose:** Single-line bar at the very bottom showing context-sensitive keybind hints.

```typescript
interface FooterBarProps {
  /** Current agent state to determine which hints to show */
  agentStatus: AgentStreamState["status"];
  /** Whether any collapsible section exists */
  hasCollapsible: boolean;
}
```

**Render Description:**

Idle state:
```
  /help for commands  │  ctrl+c to exit
```

Agent running:
```
  esc to interrupt  │  /help for commands  │  ctrl+c to exit
```

Collapsible present:
```
  esc to interrupt  │  ctrl+o to expand  │  ctrl+c to exit
```

**Key Behaviors:**

1. Content is centered within the terminal width.
2. Hints are separated by `│` with spacing.
3. Hint keys are rendered in bold, descriptions in dim.
4. Adapts dynamically based on agent status and UI state.

**Responsive Variations:**

- Compact: shows abbreviated hints (`esc │ /help │ ctrl+c`).
- Normal/Wide: full descriptions.

---

### 5.12 Spinner.tsx

**Purpose:** Animated braille spinner for tool call progress and agent thinking.

```typescript
interface SpinnerProps {
  /** Whether the spinner is active */
  active: boolean;
  /** Optional label next to spinner */
  label?: string;
  /** Color of the spinner character */
  color?: string; // default: cyan
}
```

**Render Description:**

```
⠋ thinking...
⠙ thinking...
⠹ thinking...
```

The braille frames cycle: `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`

**Key Behaviors:**

1. Frame changes every 80ms.
2. When `active` becomes false, spinner unmounts (no final frame shown).
3. Uses `useEffect` with `setInterval` for animation.

---

### 5.13 ThinkingDots.tsx

**Purpose:** Subtle "..." indicator in the bottom-right corner of the message area while the agent is thinking.

```typescript
interface ThinkingDotsProps {
  /** Whether to show the dots */
  active: boolean;
}
```

**Render Description:**

Cycles through: `.` `..` `...` `..` `.` (ping-pong pattern).

Positioned at the absolute bottom-right of the message area, overlaying content.

**Key Behaviors:**

1. Animation interval: 150ms per frame.
2. Uses absolute positioning via ANSI cursor movement (not ink layout) for precise bottom-right placement.
3. When inactive, the area is cleared.

---

### 5.14 MarkdownRenderer.tsx

**Purpose:** Converts markdown text to styled terminal output within an ink component.

```typescript
interface MarkdownRendererProps {
  /** Raw markdown text */
  text: string;
  /** Available width for wrapping */
  width: number;
}
```

**Render Description:**

Handles the following markdown elements:

| Element | Rendering |
|---------|-----------|
| `# Heading 1` | Cyan, bold |
| `## Heading 2` | Cyan, bold |
| `### Heading 3` | White, bold |
| `**bold**` | Bold |
| `` `inline code` `` | Yellow background (dim), monospace |
| ` ```lang ... ``` ` | Bordered box with language label, green text |
| `- list item` | Indented with `•` prefix |
| `1. ordered` | Indented with number prefix |
| `> blockquote` | Dim, with `│` prefix |
| `---` | Horizontal rule (dim `─` chars) |
| `[text](url)` | Underlined text, dim URL in parentheses |

**Key Behaviors:**

1. Code blocks are word-wrapped within their bordered boxes.
2. All text is word-wrapped to the available width using `wrap-ansi`.
3. Nested lists are supported up to 3 levels with increased indentation.

---

## 6. Hook Specifications

### 6.1 useTerminalSize.ts

```typescript
interface UseTerminalSizeReturn {
  width: number;
  height: number;
  tier: LayoutTier;
}

function useTerminalSize(): UseTerminalSizeReturn;
```

**Behavior:**

1. Reads initial size from `process.stdout.columns` and `process.stdout.rows`.
2. Listens to `SIGWINCH` signal for resize events.
3. Computes tier: `width < 80` = compact, `80 <= width < 120` = normal, `width >= 120` = wide.
4. Debounces resize events by 50ms to avoid excessive re-renders.
5. Returns reactive values that trigger re-render on change.

---

### 6.2 useInputHistory.ts

```typescript
interface UseInputHistoryReturn {
  /** All history entries (most recent last) */
  entries: string[];
  /** Navigate up (older). Returns the entry or undefined if at top. */
  navigateUp: () => string | undefined;
  /** Navigate down (newer). Returns the entry or empty string if at bottom. */
  navigateDown: () => string | undefined;
  /** Add a new entry to history */
  push: (entry: string) => void;
  /** Reset navigation position to bottom */
  resetPosition: () => void;
}

function useInputHistory(maxEntries?: number): UseInputHistoryReturn;
```

**Behavior:**

1. Stores up to `maxEntries` (default: 100) entries in memory.
2. Navigation works like bash: Up goes to older entries, Down goes to newer.
3. When at the newest position, Down returns empty string (clears input).
4. Duplicate consecutive entries are not stored.
5. History persists for the session duration only (not saved to disk).

---

### 6.3 useKeyHandler.ts

```typescript
interface UseKeyHandlerConfig {
  onEscape: () => void;           // Interrupt agent
  onCtrlO: () => void;            // Toggle collapsible
  onCtrlC: () => void;            // Exit
  onPageUp: () => void;           // Scroll up
  onPageDown: () => void;         // Scroll down
}

function useKeyHandler(config: UseKeyHandlerConfig): void;
```

**Behavior:**

1. Sets `process.stdin` to raw mode to capture individual keystrokes.
2. Parses ANSI escape sequences for special keys (arrows, page up/down, function keys).
3. Routes key events to the appropriate handler based on context (input focused vs. not).
4. Does not intercept keys when the input box has focus — those are handled by `InputBox` directly.
5. Cleans up raw mode on unmount.

---

### 6.4 useAgentStream.ts

```typescript
interface UseAgentStreamConfig {
  /** Whether using cloud mode */
  cloudMode: boolean;
  /** Cloud client instance (if cloud mode) */
  cloudClient?: CloudClient;
  /** Session data */
  session: SessionData;
  /** Config */
  config: YuanConfig;
}

interface UseAgentStreamReturn {
  /** Current state */
  state: AgentStreamState;
  /** Send a message to the agent */
  sendMessage: (text: string) => Promise<void>;
  /** Interrupt the current agent execution */
  interrupt: () => void;
  /** Handle approval response */
  respondToApproval: (approved: boolean, alwaysApprove?: boolean) => void;
  /** Clear conversation */
  clearMessages: () => void;
}

function useAgentStream(config: UseAgentStreamConfig): UseAgentStreamReturn;
```

**Behavior:**

1. Bridges between `AgentLoop` / `CloudClient` events and React state.
2. On `sendMessage`:
   - Sets status to `"thinking"`.
   - Creates `AgentLoop` (local) or starts cloud session.
   - Subscribes to events and updates state reactively.
3. Event mapping:
   - `agent:thinking` -> updates `thinkingMessage`, status stays `"thinking"`.
   - `agent:text_delta` -> appends to `streamBuffer`, status = `"streaming"`.
   - `agent:tool_call` -> adds to current message's `toolCalls`, status = `"tool_running"`.
   - `agent:tool_result` -> updates tool call result, keeps status.
   - `agent:approval_needed` -> sets `approvalRequest`, status = `"awaiting_approval"`.
   - `agent:completed` -> finalizes message, status = `"idle"`.
   - `agent:error` -> adds error message, status = `"idle"`.
4. On `interrupt`:
   - Aborts the `AgentLoop` or cloud session.
   - Sets status to `"idle"`.
   - Adds system message: "Agent interrupted."
5. Token usage events update `tokensPerSecond` (rolling average over 3s window).

---

### 6.5 useScrollPosition.ts

```typescript
interface UseScrollPositionReturn {
  /** Current scroll offset (0 = top) */
  offset: number;
  /** Whether auto-scroll is active (user hasn't scrolled up) */
  isAutoScroll: boolean;
  /** Scroll up by N lines */
  scrollUp: (lines?: number) => void;
  /** Scroll down by N lines */
  scrollDown: (lines?: number) => void;
  /** Scroll to bottom and re-enable auto-scroll */
  scrollToBottom: () => void;
  /** Total scrollable height */
  totalHeight: number;
  /** Set total height (called by MessageList on content change) */
  setTotalHeight: (height: number) => void;
}

function useScrollPosition(viewportHeight: number): UseScrollPositionReturn;
```

**Behavior:**

1. PageUp/PageDown scroll by `viewportHeight - 2` lines (overlap for context).
2. When `isAutoScroll` is true, new content automatically scrolls to bottom.
3. Scrolling up disables auto-scroll. Scrolling to exact bottom re-enables it.
4. Offset is clamped to `[0, totalHeight - viewportHeight]`.

---

### 6.6 useSlashCommands.ts

```typescript
interface UseSlashCommandsReturn {
  /** All registered commands */
  commands: SlashCommand[];
  /** Filter commands by partial input */
  filter: (input: string) => SlashCommand[];
  /** Execute a command by name */
  execute: (name: string) => void | Promise<void>;
}

function useSlashCommands(handlers: {
  onClear: () => void;
  onExit: () => void;
  onConfig: () => void;
  onModel: () => void;
  onMode: () => void;
  onCompact: () => void;
}): UseSlashCommandsReturn;
```

**Behavior:**

1. Registers all slash commands with their handlers.
2. `filter` performs prefix matching on command name (e.g., `/con` matches `/config`).
3. Unknown commands show an error message.

---

## 7. Library Specifications

### 7.1 lib/ansi.ts

Extracted from the existing `renderer.ts` colors and ANSI helpers.

```typescript
/** ANSI color/style escape sequences */
export const ansi = {
  // Styles
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  inverse: "\x1b[7m",

  // Foreground
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  brightGreen: "\x1b[92m",

  // Background
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgDimRed: "\x1b[48;5;52m",
  bgDimGreen: "\x1b[48;5;22m",

  // Cursor & screen
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  clearLine: "\x1b[2K\r",
  clearScreen: "\x1b[2J\x1b[H",
  enterAltScreen: "\x1b[?1049h",
  exitAltScreen: "\x1b[?1049l",
} as const;

/** Apply color/style to text */
export function styled(style: string, text: string): string;

/** Move cursor to position */
export function cursorTo(row: number, col: number): string;

/** Move cursor up N lines */
export function cursorUp(n: number): string;

/** Save/restore cursor position */
export function saveCursor(): string;
export function restoreCursor(): string;
```

---

### 7.2 lib/box-drawing.ts

```typescript
/** Box drawing character sets */
export const box = {
  rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  sharp:   { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  double:  { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
} as const;

/** Tree connector characters */
export const tree = {
  branch: "├─",
  last: "╰─",
  pipe: "│",
  blank: "  ",
} as const;

/** Render a horizontal box line */
export function boxLine(
  width: number,
  position: "top" | "bottom" | "separator",
  style?: keyof typeof box,
  label?: string,
): string;

/** Render a content line with vertical borders */
export function boxContent(
  text: string,
  width: number,
  style?: keyof typeof box,
  align?: "left" | "center" | "right",
): string;

/** Render a complete box around content lines */
export function renderBox(
  lines: string[],
  width: number,
  options?: {
    style?: keyof typeof box;
    title?: string;
    padding?: number;
  },
): string[];
```

---

### 7.3 lib/diff-formatter.ts

```typescript
/**
 * Parse a unified diff string into structured data.
 * Handles both `git diff` output and simple unified diff format.
 */
export function parseDiff(diffText: string): ParsedDiff[];

/**
 * Format a ParsedDiff into colored terminal strings.
 * Returns an array of lines ready for display.
 */
export function formatDiff(
  diff: ParsedDiff,
  options: {
    width: number;
    useBackground?: boolean;  // use bg colors for add/delete
    contextLines?: number;    // default: 3
    sideBySide?: boolean;     // side-by-side mode
  },
): string[];

/**
 * Generate a compact diff summary string.
 * E.g., "src/auth.ts +3 -2"
 */
export function diffSummary(diff: ParsedDiff): string;
```

---

### 7.4 lib/layout.ts

```typescript
import type { LayoutTier, TerminalDimensions } from "../types.js";

/** Determine layout tier from terminal width */
export function getTier(width: number): LayoutTier;

/** Calculate available content width (accounting for borders, padding) */
export function contentWidth(termWidth: number, indent?: number): number;

/** Calculate zone heights */
export function zoneHeights(termHeight: number): {
  statusBar: number;   // always 1
  messageArea: number; // dynamic
  inputBox: number;    // 2-10
  footerBar: number;   // always 1
};
```

---

### 7.5 lib/screen-buffer.ts

```typescript
/**
 * Enter alternate screen buffer.
 * Saves the current screen content and clears for full-screen TUI.
 */
export function enterAltScreen(): void;

/**
 * Exit alternate screen buffer.
 * Restores the previous screen content.
 */
export function exitAltScreen(): void;

/**
 * Setup exit handlers to ensure alt screen is exited on:
 * - process.exit
 * - SIGINT
 * - SIGTERM
 * - uncaughtException
 */
export function setupExitHandlers(): void;
```

---

### 7.6 lib/truncate.ts

```typescript
/**
 * Truncate a string to fit within maxWidth, accounting for
 * Unicode character widths (CJK, emoji) and ANSI escape sequences.
 * Appends "..." if truncated.
 */
export function truncate(text: string, maxWidth: number): string;

/**
 * Truncate a file path intelligently:
 * "/very/long/path/to/src/middleware/auth.ts" -> ".../src/middleware/auth.ts"
 */
export function truncatePath(filePath: string, maxWidth: number): string;
```

---

## 8. Streaming Strategy

### Short Responses (< 200 characters)

- **Rendering:** Character-by-character as tokens arrive from the LLM.
- **Cursor:** Block cursor `█` shown at the insertion point, replaced by each new character.
- **Latency:** No artificial buffering. Tokens written immediately via `process.stdout.write`.
- **Scroll:** MessageList stays at bottom (auto-scroll).

### Long Responses (>= 200 characters)

- **Rendering:** Buffer incoming tokens and flush to screen every 100ms.
- **Reason:** Prevents excessive re-renders in ink which can cause flickering on fast streams.
- **Smooth scroll:** Each flush appends new content and scrolls smoothly to bottom.
- **Line wrapping:** Deferred — only recomputed on flush (not per-character).

### Tool Results

- **Rendering:** Appear instantly as a complete block (non-streaming).
- **Auto-collapse:** Results exceeding 10 lines are collapsed by default.
- **Animation:** Tool status shows spinner while running, then snaps to `✓`/`✗` on completion.

### Thinking State

- **Spinner:** Braille dots (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) animate next to `✻ yuan` at 80ms interval.
- **Corner dots:** `...` animate at bottom-right of message area at 150ms (ping-pong: `.` `..` `...` `..` `.`).
- **Thinking text:** The thinking/reasoning text from the model (if exposed) is shown dimmed below the spinner: `⠹ analyzing the middleware pattern...`.

### Performance Targets

| Metric | Target |
|--------|--------|
| Time to first token displayed | < 50ms after receipt |
| Render latency (short response) | < 16ms per frame |
| Render latency (long response) | < 100ms per flush |
| Scroll smoothness | 60fps equivalent (no visible jank) |
| Memory (1000-message conversation) | < 50MB |

---

## 9. Key Interactions

| Key | Context | Action |
|-----|---------|--------|
| `Enter` | Input (single-line) | Send message |
| `Shift+Enter` | Input | Insert newline (multiline mode) |
| `Esc` | Agent running | Interrupt/cancel agent execution |
| `Esc` | Slash menu open | Dismiss slash menu |
| `Up Arrow` | Input (empty) | Navigate to previous history entry |
| `Down Arrow` | Input (history mode) | Navigate to next history entry |
| `Up/Down Arrow` | Slash menu open | Navigate menu items |
| `/` | Input (empty or start) | Open slash command autocomplete |
| `Ctrl+O` | Any (collapsible present) | Toggle expand/collapse nearest section |
| `Ctrl+C` | Any | Exit YUAN (with confirmation if agent running) |
| `PageUp` | Message area | Scroll up by viewport height |
| `PageDown` | Message area | Scroll down by viewport height |
| `Ctrl+L` | Any | Clear screen and re-render |
| `Tab` | Slash menu | Accept selected completion |
| `Ctrl+A` | Input | Move cursor to start of line |
| `Ctrl+E` | Input | Move cursor to end of line |
| `Ctrl+U` | Input | Clear current input |
| `Ctrl+W` | Input | Delete word before cursor |

### Ctrl+C Behavior Detail

1. **Agent idle:** Exit immediately with cleanup (exit alt screen, show cursor, print farewell).
2. **Agent running:** First press interrupts the agent (sends abort signal). Second press within 1 second exits.
3. **Approval prompt active:** Cancel approval (reject), return to idle.

---

## 10. Slash Commands

```typescript
const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "/help",
    description: "Show available commands and keybindings",
    aliases: ["/h", "/?"],
    handler: () => { /* render help overlay */ },
  },
  {
    name: "/clear",
    description: "Clear conversation history",
    aliases: ["/cls"],
    handler: () => { /* clear messages, re-render */ },
  },
  {
    name: "/config",
    description: "Show or edit configuration",
    aliases: ["/cfg"],
    handler: () => { /* show config panel */ },
  },
  {
    name: "/model",
    description: "Switch LLM model",
    aliases: ["/m"],
    handler: () => { /* show model picker */ },
  },
  {
    name: "/mode",
    description: "Switch agent mode (code/review/debug)",
    aliases: [],
    handler: () => { /* cycle modes */ },
  },
  {
    name: "/compact",
    description: "Toggle compact display mode",
    aliases: [],
    handler: () => { /* toggle compact flag */ },
  },
  {
    name: "/diff",
    description: "Show current working directory changes",
    aliases: ["/d"],
    handler: () => { /* run git diff, render in DiffView */ },
  },
  {
    name: "/undo",
    description: "Undo the last file change",
    aliases: ["/u"],
    handler: () => { /* git checkout last changed file */ },
  },
  {
    name: "/session",
    description: "Show session info (ID, tokens, files changed)",
    aliases: ["/s"],
    handler: () => { /* render session panel */ },
  },
  {
    name: "/exit",
    description: "Exit YUAN",
    aliases: ["/quit", "/q"],
    handler: () => { /* cleanup and exit */ },
  },
];
```

---

## 11. Color Palette & Theme

All colors use standard ANSI 16-color codes for maximum terminal compatibility, with optional 256-color enhancements for terminals that support them.

### Base Colors

| Element | Foreground | Background | Style |
|---------|-----------|------------|-------|
| Default text | Terminal default | Terminal default | Normal |
| User message prefix (`● you`) | White (#FFFFFF) | - | Bold |
| User message content | Terminal default | - | Normal |
| Agent message prefix (`✻ yuan`) | Cyan (#00D7FF) | - | Bold |
| Agent message content | Terminal default | - | Normal |
| System message | Blue (#5F87FF) | - | Normal |
| Error text | Red (#FF5F5F) | - | Normal |
| Warning text | Yellow (#FFAF00) | - | Normal |
| Success indicator (`✓`) | Green (#5FFF5F) | - | Bold |
| Error indicator (`✗`) | Red (#FF5F5F) | - | Bold |
| Dim/secondary text | Gray (#808080) | - | Dim |

### Diff Colors

| Element | Foreground | Background |
|---------|-----------|------------|
| Addition line | Green (#5FFF5F) | Dim green (256: color 22) |
| Deletion line | Red (#FF5F5F) | Dim red (256: color 52) |
| Addition `+` prefix | Green | - |
| Deletion `-` prefix | Red | - |
| Context line | Dim gray | - |
| Hunk header (`@@`) | Cyan | - |
| Line numbers | Dim gray | - |

### UI Chrome

| Element | Foreground | Background | Style |
|---------|-----------|------------|-------|
| Status bar text | Black | White | Inverse |
| Status bar (alt) | Dim white | - | Dim |
| Box borders (`╭─╮│╰─╯`) | Dim gray | - | - |
| Tree connectors (`├─ ╰─ │`) | Dim gray | - | - |
| Input prompt (`>`) | Bright green | - | Bold |
| Spinner (braille) | Cyan | - | - |
| Thinking dots (`...`) | Dim gray | - | - |
| Footer hints (keys) | White | - | Bold |
| Footer hints (descriptions) | Dim gray | - | Dim |
| Slash menu selected | Terminal default | Inverse | Inverse |
| Slash menu unselected | Dim gray | - | - |
| Code block text | Green | - | - |
| Code block border | Dim gray | - | - |
| Inline code | Yellow | - | - |

### YSpinner Integration

The existing `YSpinner` in `y-spinner.ts` uses 256-color for the glowing Y effect. In the TUI, this is used for the initial loading screen and can be optionally shown during long operations. The standard braille spinner is used for inline tool call progress.

---

## 12. Dependencies

### New Dependencies (to add to `package.json`)

```json
{
  "dependencies": {
    "ink": "^5.1.0",
    "ink-text-input": "^6.0.0",
    "react": "^18.3.0",
    "chalk": "^5.4.0",
    "cli-cursor": "^5.0.0",
    "ansi-escapes": "^7.0.0",
    "string-width": "^7.0.0",
    "wrap-ansi": "^9.0.0",
    "strip-ansi": "^7.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0"
  }
}
```

### Dependency Justification

| Package | Purpose | Size | Alternative Considered |
|---------|---------|------|----------------------|
| `ink` v5 | React component model for terminal rendering | ~50KB | `blessed` (too heavy, unmaintained), raw ANSI (too low-level for layout) |
| `react` 18 | Required by ink | ~130KB | Included by ink peer dependency |
| `ink-text-input` | Text input component with cursor management | ~5KB | Custom implementation (complex cursor handling) |
| `chalk` v5 | Color output (ESM, tree-shakeable) | ~15KB | Raw ANSI (less readable code) |
| `cli-cursor` | Show/hide terminal cursor | ~2KB | Raw ANSI (cross-platform issues) |
| `ansi-escapes` | Screen buffer control, cursor positioning | ~5KB | Raw ANSI (missing some terminal-specific codes) |
| `string-width` | Unicode-aware string width (CJK, emoji) | ~5KB | None — essential for correct layout |
| `wrap-ansi` | Word wrap preserving ANSI codes | ~8KB | Manual implementation (error-prone with escape sequences) |
| `strip-ansi` | Remove ANSI codes for width calculation | ~3KB | Regex (fragile) |

### Existing Dependencies (kept)

- `commander` — CLI argument parsing (entry point)
- `@yuaone/core` — Agent loop, events, types
- `@yuaone/tools` — Tool registry and execution

---

## 13. Migration Plan

### Phase 1: Core Shell (Week 1)

**Goal:** Alternate screen works, basic 4-zone layout renders, input accepts text.

**Files to create:**
- `tui/App.tsx`
- `tui/components/StatusBar.tsx`
- `tui/components/InputBox.tsx`
- `tui/components/FooterBar.tsx`
- `tui/lib/ansi.ts`
- `tui/lib/screen-buffer.ts`
- `tui/lib/layout.ts`
- `tui/lib/box-drawing.ts`
- `tui/hooks/useTerminalSize.ts`
- `tui/types.ts`

**Files to modify:**
- `cli.ts` — add `--tui` flag, route to new TUI for interactive mode
- `package.json` — add new dependencies (ink, react, etc.)
- `tsconfig.json` — add `"jsx": "react-jsx"` for TSX support

**Verification:**
- `yuan --tui` enters alt screen, shows status bar, input box, footer, exits cleanly on Ctrl+C.
- Resize terminal -> layout adapts.

### Phase 2: Message Display (Week 2)

**Goal:** Messages render with correct styling, markdown works, scrolling works.

**Files to create:**
- `tui/components/MessageList.tsx`
- `tui/components/MessageBubble.tsx`
- `tui/components/Spinner.tsx`
- `tui/components/ThinkingDots.tsx`
- `tui/components/MarkdownRenderer.tsx`
- `tui/hooks/useScrollPosition.ts`
- `tui/hooks/useInputHistory.ts`

**Verification:**
- Type a message, see it rendered as user message.
- Mock agent responses render with correct styling.
- PageUp/PageDown scroll works.
- Arrow up/down history works.

### Phase 3: Tool Calls & Rich Content (Week 3)

**Goal:** Tool calls display in tree format, diffs render inline, bash output shows in boxes.

**Files to create:**
- `tui/components/ToolCallTree.tsx`
- `tui/components/DiffView.tsx`
- `tui/components/CollapsibleSection.tsx`
- `tui/components/BashOutput.tsx`
- `tui/lib/diff-formatter.ts`
- `tui/lib/truncate.ts`
- `tui/hooks/useKeyHandler.ts`

**Verification:**
- Tool calls show with tree connectors and status indicators.
- Diffs render with red/green highlighting.
- Ctrl+O expands/collapses sections.
- Bash output shows in bordered boxes.

### Phase 4: Slash Commands & Polish (Week 4)

**Goal:** Slash menu autocomplete, all slash commands functional, responsive polish.

**Files to create:**
- `tui/components/SlashMenu.tsx`
- `tui/hooks/useSlashCommands.ts`

**Files to modify:**
- All components — responsive variations for compact/normal/wide.
- `InputBox.tsx` — multiline support.

**Verification:**
- `/` opens autocomplete menu.
- All slash commands work (`/help`, `/clear`, `/config`, `/model`, `/diff`, `/undo`, `/session`, `/exit`).
- Compact layout works at 60 columns.
- Wide layout uses extra space at 140+ columns.

### Phase 5: Streaming Integration (Week 5)

**Goal:** Full integration with `@yuaone/core` AgentLoop and CloudClient.

**Files to create:**
- `tui/hooks/useAgentStream.ts`

**Files to modify:**
- `App.tsx` — wire `useAgentStream` to MessageList and StatusBar.
- `interactive.ts` — deprecate, add redirect to TUI.

**Verification:**
- Send a real message, agent responds with streaming text.
- Tool calls appear live as agent executes them.
- Approval prompts work.
- Esc interrupts agent.
- Cloud mode works identically to local mode.
- Token usage updates in status bar.

### Phase 6: Default Rollout

**Goal:** TUI becomes the default interactive mode.

**Files to modify:**
- `cli.ts` — make TUI the default for `yuan` (no arguments). Add `--classic` flag for old readline mode.
- `interactive.ts` — keep as fallback, rename to `classic-interactive.ts`.

---

## 14. Non-Goals (Explicit Exclusions)

The following are explicitly out of scope for this redesign:

1. **Mouse support** — No mouse click handling. Terminal mouse events are unreliable across terminals.
2. **Image rendering** — No inline image display (e.g., sixel, iTerm2 inline images).
3. **Split panes** — No side-by-side editor/terminal split. Keep single-column layout.
4. **File tree browser** — No filesystem navigation UI. Use tool calls for file operations.
5. **Syntax highlighting** — Code blocks use single-color (green). Full syntax highlighting is deferred to a future enhancement.
6. **Persistent history** — Input history is session-only. Persistent history file (`.yuan_history`) is a future enhancement.
7. **Themes/customization** — Single color scheme. User-configurable themes are a future enhancement.
8. **Windows Terminal compatibility** — Primary targets are macOS Terminal/iTerm2, Linux terminal emulators, and WSL. Native Windows cmd.exe is not targeted.

---

## 15. Testing Strategy

### Unit Tests

- `lib/diff-formatter.ts` — parse various diff formats, verify structured output.
- `lib/box-drawing.ts` — render boxes at various widths, verify character alignment.
- `lib/layout.ts` — tier calculation at boundary widths (79, 80, 119, 120).
- `lib/truncate.ts` — Unicode, CJK, emoji, ANSI-aware truncation.
- `hooks/useInputHistory.ts` — navigation, dedup, boundary conditions.

### Integration Tests

- Render `App` with mock `useAgentStream` -> verify layout zones are correct.
- Send mock events through `useAgentStream` -> verify message rendering.
- Simulate key events -> verify handlers fire correctly.

### Manual Test Matrix

| Scenario | Terminal | Verification |
|----------|----------|--------------|
| Basic conversation | macOS Terminal | Messages render, input works |
| Long conversation (100+ messages) | iTerm2 | No performance degradation |
| Tool calls with diffs | Linux (GNOME Terminal) | Colors correct, diff readable |
| Resize during streaming | Any | Layout adapts, no corruption |
| Ctrl+C during agent | Any | Clean exit, alt screen restored |
| Narrow terminal (40 cols) | Any | Graceful degradation, no crashes |
| SSH session | Remote Linux | No rendering artifacts |

---

## 16. Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| ink v5 performance with fast streaming | Medium | High | Buffer long responses (100ms flush), profile early |
| Alternate screen buffer not supported (e.g., CI) | Low | Medium | Detect `!process.stdout.isTTY`, fall back to classic mode |
| Unicode box-drawing misaligned in some fonts | Medium | Low | Provide `--ascii` flag for plain ASCII borders |
| React overhead for simple terminal UI | Low | Low | ink is lightweight; profile shows negligible overhead |
| Breaking change in ink v5 API | Low | Medium | Pin exact version, monitor changelog |

---

## 17. Entry Point Integration

### cli.ts Modifications

```typescript
// In the interactive command handler:

import { render } from "ink";
import React from "react";
import { App } from "./tui/App.js";
import { enterAltScreen, exitAltScreen, setupExitHandlers } from "./tui/lib/screen-buffer.js";

async function startInteractive(options: InteractiveOptions) {
  // Detect if TUI is supported
  const useTUI = options.tui !== false && process.stdout.isTTY;

  if (!useTUI) {
    // Fall back to classic readline mode
    const { InteractiveSession } = await import("./interactive.js");
    // ... existing code ...
    return;
  }

  // Enter alternate screen
  enterAltScreen();
  setupExitHandlers();

  // Render ink app
  const { waitUntilExit } = render(
    React.createElement(App, {
      session,
      config: configManager.get(),
      cloudMode: configManager.isCloudMode(),
      cloudClient: configManager.isCloudMode()
        ? new CloudClient(config.serverUrl, config.apiKey)
        : undefined,
    })
  );

  await waitUntilExit();
  exitAltScreen();
}
```

### Commander Flag Addition

```typescript
program
  .command("interactive", { isDefault: true })
  .description("Start interactive YUAN session")
  .option("--no-tui", "Use classic readline mode instead of TUI")
  .option("--classic", "Alias for --no-tui")
  .action(startInteractive);
```

---

## 18. File-by-File Summary

| # | File | Lines (est.) | Dependencies | Priority |
|---|------|-------------|--------------|----------|
| 1 | `tui/types.ts` | ~80 | None | P1 |
| 2 | `tui/lib/ansi.ts` | ~60 | None | P1 |
| 3 | `tui/lib/screen-buffer.ts` | ~40 | `ansi.ts` | P1 |
| 4 | `tui/lib/layout.ts` | ~50 | `types.ts` | P1 |
| 5 | `tui/lib/box-drawing.ts` | ~100 | `string-width` | P1 |
| 6 | `tui/lib/truncate.ts` | ~60 | `string-width`, `strip-ansi` | P3 |
| 7 | `tui/lib/diff-formatter.ts` | ~150 | `ansi.ts` | P3 |
| 8 | `tui/hooks/useTerminalSize.ts` | ~40 | `types.ts` | P1 |
| 9 | `tui/hooks/useInputHistory.ts` | ~60 | None | P2 |
| 10 | `tui/hooks/useScrollPosition.ts` | ~70 | None | P2 |
| 11 | `tui/hooks/useKeyHandler.ts` | ~80 | None | P3 |
| 12 | `tui/hooks/useSlashCommands.ts` | ~50 | `types.ts` | P4 |
| 13 | `tui/hooks/useAgentStream.ts` | ~200 | `@yuaone/core`, `types.ts` | P5 |
| 14 | `tui/components/StatusBar.tsx` | ~60 | `ansi.ts`, `box-drawing.ts` | P1 |
| 15 | `tui/components/FooterBar.tsx` | ~40 | `ansi.ts` | P1 |
| 16 | `tui/components/InputBox.tsx` | ~120 | `ink-text-input`, `useInputHistory` | P1 |
| 17 | `tui/components/MessageList.tsx` | ~100 | `useScrollPosition`, `MessageBubble` | P2 |
| 18 | `tui/components/MessageBubble.tsx` | ~90 | `MarkdownRenderer`, `ToolCallTree` | P2 |
| 19 | `tui/components/Spinner.tsx` | ~40 | `ink` | P2 |
| 20 | `tui/components/ThinkingDots.tsx` | ~35 | `ansi.ts` | P2 |
| 21 | `tui/components/MarkdownRenderer.tsx` | ~130 | `wrap-ansi`, `chalk` | P2 |
| 22 | `tui/components/ToolCallTree.tsx` | ~150 | `CollapsibleSection`, `DiffView`, `BashOutput` | P3 |
| 23 | `tui/components/DiffView.tsx` | ~120 | `diff-formatter.ts`, `box-drawing.ts` | P3 |
| 24 | `tui/components/CollapsibleSection.tsx` | ~50 | None | P3 |
| 25 | `tui/components/BashOutput.tsx` | ~70 | `box-drawing.ts` | P3 |
| 26 | `tui/components/SlashMenu.tsx` | ~80 | `useSlashCommands` | P4 |
| 27 | `tui/App.tsx` | ~120 | All components, all hooks | P1 |

**Total estimated:** ~2,285 lines across 27 files.

---

## Appendix A: Comparison with Current Implementation

| Feature | Current (`interactive.ts`) | New TUI |
|---------|--------------------------|---------|
| Screen mode | Normal scrollback | Alternate screen buffer |
| Layout | Unstructured `console.log` | 4-zone fixed layout |
| Input | `readline.Interface` | ink `TextInput` with multiline |
| History | readline built-in | Custom hook with navigation |
| Tool calls | Single-line `console.log` | Tree structure with collapse |
| Diffs | Raw colorized text | Structured DiffView with line numbers |
| Scroll | Terminal native | Virtual scroll with position tracking |
| Responsive | None | 3-tier (compact/normal/wide) |
| Slash commands | String matching | Autocomplete dropdown |
| Streaming | Direct `stdout.write` | Buffered + character-level rendering |
| Spinner | Braille on single line | Inline with agent label |
| Exit behavior | readline close | Alt screen restore, clean exit |

---

## Appendix B: Terminal Escape Sequence Reference

Key ANSI sequences used throughout the TUI:

```
\x1b[?1049h        Enter alternate screen buffer
\x1b[?1049l        Exit alternate screen buffer
\x1b[?25h          Show cursor
\x1b[?25l          Hide cursor
\x1b[2J\x1b[H      Clear screen and move to top-left
\x1b[{n}A          Move cursor up n lines
\x1b[{n}B          Move cursor down n lines
\x1b[{r};{c}H      Move cursor to row r, column c
\x1b[2K            Clear entire line
\x1b[K             Clear from cursor to end of line
\x1b[s             Save cursor position
\x1b[u             Restore cursor position
\x1b[7             Save cursor position (DEC)
\x1b[8             Restore cursor position (DEC)
```
