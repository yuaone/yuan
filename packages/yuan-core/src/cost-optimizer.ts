/**
 * cost-optimizer.ts — LLM Cost Optimization Module for YUAN Coding Agent
 *
 * Selects optimal models per task, predicts token usage,
 * tracks costs, and enforces budget constraints.
 */

// ─── Types ───────────────────────────────────────────────────────────

export type ModelTier = "cheap" | "standard" | "premium";

export interface ModelProfile {
  tier: ModelTier;
  name: string;
  inputCostPer1M: number;
  outputCostPer1M: number;
  maxContext: number;
  capabilities: string[];
}

export interface CostEstimate {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUSD: number;
  model: string;
  tier: ModelTier;
}

export interface CostRecord {
  model: string;
  tier: ModelTier;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  taskType: string;
  timestamp: number;
}

export interface SessionCostSummary {
  totalCostUSD: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byModel: Record<string, { cost: number; tokens: number; calls: number }>;
  byTier: Record<ModelTier, { cost: number; tokens: number; calls: number }>;
  budgetRemaining: number;
  budgetUsedPercent: number;
}

export interface CostOptimizerConfig {
  budgetUSD: number;
  defaultTier: ModelTier;
  models: ModelProfile[];
  enableAutoSelect: boolean;
  costWarningThreshold: number;
}

// ─── Constants ───────────────────────────────────────────────────────

const DEFAULT_MODELS: ModelProfile[] = [
  {
    tier: "cheap",
    name: "claude-haiku-4-5",
    inputCostPer1M: 0.80,
    outputCostPer1M: 4.00,
    maxContext: 200_000,
    capabilities: ["simple", "classify", "grep"],
  },
  {
    tier: "cheap",
    name: "gpt-4o-mini",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60,
    maxContext: 128_000,
    capabilities: ["simple", "classify", "coding"],
  },
  {
    tier: "standard",
    name: "claude-sonnet-4-6",
    inputCostPer1M: 3.00,
    outputCostPer1M: 15.00,
    maxContext: 200_000,
    capabilities: ["coding", "review", "test", "planning"],
  },
  {
    tier: "standard",
    name: "gpt-4o",
    inputCostPer1M: 2.50,
    outputCostPer1M: 10.00,
    maxContext: 128_000,
    capabilities: ["coding", "review", "test"],
  },
  {
    tier: "premium",
    name: "claude-opus-4-6",
    inputCostPer1M: 15.00,
    outputCostPer1M: 75.00,
    maxContext: 200_000,
    capabilities: ["coding", "planning", "debate", "review", "complex_refactor"],
  },
  {
    tier: "premium",
    name: "o3",
    inputCostPer1M: 10.00,
    outputCostPer1M: 40.00,
    maxContext: 200_000,
    capabilities: ["coding", "planning", "debate", "complex_refactor"],
  },
];

const DEFAULT_CONFIG: CostOptimizerConfig = {
  budgetUSD: 1.0,
  defaultTier: "standard",
  models: DEFAULT_MODELS,
  enableAutoSelect: true,
  costWarningThreshold: 0.8,
};

/**
 * Maps a task type to its base model tier.
 * Tasks not listed here default to "standard".
 */
const TASK_TIER_MAP: Record<string, ModelTier> = {
  classify: "cheap",
  grep: "cheap",
  simple_edit: "cheap",
  coding: "standard",
  review: "standard",
  test: "standard",
  planning: "premium",
  debate: "premium",
  complex_refactor: "premium",
};

/**
 * Output-to-input token ratio heuristics per task type.
 * A ratio of 1.2 means the model is expected to produce
 * 1.2x as many output tokens as input tokens.
 */
const TOKEN_OUTPUT_RATIO: Record<string, number> = {
  classify: 0.3,
  coding: 1.2,
  planning: 2.0,
  review: 0.8,
  simple_edit: 0.5,
  grep: 0.3,
  test: 1.0,
  debate: 1.5,
  complex_refactor: 1.5,
};

const TIER_ORDER: ModelTier[] = ["cheap", "standard", "premium"];

