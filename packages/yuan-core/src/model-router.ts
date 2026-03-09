/**
 * @module model-router
 * @description ModelRouter — 태스크·역할·복잡도·API 키 조합으로 최적 LLM 모델을 결정하는 라우터.
 *
 * 라우팅 알고리즘:
 * 1. 태스크 유형에서 필요 역량(strengths) 추출
 * 2. 사용 가능한 프로바이더(API 키 보유)로 모델 필터링
 * 3. 역량 매칭·비용·성능 통계·복잡도 적합성을 가중 합산하여 스코어링
 * 4. 최고 스코어 모델을 primary로, 차순위 2개를 fallback으로 반환
 *
 * 통합 지점:
 * - ParallelExecutor: 태스크별 모델 할당
 * - Planner: PlannedTask에 추천 모델 주석
 * - AgentLoop: 단일 에이전트 모드 기본 모델 선택
 */

import type {
  LLMProvider,
  BYOKConfig,
  AgentRole,
  FixedAgentRole,
  TaskContract,
} from "./types.js";
import { PROVIDER_BASE_URLS } from "./constants.js";
import { RoleConfigRegistry } from "./role-registry.js";

// ─── Public Types ───

/** 태스크 복잡도 수준 */
export type TaskComplexityLevel =
  | "trivial"
  | "simple"
  | "moderate"
  | "complex"
  | "critical";

/** 모델 티어 — 비용/품질 트레이드오프 */
export type ModelTierLevel = "economy" | "standard" | "premium" | "flagship";

/** 라우팅 결정 결과 */
export interface RoutingDecision {
  /** 선택된 프로바이더 */
  provider: LLMProvider;
  /** 선택된 모델 ID */
  model: string;
  /** 모델 티어 */
  tier: ModelTierLevel;
  /** 선택 사유 (디버깅/로깅용) */
  reason: string;
  /** 대체 모델 목록 (최대 2개) */
  fallbacks: Array<{ provider: LLMProvider; model: string }>;
  /** 1K 토큰당 예상 비용 (input+output 평균, USD) */
  estimatedCostPer1kTokens: number;
}

/** 사용 가능한 프로바이더 API 키 설정 */
export interface AvailableProviders {
  anthropic?: { apiKey: string; baseUrl?: string };
  openai?: { apiKey: string; baseUrl?: string };
  google?: { apiKey: string; baseUrl?: string };
  yua?: { apiKey: string; baseUrl?: string };
  deepseek?: { apiKey: string; baseUrl?: string };
}

/** 모델 성능 통계 (적응형 라우팅용) */
export interface ModelStats {
  provider: LLMProvider;
  model: string;
  avgLatencyMs: number;
  successRate: number;
  avgTokensPerTask: number;
  totalCalls: number;
  lastError?: string;
  lastUsed: number;
}

/** 라우터 설정 */
export interface ModelRouterConfig {
  /** 사용 가능한 프로바이더 API 키 */
  providers: AvailableProviders;
  /** 비용 최적화 전략: "quality"는 최고 모델 선호, "balanced", "economy"는 최저 비용 선호 */
  costStrategy: "quality" | "balanced" | "economy";
  /** 세션당 최대 비용 (USD, 근사치) */
  maxSessionCostUsd?: number;
  /** 모든 태스크에 특정 프로바이더 강제 (라우팅 오버라이드) */
  forceProvider?: LLMProvider;
  /** 모든 태스크에 특정 모델 강제 */
  forceModel?: string;
}

// ─── Internal Types ───

/** 모델 카탈로그 엔트리 */
export interface ModelEntry {
  provider: LLMProvider;
  model: string;
  tier: ModelTierLevel;
  costPer1kInput: number;
  costPer1kOutput: number;
  strengths: string[];
  maxContext: number;
}

/** 내부 스코어링 결과 */
interface ScoredModel {
  entry: ModelEntry;
  score: number;
  reason: string;
}

// ─── Model Catalog ───

