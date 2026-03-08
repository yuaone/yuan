/**
 * @module agent-loop
 * @description 메인 Agent Loop — LLM ↔ Tool 반복 실행 엔진.
 *
 * while 루프로 LLM 호출 → tool_use 파싱 → tool 실행 → 결과 피드백을 반복.
 * Governor가 반복 제한/안전 검증을 담당하고,
 * ContextManager가 컨텍스트 윈도우를 관리한다.
 */

import { EventEmitter } from "node:events";
import type {
  AgentConfig,
  AgentEvent,
  AgentTermination,
  Message,
  ToolCall,
  ToolResult,
  ToolExecutor,
  TokenUsage,
} from "./types.js";
import { BYOKClient, type LLMResponse } from "./llm-client.js";
import { Governor, type GovernorConfig } from "./governor.js";
import { ContextManager, type ContextManagerConfig } from "./context-manager.js";
import {
  YuanError,
  ToolError,
  LLMError,
  PlanLimitError,
  ApprovalRequiredError,
} from "./errors.js";

/** AgentLoop 설정 */
export interface AgentLoopOptions {
  /** 에이전트 설정 */
  config: AgentConfig;
  /** 도구 실행기 */
  toolExecutor: ToolExecutor;
  /** Governor 설정 (planTier 등) */
  governorConfig: GovernorConfig;
  /** ContextManager 설정 */
  contextConfig?: Partial<ContextManagerConfig>;
}

/**
 * AgentLoop — YUAN 에이전트의 핵심 실행 루프.
 *
 * 동작 흐름:
 * 1. 사용자 메시지 수신
 * 2. 시스템 프롬프트 + 히스토리로 LLM 호출
 * 3. LLM 응답에서 tool_call 파싱
 * 4. Governor가 안전성 검증
 * 5. 도구 실행 → 결과를 히스토리에 추가
 * 6. LLM에 결과 피드백 → 2번으로 반복
 * 7. 종료 조건 충족 시 결과 반환
 *
 * @example
 * ```typescript
 * const loop = new AgentLoop({
 *   config: agentConfig,
 *   toolExecutor: executor,
 *   governorConfig: { planTier: "PRO" },
 * });
 *
 * loop.on("event", (event: AgentEvent) => {
 *   // SSE 스트리밍
 * });
 *
 * const result = await loop.run("모든 console.log를 제거해줘");
 * ```
 */
export class AgentLoop extends EventEmitter {
  private readonly llmClient: BYOKClient;
  private readonly governor: Governor;
  private readonly contextManager: ContextManager;
  private readonly toolExecutor: ToolExecutor;
  private readonly config: AgentConfig;
  private aborted = false;
  private tokenUsage: TokenUsage = {
    input: 0,
    output: 0,
    reasoning: 0,
    total: 0,
  };

  constructor(options: AgentLoopOptions) {
    super();

    this.config = options.config;
    this.toolExecutor = options.toolExecutor;

    // BYOK LLM 클라이언트 생성
    this.llmClient = new BYOKClient(options.config.byok);

    // Governor 생성
    this.governor = new Governor(options.governorConfig);

    // ContextManager 생성
    this.contextManager = new ContextManager({
      maxContextTokens:
        options.contextConfig?.maxContextTokens ??
        options.config.loop.totalTokenBudget,
      outputReserveTokens:
        options.contextConfig?.outputReserveTokens ?? 4096,
      ...options.contextConfig,
    });

    // 시스템 프롬프트 추가
    this.contextManager.addMessage({
      role: "system",
      content: this.config.loop.systemPrompt,
    });
  }

  /**
   * 에이전트 루프를 실행.
   * @param userMessage 사용자의 요청 메시지
   * @returns 종료 사유 및 결과
   */
  async run(userMessage: string): Promise<AgentTermination> {
    this.aborted = false;

    // 사용자 메시지 추가
    this.contextManager.addMessage({
      role: "user",
      content: userMessage,
    });

    this.emitEvent({ kind: "agent:start", goal: userMessage });

    try {
      return await this.executeLoop();
    } catch (err) {
      return this.handleFatalError(err);
    }
  }

  /**
   * 실행 중인 루프를 중단.
   */
  abort(): void {
    this.aborted = true;
  }

  /**
   * 현재 토큰 사용량을 반환.
   */
  getTokenUsage(): Readonly<TokenUsage> {
    return { ...this.tokenUsage };
  }

  /**
   * 대화 히스토리를 반환.
   */
  getHistory(): Message[] {
    return this.contextManager.getMessages();
  }

  // ─── Core Loop ───

