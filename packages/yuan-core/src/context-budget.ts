/**
 * @module context-budget
 * @description 컨텍스트 윈도우 예산 관리자.
 *
 * LLM 컨텍스트 오버플로우를 방지하기 위한 고급 예산 관리 시스템.
 * - 카테고리별 토큰 예산 배분 및 강제
 * - 우선순위 기반 선택적 유지/제거
 * - LLM 기반 요약을 통한 오래된 메시지 압축
 * - 관련성 기반 검색으로 필요한 컨텍스트만 로드
 * - 슬라이딩 윈도우 + 체크포인트로 핵심 결정 보존
 *
 * @example
 * ```typescript
 * const budget = new ContextBudgetManager({ totalBudget: 128_000 });
 *
 * budget.addItem({
 *   category: "systemPrompt",
 *   priority: "critical",
 *   content: systemPrompt,
 *   role: "system",
 * });
 *
 * budget.addItem({
 *   category: "conversationHistory",
 *   priority: "high",
 *   content: userMessage,
 *   role: "user",
 * });
 *
 * // Auto-manage when nearing limits
 * await budget.autoManage(async (text) => llm.summarize(text));
 *
 * // Build context for LLM call
 * const messages = budget.toMessages();
 * ```
 */

import { EventEmitter } from "node:events";
import { type Message, contentToString } from "./types.js";

// ─── Types ───

/** 카테고리별 토큰 예산 배분 (합계 = 100) */
export interface BudgetAllocation {
  /** 시스템 프롬프트 비율 (기본 15%) */
  systemPrompt: number;
  /** 프로젝트 컨텍스트 비율 — YUAN.md, 파일 컨텍스트 (기본 10%) */
  projectContext: number;
  /** 대화 히스토리 비율 (기본 40%) */
  conversationHistory: number;
  /** 도구 결과 비율 (기본 25%) */
  toolResults: number;
  /** 워킹 메모리 비율 (기본 10%) */
  workingMemory: number;
}

/** 컨텍스트 아이템 우선순위 */
export type ContextPriority =
  | "critical"    // 절대 제거 불가 (시스템 프롬프트, 현재 태스크 목표)
  | "high"        // 최후에 제거 (최근 도구 결과, 사용자 메시지)
  | "medium"      // 공간 부족 시 요약 (오래된 히스토리)
  | "low"         // 먼저 제거 (오래된 도구 결과, 장황한 출력)
  | "ephemeral";  // 사용 후 자동 제거 (thinking 토큰, 진행 상황)

/** 컨텍스트 아이템 — 예산 관리의 최소 단위 */
export interface ContextItem {
  /** 고유 ID */
  id: string;
  /** 소속 카테고리 */
  category: keyof BudgetAllocation;
  /** 우선순위 */
  priority: ContextPriority;
  /** 콘텐츠 문자열 */
  content: string;
  /** 추정 토큰 수 */
  tokenCount: number;
  /** 생성 시각 (epoch ms) */
  timestamp: number;
  /** 메시지 역할 */
  role?: "system" | "user" | "assistant" | "tool";
  /** 도구 이름 (role=tool 일 때) */
  toolName?: string;
  /** 연관 파일 경로 */
  file?: string;
  /** 이미 요약되었는지 여부 */
  summarized?: boolean;
  /** 이 아이템이 요약한 원본 아이템 ID 목록 */
  summaryOf?: string[];
  /** 사용자가 수동으로 고정했는지 여부 */
  pinned?: boolean;
}

/** 요약 결과 */
export interface ContextSummary {
  /** 요약된 원본 아이템 ID 목록 */
  originalIds: string[];
  /** 원본 총 토큰 수 */
  originalTokens: number;
  /** 요약된 콘텐츠 */
  summarizedContent: string;
  /** 요약 토큰 수 */
  summarizedTokens: number;
  /** 압축률 (요약/원본) */
  compressionRatio: number;
  /** 생성 시각 (epoch ms) */
  createdAt: number;
}

/** 검색 쿼리 — 관련성 기반 컨텍스트 필터링 */
export interface RetrievalQuery {
  /** 현재 태스크 목표 */
  goal: string;
  /** 현재 작업 중인 파일 */
  currentFiles: string[];
  /** 최근 사용한 도구 */
  recentTools: string[];
  /** 추출된 키워드 */
  keywords: string[];
}

/** 검색 결과 */
export interface RetrievalResult {
  /** 검색된 아이템 목록 */
  items: ContextItem[];
  /** 총 토큰 수 */
  totalTokens: number;
  /** 예산 초과로 잘렸는지 여부 */
  truncated: boolean;
  /** 평균 관련성 점수 (0-1) */
  retrievalScore: number;
}

/** ContextBudgetManager 설정 */
export interface ContextBudgetConfig {
  /** 총 토큰 예산 (기본 128,000) */
  totalBudget: number;
  /** 카테고리별 예산 배분 */
  allocation: BudgetAllocation;

