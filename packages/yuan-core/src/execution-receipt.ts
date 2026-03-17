/**
 * @module execution-receipt
 * @description Typed execution receipt — structured run outcome.
 * Created at end of each run. Consumed by memory, CLI, future backend sync.
 * NO LLM.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface ExecutionReceipt {
  sessionId: string;
  goal: string;
  outcome: "success" | "partial" | "blocked" | "error" | "clarification";
  decision: {
    intent: string;
    complexity: string;
    interactionMode: string;
    codeTaskType: string;
  };
  toolsUsed: Array<{ name: string; count: number; successRate: number }>;
  filesChanged: Array<{ path: string; action: "created" | "modified" | "deleted" }>;
  verification: {
    ran: boolean;
    passed: boolean;
    commands: string[];
  };
  remainingRisks: string[];
  rollbackAvailable: boolean;
  duration: number;
  tokensUsed: { input: number; output: number };
  timestamp: number;
}

export function buildReceipt(params: {
  sessionId: string;
  goal: string;
  terminationReason: string;
  decision: ExecutionReceipt["decision"];
  toolResults: Array<{ name: string; success: boolean }>;
  changedFiles: string[];
  verificationRan: boolean;
  verificationPassed: boolean;
  verificationCommands: string[];
  patchRisk: number;
  rollbackAvailable: boolean;
  duration: number;
  tokensUsed: { input: number; output: number };
}): ExecutionReceipt {
  // Aggregate tool usage
  const toolMap = new Map<string, { count: number; successes: number }>();
  for (const r of params.toolResults) {
    const existing = toolMap.get(r.name) ?? { count: 0, successes: 0 };
    existing.count++;
    if (r.success) existing.successes++;
    toolMap.set(r.name, existing);
  }
  const toolsUsed = [...toolMap.entries()].map(([name, { count, successes }]) => ({
    name, count, successRate: count > 0 ? successes / count : 0,
  }));

  // Map termination reason to outcome
  const outcomeMap: Record<string, ExecutionReceipt["outcome"]> = {
    GOAL_ACHIEVED: "success",
    NEEDS_CLARIFICATION: "clarification",
    BLOCKED_EXTERNAL: "blocked",
    ERROR: "error",
    MAX_ITERATIONS: "partial",
    BUDGET_EXHAUSTED: "partial",
  };
  const outcome = outcomeMap[params.terminationReason] ?? "partial";

  // Remaining risks
  const risks: string[] = [];
  if (params.patchRisk > 0.5) risks.push(`Patch risk: ${(params.patchRisk * 100).toFixed(0)}%`);
  if (!params.verificationRan) risks.push("Verification was not run");
  if (params.verificationRan && !params.verificationPassed) risks.push("Verification failed");

  return {
    sessionId: params.sessionId,
    goal: params.goal,
    outcome,
    decision: params.decision,
    toolsUsed,
    filesChanged: params.changedFiles.map(p => ({ path: p, action: "modified" as const })),
    verification: {
      ran: params.verificationRan,
      passed: params.verificationPassed,
      commands: params.verificationCommands,
    },
    remainingRisks: risks,
    rollbackAvailable: params.rollbackAvailable,
    duration: params.duration,
    tokensUsed: params.tokensUsed,
    timestamp: Date.now(),
  };
}

export function saveReceipt(receipt: ExecutionReceipt, projectPath: string): void {
  try {
    const dir = join(projectPath, ".yuan", "sessions", receipt.sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "receipt.json"), JSON.stringify(receipt, null, 2));
  } catch { /* non-fatal */ }
}
