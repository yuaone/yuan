/**
 * @module token-budget
 * @description Role-based Token Budget Manager.
 *
 * Allocates token budgets by agent role (Governor, Planner, Executor, Validator,
 * Reflector, Classifier) to prevent any single role from consuming too many tokens.
 * Tracks usage per role and enforces limits with soft/hard thresholds.
 *
 * @example
 * ```typescript
 * const manager = new TokenBudgetManager({
 *   totalBudget: 50_000,
 *   roleBudgets: { executor: 20_000, planner: 8_000 },
 * });
 *
 * manager.recordUsage("executor", 500, 1200);
 * const check = manager.canUse("executor", 3000);
 * if (!check.allowed) console.warn(check.reason);
 *
 * console.log(manager.formatStatus());
 * ```
 */

// ─── Types ───

/** Agent roles for token budget allocation */
export type BudgetRole =
  | "governor"
  | "planner"
  | "executor"
  | "validator"
  | "reflector"
  | "classifier";

/** All known agent roles */
const ALL_ROLES: readonly BudgetRole[] = [
  "governor",
  "planner",
  "executor",
  "validator",
  "reflector",
  "classifier",
] as const;

/** Configuration for role-based token budgets */
export interface RoleBudgetConfig {
  /** Total tokens for entire run */
  totalBudget: number;
  /** Per-role token limits (미지정 시 기본값 사용) */
  roleBudgets?: Partial<Record<BudgetRole, number>>;
  /** Warn at this ratio (default 0.8) */
  softLimitRatio?: number;
  /** What to do at hard limit (default "throttle") */
  hardLimitAction?: "warn" | "throttle" | "block";
}

/** Per-role usage tracking */
export interface RoleUsage {
  role: BudgetRole;
  budget: number;
  used: number;
  remaining: number;
  /** 0–100 */
  percentage: number;
  status: "ok" | "warning" | "exceeded";
}

/** Result of a budget check */
export interface BudgetCheckResult {
  allowed: boolean;
  role: BudgetRole;
  remaining: number;
  /** If not allowed */
  reason?: string;
  /** E.g., "try a simpler approach" */
  suggestion?: string;
}

/** Overall budget status across all roles */
export interface OverallBudgetStatus {
  totalBudget: number;
  totalUsed: number;
  totalRemaining: number;
  /** 0–100 */
  percentage: number;
  roleStatuses: RoleUsage[];
  /** Which role is closest to its limit */
  bottleneck: BudgetRole | null;
}

// ─── Defaults ───

/** Default per-role token budgets (based on typical coding agent runs) */
const DEFAULT_ROLE_BUDGETS: Record<BudgetRole, number> = {
  governor: 8_000,
  planner: 4_000,
  executor: 16_000,
  validator: 8_000,
  reflector: 2_000,
  classifier: 1_000,
};

const DEFAULT_SOFT_LIMIT_RATIO = 0.8;
const DEFAULT_HARD_LIMIT_ACTION: NonNullable<RoleBudgetConfig["hardLimitAction"]> = "throttle";

// ─── Internal tracking ───

interface InternalRoleState {
  budget: number;
  used: number;
  /** Epoch ms of last recordUsage call, 0 if never used */
  lastActivity: number;
}

// ─── TokenBudgetManager ───

/**
 * TokenBudgetManager — allocates and enforces per-role token budgets.
 *
 * Key behaviours:
 * - `canUse()` returns `allowed: false` when hard limit is reached, with a helpful suggestion.
 * - `rebalance()` redistributes unused budget from idle roles to active ones.
 * - At soft limit (default 80%) status changes to "warning".
 * - "throttle" hard-limit action: halves estimated tokens and allows with warning.
 * - Fully synchronous — no async needed.
 */
export class TokenBudgetManager {
  private readonly totalBudget: number;
  private readonly softLimitRatio: number;
  private readonly hardLimitAction: "warn" | "throttle" | "block";
  private readonly roles: Map<BudgetRole, InternalRoleState>;

  constructor(config: RoleBudgetConfig) {
    this.totalBudget = config.totalBudget;
    this.softLimitRatio = config.softLimitRatio ?? DEFAULT_SOFT_LIMIT_RATIO;
    this.hardLimitAction = config.hardLimitAction ?? DEFAULT_HARD_LIMIT_ACTION;

    this.roles = new Map();

    for (const role of ALL_ROLES) {
      const budget =
        config.roleBudgets?.[role] ?? DEFAULT_ROLE_BUDGETS[role];
      this.roles.set(role, { budget, used: 0, lastActivity: 0 });
    }
  }

  // ─── Public API ───