// ─── Helpers ─────────────────────────────────────────────────────────

function tierIndex(tier: ModelTier): number {
  return TIER_ORDER.indexOf(tier);
}

function clampTier(index: number): ModelTier {
  const clamped = Math.max(0, Math.min(index, TIER_ORDER.length - 1));
  return TIER_ORDER[clamped];
}

function computeCost(
  profile: ModelProfile,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens / 1_000_000) * profile.inputCostPer1M +
    (outputTokens / 1_000_000) * profile.outputCostPer1M
  );
}

function emptyTierBucket(): { cost: number; tokens: number; calls: number } {
  return { cost: 0, tokens: 0, calls: 0 };
}

// ─── CostOptimizer ──────────────────────────────────────────────────

export class CostOptimizer {
  private config: CostOptimizerConfig;
  private records: CostRecord[] = [];
  private models: Map<string, ModelProfile> = new Map();

  constructor(config?: Partial<CostOptimizerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // If caller provided models, use them; otherwise use defaults
    if (config?.models) {
      this.config.models = config.models;
    }

    for (const model of this.config.models) {
      this.models.set(model.name, model);
    }
  }

  // ── Model Selection ──────────────────────────────────────────────

  /**
   * Select the optimal model for a given task.
   *
   * Selection logic:
   *  1. Determine base tier from taskType
   *  2. Apply complexity modifier (trivial/simple → downgrade, complex/massive → upgrade)
   *  3. Apply budget pressure (low budget → downgrade)
   *  4. Pick the cheapest model in the resolved tier that has a matching capability
   *  5. If auto-select is disabled, use defaultTier
   */
  selectModel(
    taskType: string,
    complexity: string,
    estimatedTokens?: number,
  ): ModelProfile {
    let tier = this.config.enableAutoSelect
      ? this.resolveBaseTier(taskType)
      : this.config.defaultTier;

    // Complexity modifier
    tier = this.applyComplexityModifier(tier, complexity);

    // Budget pressure
    tier = this.applyBudgetPressure(tier, taskType, estimatedTokens);

    // Find best model in tier
    return this.pickModelForTier(tier, taskType);
  }

  // ── Token Prediction ─────────────────────────────────────────────

  /**
   * Predict input and output token counts for a task.
   *
   * Input tokens are estimated as roughly `inputLength / 4` (avg chars per token).
   * Output tokens use a task-specific multiplier on the input token count.
   */
  predictTokens(
    taskType: string,
    inputLength: number,
  ): { input: number; output: number } {
    const inputTokens = Math.ceil(inputLength / 4);
    const ratio = TOKEN_OUTPUT_RATIO[taskType] ?? 1.0;
    const outputTokens = Math.ceil(inputTokens * ratio);
    return { input: inputTokens, output: outputTokens };
  }

  // ── Cost Estimation ──────────────────────────────────────────────

  /**
   * Estimate the cost of a task before execution.
   * Combines token prediction with model selection to produce a USD estimate.
   */
  estimateCost(taskType: string, inputLength: number): CostEstimate {
    const { input, output } = this.predictTokens(taskType, inputLength);
    const model = this.selectModel(taskType, "normal", input);
    const cost = computeCost(model, input, output);

    return {
      estimatedInputTokens: input,
      estimatedOutputTokens: output,
      estimatedCostUSD: Math.round(cost * 1_000_000) / 1_000_000,
      model: model.name,
      tier: model.tier,
    };
  }

  // ── Usage Recording ──────────────────────────────────────────────

  /**
   * Record actual token usage after an LLM call completes.
   * The cost is computed from the model's pricing profile.
   * If the model is unknown, cost is recorded as 0.
   */
  recordUsage(
    model: string,
    inputTokens: number,
    outputTokens: number,
    taskType: string,
  ): void {
    const profile = this.models.get(model);
    const tier: ModelTier = profile?.tier ?? this.config.defaultTier;
    const costUSD = profile ? computeCost(profile, inputTokens, outputTokens) : 0;

    this.records.push({
      model,
      tier,
      inputTokens,
      outputTokens,
      costUSD,
      taskType,
      timestamp: Date.now(),
    });
  }

