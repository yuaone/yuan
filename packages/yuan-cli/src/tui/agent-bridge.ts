/**
 * agent-bridge.ts — Bridges @yuaone/core AgentLoop to the TUI.
 *
 * This is the non-React glue layer that:
 * 1. Creates AgentLoop with proper config
 * 2. Subscribes to AgentLoop events
 * 3. Forwards events to a callback (which the TUI App sets)
 * 4. Handles interruption (Esc → hard interrupt)
 * 5. Handles approval flow
 */

import {
  AgentLoop,
  DEFAULT_LOOP_CONFIG,
  ExecutionEngine,
  type ExecutionEngineConfig,
  type AgentConfig,
  type AgentEvent,
  type BYOKConfig,
  type ApprovalRequest,
  type ApprovalResponse,
} from "@yuaone/core";
import { createDefaultRegistry } from "@yuaone/tools";

export interface AgentBridgeConfig {
  provider: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  workDir: string;
  useExecutionEngine?: boolean;
}

export type EventCallback = (event: AgentEvent) => void;
export type ApprovalCallback = (request: ApprovalRequest) => Promise<ApprovalResponse>;
export type TerminationCallback = (result: { reason: string; [key: string]: unknown }) => void;

export class AgentBridge {
  private config: AgentBridgeConfig;
  private loop: AgentLoop | null = null;
  private engine: ExecutionEngine | null = null;
  private eventCallback: EventCallback | null = null;
  private approvalCallback: ApprovalCallback | null = null;
  private terminationCallback: TerminationCallback | null = null;
  private changedFiles: string[] = [];
  private isProcessing = false;

  constructor(config: AgentBridgeConfig) {
    this.config = config;
  }

  /** Set the event callback (called for every AgentEvent) */
  onEvent(cb: EventCallback): void {
    this.eventCallback = cb;
  }

  /** Set the approval callback */
  onApproval(cb: ApprovalCallback): void {
    this.approvalCallback = cb;
  }

  /** Set the termination callback (called when run() completes) */
  onTermination(cb: TerminationCallback): void {
    this.terminationCallback = cb;
  }

  /** Whether the agent is currently processing */
  get running(): boolean {
    return this.isProcessing;
  }

  /** Get list of changed files in this session */
  get filesChanged(): string[] {
    return [...this.changedFiles];
  }

  /**
   * Send a message to the agent. Creates a new AgentLoop each time
   * (matching the interactive.ts pattern — stateless per request).
   */
  async sendMessage(message: string): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    const { provider, apiKey, model, baseUrl, workDir, useExecutionEngine } = this.config;
    const normalizedProvider = this.toProvider(provider);

    // Build BYOK config
    const byokConfig: BYOKConfig = {
     provider: normalizedProvider,
      apiKey,
      model,
      baseUrl,
    };

    // Create tool registry
    const registry = createDefaultRegistry();
    const toolExecutor = registry.toExecutor(workDir);

