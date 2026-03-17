/**
 * @module command-plan-compiler
 * @description Compiles deterministic shell commands from Decision + RepoProfile.
 * Only handles: build, test, lint, verify, install, search.
 * Custom/unknown commands pass through with warning.
 * Role: COMMAND COMPILER only. Does NOT block commands.
 */

// ─── Types ───

export type CommandPurpose = "build" | "test" | "lint" | "verify" | "install" | "search";
export type CommandPlanMode = "compiled" | "llm_proposed" | "hybrid";

export interface CommandPlan {
  purpose: CommandPurpose;
  commands: string[];
  mode: CommandPlanMode;
  derivedFrom: string[];
  userApprovalRequired: boolean;
}

export interface CommandCompilerInput {
  verifyDepth: "skip" | "quick" | "thorough";
  packageManager: string;
  testFramework: string;
  buildTool: string;
  hasStrictMode: boolean;
  monorepo: boolean;
  changedPackage?: string;
}

// ─── Internal helpers ───

function pm(input: CommandCompilerInput): string {
  const pm = input.packageManager;
  if (pm === "pnpm" || pm === "npm" || pm === "yarn" || pm === "bun") return pm;
  return "npm";
}

function filterFlag(input: CommandCompilerInput): string {
  if (!input.monorepo || !input.changedPackage) return "";
  if (input.packageManager === "pnpm") return ` --filter ${input.changedPackage}`;
  return "";
}

function testCmd(input: CommandCompilerInput): string {
  const fw = input.testFramework;
  if (fw === "vitest") return "npx vitest run";
  if (fw === "jest") return "npx jest";
  if (fw === "mocha") return "npx mocha";
  if (fw === "pytest") return "python -m pytest";
  if (fw === "node:test") return "node --test";
  return `${pm(input)} test`;
}

// ─── Compilers ───

/** Compile verification commands from Decision + RepoProfile */
export function compileVerifyCommands(input: CommandCompilerInput): CommandPlan {
  const commands: string[] = [];
  const derivedFrom: string[] = ["verifyDepth"];

  if (input.verifyDepth === "skip") {
    return { purpose: "verify", commands: [], mode: "compiled", derivedFrom, userApprovalRequired: false };
  }

  // Quick: type check only
  if (input.verifyDepth === "quick") {
    if (input.buildTool === "tsc" || input.hasStrictMode) {
      commands.push("npx tsc --noEmit");
    }
    return { purpose: "verify", commands, mode: "compiled", derivedFrom, userApprovalRequired: false };
  }

  // Thorough: build + test
  const filter = filterFlag(input);
  commands.push(`${pm(input)}${filter} run build`);
  if (input.hasStrictMode) {
    commands.push("npx tsc --noEmit");
  }
  commands.push(testCmd(input));

  return { purpose: "verify", commands, mode: "compiled", derivedFrom, userApprovalRequired: false };
}

/** Compile build commands */
export function compileBuildCommands(input: CommandCompilerInput): CommandPlan {
  const filter = filterFlag(input);
  const commands = [`${pm(input)}${filter} run build`];
  return { purpose: "build", commands, mode: "compiled", derivedFrom: ["buildTool", "packageManager"], userApprovalRequired: false };
}

/** Compile test commands */
export function compileTestCommands(input: CommandCompilerInput, changedFiles?: string[]): CommandPlan {
  const derivedFrom = ["testFramework"];
  const fw = input.testFramework;

  // If specific test files changed and count is manageable, run them directly
  if (changedFiles && changedFiles.length > 0) {
    const testFiles = changedFiles.filter(f => /\.(test|spec)\.[jt]sx?$/.test(f));
    if (testFiles.length > 0 && testFiles.length <= 3) {
      const runner = fw === "vitest" ? "npx vitest run" : fw === "jest" ? "npx jest" : null;
      if (runner) {
        return {
          purpose: "test",
          commands: [`${runner} ${testFiles.join(" ")}`],
          mode: "compiled",
          derivedFrom,
          userApprovalRequired: false,
        };
      }
    }
  }

  return {
    purpose: "test",
    commands: [testCmd(input)],
    mode: "compiled",
    derivedFrom,
    userApprovalRequired: false,
  };
}

