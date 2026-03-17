/**
 * @module agent-affordance
 * @description AgentAffordanceVector calculator.
 * Pure math, NO LLM, NO async. Deterministic: same input → same output.
 *
 * Ported from YUA Decision Orchestrator's computeResponseAffordance
 * into coding-agent execution-tendency vectors.
 */

import type {
  AgentReasoningResult,
  AgentAffordanceVector,
  AgentIntent,
  AgentTaskStage,
  AgentComplexity,
} from "./agent-decision-types.js";

// ─── Math Utilities ───

/** Clamp a number to [0, 1]. */
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Smooth ease curve: 0→0, 0.5→0.5, 1→1.
 * `0.5 * (1 - cos(PI * clamp01(x)))`
 */
export function cosineEase(x: number): number {
  return 0.5 * (1 - Math.cos(Math.PI * clamp01(x)));
}

/**
 * Cosine similarity between two affordance vectors.
 * Returns a value in [-1, 1], though for non-negative vectors it's [0, 1].
 */
export function cosineSimilarity(
  a: AgentAffordanceVector,
  b: AgentAffordanceVector,
): number {
  const keys: (keyof AgentAffordanceVector)[] = [
    "explain_plan", "inspect_more", "edit_now", "run_checks", "finalize",
  ];
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const k of keys) {
    dot += a[k] * b[k];
    magA += a[k] * a[k];
    magB += b[k] * b[k];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

// ─── Intent Bias Table (9 intents → 5D base vectors, §5.1) ───

const INTENT_BIAS: Record<AgentIntent, AgentAffordanceVector> = {
  inspect:  { explain_plan: 0.3, inspect_more: 0.8, edit_now: 0.1, run_checks: 0.2, finalize: 0.1 },
  plan:     { explain_plan: 0.9, inspect_more: 0.5, edit_now: 0.2, run_checks: 0.3, finalize: 0.1 },
  search:   { explain_plan: 0.2, inspect_more: 0.9, edit_now: 0.1, run_checks: 0.1, finalize: 0.1 },
  read:     { explain_plan: 0.3, inspect_more: 0.7, edit_now: 0.1, run_checks: 0.2, finalize: 0.2 },
  edit:     { explain_plan: 0.3, inspect_more: 0.2, edit_now: 0.9, run_checks: 0.5, finalize: 0.3 },
  test:     { explain_plan: 0.2, inspect_more: 0.2, edit_now: 0.3, run_checks: 0.9, finalize: 0.4 },
  verify:   { explain_plan: 0.1, inspect_more: 0.2, edit_now: 0.2, run_checks: 0.8, finalize: 0.7 },
  refactor: { explain_plan: 0.5, inspect_more: 0.4, edit_now: 0.8, run_checks: 0.7, finalize: 0.3 },
  fix:      { explain_plan: 0.2, inspect_more: 0.3, edit_now: 0.8, run_checks: 0.8, finalize: 0.4 },
};

// ─── Stage Multipliers ───

interface PartialMultiplier {
  explain_plan?: number;
  inspect_more?: number;
  edit_now?: number;
  run_checks?: number;
  finalize?: number;
}

const STAGE_MULTIPLIER: Record<AgentTaskStage, PartialMultiplier> = {
  underspecified: { explain_plan: 1.3, inspect_more: 1.5, edit_now: 0.3 },
  blocked:        { inspect_more: 1.4, run_checks: 1.3, edit_now: 0.5 },
  iterating:      { edit_now: 1.2, run_checks: 1.1, finalize: 0.8 },
  ready:          {}, // no modifier
};

// ─── Depth Decay ───

const DEPTH_DECAY: Record<AgentReasoningResult["depthHint"], number> = {
  deep: 0.95,
  normal: 0.85,
  shallow: 0.7,
};

// ─── Affordance Keys ───

const AFFORDANCE_KEYS: (keyof AgentAffordanceVector)[] = [
  "explain_plan", "inspect_more", "edit_now", "run_checks", "finalize",
];

// ─── Main Calculator ───

/**
 * Compute the 5D agent affordance vector from reasoning output.
 * Pure function — same inputs produce identical output.
 *
 * Pipeline: intentBias → stageMultiplier → depthDecay → cosineEase → clamp →
 *           hardGuards → trendCorrection → stuckBreaker
 */
export function computeAgentAffordance(
  reasoning: AgentReasoningResult,
  prevAffordance?: AgentAffordanceVector,
): AgentAffordanceVector {
  const { intent, taskStage, complexity, depthHint } = reasoning;

  const base = INTENT_BIAS[intent];
  const stageMul = STAGE_MULTIPLIER[taskStage];
  const depthDecay = DEPTH_DECAY[depthHint];

  // Compute raw vector with cosineEase
  const raw: AgentAffordanceVector = {
    explain_plan: 0,
    inspect_more: 0,
    edit_now: 0,
    run_checks: 0,
    finalize: 0,
  };

  for (const k of AFFORDANCE_KEYS) {
    raw[k] = cosineEase(
      base[k] * (stageMul[k] ?? 1) * depthDecay,
    );
  }

  // Clamp all to [0, 1]
  for (const k of AFFORDANCE_KEYS) {
    raw[k] = clamp01(raw[k]);
  }

  // ─── Hard Guards ───

  // underspecified → edit_now max 0.15
  if (taskStage === "underspecified") {
    raw.edit_now = Math.min(raw.edit_now, 0.15);
  }

  // trivial → explain_plan max 0.2, finalize min 0.7
  if (complexity === "trivial") {
    raw.explain_plan = Math.min(raw.explain_plan, 0.2);
    raw.finalize = Math.max(raw.finalize, 0.7);
  }

  // ─── Trend Correction ───
  if (prevAffordance) {
    const similarity = cosineSimilarity(raw, prevAffordance);
    if (similarity > 0.92) {
      // Too similar — induce slight exploration boost
      raw.inspect_more = clamp01(raw.inspect_more + 0.05);
    }
  }

  return raw;
}

// ─── Stuck Breaker (GPT QA #15) ───

/**
 * If the same decision pattern repeats 3+ times, force a strategy shift
 * to break out of repetitive loops.
 *
 * @param affordance - Current affordance vector (will be shallow-copied, not mutated)
 * @param repeatCount - Number of consecutive similar decisions
 * @returns Adjusted affordance vector, or the original if repeatCount < 3
 */
export function applyStuckBreaker(
  affordance: Readonly<AgentAffordanceVector>,
  repeatCount: number,
): AgentAffordanceVector {
  if (repeatCount < 3) return { ...affordance };

  // 3+ repeats → force strategy shift
  return {
    explain_plan: clamp01(affordance.explain_plan + 0.2),
    inspect_more: clamp01(affordance.inspect_more - 0.2),
    edit_now:     clamp01(affordance.edit_now - 0.1),
    run_checks:   clamp01(affordance.run_checks + 0.3),
    finalize:     clamp01(affordance.finalize + 0.2),
  };
}