/** 지원 모델 카탈로그 — 프로바이더별 모델, 티어, 비용, 역량 정의 */
const MODEL_CATALOG: ModelEntry[] = [
  // Anthropic
  {
    provider: "anthropic",
    model: "claude-opus-4-20250514",
    tier: "flagship",
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
    strengths: ["reasoning", "planning", "analysis", "debugging"],
    maxContext: 200_000,
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    tier: "premium",
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
    strengths: ["coding", "editing", "review", "security"],
    maxContext: 200_000,
  },
  {
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    tier: "economy",
    costPer1kInput: 0.0008,
    costPer1kOutput: 0.004,
    strengths: ["simple", "search", "documentation"],
    maxContext: 200_000,
  },
  // OpenAI
  {
    provider: "openai",
    model: "gpt-4o",
    tier: "premium",
    costPer1kInput: 0.0025,
    costPer1kOutput: 0.01,
    strengths: ["coding", "testing", "data", "function_calling"],
    maxContext: 128_000,
  },
  {
    provider: "openai",
    model: "gpt-4o-mini",
    tier: "economy",
    costPer1kInput: 0.00015,
    costPer1kOutput: 0.0006,
    strengths: ["simple", "boilerplate", "search", "automation"],
    maxContext: 128_000,
  },
  {
    provider: "openai",
    model: "o3",
    tier: "flagship",
    costPer1kInput: 0.01,
    costPer1kOutput: 0.04,
    strengths: ["reasoning", "planning", "debugging", "analysis"],
    maxContext: 200_000,
  },
  // Google
  {
    provider: "google",
    model: "gemini-2.5-pro",
    tier: "premium",
    costPer1kInput: 0.00125,
    costPer1kOutput: 0.005,
    strengths: ["review", "analysis", "large_context"],
    maxContext: 1_000_000,
  },
  {
    provider: "google",
    model: "gemini-2.5-flash",
    tier: "standard",
    costPer1kInput: 0.00015,
    costPer1kOutput: 0.0006,
    strengths: ["coding", "fast", "search", "boilerplate"],
    maxContext: 1_000_000,
  },
  // YUA (OpenAI-compatible, self-hosted)
  {
    provider: "yua",
    model: "yua-pro",
    tier: "premium",
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
    strengths: ["coding", "review", "planning", "analysis"],
    maxContext: 128_000,
  },
  {
    provider: "yua",
    model: "yua-basic",
    tier: "economy",
    costPer1kInput: 0.0005,
    costPer1kOutput: 0.002,
    strengths: ["simple", "search", "boilerplate", "documentation"],
    maxContext: 128_000,
  },
  // DeepSeek
  {
    provider: "deepseek",
    model: "deepseek-chat",
    tier: "standard",
    costPer1kInput: 0.00014,
    costPer1kOutput: 0.00028,
    strengths: ["coding", "review", "debugging", "refactoring"],
    maxContext: 128_000,
  },
  {
    provider: "deepseek",
    model: "deepseek-reasoner",
    tier: "premium",
    costPer1kInput: 0.00055,
    costPer1kOutput: 0.0022,
    strengths: ["reasoning", "planning", "analysis", "debugging"],
    maxContext: 128_000,
  },
];

// ─── Task → Strengths Mapping ───

/** 태스크 유형별 요구 역량 매핑 */
const TASK_STRENGTH_MAP: Record<string, string[]> = {
  planning: ["reasoning", "planning", "analysis"],
  coding: ["coding", "editing"],
  code_review: ["review", "analysis", "security"],
  testing: ["testing", "coding", "boilerplate"],
  debugging: ["debugging", "reasoning", "analysis"],
  refactoring: ["coding", "review", "analysis"],
  search: ["search", "fast", "simple"],
  documentation: ["documentation", "simple"],
  security_scan: ["security", "review", "analysis"],
  data_processing: ["data", "function_calling"],
  simple_edit: ["simple", "fast", "editing"],
  boilerplate: ["boilerplate", "fast", "simple"],
};

// ─── Tier Weights ───

/** 티어별 가중치 (quality 전략용) */
const TIER_WEIGHT: Record<ModelTierLevel, number> = {
  economy: 0.25,
  standard: 0.5,
  premium: 0.75,
  flagship: 1.0,
};

