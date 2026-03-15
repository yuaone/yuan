/**
 * @module llm-client
 * @description BYOK LLM API 클라이언트 — OpenAI/Anthropic 호출 추상화
 *
 * openai SDK를 사용하여 OpenAI 호환 포맷으로 통신 (YUA도 OpenAI-compatible).
 * Anthropic은 별도 네이티브 포맷 변환 후 호출.
 */
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import {
  type BYOKConfig,
  type ContentBlock,
  type LLMProvider,
  type Message,
  type ToolCall,
  type ToolDefinition,
  contentToString,
} from "./types.js";
import { MODEL_DEFAULTS, PROVIDER_BASE_URLS } from "./constants.js";
import { LLMError } from "./errors.js";

/** LLM 응답 결과 */
export interface LLMResponse {
  /** 텍스트 응답 (없으면 null) */
  content: string | null;
  /** 도구 호출 목록 */
  toolCalls: ToolCall[];
  /** 토큰 사용량 */
  usage: { input: number; output: number };
  /** 종료 사유 */
  finishReason: string;
}

/** 스트리밍 청크 */
export interface LLMStreamChunk {
   type: "text" | "reasoning" | "tool_call" | "done";
  /** 텍스트 델타 (type=text) */
  text?: string;
  /** 도구 호출 정보 (type=tool_call, 완료 시) */
  reasoning?: {
    id?: string;
    text: string;
    provider?: string;
    model?: string;
    source?: "llm";
  };
  toolCall?: ToolCall;
  /** 최종 사용량 (type=done) */
  usage?: { input: number; output: number };
}

/**
 * BYOK LLM 클라이언트.
 * 사용자의 API 키로 직접 LLM을 호출한다.
 */
export class BYOKClient {
  private readonly config: BYOKConfig;
  private readonly model: string;
  private openaiClient: OpenAI | null;

