/**
 * @yuan/tools — Tool Registry
 *
 * Central registry for all YUAN agent tools.
 * - Register/retrieve tools by name
 * - Generate LLM-ready tool definitions
 * - Execute tools by name
 */

import type { ToolDefinition, ToolResult } from './types.js';
import type { BaseTool } from './base-tool.js';

export class ToolRegistry {
  private tools = new Map<string, BaseTool>();

  /** Register a tool instance. */
  register(tool: BaseTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Register multiple tools at once. */
  registerAll(tools: BaseTool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /** Get a tool by name. */
  get(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }

  /** Check if a tool is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** List all registered tool names. */
  listNames(): string[] {
    return [...this.tools.keys()];
  }

  /** Generate tool definitions for LLM consumption. */
  toDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.toDefinition());
  }

  /**
   * Execute a tool by name.
   * @param name - Tool name
   * @param args - Tool arguments (must include _toolCallId)
   * @param workDir - Project working directory
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    workDir: string
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        toolCallId: (args._toolCallId as string) ?? '',
        success: false,
        output: '',
        error: `Unknown tool: ${name}. Available tools: ${this.listNames().join(', ')}`,
      };
    }

    return tool.execute(args, workDir);
  }

  /** Get the number of registered tools. */
  get size(): number {
    return this.tools.size;
  }
}

// ─── Factory: create a registry with all built-in tools ──────────────

import { FileReadTool } from './file-read.js';
import { FileWriteTool } from './file-write.js';
import { FileEditTool } from './file-edit.js';
import { ShellExecTool } from './shell-exec.js';
import { GrepTool } from './grep.js';
import { GlobTool } from './glob.js';
import { GitOpsTool } from './git-ops.js';

/**
 * Create a ToolRegistry pre-loaded with all built-in YUAN tools.
 */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll([
    new FileReadTool(),
    new FileWriteTool(),
    new FileEditTool(),
    new ShellExecTool(),
    new GrepTool(),
    new GlobTool(),
    new GitOpsTool(),
  ]);
  return registry;
}