// ─── Command Classification ───

/** Regex patterns for recognizable CLI commands */
const COMMAND_PATTERNS: Array<{ pattern: RegExp; purpose: CommandPurpose }> = [
  // Build
  { pattern: /\b(pnpm|npm|yarn|bun)\s+(run\s+)?build\b/, purpose: "build" },
  { pattern: /\bnpx\s+tsc\b/, purpose: "build" },
  { pattern: /\bnpx\s+(vite|esbuild|rollup)\s+build\b/, purpose: "build" },
  // Test
  { pattern: /\b(pnpm|npm|yarn|bun)\s+(run\s+)?test\b/, purpose: "test" },
  { pattern: /\bnpx\s+(vitest|jest|mocha)\b/, purpose: "test" },
  { pattern: /\b(pytest|python\s+-m\s+pytest)\b/, purpose: "test" },
  { pattern: /\bnode\s+--test\b/, purpose: "test" },
  { pattern: /\bcargo\s+test\b/, purpose: "test" },
  { pattern: /\bgo\s+test\b/, purpose: "test" },
  // Lint
  { pattern: /\b(pnpm|npm|yarn|bun)\s+(run\s+)?lint\b/, purpose: "lint" },
  { pattern: /\bnpx\s+(eslint|biome|prettier)\b/, purpose: "lint" },
  // Verify (tsc --noEmit specifically)
  { pattern: /\btsc\s+--noEmit\b/, purpose: "verify" },
  // Install
  { pattern: /\b(pnpm|npm|yarn|bun)\s+(install|add|i)\b/, purpose: "install" },
  { pattern: /\bpip\s+install\b/, purpose: "install" },
  { pattern: /\bcargo\s+(add|install)\b/, purpose: "install" },
  // Search
  { pattern: /\b(grep|rg|find|fd|ag)\b/, purpose: "search" },
];

/** Check if an LLM-proposed command matches a compilable pattern */
export function classifyCommand(command: string): { purpose: CommandPurpose | null; isCacheable: boolean } {
  const trimmed = command.trim().toLowerCase();
  for (const { pattern, purpose } of COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      // Build/test/lint/verify are cacheable (deterministic); install/search are not
      const isCacheable = purpose === "build" || purpose === "test" || purpose === "lint" || purpose === "verify";
      return { purpose, isCacheable };
    }
  }
  return { purpose: null, isCacheable: false };
}

/** Validate an LLM-proposed command against compiled expectation */
export function validateProposedCommand(
  proposed: string,
  compiled: CommandPlan,
): {
  matches: boolean;
  deviation?: string;
  recommendation: "use_compiled" | "allow_proposed" | "warn";
} {
  const proposedTrimmed = proposed.trim();
  const proposedClassified = classifyCommand(proposedTrimmed);

  // If proposed is not a recognized command, allow with warning
  if (!proposedClassified.purpose) {
    return {
      matches: false,
      deviation: "Unrecognized command pattern — cannot validate against compiled plan",
      recommendation: "warn",
    };
  }

  // If purposes differ entirely, prefer compiled
  if (proposedClassified.purpose !== compiled.purpose) {
    return {
      matches: false,
      deviation: `Purpose mismatch: proposed=${proposedClassified.purpose}, compiled=${compiled.purpose}`,
      recommendation: "use_compiled",
    };
  }

  // Same purpose — check if the proposed command is in the compiled list
  const exactMatch = compiled.commands.some(
    c => c.trim().toLowerCase() === proposedTrimmed.toLowerCase(),
  );
  if (exactMatch) {
    return { matches: true, recommendation: "allow_proposed" };
  }

  // Same purpose but different command — warn (minor deviation)
  return {
    matches: false,
    deviation: `Same purpose (${compiled.purpose}) but different command. Compiled: ${compiled.commands[0] ?? "none"}`,
    recommendation: "warn",
  };
}
