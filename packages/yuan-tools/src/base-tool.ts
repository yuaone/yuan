/**
 * @yuan/tools — BaseTool abstract class
 *
 * Every tool inherits from BaseTool which provides:
 * - Tool definition metadata
 * - Path validation (path traversal defence)
 * - Output truncation
 * - Common execute contract
 */

import type { ParameterDef, RiskLevel, ToolDefinition, ToolResult } from './types.js';
import { validatePath as _validatePath, truncateOutput as _truncateOutput } from './validators.js';

export abstract class BaseTool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly parameters: Record<string, ParameterDef>;
  abstract readonly riskLevel: RiskLevel;

  /** Tools with riskLevel !== 'low' require user approval by default. */
  get requiresApproval(): boolean {
    return this.riskLevel !== 'low';
  }

  /** Execute the tool with the given arguments and workDir. */
  abstract execute(args: Record<string, unknown>, workDir: string): Promise<ToolResult>;

  /** Validate and resolve a path within workDir. Throws on traversal. */
  protected validatePath(path: string, workDir: string): string {
    return _validatePath(path, workDir);
  }

  /** Truncate output to maxBytes. */
  protected truncateOutput(output: string, maxBytes?: number): string {
    return _truncateOutput(output, maxBytes);
  }

  /** Generate a ToolDefinition for LLM consumption. */
  toDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
      requiresApproval: this.requiresApproval,
      riskLevel: this.riskLevel,
    };
  }

  /** Helper to build a success ToolResult. */
  protected ok(toolCallId: string, output: string, metadata?: Record<string, unknown>): ToolResult {
    return {
      toolCallId,
      success: true,
      output: this.truncateOutput(output),
      metadata,
    };
  }

  /** Helper to build a failure ToolResult. */
  protected fail(toolCallId: string, error: string): ToolResult {
    return {
      toolCallId,
      success: false,
      output: '',
      error,
    };
  }
}
