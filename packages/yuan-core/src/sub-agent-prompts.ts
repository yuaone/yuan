/**
 * @module sub-agent-prompts
 * @description Role-specific, token-optimized prompts for sub-agents.
 *
 * Design principles:
 * 1. Shorter prompts → fewer input tokens → lower cost
 * 2. Clearer constraints → better first-attempt quality → fewer iterations
 * 3. Output format → structured responses → easier parsing
 * 4. Domain expertise → fewer mistakes → less back-and-forth
 */

import { getCodingStandards } from "./coding-standards.js";

// ─── Types ───

export type SubAgentRole =
  | "coder"
  | "reviewer"
  | "tester"
  | "debugger"
  | "refactorer"
  | "planner";

export interface SubAgentPromptConfig {
  /** Sub-agent role determines the system prompt template */
  role: SubAgentRole;
  /** Primary language (e.g. "typescript", "python") */
  language?: string;
  /** Framework in use (e.g. "react", "next.js") */
  framework?: string;
  /** Brief project description for context */
  projectContext?: string;
  /** Additional constraints injected verbatim */
  constraints?: string[];
}

// ─── Role Prompt Templates ───
// Each template is kept concise: ~400-600 tokens to minimize input cost.

const ROLE_PROMPTS: Record<SubAgentRole, string> = {
  coder: `You are a precise coding agent. Your goal: write minimal, correct code on the first attempt.

Rules:
- Read existing code before writing. Match the project's style, patterns, and conventions exactly.
- Make the smallest change that achieves the goal. No unnecessary abstractions, comments, or over-engineering.
- Prefer editing existing files (file_edit) over full rewrites (file_write).
- After changes, verify with build/lint/typecheck. Fix any errors before reporting done.
- Never modify files outside your assigned scope.

Output format:
1. Brief plan (1-3 lines)
2. Code changes (use tools)
3. Verification result (build/lint output)
4. Summary: files changed + what was done`,

  reviewer: `You are a code review agent. Focus on correctness, security, and performance — in that order.

Rules:
- Read all changed files thoroughly before judging.
- Flag only real issues: bugs, security holes, perf problems, broken contracts.
- No style nits unless they cause bugs. No suggestions for "nice to have" improvements.
- Be specific: cite file, line, and the exact problem.

Output format (JSON):
{
  "verdict": "approve" | "request_changes" | "comment",
  "issues": [{ "severity": "critical|high|medium", "file": "...", "line": N, "description": "..." }],
  "confidence": 0.0-1.0,
  "summary": "one line"
}`,

  tester: `You are a test-writing agent. Write tests that catch real bugs, not ceremonial coverage.

Rules:
- Test behavior and contracts, not implementation details.
- Cover: happy path, edge cases, error paths, boundary values.
- Keep tests independent — no shared mutable state between tests.
- Use the project's existing test framework and patterns.
- Run tests after writing. Fix failures before reporting done.

Output format:
1. Test strategy (2-3 lines: what to test and why)
2. Test files created/modified
3. Test run results (pass/fail counts)
4. Coverage gaps noted (if any)`,

  debugger: `You are a debugging agent. Reproduce first, then diagnose, then fix minimally.

Rules:
- Reproduce the bug with a concrete test case or command before anything else.
- Build a causal chain: symptom → hypothesis → evidence → root cause.
- Make the minimal fix that addresses the root cause. Do NOT refactor during debugging.
- Verify the fix resolves the symptom and doesn't break other tests.
- If you can't reproduce, report what you tried and hypotheses.

Output format:
1. Reproduction steps + result
2. Root cause analysis (causal chain)
3. Fix applied (minimal diff)
4. Verification (tests pass, symptom gone)`,

  refactorer: `You are a refactoring agent. Improve code structure while preserving behavior exactly.

Rules:
- Run tests BEFORE refactoring to establish a green baseline.
- Apply one refactoring pattern at a time (extract, inline, rename, move, simplify).
- After each refactoring, run tests again to confirm no regressions.
- Measure improvement: lines of code, cyclomatic complexity, duplication removed.
- Never change behavior. If tests fail after refactoring, revert and try a different approach.

Output format:
1. Baseline test results
2. Refactoring applied (pattern + files)
3. Post-refactoring test results
4. Metrics: before/after (LOC, complexity)`,

  planner: `You are a planning agent. Break complex goals into concrete, actionable tasks.

Rules:
- Analyze the codebase structure before planning. Read key files to understand architecture.
- Each task must be independently executable with clear inputs/outputs.
- Identify dependencies between tasks (what blocks what).
- Estimate effort per task (simple/moderate/complex) and assign to appropriate agent roles.
- Flag risks and unknowns explicitly.

Output format:
1. Goal analysis (what's needed, key challenges)
2. Task list with dependencies, roles, and estimates
3. Execution order (respecting dependencies)
4. Risks and mitigations`,
};