/** 복잡도 → 최소 적합 티어 매핑 */
const COMPLEXITY_MIN_TIER: Record<TaskComplexityLevel, ModelTierLevel> = {
  trivial: "economy",
  simple: "economy",
  moderate: "standard",
  complex: "premium",
  critical: "flagship",
};

/** 티어 순서 (숫자 비교용) */
const TIER_ORDER: Record<ModelTierLevel, number> = {
  economy: 0,
  standard: 1,
  premium: 2,
  flagship: 3,
};

// ─── Complexity Keywords ───

/** 복잡도 추정을 위한 키워드 → 복잡도 매핑 (순서대로 매칭 — 첫 번째 매칭 사용) */
const COMPLEXITY_KEYWORDS: Array<{
  pattern: RegExp;
  level: TaskComplexityLevel;
}> = [
  { pattern: /\b(full\s+rewrite|security\s+audit|complete\s+overhaul)\b/i, level: "critical" },
  { pattern: /\b(redesign|migrat(e|ion)|architecture|large[- ]scale)\b/i, level: "complex" },
  { pattern: /\b(implement\s+feature|refactor|restructure|integrate)\b/i, level: "moderate" },
  { pattern: /\b(add\s+field|update\s+config|minor\s+change|small\s+fix)\b/i, level: "simple" },
  { pattern: /\b(fix\s+typo|rename|formatting|whitespace|comment)\b/i, level: "trivial" },
];

// ─── Role → Task Type Mapping ───

/** 고정 역할 → 기본 태스크 유형 매핑 */
const ROLE_TASK_MAP: Record<FixedAgentRole, string> = {
  orchestrator: "planning",
  coder: "coding",
  reviewer: "code_review",
  memory: "documentation",
  search: "search",
  security: "security_scan",
  data: "data_processing",
  automation: "boilerplate",
};

// ─── ModelRouter ───

/**
 * ModelRouter — 태스크·역할·복잡도·API 키 조합으로 최적 LLM 모델을 선택하는 라우터.
 *
 * 동일한 입력에 대해 항상 동일한 결과를 반환한다 (결정론적).
 * 단, `recordStats()`로 축적된 성능 통계가 변하면 스코어가 달라질 수 있다.
 *
 * @example
 * ```typescript
 * const router = new ModelRouter({
 *   providers: { anthropic: { apiKey: "sk-..." } },
 *   costStrategy: "balanced",
 * });
 *
 * const decision = router.route("coding", "coder", "moderate");
 * const config = router.toBYOKConfig(decision);
 * ```
 */
export class ModelRouter {
  private readonly config: ModelRouterConfig;
  private readonly stats = new Map<string, ModelStats>();
  private readonly roleRegistry = new RoleConfigRegistry();
  private accumulatedCostUsd = 0;

  constructor(config: ModelRouterConfig) {
    this.config = config;
  }

  // ─── Public API ───

  /**
   * 태스크를 최적 모델로 라우팅한다.
   *
   * @param taskType - 태스크 유형 (TASK_STRENGTH_MAP 키 또는 임의 문자열)
   * @param role - 에이전트 역할 (선택적, 역할에서 태스크 유형을 추론할 수 있음)
   * @param complexity - 태스크 복잡도 (선택적, 기본 "moderate")
   * @returns 라우팅 결정 (모델, 티어, fallback, 예상 비용 포함)
   * @throws 사용 가능한 프로바이더가 없으면 Error
   */
  route(
    taskType: string,
    role?: AgentRole,
    complexity: TaskComplexityLevel = "moderate",
  ): RoutingDecision {
    if (!this.hasProvider()) {
      throw new Error(
        "ModelRouter: No API keys configured. Provide at least one provider in config.providers.",
      );
    }

    // Budget check
    if (this.isBudgetExhausted()) {
      throw new Error(
        `ModelRouter: Session budget exhausted ($${this.accumulatedCostUsd.toFixed(4)} / $${this.config.maxSessionCostUsd}).`,
      );
    }

    // Resolve effective task type from role if needed
    const effectiveTaskType = this.resolveTaskType(taskType, role);

    // Force overrides
    if (this.config.forceProvider || this.config.forceModel) {
      return this.buildForcedDecision(effectiveTaskType, complexity);
    }

    // Score and rank models
    const scored = this.scoreModels(effectiveTaskType, complexity);
    if (scored.length === 0) {
      throw new Error(
        "ModelRouter: No models available for configured providers.",
      );
    }

    const primary = scored[0]!;
    const fallbacks = scored
      .slice(1, 3)
      .map((s) => ({ provider: s.entry.provider, model: s.entry.model }));

    return {
      provider: primary.entry.provider,
      model: primary.entry.model,
      tier: primary.entry.tier,
      reason: primary.reason,
      fallbacks,
      estimatedCostPer1kTokens: this.avgCostPer1k(primary.entry),
    };
  }

