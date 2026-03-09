/**
 * @module execution-policy-engine
 * @description 실행 정책 엔진 — `.yuan/policy.json` 또는 YUAN.md에서 정책을 로드하여
 * 에이전트의 모든 모듈을 단일 소스에서 구성.
 *
 * 로드 순서: DEFAULT_POLICY → .yuan/policy.json → YUAN.md 오버라이드
 */

import { readFile, writeFile, mkdir, rename, access, constants } from "node:fs/promises";
import path from "node:path";

// ─── Interfaces ───

export interface ExecutionPolicy {
  planning: {
    enabled: boolean;
    threshold: "simple" | "moderate" | "complex";
    maxDepth: number;
    autoReplan: boolean;
  };
  speculation: {
    enabled: boolean;
    maxApproaches: number;
    minComplexity: "moderate" | "complex" | "massive";
  };
  debate: {
    enabled: boolean;
    rounds: number;
    roles: string[];
    minComplexity: "moderate" | "complex" | "massive";
  };
  verification: {
    depth: "shallow" | "standard" | "deep";
    strictness: number;
    autoTest: boolean;
    autoBuild: boolean;
    autoLint: boolean;
  };
  cost: {
    maxTokensPerSession: number;
    maxTokensPerIteration: number;
    budgetPerRole: Record<string, number>;
    preferredModel: string;
  };
  safety: {
    sandboxTier: number;
    approvalLevel: "none" | "dangerous" | "all";
    blockedCommands: string[];
    blockedPaths: string[];
    secretDetection: boolean;
  };
  recovery: {
    maxRetries: number;
    maxStrategySwitches: number;
    enableRollback: boolean;
    enableScopeReduce: boolean;
    escalateThreshold: number;
  };
  memory: {
    enabled: boolean;
    autoSavelearnings: boolean;
    checkpointThreshold: number;
    maxCheckpoints: number;
  };
  mcp: {
    enabled: boolean;
    servers: Array<{
      name: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }>;
  };
}

export interface PolicySource {
  type: "file" | "yuanmd" | "default";
  path?: string;
  loadedAt: string;
}

// ─── Defaults ───

export const DEFAULT_POLICY: ExecutionPolicy = {
  planning: {
    enabled: true,
    threshold: "moderate",
    maxDepth: 3,
    autoReplan: true,
  },
  speculation: {
    enabled: false,
    maxApproaches: 3,
    minComplexity: "complex",
  },
  debate: {
    enabled: false,
    rounds: 3,
    roles: ["coder", "reviewer", "verifier"],
    minComplexity: "moderate",
  },
  verification: {
    depth: "standard",
    strictness: 0.7,
    autoTest: false,
    autoBuild: true,
    autoLint: true,
  },
  cost: {
    maxTokensPerSession: 500_000,
    maxTokensPerIteration: 50_000,
    budgetPerRole: {},
    preferredModel: "standard",
  },
  safety: {
    sandboxTier: 2,
    approvalLevel: "dangerous",
    blockedCommands: ["rm -rf /", "sudo", "mkfs", "dd if=", ":(){:|:&};:"],
    blockedPaths: ["/etc", "/usr", "/bin", "/sbin", "/boot", "/sys", "/proc"],
    secretDetection: true,
  },
  recovery: {
    maxRetries: 3,
    maxStrategySwitches: 3,
    enableRollback: true,
    enableScopeReduce: true,
    escalateThreshold: 2,
  },
  memory: {
    enabled: true,
    autoSavelearnings: true,
    checkpointThreshold: 0.8,
    maxCheckpoints: 5,
  },
  mcp: {
    enabled: false,
    servers: [],
  },
};

// ─── Utilities ───

const VALID_THRESHOLDS = new Set(["simple", "moderate", "complex"]);
const VALID_COMPLEXITY = new Set(["moderate", "complex", "massive"]);
const VALID_DEPTH = new Set(["shallow", "standard", "deep"]);
const VALID_APPROVAL = new Set(["none", "dangerous", "all"]);

/** Deep merge: source values override target. Arrays are replaced, not concatenated. */
function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof T)[]) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal !== null &&
      srcVal !== undefined &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal) &&
      tgtVal !== null
    ) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      ) as T[keyof T];
    } else if (srcVal !== undefined) {
      result[key] = srcVal as T[keyof T];
    }
  }
  return result;
}

/** Set a nested value using dot-notation path (e.g. "safety.sandboxTier"). */
function setNestedValue(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const lastKey = parts[parts.length - 1];
  current[lastKey] = value;
}

/** Coerce a string value to the appropriate JS type. */
function coerceValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  // Strip quotes if present
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// ─── Engine ───

