/**
 * @module test-impact-planner
 * @description Determines targeted verification commands based on changed files.
 * Instead of running full build/test every time, calculates minimal verification scope.
 * NO LLM, deterministic file-based analysis.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export type VerificationScopeLevel = "file" | "package" | "workspace" | "full";

export interface VerificationScope {
  level: VerificationScopeLevel;
  commands: string[];
  requiredChecks: string[];
  optionalChecks: string[];
  estimatedCostUnits: number;
}

export function resolveVerificationScope(
  changedFiles: string[],
  verifyDepth: "skip" | "quick" | "thorough",
  projectPath: string,
): VerificationScope {
  if (verifyDepth === "skip" || changedFiles.length === 0) {
    return { level: "file", commands: [], requiredChecks: [], optionalChecks: [], estimatedCostUnits: 0 };
  }

  const hasTS = changedFiles.some(f => /\.tsx?$/.test(f));
  const hasTest = changedFiles.some(f => /\.(test|spec)\.[jt]sx?$/.test(f));
  const hasConfig = changedFiles.some(f => /(tsconfig|package|jest\.config|vitest\.config|\.eslintrc)/.test(f));
  const hasLock = changedFiles.some(f => /lock\.yaml|lock\.json|\.lock$/.test(f));

  // Detect project tools
  const hasTsConfig = existsSync(join(projectPath, "tsconfig.json"));
  const usePnpm = existsSync(join(projectPath, "pnpm-lock.yaml"));
  const useVitest = existsSync(join(projectPath, "vitest.config.ts")) || existsSync(join(projectPath, "vitest.config.js"));
  const useJest = existsSync(join(projectPath, "jest.config.ts")) || existsSync(join(projectPath, "jest.config.js"));
  const runPrefix = usePnpm ? "pnpm" : "npm";
  const testRunner = useVitest ? "vitest" : useJest ? "jest" : null;

  const required: string[] = [];
  const optional: string[] = [];

  // Quick: type check only
  if (verifyDepth === "quick") {
    if (hasTsConfig && hasTS) required.push("npx tsc --noEmit");
    return { level: "file", commands: required, requiredChecks: required, optionalChecks: [], estimatedCostUnits: required.length };
  }

  // Thorough: full verification
  if (hasTsConfig && hasTS) required.push("npx tsc --noEmit");

  if (hasConfig || hasLock) {
    // Config changed → full build
    required.push(`${runPrefix} run build`);
    if (testRunner) required.push(`${runPrefix} test`);
    return { level: "workspace", commands: [...required, ...optional], requiredChecks: required, optionalChecks: optional, estimatedCostUnits: required.length * 3 + optional.length };
  }

  if (hasTest && testRunner) {
    // Test files changed → run affected tests
    const testFiles = changedFiles.filter(f => /\.(test|spec)\.[jt]sx?$/.test(f));
    if (testFiles.length <= 3) {
      required.push(`npx ${testRunner} ${testFiles.join(" ")}`);
    } else {
      required.push(`${runPrefix} test`);
    }
  } else if (testRunner && changedFiles.length <= 5) {
    // Code changed → run related tests
    optional.push(`${runPrefix} test -- --changed`);
  } else if (testRunner) {
    required.push(`${runPrefix} test`);
  }

  const level: VerificationScopeLevel = changedFiles.length > 10 ? "workspace" : changedFiles.length > 3 ? "package" : "file";

  return {
    level,
    commands: [...required, ...optional],
    requiredChecks: required,
    optionalChecks: optional,
    estimatedCostUnits: required.length * 3 + optional.length,
  };
}