  /**
   * TaskContract를 기반으로 최적 모델을 라우팅한다.
   * 계약의 목표, 역할, 파일 수, 예상 반복 횟수에서 복잡도를 자동 추정한다.
   *
   * @param contract - 태스크 계약
   * @returns 라우팅 결정
   */
  routeForContract(contract: TaskContract): RoutingDecision {
    const fileCount =
      contract.inputSchema.files.length +
      contract.outputSchema.expectedFiles.length;

    const complexity = this.estimateComplexity(
      contract.goal,
      fileCount,
    );

    // Infer task type from role
    const taskType = this.taskTypeFromRole(contract.assignedRole);

    return this.route(taskType, contract.assignedRole, complexity);
  }

  /**
   * 태스크 설명·파일 수·예상 반복 횟수에서 복잡도를 추정한다.
   *
   * 우선순위:
   * 1. fileCount / estimatedIterations 기반 범위 판정
   * 2. description 키워드 매칭
   * 3. 기본값 "moderate"
   *
   * @param description - 태스크 설명
   * @param fileCount - 관련 파일 수 (선택적)
   * @param estimatedIterations - 예상 반복 횟수 (선택적)
   * @returns 추정된 복잡도 수준
   */
  estimateComplexity(
    description: string,
    fileCount?: number,
    estimatedIterations?: number,
  ): TaskComplexityLevel {
    // 1. Numeric heuristic (higher priority — more objective)
    const numericLevel = this.complexityFromMetrics(
      fileCount ?? 0,
      estimatedIterations ?? 0,
    );

    // 2. Keyword heuristic
    const keywordLevel = this.complexityFromKeywords(description);

    // Return the higher complexity of the two (conservative)
    if (numericLevel && keywordLevel) {
      return TIER_ORDER[COMPLEXITY_MIN_TIER[numericLevel]] >=
        TIER_ORDER[COMPLEXITY_MIN_TIER[keywordLevel]]
        ? numericLevel
        : keywordLevel;
    }

    return numericLevel ?? keywordLevel ?? "moderate";
  }

  /**
   * 라우팅 결정을 BYOKConfig로 변환한다.
   *
   * @param decision - 라우팅 결정
   * @returns BYOKConfig (BYOKClient 생성자에 전달 가능)
   * @throws 해당 프로바이더의 API 키가 없으면 Error
   */
  toBYOKConfig(decision: RoutingDecision): BYOKConfig {
    const providerConfig = this.config.providers[decision.provider];
    if (!providerConfig) {
      throw new Error(
        `ModelRouter: No API key configured for provider "${decision.provider}".`,
      );
    }

    return {
      provider: decision.provider,
      apiKey: providerConfig.apiKey,
      model: decision.model,
      baseUrl:
        providerConfig.baseUrl ?? PROVIDER_BASE_URLS[decision.provider],
    };
  }