export class ExecutionPolicyEngine {
  private policy: ExecutionPolicy;
  private source: PolicySource;
  private readonly projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.policy = structuredClone(DEFAULT_POLICY);
    this.source = { type: "default", loadedAt: new Date().toISOString() };
  }

  /**
   * Load policy: DEFAULT → .yuan/policy.json → YUAN.md overrides.
   */
  async load(): Promise<ExecutionPolicy> {
    let merged = structuredClone(DEFAULT_POLICY);
    let sourceType: PolicySource["type"] = "default";
    let sourcePath: string | undefined;

    // 1. Try .yuan/policy.json
    const policyJsonPath = path.join(this.projectPath, ".yuan", "policy.json");
    try {
      await access(policyJsonPath, constants.R_OK);
      const raw = await readFile(policyJsonPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<ExecutionPolicy>;
      merged = deepMerge(merged as unknown as Record<string, unknown>, parsed as Record<string, unknown>) as unknown as ExecutionPolicy;
      sourceType = "file";
      sourcePath = policyJsonPath;
    } catch {
      // No policy.json — continue with defaults
    }

    // 2. Try YUAN.md overrides
    const yuanMdPath = path.join(this.projectPath, "YUAN.md");
    try {
      await access(yuanMdPath, constants.R_OK);
      const md = await readFile(yuanMdPath, "utf-8");
      const overrides = this.parseYuanMd(md);
      if (Object.keys(overrides).length > 0) {
        merged = deepMerge(merged as unknown as Record<string, unknown>, overrides) as unknown as ExecutionPolicy;
        if (sourceType === "default") {
          sourceType = "yuanmd";
          sourcePath = yuanMdPath;
        }
      }
    } catch {
      // No YUAN.md — continue
    }

    // 3. Validate & store
    const { valid, errors } = ExecutionPolicyEngine.validate(merged);
    if (!valid) {
      throw new Error(`Invalid execution policy:\n${errors.join("\n")}`);
    }

    this.policy = merged;
    this.source = {
      type: sourceType,
      path: sourcePath,
      loadedAt: new Date().toISOString(),
    };

    return this.policy;
  }

  /** Get the full current policy. */
  getPolicy(): ExecutionPolicy {
    return this.policy;
  }

  /** Get a specific policy section. */
  get<K extends keyof ExecutionPolicy>(section: K): ExecutionPolicy[K] {
    return this.policy[section];
  }

  /** Override a section at runtime (in-memory only, call save() to persist). */
  override<K extends keyof ExecutionPolicy>(section: K, values: Partial<ExecutionPolicy[K]>): void {
    this.policy[section] = {
      ...this.policy[section],
      ...values,
    };
  }

  /** Save current policy to .yuan/policy.json (atomic write via tmp + rename). */
  async save(): Promise<void> {
    const dir = path.join(this.projectPath, ".yuan");
    await mkdir(dir, { recursive: true });

    const target = path.join(dir, "policy.json");
    const tmp = path.join(dir, `policy.json.tmp.${Date.now()}`);
    const content = JSON.stringify(this.policy, null, 2) + "\n";

    await writeFile(tmp, content, "utf-8");
    await rename(tmp, target);

    this.source = {
      type: "file",
      path: target,
      loadedAt: new Date().toISOString(),
    };
  }

  /** Get info about where the policy was loaded from. */
  getSource(): PolicySource {
    return this.source;
  }

  // ─── Static helpers ───

  /** Merge a partial policy with defaults. */
  static mergeWithDefaults(partial: Partial<ExecutionPolicy>): ExecutionPolicy {
    return deepMerge(
      structuredClone(DEFAULT_POLICY) as unknown as Record<string, unknown>,
      partial as Record<string, unknown>,
    ) as unknown as ExecutionPolicy;
  }

  /** Validate policy values (ranges, enums). Returns all errors, not just the first. */
  static validate(policy: ExecutionPolicy): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // planning
    if (!VALID_THRESHOLDS.has(policy.planning.threshold)) {
      errors.push(`planning.threshold must be one of: ${[...VALID_THRESHOLDS].join(", ")} (got "${policy.planning.threshold}")`);
    }
    if (policy.planning.maxDepth < 1) {
      errors.push(`planning.maxDepth must be >= 1 (got ${policy.planning.maxDepth})`);
    }

    // speculation
    if (!VALID_COMPLEXITY.has(policy.speculation.minComplexity)) {
      errors.push(`speculation.minComplexity must be one of: ${[...VALID_COMPLEXITY].join(", ")} (got "${policy.speculation.minComplexity}")`);
    }

    // debate
    if (!VALID_COMPLEXITY.has(policy.debate.minComplexity)) {
      errors.push(`debate.minComplexity must be one of: ${[...VALID_COMPLEXITY].join(", ")} (got "${policy.debate.minComplexity}")`);
    }
    if (policy.debate.rounds < 1) {
      errors.push(`debate.rounds must be >= 1 (got ${policy.debate.rounds})`);
    }

    // verification
    if (!VALID_DEPTH.has(policy.verification.depth)) {
      errors.push(`verification.depth must be one of: ${[...VALID_DEPTH].join(", ")} (got "${policy.verification.depth}")`);
    }
    if (policy.verification.strictness < 0 || policy.verification.strictness > 1) {
      errors.push(`verification.strictness must be 0-1 (got ${policy.verification.strictness})`);
    }

    // cost
    if (policy.cost.maxTokensPerSession <= 0) {
      errors.push(`cost.maxTokensPerSession must be > 0 (got ${policy.cost.maxTokensPerSession})`);
    }
    if (policy.cost.maxTokensPerIteration <= 0) {
      errors.push(`cost.maxTokensPerIteration must be > 0 (got ${policy.cost.maxTokensPerIteration})`);
    }

    // safety
    if (policy.safety.sandboxTier < 0 || policy.safety.sandboxTier > 3) {
      errors.push(`safety.sandboxTier must be 0-3 (got ${policy.safety.sandboxTier})`);
    }
    if (!VALID_APPROVAL.has(policy.safety.approvalLevel)) {
      errors.push(`safety.approvalLevel must be one of: ${[...VALID_APPROVAL].join(", ")} (got "${policy.safety.approvalLevel}")`);
    }

    // recovery
    if (policy.recovery.maxRetries < 0) {
      errors.push(`recovery.maxRetries must be >= 0 (got ${policy.recovery.maxRetries})`);
    }
    if (policy.recovery.escalateThreshold < 0) {
      errors.push(`recovery.escalateThreshold must be >= 0 (got ${policy.recovery.escalateThreshold})`);
    }

    // memory
    if (policy.memory.checkpointThreshold < 0 || policy.memory.checkpointThreshold > 1) {
      errors.push(`memory.checkpointThreshold must be 0-1 (got ${policy.memory.checkpointThreshold})`);
    }
    if (policy.memory.maxCheckpoints < 1) {
      errors.push(`memory.maxCheckpoints must be >= 1 (got ${policy.memory.maxCheckpoints})`);
    }

    return { valid: errors.length === 0, errors };
  }

  // ─── Conversion methods ───

  /** Convert policy → GovernorConfig shape. */
  toGovernorConfig(): { planTier: string; customLimits: Record<string, number> } {
    return {
      planTier: this.policy.cost.preferredModel,
      customLimits: {
        tokensPerRequest: this.policy.cost.maxTokensPerIteration,
        maxIterations: Math.ceil(this.policy.cost.maxTokensPerSession / this.policy.cost.maxTokensPerIteration),
      },
    };
  }

  /** Convert policy → AutoFixConfig shape. */
  toAutoFixConfig(): { maxRetries: number; autoLint: boolean; autoTest: boolean; autoBuild: boolean } {
    return {
      maxRetries: this.policy.recovery.maxRetries,
      autoLint: this.policy.verification.autoLint,
      autoTest: this.policy.verification.autoTest,
      autoBuild: this.policy.verification.autoBuild,
    };
  }

  /** Convert policy → failure recovery config. */
  toFailureRecoveryConfig(): {
    maxStrategySwitches: number;
    enableRollback: boolean;
    enableScopeReduce: boolean;
    escalateThreshold: number;
  } {
    return {
      maxStrategySwitches: this.policy.recovery.maxStrategySwitches,
      enableRollback: this.policy.recovery.enableRollback,
      enableScopeReduce: this.policy.recovery.enableScopeReduce,
      escalateThreshold: this.policy.recovery.escalateThreshold,
    };
  }

  /** Convert policy → ContextManagerConfig shape. */
  toContextManagerConfig(): { maxContextTokens: number } {
    return {
      maxContextTokens: this.policy.cost.maxTokensPerSession,
    };
  }

  /** Convert policy → ExecutionEngineConfig shape (general-purpose). */
  toExecutionEngineConfig(): Record<string, unknown> {
    return {
      planning: this.policy.planning,
      speculation: this.policy.speculation,
      debate: this.policy.debate,
      verification: this.policy.verification,
      safety: {
        sandboxTier: this.policy.safety.sandboxTier,
        approvalLevel: this.policy.safety.approvalLevel,
        secretDetection: this.policy.safety.secretDetection,
      },
      memory: this.policy.memory,
      mcp: this.policy.mcp,
    };
  }

  // ─── Private ───

  /**
   * Parse YUAN.md for policy overrides.
   * Looks for a `## Policy` or `## Configuration` section, then extracts
   * lines matching `- dotted.key: value`.
   */
  private parseYuanMd(content: string): Record<string, unknown> {
    const overrides: Record<string, unknown> = {};
    const lines = content.split("\n");

    let inPolicySection = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Detect section boundaries
      if (/^##\s+(Policy|Configuration)\s*$/i.test(trimmed)) {
        inPolicySection = true;
        continue;
      }
      // Any other H2 ends the section
      if (/^##\s+/.test(trimmed) && inPolicySection) {
        inPolicySection = false;
        continue;
      }

      if (!inPolicySection) continue;

      // Match lines like: - planning.threshold: complex
      const match = trimmed.match(/^-\s+([\w.]+)\s*:\s*(.+)$/);
      if (match) {
        const [, dotPath, rawValue] = match;
        setNestedValue(overrides, dotPath, coerceValue(rawValue));
      }
    }

    return overrides;
  }
}
