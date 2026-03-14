/**
 * StrategyMarket integration helpers.
 * Called from agent-loop.ts at two sites:
 *   1. At run() start — register known task types as competing playbooks (initMarketPlaybooks)
 *   2. After taskType is inferred — select champion playbook (selectMarketStrategy)
 */
import type { StrategyMarket } from "../strategy-market.js";

/**
 * Known task types derived from playbookLibrary / yuan-core usage patterns.
 * These match the taskType strings used in agent-loop.ts.
 */
const KNOWN_TASK_TYPES = [
  "bugfix",
  "refactor",
  "feature",
  "test",
  "docs",
  "analysis",
  "unknown",
] as const;

/**
 * Register default playbook variants per task type in the market.
 * Should be called once per run() invocation.
 * Idempotent — StrategyMarket.register() handles duplicates gracefully.
 * Never throws.
 */
export function initMarketPlaybooks(market: StrategyMarket | null): void {
  if (!market) return;
  for (const taskType of KNOWN_TASK_TYPES) {
    try {
      // Register two competing strategies per task type
      market.register(`${taskType}-default`, taskType);
      market.register(`${taskType}-aggressive`, taskType);
    } catch {
      // Non-fatal
    }
  }
}

/**
 * Select the champion playbook for the given task type.
 * Returns the playbookId of the champion, or null if no champion yet.
 * Never throws.
 */
export function selectMarketStrategy(
  market: StrategyMarket | null,
  taskType: string,
): string | null {
  if (!market) return null;
  try {
    const champion = market.getChampion(taskType);
    return champion?.playbookId ?? null;
  } catch {
    return null;
  }
}