    if (useExecutionEngine) {
      await this.runWithExecutionEngine(message, byokConfig, toolExecutor, workDir);
    } else {
      await this.runWithAgentLoop(message, byokConfig, toolExecutor, workDir);
    }
  }

  /** Run using the standard AgentLoop */
  private async runWithAgentLoop(
    message: string,
    byokConfig: BYOKConfig,
    toolExecutor: ReturnType<ReturnType<typeof createDefaultRegistry>["toExecutor"]>,
    workDir: string,
  ): Promise<void> {
    // Build agent config
    const agentConfig: AgentConfig = {
      byok: byokConfig,
      loop: {
        model: "coding",
        maxIterations: DEFAULT_LOOP_CONFIG.maxIterations,
        maxTokensPerIteration: DEFAULT_LOOP_CONFIG.maxTokensPerIteration,
        totalTokenBudget: DEFAULT_LOOP_CONFIG.totalTokenBudget,
        tools: toolExecutor.definitions,
        systemPrompt:
          `You are YUAN, an autonomous coding agent.\n` +
          `You have tools for reading, writing, editing files, running shell commands, searching code, and git operations.\n` +
          `\n` +
          `## How to work\n` +
          `- Before making changes, briefly state what you plan to do (e.g., "I'll read the config, then update the handler")\n` +
          `- After completing a step, summarize what was done and what's next\n` +
          `- When a task has multiple independent parts, call multiple tools at once to work faster\n` +
          `- For file modifications, always read the file first to understand context\n` +
          `\n` +
          `## Tool usage tips\n` +
          `- Use glob/grep to find files before reading them\n` +
          `- Use file_read with offset/limit for large files (>50KB)\n` +
          `- Use shell_exec for build, test, lint commands\n` +
          `- You can call multiple tools in a single response when they don't depend on each other\n` +
          `\n` +
          `## Response style\n` +
          `- Be concise. Lead with actions, not explanations\n` +
          `- Use markdown for formatting (bold, code, lists)\n` +
          `- Report progress naturally — what you did, what you found, what's next\n` +
          `- If something fails, explain why and try an alternative approach\n` +
          `- Answer in the same language the user uses`,
        projectPath: workDir,
      },
    };

    // Create AgentLoop
    const loop = new AgentLoop({
      config: agentConfig,
      toolExecutor,
      governorConfig: { planTier: "LOCAL" },
      approvalHandler: (request) => this.handleApproval(request),
      autoFixConfig: { maxRetries: 3, autoLint: true, autoBuild: true, autoTest: false },
    });

    this.loop = loop;

    // Subscribe to events
    loop.on("event", (event: AgentEvent) => {
      // Track file changes
      if (event.kind === "agent:file_change") {
        if (!this.changedFiles.includes(event.path)) {
          this.changedFiles.push(event.path);
        }
      }

      // Forward to TUI
      this.eventCallback?.(event);
    });

    try {
      const result = await loop.run(message);
      this.terminationCallback?.(result);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.eventCallback?.({
        kind: "agent:error",
        message: errMsg,
        retryable: false,
      });
      this.terminationCallback?.({ reason: "ERROR", error: errMsg });
    } finally {
      this.isProcessing = false;
      loop.removeAllListeners();
      this.loop = null;
    }
  }

  /** Run using ExecutionEngine (hierarchical planning, parallel tools, deep verify) */
  private async runWithExecutionEngine(
    message: string,
    byokConfig: BYOKConfig,
    toolExecutor: ReturnType<ReturnType<typeof createDefaultRegistry>["toExecutor"]>,
    workDir: string,
  ): Promise<void> {
    const engine = new ExecutionEngine({
      byokConfig,
      projectPath: workDir,
      toolExecutor,
      maxIterations: 100,
      totalTokenBudget: 500_000,
      enableParallel: true,
      enableHierarchicalPlanning: true,
      enableDeepVerify: true,
      approvalHandler: (request: ApprovalRequest) => this.handleApproval(request),
    });

    this.engine = engine;

    // Map ExecutionEngine events to AgentEvent format
    engine.on("text_delta", (text: string) => {
      this.eventCallback?.({ kind: "agent:text_delta", text } as AgentEvent);
    });
engine.on("token_usage", (usage: { input: number; output: number }) => {
  this.eventCallback?.({
    kind: "agent:token_usage",
    input: usage.input,
    output: usage.output,
  } as AgentEvent);
});
    engine.on("thinking", (text: string) => {
      this.eventCallback?.({ kind: "agent:thinking", content: text } as AgentEvent);
    });

    engine.on("tool:call", (name: string, input: unknown) => {
      this.eventCallback?.({ kind: "agent:tool_call", tool: name, input } as AgentEvent);
    });

    engine.on("tool:result", (name: string, output: unknown, durationMs?: number) => {
      this.eventCallback?.({
        kind: "agent:tool_result",
        tool: name,
        output,
        durationMs: durationMs ?? 0,
      } as AgentEvent);
    });

    engine.on("engine:error", (error: Error) => {
      this.eventCallback?.({
        kind: "agent:error",
        message: error.message,
        retryable: false,
      } as AgentEvent);
    });

    engine.on("engine:complete", (result: { summary: string; changedFiles: string[] }) => {
      // Track changed files from engine result
      for (const f of result.changedFiles) {
        if (!this.changedFiles.includes(f)) {
          this.changedFiles.push(f);
        }
      }

      this.eventCallback?.({
        kind: "agent:completed",
        summary: result.summary,
        filesChanged: result.changedFiles,
      } as AgentEvent);
    });

    engine.on("phase:enter", (phase: string) => {
      this.eventCallback?.({
        kind: "agent:thinking",
        content: `Phase: ${phase}`,
      } as AgentEvent);
    });

    try {
      const result = await engine.execute(message);
      this.terminationCallback?.({
        reason: "COMPLETE",
        summary: result.summary,
        changedFiles: result.changedFiles,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.eventCallback?.({
        kind: "agent:error",
        message: errMsg,
        retryable: false,
      } as AgentEvent);
      this.terminationCallback?.({ reason: "ERROR", error: errMsg });
    } finally {
      this.isProcessing = false;
      engine.removeAllListeners();
      this.engine = null;
    }
  }

  /** Interrupt the current agent execution (hard stop) */
  interrupt(): void {
    if (!this.isProcessing) return;

    if (this.loop) {
      this.loop.interrupt({
        type: "hard",
        source: "cli",
      });
    }

    if (this.engine) {
      this.engine.abort();
    }
  }

  /** Handle approval requests by delegating to the callback */
  private async handleApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    if (this.approvalCallback) {
      return this.approvalCallback(request);
    }
    // Default: auto-approve (can be changed via config)
    return "approve";
  }

  /** Reset file tracking */
  resetChangedFiles(): void {
    this.changedFiles = [];
  }
  private toProvider(provider: string): BYOKConfig["provider"] {
    switch (provider) {
      case "openai":
      case "anthropic":
      case "google":
      case "yua":
        return provider;
      default:
        return "openai";
    }
  }
}
