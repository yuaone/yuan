/**
 * @module llm-client
 * @description BYOK LLM API 클라이언트 — OpenAI/Anthropic/Google 호출 추상화
 *
 * openai SDK를 사용하여 OpenAI 호환 포맷으로 통신.
 * Anthropic/Google은 별도 포맷 변환 후 호출.
 */

import OpenAI from "openai";
import type {
  BYOKConfig,
  LLMProvider,
  Message,
  ToolCall,
  ToolDefinition,
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
  type: "text" | "tool_call" | "done";
  /** 텍스트 델타 (type=text) */
  text?: string;
  /** 도구 호출 정보 (type=tool_call, 완료 시) */
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
  private readonly openaiClient: OpenAI | null;

  constructor(config: BYOKConfig) {
    this.config = config;
    this.model = config.model ?? MODEL_DEFAULTS[config.provider];

    // Anthropic uses native fetch — skip OpenAI SDK instance
    if (config.provider === "anthropic") {
      this.openaiClient = null;
    } else {
      this.openaiClient = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl ?? this.getBaseUrl(config.provider),
        defaultHeaders: this.getDefaultHeaders(config.provider),
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
          const delta = chunk.choices[0]?.delta;

          // Text delta
          if (delta?.content) {
            yield { type: "text", text: delta.content };
          }

          // Tool call deltas
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCallAccumulators.has(idx)) {
                toolCallAccumulators.set(idx, {
                  id: tc.id ?? "",
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
            id: acc.id,
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
    const systemMessage = messages.find((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 8192,
      ...(systemMessage?.content ? { system: systemMessage.content } : {}),
      messages: nonSystemMessages.map((m) => this.toAnthropicMessage(m)),
      ...(tools && tools.length > 0
        ? { tools: tools.map((t) => this.toAnthropicTool(t)) }
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
    const systemMessage = messages.find((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 8192,
      stream: true,
      ...(systemMessage?.content ? { system: systemMessage.content } : {}),
      messages: nonSystemMessages.map((m) => this.toAnthropicMessage(m)),
      ...(tools && tools.length > 0
        ? { tools: tools.map((t) => this.toAnthropicTool(t)) }
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
        const lines = buffer.split("\n");
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
            } else if (delta?.type === "input_json_delta") {
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
        content: msg.content ?? "",
        tool_call_id: msg.tool_call_id ?? "",
      };
    }

    if (msg.role === "assistant" && msg.tool_calls?.length) {
      return {
        role: "assistant",
        content: msg.content ?? null,
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
        content.push({ type: "text", text: msg.content });
      }
      for (const tc of msg.tool_calls) {
        let input: unknown;
        if (typeof tc.arguments === "string") {
          try {
            input = JSON.parse(tc.arguments);
          } catch {
            // If arguments is malformed JSON, pass raw string as-is
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
            content: msg.content ?? "",
          },
        ],
      };
    }

    return {
      role: msg.role === "system" ? "user" : msg.role,
      content: msg.content ?? "",
    };
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

  // ─── Helpers ───

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
