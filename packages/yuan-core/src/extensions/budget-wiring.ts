/**
 * BudgetGovernorV2 integration helpers.
 * These are called from agent-loop.ts at two sites:
 *   1. After each LLM response (recordBudgetUsage)
 *   2. At the start of each iteration (checkBudgetShouldHalt)
 */
import type { BudgetGovernorV2 } from "../budget-governor-v2.js";

/**
 * Record token usage in the budget governor after an LLM call.
 * Uses "task" budget type keyed by sessionId.
 * Never throws.
 */
export function recordBudgetUsage(
  gov: BudgetGovernorV2 | null,
  inputTokens: number,
  outputTokens: number,
  sessionId: string,
): void {
  if (!gov) return;
  try {
    gov.recordUsage(inputTokens + outputTokens, "task", sessionId);
  } catch {
    // Non-fatal: budget tracking failure must never crash the agent
  }
}

/**
 * Check whether the budget governor has halted this task.
 * Returns true if execution should stop.
 * Never throws.
 */
export function checkBudgetShouldHalt(
  gov: BudgetGovernorV2 | null,
  sessionId: string,
): boolean {
  if (!gov) return false;
  try {
    const status = gov.check(sessionId);
    return status?.isHalted ?? false;
  } catch {
    return false;
  }
}
