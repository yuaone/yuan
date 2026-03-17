import { BaseTool } from './base-tool.js';
import type { ToolResult } from '@yuaone/core';
import type { ParameterDef, RiskLevel } from './types.js';

/**
 * task_complete — signals that the agent has finished its task.
 * The agent MUST call this tool when done. The loop intercepts this
 * call and terminates with GOAL_ACHIEVED, using `summary` as the
 * final response shown to the user.
 *
 * Protocol-level completion signal: language-agnostic, CoT-safe.
 */
export class TaskCompleteTool extends BaseTool {
  readonly name = 'task_complete';
  readonly description =
    'Signal that your task is fully complete. Call this ONLY when you have finished all work. ' +
    'Provide a concise summary of what was accomplished. ' +
    'DO NOT call this if you still have pending actions or need to use other tools first.';
  readonly riskLevel: RiskLevel = 'low';

  readonly parameters: Record<string, ParameterDef> = {
    summary: {
      type: 'string',
      description: 'A concise summary of the completed work (1-3 sentences).',
      required: true,
    },
  };

  async execute(
    args: Record<string, unknown>,
    _workDir: string,
    _abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    const summary = String(args['summary'] ?? '');
    // The actual loop termination is handled by the agent-loop intercepting this tool call.
    // This execute() is a fallback that should not normally be reached.
    return this.ok('', `task_complete: ${summary}`);
  }
}
