/**
 * CapabilityGraph integration helpers.
 * Called from agent-loop.ts at two sites:
 *   1. On init — register all tool names as graph nodes (registerToolsInGraph)
 *   2. After each tool execution — record outcome (recordToolOutcomeInGraph)
 */
import type { CapabilityGraph } from "../capability-graph.js";

/**
 * Register tool names as "tool" nodes in the capability graph.
 * Idempotent — upsertNode handles duplicates.
 * Never throws.
 */
export function registerToolsInGraph(
  graph: CapabilityGraph | null,
  toolNames: string[],
): void {
  if (!graph) return;
  for (const name of toolNames) {
    try {
      graph.upsertNode({
        id: name,
        type: "tool",
        name,
        description: "",
        successRate: 0,
        usageCount: 0,
        tags: [],
        metadata: {},
      });
    } catch {
      // Non-fatal
    }
  }
}

/**
 * Record a tool execution outcome in the capability graph.
 * Never throws.
 */
export function recordToolOutcomeInGraph(
  graph: CapabilityGraph | null,
  toolName: string,
  success: boolean,
): void {
  if (!graph) return;
  try {
    graph.recordOutcome(toolName, success);
  } catch {
    // Non-fatal
  }
}
