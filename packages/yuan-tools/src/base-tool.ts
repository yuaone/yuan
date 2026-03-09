/**
 * @yuan/tools — BaseTool abstract class
 *
 * Every tool inherits from BaseTool which provides:
 * - Tool definition metadata
 * - Path validation (path traversal defence)
 * - Output truncation
 * - Common execute contract
 *
 * ToolResult now uses @yuan/core's format:
 *   { tool_call_id, name, output, success, durationMs }
 */

import type { ToolResult, ToolDefinition, ToolParameterSchema } from '@yuan/core';
import type { ParameterDef, RiskLevel } from './types.js';
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

  /**
   * Execute the tool with the given arguments and workDir.
   * @param args - Tool arguments
   * @param workDir - Working directory
   * @param abortSignal - Optional AbortSignal for interrupt-based cancellation
   */
  abstract execute(args: Record<string, unknown>, workDir: string, abortSignal?: AbortSignal): Promise<ToolResult>;

  /** Validate and resolve a path within workDir. Throws on traversal. */
  protected validatePath(path: string, workDir: string): string {
    return _validatePath(path, workDir);
  }

  /** Truncate output to maxBytes. */
  protected truncateOutput(output: string, maxBytes?: number): string {
    return _truncateOutput(output, maxBytes);
  }

  /**
   * Convert ParameterDef map to JSON Schema for LLM consumption.
   * This bridges the tools' ParameterDef format to core's ToolParameterSchema.
   */
  private toJsonSchema(): ToolParameterSchema {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, param] of Object.entries(this.parameters)) {
      const prop: Record<string, unknown> = {
        type: param.type,
        description: param.description,
      };
      if (param.enum) prop.enum = param.enum;
      if (param.default !== undefined) prop.default = param.default;
      if (param.items) {
        prop.items = { type: param.items.type, description: param.items.description };
      }
      properties[key] = prop;
      if (param.required) {
        required.push(key);
      }
    }

    return {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
      additionalProperties: false,
    };
  }

  /** Generate a ToolDefinition (core-compatible) for LLM consumption. */
  toDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      parameters: this.toJsonSchema(),
    };
  }

  /** Helper to build a success ToolResult (core-compatible). */
  protected ok(toolCallId: string, output: string, metadata?: Record<string, unknown>): ToolResult {
    return {
      tool_call_id: toolCallId,
      name: this.name,
      output: this.truncateOutput(output),
      success: true,
      durationMs: 0, // Caller can override via wrapper
    };
  }

  /** Helper to build a failure ToolResult (core-compatible). */
  protected fail(toolCallId: string, error: string): ToolResult {
    return {
      tool_call_id: toolCallId,
      name: this.name,
      output: `Error: ${error}`,
      success: false,
      durationMs: 0,
    };
  }
}