  // 요약 설정
  /** 요약 기능 활성화 (기본 true) */
  enableSummarization: boolean;
  /** 요약 트리거 사용률 (기본 0.75) */
  summarizationThreshold: number;
  /** 최소 요약 배치 크기 (기본 5) */
  minItemsToSummarize: number;
  /** 요약 최대 토큰 수 (기본 500) */
  maxSummaryLength: number;

  // 검색 설정
  /** 검색 기능 활성화 (기본 true) */
  enableRetrieval: boolean;
  /** 검색 시 최대 반환 아이템 수 (기본 20) */
  retrievalTopK: number;

  // 체크포인트 설정
  /** 체크포인트 기능 활성화 (기본 true) */
  enableCheckpoints: boolean;
  /** 체크포인트 생성 간격 (메시지 수, 기본 10) */
  checkpointInterval: number;
  /** 최대 유지 체크포인트 수 (기본 5) */
  maxCheckpoints: number;

  // 제거 설정
  /** 제거 전략 (기본 "hybrid") */
  evictionStrategy: "lru" | "priority" | "hybrid";
}

/** 예산 현황 */
export interface BudgetStatus {
  /** 총 예산 */
  totalBudget: number;
  /** 사용 중인 토큰 수 */
  usedTokens: number;
  /** 사용률 (0-1) */
  usagePercent: number;
  /** 카테고리별 현황 */
  byCategory: Record<keyof BudgetAllocation, {
    budget: number;
    used: number;
    percent: number;
    itemCount: number;
  }>;
  /** 요약 수행 횟수 */
  summarizationCount: number;
  /** 제거된 아이템 수 */
  evictionCount: number;
  /** 체크포인트 수 */
  checkpointCount: number;
  /** 건강 상태 */
  health: "healthy" | "warning" | "critical" | "overflow";
}

/** ContextBudgetManager의 직렬화 스냅샷 — 세션 영속성용 */
export interface ContextBudgetSnapshot {
  /** 모든 컨텍스트 아이템 (Map → 배열 변환) */
  items: Array<{ key: string; item: ContextItem }>;
  /** 요약 기록 */
  summaries: ContextSummary[];
  /** 체크포인트 목록 */
  checkpoints: ContextCheckpoint[];
  /** 내부 ID 카운터 */
  idCounter: number;
  /** 요약 수행 횟수 */
  summarizationCount: number;
  /** 제거된 아이템 수 */
  evictionCount: number;
}

/** 컨텍스트 체크포인트 — 슬라이딩 윈도우의 스냅샷 */
export interface ContextCheckpoint {
  /** 체크포인트 ID */
  id: string;
  /** 생성 시각 (epoch ms) */
  timestamp: number;
  /** 메시지 인덱스 */
  messageIndex: number;
  /** 축약된 요약 */
  summary: string;
  /** 핵심 결정 목록 */
  keyDecisions: string[];
  /** 현재 작업 중인 파일 목록 */
  activeFiles: string[];
  /** 토큰 수 */
  tokenCount: number;
}

// ─── Constants ───

const DEFAULT_ALLOCATION: BudgetAllocation = {
  systemPrompt: 15,
  projectContext: 10,
  conversationHistory: 40,
  toolResults: 25,
  workingMemory: 10,
};

const DEFAULT_CONFIG: Required<ContextBudgetConfig> = {
  totalBudget: 128_000,
  allocation: DEFAULT_ALLOCATION,
  enableSummarization: true,
  summarizationThreshold: 0.75,
  minItemsToSummarize: 5,
  maxSummaryLength: 500,
  enableRetrieval: true,
  retrievalTopK: 20,
  enableCheckpoints: true,
  checkpointInterval: 10,
  maxCheckpoints: 5,
  evictionStrategy: "hybrid",
};

/** 우선순위 → 숫자 (높을수록 중요) */
const PRIORITY_SCORES: Record<ContextPriority, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  ephemeral: 1,
};

/** 카테고리 간 차용 가능한 최대 오버플로우 (20%) */
const CATEGORY_OVERFLOW_LIMIT = 0.2;

// ─── ContextBudgetManager ───

/**
 * ContextBudgetManager — LLM 컨텍스트 윈도우 예산을 지능적으로 관리.
 *
 * 핵심 기능:
 * - 카테고리별 토큰 예산 배분 및 강제
 * - 우선순위 기반 아이템 제거 (hybrid LRU + priority)
 * - LLM 기반 요약을 통한 오래된 메시지 압축
 * - 관련성 점수 기반 검색으로 필요한 컨텍스트만 로드
 * - 슬라이딩 윈도우 + 체크포인트로 핵심 결정 보존
 *
 * 이벤트:
 * - `budget:warning` — 사용률 > 75%
 * - `budget:critical` — 사용률 > 90%
 * - `budget:overflow` — 사용률 > 100%, 강제 제거 수행
 * - `summarize:start` — 요약 시작
 * - `summarize:complete` — 요약 완료 (압축률 포함)
 * - `evict:items` — 아이템 제거됨
 * - `checkpoint:created` — 체크포인트 저장됨
 */