  /**
   * 모델 성능 통계를 기록한다 (적응형 라우팅용).
   * 호출 수, 평균 레이턴시, 성공률, 평균 토큰을 누적 평균으로 갱신한다.
   *
   * @param provider - 프로바이더
   * @param model - 모델 ID
   * @param latencyMs - 응답 레이턴시 (ms)
   * @param success - 성공 여부
   * @param tokensUsed - 사용된 토큰 수
   */
  recordStats(
    provider: LLMProvider,
    model: string,
    latencyMs: number,
    success: boolean,
    tokensUsed: number,
  ): void {
    const key = `${provider}:${model}`;
    const existing = this.stats.get(key);

    if (!existing) {
      this.stats.set(key, {
        provider,
        model,
        avgLatencyMs: latencyMs,
        successRate: success ? 1.0 : 0.0,
        avgTokensPerTask: tokensUsed,
        totalCalls: 1,
        lastError: success ? undefined : "Failed",
        lastUsed: Date.now(),
      });
      return;
    }

    const n = existing.totalCalls;
    existing.avgLatencyMs = (existing.avgLatencyMs * n + latencyMs) / (n + 1);
    existing.successRate = (existing.successRate * n + (success ? 1 : 0)) / (n + 1);
    existing.avgTokensPerTask =
      (existing.avgTokensPerTask * n + tokensUsed) / (n + 1);
    existing.totalCalls = n + 1;
    existing.lastUsed = Date.now();
    if (!success) {
      existing.lastError = "Failed";
    }
  }

  /**
   * 축적된 모델 성능 통계를 반환한다.
   *
   * @returns 모든 모델의 성능 통계 배열
   */
  getStats(): ModelStats[] {
    return Array.from(this.stats.values());
  }

  /**
   * 사용 가능한 모델 목록을 반환한다 (API 키가 설정된 프로바이더만 필터링).
   *
   * @returns 사용 가능한 모델 카탈로그 엔트리 배열
   */
  getAvailableModels(): ModelEntry[] {
    return MODEL_CATALOG.filter((entry) => this.isProviderAvailable(entry.provider));
  }

  /**
   * 최소 하나의 프로바이더가 설정되어 있는지 확인한다.
   *
   * @returns true면 사용 가능한 프로바이더가 있음
   */
  hasProvider(): boolean {
    const { providers } = this.config;
    return !!(
      providers.anthropic?.apiKey ||
      providers.openai?.apiKey ||
      providers.google?.apiKey
    );
  }

  /**
   * 누적 비용을 추가한다 (세션 예산 추적용).
   *
   * @param costUsd - 추가할 비용 (USD)
   */
  addCost(costUsd: number): void {
    this.accumulatedCostUsd += costUsd;
  }

  /**
   * 현재 누적 비용을 반환한다.
   *
   * @returns 누적 비용 (USD)
   */
  getAccumulatedCost(): number {
    return this.accumulatedCostUsd;
  }

  // ─── Private: Scoring ───

  /**
   * 사용 가능한 모든 모델에 대해 스코어를 계산하고 내림차순 정렬한다.
   *
   * 스코어 공식:
   *   finalScore = strengthMatch * 0.4 + costScore * 0.2 + performanceScore * 0.2 + complexityFit * 0.2
   */
  private scoreModels(
    taskType: string,
    complexity: TaskComplexityLevel,
  ): ScoredModel[] {
    const available = this.getAvailableModels();
    if (available.length === 0) return [];

    const requiredStrengths = TASK_STRENGTH_MAP[taskType] ?? [];

    // Pre-compute cost normalization range
    const costs = available.map((e) => this.avgCostPer1k(e));
    const maxCost = Math.max(...costs, 0.001); // avoid division by zero
    const minCost = Math.min(...costs, 0.001);
    const costRange = maxCost - minCost || 0.001;

    const scored: ScoredModel[] = available.map((entry) => {
      // 1. Strength match (0..1)
      const strengthMatch =
        requiredStrengths.length > 0
          ? requiredStrengths.filter((s) => entry.strengths.includes(s)).length /
            requiredStrengths.length
          : 0.5; // no preference → neutral

      // 2. Cost score (0..1) — strategy-dependent
      const entryCost = this.avgCostPer1k(entry);
      const costScore = this.computeCostScore(
        entryCost,
        minCost,
        costRange,
        entry.tier,
      );

      // 3. Performance score from stats (0..1)
      const performanceScore = this.computePerformanceScore(entry);

      // 4. Complexity fit (0..1)
      const complexityFit = this.computeComplexityFit(entry.tier, complexity);

      const finalScore =
        strengthMatch * 0.4 +
        costScore * 0.2 +
        performanceScore * 0.2 +
        complexityFit * 0.2;

      const matchedStrengths = requiredStrengths.filter((s) =>
        entry.strengths.includes(s),
      );
      const reason = [
        `score=${finalScore.toFixed(3)}`,
        `strengths=[${matchedStrengths.join(",")}]`,
        `tier=${entry.tier}`,
        `strategy=${this.config.costStrategy}`,
      ].join(" ");

      return { entry, score: finalScore, reason };
    });

    // Sort descending by score — deterministic tiebreak by model name
    scored.sort((a, b) => {
      const diff = b.score - a.score;
      if (Math.abs(diff) > 1e-9) return diff;
      return a.entry.model.localeCompare(b.entry.model);
    });

    return scored;
  }

