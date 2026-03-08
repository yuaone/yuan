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
import { BYOKClient, type LLMResponse, type LLMStreamChunk } from "./llm-client.js";
import { Governor, type GovernorConfig } from "./governor.js";
import { ContextManager, type ContextManagerConfig } from "./context-manager.js";
import {
  YuanError,
  ToolError,
  LLMError,
  PlanLimitError,
  ApprovalRequiredError,
} from "./errors.js";
import {
  ApprovalManager,
  type ApprovalHandler,
  type ApprovalRequest,
  type AutoApprovalConfig,
} from "./approval.js";
import {
  AutoFixLoop,
  type AutoFixConfig,
  type ValidationResult,
} from "./auto-fix.js";

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
  /** 승인 시스템 설정 */
  approvalConfig?: Partial<AutoApprovalConfig>;
  /** 승인 핸들러 (CLI/UI에서 등록) */
  approvalHandler?: ApprovalHandler;
  /** 자동 수정 루프 설정 */
  autoFixConfig?: Partial<AutoFixConfig>;
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
  private readonly approvalManager: ApprovalManager;
  private readonly autoFixLoop: AutoFixLoop;
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

    // ApprovalManager 생성
    this.approvalManager = new ApprovalManager(options.approvalConfig);
    if (options.approvalHandler) {
      this.approvalManager.setHandler(options.approvalHandler);
    }

    // AutoFixLoop 생성
    this.autoFixLoop = new AutoFixLoop(options.autoFixConfig);

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

  /**
   * ApprovalManager 인스턴스를 반환.
   * CLI/UI에서 핸들러를 등록하거나 설정을 변경할 때 사용.
   */
  getApprovalManager(): ApprovalManager {
    return this.approvalManager;
  }

  /**
   * AutoFixLoop 인스턴스를 반환.
   * 수정 시도 기록 등을 조회할 때 사용.
   */
  getAutoFixLoop(): AutoFixLoop {
    return this.autoFixLoop;
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

      // 2. LLM 호출 (streaming)
      this.emitEvent({
        kind: "agent:thinking",
        content: `Iteration ${iteration}...`,
      });

      let response: LLMResponse;
      try {
        response = await this.callLLMStreaming(messages);
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
   * LLM을 스트리밍 모드로 호출하여 text delta를 실시간 emit.
   * 텍스트 청크는 `agent:text_delta` 이벤트로, tool_call은 누적 후 완료 시 반환.
   */
  private async callLLMStreaming(messages: Message[]): Promise<LLMResponse> {
    let content = "";
    const toolCalls: ToolCall[] = [];
    let usage = { input: 0, output: 0 };
    let finishReason = "stop";

    const stream = this.llmClient.chatStream(
      messages,
      this.config.loop.tools,
    );

    for await (const chunk of stream) {
      if (this.aborted) break;

      switch (chunk.type) {
        case "text":
          if (chunk.text) {
            content += chunk.text;
            this.emitEvent({
              kind: "agent:text_delta",
              text: chunk.text,
            });
          }
          break;

        case "tool_call":
          if (chunk.toolCall) {
            toolCalls.push(chunk.toolCall);
            this.emitEvent({
              kind: "agent:tool_call",
              tool: chunk.toolCall.name,
              input: chunk.toolCall.arguments,
            });
          }
          break;

        case "done":
          if (chunk.usage) {
            usage = chunk.usage;
          }
          break;
      }
    }

    return {
      content: content || null,
      toolCalls,
      usage,
      finishReason,
    };
  }

  /**
   * 도구 호출 목록을 실행.
   * 각 도구 호출에 대해:
   * 1. Governor 안전성 검증
   * 2. ApprovalManager 승인 체크 → 필요 시 대기
   * 3. 도구 실행
   * 4. AutoFixLoop 결과 검증 → 실패 시 에러 피드백 메시지 추가
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
          // Governor가 위험 감지 → ApprovalManager로 승인 프로세스 위임
          const args = this.parseToolArgs(toolCall.arguments);
          const approvalResult = await this.handleApproval(toolCall, args, err);
          if (approvalResult) {
            results.push(approvalResult);
            continue;
          }
          // 승인됨 → 계속 실행
        } else {
          throw err;
        }
      }

      // ApprovalManager: 추가 승인 체크 (Governor가 못 잡은 규칙)
      const args = this.parseToolArgs(toolCall.arguments);
      const approvalRequest = this.approvalManager.checkApproval(
        toolCall.name,
        args,
      );
      if (approvalRequest) {
        const approvalResult = await this.handleApprovalRequest(
          toolCall,
          approvalRequest,
        );
        if (approvalResult) {
          results.push(approvalResult);
          continue;
        }
        // 승인됨 → 계속 실행
      }

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

        // AutoFixLoop: 결과 검증
        await this.validateAndFeedback(toolCall.name, result);
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

  /**
   * Governor의 ApprovalRequiredError를 ApprovalManager로 처리.
   * 승인되면 null 반환 (실행 계속), 거부되면 ToolResult 반환 (실행 차단).
   */
  private async handleApproval(
    toolCall: ToolCall,
    args: Record<string, unknown>,
    err: ApprovalRequiredError,
  ): Promise<ToolResult | null> {
    const request: ApprovalRequest = {
      id: crypto.randomUUID(),
      toolName: toolCall.name,
      arguments: args,
      riskLevel: "high",
      reason: err.description,
      timeout: 120_000,
    };

    return this.handleApprovalRequest(toolCall, request);
  }

  /**
   * ApprovalRequest를 처리하고 승인/거부 결과를 반환.
   * 승인되면 null (실행 계속), 거부되면 ToolResult (차단).
   */
  private async handleApprovalRequest(
    toolCall: ToolCall,
    request: ApprovalRequest,
  ): Promise<ToolResult | null> {
    const pendingAction = this.approvalManager.buildPendingAction(
      toolCall,
      request,
    );

    this.emitEvent({
      kind: "agent:approval_needed",
      action: pendingAction,
    });

    const response = await this.approvalManager.requestApproval(request);

    if (response === "reject") {
      return {
        tool_call_id: toolCall.id,
        name: toolCall.name,
        output: `[REJECTED] User denied approval: ${request.reason}`,
        success: false,
        durationMs: 0,
      };
    }

    // approve 또는 always_approve → 실행 허가
    return null;
  }

  /**
   * 도구 실행 결과를 AutoFixLoop으로 검증하고,
   * 실패 시 수정 프롬프트를 대화 히스토리에 추가.
   */
  private async validateAndFeedback(
    toolName: string,
    result: ToolResult,
  ): Promise<void> {
    // file_write/file_edit만 검증 (다른 도구는 스킵)
    if (!["file_write", "file_edit"].includes(toolName)) {
      return;
    }

    const validation = await this.autoFixLoop.validateResult(
      toolName,
      result.output,
      result.success,
      this.config.loop.projectPath,
    );

    if (validation.passed) {
      // 검증 통과 → 수정 시도 기록 초기화
      this.autoFixLoop.resetAttempts();
      return;
    }

    // 검증 실패 → 에러 피드백
    if (!this.autoFixLoop.canRetry()) {
      // 재시도 한도 초과 → 에러 이벤트만 emit
      this.emitEvent({
        kind: "agent:error",
        message: `Auto-fix exhausted (${this.autoFixLoop.getAttempts().length} attempts): ${validation.failures[0]?.message ?? "Unknown error"}`,
        retryable: false,
      });
      return;
    }

    // 수정 프롬프트 생성 → 대화 히스토리에 user 메시지로 추가
    const errorMsg = validation.failures
      .map((f) => `[${f.type}] ${f.message}\n${f.rawOutput}`)
      .join("\n\n");

    const fixPrompt = this.autoFixLoop.buildFixPrompt(
      errorMsg,
      `After ${toolName} execution on project at ${this.config.loop.projectPath}`,
    );

    // 수정 시도 기록
    this.autoFixLoop.recordAttempt(
      errorMsg,
      "Requesting LLM fix",
      false,
      0,
    );

    // 피드백을 히스토리에 추가 (다음 LLM 호출에서 수정 시도)
    this.contextManager.addMessage({
      role: "user",
      content: fixPrompt,
    });
  }

  /**
   * 도구 인자를 파싱하는 헬퍼.
   */
  private parseToolArgs(
    args: string | Record<string, unknown>,
  ): Record<string, unknown> {
    if (typeof args === "string") {
      try {
        return JSON.parse(args) as Record<string, unknown>;
      } catch {
        return { raw: args };
      }
    }
    return args;
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
