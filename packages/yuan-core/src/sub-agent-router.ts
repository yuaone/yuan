/**
 * @module sub-agent-router
 * @description Smart model routing for sub-agents.
 *
 * Strategy: Use the cheapest model that can handle the task well.
 * - Trivial/simple tasks → FAST tier (gpt-4o-mini, haiku)
 * - Moderate tasks → NORMAL tier (gpt-4o, sonnet)
 * - Complex/critical tasks → DEEP tier (gpt-4.1, opus)
 * - Reviewer tasks → one tier below main (cost saving)
 */

import type { SubAgentRole } from "./sub-agent-prompts.js";

// ─── Types ───

/** Model tier for sub-agent routing */
export type SubAgentTier = "FAST" | "NORMAL" | "DEEP";

/** Routing decision with reasoning */
export interface RoutingDecision {
  /** Selected model tier */
  tier: SubAgentTier;
  /** Human-readable reason for the decision */
  reason: string;
  /** Cost multiplier relative to FAST=1.0 */
  estimatedCostMultiplier: number;
}

/** Signals used to determine optimal model tier */
export interface TaskSignals {
  /** Sub-agent role */
  role: SubAgentRole;
  /** Task complexity estimate */
  complexity: "trivial" | "simple" | "moderate" | "complex" | "massive";
  /** Number of files involved */
  fileCount: number;
  /** Whether the task involves tests */
  hasTests: boolean;
  /** Whether this is on a critical path (security, auth, payments) */
  isCriticalPath: boolean;
  /** Number of previous failures (retry count) */
  previousFailures: number;
  /** Parent agent's model tier (for cost containment) */
  parentModelTier: SubAgentTier;
}

// ─── Constants ───

const TIER_ORDER: SubAgentTier[] = ["FAST", "NORMAL", "DEEP"];

const COST_MULTIPLIERS: Record<SubAgentTier, number> = {
  FAST: 1.0,
  NORMAL: 5.0,
  DEEP: 20.0,
};

/** Complexity → base tier mapping */
const COMPLEXITY_BASE_TIER: Record<string, SubAgentTier> = {
  trivial: "FAST",
  simple: "FAST",
  moderate: "NORMAL",
  complex: "DEEP",
  massive: "DEEP",
};

// ─── Helpers ───

function tierIndex(tier: SubAgentTier): number {
  return TIER_ORDER.indexOf(tier);
}

function clampTier(index: number): SubAgentTier {
  const clamped = Math.max(0, Math.min(index, TIER_ORDER.length - 1));
  return TIER_ORDER[clamped];
}

function upgradeTier(tier: SubAgentTier, steps: number = 1): SubAgentTier {
  return clampTier(tierIndex(tier) + steps);
}

function downgradeTier(tier: SubAgentTier, steps: number = 1): SubAgentTier {
  return clampTier(tierIndex(tier) - steps);
}

// ─── Router ───

/**
 * Route a sub-agent task to the optimal model tier.
 *
 * Applies a series of rules to select the cheapest model tier
 * that can handle the task effectively. Rules are applied in order:
 *
 * 1. Role-based base tier (reviewer→FAST, debugger→NORMAL minimum, etc.)
 * 2. Complexity modifier (adjusts up/down based on task complexity)
 * 3. Critical path floor (security/auth/payments → NORMAL minimum)
 * 4. Failure escalation (2+ failures → upgrade one tier)
 * 5. Parent containment (never exceed parent's tier)
 *
 * @param signals - Task characteristics used for routing
 * @returns Routing decision with tier, reason, and cost estimate
 */
