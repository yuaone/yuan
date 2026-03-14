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
 * Only checks the task-level budget (not daily/project/branch) to avoid
 * false halts from accumulated cross-session token counts.
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
    // Only halt on task-level exhaustion — daily/project budgets should degrade, not halt
    const taskAlloc = status?.allocations?.find(
      (a) => (a as { type?: string }).type === "task",
    );
    if (!taskAlloc) return false;
    const limit = (taskAlloc as { limit?: number }).limit ?? 0;
    const used = (taskAlloc as { used?: number }).used ?? 0;
    if (limit <= 0) return false;
    return used / limit >= 1.0;
  } catch {
    return false;
  }
}
