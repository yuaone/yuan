/**
 * @module context-manager
 * @description 컨텍스트 윈도우 관리.
 * 메시지 히스토리 관리, 토큰 카운팅 (근사), 컨텍스트 압축.
 */

import { type Message, contentToString } from "./types.js";
import { TOOL_RESULT_LIMITS, HISTORY_COMPACTION } from "./constants.js";
import { ContextOverflowError } from "./errors.js";
import { ContextCompressor } from "./context-compressor.js";

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
   * 시스템 메시지를 교체.
   * init() 후 향상된 프롬프트로 갱신할 때 사용.
   * @param content 새 시스템 프롬프트 내용
   */
  replaceSystemMessage(content: string): void {
    const idx = this.messages.findIndex((m) => m.role === "system");
    if (idx >= 0) {
      this.messages[idx] = { role: "system", content };
    } else {
      this.messages.unshift({ role: "system", content });
    }
  }

  /**
   * 현재 메시지 히스토리 반환.
   * 컨텍스트 윈도우 내에 맞도록 자동 압축.
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * 현재 컨텍스트 사용 비율(0~1 근사치)을 반환.
   * output reserve를 제외한 usable budget 기준이다.
   */
  getUsageRatio(): number {
    const availableTokens = Math.max(1, this.maxTokens - this.outputReserve);
    return this.estimateTokens(this.messages) / availableTokens;
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

    // 우선순위 기반 압축 먼저 시도 (ContextCompressor)
    try {
      const compressor = new ContextCompressor({
        maxTokens: this.maxTokens,
        reserveTokens: this.outputReserve,
      });
      const compressed = compressor.compress(this.messages, currentTokens);
      const compressedTokens = this.estimateTokens(compressed.messages);
      if (compressedTokens <= availableTokens) {
        return compressed.messages;
      }
      // ContextCompressor가 충분히 줄이지 못한 경우 compactHistory로 추가 압축
      const compacted = this.compactHistory(availableTokens);
      const compactedTokens = this.estimateTokens(compacted);
      if (compactedTokens > availableTokens) {
        return this.emergencyTrim(compacted, availableTokens);
      }
      return compacted;
    } catch {
      // ContextCompressor 실패 시 기존 방식으로 fallback
    }

    // fallback: 기존 compactHistory
    const compacted = this.compactHistory(availableTokens);
    currentTokens = this.estimateTokens(compacted);

    if (currentTokens > availableTokens) {
     return this.emergencyTrim(compacted, availableTokens);
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
      if (msg.content !== undefined) {
        if (typeof msg.content === "string") {
          total += this.estimateStringTokens(msg.content);
        } else if (Array.isArray(msg.content)) {
          // 멀티모달 콘텐츠 블록
          for (const block of msg.content) {
            if (block.type === "text") {
              total += this.estimateStringTokens(block.text);
            } else if (block.type === "image") {
              // 이미지는 대략 85 토큰 (low detail) ~ 1000+ (high detail)
              total += 300;
            } else if (block.type === "file") {
              total += this.estimateStringTokens(block.content) + 10;
            }
          }
        }
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

    // 1. system 메시지 추출 — rolling window으로 무한 누적 방지
    const allSystemMessages = this.messages.filter(
      (m) => m.role === "system",
    );
    const systemMessages = this.pruneSystemMessages(allSystemMessages);
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
          content: this.truncateToolResult(contentToString(msg.content)),
        });
      } else {
        result.push(msg);
      }
    }

    // 2. 최근 메시지 → 원본 유지
    for (let i = recentStart; i < total; i++) {
      result.push(nonSystemMessages[i]);
    }

    // Ensure assistant(tool_calls) + tool message pairs are never split.
    // Walk result and if an assistant message has tool_calls but the next
    // message(s) are not the matching tool results, re-insert them.
    const repaired: Message[] = [];
    for (let i = 0; i < result.length; i++) {
      repaired.push(result[i]);
      const msg = result[i];
      if (msg.role === "assistant" && msg.tool_calls?.length) {
        const expectedIds = new Set(msg.tool_calls.map((tc) => tc.id));
        // Check if the next messages already cover all tool_call_ids
        let j = i + 1;
        while (j < result.length && result[j].role === "tool") {
          expectedIds.delete(result[j].tool_call_id ?? "");
          j++;
        }
        // If some tool results are missing, find them in original messages
        if (expectedIds.size > 0) {
          for (const origMsg of this.messages) {
            if (origMsg.role === "tool" && expectedIds.has(origMsg.tool_call_id ?? "")) {
              repaired.push(origMsg);
              expectedIds.delete(origMsg.tool_call_id ?? "");
            }
          }
        }
      }
    }

    // 토큰 초과 시 중간 메시지도 추가 요약
    let tokens = this.estimateTokens(repaired);
    if (tokens > targetTokens && repaired.length > systemMessages.length + this.recentWindow) {
      const keep = systemMessages.length + 1 + this.recentWindow;
      while (repaired.length > keep && tokens > targetTokens) {
        // Don't remove tool messages or assistant messages with tool_calls
        // (removing either would break the tool_calls ↔ tool result pair contract)
        const candidate = repaired[systemMessages.length + 1];
        if (candidate.role === "tool") {
          break;
        }
        if (candidate.role === "assistant" && candidate.tool_calls?.length) {
          break;
        }
        repaired.splice(systemMessages.length + 1, 1);
        tokens = this.estimateTokens(repaired);
      }
    }

    return repaired;
  }

  /**
   * compactHistory 이후에도 예산을 초과하면 실행하는 최후 압축 단계.
   *
   * 절대 throw하지 않고:
   * - system 메시지(rolling window 적용 후) 유지
   * - 오래된 대화는 1개의 초압축 summary로 치환
   * - 최근 대화만 남김
   * - 그래도 크면 최근 메시지부터 내용 자체를 잘라서 맞춘다
   */
  private emergencyTrim(messages: Message[], targetTokens: number): Message[] {
    const systemMessages = this.pruneSystemMessages(
      messages.filter((m) => m.role === "system"),
      8,
    );
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    const recentMessages = this.takeRecentConversationWindow(nonSystemMessages, 6);
    const olderMessages = nonSystemMessages.slice(
      0,
      Math.max(0, nonSystemMessages.length - recentMessages.length),
    );

    const result: Message[] = [...systemMessages];

    if (olderMessages.length > 0) {
      result.push({
        role: "system",
        content:
          "[Compressed conversation state]\n" +
          this.summarizeMessages(olderMessages).slice(0, 1200),
      });
    }

    for (const msg of recentMessages) {
      if (msg.role === "tool" && msg.content) {
        result.push({
          ...msg,
          content: this.truncateToolResult(contentToString(msg.content)),
        });
      } else {
        result.push(msg);
      }
    }

    let currentTokens = this.estimateTokens(result);
    if (currentTokens <= targetTokens) {
      return result;
    }

    // 여전히 크면, 오래된 non-system부터 제거
    while (result.length > systemMessages.length + 2 && currentTokens > targetTokens) {
      const removeIndex = systemMessages.length;
      if (removeIndex >= result.length) break;

      const candidate = result[removeIndex];
      if (candidate.role === "tool") break;
      if (candidate.role === "assistant" && candidate.tool_calls?.length) break;

      result.splice(removeIndex, 1);
      currentTokens = this.estimateTokens(result);
    }

    if (currentTokens <= targetTokens) {
      return result;
    }

    // 그래도 크면 최근 메시지 본문 자체를 잘라서 맞춘다.
    for (let i = result.length - 1; i >= systemMessages.length && currentTokens > targetTokens; i--) {
      const msg = result[i];
      result[i] = this.truncateMessageForBudget(msg, 400);
      currentTokens = this.estimateTokens(result);
    }

    // 마지막 fallback: system + 마지막 user/assistant/tool 흐름만 남긴다.
    if (currentTokens > targetTokens) {
      const minimalRecent = this.takeRecentConversationWindow(nonSystemMessages, 3).map((msg) =>
        this.truncateMessageForBudget(msg, 250),
      );
      return [...systemMessages, ...minimalRecent];
    }

    return result;
  }

  /**
   * 최근 대화 윈도우를 가져오되, assistant(tool_calls) ↔ tool pair가
   * 깨지지 않도록 뒤에서부터 묶어서 보존한다.
   */
  private takeRecentConversationWindow(messages: Message[], count: number): Message[] {
    const start = Math.max(0, messages.length - count);
    const recent = messages.slice(start);

    if (recent.length === 0) return recent;

    const repaired: Message[] = [];
    for (let i = 0; i < recent.length; i++) {
      repaired.push(recent[i]);
      const msg = recent[i];
      if (msg.role === "assistant" && msg.tool_calls?.length) {
        const expectedIds = new Set(msg.tool_calls.map((tc) => tc.id));
        let j = i + 1;
        while (j < recent.length && recent[j].role === "tool") {
          if (expectedIds.has(recent[j].tool_call_id ?? "")) {
            repaired.push(recent[j]);
          }
          j++;
        }
      }
    }

    return repaired;
  }
  /**
   * 런타임 시스템 메시지를 rolling window으로 제한.
   * 첫 번째 시스템 메시지(기본 프롬프트)는 항상 유지하고,
   * 나머지 런타임 시스템 메시지는 최근 maxRuntime개만 유지.
   */
  pruneSystemMessages(systemMessages: Message[], maxRuntime: number = 15): Message[] {
    if (systemMessages.length <= maxRuntime + 1) {
      return systemMessages;
    }

    // 첫 번째(기본 프롬프트) + 최근 maxRuntime개 런타임 메시지
    const base = systemMessages[0];
    const runtime = systemMessages.slice(1);
    const kept = runtime.slice(-maxRuntime);

    return [base, ...kept];
  }

  private summarizeMessages(messages: Message[]): string {
    const actions: string[] = [];
    let userMsgCount = 0;
    let toolCallCount = 0;

    for (const msg of messages) {
      if (msg.role === "user") {
        userMsgCount++;
        if (msg.content) {
          const text = contentToString(msg.content);
          const preview = text.slice(0, 100);
          actions.push(`User: ${preview}${text.length > 100 ? "..." : ""}`);
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
   * 메시지 하나를 예산 친화적으로 축약한다.
   * tool_call / tool_call_id 구조는 유지하고 content만 줄인다.
   */
  private truncateMessageForBudget(message: Message, maxChars: number): Message {
    if (!message.content) return message;

    if (typeof message.content === "string") {
      if (message.content.length <= maxChars) return message;
      return {
        ...message,
        content:
          message.content.slice(0, Math.floor(maxChars / 2)) +
          "\n...[compressed]...\n" +
          message.content.slice(-Math.floor(maxChars / 2)),
      };
    }

    const content = contentToString(message.content);
    if (content.length <= maxChars) return message;

    return {
      ...message,
      content:
        content.slice(0, Math.floor(maxChars / 2)) +
        "\n...[compressed]...\n" +
        content.slice(-Math.floor(maxChars / 2)),
    };
  }

  /**
   * 문자열의 대략적인 토큰 수를 추정 (근사치).
   *
   * **추정 방식:**
   * - 영어/ASCII 텍스트: ~4 characters per token
   * - CJK/한국어 텍스트 (U+3000–U+9FFF, U+AC00–U+D7AF): ~2 characters per token
   * - 혼합 텍스트는 각 범위의 문자 수를 분리하여 합산
   *
   * **오차 범위:**
   * - 영어: 실제 토큰 대비 ~±20% 오차 (서브워드 분할 특성상 변동)
   * - CJK/한국어: ~±20% 이상 오차 가능 (모델별 토크나이저 차이가 큼)
   * - 코드, 특수문자, 긴 단어 등에서 오차가 더 커질 수 있음
   *
   * **의도적 설계:**
   * BYOK 환경에서는 사용자가 다양한 모델(Claude, GPT, Gemini 등)을
   * 자유롭게 선택하므로 모델별 토크나이저에 접근할 수 없다.
   * 따라서 정확한 토큰 카운팅 대신 범용 근사치를 사용하며,
   * 컨텍스트 오버플로우는 outputReserve 마진으로 방어한다.
   */
  private estimateStringTokens(str: string): number {
    // CJK 문자 비율 체크
    const cjkCount = (str.match(/[\u3000-\u9fff\uac00-\ud7af]/g) ?? []).length;
    const nonCjkCount = str.length - cjkCount;
    return Math.ceil(nonCjkCount / 4 + cjkCount / 2);
  }
}