  // ── Summary ──────────────────────────────────────────────────────

  /**
   * Produce a summary of all costs recorded in this session.
   */
  getSummary(): SessionCostSummary {
    const byModel: Record<string, { cost: number; tokens: number; calls: number }> = {};
    const byTier: Record<ModelTier, { cost: number; tokens: number; calls: number }> = {
      cheap: emptyTierBucket(),
      standard: emptyTierBucket(),
      premium: emptyTierBucket(),
    };

    let totalCostUSD = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const record of this.records) {
      totalCostUSD += record.costUSD;
      totalInputTokens += record.inputTokens;
      totalOutputTokens += record.outputTokens;

      // By model
      if (!byModel[record.model]) {
        byModel[record.model] = { cost: 0, tokens: 0, calls: 0 };
      }
      byModel[record.model].cost += record.costUSD;
      byModel[record.model].tokens += record.inputTokens + record.outputTokens;
      byModel[record.model].calls += 1;

      // By tier
      byTier[record.tier].cost += record.costUSD;
      byTier[record.tier].tokens += record.inputTokens + record.outputTokens;
      byTier[record.tier].calls += 1;
    }

    const budgetRemaining = Math.max(0, this.config.budgetUSD - totalCostUSD);
    const budgetUsedPercent =
      this.config.budgetUSD > 0
        ? Math.min(100, (totalCostUSD / this.config.budgetUSD) * 100)
        : 100;