// ─── Prompt Builder ───

/**
 * Build an optimized system prompt for a sub-agent.
 *
 * Assembles role-specific instructions, optional language standards,
 * framework context, and custom constraints into a single prompt.
 *
 * Target: <800 tokens for simple roles, <1200 for complex roles.
 *
 * @param config - Prompt configuration specifying role and context
 * @returns Fully constructed system prompt string
 */
export function buildSubAgentPrompt(config: SubAgentPromptConfig): string {
  const sections: string[] = [];

  // 1. Role-specific prompt (core instructions)
  const rolePrompt = ROLE_PROMPTS[config.role];
  if (!rolePrompt) {
    // Fallback to coder if unknown role
    sections.push(ROLE_PROMPTS.coder);
  } else {
    sections.push(rolePrompt);
  }

  // 2. Language-specific coding standards (if detected)
  if (config.language) {
    const standards = getCodingStandards(config.language);
    if (standards) {
      sections.push(`## ${config.language} Standards\n${standards}`);
    }
  }

  // 3. Framework context (brief)
  if (config.framework) {
    const frameworkNote = getFrameworkNote(config.framework);
    if (frameworkNote) {
      sections.push(`## Framework: ${config.framework}\n${frameworkNote}`);
    }
  }

  // 4. Project context (if provided)
  if (config.projectContext) {
    sections.push(`## Project Context\n${config.projectContext}`);
  }

  // 5. Additional constraints
  if (config.constraints && config.constraints.length > 0) {
    sections.push(
      `## Additional Constraints\n${config.constraints.map((c) => `- ${c}`).join("\n")}`,
    );
  }

  return sections.join("\n\n").trim();
}

/**
 * Get the role-specific prompt template without additional context.
 * Useful for inspecting or testing individual role prompts.
 */
export function getRolePrompt(role: SubAgentRole): string {
  return ROLE_PROMPTS[role] ?? ROLE_PROMPTS.coder;
}

/**
 * Get all available sub-agent roles.
 */
export function getAvailableRoles(): SubAgentRole[] {
  return Object.keys(ROLE_PROMPTS) as SubAgentRole[];
}

// ─── Framework Notes ───
// Short notes (<100 tokens each) to orient the agent in a specific framework.

function getFrameworkNote(framework: string): string | null {
  const normalized = framework.toLowerCase().replace(/[.\s]/g, "");

  const notes: Record<string, string> = {
    react: "Use functional components + hooks. Follow Rules of Hooks. Use key props in lists. Memoize expensive computations. Clean up effects.",
    nextjs: "App Router: use server components by default, 'use client' only when needed. Use next/image, next/link. API routes in app/api/. Metadata exports for SEO.",
    vue: "Composition API preferred. Use ref/reactive for state. defineProps/defineEmits for component contracts. v-model for two-way binding.",
    svelte: "Use $: for reactive declarations. Bind with bind:value. Use #each with key. Dispatch custom events. Use stores for shared state.",
    express: "Use middleware composition. Validate inputs with schema. Handle errors in centralized error middleware. Use async handlers with try-catch.",
    fastify: "Use schema validation for routes. Register plugins properly. Use decorators for shared state. Async handlers are native.",
    django: "Use class-based views for complex logic, function views for simple. Follow model-view-template. Use ORM querysets efficiently.",
    flask: "Use blueprints for modularity. Application factory pattern. Use decorators for routes. Register error handlers.",
  };

  return notes[normalized] ?? null;
}
