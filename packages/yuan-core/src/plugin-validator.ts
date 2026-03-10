/**
 * Plugin Validator Engine — Executes validation rules from plugins.
 *
 * Validators run at 4 stages: pre (before changes), post (after changes),
 * quality (code quality), safety (security checks).
 *
 * ValidatorDefinition.check is interpreted as:
 * - If it starts with "/" → treated as a regex pattern to match against outputs
 * - If it contains spaces → treated as a shell command (informational)
 * - Otherwise → treated as a regex pattern
 */

import type { ValidatorDefinition } from "./plugin-types.js";

export type ValidatorStage = "pre" | "post" | "quality" | "safety";

export interface ValidationResult {
  passed: boolean;
  stage: ValidatorStage;
  validatorId: string;
  message: string;
  severity: "error" | "warning" | "info";
  file?: string;
  line?: number;
}

export interface ValidationReport {
  results: ValidationResult[];
  passed: boolean;
  errorCount: number;
  warningCount: number;
}

export class PluginValidator {
  private validators: ValidatorDefinition[] = [];

  addValidators(validators: ValidatorDefinition[]): void {
    this.validators.push(...validators);
  }

  clearValidators(): void {
    this.validators = [];
  }

  /**
   * Run all validators for a given stage.
   * Returns a report with pass/fail status per validator.
   */
  async validate(
    stage: ValidatorStage,
    context: {
      changedFiles: string[];
      toolResults: Array<{ name: string; output: string; success: boolean }>;
      errorOutput?: string;
    },
  ): Promise<ValidationReport> {
    const stageValidators = this.validators.filter((v) => v.stage === stage);
    const results: ValidationResult[] = [];

    for (const validator of stageValidators) {
      try {
        const result = this.runValidator(validator, context);
        results.push(result);
      } catch {
        results.push({
          passed: false,
          stage,
          validatorId: validator.id,
          message: `Validator ${validator.id} threw an error`,
          severity: "warning",
        });
      }
    }

    const errorCount = results.filter(
      (r) => !r.passed && (r.severity === "error"),
    ).length;
    const warningCount = results.filter(
      (r) => !r.passed && r.severity === "warning",
    ).length;

    return {
      results,
      passed: errorCount === 0,
      errorCount,
      warningCount,
    };
  }

  private runValidator(
    validator: ValidatorDefinition,
    context: {
      changedFiles: string[];
      toolResults: Array<{ name: string; output: string; success: boolean }>;
      errorOutput?: string;
    },
  ): ValidationResult {
    const stage = validator.stage as ValidatorStage;
    const severity = this.mapSeverity(validator.severity);
    const check = validator.check;

    // Determine if `check` is a command or a pattern
    const isCommand = check.includes(" ") && !check.startsWith("/");

    if (!isCommand) {
      // Pattern-based validation: treat `check` as a regex
      const patternStr = check.startsWith("/") ? check.slice(1) : check;
      try {
        const regex = new RegExp(patternStr, "i");

        // Check against error output
        if (context.errorOutput && regex.test(context.errorOutput)) {
          return {
            passed: false,
            stage,
            validatorId: validator.id,
            message: `Pattern matched: ${patternStr}`,
            severity,
          };
        }

        // Check against failed tool outputs
        for (const result of context.toolResults) {
          if (!result.success && regex.test(result.output)) {
            return {
              passed: false,
              stage,
              validatorId: validator.id,
              message: `Pattern matched in ${result.name}: ${patternStr}`,
              severity,
            };
          }
        }
      } catch {
        // Invalid regex — treat as non-matching
      }
    } else {
      // Command-based validation — informational only.
      // Actual execution is handled by the agent; we just report it.
      return {
        passed: true,
        stage,
        validatorId: validator.id,
        message: `Run: ${check}`,
        severity: "info",
      };
    }

    return {
      passed: true,
      stage,
      validatorId: validator.id,
      message: "OK",
      severity: "info",
    };
  }

  /**
   * Map ValidatorDefinition severity to ValidationResult severity.
   * "critical" maps to "error" for the report's pass/fail logic.
   */
  private mapSeverity(
    severity: ValidatorDefinition["severity"],
  ): "error" | "warning" | "info" {
    switch (severity) {
      case "error":
      case "critical":
        return "error";
      case "warning":
        return "warning";
      default:
        return "warning";
    }
  }

  getValidators(stage?: ValidatorStage): ValidatorDefinition[] {
    if (!stage) return [...this.validators];
    return this.validators.filter((v) => v.stage === stage);
  }
}
