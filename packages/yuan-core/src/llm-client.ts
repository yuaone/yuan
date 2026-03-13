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
  ): AsyncGenerator<LLMStreamChunk> {
    try {
      if (this.config.provider === "anthropic") {
        yield* this.chatStreamAnthropic(messages, tools);
        return;
      }

      if (!this.openaiClient) {
        throw new LLMError(this.config.provider, "OpenAI client not initialized for this provider");
      }

      const params: OpenAI.Chat.ChatCompletionCreateParams = {
        model: this.model,
        messages: messages.map((m) => this.toOpenAIMessage(m)),
        stream: true,
        ...(tools && tools.length > 0
          ? { tools: tools.map((t) => this.toOpenAITool(t)) }
          : {}),
      };

      const stream =
        await this.openaiClient.chat.completions.create(params);

      const toolCallAccumulators = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
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
              const idx = tc.index ?? 0;
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
   * Caches the first block (stable base prompt) to maximize token savings.
   */
  private buildAnthropicSystemPayload(
    systemTexts: string[],
  ): Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> | undefined {
    if (systemTexts.length === 0) return undefined;

    if (systemTexts.length === 1) {
      return [
        { type: "text" as const, text: systemTexts[0], cache_control: { type: "ephemeral" as const } },
      ];
    }

    // Multiple system messages: cache the first block (stable base prompt)
    // Anthropic caches everything up to the cache_control marker
    return systemTexts.map((text, i) => {
      const block: { type: "text"; text: string; cache_control?: { type: "ephemeral" } } = {
        type: "text" as const,
        text,
      };
      if (i === 0) {
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