    return {
      totalCostUSD: Math.round(totalCostUSD * 1_000_000) / 1_000_000,
      totalInputTokens,
      totalOutputTokens,
      byModel,
      byTier,
      budgetRemaining: Math.round(budgetRemaining * 1_000_000) / 1_000_000,
      budgetUsedPercent: Math.round(budgetUsedPercent * 100) / 100,
    };
  }

  // ── Budget ───────────────────────────────────────────────────────

  /**
   * Check whether the session is still within its budget.
   * Optionally include an additional planned cost to see if it would exceed.
   */
  isWithinBudget(additionalCostUSD: number = 0): boolean {
    const spent = this.totalSpent();
    return spent + additionalCostUSD <= this.config.budgetUSD;
  }

  /**
   * Returns a warning string if budget usage has crossed the configured
   * warning threshold. Returns null if usage is below the threshold.
   */
  getBudgetWarning(): string | null {
    const spent = this.totalSpent();
    const usedPercent = this.config.budgetUSD > 0
      ? spent / this.config.budgetUSD
      : 1;

    if (usedPercent >= 1.0) {
      return `Budget exhausted: $${spent.toFixed(4)} / $${this.config.budgetUSD.toFixed(2)} (${(usedPercent * 100).toFixed(1)}%)`;
    }

    if (usedPercent >= this.config.costWarningThreshold) {
      return `Budget warning: $${spent.toFixed(4)} / $${this.config.budgetUSD.toFixed(2)} (${(usedPercent * 100).toFixed(1)}% used)`;
    }

    return null;
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Reset all recorded usage for a new session.
   * Model registrations and config are preserved.
   */
  reset(): void {
    this.records = [];
  }

  // ── Model Management ─────────────────────────────────────────────

  /**
   * Return all registered model profiles.
   */
  getModels(): ModelProfile[] {
    return Array.from(this.models.values());
  }

  /**
   * Register a new model or update an existing one.
   */
  registerModel(profile: ModelProfile): void {
    this.models.set(profile.name, profile);

    // Keep config.models in sync
    const idx = this.config.models.findIndex((m) => m.name === profile.name);
    if (idx >= 0) {
      this.config.models[idx] = profile;
    } else {
      this.config.models.push(profile);
    }
  }

  // ── Private Helpers ──────────────────────────────────────────────

  /**
   * Resolve the base tier for a task type using the static mapping.
   */
  private resolveBaseTier(taskType: string): ModelTier {
    return TASK_TIER_MAP[taskType] ?? this.config.defaultTier;
  }

  /**
   * Shift tier up or down based on complexity label.
   *
   *  - "trivial" | "simple"  → downgrade one tier (min: cheap)
   *  - "complex" | "massive" → upgrade one tier (max: premium)
   *  - anything else         → no change
   */
  private applyComplexityModifier(tier: ModelTier, complexity: string): ModelTier {
    const normalized = complexity.toLowerCase();
    const idx = tierIndex(tier);

    if (normalized === "trivial" || normalized === "simple") {
      return clampTier(idx - 1);
    }
    if (normalized === "complex" || normalized === "massive") {
      return clampTier(idx + 1);
    }
    return tier;
  }

  /**
   * Downgrade tier when budget is under pressure.
   *
   *  - If remaining budget < estimated cost × 2 → downgrade one tier
   *  - If remaining budget < 10% of total budget → force cheap
   */
  private applyBudgetPressure(
    tier: ModelTier,
    taskType: string,
    estimatedTokens?: number,
  ): ModelTier {
    const spent = this.totalSpent();
    const remaining = this.config.budgetUSD - spent;
    const budgetFraction = this.config.budgetUSD > 0
      ? remaining / this.config.budgetUSD
      : 0;

    // Force cheap when nearly out of budget
    if (budgetFraction < 0.10) {
      return "cheap";
    }

    // Downgrade if the estimated cost is tight
    if (estimatedTokens !== undefined && estimatedTokens > 0) {
      const candidates = this.modelsForTier(tier);
      if (candidates.length > 0) {
        const cheapest = candidates[0]; // sorted cheapest-first
        const ratio = TOKEN_OUTPUT_RATIO[taskType] ?? 1.0;
        const outputEstimate = Math.ceil(estimatedTokens * ratio);
        const estimatedCost = computeCost(cheapest, estimatedTokens, outputEstimate);

        if (remaining < estimatedCost * 2) {
          return clampTier(tierIndex(tier) - 1);
        }
      }
    }

    return tier;
  }

  /**
   * Pick the cheapest model in the given tier whose capabilities
   * include the requested task type.  Falls back to cheapest in-tier
   * if no capability match, then falls back to the cheapest model overall.
   */
  private pickModelForTier(tier: ModelTier, taskType: string): ModelProfile {
    const candidates = this.modelsForTier(tier);

    // Prefer models whose capabilities include the task type
    const capable = candidates.filter((m) => m.capabilities.includes(taskType));
    if (capable.length > 0) {
      return capable[0];
    }

    // Fallback: any model in the tier
    if (candidates.length > 0) {
      return candidates[0];
    }

    // Ultimate fallback: cheapest model overall
    const all = this.allModelsSorted();
    if (all.length > 0) {
      return all[0];
    }

    // Should never happen if config has at least one model
    throw new Error(
      `CostOptimizer: no models registered. Cannot select a model for tier="${tier}" task="${taskType}".`,
    );
  }

  /**
   * Return models for a given tier, sorted by total cost (cheapest first).
   * Total cost heuristic: inputCostPer1M + outputCostPer1M.
   */
  private modelsForTier(tier: ModelTier): ModelProfile[] {
    return Array.from(this.models.values())
      .filter((m) => m.tier === tier)
      .sort(
        (a, b) =>
          a.inputCostPer1M + a.outputCostPer1M -
          (b.inputCostPer1M + b.outputCostPer1M),
      );
  }

  /**
   * Return all models sorted by total cost (cheapest first).
   */
  private allModelsSorted(): ModelProfile[] {
    return Array.from(this.models.values()).sort(
      (a, b) =>
        a.inputCostPer1M + a.outputCostPer1M -
        (b.inputCostPer1M + b.outputCostPer1M),
    );
  }

  /**
   * Sum of all recorded costs so far.
   */
  private totalSpent(): number {
    let total = 0;
    for (const r of this.records) {
      total += r.costUSD;
    }
    return total;
  }
}