  /**
   * 비용 전략에 따른 비용 스코어 계산.
   * - economy: 저비용일수록 높은 스코어
   * - quality: 고티어일수록 높은 스코어
   * - balanced: 비용과 티어의 균형
   */
  private computeCostScore(
    entryCost: number,
    minCost: number,
    costRange: number,
    tier: ModelTierLevel,
  ): number {
    switch (this.config.costStrategy) {
      case "economy": {
        // Inverse cost normalized to 0..1 (cheapest = 1.0)
        return 1.0 - (entryCost - minCost) / costRange;
      }
      case "quality": {
        // Tier weight directly
        return TIER_WEIGHT[tier];
      }
      case "balanced": {
        // Average of inverse cost and tier weight
        const inverseCost = 1.0 - (entryCost - minCost) / costRange;
        return (inverseCost + TIER_WEIGHT[tier]) / 2;
      }
      default:
        return 0.5;
    }
  }

  /**
   * 축적된 성능 통계에서 성능 스코어를 계산한다.
   * 통계가 없으면 중립값 0.5를 반환한다.
   */
  private computePerformanceScore(entry: ModelEntry): number {
    const key = `${entry.provider}:${entry.model}`;
    const stat = this.stats.get(key);

    if (!stat || stat.totalCalls === 0) {
      return 0.5; // neutral — no data
    }

    // successRate: 0..1 → contributes directly
    // latency: lower is better → normalize with a reference (5000ms = 0, 0ms = 1)
    const latencyScore = Math.max(
      0,
      Math.min(1, 1 - stat.avgLatencyMs / 10_000),
    );

    return stat.successRate * 0.7 + latencyScore * 0.3;
  }

  /**
   * 모델 티어가 태스크 복잡도에 적합한지 평가한다 (0..1).
   * 정확히 매칭하면 1.0, 한 단계 차이면 0.7, 그 이상이면 감소.
   */
  private computeComplexityFit(
    tier: ModelTierLevel,
    complexity: TaskComplexityLevel,
  ): number {
    const idealTier = COMPLEXITY_MIN_TIER[complexity];
    const tierDiff = Math.abs(TIER_ORDER[tier] - TIER_ORDER[idealTier]);

    switch (tierDiff) {
      case 0:
        return 1.0;
      case 1:
        return 0.7;
      case 2:
        return 0.4;
      default:
        return 0.2;
    }
  }

  // ─── Private: Complexity Estimation ───

  /** 파일 수·반복 횟수에서 복잡도 추정 */
  private complexityFromMetrics(
    fileCount: number,
    estimatedIterations: number,
  ): TaskComplexityLevel | null {
    // Both zero → cannot determine
    if (fileCount === 0 && estimatedIterations === 0) return null;

    if (fileCount <= 1 && estimatedIterations <= 2) return "trivial";
    if (fileCount <= 3 && estimatedIterations <= 5) return "simple";
    if (fileCount <= 10 && estimatedIterations <= 15) return "moderate";
    if (fileCount <= 30 && estimatedIterations <= 50) return "complex";
    return "critical";
  }

