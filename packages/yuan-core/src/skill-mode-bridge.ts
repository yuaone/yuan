/**
 * @module skill-mode-bridge
 * @description Maps built-in skill IDs to their corresponding AgentMode values.
 *
 * When a skill is enabled via `/skills enable <id>`, the CLI can use this map
 * to also apply the corresponding agent mode, giving the LLM the right
 * system-prompt suffix and tool restrictions for that skill's domain.
 */

import type { AgentMode } from "./agent-modes.js";

/** Map from built-in skill ID to the AgentMode it corresponds to. */
export const SKILL_TO_MODE: Record<string, AgentMode> = {
  "code-review": "review",
  "security-scan": "security",
  "test-driven": "test",
  "test-gen": "test",
  refactor: "refactor",
  debug: "debug",
  plan: "plan",
  architect: "architect",
};

/**
 * Resolve the AgentMode for a given skill ID.
 * Returns undefined if the skill has no mode mapping.
 */
export function skillToMode(skillId: string): AgentMode | undefined {
  return SKILL_TO_MODE[skillId];
}