export class ContextBudgetManager extends EventEmitter {
  private readonly config: Required<ContextBudgetConfig>;
  private items: Map<string, ContextItem>;
  private summaries: ContextSummary[];
  private checkpoints: ContextCheckpoint[];
  private idCounter: number;
  private summarizationCount: number;
  private evictionCount: number;

  constructor(config?: Partial<ContextBudgetConfig>) {
    super();
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      allocation: {
        ...DEFAULT_ALLOCATION,
        ...config?.allocation,
      },
    };
    this.items = new Map();
    this.summaries = [];
    this.checkpoints = [];
    this.idCounter = 0;
    this.summarizationCount = 0;
    this.evictionCount = 0;
  }

  // ─── Item Management ───

  /**
   * 컨텍스트 아이템을 추가하고 자동으로 예산을 강제한다.
   * 추가 후 전체 사용률이 90%를 넘으면 `budget:critical` 이벤트를 발생시킨다.
   *
   * @param item - 아이템 메타데이터 (id, tokenCount, timestamp 자동 생성)
   * @param content - 아이템 콘텐츠
   * @returns 생성된 ContextItem
   */
  addItem(
    item: Omit<ContextItem, "id" | "tokenCount" | "timestamp">,
    content: string,
  ): ContextItem {
    const id = `ctx_${++this.idCounter}_${Date.now()}`;
    const tokenCount = this.estimateTokens(content);
    const timestamp = Date.now();

    const contextItem: ContextItem = {
      ...item,
      id,
      content,
      tokenCount,
      timestamp,
    };

    this.items.set(id, contextItem);
    this.checkBudgetHealth();

    return contextItem;
  }

  /**
   * 기존 아이템의 콘텐츠를 업데이트한다.
   * @param id - 아이템 ID
   * @param content - 새 콘텐츠
   */
  updateItem(id: string, content: string): void {
    const item = this.items.get(id);
    if (!item) return;

    item.content = content;
    item.tokenCount = this.estimateTokens(content);
    this.checkBudgetHealth();
  }

  /**
   * 아이템을 제거한다.
   * @param id - 제거할 아이템 ID
   */
  removeItem(id: string): void {
    this.items.delete(id);
  }

  /**
   * 아이템을 고정/해제한다. 고정된 아이템은 절대 제거되지 않는다.
   * @param id - 아이템 ID
   * @param pinned - 고정 여부 (기본 true)
   */
  pinItem(id: string, pinned: boolean = true): void {
    const item = this.items.get(id);
    if (item) {
      item.pinned = pinned;
    }
  }

  // ─── Budget Queries ───

  /**
   * 현재 예산 현황을 반환한다.
   * @returns 카테고리별 사용량, 건강 상태 등
   */
  getStatus(): BudgetStatus {
    const { totalBudget, allocation } = this.config;
    const usedTokens = this.getTotalUsedTokens();
    const usagePercent = usedTokens / totalBudget;

    const categories = Object.keys(allocation) as (keyof BudgetAllocation)[];
    const byCategory = {} as BudgetStatus["byCategory"];

    for (const cat of categories) {
      const budget = Math.floor(totalBudget * (allocation[cat] / 100));
      const catItems = this.getItemsByCategory(cat);
      const used = catItems.reduce((sum, it) => sum + it.tokenCount, 0);

      byCategory[cat] = {
        budget,
        used,
        percent: budget > 0 ? used / budget : 0,
        itemCount: catItems.length,
      };
    }

    let health: BudgetStatus["health"];
    if (usagePercent > 1.0) {
      health = "overflow";
    } else if (usagePercent > 0.9) {
      health = "critical";
    } else if (usagePercent > 0.75) {
      health = "warning";
    } else {
      health = "healthy";
    }

    return {
      totalBudget,
      usedTokens,
      usagePercent,
      byCategory,
      summarizationCount: this.summarizationCount,
      evictionCount: this.evictionCount,
      checkpointCount: this.checkpoints.length,
      health,
    };
  }

  /**
   * 특정 카테고리의 예산 토큰 수를 반환한다.
   * @param category - 카테고리 이름
   * @returns 해당 카테고리의 토큰 예산
   */
  getCategoryBudget(category: keyof BudgetAllocation): number {
    return Math.floor(
      this.config.totalBudget * (this.config.allocation[category] / 100),
    );
  }

  /**
   * 지정된 토큰 수를 추가할 공간이 있는지 확인한다.
   * @param tokens - 필요한 토큰 수
   * @param category - 특정 카테고리 체크 (미지정 시 전체)
   * @returns 공간 있으면 true
   */
  hasRoom(tokens: number, category?: keyof BudgetAllocation): boolean {
    if (category) {
      return this.getRemainingTokens(category) >= tokens;
    }
    return this.getTotalUsedTokens() + tokens <= this.config.totalBudget;
  }

  /**
   * 카테고리의 남은 토큰 수를 반환한다.
   * 카테고리 간 차용을 허용하여 소프트 예산의 20% 오버플로우까지 허용한다.
   * @param category - 카테고리 이름
   * @returns 남은 토큰 수
   */
  getRemainingTokens(category: keyof BudgetAllocation): number {
    const budget = this.getCategoryBudget(category);
    const overflowBudget = Math.floor(budget * (1 + CATEGORY_OVERFLOW_LIMIT));
    const used = this.getItemsByCategory(category).reduce(
      (sum, it) => sum + it.tokenCount,
      0,
    );
    return Math.max(0, overflowBudget - used);
  }

  // ─── Context Building ───

  /**
   * LLM 호출을 위한 최종 컨텍스트를 구축한다.
   * 예산 내에서 우선순위 순으로 아이템을 정렬하여 반환한다.
   * @returns 예산 내의 ContextItem 배열
   */
  buildContext(): ContextItem[] {
    const allItems = Array.from(this.items.values());

    // 우선순위 높은 것 먼저, 같은 우선순위 내에서는 최신 먼저
    allItems.sort((a, b) => {
      const pa = PRIORITY_SCORES[a.priority];
      const pb = PRIORITY_SCORES[b.priority];
      if (pa !== pb) return pb - pa;
      return a.timestamp - b.timestamp; // 시간순 (오래된 것 먼저)
    });

    const result: ContextItem[] = [];
    let totalTokens = 0;

    for (const item of allItems) {
      if (totalTokens + item.tokenCount <= this.config.totalBudget) {
        result.push(item);
        totalTokens += item.tokenCount;
      } else if (item.priority === "critical" || item.pinned) {
        // critical/pinned는 예산 초과해도 포함
        result.push(item);
        totalTokens += item.tokenCount;
      }
    }

    // 최종적으로 timestamp 순으로 정렬 (대화 순서 유지)
    result.sort((a, b) => a.timestamp - b.timestamp);

    return result;
  }

  /**
   * 관련성 기반 검색으로 컨텍스트를 구축한다.
   * 현재 작업과 관련 없는 아이템은 제외하여 토큰을 절약한다.
   * @param query - 검색 쿼리
   * @returns 검색 결과
   */
  buildContextWithRetrieval(query: RetrievalQuery): RetrievalResult {
    if (!this.config.enableRetrieval) {
      const items = this.buildContext();
      return {
        items,
        totalTokens: items.reduce((s, it) => s + it.tokenCount, 0),
        truncated: false,
        retrievalScore: 1.0,
      };
    }

    const allItems = Array.from(this.items.values());

    // 관련성 점수 계산 및 정렬
    const scored = allItems.map((item) => ({
      item,
      score: this.scoreRelevance(item, query),
    }));

    scored.sort((a, b) => {
      // critical은 항상 포함
      if (a.item.priority === "critical" && b.item.priority !== "critical") return -1;
      if (b.item.priority === "critical" && a.item.priority !== "critical") return 1;
      // pinned는 항상 포함
      if (a.item.pinned && !b.item.pinned) return -1;
      if (b.item.pinned && !a.item.pinned) return 1;
      // 나머지는 점수순
      return b.score - a.score;
    });

    const result: ContextItem[] = [];
    let totalTokens = 0;
    let totalScore = 0;
    let truncated = false;

    const topK = this.config.retrievalTopK;

    for (const { item, score } of scored) {
      // critical/pinned는 항상 포함
      if (item.priority === "critical" || item.pinned) {
        result.push(item);
        totalTokens += item.tokenCount;
        totalScore += score;
        continue;
      }

      // topK 초과 시 중단
      if (result.length >= topK) {
        truncated = true;
        break;
      }

      // 예산 초과 시 중단
      if (totalTokens + item.tokenCount > this.config.totalBudget) {
        truncated = true;
        break;
      }

      result.push(item);
      totalTokens += item.tokenCount;
      totalScore += score;
    }

    // timestamp 순 정렬
    result.sort((a, b) => a.timestamp - b.timestamp);

    return {
      items: result,
      totalTokens,
      truncated,
      retrievalScore: result.length > 0 ? totalScore / result.length : 0,
    };
  }

  /**
   * 카테고리별 아이템을 우선순위 → 최신순으로 정렬하여 반환한다.
   * @param category - 카테고리 이름
   * @returns 정렬된 ContextItem 배열
   */
  getItemsByCategory(category: keyof BudgetAllocation): ContextItem[] {
    const result: ContextItem[] = [];
    for (const item of this.items.values()) {
      if (item.category === category) {
        result.push(item);
      }
    }
    result.sort((a, b) => {
      const pa = PRIORITY_SCORES[a.priority];
      const pb = PRIORITY_SCORES[b.priority];
      if (pa !== pb) return pb - pa;
      return b.timestamp - a.timestamp;
    });
    return result;
  }

  // ─── Summarization ───

  /**
   * 오래된 medium 우선순위 메시지를 LLM으로 요약한다.
   * 연속된 medium 아이템을 그룹화하여 하나의 요약으로 교체한다.
   *
   * @param summarizeFn - LLM 요약 호출 함수
   * @returns 요약 결과 또는 null (요약 불필요 시)
   */
  async summarize(
    summarizeFn: (messages: string) => Promise<string>,
  ): Promise<ContextSummary | null> {
    if (!this.config.enableSummarization || !this.needsSummarization()) {
      return null;
    }

    // medium 우선순위 아이템 중 아직 요약되지 않은 것을 timestamp 순으로 수집
    const candidates: ContextItem[] = [];
    for (const item of this.items.values()) {
      if (
        item.priority === "medium" &&
        !item.summarized &&
        !item.pinned
      ) {
        candidates.push(item);
      }
    }

    candidates.sort((a, b) => a.timestamp - b.timestamp);

    if (candidates.length < this.config.minItemsToSummarize) {
      return null;
    }

    // 배치 선택: 가장 오래된 minItemsToSummarize 이상의 연속 아이템
    const batch = candidates.slice(
      0,
      Math.max(this.config.minItemsToSummarize, Math.floor(candidates.length / 2)),
    );

    const originalTokens = batch.reduce((s, it) => s + it.tokenCount, 0);
    const combinedContent = batch
      .map((it) => {
        const prefix = it.role ? `[${it.role}]` : "[context]";
        return `${prefix} ${it.content}`;
      })
      .join("\n\n---\n\n");

    const prompt =
      "Summarize the following conversation turns concisely. " +
      "Preserve key decisions, file changes, errors encountered, and important context. " +
      "Be brief but complete.\n\n" +
      combinedContent;

    this.emit("summarize:start", { itemCount: batch.length, tokens: originalTokens });

    let summarizedContent: string;
    try {
      summarizedContent = await summarizeFn(prompt);
    } catch {
      return null;
    }

    // 요약 토큰 수 제한
    const maxLen = this.config.maxSummaryLength;
    const summaryTokens = this.estimateTokens(summarizedContent);
    if (summaryTokens > maxLen) {
      // 대략적인 문자 수로 잘라냄
      const charLimit = Math.floor(maxLen * 3.5);
      summarizedContent = summarizedContent.slice(0, charLimit) + "...";
    }

    const summarizedTokens = this.estimateTokens(summarizedContent);
    const originalIds = batch.map((it) => it.id);

    // 원본 아이템 제거
    for (const item of batch) {
      this.items.delete(item.id);
    }

    // 요약 아이템 추가
    const summaryItem = this.addItem(
      {
        category: "conversationHistory",
        priority: "medium",
        content: summarizedContent,
        role: "system",
        summarized: true,
        summaryOf: originalIds,
      },
      `[Summary of ${originalIds.length} messages]\n${summarizedContent}`,
    );

    // 토큰 카운트는 addItem에서 자동 계산되므로 summaryItem.tokenCount 사용
    const summary: ContextSummary = {
      originalIds,
      originalTokens,
      summarizedContent,
      summarizedTokens: summaryItem.tokenCount,
      compressionRatio: summaryItem.tokenCount / originalTokens,
      createdAt: Date.now(),
    };

    this.summaries.push(summary);

    // Bound summaries array to prevent unbounded growth
    const MAX_SUMMARIES = 50;
    while (this.summaries.length > MAX_SUMMARIES) {
      this.summaries.shift();
    }

    this.summarizationCount++;

    this.emit("summarize:complete", {
      compressionRatio: summary.compressionRatio,
      savedTokens: originalTokens - summaryItem.tokenCount,
    });

    return summary;
  }

  /**
   * 요약이 필요한지 확인한다.
   * 전체 사용률이 summarizationThreshold를 초과하고
   * 요약 가능한 medium 아이템이 충분하면 true.
   * @returns 요약 필요 여부
   */
  needsSummarization(): boolean {
    if (!this.config.enableSummarization) return false;

    const usagePercent = this.getTotalUsedTokens() / this.config.totalBudget;
    if (usagePercent < this.config.summarizationThreshold) return false;

    let mediumCount = 0;
    for (const item of this.items.values()) {
      if (item.priority === "medium" && !item.summarized && !item.pinned) {
        mediumCount++;
      }
    }

    return mediumCount >= this.config.minItemsToSummarize;
  }

  // ─── Eviction ───

  /**
   * 지정된 토큰 수를 확보하기 위해 아이템을 제거한다.
   *
   * Hybrid 전략:
   * 1. ephemeral 아이템 먼저 제거
   * 2. low 우선순위 아이템 제거 (LRU 순)
   * 3. medium 우선순위 아이템 제거 (LRU 순)
   * 4. high는 최후의 수단으로만
   * 5. critical/pinned는 절대 제거 불가
   *
   * @param tokensNeeded - 확보해야 할 토큰 수
   * @returns 제거된 아이템 목록
   */
  evict(tokensNeeded: number): ContextItem[] {
    const evicted: ContextItem[] = [];
    let freed = 0;

    // 전략에 따라 제거 순서 결정
    const allItems = Array.from(this.items.values());
    const sortedForEviction = this.sortForEviction(allItems);

    for (const item of sortedForEviction) {
      if (freed >= tokensNeeded) break;

      // critical/pinned는 절대 제거 불가
      if (item.priority === "critical" || item.pinned) continue;

      this.items.delete(item.id);
      evicted.push(item);
      freed += item.tokenCount;
    }

    if (evicted.length > 0) {
      this.evictionCount += evicted.length;
      this.emit("evict:items", {
        count: evicted.length,
        freedTokens: freed,
        items: evicted.map((it) => ({
          id: it.id,
          priority: it.priority,
          category: it.category,
          tokens: it.tokenCount,
        })),
      });
    }

    return evicted;
  }

  /**
   * 예산을 자동으로 관리한다.
   * 사용률에 따라 요약 → 제거 순서로 토큰을 확보한다.
   *
   * @param summarizeFn - LLM 요약 호출 함수 (선택)
   * @returns 요약/제거된 아이템 수
   */
  async autoManage(
    summarizeFn?: (messages: string) => Promise<string>,
  ): Promise<{ summarized: number; evicted: number }> {
    let summarized = 0;
    let evicted = 0;

    const usagePercent = this.getTotalUsedTokens() / this.config.totalBudget;

    // 90% 이상이면 자동 관리 시작
    if (usagePercent < 0.9) {
      return { summarized, evicted };
    }

    // 1. 먼저 요약 시도
    if (summarizeFn && this.needsSummarization()) {
      const result = await this.summarize(summarizeFn);
      if (result) {
        summarized = result.originalIds.length;
      }
    }

    // 2. 여전히 예산 초과이면 제거
    const currentUsed = this.getTotalUsedTokens();
    const targetUsed = Math.floor(this.config.totalBudget * 0.8); // 80%까지 줄이기
    if (currentUsed > targetUsed) {
      const tokensToFree = currentUsed - targetUsed;
      const evictedItems = this.evict(tokensToFree);
      evicted = evictedItems.length;
    }

    return { summarized, evicted };
  }

  // ─── Checkpoints ───

  /**
   * 현재 상태의 체크포인트를 생성한다.
   * 체크포인트는 전체 컨텍스트의 축약 요약 + 핵심 결정 목록을 포함한다.
   *
   * @param messageIndex - 현재 메시지 인덱스
   * @param summarizeFn - LLM 요약 호출 함수
   * @returns 생성된 체크포인트
   */
  async createCheckpoint(
    messageIndex: number,
    summarizeFn: (text: string) => Promise<string>,
  ): Promise<ContextCheckpoint> {
    if (!this.config.enableCheckpoints) {
      throw new Error("Checkpoints are disabled");
    }

    // 핵심 결정 추출 (user/assistant 메시지에서)
    const keyDecisions: string[] = [];
    const activeFiles = new Set<string>();

    for (const item of this.items.values()) {
      if (item.file) {
        activeFiles.add(item.file);
      }

      // 사용자 요청 또는 승인/거부 결정 추출
      if (item.role === "user" && item.content) {
        const preview = item.content.slice(0, 120);
        keyDecisions.push(`User: ${preview}${item.content.length > 120 ? "..." : ""}`);
      }
      if (
        item.role === "assistant" &&
        item.content &&
        (item.content.includes("[APPROVED]") ||
          item.content.includes("[REJECTED]") ||
          item.content.includes("decision:"))
      ) {
        keyDecisions.push(item.content.slice(0, 200));
      }
    }

    // 전체 컨텍스트를 축약 요약
    const allContent = Array.from(this.items.values())
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((it) => `[${it.role ?? it.category}] ${it.content?.slice(0, 200) ?? ""}`)
      .join("\n");

    const summaryPrompt =
      "Create a brief checkpoint summary (2-3 sentences) of this conversation context. " +
      "Focus on: current goal, progress made, files modified, and key decisions.\n\n" +
      allContent.slice(0, 8000);

    let summary: string;
    try {
      summary = await summarizeFn(summaryPrompt);
    } catch {
      summary = `Checkpoint at message ${messageIndex}. ${this.items.size} context items, ${this.getTotalUsedTokens()} tokens used.`;
    }

    const checkpoint: ContextCheckpoint = {
      id: `ckpt_${Date.now()}_${messageIndex}`,
      timestamp: Date.now(),
      messageIndex,
      summary,
      keyDecisions: keyDecisions.slice(0, 10),
      activeFiles: Array.from(activeFiles),
      tokenCount: this.getTotalUsedTokens(),
    };

    this.checkpoints.push(checkpoint);

    // 최대 체크포인트 수 유지
    while (this.checkpoints.length > this.config.maxCheckpoints) {
      this.checkpoints.shift();
    }

    this.emit("checkpoint:created", checkpoint);

    return checkpoint;
  }

  /**
   * 체크포인트에서 복원한다.
   * 현재 아이템을 모두 지우고 체크포인트 요약을 시스템 메시지로 추가한다.
   *
   * @param checkpoint - 복원할 체크포인트
   */
  restoreFromCheckpoint(checkpoint: ContextCheckpoint): void {
    this.items.clear();

    // 체크포인트 요약을 시스템 메시지로 추가
    this.addItem(
      {
        category: "conversationHistory",
        priority: "critical",
        content: checkpoint.summary,
        role: "system",
        summarized: true,
      },
      `[Restored from checkpoint ${checkpoint.id}]\n${checkpoint.summary}`,
    );

    // 핵심 결정을 워킹 메모리로 추가
    if (checkpoint.keyDecisions.length > 0) {
      this.addItem(
        {
          category: "workingMemory",
          priority: "high",
          content: checkpoint.keyDecisions.join("\n"),
          role: "system",
        },
        `[Key decisions]\n${checkpoint.keyDecisions.join("\n")}`,
      );
    }
  }

  /**
   * 모든 체크포인트를 반환한다.
   * @returns 읽기 전용 체크포인트 배열
   */
  getCheckpoints(): readonly ContextCheckpoint[] {
    return this.checkpoints;
  }

  // ─── Retrieval ───

  /**
   * 아이템의 현재 작업에 대한 관련성 점수를 계산한다.
   *
   * 점수 구성:
   * - fileMatch (0.3): 현재 작업 파일과 일치
   * - keywordMatch (0.25): 키워드 겹침
   * - recencyScore (0.2): 최신일수록 높음
   * - priorityScore (0.15): 높은 우선순위일수록 높음
   * - toolMatch (0.1): 최근 사용 도구와 일치
   *
   * @param item - 평가할 아이템
   * @param query - 검색 쿼리
   * @returns 관련성 점수 (0-1)
   */
  scoreRelevance(item: ContextItem, query: RetrievalQuery): number {
    let score = 0;

    // 1. 파일 매치 (0.3)
    if (item.file && query.currentFiles.length > 0) {
      const fileMatch = query.currentFiles.some(
        (f) => item.file === f || item.content.includes(f),
      );
      if (fileMatch) score += 0.3;
    } else if (query.currentFiles.length > 0) {
      // 콘텐츠에 파일 경로가 포함되어 있는지 확인
      const contentFileMatch = query.currentFiles.some((f) =>
        item.content.includes(f),
      );
      if (contentFileMatch) score += 0.2;
    }

    // 2. 키워드 매치 (0.25)
    if (query.keywords.length > 0) {
      const contentLower = item.content.toLowerCase();
      let matchCount = 0;
      for (const kw of query.keywords) {
        if (contentLower.includes(kw.toLowerCase())) {
          matchCount++;
        }
      }
      score += 0.25 * (matchCount / query.keywords.length);
    }

    // 3. 최신성 점수 (0.2)
    const now = Date.now();
    const age = now - item.timestamp;
    const maxAge = 30 * 60 * 1000; // 30분
    const recency = Math.max(0, 1 - age / maxAge);
    score += 0.2 * recency;

    // 4. 우선순위 점수 (0.15)
    const priorityScore = PRIORITY_SCORES[item.priority] / 5; // 0-1 정규화
    score += 0.15 * priorityScore;

    // 5. 도구 매치 (0.1)
    if (item.toolName && query.recentTools.length > 0) {
      if (query.recentTools.includes(item.toolName)) {
        score += 0.1;
      }
    }

    return Math.min(1, score);
  }

  // ─── Serialization ───

  /**
   * JSON 직렬화 — 세션 영속성을 위해 전체 상태를 스냅샷으로 변환한다.
   * Map/Set → 배열 변환을 수행한다.
   *
   * @returns ContextBudgetSnapshot
   */
  toJSON(): ContextBudgetSnapshot {
    return {
      items: Array.from(this.items.entries()).map(([key, item]) => ({ key, item })),
      summaries: [...this.summaries],
      checkpoints: [...this.checkpoints],
      idCounter: this.idCounter,
      summarizationCount: this.summarizationCount,
      evictionCount: this.evictionCount,
    };
  }

  /**
   * JSON에서 ContextBudgetManager를 복구한다.
   * 기존 config를 유지하면서 저장된 런타임 상태를 복원한다.
   *
   * @param snapshot - 저장된 스냅샷
   * @param config - 예산 설정 (미지정 시 기본값)
   * @returns 복원된 ContextBudgetManager
   */
  static fromJSON(
    snapshot: ContextBudgetSnapshot,
    config?: Partial<ContextBudgetConfig>,
  ): ContextBudgetManager {
    const manager = new ContextBudgetManager(config);

    // 아이템 복원
    for (const { key, item } of snapshot.items) {
      manager.items.set(key, item);
    }

    // 요약/체크포인트/카운터 복원
    manager.summaries = [...(snapshot.summaries ?? [])];
    manager.checkpoints = [...(snapshot.checkpoints ?? [])];
    manager.idCounter = snapshot.idCounter ?? 0;
    manager.summarizationCount = snapshot.summarizationCount ?? 0;
    manager.evictionCount = snapshot.evictionCount ?? 0;

    return manager;
  }

  // ─── Token Counting ───

  /**
   * 문자열의 대략적인 토큰 수를 추정한다.
   *
   * CJK 문자가 30% 이상이면 CJK 모드 (~2 chars/token),
   * 그 외에는 영어 모드 (~3.5 chars/token).
   *
   * @param text - 추정할 문자열
   * @returns 추정 토큰 수
   */
  estimateTokens(text: string): number {
    if (!text) return 0;
    const cjkCount = (text.match(/[\u3000-\u9fff\uac00-\ud7af]/g) ?? []).length;
    const nonCjkCount = text.length - cjkCount;

    // CJK 비율이 높으면 전체를 2로 나눔
    if (cjkCount > text.length * 0.3) {
      return Math.ceil(text.length / 2);
    }

    return Math.ceil(nonCjkCount / 3.5 + cjkCount / 2);
  }

  // ─── Conversion ───

  /**
   * 현재 아이템을 LLM 호출용 Message[] 로 변환한다.
   * 예산 내의 아이템만 포함하며, timestamp 순으로 정렬한다.
   *
   * @returns Message 배열
   */
  toMessages(): Message[] {
    const items = this.buildContext();
    const messages: Message[] = [];

    for (const item of items) {
      const role = item.role ?? "system";
      messages.push({
        role,
        content: item.content,
      });
    }

    return messages;
  }

  /**
   * 기존 Message[] 히스토리를 아이템으로 임포트한다.
   * 각 메시지를 적절한 카테고리와 우선순위로 분류한다.
   *
   * @param messages - 임포트할 메시지 배열
   */
  importMessages(messages: Message[]): void {
    const total = messages.length;

    for (let i = 0; i < total; i++) {
      const msg = messages[i];
      const isRecent = i >= total - 5;

      let category: keyof BudgetAllocation;
      let priority: ContextPriority;

      switch (msg.role) {
        case "system":
          category = "systemPrompt";
          priority = "critical";
          break;
        case "user":
          category = "conversationHistory";
          priority = isRecent ? "high" : "medium";
          break;
        case "assistant":
          category = "conversationHistory";
          priority = isRecent ? "high" : "medium";
          break;
        case "tool":
          category = "toolResults";
          priority = isRecent ? "high" : "low";
          break;
        default:
          category = "conversationHistory";
          priority = "medium";
      }

      // 첫 번째 user 메시지는 목표이므로 high
      if (msg.role === "user" && i <= 1) {
        priority = "high";
      }

      const contentStr = contentToString(msg.content);
      this.addItem(
        {
          category,
          priority,
          content: contentStr,
          role: msg.role,
        },
        contentStr,
      );
    }
  }

  // ─── Private Helpers ───

  /**
   * 전체 사용 중인 토큰 수를 계산한다.
   */
  private getTotalUsedTokens(): number {
    let total = 0;
    for (const item of this.items.values()) {
      total += item.tokenCount;
    }
    return total;
  }

  /**
   * 예산 건강 상태를 확인하고 필요 시 이벤트를 발생시킨다.
   */
  private checkBudgetHealth(): void {
    const usagePercent = this.getTotalUsedTokens() / this.config.totalBudget;

    if (usagePercent > 1.0) {
      this.emit("budget:overflow", { usagePercent, usedTokens: this.getTotalUsedTokens() });
    } else if (usagePercent > 0.9) {
      this.emit("budget:critical", { usagePercent, usedTokens: this.getTotalUsedTokens() });
    } else if (usagePercent > 0.75) {
      this.emit("budget:warning", { usagePercent, usedTokens: this.getTotalUsedTokens() });
    }
  }

  /**
   * 제거 전략에 따라 아이템을 정렬한다.
   * 제거 순서: ephemeral → low → medium → high (oldest first within each)
   *
   * @param items - 정렬할 아이템 배열
   * @returns 제거 우선순위 순으로 정렬된 배열
   */
  private sortForEviction(items: ContextItem[]): ContextItem[] {
    const { evictionStrategy } = this.config;

    return [...items].sort((a, b) => {
      // pinned/critical은 항상 마지막
      if (a.pinned || a.priority === "critical") return 1;
      if (b.pinned || b.priority === "critical") return -1;

      switch (evictionStrategy) {
        case "lru":
          // 오래된 것 먼저
          return a.timestamp - b.timestamp;

        case "priority":
          // 낮은 우선순위 먼저
          return PRIORITY_SCORES[a.priority] - PRIORITY_SCORES[b.priority];

        case "hybrid":
        default: {
          // 낮은 우선순위 먼저, 같은 우선순위 내에서 오래된 것 먼저
          const pa = PRIORITY_SCORES[a.priority];
          const pb = PRIORITY_SCORES[b.priority];
          if (pa !== pb) return pa - pb;
          return a.timestamp - b.timestamp;
        }
      }
    });
  }
}
