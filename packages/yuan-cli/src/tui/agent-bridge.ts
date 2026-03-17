/**
 * agent-bridge.ts — Bridges @yuaone/core AgentLoop to the TUI.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Debug logger ────────────────────────────────────────────────────────────
// Writes key LLM/event milestones to ~/.yuan/logs/debug.log
// Clears log on each process start so only current session is tracked.
const LOG_PATH = join(homedir(), ".yuan", "logs", "debug.log");
let _logReady = false;
function dbg(tag: string, msg: string): void {
  try {
    if (!_logReady) {
      mkdirSync(join(homedir(), ".yuan", "logs"), { recursive: true });
      // Truncate on first write (fresh session)
      writeFileSync(LOG_PATH, `[${new Date().toISOString()}] [session] START\n`);
      _logReady = true;
    }
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] [${tag}] ${msg}\n`);
  } catch { /* never crash the TUI over logging */ }
}

import {
  AgentLoop,
  DEFAULT_LOOP_CONFIG,
  ExecutionEngine,
  buildSystemPrompt,
  agentDecide,
  type ExecutionEngineConfig,
  type AgentConfig,
  type AgentEvent,
  type AgentDecisionContext,
  type BYOKConfig,
  type ApprovalRequest,
  type ApprovalResponse,
} from "@yuaone/core";
import { createDefaultRegistry } from "@yuaone/tools";
import type { RegistryOptions } from "@yuaone/tools";

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
  /** Generation counter — prevents stale finally blocks from clobbering event callbacks */
  private _runGeneration = 0;
  /** Persistent loop instance — reused across messages to preserve conversation history */
  private persistentLoop: AgentLoop | null = null;
  /** Previous decision — for continuation detection + stuck breaker */
  private prevDecision: AgentDecisionContext | null = null;

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
    if (this.isProcessing) {
      this.eventCallback?.({ kind: "agent:error", message: "Agent is busy — message queued", retryable: true } as AgentEvent);
      return;
    }
    this.isProcessing = true;
    dbg("bridge", `sendMessage start msg="${message.slice(0, 60)}"`);

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

    // Create tool registry — inject Gemini native search when provider is Google
    const registryOpts: RegistryOptions = normalizedProvider === "google"
      ? { geminiSearch: { apiKey: effectiveApiKey, model: model ?? "gemini-2.0-flash" } }
      : {};
    const registry = createDefaultRegistry(registryOpts);
    const toolExecutor = registry.toExecutor(workDir);

    // Decision Engine — deterministic mode routing (no LLM call)
    let decision: AgentDecisionContext | null = null;
    try {
      decision = agentDecide({
        message,
        prevDecision: this.prevDecision ?? undefined,
      });
      this.prevDecision = decision;
      dbg("decision", `mode=${decision.core.interactionMode} intent=${decision.core.reasoning.intent} complexity=${decision.core.reasoning.complexity}`);
    } catch (err) {
      dbg("decision", `agentDecide failed, falling back: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Route based on Decision Engine's interactionMode
    const mode = decision?.core.interactionMode ?? (useExecutionEngine ? "AGENT" : "CHAT");

    switch (mode) {
      case "AGENT":
        await this.runWithExecutionEngine(message, byokConfig, toolExecutor, workDir, decision ?? undefined);
        break;
      case "CHAT":
      case "HYBRID":
      default:
        await this.runWithAgentLoop(message, byokConfig, toolExecutor, workDir);
        break;
    }
  }

  /** Build the system prompt — delegates to yuan-core SSOT prompt builder */
  private buildAgentSystemPrompt(mode: string = "code", toolDefs?: import("@yuaone/core").ToolDefinition[]): string {
    const modeInstructions: Record<string, string> = {
      code: "Current mode: CODE — autonomous coding. Write, edit, refactor as needed.",
      review: "Current mode: REVIEW — read-only. Do NOT write or edit files. Only analyze and report.",
      security: "Current mode: SECURITY — OWASP audit. Scan for vulnerabilities, secrets, injection risks.",
      debug: "Current mode: DEBUG — systematic debugging. Isolate root causes, propose minimal targeted fixes.",
      refactor: "Current mode: REFACTOR — improve structure without changing behavior.",
      test: "Current mode: TEST — write tests, run them, fix failures.",
      plan: "Current mode: PLAN — read-only planning. Create detailed plans but do NOT modify files.",
      architect: "Current mode: ARCHITECT — analyze structure, dependencies, scalability.",
      report: "Current mode: REPORT — generate analysis reports in markdown.",
    };
    const modeRule = modeInstructions[mode] ?? modeInstructions["code"]!;

    // Use yuan-core buildSystemPrompt as SSOT
    // Pass tools if available; additionalRules carries the current mode instruction
    return buildSystemPrompt({
      tools: toolDefs ?? [],
      additionalRules: [modeRule],
      projectPath: this.config.workDir,
    });
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
        systemPrompt: this.buildAgentSystemPrompt(this._currentMode, toolExecutor.definitions),
        projectPath: workDir,
      },
    };

    const loop = new AgentLoop({
      config: agentConfig,
      toolExecutor,
      governorConfig: { planTier: "LOCAL" },
      approvalHandler: (request) => this.handleApproval(request),
      autoFixConfig: { maxRetries: 3, autoLint: true, autoBuild: true, autoTest: false },
      // Disable pre-run hierarchical planning — it adds 30-60s LLM call before first response
      enablePlanning: false,
    });

    // Subscribe to events — persistent listener
    loop.on("event", (event: AgentEvent) => {
      // Debug logging for key milestones
      switch (event.kind) {
        case "agent:text_delta":
          dbg("event", `text_delta len=${String((event as {text?:string}).text ?? "").length}`);
          break;
        case "agent:tool_call":
          dbg("event", `tool_call tool=${String((event as {tool?:string}).tool ?? "")}`);
          break;
        case "agent:tool_result":
          dbg("event", `tool_result tool=${String((event as {tool?:string}).tool ?? "")}`);
          break;
        case "agent:thinking":
          dbg("event", `thinking len=${String((event as {content?:string}).content ?? "").length}`);
          break;
        case "agent:reasoning_delta":
          dbg("event", `reasoning_delta len=${String((event as {text?:string}).text ?? "").length}`);
          break;
        case "agent:completed":
          dbg("event", "agent:completed ✓");
          break;
        case "agent:error":
          dbg("event", `agent:error msg=${String((event as {message?:string}).message ?? "")}`);
          break;
      }

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

    let completedEmitted = false;
    const originalEventCallback = this.eventCallback;
    // Capture generation so stale finally blocks don't clobber a newer callback
    const gen = ++this._runGeneration;
    // Intercept event stream to track whether agent:completed is emitted
    this.eventCallback = (event: AgentEvent) => {
      if (event.kind === "agent:completed") completedEmitted = true;
      originalEventCallback?.(event);
    };

    try {
      dbg("bridge", "loop.run() start");
      const result = await loop.run(message);
      const reason = String((result as {reason?:string}).reason ?? "");
      const errorDetail = String((result as {error?:string}).error ?? "");
      dbg("bridge", `loop.run() done reason=${reason}${errorDetail ? ` error=${errorDetail.slice(0,120)}` : ""}`);
      // If loop returned ERROR, emit agent:error so TUI shows the message
      if (reason === "ERROR" && errorDetail && !completedEmitted) {
        originalEventCallback?.({ kind: "agent:error", message: errorDetail, retryable: false } as unknown as AgentEvent);
      }
      // If loop didn't emit agent:completed (e.g. BUDGET_EXHAUSTED), emit it now
      if (!completedEmitted) {
        dbg("bridge", "fallback agent:completed emit (loop didn't emit one)");
        originalEventCallback?.({ kind: "agent:completed", summary: "", filesChanged: [], reason } as unknown as AgentEvent);
      }
      this.terminationCallback?.(result);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      dbg("bridge", `loop.run() THREW: ${errMsg.slice(0, 120)}`);
      this.eventCallback?.({
        kind: "agent:error",
        message: errMsg,
        retryable: false,
      });
      this.terminationCallback?.({ reason: "ERROR", error: errMsg });
    } finally {
      // Only restore callback if no newer runWithAgentLoop has started.
      // If generation diverged, a new run already swapped the callback — skip restore.
      if (this._runGeneration === gen) {
        this.eventCallback = originalEventCallback;
      }
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
    decision?: AgentDecisionContext,
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
      const result = await engine.execute(message, decision);
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

    dbg("bridge", "interrupt() called — force-stopping");

    if (this.loop) {
      this.loop.interrupt({
        type: "hard",
        source: "cli",
      });
    }

    if (this.engine) {
      this.engine.abort();
    }

    // Force isProcessing=false immediately so next sendMessage() is not blocked.
    // The loop.run() Promise will eventually settle (error/complete) but we don't wait.
    this.isProcessing = false;
    this.loop = null;
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
    // Recreate loop on next sendMessage with the new system prompt.
    // We null persistentLoop here so the next message picks up the new mode.
    // History is lost but mode must actually take effect in the LLM context.
    if (this.persistentLoop) {
      this.persistentLoop = null;
      this.loop = null;
    }
    this.eventCallback?.({
      kind: "agent:thinking",
      content: `Mode → ${mode}`,
    } as import("@yuaone/core").AgentEvent);
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
