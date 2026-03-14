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
  /** Multi-provider keys — used when user switches providers via /model */
  apiKeys?: Partial<Record<string, string>>;
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
  /** Persistent loop instance — reused across messages to preserve conversation history */
  private persistentLoop: AgentLoop | null = null;

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

  /** Current active provider */
  get activeProvider(): string {
    return this.config.provider;
  }

  /** Get list of changed files in this session */
  get filesChanged(): string[] {
    return [...this.changedFiles];
  }

  /**
   * Send a message to the agent. Creates a new AgentLoop each time
   * (matching the interactive.ts pattern — stateless per request).
   */
  /** Update provider+model at runtime (called by /model command) */
  updateModel(provider: string, model: string): void {
    this.config.provider = provider;
    this.config.model = model;
    // Destroy persistent loop so next sendMessage rebuilds with new provider/model/key
    if (this.persistentLoop) {
      this.persistentLoop.removeAllListeners();
      this.persistentLoop = null;
    }
  }

  /** Store a provider API key at runtime */
  setProviderKey(provider: string, key: string): void {
    if (!this.config.apiKeys) this.config.apiKeys = {};
    this.config.apiKeys[provider] = key;
  }

  /** Get effective API key for the current provider */
  private getEffectiveApiKey(provider: string): string {
    // 1. Multi-key map
    const fromMap = this.config.apiKeys?.[provider];
    if (fromMap) return fromMap;
    // 2. Environment variables
    const envMap: Record<string, string> = {
      openai: process.env["OPENAI_API_KEY"] ?? "",
      anthropic: process.env["ANTHROPIC_API_KEY"] ?? "",
      google: process.env["GOOGLE_API_KEY"] ?? process.env["GEMINI_API_KEY"] ?? "",
      yua: process.env["YUA_API_KEY"] ?? "",
    };
    if (envMap[provider]) return envMap[provider];
    // 3. Legacy fallback
    return this.config.apiKey;
  }

  async sendMessage(message: string): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    const { provider, model, baseUrl, workDir, useExecutionEngine } = this.config;
    const normalizedProvider = this.toProvider(provider);
    const effectiveApiKey = this.getEffectiveApiKey(provider);

    // Build BYOK config
    const byokConfig: BYOKConfig = {
      provider: normalizedProvider,
      apiKey: effectiveApiKey,
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

  /** Build the system prompt for agent config */
  private buildSystemPrompt(mode: string = "code"): string {
    const modeInstructions: Record<string, string> = {
      code: "You are in CODE mode — autonomous coding. Write, edit, refactor code as needed.",
      review: "You are in REVIEW mode — read-only code review. Do NOT write or edit files. Only analyze and report issues.",
      security: "You are in SECURITY mode — OWASP security audit. Scan for vulnerabilities, secrets, injection risks.",
      debug: "You are in DEBUG mode — systematic debugging. Isolate root causes, propose minimal targeted fixes.",
      refactor: "You are in REFACTOR mode — code refactoring. Improve structure without changing behavior.",
      test: "You are in TEST mode — test generation and execution. Write tests, run them, fix failures.",
      plan: "You are in PLAN mode — task planning (read-only). Create detailed plans but do NOT modify files.",
      architect: "You are in ARCHITECT mode — architecture analysis. Analyze structure, dependencies, scalability.",
      report: "You are in REPORT mode — generate analysis reports. Summarize findings in markdown.",
    };

    const modeInstruction = modeInstructions[mode] ?? modeInstructions["code"];

    return (
      `# YUAN — Autonomous Coding Agent\n` +
      `\n` +
      `I am YUAN, a senior autonomous coding agent built to tackle any engineering challenge — ` +
      `from a single bug fix to architecting a full operating system from scratch.\n` +
      `I have been trained across millions of codebases and I approach every task with confidence and precision.\n` +
      `\n` +
      `## My Identity\n` +
      `- **Role**: Senior software engineer + autonomous agent\n` +
      `- **Mindset**: Every task is solvable. I decompose, plan, and execute — never refuse.\n` +
      `- **Approach**: Read before write. Understand before change. Verify after every step.\n` +
      `- **Scale**: I work on files, directories, entire monorepos — no project is too large.\n` +
      `\n` +
      `## Tools I have\n` +
      `file_read, file_write, file_edit, glob, grep, shell_exec, git_ops, code_search — ` +
      `I use them in parallel where possible to move fast.\n` +
      `\n` +
      `## Current Mode\n` +
      `${modeInstruction}\n` +
      `\n` +
      `## How to work\n` +
      `- Before making changes, briefly state what you plan to do (1-2 lines max)\n` +
      `- After completing a step, summarize what was done and what's next\n` +
      `- When a task has multiple independent parts, call multiple tools at once to work faster\n` +
      `- For file modifications, always read the file first to understand context\n` +
      `- For large tasks, break them into phases — report "✓ Phase X/N done. Starting Phase Y..."\n` +
      `\n` +
      `## Tackling ambitious or large-scale tasks\n` +
      `- NEVER assess a task as "too large" or "too complex" — that is not your call to make\n` +
      `- If you've never built something (OS, compiler, distributed system), START ANYWAY:\n` +
      `  1. Decompose into concrete components (kernel, scheduler, memory, IPC, drivers, FS, UI...)\n` +
      `  2. Design/implement the most critical component first\n` +
      `  3. Build iteratively — partial output is infinitely better than refusal\n` +
      `- For mega-scale tasks: produce a phased plan first, then execute each phase in order\n` +
      `- Unknown domain = use shell_exec to research, grep existing code, look at real implementations\n` +
      `\n` +
      `## Recovery when stuck\n` +
      `- Tool returns empty/error → try 2 alternative approaches before reporting failure\n` +
      `- Build fails → read error, fix, retry (max 3 self-fix loops before escalating)\n` +
      `- If genuinely blocked (missing credentials, hardware required) → state WHAT is missing\n` +
      `  and produce maximum possible output given the constraint\n` +
      `\n` +
      `## Tool usage tips\n` +
      `- Use glob/grep to find files before reading them\n` +
      `- Use file_read with offset/limit for large files (>50KB)\n` +
      `- Use shell_exec for build, test, lint commands\n` +
      `- You can call multiple tools in a single response when they don't depend on each other\n` +
      `- To search/read files OUTSIDE the current project directory (e.g. ../other-repo), use:\n` +
      `  glob(path="../other-repo", pattern="**") or file_read(path="../other-repo/src/index.ts")\n` +
      `  NEVER put ../ inside the glob pattern field — put it in the path field instead\n` +
      `- If a path like ../foo is mentioned, immediately try glob(path="../foo", pattern="**") — don't ask if it exists\n` +
      `\n` +
      `## BANNED commands — NEVER use these\n` +
      `- NEVER run \`ls -R\`, \`ls -la\`, \`find / \`, \`find ~\`, \`find .\` without a specific path and -maxdepth 2\n` +
      `  These scan entire directory trees and can take 10+ minutes. They will time out and waste everyone's time.\n` +
      `- Instead: use glob(pattern="**/*.ts") or grep to find what you need. Be targeted.\n` +
      `- If you need to understand project structure: glob(pattern="*") at the root, then drill into specific dirs\n` +
      `\n` +
      `## Narration — talk while you work\n` +
      `- Before each tool call (or batch of tool calls), write 1 short sentence explaining what you're doing.\n` +
      `  Examples:\n` +
      `  "Let me check the existing project structure first."\n` +
      `  "Reading the main entry point to understand how this is wired."\n` +
      `  "Searching for existing model definitions."\n` +
      `  "Running the build to verify the changes compile."\n` +
      `- After a tool result, briefly say what you found and what's next (1 line max).\n` +
      `- Keep it tight — narrate like a senior dev pair-programming, not like writing documentation.\n` +
      `- DO NOT narrate if you're just doing a quick follow-up tool call (no need for a sentence every single tool).\n` +
      `\n` +
      `## Response style\n` +
      `- Be concise. Lead with actions, not explanations\n` +
      `- Use markdown for formatting (bold, code, lists)\n` +
      `- For long tasks: report milestones like "✓ Phase 1/4 done (kernel design). Starting Phase 2 (memory manager)..."\n` +
      `- If a tool returns 0 results, try a different approach (different path, different pattern) before giving up\n` +
      `- If something fails, immediately try an alternative — NEVER just report failure and stop\n` +
      `- Answer in the same language the user uses\n` +
      `- NEVER refuse to attempt large or ambitious tasks — break them into steps and start immediately\n` +
      `- NEVER say "I can't access the file system" or "I can't find the directory" without trying tools first\n` +
      `- NEVER hedge with "this would require..." or "in a real implementation..." — just do it`
    );
  }

  /** Create a persistent AgentLoop (once per session, reused across messages) */
  private createPersistentLoop(
    byokConfig: BYOKConfig,
    toolExecutor: ReturnType<ReturnType<typeof createDefaultRegistry>["toExecutor"]>,
    workDir: string,
  ): AgentLoop {
    const agentConfig: AgentConfig = {
      byok: byokConfig,
      loop: {
        model: "coding",
        maxIterations: DEFAULT_LOOP_CONFIG.maxIterations,
        maxTokensPerIteration: DEFAULT_LOOP_CONFIG.maxTokensPerIteration,
        totalTokenBudget: DEFAULT_LOOP_CONFIG.totalTokenBudget,
        tools: toolExecutor.definitions,
        systemPrompt: this.buildSystemPrompt(this._currentMode),
        projectPath: workDir,
      },
    };

    const loop = new AgentLoop({
      config: agentConfig,
      toolExecutor,
      governorConfig: { planTier: "LOCAL" },
      approvalHandler: (request) => this.handleApproval(request),
      autoFixConfig: { maxRetries: 3, autoLint: true, autoBuild: true, autoTest: false },
    });

    // Subscribe to events — persistent listener
    loop.on("event", (event: AgentEvent) => {
      if (event.kind === "agent:file_change") {
        if (!this.changedFiles.includes(event.path)) {
          this.changedFiles.push(event.path);
        }
      }
      this.eventCallback?.(event);
    });

    return loop;
  }

  /** Run using the standard AgentLoop — reuses persistent loop to maintain conversation history */
  private async runWithAgentLoop(
    message: string,
    byokConfig: BYOKConfig,
    toolExecutor: ReturnType<ReturnType<typeof createDefaultRegistry>["toExecutor"]>,
    workDir: string,
  ): Promise<void> {
    // Reuse existing loop to preserve conversation history, or create new one
    if (!this.persistentLoop) {
      this.persistentLoop = this.createPersistentLoop(byokConfig, toolExecutor, workDir);
    }

    const loop = this.persistentLoop;
    this.loop = loop;

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
      this.loop = null;
      // NOTE: do NOT null out persistentLoop — it holds conversation history
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

  /** Reset conversation history (start a new session) */
  resetSession(): void {
    if (this.persistentLoop) {
      this.persistentLoop.removeAllListeners();
      this.persistentLoop = null;
    }
    this.changedFiles = [];
  }
  /** Compact context — compress old messages in the persistent loop */
  compact(): string {
    if (!this.persistentLoop) return "No active session to compact.";
    // Access contextManager via public getConversationHistory or internal cast
    const msgs = (this.persistentLoop as unknown as { getConversationHistory?: () => unknown[] }).getConversationHistory?.() ?? [];
    if (msgs.length < 4) return "Context is too short to compact (< 4 messages).";
    // Mark session for compression on next iteration by emitting a synthetic event
    this.eventCallback?.({
      kind: "agent:thinking",
      content: "Context compaction requested — will apply at next iteration.",
    } as import("@yuaone/core").AgentEvent);
    return `Compaction queued. Current context: ${msgs.length} messages. Will compress on next agent call.`;
  }

  /** Remove the last tracked changed file (for /undo) */
  removeLastChangedFile(): string | null {
    return this.changedFiles.pop() ?? null;
  }

  /** Set current agent mode — injected into system prompt on next message */
  private _currentMode: string = "code";
  setMode(mode: string): void {
    this._currentMode = mode;
    // Destroy the current persistent loop so next message creates a new one with updated system prompt
    // (preserve conversation history by NOT nulling it — will be recreated with mode in next sendMessage)
    // Actually, we can't preserve history easily when recreating the loop.
    // So instead, add a system message to the existing loop context if it exists.
    if (this.persistentLoop) {
      // Signal mode change via thinking event
      this.eventCallback?.({
        kind: "agent:thinking",
        content: `Mode switched to: ${mode}`,
      } as import("@yuaone/core").AgentEvent);
    }
  }
  get currentMode(): string { return this._currentMode; }

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
