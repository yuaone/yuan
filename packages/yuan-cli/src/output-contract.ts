/**
 * Output Contract Layer
 *
 * 3-stage filter pipeline that prevents internal LLM prompt leaks
 * from reaching the user transcript.
 *
 * Pipeline: raw delta -> sanitizeDelta() -> lineBuffer -> isInternalLeak() -> render
 */

// ---------------------------------------------------------------------------
// Internal leak patterns (line-level)
// ---------------------------------------------------------------------------

const INTERNAL_LEAK_PATTERNS: readonly RegExp[] = [
  /^\*\*Acknowledge the /i,
  /^\*\*As instructed/i,
  /^I(?:'ve| have) been instructed/i,
  /^(?:As |Per )(?:the )?(?:system |developer )?(?:prompt|instruction)/i,
  /^I (?:should|will|need to) (?:reply|respond|answer) in/i,
  /^(?:GOAL_ACHIEVED|REASON_|INTERNAL_|PHASE_)/,
  /^\[?system[_ ]?prompt\]?/i,
  /^(?:developer|hidden) instruction/i,
  /^policy:/i,
  /^\*\*Awaiting Further Instruction/i,
  /^No further action will be taken/i,
];

// ---------------------------------------------------------------------------
// Delta-level keywords (conservative — only obvious internal markers)
// ---------------------------------------------------------------------------

const DELTA_BLOCK_PATTERN =
  /Acknowledge the |system prompt|developer instruction|hidden instruction|Awaiting Further Instruction|No further action/i;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Chunk-level filter.
 *
 * Examines a raw streaming delta and returns an empty string when the chunk
 * contains an obvious internal keyword. The check is intentionally
 * conservative: it only blocks phrases that are unambiguously internal,
 * never common English words.
 */
export function sanitizeDelta(delta: string): string {
  if (DELTA_BLOCK_PATTERN.test(delta)) {
    return "";
  }
  return delta;
}

/**
 * Line-level filter.
 *
 * Returns `true` when a fully-buffered line matches one of the known
 * internal prompt leak patterns. Callers should drop the line from the
 * user-visible transcript when this returns `true`.
 */
export function isInternalLeak(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return INTERNAL_LEAK_PATTERNS.some((p) => p.test(trimmed));
}

// ---------------------------------------------------------------------------
// PublicOutput — typed output that renderers consume
// ---------------------------------------------------------------------------

export type PublicOutput =
  | { type: "text"; text: string }
  | { type: "tool_header"; name: string; verb: string; target: string }
  | { type: "tool_result"; name: string; summary: string; preview?: string }
  | { type: "status"; text: string }
  | { type: "error"; message: string }
  | { type: "user_message"; text: string }
  | { type: "done"; tokens: number; duration: number }
  | { type: "system_notice"; text: string };
