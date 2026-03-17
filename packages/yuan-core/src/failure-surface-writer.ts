/**
 * @module failure-surface-writer
 * @description Tracks "why the agent failed" by category.
 * Appends to .yuan/logs/failure-surface.jsonl after each failed run.
 * Used to adjust Decision failureSurface in future sessions.
 * NO LLM.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface FailureSurfaceEntry {
  sessionId: string;
  timestamp: number;
  failureType: "tool_error" | "build_fail" | "test_fail" | "timeout" | "budget_exhausted" | "user_cancelled" | "unknown";
  toolName?: string;
  errorPattern?: string;
  intent?: string;
  complexity?: string;
  patchRisk?: number;
}

export function writeFailureSurface(entry: FailureSurfaceEntry, projectPath: string): void {
  try {
    const dir = join(projectPath, ".yuan", "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "failure-surface.jsonl"), JSON.stringify(entry) + "\n");
  } catch { /* non-fatal */ }
}

export function classifyFailure(terminationReason: string, lastToolError?: string): FailureSurfaceEntry["failureType"] {
  if (terminationReason === "BUDGET_EXHAUSTED") return "budget_exhausted";
  if (terminationReason === "MAX_ITERATIONS") return "timeout";
  if (terminationReason === "USER_CANCELLED") return "user_cancelled";
  if (!lastToolError) return "unknown";
  if (/tsc|TS\d{4}|build/i.test(lastToolError)) return "build_fail";
  if (/test|FAIL|assertion/i.test(lastToolError)) return "test_fail";
  return "tool_error";
}
