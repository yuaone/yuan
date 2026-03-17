/**
 * @module judgment-rules
 * @description Deterministic rule registry for tool execution approval.
 * Rules are loaded from .yuan/judgment-rules.json or defaults.
 * NO LLM, pure pattern matching.
 * YUA reference: ai/judgment/judgment-rule.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RepoCapabilityProfile } from "./repo-capability-profile.js";

export type JudgmentAction = "ALLOW" | "WARN" | "BLOCK" | "REQUIRE_APPROVAL";

export interface JudgmentRule {
  id: string;
  tool: string;           // tool name pattern (glob-like: "file_*", "shell_exec", "*")
  pathPattern?: string;   // file path regex pattern
  commandPattern?: string; // shell command regex pattern
  action: JudgmentAction;
  reason: string;
  successCount: number;   // times this rule was correct
  failureCount: number;   // times this rule was wrong
  confidence: number;     // 0~1, derived from success/failure
}

export interface JudgmentResult {
  rule?: JudgmentRule;
  action: JudgmentAction;
  reason?: string;
}

// Default rules for coding agent safety
const DEFAULT_RULES: JudgmentRule[] = [
  {
    id: "block-env-write",
    tool: "file_write",
    pathPattern: "\\.env$",
    action: "BLOCK",
    reason: "Direct .env modification blocked",
    successCount: 0,
    failureCount: 0,
    confidence: 1.0,
  },
  {
    id: "block-env-edit",
    tool: "file_edit",
    pathPattern: "\\.env$",
    action: "BLOCK",
    reason: "Direct .env modification blocked",
    successCount: 0,
    failureCount: 0,
    confidence: 1.0,
  },
  {
    id: "approve-git-push",
    tool: "git_ops",
    commandPattern: "push",
    action: "REQUIRE_APPROVAL",
    reason: "Git push requires approval",
    successCount: 0,
    failureCount: 0,
    confidence: 1.0,
  },
  {
    id: "warn-config-edit",
    tool: "file_edit",
    pathPattern: "tsconfig\\.json$|package\\.json$|\\.eslintrc",
    action: "WARN",
    reason: "Config file modification",
    successCount: 0,
    failureCount: 0,
    confidence: 0.8,
  },
  {
    id: "approve-dist-write",
    tool: "file_write",
    pathPattern: "dist/|build/|\\.next/|node_modules/",
    action: "BLOCK",
    reason: "Generated/build output modification blocked",
    successCount: 0,
    failureCount: 0,
    confidence: 1.0,
  },
];

export class JudgmentRuleRegistry {
  private rules: JudgmentRule[];
  private rulesPath: string;

  constructor(projectPath: string) {
    this.rulesPath = join(projectPath, ".yuan", "judgment-rules.json");
    this.rules = this.load();
  }

  private load(): JudgmentRule[] {
    try {
      const data = readFileSync(this.rulesPath, "utf-8");
      return JSON.parse(data) as JudgmentRule[];
    } catch {
      return [...DEFAULT_RULES];
    }
  }

  save(): void {
    try {
      mkdirSync(join(this.rulesPath, ".."), { recursive: true });
      writeFileSync(this.rulesPath, JSON.stringify(this.rules, null, 2));
    } catch { /* non-fatal */ }
  }

  /** Evaluate a tool call against all rules */
  evaluate(toolName: string, args: Record<string, unknown>): JudgmentResult {
    const filePath = String(args.path ?? args.file_path ?? "");
    const command = String(args.command ?? args.operation ?? "");

    for (const rule of this.rules) {
      // Match tool name (simple glob: "file_*" matches "file_write")
      const toolMatch =
        rule.tool === "*" ||
        rule.tool === toolName ||
        (rule.tool.endsWith("*") && toolName.startsWith(rule.tool.slice(0, -1)));
      if (!toolMatch) continue;

      // Match path pattern
      if (rule.pathPattern && filePath) {
        try {
          if (new RegExp(rule.pathPattern).test(filePath)) {
            return { rule, action: rule.action, reason: rule.reason };
          }
        } catch { /* invalid regex, skip */ }
      }

      // Match command pattern
      if (rule.commandPattern && command) {
        try {
          if (new RegExp(rule.commandPattern).test(command)) {
            return { rule, action: rule.action, reason: rule.reason };
          }
        } catch { /* invalid regex, skip */ }
      }
    }

    return { action: "ALLOW" };
  }

  /** Record that a rule's judgment was correct */
  recordSuccess(ruleId: string): void {
    const rule = this.rules.find((r) => r.id === ruleId);
    if (rule) {
      rule.successCount++;
      rule.confidence = rule.successCount / (rule.successCount + rule.failureCount + 1);
      this.save();
    }
  }

  /** Record that a rule's judgment was wrong */
  recordFailure(ruleId: string): void {
    const rule = this.rules.find((r) => r.id === ruleId);
    if (rule) {
      rule.failureCount++;
      rule.confidence = rule.successCount / (rule.successCount + rule.failureCount + 1);
      // Low confidence rules get demoted
      if (rule.confidence < 0.3 && rule.action === "BLOCK") {
        rule.action = "WARN";
      }
      this.save();
    }
  }

  /** Add a new rule */
  addRule(rule: Omit<JudgmentRule, "successCount" | "failureCount" | "confidence">): void {
    this.rules.push({ ...rule, successCount: 0, failureCount: 0, confidence: 0.5 });
    this.save();
  }

  getRules(): readonly JudgmentRule[] {
    return this.rules;
  }

  /** Auto-generate rules from RepoCapabilityProfile */
  autoExpandFromProfile(profile: RepoCapabilityProfile): void {
    // Generated paths → BLOCK
    for (const gp of profile.generatedPaths) {
      const id = `auto-block-generated-${gp.replace(/\//g, "-")}`;
      if (!this.rules.find(r => r.id === id)) {
        this.rules.push({
          id,
          tool: "file_*",
          pathPattern: gp.replace(/\/$/, "") + "/",
          action: "BLOCK",
          reason: `Generated path: ${gp} — do not modify directly`,
          successCount: 0,
          failureCount: 0,
          confidence: 1.0,
        });
      }
    }

    // Protected files → WARN
    for (const pf of profile.protectedFiles) {
      const id = `auto-warn-protected-${pf.replace(/[./]/g, "-")}`;
      if (!this.rules.find(r => r.id === id)) {
        this.rules.push({
          id,
          tool: "file_*",
          pathPattern: pf.replace(/\./g, "\\.") + "$",
          action: "WARN",
          reason: `Protected file: ${pf} — modify with caution`,
          successCount: 0,
          failureCount: 0,
          confidence: 0.8,
        });
      }
    }

    this.save();
  }
}