  /**
   * Record token usage for a role.
   * @param role  - agent role
   * @param input - input tokens consumed
   * @param output - output tokens consumed
   */
  recordUsage(role: BudgetRole, input: number, output: number): void {
    const state = this.getState(role);
    state.used += input + output;
    state.lastActivity = Date.now();
  }

  /**
   * Check if a role can use more tokens.
   * @param role - agent role
   * @param estimatedTokens - how many tokens the role wants to use (default 0)
   * @returns BudgetCheckResult
   */
  canUse(role: BudgetRole, estimatedTokens: number = 0): BudgetCheckResult {
    const state = this.getState(role);
    const remaining = Math.max(0, state.budget - state.used);

    // Within budget — straightforward allow
    if (state.used + estimatedTokens <= state.budget) {
      return { allowed: true, role, remaining };
    }

    // Budget exceeded — apply hard limit action
    switch (this.hardLimitAction) {
      case "block":
        return {
          allowed: false,
          role,
          remaining,
          reason: `Role "${role}" has exhausted its token budget (${state.used}/${state.budget}).`,
          suggestion:
            role === "executor"
              ? "Try a simpler approach or break the task into smaller steps."
              : role === "planner"
                ? "Reduce planning depth; use a shorter plan."
                : "Consider rebalancing budgets or resetting usage.",
        };

      case "warn":
        return {
          allowed: true,
          role,
          remaining,
          reason: `Warning: role "${role}" is over budget (${state.used}/${state.budget}).`,
          suggestion: "Budget exceeded but execution is allowed under 'warn' policy.",
        };

      case "throttle": {
        // Halve estimated tokens and allow with warning
        const throttled = Math.floor(estimatedTokens / 2);
        const wouldFit = state.used + throttled <= state.budget || remaining > 0;
        if (wouldFit) {
          return {
            allowed: true,
            role,
            remaining,
            reason: `Throttled: role "${role}" approaching limit. Estimated tokens halved from ${estimatedTokens} to ${throttled}.`,
            suggestion: "Use a more concise prompt or reduce output length.",
          };
        }
        return {
          allowed: false,
          role,
          remaining,
          reason: `Role "${role}" has exhausted its token budget even after throttling (${state.used}/${state.budget}).`,
          suggestion:
            "Try a simpler approach, rebalance budgets, or reset usage for a new run.",
        };
      }
    }
  }

  /**
   * Get current usage for a role.
   */
  getUsage(role: BudgetRole): RoleUsage {
    const state = this.getState(role);
    return this.buildRoleUsage(role, state);
  }

  /**
   * Get overall budget status.
   */
  getOverallStatus(): OverallBudgetStatus {
    let totalUsed = 0;
    const roleStatuses: RoleUsage[] = [];
    let bottleneckRole: BudgetRole | null = null;
    let highestPercentage = -1;

    for (const role of ALL_ROLES) {
      const state = this.getState(role);
      const usage = this.buildRoleUsage(role, state);
      roleStatuses.push(usage);
      totalUsed += state.used;

      if (usage.percentage > highestPercentage) {
        highestPercentage = usage.percentage;
        bottleneckRole = role;
      }
    }

    const totalRemaining = Math.max(0, this.totalBudget - totalUsed);
    const percentage =
      this.totalBudget > 0 ? (totalUsed / this.totalBudget) * 100 : 0;

    return {
      totalBudget: this.totalBudget,
      totalUsed,
      totalRemaining,
      percentage: Math.round(percentage * 100) / 100,
      roleStatuses,
      bottleneck: bottleneckRole,
    };
  }

  /**
   * Get all role statuses as a Map.
   */
  getAllRoleStatuses(): Map<BudgetRole, RoleUsage> {
    const result = new Map<BudgetRole, RoleUsage>();
    for (const role of ALL_ROLES) {
      result.set(role, this.getUsage(role));
    }
    return result;
  }

