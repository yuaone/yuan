/**
 * @yuaone/tools — Tool Registry
 *
 * Central registry for all YUAN agent tools.
 * - Register/retrieve tools by name
 * - Generate LLM-ready tool definitions
 * - Execute tools by name
 * - toExecutor() bridges to @yuaone/core's ToolExecutor interface
 */

import type { ToolDefinition, ToolResult, ToolCall, ToolExecutor } from '@yuaone/core';
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

  /** Generate tool definitions for LLM consumption (core-compatible JSON Schema). */
  toDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.toDefinition());
  }

  /**
   * Execute a tool by name (internal use).
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
        tool_call_id: (args._toolCallId as string) ?? '',
        name,
        success: false,
        output: `Error: Unknown tool: ${name}. Available tools: ${this.listNames().join(', ')}`,
        durationMs: 0,
      };
    }

    return tool.execute(args, workDir);
  }

  /**
   * Execute a tool by name, passing an optional AbortSignal for interrupt support.
   * @param name - Tool name
   * @param args - Tool arguments
   * @param workDir - Project working directory
   * @param abortSignal - Optional AbortSignal for cancellation
   */
  async executeWithSignal(
    name: string,
    args: Record<string, unknown>,
    workDir: string,
    abortSignal?: AbortSignal
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        tool_call_id: (args._toolCallId as string) ?? '',
        name,
        success: false,
        output: `Error: Unknown tool: ${name}. Available tools: ${this.listNames().join(', ')}`,
        durationMs: 0,
      };
    }

    return tool.execute(args, workDir, abortSignal);
  }

  /**
   * Create a ToolExecutor adapter that implements @yuaone/core's ToolExecutor interface.
   *
   * The adapter:
   * - Provides tool definitions in JSON Schema format
   * - Parses ToolCall.arguments (string → object if needed)
   * - Injects _toolCallId into args
   * - Measures execution duration
   * - Returns core-compatible ToolResult
   *
   * @param workDir - Project working directory for tool execution
   */
  toExecutor(workDir: string): ToolExecutor {
    const registry = this;
    const definitions = this.toDefinitions();

    return {
      definitions,

      async execute(call: ToolCall, abortSignal?: AbortSignal): Promise<ToolResult> {
        // Parse arguments: core ToolCall.arguments can be string or object
        let args: Record<string, unknown>;
        if (typeof call.arguments === 'string') {
          try {
            args = JSON.parse(call.arguments) as Record<string, unknown>;
          } catch {
            return {
              tool_call_id: call.id,
              name: call.name,
              output: `Error: Failed to parse tool arguments as JSON: ${call.arguments}`,
              success: false,
              durationMs: 0,
            };
          }
        } else {
          args = { ...call.arguments };
        }

        // Inject toolCallId for BaseTool.execute
        args._toolCallId = call.id;

        const startTime = Date.now();
        const result = await registry.executeWithSignal(call.name, args, workDir, abortSignal);
        const durationMs = Date.now() - startTime;

        // Ensure result has correct durationMs
        return {
          ...result,
          durationMs,
        };
      },
    };
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
import { BashTool } from './bash.js';
import { GrepTool } from './grep.js';
import { GlobTool } from './glob.js';
import { GitOpsTool } from './git-ops.js';
import { TestRunTool } from './test-run.js';
import { CodeSearchTool } from './code-search.js';
import { SecurityScanTool } from './security-scan.js';
import { WebSearchTool, type GeminiSearchConfig } from './web-search.js';
import { ParallelWebSearchTool } from './parallel-web-search.js';
import { TaskCompleteTool } from './task-complete.js';

export interface RegistryOptions {
  /** Pass Gemini config to enable native Google Search for web_search and parallel_web_search */
  geminiSearch?: GeminiSearchConfig;
}

/**
 * Create a ToolRegistry pre-loaded with all built-in YUAN tools.
 * Pass `opts.geminiSearch` to enable Gemini native Google Search as the search backend.
 */
export function createDefaultRegistry(opts?: RegistryOptions): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll([
    new FileReadTool(),
    new FileWriteTool(),
    new FileEditTool(),
    new ShellExecTool(),
    new BashTool(),
    new GrepTool(),
    new GlobTool(),
    new GitOpsTool(),
    new TestRunTool(),
    new CodeSearchTool(),
    new SecurityScanTool(),
    new WebSearchTool(opts?.geminiSearch),
    new ParallelWebSearchTool(opts?.geminiSearch),
    new TaskCompleteTool(),
  ]);
  return registry;
}

/**
 * Create a ToolRegistry with all standard tools + design mode tools.
 *
 * Design tools (snapshot, screenshot, navigate, resize, inspect, scroll)
 * are loaded via dynamic import to avoid circular dependencies.
 *
 * @param workDir - Project working directory (reserved for future use)
 */
export async function createDesignRegistry(workDir: string): Promise<ToolRegistry> {
  const registry = createDefaultRegistry();
  const { createDesignTools } = await import('./design-tools.js');
  for (const tool of createDesignTools()) {
    registry.register(tool);
  }
  return registry;
}
