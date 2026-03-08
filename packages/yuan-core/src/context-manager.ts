/**
 * @module context-manager
 * @description 컨텍스트 윈도우 관리.
 * 메시지 히스토리 관리, 토큰 카운팅 (근사), 컨텍스트 압축.
 */

import type { Message } from "./types.js";
import { TOOL_RESULT_LIMITS, HISTORY_COMPACTION } from "./constants.js";
import { ContextOverflowError } from "./errors.js";

/** ContextManager 설정 */
export interface ContextManagerConfig {
  /** 최대 컨텍스트 토큰 수 */
  maxContextTokens: number;
  /** 출력 예약 토큰 (LLM 응답용) */
  outputReserveTokens?: number;
  /** 히스토리 압축 설정 */
  compaction?: {
    recentWindow?: number;
    summaryWindow?: number;
  };
}

/**
 * ContextManager — 컨텍스트 윈도우 크기를 관리.
 *
 * 역할:
 * - 메시지 히스토리를 관리하고 토큰 수를 추적
 * - 도구 결과가 너무 크면 자동 압축
 * - 오래된 메시지를 요약으로 교체하여 컨텍스트 내에 유지
 */
export class ContextManager {
  private messages: Message[] = [];
  private readonly maxTokens: number;
  private readonly outputReserve: number;
  private readonly recentWindow: number;
  private readonly summaryWindow: number;

  constructor(config: ContextManagerConfig) {
    this.maxTokens = config.maxContextTokens;
    this.outputReserve = config.outputReserveTokens ?? 4096;
    this.recentWindow =
      config.compaction?.recentWindow ?? HISTORY_COMPACTION.recentWindow;
    this.summaryWindow =
      config.compaction?.summaryWindow ?? HISTORY_COMPACTION.summaryWindow;
  }

  /**
   * 메시지를 히스토리에 추가.
   * @param message 추가할 메시지
   */
  addMessage(message: Message): void {
    this.messages.push(message);
  }

  /**
   * 여러 메시지를 한 번에 추가.
   * @param messages 추가할 메시지 목록
   */
  addMessages(messages: Message[]): void {
    this.messages.push(...messages);
  }

  /**
   * 현재 메시지 히스토리 반환.
   * 컨텍스트 윈도우 내에 맞도록 자동 압축.
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * LLM에 보낼 메시지를 준비.
   * 필요 시 압축하여 컨텍스트 윈도우 내에 맞춤.
   */
  prepareForLLM(): Message[] {
    const availableTokens = this.maxTokens - this.outputReserve;
    let currentTokens = this.estimateTokens(this.messages);

    if (currentTokens <= availableTokens) {
      return [...this.messages];
    }

    // 압축 필요
    const compacted = this.compactHistory(availableTokens);
    currentTokens = this.estimateTokens(compacted);

    if (currentTokens > availableTokens) {
      throw new ContextOverflowError(currentTokens, availableTokens);
    }

    return compacted;
  }