export function routeSubAgent(signals: TaskSignals): RoutingDecision {
  const reasons: string[] = [];

  // Step 1: Role-based starting tier
  let tier = getRoleBaseTier(signals.role, signals.complexity);
  reasons.push(`role=${signals.role}, complexity=${signals.complexity} → ${tier}`);

  // Step 2: Reviewer override — always prefer FAST for reviews
  if (signals.role === "reviewer") {
    tier = "FAST";
    reasons.push("reviewer → FAST (reviews don't need expensive models)");
  }

  // Step 3: Debugger floor — debugging needs reasoning, minimum NORMAL
  if (signals.role === "debugger" && tierIndex(tier) < tierIndex("NORMAL")) {
    tier = "NORMAL";
    reasons.push("debugger → NORMAL minimum (reasoning required)");
  }

  // Step 4: File count pressure — many files suggest higher complexity
  if (signals.fileCount > 10 && tierIndex(tier) < tierIndex("NORMAL")) {
    tier = "NORMAL";
    reasons.push(`fileCount=${signals.fileCount} → NORMAL (many files)`);
  }
  if (signals.fileCount > 25 && tierIndex(tier) < tierIndex("DEEP")) {
    tier = "DEEP";
    reasons.push(`fileCount=${signals.fileCount} → DEEP (massive scope)`);
  }

  // Step 5: Critical path floor — security/auth/payments need NORMAL minimum
  if (signals.isCriticalPath && tierIndex(tier) < tierIndex("NORMAL")) {
    tier = "NORMAL";
    reasons.push("critical path → NORMAL minimum (security/auth/payments)");
  }

  // Step 6: Failure escalation — model wasn't capable enough, upgrade
  if (signals.previousFailures >= 2) {
    const upgraded = upgradeTier(tier);
    if (upgraded !== tier) {
      tier = upgraded;
      reasons.push(
        `${signals.previousFailures} failures → upgraded to ${tier}`,
      );
    }
  }

  // Step 7: Parent containment — sub-agents never exceed parent tier
  if (tierIndex(tier) > tierIndex(signals.parentModelTier)) {
    tier = signals.parentModelTier;
    reasons.push(`capped to parent tier ${signals.parentModelTier}`);
  }

  // Step 8: If parent is FAST, all sub-agents are FAST (cost containment)
  if (signals.parentModelTier === "FAST") {
    tier = "FAST";
    reasons.push("parent=FAST → all sub-agents FAST (cost containment)");
  }

  return {
    tier,
    reason: reasons.join("; "),
    estimatedCostMultiplier: COST_MULTIPLIERS[tier],
  };
}

/**
 * Get the base tier for a role + complexity combination.
 */
function getRoleBaseTier(
  role: SubAgentRole,
  complexity: string,
): SubAgentTier {
  // Start with complexity-based tier
  const baseTier = COMPLEXITY_BASE_TIER[complexity] ?? "NORMAL";

  // Role-specific adjustments
  switch (role) {
    case "reviewer":
      // Reviews are always cheap — pattern matching, not generation
      return "FAST";

    case "tester":
      // Simple tests → FAST, complex → NORMAL (never DEEP for tests)
      return complexity === "complex" || complexity === "massive"
        ? "NORMAL"
        : "FAST";

    case "planner":
      // Planning needs reasoning — minimum NORMAL
      return tierIndex(baseTier) < tierIndex("NORMAL") ? "NORMAL" : baseTier;

    case "debugger":
      // Debugging needs reasoning — minimum NORMAL
      return tierIndex(baseTier) < tierIndex("NORMAL") ? "NORMAL" : baseTier;

    case "refactorer":
      // Refactoring: follow complexity, but cap at NORMAL unless massive
      return complexity === "massive" ? "DEEP" : baseTier;

    case "coder":
    default:
      // Coding follows complexity directly
      return baseTier;
  }
}

/**
 * Estimate complexity from task signals when explicit complexity is unknown.
 * Useful when the caller doesn't have a pre-computed complexity level.
 *
 * @param fileCount - Number of files involved
 * @param goalLength - Character length of the goal description
 * @param hasTests - Whether tests are required
 * @returns Estimated complexity level
 */
export function estimateComplexity(
  fileCount: number,
  goalLength: number,
  hasTests: boolean,
): "trivial" | "simple" | "moderate" | "complex" | "massive" {
  // Simple heuristics based on scope
  if (fileCount <= 1 && goalLength < 100 && !hasTests) return "trivial";
  if (fileCount <= 2 && goalLength < 300) return "simple";
  if (fileCount <= 5 && goalLength < 800) return "moderate";
  if (fileCount <= 15) return "complex";
  return "massive";
}

/**
 * Get the cost multiplier for a tier.
 * FAST=1.0, NORMAL=5.0, DEEP=20.0
 */
export function getTierCostMultiplier(tier: SubAgentTier): number {
  return COST_MULTIPLIERS[tier];
}

/**
 * Get all tier names in order from cheapest to most expensive.
 */
export function getAllTiers(): SubAgentTier[] {
  return [...TIER_ORDER];
}