  /**
   * Rebalance remaining budget between roles.
   *
   * Logic:
   * - Find roles under 50% usage with no recent activity (idle > 30 s) — donors.
   * - Find roles over 70% usage — recipients.
   * - Redistribute donor surplus proportionally to recipients.
   * - Never exceed totalBudget across all roles.
   */
  rebalance(): void {
    const now = Date.now();
    const IDLE_THRESHOLD_MS = 30_000; // 30 seconds

    // Identify donors and recipients
    const donors: { role: BudgetRole; state: InternalRoleState; surplus: number }[] = [];
    const recipients: { role: BudgetRole; state: InternalRoleState; percentage: number }[] = [];

    for (const role of ALL_ROLES) {
      const state = this.getState(role);
      const percentage = state.budget > 0 ? (state.used / state.budget) * 100 : 0;
      const isIdle =
        state.lastActivity > 0 && now - state.lastActivity > IDLE_THRESHOLD_MS;

      if (percentage < 50 && isIdle) {
        // Donor: give away remaining budget minus a small buffer
        const surplus = Math.max(0, state.budget - state.used);
        if (surplus > 0) {
          donors.push({ role, state, surplus });
        }
      } else if (percentage > 70) {
        recipients.push({ role, state, percentage });
      }
    }

    if (donors.length === 0 || recipients.length === 0) return;

    // Total surplus available
    const totalSurplus = donors.reduce((sum, d) => sum + d.surplus, 0);

    // Total "need" — proportional to how far over 70% each recipient is
    const totalNeed = recipients.reduce((sum, r) => sum + r.percentage, 0);

    // Guard against totalBudget overflow
    const currentTotalBudget = this.sumAllBudgets();

    for (const recipient of recipients) {
      const share = totalNeed > 0 ? recipient.percentage / totalNeed : 1 / recipients.length;
      let grant = Math.floor(totalSurplus * share);

      // Ensure we don't exceed totalBudget
      const newTotal = currentTotalBudget + grant - totalSurplus;
      if (newTotal > this.totalBudget) {
        grant = Math.max(0, grant - (newTotal - this.totalBudget));
      }

      recipient.state.budget += grant;
    }

    // Reduce donor budgets
    for (const donor of donors) {
      donor.state.budget = donor.state.used; // shrink to exactly what was used
    }
  }

  /**
   * Reset all usage (for a new run).
   */
  reset(): void {
    for (const state of this.roles.values()) {
      state.used = 0;
      state.lastActivity = 0;
    }
  }

  /**
   * Format status for logging — returns a table-like string.
   */
  formatStatus(): string {
    const overall = this.getOverallStatus();
    const lines: string[] = [];

    lines.push("┌─────────────┬──────────┬──────────┬───────────┬──────────┬──────────┐");
    lines.push("│ Role        │   Budget │     Used │ Remaining │      Pct │  Status  │");
    lines.push("├─────────────┼──────────┼──────────┼───────────┼──────────┼──────────┤");

    for (const rs of overall.roleStatuses) {
      const rolePad = rs.role.padEnd(11);
      const budgetPad = String(rs.budget).padStart(8);
      const usedPad = String(rs.used).padStart(8);
      const remainPad = String(rs.remaining).padStart(9);
      const pctPad = `${rs.percentage.toFixed(1)}%`.padStart(8);
      const statusPad = rs.status.padStart(8);
      lines.push(
        `│ ${rolePad} │ ${budgetPad} │ ${usedPad} │ ${remainPad} │ ${pctPad} │ ${statusPad} │`,
      );
    }

    lines.push("├─────────────┼──────────┼──────────┼───────────┼──────────┼──────────┤");

    const totalLabel = "TOTAL".padEnd(11);
    const totalBudgetPad = String(overall.totalBudget).padStart(8);
    const totalUsedPad = String(overall.totalUsed).padStart(8);
    const totalRemainPad = String(overall.totalRemaining).padStart(9);
    const totalPctPad = `${overall.percentage.toFixed(1)}%`.padStart(8);
    const bottleneckStr = overall.bottleneck ?? "—";
    const bnPad = bottleneckStr.padStart(8);
    lines.push(
      `│ ${totalLabel} │ ${totalBudgetPad} │ ${totalUsedPad} │ ${totalRemainPad} │ ${totalPctPad} │ ${bnPad} │`,
    );

    lines.push("└─────────────┴──────────┴──────────┴───────────┴──────────┴──────────┘");

    return lines.join("\n");
  }

  // ─── Private Helpers ───

  private getState(role: BudgetRole): InternalRoleState {
    const state = this.roles.get(role);
    if (!state) {
      // Should never happen since constructor initialises all roles,
      // but handle defensively.
      const fallback: InternalRoleState = {
        budget: DEFAULT_ROLE_BUDGETS[role],
        used: 0,
        lastActivity: 0,
      };
      this.roles.set(role, fallback);
      return fallback;
    }
    return state;
  }

  private buildRoleUsage(role: BudgetRole, state: InternalRoleState): RoleUsage {
    const remaining = Math.max(0, state.budget - state.used);
    const percentage =
      state.budget > 0
        ? Math.round((state.used / state.budget) * 10_000) / 100
        : state.used > 0
          ? 100
          : 0;

    let status: RoleUsage["status"];
    if (state.used >= state.budget) {
      status = "exceeded";
    } else if (percentage >= this.softLimitRatio * 100) {
      status = "warning";
    } else {
      status = "ok";
    }

    return { role, budget: state.budget, used: state.used, remaining, percentage, status };
  }

  private sumAllBudgets(): number {
    let total = 0;
    for (const state of this.roles.values()) {
      total += state.budget;
    }
    return total;
  }
}