  async embed(text: string): Promise<{ embedding: number[] }> {
    if (!this.openaiClient) {
      throw new Error("Embedding not supported for this provider");
    }

    const response = await this.openaiClient.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });

    return {
      embedding: response.data[0].embedding,
    };
  }
  constructor(config: BYOKConfig) {
    this.config = config;
    this.model = config.model ?? MODEL_DEFAULTS[config.provider];

    // Anthropic uses native fetch — skip OpenAI SDK instance
    if (config.provider === "anthropic") {
      this.openaiClient = null;
    } else {
      const headers = this.getDefaultHeaders(config.provider);
      // YUA uses x-api-key header, not Bearer token.
      // Override Authorization to prevent OpenAI SDK from sending Bearer token
      // which would trigger YUA's Firebase auth path instead of API key auth.
      if (config.provider === "yua") {
        headers["Authorization"] = "";
      }
      this.openaiClient = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl ?? this.getBaseUrl(config.provider),
        defaultHeaders: headers,
      });
    }
  }

  /**
   * LLM에 메시지 전송 (non-streaming).
   * @param messages 대화 메시지 목록
   * @param tools 사용 가능한 도구 정의
   * @returns LLM 응답
   */
  async chat(
    messages: Message[],
    tools?: ToolDefinition[],
  ): Promise<LLMResponse> {
    try {
      if (this.config.provider === "anthropic") {
        return await this.chatAnthropic(messages, tools);
      }

      if (this.config.provider === "google") {
        return await this.chatGeminiNative(messages, tools);
      }

      if (!this.openaiClient) {
        throw new LLMError(this.config.provider, "OpenAI client not initialized for this provider");
      }

      const params: OpenAI.Chat.ChatCompletionCreateParams = {
        model: this.model,
        messages: messages.map((m) => this.toOpenAIMessage(m)),
        ...(tools && tools.length > 0
          ? { tools: tools.map((t) => this.toOpenAITool(t)) }
          : {}),
      };

      const response =
        await this.openaiClient.chat.completions.create(params);
      const choice = response.choices[0];

      return {
        content: choice?.message?.content ?? null,
        toolCalls: this.parseOpenAIToolCalls(choice?.message?.tool_calls),
        usage: {
          input: response.usage?.prompt_tokens ?? 0,
          output: response.usage?.completion_tokens ?? 0,
        },
        finishReason: choice?.finish_reason ?? "stop",
      };
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  /**
   * LLM에 메시지 전송 (streaming).
   * @param messages 대화 메시지 목록
   * @param tools 사용 가능한 도구 정의
   * @returns 비동기 이터레이터
   */
  async *chatStream(
    messages: Message[],
    tools?: ToolDefinition[],
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LLMStreamChunk> {
    try {
      if (this.config.provider === "anthropic") {
        yield* this.chatStreamAnthropic(messages, tools, abortSignal);
        return;
      }

      // Native Gemini API — exposes thinking/reasoning parts not available via OpenAI gateway
      if (this.config.provider === "google") {
        yield* this.chatStreamGeminiNative(messages, tools, abortSignal);
        return;
      }

      if (!this.openaiClient) {
        throw new LLMError(this.config.provider, "OpenAI client not initialized for this provider");
      }

      const params: OpenAI.Chat.ChatCompletionCreateParams = {
        model: this.model,
        messages: messages.map((m) => this.toOpenAIMessage(m)),
        stream: true,
        stream_options: { include_usage: true },
        ...(tools && tools.length > 0
          ? { tools: tools.map((t) => this.toOpenAITool(t)) }
          : {}),
      };

      const stream =
        await this.openaiClient.chat.completions.create(params, { signal: abortSignal });

      const toolCallAccumulators = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      // id → index mapping: Gemini may omit index but always sends id
      const idToIndex = new Map<string, number>();
      let nextFallbackIndex = 0;
      let inputTokens = 0;
      let outputTokens = 0;

      for await (const chunk of stream as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>) {
        try {
          const choice = chunk.choices?.[0];
          const delta = choice?.delta as Record<string, unknown> | undefined;

          if (delta) {
            for (const reasoningChunk of this.extractOpenAICompatibleReasoning(delta)) {
              yield reasoningChunk;
            }
          }

          // Text delta
          if (typeof delta?.content === "string" && delta.content.length > 0) {
            yield { type: "text", text: delta.content };
          }

          // Tool call deltas
         const toolCallDeltas = Array.isArray(delta?.tool_calls)
           ? (delta.tool_calls as Array<{
               index?: number;
                id?: string;
                function?: {
                  name?: string;
                  arguments?: string;
                };
              }>)
            : [];

          for (const tc of toolCallDeltas) {
              // Resolve index: prefer explicit index, then id-based mapping, then auto-increment
              let idx: number;
              if (tc.index !== undefined) {
                idx = tc.index;
              } else if (tc.id && idToIndex.has(tc.id)) {
                idx = idToIndex.get(tc.id)!;
              } else if (tc.id) {
                idx = nextFallbackIndex++;
                idToIndex.set(tc.id, idx);
              } else {
                idx = 0;
              }

              if (!toolCallAccumulators.has(idx)) {
                toolCallAccumulators.set(idx, {
                 id: tc.id ?? `call_${idx}_${Date.now()}`,
                  name: tc.function?.name ?? "",
                  arguments: "",
                });
              }
              const acc = toolCallAccumulators.get(idx)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments)
                acc.arguments += tc.function.arguments;
          }

          // Usage (final chunk)
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens ?? 0;
            outputTokens = chunk.usage.completion_tokens ?? 0;
          }
        } catch (chunkErr) {
          // Skip malformed chunks to preserve accumulated tool calls
          console.warn("[BYOKClient] Skipping bad stream chunk:", chunkErr);
        }
      }

      // Emit accumulated tool calls
      for (const [, acc] of toolCallAccumulators) {
        yield {
          type: "tool_call",
          toolCall: {
            id: acc.id || randomUUID(),
            name: acc.name,
            arguments: acc.arguments,
          },
        };
      }

      yield {
        type: "done",
        usage: { input: inputTokens, output: outputTokens },
      };
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  /**
   * Anthropic Messages API 호출 (non-streaming).
   * Anthropic은 OpenAI 호환이 아니므로 직접 변환.
   */
  private async chatAnthropic(
    messages: Message[],
    tools?: ToolDefinition[],
  ): Promise<LLMResponse> {
    const systemMessages = messages.filter((m) => m.role === "system");
    const systemTexts = systemMessages
      .map((m) => typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n") : ""))
      .filter(Boolean);

    // Build system content with cache_control for Anthropic prompt caching
    const systemPayload = this.buildAnthropicSystemPayload(systemTexts);
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 8192,
      ...(systemPayload ? { system: systemPayload } : {}),
      messages: nonSystemMessages.map((m) => this.toAnthropicMessage(m)),
      ...(tools && tools.length > 0
        ? {
            tools: tools.map((t, i) => {
              const anthropicTool = this.toAnthropicTool(t);
              // Cache the last tool definition for prompt caching
              if (i === tools.length - 1) {
                (anthropicTool as Record<string, unknown>).cache_control = { type: "ephemeral" };
              }
              return anthropicTool;
            }),
          }
        : {}),
    };

    const response = await fetch(
      `${this.config.baseUrl ?? PROVIDER_BASE_URLS.anthropic}/v1/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31",
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new LLMError("anthropic", text, response.status);
    }

    const data = (await response.json()) as Record<string, unknown>;
    return this.parseAnthropicResponse(data);
  }

  /**
   * Anthropic Messages API 호출 (streaming).
   */
  private async *chatStreamAnthropic(
    messages: Message[],
    tools?: ToolDefinition[],
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LLMStreamChunk> {
    const systemMessages = messages.filter((m) => m.role === "system");
    const systemTexts = systemMessages
      .map((m) => typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n") : ""))
      .filter(Boolean);

    // Build system content with cache_control for Anthropic prompt caching
    const systemPayload = this.buildAnthropicSystemPayload(systemTexts);
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 8192,
      stream: true,
      ...(systemPayload ? { system: systemPayload } : {}),
      messages: nonSystemMessages.map((m) => this.toAnthropicMessage(m)),
      ...(tools && tools.length > 0
        ? {
            tools: tools.map((t, i) => {
              const anthropicTool = this.toAnthropicTool(t);
              // Cache the last tool definition for prompt caching
              if (i === tools.length - 1) {
                (anthropicTool as Record<string, unknown>).cache_control = { type: "ephemeral" };
              }
              return anthropicTool;
            }),
          }
        : {}),
    };

    const response = await fetch(
      `${this.config.baseUrl ?? PROVIDER_BASE_URLS.anthropic}/v1/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31",
        },
        body: JSON.stringify(body),
        signal: abortSignal,
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new LLMError("anthropic", text, response.status);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new LLMError("anthropic", "No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let currentToolId = "";
    let currentToolName = "";
    let currentToolArgs = "";
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === "[DONE]") continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            continue;
          }

          const eventType = event.type as string | undefined;

          if (eventType === "content_block_start") {
            const cb = event.content_block as
              | Record<string, unknown>
              | undefined;
            if (cb?.type === "tool_use") {
              currentToolId = (cb.id as string) ?? "";
              currentToolName = (cb.name as string) ?? "";
              currentToolArgs = "";
            }
          } else if (eventType === "content_block_delta") {
            const delta = event.delta as Record<string, unknown> | undefined;
            if (delta?.type === "text_delta") {
              yield { type: "text", text: delta.text as string };
            }
            else if (delta?.type === "thinking_delta") {
              const reasoningChunk = this.buildReasoningChunk(
                delta.thinking,
                typeof event.index === "number" ? String(event.index) : undefined,
              );
              if (reasoningChunk) {
    yield {
      ...reasoningChunk,
      reasoning: {
        ...reasoningChunk.reasoning!,
        provider: "anthropic",
      },
    };
              }
            }
            else if (delta?.type === "input_json_delta") {
              currentToolArgs += (delta.partial_json as string) ?? "";
            }
          } else if (eventType === "content_block_stop") {
            if (currentToolId) {
              yield {
                type: "tool_call",
                toolCall: {
                  id: currentToolId,
                  name: currentToolName,
                  arguments: currentToolArgs,
                },
              };
              currentToolId = "";
              currentToolName = "";
              currentToolArgs = "";
            }
          } else if (eventType === "message_delta") {
            const usage = event.usage as
              | Record<string, number>
              | undefined;
            if (usage?.output_tokens) {
              outputTokens = usage.output_tokens;
            }
          } else if (eventType === "message_start") {
            const message = event.message as
              | Record<string, unknown>
              | undefined;
            const usage = message?.usage as
              | Record<string, number>
              | undefined;
            if (usage?.input_tokens) {
              inputTokens = usage.input_tokens;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield {
      type: "done",
      usage: { input: inputTokens, output: outputTokens },
    };
  }

  // ─── Format Converters ───

  private toOpenAIMessage(
    msg: Message,
  ): OpenAI.Chat.ChatCompletionMessageParam {
    if (msg.role === "tool") {
      return {
        role: "tool",
        content: contentToString(msg.content),
        tool_call_id: msg.tool_call_id ?? "",
      };
    }

    if (msg.role === "assistant" && msg.tool_calls?.length) {
      return {
        role: "assistant",
        content: typeof msg.content === "string" ? msg.content : null,
        tool_calls: msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments:
              typeof tc.arguments === "string"
                ? tc.arguments
                : JSON.stringify(tc.arguments),
          },
        })),
      };
    }

    // 멀티모달 콘텐츠 블록 처리 (user/system)
    if (Array.isArray(msg.content)) {
      const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          parts.push({
            type: "image_url",
            image_url: {
              url: `data:${block.mediaType};base64,${block.data}`,
            },
          });
        } else if (block.type === "file") {
          const lang = block.language || "";
          parts.push({
            type: "text",
            text: `--- File: ${block.name} ---\n\`\`\`${lang}\n${block.content}\n\`\`\``,
          });
        }
      }
      return {
        role: msg.role as "user" | "system",
        content: parts as any,
      } as OpenAI.Chat.ChatCompletionMessageParam;
    }

    return {
      role: msg.role as "system" | "user" | "assistant",
      content: msg.content ?? "",
    };
  }

  private toOpenAITool(
    tool: ToolDefinition,
  ): OpenAI.Chat.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as OpenAI.FunctionParameters,
      },
    };
  }

  private parseOpenAIToolCalls(
    toolCalls?: OpenAI.Chat.ChatCompletionMessageToolCall[],
  ): ToolCall[] {
    if (!toolCalls) return [];
    return toolCalls
      .filter((tc): tc is OpenAI.Chat.ChatCompletionMessageToolCall & { type: "function" } =>
        tc.type === "function",
      )
      .map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));
  }

  private toAnthropicMessage(
    msg: Message,
  ): Record<string, unknown> {
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      const content: unknown[] = [];
      if (msg.content) {
        const textContent = typeof msg.content === "string"
          ? msg.content
          : msg.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n");
        if (textContent) {
          content.push({ type: "text", text: textContent });
        }
      }
      for (const tc of msg.tool_calls) {
        let input: unknown;
        if (typeof tc.arguments === "string") {
          try {
            input = JSON.parse(tc.arguments);
          } catch {
            input = tc.arguments;
          }
        } else {
          input = tc.arguments;
        }
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input,
        });
      }
      return { role: "assistant", content };
    }

    if (msg.role === "tool") {
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id,
            content: typeof msg.content === "string" ? msg.content : (msg.content ?? ""),
          },
        ],
      };
    }

    // 멀티모달 콘텐츠 블록 처리
    if (Array.isArray(msg.content)) {
      const parts: unknown[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          parts.push({
            type: "image",
            source: {
              type: "base64",
              media_type: block.mediaType,
              data: block.data,
            },
          });
        } else if (block.type === "file") {
          const lang = block.language || "";
          parts.push({
            type: "text",
            text: `--- File: ${block.name} ---\n\`\`\`${lang}\n${block.content}\n\`\`\``,
          });
        }
      }
      return {
        role: msg.role === "system" ? "user" : msg.role,
        content: parts,
      };
    }

    return {
      role: msg.role === "system" ? "user" : msg.role,
      content: msg.content ?? "",
    };
  }

  /**
   * Build system payload with cache_control markers for Anthropic prompt caching.
   *
   * CAG (Cache-Augmented Generation) strategy:
   * - "Cold" data (stable across tasks): system prompt, YUAN.md, project conventions, memory
   *   → mark with cache_control (Anthropic caches up to 4 checkpoints)
   * - "Hot" data (per-task dynamic): RAG hits, task memory, reflexion guidance
   *   → no cache_control (always fresh retrieval)
   *
   * Heuristic: cache the first ceil(N/2) blocks (injected first = more stable),
   * leave the later half uncached (injected later = task-specific hot data).
   * Max 4 cache checkpoints per Anthropic API constraint.
   */
  private buildAnthropicSystemPayload(
    systemTexts: string[],
  ): Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> | undefined {
    if (systemTexts.length === 0) return undefined;

    // Single block: always cache (it's the base system prompt)
    if (systemTexts.length === 1) {
      return [
        { type: "text" as const, text: systemTexts[0], cache_control: { type: "ephemeral" as const } },
      ];
    }

    // Multiple blocks: cache stable cold-data blocks, leave hot-data blocks uncached.
    // Cold = first ceil(N/2) blocks (base prompt + YUAN.md + memory learnings)
    // Hot  = remaining blocks (per-task RAG, getRelevant, reflexion guidance)
    // Anthropic supports max 4 cache_control checkpoints.
    const coldCount = Math.min(Math.ceil(systemTexts.length / 2), 4);

    return systemTexts.map((text, i) => {
      const block: { type: "text"; text: string; cache_control?: { type: "ephemeral" } } = {
        type: "text" as const,
        text,
      };
      if (i < coldCount) {
        block.cache_control = { type: "ephemeral" as const };
      }
      return block;
    });
  }

  private toAnthropicTool(
    tool: ToolDefinition,
  ): Record<string, unknown> {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    };
  }

  private parseAnthropicResponse(
    data: Record<string, unknown>,
  ): LLMResponse {
    const content = data.content as Array<Record<string, unknown>>;
    const usage = data.usage as Record<string, number> | undefined;

    let text: string | null = null;
    const toolCalls: ToolCall[] = [];

    for (const block of content) {
      if (block.type === "text") {
        text = (text ?? "") + (block.text as string);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id as string,
          name: block.name as string,
          arguments: JSON.stringify(block.input),
        });
      }
    }

    return {
      content: text,
      toolCalls,
      usage: {
        input: usage?.input_tokens ?? 0,
        output: usage?.output_tokens ?? 0,
      },
      finishReason:
        (data.stop_reason as string) ?? "end_turn",
    };
  }

  /**
   * Native Gemini REST API streaming — uses the `generateContent` endpoint directly
   * instead of the OpenAI-compatible gateway. This unlocks native thinking/reasoning
   * parts (parts with `thought: true`) that the OpenAI gateway does not expose.
   *
   * Endpoint: https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent
   * Auth: API key via `?key=` query param
   */
  private async *chatStreamGeminiNative(
    messages: Message[],
    tools?: ToolDefinition[],
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LLMStreamChunk> {
    const apiKey = this.config.apiKey;
    const baseUrl =
      this.config.baseUrl?.replace(/\/openai\/?$/, "") ??
      "https://generativelanguage.googleapis.com/v1beta";
    const endpoint = `${baseUrl}/models/${this.model}:streamGenerateContent?alt=sse&key=${apiKey}`;

    // Convert messages to Gemini format
    const systemParts: string[] = [];
    const geminiContents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];

    for (const msg of messages) {
      const textContent =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((b): b is { type: "text"; text: string } => b.type === "text")
                .map((b) => b.text)
                .join("\n")
            : "";

      if (msg.role === "system") {
        if (textContent) systemParts.push(textContent);
        continue;
      }

      if (msg.role === "tool") {
        // Tool results — may be plain text, functionResponse blocks, or image ContentBlocks
        if (Array.isArray(msg.content)) {
          const contentBlocks = msg.content as Array<{ type: string; [k: string]: unknown }>;
          // Check if this is a vision tool result (image ContentBlocks)
          const hasImageBlocks = contentBlocks.some((b) => b.type === "image");
          if (hasImageBlocks) {
            const parts: Array<Record<string, unknown>> = [];
            for (const block of contentBlocks) {
              if (block.type === "image") {
                parts.push({
                  inlineData: {
                    mimeType: block.mediaType,
                    data: block.data,
                  },
                });
              } else if (block.type === "text" && typeof block.text === "string" && block.text) {
                parts.push({ text: block.text });
              }
            }
            if (parts.length > 0) {
              geminiContents.push({ role: "user", parts });
            }
          } else {
            // functionResponse blocks
            const toolResultBlocks = contentBlocks as Array<{ type: string; tool_use_id?: string; content?: unknown }>;
            const parts = toolResultBlocks
              .filter((b) => b.type === "tool_result")
              .map((b) => ({
                functionResponse: {
                  name: (b as Record<string, unknown>).name ?? "tool",
                  response: { content: b.content ?? "" },
                },
              }));
            if (parts.length > 0) {
              geminiContents.push({ role: "user", parts });
            }
          }
        } else if (typeof msg.content === "string" && msg.content) {
          geminiContents.push({ role: "user", parts: [{ text: msg.content }] });
        }
        continue;
      }

      const role = msg.role === "assistant" ? "model" : "user";

      // Check for tool calls in assistant messages
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const parts: Array<Record<string, unknown>> = [];
        for (const block of msg.content as Array<{ type: string; [k: string]: unknown }>) {
          if (block.type === "text" && typeof block.text === "string" && block.text) {
            parts.push({ text: block.text });
          } else if (block.type === "tool_use") {
            parts.push({
              functionCall: {
                name: block.name,
                args: block.input ?? {},
              },
            });
          }
        }
        if (parts.length > 0) geminiContents.push({ role, parts });
        continue;
      }

      // User messages with ContentBlock[] — may include image blocks
      if (Array.isArray(msg.content)) {
        const parts: Array<Record<string, unknown>> = [];
        for (const block of msg.content as Array<{ type: string; [k: string]: unknown }>) {
          if (block.type === "text" && typeof block.text === "string" && block.text) {
            parts.push({ text: block.text });
          } else if (block.type === "image") {
            parts.push({
              inlineData: {
                mimeType: block.mediaType,
                data: block.data,
              },
            });
          }
        }
        if (parts.length > 0) geminiContents.push({ role, parts });
        continue;
      }

      if (textContent) {
        geminiContents.push({ role, parts: [{ text: textContent }] });
      }
    }

    // Build Gemini tool declarations
    // Strip JSON Schema fields unsupported by Gemini API (additionalProperties, $schema, etc.)
    const stripGeminiUnsupported = (schema: Record<string, unknown>): Record<string, unknown> => {
      const UNSUPPORTED = new Set(["additionalProperties", "$schema", "$defs", "definitions", "default", "examples", "$id", "$ref"]);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema)) {
        if (UNSUPPORTED.has(k)) continue;
        if (k === "properties" && v && typeof v === "object") {
          const stripped: Record<string, unknown> = {};
          for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
            stripped[pk] = pv && typeof pv === "object" ? stripGeminiUnsupported(pv as Record<string, unknown>) : pv;
          }
          out[k] = stripped;
        } else if (k === "items" && v && typeof v === "object") {
          out[k] = stripGeminiUnsupported(v as Record<string, unknown>);
        } else {
          out[k] = v;
        }
      }
      return out;
    };

    const functionDeclarations = tools?.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: stripGeminiUnsupported(t.parameters as Record<string, unknown>),
    }));

    const body: Record<string, unknown> = {
      contents: geminiContents,
      ...(systemParts.length > 0
        ? { systemInstruction: { parts: systemParts.map((t) => ({ text: t })) } }
        : {}),
      ...(functionDeclarations && functionDeclarations.length > 0
        ? { tools: [{ functionDeclarations }] }
        : {}),
      generationConfig: {
        maxOutputTokens: 8192,
        thinkingConfig: {
          thinkingBudget: 8192,
          includeThoughts: true,
        },
      },
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abortSignal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new LLMError("google", `Gemini API error ${response.status}: ${errText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new LLMError("google", "No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    const pendingToolCalls = new Map<string, { name: string; args: Record<string, unknown> }>();
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]" || !jsonStr) continue;

          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(jsonStr) as Record<string, unknown>;
          } catch {
            continue;
          }

          // Extract usage from usageMetadata
          const usage = chunk.usageMetadata as Record<string, unknown> | undefined;
          if (usage) {
            inputTokens = (usage.promptTokenCount as number) ?? inputTokens;
            outputTokens = (usage.candidatesTokenCount as number) ?? outputTokens;
          }

          const candidates = (chunk.candidates as Array<Record<string, unknown>>) ?? [];
          for (const candidate of candidates) {
            const content = candidate.content as Record<string, unknown> | undefined;
            const parts = (content?.parts as Array<Record<string, unknown>>) ?? [];

            for (const part of parts) {
              // Thinking part (native reasoning)
              if (part.thought === true && typeof part.text === "string" && part.text) {
                const rc = this.buildReasoningChunk(part.text);
                if (rc) yield rc;
                continue;
              }

              // Text part
              if (typeof part.text === "string" && part.text) {
                yield { type: "text", text: part.text };
                continue;
              }

              // Function call part
              const fc = part.functionCall as Record<string, unknown> | undefined;
              if (fc && typeof fc.name === "string") {
                const callId = `call_gemini_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                pendingToolCalls.set(callId, {
                  name: fc.name,
                  args: (fc.args as Record<string, unknown>) ?? {},
                });
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Emit accumulated tool calls
    for (const [callId, tc] of pendingToolCalls) {
      yield {
        type: "tool_call",
        toolCall: {
          id: callId,
          name: tc.name,
          arguments: tc.args,
        },
      };
    }

    yield { type: "done", usage: { input: inputTokens, output: outputTokens } };
  }

  /**
   * Native Gemini REST API non-streaming — uses the `generateContent` endpoint directly.
   * Mirror of chatStreamGeminiNative but calls generateContent instead of streamGenerateContent.
   */
  private async chatGeminiNative(
    messages: Message[],
    tools?: ToolDefinition[],
  ): Promise<LLMResponse> {
    const apiKey = this.config.apiKey;
    const baseUrl =
      this.config.baseUrl?.replace(/\/openai\/?$/, "") ??
      "https://generativelanguage.googleapis.com/v1beta";
    const endpoint = `${baseUrl}/models/${this.model}:generateContent?key=${apiKey}`;

    // Convert messages to Gemini format (same logic as chatStreamGeminiNative)
    const systemParts: string[] = [];
    const geminiContents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];

    for (const msg of messages) {
      const textContent =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((b): b is { type: "text"; text: string } => b.type === "text")
                .map((b) => b.text)
                .join("\n")
            : "";

      if (msg.role === "system") {
        if (textContent) systemParts.push(textContent);
        continue;
      }

      if (msg.role === "tool") {
        if (Array.isArray(msg.content)) {
          const contentBlocks = msg.content as Array<{ type: string; [k: string]: unknown }>;
          const hasImageBlocks = contentBlocks.some((b) => b.type === "image");
          if (hasImageBlocks) {
            const parts: Array<Record<string, unknown>> = [];
            for (const block of contentBlocks) {
              if (block.type === "image") {
                parts.push({
                  inlineData: {
                    mimeType: block.mediaType,
                    data: block.data,
                  },
                });
              } else if (block.type === "text" && typeof block.text === "string" && block.text) {
                parts.push({ text: block.text });
              }
            }
            if (parts.length > 0) {
              geminiContents.push({ role: "user", parts });
            }
          } else {
            const toolResultBlocks = contentBlocks as Array<{ type: string; tool_use_id?: string; content?: unknown }>;
            const parts = toolResultBlocks
              .filter((b) => b.type === "tool_result")
              .map((b) => ({
                functionResponse: {
                  name: (b as Record<string, unknown>).name ?? "tool",
                  response: { content: b.content ?? "" },
                },
              }));
            if (parts.length > 0) {
              geminiContents.push({ role: "user", parts });
            }
          }
        } else if (typeof msg.content === "string" && msg.content) {
          geminiContents.push({ role: "user", parts: [{ text: msg.content }] });
        }
        continue;
      }

      const role = msg.role === "assistant" ? "model" : "user";

      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const parts: Array<Record<string, unknown>> = [];
        for (const block of msg.content as Array<{ type: string; [k: string]: unknown }>) {
          if (block.type === "text" && typeof block.text === "string" && block.text) {
            parts.push({ text: block.text });
          } else if (block.type === "tool_use") {
            parts.push({
              functionCall: {
                name: block.name,
                args: block.input ?? {},
              },
            });
          }
        }
        if (parts.length > 0) geminiContents.push({ role, parts });
        continue;
      }

      if (Array.isArray(msg.content)) {
        const parts: Array<Record<string, unknown>> = [];
        for (const block of msg.content as Array<{ type: string; [k: string]: unknown }>) {
          if (block.type === "text" && typeof block.text === "string" && block.text) {
            parts.push({ text: block.text });
          } else if (block.type === "image") {
            parts.push({
              inlineData: {
                mimeType: block.mediaType,
                data: block.data,
              },
            });
          }
        }
        if (parts.length > 0) geminiContents.push({ role, parts });
        continue;
      }

      if (textContent) {
        geminiContents.push({ role, parts: [{ text: textContent }] });
      }
    }

    // Build Gemini tool declarations (same stripping logic as streaming)
    const stripGeminiUnsupported = (schema: Record<string, unknown>): Record<string, unknown> => {
      const UNSUPPORTED = new Set(["additionalProperties", "$schema", "$defs", "definitions", "default", "examples", "$id", "$ref"]);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema)) {
        if (UNSUPPORTED.has(k)) continue;
        if (k === "properties" && v && typeof v === "object") {
          const stripped: Record<string, unknown> = {};
          for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
            stripped[pk] = pv && typeof pv === "object" ? stripGeminiUnsupported(pv as Record<string, unknown>) : pv;
          }
          out[k] = stripped;
        } else if (k === "items" && v && typeof v === "object") {
          out[k] = stripGeminiUnsupported(v as Record<string, unknown>);
        } else {
          out[k] = v;
        }
      }
      return out;
    };

    const functionDeclarations = tools?.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: stripGeminiUnsupported(t.parameters as Record<string, unknown>),
    }));

    const body: Record<string, unknown> = {
      contents: geminiContents,
      ...(systemParts.length > 0
        ? { systemInstruction: { parts: systemParts.map((t) => ({ text: t })) } }
        : {}),
      ...(functionDeclarations && functionDeclarations.length > 0
        ? { tools: [{ functionDeclarations }] }
        : {}),
      generationConfig: {
        maxOutputTokens: 8192,
      },
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new LLMError("google", `Gemini API error ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as Record<string, unknown>;

    // Parse Gemini generateContent response
    const candidates = (data.candidates as Array<Record<string, unknown>>) ?? [];
    const usageMetadata = data.usageMetadata as Record<string, unknown> | undefined;

    let textContent: string | null = null;
    const toolCalls: ToolCall[] = [];

    for (const candidate of candidates) {
      const content = candidate.content as Record<string, unknown> | undefined;
      const parts = (content?.parts as Array<Record<string, unknown>>) ?? [];
      for (const part of parts) {
        if (typeof part.text === "string" && part.text) {
          textContent = (textContent ?? "") + part.text;
        }
        const fc = part.functionCall as Record<string, unknown> | undefined;
        if (fc && typeof fc.name === "string") {
          const callId = `call_gemini_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          toolCalls.push({
            id: callId,
            name: fc.name,
            arguments: (fc.args as Record<string, unknown>) ?? {},
          });
        }
      }
    }

    const firstCandidate = candidates[0] as Record<string, unknown> | undefined;
    const finishReason = (firstCandidate?.finishReason as string) ?? "STOP";

    return {
      content: textContent,
      toolCalls,
      usage: {
        input: (usageMetadata?.promptTokenCount as number) ?? 0,
        output: (usageMetadata?.candidatesTokenCount as number) ?? 0,
      },
      finishReason,
    };
  }

  /**
   * 리소스 정리. 내부 클라이언트 참조를 해제한다.
   */
  destroy(): void {
    // Clear the OpenAI client reference to allow GC
    this.openaiClient = null;
  }

  // ─── Helpers ───

  private buildReasoningChunk(
    text: unknown,
    id?: string,
  ): LLMStreamChunk | null {
    if (typeof text !== "string") return null;
  const normalized = text;
  if (!normalized || normalized.length === 0) return null;

    return {
      type: "reasoning",
      reasoning: {
       id: id ?? `reasoning-${Date.now()}`,
        text: normalized,
        provider: this.config.provider,
        model: this.model,
        source: "llm",
      },
    };
  }

  /**
   * OpenAI-compatible / YUA / Google(OpenAI-compatible gateway) 스트림에서
   * reasoning 유사 필드를 최대한 느슨하게 흡수한다.
   *
   * 주의:
   * - provider가 실제로 reasoning delta를 보내지 않으면 아무것도 emit하지 않는다.
   * - 일반 text(delta.content)는 reasoning으로 취급하지 않는다.
   */
  private extractOpenAICompatibleReasoning(
    delta: Record<string, unknown>,
  ): LLMStreamChunk[] {
    const rawCandidates: unknown[] = [
      delta.reasoning,
      delta.reasoning_text,
      delta.reasoning_content,
      delta.thinking,
      delta.thinking_delta,
    ];

    const chunks: LLMStreamChunk[] = [];
  if (!(this as any)._reasoningSeen) {
    (this as any)._reasoningSeen = new Set<string>();
  }

  const seen: Set<string> = (this as any)._reasoningSeen;

    const pushCandidate = (value: unknown): void => {
      if (value == null) return;

      if (typeof value === "string") {
        const chunk = this.buildReasoningChunk(value);
        if (chunk && !seen.has(chunk.reasoning!.text)) {
          seen.add(chunk.reasoning!.text);
          chunks.push(chunk);
        }
        return;
      }

      if (Array.isArray(value)) {
        for (const item of value) pushCandidate(item);
        return;
      }

      if (typeof value !== "object") return;

      const obj = value as Record<string, unknown>;
      pushCandidate(obj.text);
      pushCandidate(obj.reasoning);
      pushCandidate(obj.thinking);
      pushCandidate(obj.reasoning_text);
    };

    for (const candidate of rawCandidates) {
      pushCandidate(candidate);
    }

    return chunks;
  }
  private getBaseUrl(provider: LLMProvider): string {
    return PROVIDER_BASE_URLS[provider];
  }

  private getDefaultHeaders(
    provider: LLMProvider,
  ): Record<string, string> {
    if (provider === "anthropic") {
      return {
        "anthropic-version": "2023-06-01",
      };
    }
    if (provider === "yua") {
      return {
        "x-api-key": this.config.apiKey,
      };
    }

 if (provider === "google") {
   return {
     Authorization: `Bearer ${this.config.apiKey}`,
   };
 }
    return {};
  }

  private wrapError(err: unknown): LLMError {
    if (err instanceof LLMError) return err;
    const message = err instanceof Error ? err.message : String(err);
    const statusCode =
      err instanceof OpenAI.APIError ? err.status : undefined;
    return new LLMError(this.config.provider, message, statusCode);
  }
}
