/**
 * @module context-compressor
 * @description 컨텍스트 윈도우 압축 전략.
 * 단순 truncate 대신 우선순위 기반 메시지 관리.
 *
 * ContextManager의 기본 compactHistory보다 정교한 압축을 제공한다:
 * - 메시지 유형별 우선순위 부여
 * - 도구 결과 유형별 맞춤 요약
 * - 오래된 메시지 자동 요약
 *
 * @example
 * ```typescript
 * const compressor = new ContextCompressor({
 *   maxTokens: 128_000,
 *   reserveTokens: 8_000,
 * });
 *
 * const result = compressor.compress(messages, currentTokenEstimate);
 * // result.messages — 압축된 메시지 배열
 * // result.evicted — 제거된 메시지 수
 * // result.summarized — 요약된 메시지 수
 * ```
 */

import { type Message, contentToString } from "./types.js";

// ─── Types ───

/** 메시지 유형별 우선순위 (높을수록 유지 우선) */
export interface CompressionPriorities {
  /** 시스템 프롬프트 — 절대 제거 불가 */
  system: number;
  /** 사용자의 최초 목표 — 항상 유지 */
  userGoal: number;
  /** 최근 도구 결과 (마지막 3개) */
  recentToolResult: number;
  /** 최근 어시스턴트 메시지 (마지막 2개) */
  recentAssistant: number;
  /** 승인 결정 메시지 */
  approval: number;
  /** 오래된 도구 결과 → 요약 대상 */
  olderToolResult: number;
  /** 오래된 어시스턴트 메시지 → 요약 대상 */
  olderAssistant: number;
  /** 사고 과정 메시지 → 우선 제거 */
  thinking: number;
}

/** 압축 전략 설정 */
export interface CompressionStrategy {
  /** 메시지 유형별 우선순위 */
  priorities: CompressionPriorities;
  /** 최근 유지할 도구 결과 수 */
  recentToolResultCount: number;
  /** 최근 유지할 어시스턴트 메시지 수 */
  recentAssistantCount: number;
}

/** ContextCompressor 생성 옵션 */
export interface ContextCompressorConfig {
  /** 최대 토큰 수 */
  maxTokens: number;
  /** LLM 응답용 예약 토큰 수 */
  reserveTokens: number;
  /** 압축 전략 (미지정 시 기본값) */
  strategy?: Partial<CompressionStrategy>;
}

/** 압축 결과 */
export interface CompressedResult {
  /** 압축된 메시지 배열 */
  messages: Message[];
  /** 제거된 메시지 수 */
  evicted: number;
  /** 요약된 메시지 수 */
  summarized: number;
  /** 최종 토큰 추정치 */
  finalTokenEstimate: number;
}

/** 우선순위가 부여된 메시지 (내부 사용) */
interface PrioritizedMessage {
  message: Message;
  priority: number;
  index: number;
  tokenEstimate: number;
}

// ─── Default Strategy ───

const DEFAULT_PRIORITIES: CompressionPriorities = {
  system: 10,
  userGoal: 9,
  recentToolResult: 8,
  recentAssistant: 7,
  approval: 6,
  olderToolResult: 4,
  olderAssistant: 3,
  thinking: 1,
};

const DEFAULT_STRATEGY: CompressionStrategy = {
  priorities: DEFAULT_PRIORITIES,
  recentToolResultCount: 3,
  recentAssistantCount: 2,
};

// ─── Tool Result Compression Limits ───

/** 도구별 결과 압축 설정 */
interface ToolCompressionRule {
  /** 요약 시 유지할 최대 줄 수 */
  maxLines: number;
  /** 머리 부분 줄 수 */
  headLines: number;
  /** 꼬리 부분 줄 수 */
  tailLines: number;
  /** 에러만 추출할지 여부 */
  errorsOnly: boolean;
}

const TOOL_COMPRESSION_RULES: Record<string, ToolCompressionRule> = {
  file_read: { maxLines: 70, headLines: 50, tailLines: 20, errorsOnly: false },
  grep: { maxLines: 20, headLines: 20, tailLines: 0, errorsOnly: false },
  glob: { maxLines: 30, headLines: 30, tailLines: 0, errorsOnly: false },
  code_search: { maxLines: 20, headLines: 20, tailLines: 0, errorsOnly: false },
  shell_exec: { maxLines: 30, headLines: 0, tailLines: 30, errorsOnly: false },
  // Build-like outputs: extract errors
  file_write: { maxLines: 40, headLines: 10, tailLines: 10, errorsOnly: true },
  file_edit: { maxLines: 40, headLines: 10, tailLines: 10, errorsOnly: true },
};

