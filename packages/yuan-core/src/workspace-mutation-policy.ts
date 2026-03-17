/**
 * @module workspace-mutation-policy
 * @description Path-level safety zones. Determines what can be modified.
 * Supports repo-local overrides via .yuan/mutation-policy.json.
 * Role: PATH PROTECTOR only. Does NOT judge code quality or budget.
 */

export type MutationZone = "SAFE" | "CAUTION" | "PROTECTED" | "FORBIDDEN";

export interface PathMutationPolicy {
  pathPattern: string;
  zone: MutationZone;
  requiresApproval: boolean;
  autoVerify: boolean;
  rollbackRequired: boolean;
}

export interface MutationCheckResult {
  zone: MutationZone;
  allowed: boolean;
  requiresApproval: boolean;
  autoVerify: boolean;
  rollbackRequired: boolean;
  reason?: string;
}

const DEFAULT_POLICIES: PathMutationPolicy[] = [
  { pathPattern: "src/", zone: "SAFE", requiresApproval: false, autoVerify: false, rollbackRequired: false },
  { pathPattern: "test/", zone: "SAFE", requiresApproval: false, autoVerify: false, rollbackRequired: false },
  { pathPattern: "tests/", zone: "SAFE", requiresApproval: false, autoVerify: false, rollbackRequired: false },
  { pathPattern: "lib/", zone: "SAFE", requiresApproval: false, autoVerify: false, rollbackRequired: false },
  { pathPattern: "package.json", zone: "CAUTION", requiresApproval: false, autoVerify: true, rollbackRequired: true },
  { pathPattern: "tsconfig", zone: "CAUTION", requiresApproval: false, autoVerify: true, rollbackRequired: true },
  { pathPattern: ".eslintrc", zone: "CAUTION", requiresApproval: false, autoVerify: true, rollbackRequired: true },
  { pathPattern: ".github/", zone: "PROTECTED", requiresApproval: true, autoVerify: true, rollbackRequired: true },
  { pathPattern: ".gitlab-ci", zone: "PROTECTED", requiresApproval: true, autoVerify: true, rollbackRequired: true },
  { pathPattern: "Dockerfile", zone: "PROTECTED", requiresApproval: true, autoVerify: true, rollbackRequired: true },
  { pathPattern: ".env", zone: "FORBIDDEN", requiresApproval: true, autoVerify: false, rollbackRequired: false },
  { pathPattern: "dist/", zone: "FORBIDDEN", requiresApproval: false, autoVerify: false, rollbackRequired: false },
  { pathPattern: "build/", zone: "FORBIDDEN", requiresApproval: false, autoVerify: false, rollbackRequired: false },
  { pathPattern: ".next/", zone: "FORBIDDEN", requiresApproval: false, autoVerify: false, rollbackRequired: false },
  { pathPattern: "node_modules/", zone: "FORBIDDEN", requiresApproval: false, autoVerify: false, rollbackRequired: false },
];

export class WorkspaceMutationPolicy {
  private policies: PathMutationPolicy[];

  constructor(projectPath: string) {
    // Load repo-local overrides
    let overrides: PathMutationPolicy[] = [];
    try {
      const { readFileSync } = require("node:fs") as typeof import("node:fs");
      const { join } = require("node:path") as typeof import("node:path");
      const overridePath = join(projectPath, ".yuan", "mutation-policy.json");
      overrides = JSON.parse(readFileSync(overridePath, "utf-8")) as PathMutationPolicy[];
    } catch { /* no overrides */ }

    // Precedence: repo-local > default
    this.policies = [...overrides, ...DEFAULT_POLICIES];
  }

  check(filePath: string): MutationCheckResult {
    for (const policy of this.policies) {
      if (filePath.includes(policy.pathPattern) || filePath.endsWith(policy.pathPattern)) {
        return {
          zone: policy.zone,
          allowed: policy.zone !== "FORBIDDEN",
          requiresApproval: policy.requiresApproval,
          autoVerify: policy.autoVerify,
          rollbackRequired: policy.rollbackRequired,
          reason: policy.zone === "FORBIDDEN" ? `Path ${filePath} is in FORBIDDEN zone` : undefined,
        };
      }
    }
    // Default: SAFE
    return { zone: "SAFE", allowed: true, requiresApproval: false, autoVerify: false, rollbackRequired: false };
  }
}