  private async executeLoop(): Promise<AgentTermination> {
    let iteration = 0;

    while (!this.aborted) {
      // Governor: iteration 검증
      try {
        this.governor.checkIteration();
      } catch (err) {
        if (err instanceof PlanLimitError) {
          return {
            reason: "MAX_ITERATIONS",
            lastState: `Stopped at iteration ${iteration}: ${err.message}`,
          };
        }
        throw err;
      }

      iteration++;
      const iterationStart = Date.now();

      // 1. 컨텍스트 준비
      const messages = this.contextManager.prepareForLLM();

      // 2. LLM 호출
      this.emitEvent({
        kind: "agent:thinking",
        content: `Iteration ${iteration}...`,
      });

      let response: LLMResponse;
      try {
        response = await this.llmClient.chat(
          messages,
          this.config.loop.tools,
        );
      } catch (err) {
        if (err instanceof LLMError) {
          return { reason: "ERROR", error: err.message };
        }
        throw err;
      }

      // 토큰 추적
      this.tokenUsage.input += response.usage.input;
      this.tokenUsage.output += response.usage.output;
      this.tokenUsage.total += response.usage.input + response.usage.output;
      this.governor.recordIteration(
        response.usage.input,
        response.usage.output,
      );

      this.emitEvent({
        kind: "agent:token_usage",
        input: this.tokenUsage.input,
        output: this.tokenUsage.output,
      });

      // 3. 응답 처리
      if (response.toolCalls.length === 0) {
        // 도구 호출 없음 → 작업 완료
        if (response.content) {
          this.contextManager.addMessage({
            role: "assistant",
            content: response.content,
          });
        }

        this.emitEvent({
          kind: "agent:completed",
          summary: response.content ?? "Task completed.",
          filesChanged: [],
        });

        return {
          reason: "GOAL_ACHIEVED",
          summary: response.content ?? "Task completed.",
        };
      }

      // 어시스턴트 메시지 저장 (tool_calls 포함)
      this.contextManager.addMessage({
        role: "assistant",
        content: response.content,
        tool_calls: response.toolCalls,
      });

      if (response.content) {
        this.emitEvent({
          kind: "agent:thinking",
          content: response.content,
        });
      }

      // 4. 도구 실행
      const toolResults = await this.executeTools(response.toolCalls);

      // 5. 도구 결과를 히스토리에 추가
      for (const result of toolResults) {
        // 큰 결과는 압축
        const compressedOutput = this.contextManager.compressToolResult(
          result.name,
          result.output,
        );

        this.contextManager.addMessage({
          role: "tool",
          content: compressedOutput,
          tool_call_id: result.tool_call_id,
        });
      }

      // iteration 이벤트
      const durationMs = Date.now() - iterationStart;
      this.emitEvent({
        kind: "agent:iteration",
        index: iteration,
        tokensUsed: response.usage.input + response.usage.output,
      });

      // 예산 초과 체크
      if (this.tokenUsage.total >= this.config.loop.totalTokenBudget) {
        return {
          reason: "BUDGET_EXHAUSTED",
          tokensUsed: this.tokenUsage.total,
        };
      }
    }

    // abort된 경우
    return { reason: "USER_CANCELLED" };
  }

  /**
   * 도구 호출 목록을 실행.
   */
  private async executeTools(
    toolCalls: ToolCall[],
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const toolCall of toolCalls) {
      // Governor: 안전성 검증
      try {
        this.governor.validateToolCall(toolCall);
      } catch (err) {
        if (err instanceof ApprovalRequiredError) {
          this.emitEvent({
            kind: "agent:approval_needed",
            action: {
              id: toolCall.id,
              type: err.actionType as import("./types.js").ApprovalAction,
              description: err.description,
              details: toolCall.arguments,
              risk: "high",
              timeout: 120_000,
            },
          });

          // 승인 없이 결과를 에러로 반환
          results.push({
            tool_call_id: toolCall.id,
            name: toolCall.name,
            output: `[BLOCKED] ${err.message}`,
            success: false,
            durationMs: 0,
          });
          continue;
        }
        throw err;
      }

      // 이벤트: 도구 호출
      const args =
        typeof toolCall.arguments === "string"
          ? JSON.parse(toolCall.arguments)
          : toolCall.arguments;
      this.emitEvent({
        kind: "agent:tool_call",
        tool: toolCall.name,
        input: args,
      });

      // 도구 실행
      const startTime = Date.now();
      try {
        const result = await this.toolExecutor.execute(toolCall);
        results.push(result);

        this.emitEvent({
          kind: "agent:tool_result",
          tool: toolCall.name,
          output:
            result.output.length > 200
              ? result.output.slice(0, 200) + "..."
              : result.output,
          durationMs: result.durationMs,
        });

        // 파일 변경 이벤트
        if (
          ["file_write", "file_edit"].includes(toolCall.name) &&
          result.success
        ) {
          const filePath =
            (args as Record<string, unknown>).path ??
            (args as Record<string, unknown>).file ??
            "unknown";
          this.emitEvent({
            kind: "agent:file_change",
            path: String(filePath),
            diff: result.output,
          });
        }
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const errorMessage =
          err instanceof Error ? err.message : String(err);

        results.push({
          tool_call_id: toolCall.id,
          name: toolCall.name,
          output: `Error: ${errorMessage}`,
          success: false,
          durationMs,
        });

        this.emitEvent({
          kind: "agent:error",
          message: `Tool ${toolCall.name} failed: ${errorMessage}`,
          retryable: true,
        });
      }
    }

    return results;
  }

  // ─── Helpers ───

  private emitEvent(event: AgentEvent): void {
    this.emit("event", event);
  }

  private handleFatalError(err: unknown): AgentTermination {
    const message = err instanceof Error ? err.message : String(err);

    this.emitEvent({
      kind: "agent:error",
      message,
      retryable: false,
    });

    return { reason: "ERROR", error: message };
  }
}
