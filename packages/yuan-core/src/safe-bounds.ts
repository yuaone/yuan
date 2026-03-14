/**
 * @module safe-bounds
 * @description Centralized resource bounds to prevent unbounded memory growth,
 * context explosions, and runaway string allocations across the agent system.
 *
 * Every array that grows over time and every string from an external source
 * must be capped here. This is the single source of truth for all size limits.
 *
 * Rule: External data enters → truncate(). Arrays accumulate → cap().
 */

// ─── Numeric Bounds ──────────────────────────────────────────────────────────

export const BOUNDS = {
  // ─── Array bounds ───
  /** Max tracked changed files per agent run */
  changedFiles: 200,
  /** Max tool results kept in memory (allToolResults) */
  allToolResults: 30,
  /** Max tool results since last replan */
  toolResultsSinceReplan: 20,
  /** Max messages in context (pruned by message-pruner) */
  messages: 40,
  /** Max reflexion FIFO entries */
  reflexionEntries: 100,
  /** Max vector store chunks in memory */
  vectorChunks: 500,
  /** Max reasoning tree depth */
  reasoningDepth: 20,
  /** Max reasoning tree total nodes */
  reasoningNodes: 200,
  /** Max session chain length (continuation parent→child) */
  sessionChains: 50,
  /** Max background task steps in TUI */
  bgTaskSteps: 20,
  /** Max background tasks tracked simultaneously */
  bgTasks: 10,
  /** Max deferred fix prompts per iteration */
  deferredFixes: 5,
  /** Max skill-learner pattern entries */
  skillPatterns: 500,
  /** Max MCP servers that can be registered */
  mcpServers: 20,

  // ─── String / content bounds (chars) ───
  /** Shell command stdout (chars) — already enforced in shell-exec.ts */
  shellStdout: 100_000,
  /** Shell command stderr (chars) — already enforced in shell-exec.ts */
  shellStderr: 50_000,
  /** File read content (chars) — already enforced in file-read.ts */
  fileContent: 50_000,
  /** Git diff output (chars) */
  gitDiff: 15_000,
  /** Web scrape / fetch result (chars) */
  webContent: 30_000,
  /** TSC error output injected into LLM context (chars) */
  tscOutput: 3_000,
  /** Single reflexion entry body (chars) */
  reflexionEntryBody: 2_000,
  /** Tool result content stored in session persistence (chars) — 4KB */
  toolResultPersistence: 4_096,
  /** LLM thinking/reasoning content per message (chars) */
  thinkingContent: 8_000,
  /** Single QA issue message (chars) */
  qaIssueMessage: 200,
  /** Architecture summary cache (chars) */
  archSummary: 20_000,
  /** Error signature for repeat detection (chars) */
  errorSignature: 500,
  /** Single agent event content (chars) */
  agentEventContent: 2_000,
} as const;

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Cap an array to the last `max` elements.
 * Keeps the most recent entries (LIFO window).
 */
export function cap<T>(arr: T[], max: number): T[] {
  return arr.length > max ? arr.slice(-max) : arr;
}

/**
 * Cap an array to the first `max` elements.
 * Useful for ID lists, file lists, etc. where order matters.
 */
export function capHead<T>(arr: T[], max: number): T[] {
  return arr.length > max ? arr.slice(0, max) : arr;
}

/**
 * Truncate a string to `max` characters.
 * Appends a labeled suffix showing how many chars were removed.
 */
export function truncate(s: string, max: number, label = "content"): string {
  if (s.length <= max) return s;
  const removed = s.length - max;
  return s.slice(0, max) + `\n[...${removed} chars truncated from ${label}]`;
}

/**
 * Truncate from the start of a string (keep the end — useful for logs/output
 * where the most relevant info is at the bottom).
 */
export function truncateHead(s: string, max: number, label = "content"): string {
  if (s.length <= max) return s;
  const removed = s.length - max;
  return `[...${removed} chars truncated from ${label}]\n` + s.slice(-max);
}

/**
 * Push an item into an array and cap it in-place.
 * Returns the (possibly truncated) array.
 */
export function pushCapped<T>(arr: T[], item: T, max: number): T[] {
  arr.push(item);
  if (arr.length > max) {
    arr.splice(0, arr.length - max);
  }
  return arr;
}

/**
 * Safe JSON stringify that never throws and caps output size.
 * Used for persisting data to disk without pretty-printing (no OOM).
 */
export function safeJsonStringify(value: unknown, maxChars = 10_000_000): string {
  try {
    const s = JSON.stringify(value);
    return s.length > maxChars ? s.slice(0, maxChars) + '"[truncated]"' : s;
  } catch {
    return '"[json-stringify-error]"';
  }
}

/**
 * Safe JSON parse that never throws.
 */
export function safeJsonParse<T = unknown>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