  /** 설명 키워드에서 복잡도 추정 */
  private complexityFromKeywords(
    description: string,
  ): TaskComplexityLevel | null {
    for (const { pattern, level } of COMPLEXITY_KEYWORDS) {
      if (pattern.test(description)) {
        return level;
      }
    }
    return null;
  }

  // ─── Private: Helpers ───

  /** 프로바이더에 API 키가 설정되어 있는지 확인 */
  private isProviderAvailable(provider: LLMProvider): boolean {
    return !!this.config.providers[provider]?.apiKey;
  }

  /** 모델의 평균 비용 (input + output) / 2 per 1K tokens */
  private avgCostPer1k(entry: ModelEntry): number {
    return (entry.costPer1kInput + entry.costPer1kOutput) / 2;
  }

  /** 세션 예산이 소진되었는지 확인 */
  private isBudgetExhausted(): boolean {
    if (this.config.maxSessionCostUsd == null) return false;
    return this.accumulatedCostUsd >= this.config.maxSessionCostUsd;
  }

  /** role에서 taskType 추론 */
  private taskTypeFromRole(role: AgentRole): string {
    if (typeof role === "string" && this.roleRegistry.isFixedRole(role)) {
      return ROLE_TASK_MAP[role] ?? "coding";
    }
    // Dynamic role — fall back to "coding"
    return "coding";
  }

  /** taskType과 role 조합에서 유효한 taskType 결정 */
  private resolveTaskType(taskType: string, role?: AgentRole): string {
    // If taskType is in the map, use it directly
    if (TASK_STRENGTH_MAP[taskType]) {
      return taskType;
    }

    // Try to infer from role
    if (role) {
      const inferred = this.taskTypeFromRole(role);
      if (TASK_STRENGTH_MAP[inferred]) {
        return inferred;
      }
    }

    // Fall back to "coding" as the most common task type
    return "coding";
  }

  /**
   * forceProvider/forceModel 설정 시 강제 결정 생성.
   * 강제된 모델이 카탈로그에 있으면 해당 엔트리 사용,
   * 없으면 기본값으로 구성하되 fallback은 정상 스코어링으로 계산.
   */
  private buildForcedDecision(
    taskType: string,
    complexity: TaskComplexityLevel,
  ): RoutingDecision {
    const { forceProvider, forceModel } = this.config;

    // Find forced model in catalog
    const forced = MODEL_CATALOG.find((entry) => {
      if (forceProvider && forceModel) {
        return entry.provider === forceProvider && entry.model === forceModel;
      }
      if (forceModel) {
        return entry.model === forceModel && this.isProviderAvailable(entry.provider);
      }
      if (forceProvider) {
        return entry.provider === forceProvider && this.isProviderAvailable(entry.provider);
      }
      return false;
    });

    if (forced) {
      // Compute fallbacks from remaining available models
      const fallbacks = this.scoreModels(taskType, complexity)
        .filter(
          (s) =>
            !(s.entry.provider === forced.provider && s.entry.model === forced.model),
        )
        .slice(0, 2)
        .map((s) => ({ provider: s.entry.provider, model: s.entry.model }));

      return {
        provider: forced.provider,
        model: forced.model,
        tier: forced.tier,
        reason: `Forced: provider=${forced.provider} model=${forced.model}`,
        fallbacks,
        estimatedCostPer1kTokens: this.avgCostPer1k(forced),
      };
    }

    // Forced model/provider not in catalog — construct minimal decision
    const provider = forceProvider ?? "openai";
    const model = forceModel ?? "unknown";

    if (!this.isProviderAvailable(provider)) {
      throw new Error(
        `ModelRouter: Forced provider "${provider}" has no API key configured.`,
      );
    }

    const fallbacks = this.scoreModels(taskType, complexity)
      .slice(0, 2)
      .map((s) => ({ provider: s.entry.provider, model: s.entry.model }));

    return {
      provider,
      model,
      tier: "standard",
      reason: `Forced (not in catalog): provider=${provider} model=${model}`,
      fallbacks,
      estimatedCostPer1kTokens: 0,
    };
  }
}
