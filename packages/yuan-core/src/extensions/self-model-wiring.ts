/**
 * CapabilitySelfModel integration helper.
 * Called from agent-loop.ts before buildSystemPrompt to inject
 * self-awareness context (known weaknesses / planning constraints).
 */
import type { CapabilitySelfModel } from "../capability-self-model.js";

/**
 * Generate a human-readable weakness / constraint context string
 * from the agent's self-model assessment.
 *
 * Returns "" if model is null, has no data, or throws.
 * Safe to inject into a system message as-is.
 */
export function getSelfWeaknessContext(
  model: CapabilitySelfModel | null,
): string {
  if (!model) return "";
  try {
    const assessment = model.assess();
    const lines: string[] = [];

    if (assessment.planningConstraints.length > 0) {
      lines.push("[Self-Model Constraints]");
      for (const c of assessment.planningConstraints) {
        lines.push(`- ${c}`);
      }
    }

    if (assessment.weaknesses.length > 0) {
      lines.push("[Known Weaknesses]");
      for (const w of assessment.weaknesses) {
        lines.push(
          `- ${w.environment}/${w.taskType}: ${w.rating} (${Math.round(w.successRate * 100)}% success)`,
        );
      }
    }

    return lines.join("\n");
  } catch {
    return "";
  }
}