const DEFAULT_TOOL_RULE: ToolCompressionRule = {
  maxLines: 40,
  headLines: 15,
  tailLines: 15,
  errorsOnly: false,
};

// ─── ContextCompressor ───

/**
 * ContextCompressor — 우선순위 기반 컨텍스트 압축.
 *
 * ContextManager의 단순 truncation을 대체하여,
 * 메시지 유형별 중요도에 따라 정교하게 컨텍스트를 관리한다.
 */
export class ContextCompressor {
  private readonly maxTokens: number;
  private readonly reserveTokens: number;
  private readonly strategy: CompressionStrategy;

  constructor(config: ContextCompressorConfig) {
    this.maxTokens = config.maxTokens;
    this.reserveTokens = config.reserveTokens;
    this.strategy = {
      ...DEFAULT_STRATEGY,
      ...config.strategy,
      priorities: {
        ...DEFAULT_PRIORITIES,
        ...config.strategy?.priorities,
      },
    };
  }

  /**
   * 메시지 배열을 토큰 예산 내에 맞도록 압축한다.
   *
   * 압축 단계:
   * 1. 각 메시지에 우선순위 부여
   * 2. 토큰 예산 초과 시 낮은 우선순위 메시지부터 제거/요약
   * 3. 제거할 수 없는 메시지(system, userGoal)는 항상 유지
   *
   * @param messages 원본 메시지 배열
   * @param currentTokens 현재 토큰 추정치 (0이면 자동 계산)
   * @returns 압축 결과
   */
  compress(messages: Message[], currentTokens: number): CompressedResult {
    const budget = this.maxTokens - this.reserveTokens;
    const estimated = currentTokens > 0 ? currentTokens : this.estimateTokensForMessages(messages);

    // 예산 내이면 압축 불필요
    if (estimated <= budget) {
      return {
        messages: [...messages],
        evicted: 0,
        summarized: 0,
        finalTokenEstimate: estimated,
      };
    }

    // 1. 우선순위 부여
    const prioritized = this.assignPriorities(messages);

    // 2. 오래된 도구 결과 요약 (우선 시도)
    let summarizedCount = 0;
    const afterSummary = this.summarizeOlderToolResults(prioritized);
    summarizedCount = afterSummary.summarizedCount;

    let currentEstimate = this.estimateTokensForPrioritized(afterSummary.items);
    if (currentEstimate <= budget) {
      return {
        messages: afterSummary.items.map((p) => p.message),
        evicted: 0,
        summarized: summarizedCount,
        finalTokenEstimate: currentEstimate,
      };
    }

    // 3. 오래된 메시지를 하나의 요약으로 축약
    const afterCollapse = this.collapseOldMessages(afterSummary.items, budget);
    currentEstimate = this.estimateTokensForPrioritized(afterCollapse.items);
    summarizedCount += afterCollapse.summarizedCount;

    if (currentEstimate <= budget) {
      return {
        messages: afterCollapse.items.map((p) => p.message),
        evicted: afterCollapse.evictedCount,
        summarized: summarizedCount,
        finalTokenEstimate: currentEstimate,
      };
    }

    // 4. 최후의 수단: 가장 낮은 우선순위부터 제거
    const afterEviction = this.evictByPriority(afterCollapse.items, budget);
    currentEstimate = this.estimateTokensForPrioritized(afterEviction.items);

    return {
      messages: afterEviction.items.map((p) => p.message),
      evicted: afterCollapse.evictedCount + afterEviction.evictedCount,
      summarized: summarizedCount,
      finalTokenEstimate: currentEstimate,
    };
  }

