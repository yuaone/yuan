/**
 * @module llm-orchestrator
 * @description Unified LLM Orchestrator — single entry point for all LLM provider calls.
 *
 * Sits above BYOKClient to add:
 * - Provider capability registry (which models support reasoning, function calling, etc.)
 * - Automatic retry with exponential backoff
 * - Normalized LLM event emission for logging/telemetry
 * - Model routing hints (prefer reasoning-capable model for planning tasks)
 *
 * All agent-loop LLM calls should go through this orchestrator.
 * BYOKClient handles the per-provider protocol details (Anthropic native, Gemini native, OpenAI).
 */

import type { Message, ToolDefinition, LLMProvider } from "./types.js";
import { BYOKClient, type LLMStreamChunk, type LLMResponse } from "./llm-client.js";
import type { BYOKConfig } from "./types.js";

// ─── Provider Capability Registry ───

/** Capabilities that a provider/model combination may support */
export interface ProviderCapabilities {
  /** Supports extended reasoning / thinking stream */
  reasoning: boolean;
  /** Supports parallel function calling (multiple tools in one response) */
  parallelTools: boolean;
  /** Max output tokens */
  maxOutputTokens: number;
  /** Whether this model has a large context window (≥128k) */
  largeContext: boolean;
}

/** Known capability overrides per model prefix */
const MODEL_CAPABILITIES: Array<{ prefix: RegExp; caps: Partial<ProviderCapabilities> }> = [
  { prefix: /^claude-3-5-opus|^claude-opus-4|^claude-sonnet-4/i, caps: { reasoning: true, parallelTools: true, maxOutputTokens: 8192, largeContext: true } },
  { prefix: /^claude/i, caps: { reasoning: false, parallelTools: true, maxOutputTokens: 8192, largeContext: true } },
  { prefix: /^gemini-2\.5/i, caps: { reasoning: true, parallelTools: true, maxOutputTokens: 8192, largeContext: true } },
  { prefix: /^gemini/i, caps: { reasoning: false, parallelTools: true, maxOutputTokens: 8192, largeContext: true } },
  { prefix: /^gpt-4/i, caps: { reasoning: false, parallelTools: true, maxOutputTokens: 4096, largeContext: false } },
  { prefix: /^o1|^o3/i, caps: { reasoning: true, parallelTools: false, maxOutputTokens: 8192, largeContext: false } },
];

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  reasoning: false,
  parallelTools: true,
  maxOutputTokens: 4096,
  largeContext: false,
};

export function getModelCapabilities(model: string): ProviderCapabilities {
  for (const entry of MODEL_CAPABILITIES) {
    if (entry.prefix.test(model)) {
      return { ...DEFAULT_CAPABILITIES, ...entry.caps };
    }
  }
  return { ...DEFAULT_CAPABILITIES };
}

// ─── Normalized Event Types ───

export type NormalizedLLMEventKind =
  | "text"
  | "reasoning"
  | "tool_call"
  | "usage"
  | "done"
  | "error"
  | "retry";

export interface NormalizedLLMEvent {
  kind: NormalizedLLMEventKind;
  provider: LLMProvider;
  model: string;
  /** Milliseconds since orchestrator.chatStream() was called */
  elapsedMs: number;
  /** Event payload */
  payload: LLMStreamChunk | { message: string; attempt: number };
}

// ─── Orchestrator Config ───

export interface OrchestratorConfig {
  /** Max retry attempts on transient errors (default: 2) */
  maxRetries?: number;
  /** Initial backoff ms for retry (default: 1000, doubles each attempt) */
  retryBackoffMs?: number;
  /** Optional event listener for telemetry/logging */
  onEvent?: (event: NormalizedLLMEvent) => void;
}

// ─── LLMOrchestrator ───

/**
 * Unified orchestrator wrapping BYOKClient.
 * Provides retry, event normalization, and capability queries.
 */
export class LLMOrchestrator {
  private readonly client: BYOKClient;
  private readonly config: OrchestratorConfig;
  private readonly provider: LLMProvider;
  private readonly model: string;
  readonly capabilities: ProviderCapabilities;

  constructor(byokConfig: BYOKConfig, orchConfig: OrchestratorConfig = {}) {
    this.client = new BYOKClient(byokConfig);
    this.config = {
      maxRetries: orchConfig.maxRetries ?? 2,
      retryBackoffMs: orchConfig.retryBackoffMs ?? 1000,
      onEvent: orchConfig.onEvent,
    };
    this.provider = byokConfig.provider;
    this.model = byokConfig.model ?? "";
    this.capabilities = getModelCapabilities(this.model);
  }

  /**
   * Streaming chat with automatic retry on transient errors.
   * Emits normalized events to `onEvent` if configured.
   */
  async *chatStream(
    messages: Message[],
    tools?: ToolDefinition[],
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LLMStreamChunk> {
    const maxRetries = this.config.maxRetries ?? 2;
    const baseBackoff = this.config.retryBackoffMs ?? 1000;
    const startTime = Date.now();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const stream = this.client.chatStream(messages, tools, abortSignal);
        for await (const chunk of stream) {
          this.emit(chunk.type as NormalizedLLMEventKind, chunk, startTime);
          yield chunk;
        }
        return; // success
      } catch (err) {
        const isAbort = abortSignal?.aborted || (err instanceof Error && err.name === "AbortError");
        if (isAbort) throw err; // don't retry aborts

        const isRetryable = this.isTransientError(err);
        if (!isRetryable || attempt >= maxRetries) {
          this.emit("error", { message: String(err), attempt }, startTime);
          throw err;
        }

        const backoff = baseBackoff * Math.pow(2, attempt);
        this.emit("retry", { message: String(err), attempt }, startTime);
        await sleep(backoff);
      }
    }
  }

  /**
   * Non-streaming chat with retry.
   */
  async chat(
    messages: Message[],
    tools?: ToolDefinition[],
    abortSignal?: AbortSignal,
  ): Promise<LLMResponse> {
    const maxRetries = this.config.maxRetries ?? 2;
    const baseBackoff = this.config.retryBackoffMs ?? 1000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.client.chat(messages, tools);
      } catch (err) {
        const isAbort = abortSignal?.aborted || (err instanceof Error && err.name === "AbortError");
        if (isAbort) throw err;

        if (!this.isTransientError(err) || attempt >= maxRetries) throw err;

        const backoff = baseBackoff * Math.pow(2, attempt);
        await sleep(backoff);
      }
    }
    // unreachable
    throw new Error("LLMOrchestrator: retry loop exhausted");
  }

  destroy(): void {
    this.client.destroy();
  }

  // ─── Private ───

  private emit(
    kind: NormalizedLLMEventKind,
    payload: LLMStreamChunk | { message: string; attempt: number },
    startTime: number,
  ): void {
    this.config.onEvent?.({
      kind,
      provider: this.provider,
      model: this.model,
      elapsedMs: Date.now() - startTime,
      payload,
    });
  }

  private isTransientError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return (
      msg.includes("rate limit") ||
      msg.includes("429") ||
      msg.includes("503") ||
      msg.includes("overloaded") ||
      msg.includes("timeout") ||
      msg.includes("econnreset") ||
      msg.includes("enotfound")
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