  /**
   * 메시지 목록의 대략적인 토큰 수를 추정.
   * tiktoken 없이 근사치 사용 (영어 ~4자/토큰, 한국어 ~2자/토큰).
   * @param messages 토큰 수를 추정할 메시지 목록
   */
  estimateTokens(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
      // 메시지 오버헤드 (~4 토큰)
      total += 4;
      if (msg.content) {
        total += this.estimateStringTokens(msg.content);
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          total += this.estimateStringTokens(tc.name) + 4;
          const argsStr =
            typeof tc.arguments === "string"
              ? tc.arguments
              : JSON.stringify(tc.arguments);
          total += this.estimateStringTokens(argsStr);
        }
      }
    }
    return total;
  }

  /**
   * 도구 결과를 크기 제한에 맞게 압축.
   * @param toolName 도구 이름
   * @param result 도구 결과 문자열
   * @returns 압축된 결과 (제한 내이면 원본 반환)
   */
  compressToolResult(toolName: string, result: string): string {
    const limit = TOOL_RESULT_LIMITS[toolName] ?? 10_000;
    if (result.length <= limit) return result;

    const headSize = Math.floor(limit * 0.3);
    const tailSize = Math.floor(limit * 0.3);
    const truncated = result.length - headSize - tailSize;

    return (
      result.slice(0, headSize) +
      `\n\n... (${truncated} chars truncated) ...\n\n` +
      result.slice(-tailSize)
    );
  }

  /**
   * 현재 총 토큰 수 추정치를 반환.
   */
  getCurrentTokenCount(): number {
    return this.estimateTokens(this.messages);
  }

  /**
   * 히스토리를 초기화.
   */
  clear(): void {
    this.messages = [];
  }

  /**
   * 히스토리 메시지 수를 반환.
   */
  get messageCount(): number {
    return this.messages.length;
  }

  // ─── Private ───

  /**
   * 히스토리를 압축하여 토큰 예산 내에 맞춤.
   *
   * 전략:
   * 1. system 메시지는 항상 유지
   * 2. 최근 recentWindow개 메시지는 원본 유지
   * 3. summaryWindow 범위: 도구 결과만 요약으로 교체
   * 4. 그 이전: 전체를 1줄 요약으로 압축
   */
  private compactHistory(targetTokens: number): Message[] {
    const result: Message[] = [];

    // 1. system 메시지 추출
    const systemMessages = this.messages.filter(
      (m) => m.role === "system",
    );
    const nonSystemMessages = this.messages.filter(
      (m) => m.role !== "system",
    );

    result.push(...systemMessages);

    const total = nonSystemMessages.length;
    const recentStart = Math.max(0, total - this.recentWindow);
    const summaryStart = Math.max(
      0,
      recentStart - this.summaryWindow,
    );

    // 4. 아주 오래된 메시지 (summaryStart 이전) → 전체 요약
    if (summaryStart > 0) {
      const oldMessages = nonSystemMessages.slice(0, summaryStart);
      const summary = this.summarizeMessages(oldMessages);
      result.push({
        role: "system",
        content: `[Previous conversation summary]\n${summary}`,
      });
    }

    // 3. 중간 메시지 (summaryStart ~ recentStart) → 도구 결과 압축
    for (let i = summaryStart; i < recentStart; i++) {
      const msg = nonSystemMessages[i];
      if (msg.role === "tool" && msg.content) {
        result.push({
          ...msg,
          content: this.truncateToolResult(msg.content),
        });
      } else {
        result.push(msg);
      }
    }

    // 2. 최근 메시지 → 원본 유지
    for (let i = recentStart; i < total; i++) {
      result.push(nonSystemMessages[i]);
    }

    // 토큰 초과 시 중간 메시지도 추가 요약
    let tokens = this.estimateTokens(result);
    if (tokens > targetTokens && result.length > systemMessages.length + this.recentWindow) {
      // 중간 메시지 제거하고 더 짧은 요약으로 교체
      const keep = systemMessages.length + 1 + this.recentWindow; // system + summary + recent
      while (result.length > keep && tokens > targetTokens) {
        result.splice(systemMessages.length + 1, 1);
        tokens = this.estimateTokens(result);
      }
    }

    return result;
  }

  private summarizeMessages(messages: Message[]): string {
    const actions: string[] = [];
    let userMsgCount = 0;
    let toolCallCount = 0;

    for (const msg of messages) {
      if (msg.role === "user") {
        userMsgCount++;
        if (msg.content) {
          const preview = msg.content.slice(0, 100);
          actions.push(`User: ${preview}${msg.content.length > 100 ? "..." : ""}`);
        }
      } else if (msg.role === "assistant" && msg.tool_calls) {
        toolCallCount += msg.tool_calls.length;
        for (const tc of msg.tool_calls) {
          actions.push(`Tool: ${tc.name}`);
        }
      }
    }

    return [
      `${userMsgCount} user messages, ${toolCallCount} tool calls.`,
      ...actions.slice(0, 10),
      actions.length > 10
        ? `... and ${actions.length - 10} more actions`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private truncateToolResult(content: string): string {
    const MAX = 500;
    if (content.length <= MAX) return content;
    return content.slice(0, 200) + "\n...(truncated)...\n" + content.slice(-200);
  }

  /**
   * 문자열의 대략적인 토큰 수 추정.
   * 영어: ~4자/토큰, CJK/한국어: ~2자/토큰 근사.
   */
  private estimateStringTokens(str: string): number {
    // CJK 문자 비율 체크
    const cjkCount = (str.match(/[\u3000-\u9fff\uac00-\ud7af]/g) ?? []).length;
    const nonCjkCount = str.length - cjkCount;
    return Math.ceil(nonCjkCount / 4 + cjkCount / 2);
  }
}