  /**
   * 도구 결과를 도구 유형에 맞게 요약한다.
   *
   * - 빌드 출력 → 에러 + 마지막 10줄만 유지
   * - 파일 읽기 → 처음 50줄 + 마지막 20줄
   * - Grep → 처음 20개 매치만 유지
   * - Shell 출력 → 종료 코드 + 마지막 30줄
   *
   * @param toolName 도구 이름
   * @param output 원본 출력
   * @param maxLength 최대 문자 수 (0이면 도구별 기본값)
   * @returns 요약된 출력
   */
  summarizeToolResult(toolName: string, output: string, maxLength: number = 0): string {
    const lines = output.split("\n");
    const rule = TOOL_COMPRESSION_RULES[toolName] ?? DEFAULT_TOOL_RULE;
    const limit = maxLength > 0 ? Math.ceil(maxLength / 40) : rule.maxLines;

    if (lines.length <= limit) {
      return output;
    }

    // 에러 추출 모드
    if (rule.errorsOnly) {
      return this.extractErrorsFromOutput(lines, limit);
    }

    // head + tail 모드
    const resultLines: string[] = [];

    if (rule.headLines > 0) {
      const head = Math.min(rule.headLines, limit);
      resultLines.push(...lines.slice(0, head));
    }

    const omitted = lines.length - (rule.headLines + rule.tailLines);
    if (omitted > 0) {
      resultLines.push(`\n... (${omitted} lines omitted) ...\n`);
    }

    if (rule.tailLines > 0) {
      const tail = Math.min(rule.tailLines, limit - resultLines.length);
      if (tail > 0) {
        resultLines.push(...lines.slice(-tail));
      }
    }

    return resultLines.join("\n");
  }

