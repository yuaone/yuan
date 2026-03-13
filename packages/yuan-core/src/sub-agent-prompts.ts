/**
 * @module sub-agent-prompts
 * @description Role-specific, token-optimized prompts for sub-agents.
 */

import { getCodingStandards } from "./coding-standards.js";

/* ────────────────────────────────────────────── */
/* Safety constants */
/* ────────────────────────────────────────────── */

const MAX_PROMPT_SECTION = 1200;

function safeSection(text: string): string {
  if (text.length > MAX_PROMPT_SECTION) {
    return text.slice(0, MAX_PROMPT_SECTION) + "\n...";
  }
  return text;
}

/* ────────────────────────────────────────────── */
/* Types */
/* ────────────────────────────────────────────── */

export type SubAgentRole =
  | "coder"
  | "reviewer"
  | "tester"
  | "debugger"
  | "refactorer"
  | "planner";

export interface SubAgentPromptConfig {
  role: SubAgentRole;

  language?: string;
  framework?: string;

  testFramework?: string;
  packageManager?: string;

  isMonorepo?: boolean;
  workspaceTool?: string;

  projectContext?: string;
  constraints?: string[];
}

/* ────────────────────────────────────────────── */
/* Role Prompt Templates */
/* ────────────────────────────────────────────── */

const ROLE_PROMPTS: Record<SubAgentRole, string> = {

coder: `
You are a coding agent.

Goal:
Write the smallest correct change that satisfies the task.

Rules:
- Read existing code before modifying it.
- Follow repository conventions exactly.
- Prefer editing existing files over rewriting.
- Never modify files outside your allowed scope.

Output:
1. Plan (1–3 lines)
2. Changes (tool calls)
3. Verification result
4. Summary
`,

reviewer: `
You are a code review agent.

Focus:
Correctness → Security → Performance.

Rules:
- Review only real issues.
- Ignore style unless it causes bugs.
- Always cite file + line.

Output JSON:
{
 "verdict":"approve|request_changes|comment",
 "issues":[{ "severity":"critical|high|medium","file":"","line":0,"description":""}],
 "confidence":0.0,
 "summary":""
}
`,

tester: `
You are a testing agent.

Goal:
Create tests that detect real bugs.

Rules:
- Test behavior not implementation
- Cover edge cases and failures
- Tests must be deterministic

Output:
1. Strategy
2. Test files
3. Test results
4. Missing coverage
`,

debugger: `
You are a debugging agent.

Process:
Reproduce → Diagnose → Fix.

Rules:
- Always reproduce first
- Identify root cause
- Apply minimal fix
- Verify fix does not break tests

Output:
1. Reproduction
2. Root cause
3. Fix
4. Verification
`,

refactorer: `
You are a refactoring agent.

Goal:
Improve structure while preserving behavior.

Rules:
- Tests must pass before and after
- Apply one refactor at a time
- Do not change behavior

Output:
1. Baseline tests
2. Refactor
3. Post-tests
4. Metrics
`,

planner: `
You are a planning agent.

Goal:
Break the objective into executable tasks.

Rules:
- Tasks must be independent
- Specify dependencies
- Assign roles
- Identify risks

Output:
1. Goal analysis
2. Task DAG
3. Execution order
4. Risks
`
};

/* ────────────────────────────────────────────── */
/* Prompt Builder */
/* ────────────────────────────────────────────── */

export function buildSubAgentPrompt(config: SubAgentPromptConfig): string {

const sections: string[] = [];

sections.push(
ROLE_PROMPTS[config.role] ?? ROLE_PROMPTS.coder
);

/* language standards */

if (config.language) {

const standards = getCodingStandards(config.language);

if (standards) {

sections.push(
safeSection(`## ${config.language} Standards\n${standards}`)
);

}

}

/* framework */

if (config.framework) {

const fw = getFrameworkNote(config.framework);

if (fw) {

sections.push(
`## Framework\n${fw}`
);

}

}

/* environment */

const env = getEnvironmentExecutionRules(config);

if (env) {

sections.push(
`## Environment\n${env}`
);

}

/* verification */

const verify = getVerificationCommands(config);

if (verify) {

sections.push(
`## Verification\n${verify}`
);

}

/* context */

if (config.projectContext) {

sections.push(
safeSection(`## Project Context\n${config.projectContext}`)
);

}

/* constraints */

if (config.constraints?.length) {

sections.push(
`## Constraints\n${config.constraints.map(c => `- ${c}`).join("\n")}`
);

}

return sections.join("\n\n").trim();

}