  /**
   * 오래된 메시지 그룹을 하나의 요약 메시지로 축약한다.
   *
   * @param messages 요약할 메시지 배열
   * @returns 요약 메시지 (role: "system")
   */
  summarizeOldMessages(messages: Message[]): Message {
    const actions: string[] = [];
    let toolCallCount = 0;
    let fileReads = 0;
    let fileWrites = 0;
    let shellExecs = 0;
    const filesRead: string[] = [];
    const filesWritten: string[] = [];

    for (const msg of messages) {
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCallCount++;
          const args = this.parseToolArgs(tc.arguments);

          switch (tc.name) {
            case "file_read":
              fileReads++;
              if (args.path) filesRead.push(String(args.path));
              break;
            case "file_write":
            case "file_edit":
              fileWrites++;
              if (args.path) filesWritten.push(String(args.path));
              break;
            case "shell_exec":
              shellExecs++;
              if (args.command) {
                actions.push(`Ran: ${String(args.command).slice(0, 80)}`);
              }
              break;
            default:
              actions.push(`${tc.name}`);
          }
        }
      } else if (msg.role === "user" && msg.content) {
        const preview = msg.content.slice(0, 120);
        actions.push(`User: ${preview}${msg.content.length > 120 ? "..." : ""}`);
      }
    }

    const summary: string[] = [
      `[Summary of ${messages.length} earlier messages]`,
      `- ${toolCallCount} tool calls (${fileReads} reads, ${fileWrites} writes, ${shellExecs} shell)`,
    ];

    if (filesRead.length > 0) {
      const uniqueReads = [...new Set(filesRead)];
      summary.push(`- Files read: ${uniqueReads.slice(0, 10).join(", ")}${uniqueReads.length > 10 ? ` (+${uniqueReads.length - 10} more)` : ""}`);
    }

    if (filesWritten.length > 0) {
      const uniqueWrites = [...new Set(filesWritten)];
      summary.push(`- Files modified: ${uniqueWrites.join(", ")}`);
    }

    if (actions.length > 0) {
      summary.push(`- Actions: ${actions.slice(0, 5).join("; ")}${actions.length > 5 ? ` (+${actions.length - 5} more)` : ""}`);
    }

    return {
      role: "system",
      content: summary.join("\n"),
    };
  }

  // ─── Private: Priority Assignment ───

  private assignPriorities(messages: Message[]): PrioritizedMessage[] {
    const { priorities, recentToolResultCount, recentAssistantCount } = this.strategy;

    // 최근 tool result / assistant 메시지의 인덱스를 역순으로 추적
    let toolResultSeen = 0;
    let assistantSeen = 0;
    const isFirstUserMessage = new Set<number>();

    // 첫 번째 user 메시지 찾기 (사용자의 최초 목표)
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "user") {
        isFirstUserMessage.add(i);
        break;
      }
    }

    // 역순으로 최근 메시지 카운팅
    const recentToolResultIndices = new Set<number>();
    const recentAssistantIndices = new Set<number>();

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "tool" && toolResultSeen < recentToolResultCount) {
        recentToolResultIndices.add(i);
        toolResultSeen++;
      }
      if (msg.role === "assistant" && assistantSeen < recentAssistantCount) {
        recentAssistantIndices.add(i);
        assistantSeen++;
      }
    }

    return messages.map((message, index) => {
      let priority: number;

      if (message.role === "system") {
        priority = priorities.system;
      } else if (isFirstUserMessage.has(index)) {
        priority = priorities.userGoal;
      } else if (message.role === "tool" && recentToolResultIndices.has(index)) {
        priority = priorities.recentToolResult;
      } else if (message.role === "assistant" && recentAssistantIndices.has(index)) {
        priority = priorities.recentAssistant;
      } else if (message.role === "tool") {
        priority = priorities.olderToolResult;
      } else if (message.role === "assistant") {
        // 승인 관련 메시지는 높은 우선순위
        const contentStr = contentToString(message.content);
        if (contentStr.includes("[APPROVED]") || contentStr.includes("[REJECTED]")) {
          priority = priorities.approval;
        } else {
          priority = priorities.olderAssistant;
        }
      } else {
        // user messages (not first) — moderate priority
        priority = priorities.olderAssistant + 1;
      }

      return {
        message,
        priority,
        index,
        tokenEstimate: this.estimateMessageTokens(message),
      };
    });
  }

  // ─── Private: Compression Stages ───

  private summarizeOlderToolResults(
    items: PrioritizedMessage[],
  ): { items: PrioritizedMessage[]; summarizedCount: number } {
    const { priorities } = this.strategy;
    let summarizedCount = 0;

    const result = items.map((item) => {
      // 오래된 도구 결과만 요약
      if (item.priority !== priorities.olderToolResult) {
        return item;
      }

      const content = contentToString(item.message.content);
      if (!content || content.length < 500) {
        return item;
      }

      // 도구 이름을 추적하기 위해 tool_call_id로 찾기 (best-effort)
      const toolName = this.guessToolNameFromContent(content);
      const summarized = this.summarizeToolResult(toolName, content);

      if (summarized.length < content.length) {
        summarizedCount++;
        return {
          ...item,
          message: { ...item.message, content: summarized },
          tokenEstimate: this.estimateStringTokens(summarized) + 4,
        };
      }

      return item;
    });

    return { items: result, summarizedCount };
  }

  private collapseOldMessages(
    items: PrioritizedMessage[],
    budget: number,
  ): { items: PrioritizedMessage[]; summarizedCount: number; evictedCount: number } {
    const { priorities } = this.strategy;
    const threshold = priorities.approval; // 6 — priority 6 이하는 요약 대상

    // 요약 대상: priority < threshold이고, system/userGoal이 아닌 것
    const toCollapse: PrioritizedMessage[] = [];
    const toKeep: PrioritizedMessage[] = [];

    for (const item of items) {
      if (
        item.priority < threshold &&
        item.priority !== priorities.system &&
        item.priority !== priorities.userGoal
      ) {
        toCollapse.push(item);
      } else {
        toKeep.push(item);
      }
    }

    if (toCollapse.length === 0) {
      return { items, summarizedCount: 0, evictedCount: 0 };
    }

    // 축약 대상 메시지를 하나의 요약으로 축약
    const summaryMessage = this.summarizeOldMessages(
      toCollapse.map((p) => p.message),
    );

    const summaryItem: PrioritizedMessage = {
      message: summaryMessage,
      priority: priorities.olderAssistant + 0.5, // 요약은 중간 우선순위
      index: toCollapse[0].index, // 원래 위치 유지
      tokenEstimate: this.estimateMessageTokens(summaryMessage),
    };

    // system 메시지 다음, 나머지 앞에 삽입
    const result: PrioritizedMessage[] = [];
    let summaryInserted = false;

    for (const item of toKeep) {
      if (!summaryInserted && item.priority < priorities.system) {
        result.push(summaryItem);
        summaryInserted = true;
      }
      result.push(item);
    }

    if (!summaryInserted) {
      // system 뒤에 삽입
      const systemEnd = result.findIndex((p) => p.priority !== priorities.system);
      if (systemEnd === -1) {
        result.push(summaryItem);
      } else {
        result.splice(systemEnd, 0, summaryItem);
      }
    }

    // 원래 인덱스 순으로 정렬
    result.sort((a, b) => a.index - b.index);

    return {
      items: result,
      summarizedCount: toCollapse.length,
      evictedCount: 0,
    };
  }

  private evictByPriority(
    items: PrioritizedMessage[],
    budget: number,
  ): { items: PrioritizedMessage[]; evictedCount: number } {
    const { priorities } = this.strategy;

    // priority 순 정렬 (낮은 것 먼저 제거)
    const sorted = [...items].sort((a, b) => a.priority - b.priority);
    let currentTokens = this.estimateTokensForPrioritized(items);
    const evictIndices = new Set<number>();

    for (const item of sorted) {
      if (currentTokens <= budget) break;

      // 절대 제거 불가: system, userGoal
      if (
        item.priority >= priorities.userGoal
      ) {
        continue;
      }

      evictIndices.add(item.index);
      currentTokens -= item.tokenEstimate;
    }

    const result = items.filter((item) => !evictIndices.has(item.index));

    return {
      items: result,
      evictedCount: evictIndices.size,
    };
  }

  // ─── Private: Token Estimation ───

  /**
   * 문자열의 대략적인 토큰 수를 추정 (~4 chars/token).
   * ContextManager.estimateStringTokens와 동일한 근사치.
   */
  private estimateStringTokens(str: string): number {
    const cjkCount = (str.match(/[\u3000-\u9fff\uac00-\ud7af]/g) ?? []).length;
    const nonCjkCount = str.length - cjkCount;
    return Math.ceil(nonCjkCount / 4 + cjkCount / 2);
  }

  private estimateMessageTokens(message: Message): number {
    let total = 4; // message overhead
    if (message.content) {
      total += this.estimateStringTokens(contentToString(message.content));
    }
    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        total += this.estimateStringTokens(tc.name) + 4;
        const argsStr =
          typeof tc.arguments === "string"
            ? tc.arguments
            : JSON.stringify(tc.arguments);
        total += this.estimateStringTokens(argsStr);
      }
    }
    return total;
  }

  private estimateTokensForMessages(messages: Message[]): number {
    return messages.reduce((sum, msg) => sum + this.estimateMessageTokens(msg), 0);
  }

  private estimateTokensForPrioritized(items: PrioritizedMessage[]): number {
    return items.reduce((sum, item) => sum + item.tokenEstimate, 0);
  }

  // ─── Private: Helpers ───

  /**
   * 빌드/쉘 출력에서 에러 줄만 추출한다.
   */
  private extractErrorsFromOutput(lines: string[], maxLines: number): string {
    const errorPatterns = /\b(error|Error|ERROR|fail|FAIL|Failed|fatal|FATAL|exception|Exception)\b/;
    const errorLines: string[] = [];
    const contextLines = 2;

    for (let i = 0; i < lines.length; i++) {
      if (errorPatterns.test(lines[i])) {
        // 에러 줄 + 주변 컨텍스트
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length, i + contextLines + 1);
        for (let j = start; j < end; j++) {
          if (!errorLines.includes(lines[j])) {
            errorLines.push(lines[j]);
          }
        }
      }
    }

    if (errorLines.length === 0) {
      // 에러를 못 찾으면 마지막 줄들 반환
      const tail = lines.slice(-maxLines);
      return `[No explicit errors found. Last ${tail.length} lines:]\n${tail.join("\n")}`;
    }

    const result = errorLines.slice(0, maxLines);
    const omitted = errorLines.length - result.length;
    const suffix = omitted > 0 ? `\n... (${omitted} more error lines)` : "";

    return `[Extracted ${result.length} error-related lines:]\n${result.join("\n")}${suffix}`;
  }

  /**
   * 도구 결과 내용에서 도구 이름을 추측한다 (best-effort).
   */
  private guessToolNameFromContent(content: string): string {
    if (content.startsWith("File:") || content.includes("lines total")) return "file_read";
    if (content.includes("matches found") || content.includes("Match:")) return "grep";
    if (content.includes("files found") || content.includes("Found:")) return "glob";
    if (content.includes("exit code") || content.includes("Exit code")) return "shell_exec";
    return "unknown";
  }

  /**
   * 도구 인자를 파싱하는 헬퍼.
   */
  private parseToolArgs(args: string | Record<string, unknown>): Record<string, unknown> {
    if (typeof args === "string") {
      try {
        return JSON.parse(args) as Record<string, unknown>;
      } catch {
        return { raw: args };
      }
    }
    return args;
  }
}