/* ────────────────────────────────────────────── */
/* Framework Notes */
/* ────────────────────────────────────────────── */

function getFrameworkNote(framework: string): string | null {

const f = framework.toLowerCase().replace(/[.\s]/g, "");

const notes: Record<string,string> = {

react:
"Use functional components and hooks. Avoid unnecessary rerenders.",

nextjs:
"Prefer server components. Avoid unnecessary 'use client'.",

vue:
"Prefer Composition API and keep component state localized.",

svelte:
"Use reactive declarations and avoid unnecessary stores.",

fastapi:
"Keep route handlers thin and push logic into services.",

nestjs:
"Preserve module/service/controller boundaries.",

django:
"Respect model-view-template architecture.",

flutter:
"Prefer small widgets and avoid rebuilding large trees.",

axum:
"Use typed extractors and explicit router composition.",

actixweb:
"Keep handlers small and propagate errors explicitly."
};

return notes[f] ?? null;

}

/* ────────────────────────────────────────────── */
/* Environment Rules */
/* ────────────────────────────────────────────── */

function getEnvironmentExecutionRules(
config: SubAgentPromptConfig
): string | null {

const rules: string[] = [];

if (config.packageManager) {

const pm = config.packageManager.toLowerCase();

if (pm === "pnpm") rules.push("- Use pnpm scripts");
else if (pm === "yarn") rules.push("- Use yarn scripts");
else if (pm === "npm") rules.push("- Use npm scripts");
else if (pm === "cargo") rules.push("- Use cargo workflow");
else if (pm === "go") rules.push("- Use go build/test");

}

if (config.isMonorepo) {

rules.push(
`- Monorepo detected${config.workspaceTool ? ` (${config.workspaceTool})` : ""}`
);

rules.push(
"- Limit changes to affected package"
);

}

return rules.length ? rules.join("\n") : null;

}

/* ────────────────────────────────────────────── */
/* Verification Commands */
/* ────────────────────────────────────────────── */

export function getVerificationCommands(
config: SubAgentPromptConfig
): string | null {

const cmds: string[] = [];

const pm = config.packageManager?.toLowerCase();
const tf = config.testFramework?.toLowerCase();

/* language */

switch(config.language){

case "typescript":
case "javascript":

if (pm === "pnpm") cmds.push("pnpm test");
else if (pm === "yarn") cmds.push("yarn test");
else cmds.push("npm test");

cmds.push("npm run build || tsc --noEmit");
cmds.push("eslint . || true");

break;

case "python":

if (tf === "pytest") cmds.push("pytest");
else cmds.push("python -m pytest");

cmds.push("ruff check . || true");

break;

case "rust":

cmds.push("cargo test");
cmds.push("cargo check");
cmds.push("cargo clippy || true");

break;

case "go":

cmds.push("go test ./...");
cmds.push("go build ./...");
cmds.push("golangci-lint run || true");

break;

}

/* framework */

if (config.framework){

const f = config.framework.toLowerCase();

if (f === "nextjs")
cmds.push("next build");

if (f === "django")
cmds.push("python manage.py test");

}

/* unique */

const unique = [...new Set(cmds)];

if (!unique.length) return null;

return unique
.map(c => `- ${c}`)
.join("\n");

}

/* ────────────────────────────────────────────── */
/* Utilities */
/* ────────────────────────────────────────────── */

export function getRolePrompt(role: SubAgentRole): string {
return ROLE_PROMPTS[role] ?? ROLE_PROMPTS.coder;
}

export function getAvailableRoles(): SubAgentRole[] {
return Object.keys(ROLE_PROMPTS) as SubAgentRole[];
}