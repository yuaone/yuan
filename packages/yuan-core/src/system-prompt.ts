/**
 * @module system-prompt
 * @description YUAN agent system prompt — SSOT.
 *
 * Design principles (based on model research):
 * - FRONT: identity + behavior + tone (highest attention zone)
 * - MIDDLE: tools + environment + project (dynamic/factual)
 * - END: reinforce identity + completion (second-highest attention for Gemini U-curve)
 * - Total: ~300 lines static + dynamic sections. Targets < 2000 tokens static core.
 * - Positive framing: "always do X" over "never do X" (pink elephant problem)
 * - No contradictions: removed "risky", "high-impact", "careful", "cautious"
 */

import type { ToolDefinition } from "./types.js";
import type { ProjectStructure } from "./memory.js";
import { SYSTEM_CORE, SYSTEM_REINFORCE } from "./system-core.js";

/** 시스템 프롬프트 빌드 옵션 */
export interface SystemPromptOptions {
  projectStructure?: ProjectStructure;
  yuanMdContent?: string;
  tools: ToolDefinition[];
  activeToolNames?: string[];
  additionalRules?: string[];
  projectPath?: string;
  environment?: EnvironmentInfo;
  activeSkills?: SkillSummary[];
  activeStrategies?: StrategySummary[];
  executionMode?: ExecutionMode;
  agentRole?: PromptAgentRole;
  experienceHints?: string[];
  currentTaskType?: string;
}

export interface EnvironmentInfo {
  os?: string;
  shell?: string;
  nodeVersion?: string;
  gitBranch?: string;
}

export type ExecutionMode = "FAST" | "NORMAL" | "DEEP" | "SUPERPOWER" | "COMPACT";
export type PromptAgentRole = "generalist" | "planner" | "coder" | "critic" | "verifier" | "specialist" | "recovery";

export interface SkillSummary {
  pluginId: string;
  skillName: string;
  summary: string;
  commonPitfalls?: string[];
  validation?: string;
}

export interface StrategySummary {
  name: string;
  description: string;
  toolSequence?: string[];
}

/**
 * Build the agent system prompt.
 *
 * Section order optimized for LLM attention:
 *   FRONT  → identity, behavior, tone  (highest attention)
 *   MIDDLE → tools, env, project, mode (factual/dynamic)
 *   END    → reinforce + completion    (Gemini U-curve second peak)
 *
 * @deprecated Use compilePromptEnvelope() + buildPrompt() from prompt-runtime.ts / prompt-builder.ts instead.
 * This function is kept for backward compatibility only.
 * New code should use the 3-layer pipeline: PromptRuntime → PromptBuilder.
 */
export function buildSystemPrompt(options: SystemPromptOptions): string {
  const sections: string[] = [];

  // ═══ FRONT — identity, behavior, tone (MUST be first) ═══
  sections.push(SYSTEM_CORE);

  // ═══ MIDDLE — dynamic/factual context ═══

  // Execution mode
  const modeSection = buildModeSection(options.executionMode);
  if (modeSection) sections.push(modeSection);

  // Agent role
  const roleSection = buildRoleSection(options.agentRole);
  if (roleSection) sections.push(roleSection);

  // Environment
  if (options.environment || options.projectPath) {
    sections.push(buildEnvironmentSection(options.environment, options.projectPath));
  }

  // Project context
  if (options.projectStructure) {
    sections.push(buildProjectSection(options.projectStructure));
  }

  // YUAN.md
  if (options.yuanMdContent) {
    let content = options.yuanMdContent;
    if (content.length > 6000) {
      content = content.slice(0, 6000) + "\n[...truncated]";
    }
    sections.push(`# Project Memory (YUAN.md)\nFollow these conventions.\n\n${content}`);
  }

  // Tools
  if (options.tools.length > 0) {
    sections.push(buildToolSection(options.tools, options.activeToolNames));
  }

  // Skills (compact)
  if (options.activeSkills?.length) {
    sections.push(`# Active Skills\n${options.activeSkills.map((s) => `- ${s.skillName}: ${s.summary}`).join("\n")}`);
  }

  // Strategies (compact)
  if (options.activeStrategies?.length) {
    sections.push(`# Strategies\n${options.activeStrategies.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`);
  }

  // Experience hints (compact)
  if (options.experienceHints?.length) {
    sections.push(`# Experience\n${options.experienceHints.map((h) => `- ${h}`).join("\n")}`);
  }

  // Additional rules
  if (options.additionalRules?.length) {
    sections.push(`# Additional Rules\n${options.additionalRules.map((r) => `- ${r}`).join("\n")}`);
  }

  // ═══ END — reinforce + completion (second attention peak) ═══
  sections.push(SYSTEM_REINFORCE);

  return sections.join("\n\n---\n\n").trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
// DYNAMIC SECTION BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

function buildModeSection(mode?: ExecutionMode): string {
  if (!mode) return "";
  const rules: Record<ExecutionMode, string> = {
    FAST: "Mode: FAST — Read only the relevant file. Smallest correct change. Use the cheapest relevant verification; skip only optional extra checks.",
    NORMAL: "Mode: NORMAL — Read related files as needed. Verify with the normal build/test path.",
    DEEP: "Mode: DEEP — Read all affected files. Full build + test. Check all references before modifying symbols.",
    SUPERPOWER: "Mode: SUPERPOWER — Full verification pipeline. Self-reflection checkpoints. Architectural consideration.",
    COMPACT: "Mode: COMPACT — Resuming from previous session. Trust prior context. Complete remaining tasks efficiently.",
  };
  return `# Execution Mode\n${rules[mode]}`;
}

function buildRoleSection(role?: PromptAgentRole): string {
  if (!role || role === "generalist") return "";
  const rules: Record<Exclude<PromptAgentRole, "generalist">, string> = {
    planner: "Role: PLANNER — Analyze structure, create execution plan. Do not write code.",
    coder: "Role: CODER — Write correct code changes. Follow the plan. Verify after each change.",
    critic: "Role: CRITIC — Review changes for bugs, security, performance. Cite file+line. Do not write code.",
    verifier: "Role: VERIFIER — Run build/test/lint. Report pass/fail with exact errors. Do not fix.",
    specialist: "Role: SPECIALIST — Focus on assigned domain. Apply domain best practices.",
    recovery: "Role: RECOVERY — Diagnose failure, apply conservative fix, verify. Try different approach after 3 fails.",
  };
  return `# Agent Role\n${rules[role]}`;
}

function buildEnvironmentSection(env?: EnvironmentInfo, projectPath?: string): string {
  const parts: string[] = ["# Environment"];
  if (projectPath) parts.push(`- dir: ${projectPath}`);
  if (env?.os) parts.push(`- os: ${env.os}`);
  if (env?.shell) parts.push(`- shell: ${env.shell}`);
  if (env?.nodeVersion) parts.push(`- node: ${env.nodeVersion}`);
  if (env?.gitBranch) parts.push(`- branch: ${env.gitBranch}`);
  return parts.join("\n");
}

function buildProjectSection(structure: ProjectStructure): string {
  const tree = structure.treeView.length > 2000
    ? structure.treeView.slice(0, 2000) + "\n..."
    : structure.treeView;
  return `# Project
- lang: ${structure.primaryLanguage}, framework: ${structure.framework}
- pkg: ${structure.packageManager}, entry: ${structure.entryPoint}, files: ${structure.fileCount}
\`\`\`
${tree}
\`\`\``;
}

function buildToolSection(
  tools: ToolDefinition[],
  activeToolNames?: string[]
): string {
  const activeSet = new Set(activeToolNames ?? []);
   const hasSubAgent = tools.some((t) => t.name === "spawn_sub_agent");
  const visibleTools =
    activeToolNames && activeToolNames.length > 0
      ? tools.filter((t) => activeSet.has(t.name))
      : tools;

  const inactiveCount = Math.max(0, tools.length - visibleTools.length);

  const focusBlock =
    activeToolNames && activeToolNames.length > 0
      ? [
          "## Active tool subset for this turn",
          ...activeToolNames.map((name) => `- ${name}`),
          inactiveCount > 0
            ? `- ${inactiveCount} other tools exist, but prefer the active subset unless the evidence clearly requires another tool.`
            : "",
          "",
        ]
          .filter(Boolean)
          .join("\n")
      : "";

  const list = visibleTools
    .map((t) => {
      const params = t.parameters.properties
        ? Object.keys(t.parameters.properties as Record<string, unknown>).join(", ")
        : "";
      return `- **${t.name}**(${params}): ${t.description}`;
    })
    .join("\n");

  return `# Tools
${focusBlock ? `${focusBlock}\n` : ""}${list}

Tool selection discipline:
- Prefer the most specific tool whose schema directly matches the task.
- Prefer specialized tools over generic shell commands when both can solve the task.
- Keep the working tool set small for the current step; avoid considering unrelated tools.
- For write or side-effecting tools, confirm the required arguments are complete and plausible before calling.
- After a tool result arrives, update the plan from the actual result rather than repeating the prior assumption.
- Do not call the same tool with identical parameters repeatedly. If a result does not help, change the strategy.

## Available tools — full reference

**File operations:**
- \`file_read(file_path)\` — read file contents (also reads images for visual analysis)
- \`file_write(file_path, content)\` — create or overwrite a file
- \`file_edit(file_path, old_string, new_string)\` — precise string replacement in a file. old_string must be unique. Use for surgical edits.
- \`glob(pattern, path?)\` — find files by glob pattern (e.g. \`"src/**/*.ts"\`). NEVER use \`find\` or \`ls -R\`.
- \`grep(pattern, path?, include?)\` — search file contents with regex. Returns matching lines with context.
- \`code_search(query, path?)\` — semantic code search — finds functions, classes, symbols by name or description. Better than grep for "find the function that handles X".

**Shell & execution:**
- \`shell_exec(command, cwd?)\` — run a shell command. Use for simple commands (no pipes).
- \`bash(script)\` — run a bash script. Use when you need pipes, redirects, or multi-line scripts.
- \`test_run(command?, cwd?)\` — run test suite. Auto-detects test framework (jest, vitest, pytest, go test). Shows failures with context.

**Git:**
- \`git_ops(operation, ...args)\` — git operations: \`status\`, \`diff\`, \`log\`, \`add\`, \`commit\`, \`branch\`, \`checkout\`, \`stash\`.

**Web & search:**
- \`web_search(query)\` — search the web (Google via Gemini, DuckDuckGo fallback). Use for docs, error messages, API references.
- \`parallel_web_search(queries[])\` — run multiple web searches simultaneously. Use when you need to research several topics at once.

**Analysis & security:**
- \`security_scan(path?)\` — scan code for security vulnerabilities (secrets, injection, XSS, etc.).
- \`browser(url, action?)\` — navigate to URL, take screenshot, interact with web pages. Use for testing web apps or reading web documentation.

**Completion:**
- \`task_complete(summary)\` — mark the task as done. Always call when finished.

**Key patterns:**
- file discovery: \`glob\` first, if empty → \`shell_exec("ls -la {dir}")\` to verify
- content search: \`grep\` for text, \`code_search\` for symbols/functions
- read before edit: \`file_read\` → \`file_edit\`
- new files: \`file_write\`
- testing: \`test_run\` (auto-detects framework)
- web research: \`web_search\` or \`parallel_web_search\` for multiple queries
- security: \`security_scan\` before committing sensitive code
${hasSubAgent ? "- parallel independent tasks: `spawn_sub_agent`" : ""}

${hasSubAgent ? `
## Sub-agent delegation (spawn_sub_agent)

Use \`spawn_sub_agent\` when the task has **independent parallel work** — i.e., tasks that don't need each other's output to proceed.

**Spawn a sub-agent when:**
- 2+ files need to be written independently (e.g., frontend + backend of a feature)
- A task can be split into clearly isolated subtasks (research vs. implementation)
- A large task would benefit from a specialist focus (e.g., a dedicated test-writer sub-agent)

**Do NOT spawn when:**
- Tasks are sequential (B depends on A's output)
- The task is a single file edit
- You need to review the sub-agent's output before deciding what to do next

**How to delegate:**
1. Split the overall goal into independent subtasks
2. Call \`spawn_sub_agent\` once per subtask with a precise \`goal\` string
3. Wait for all results, then synthesize
4. Each sub-agent gets the same tool access as the parent

**goal format:** Be specific. Include file paths, expected output, constraints.
- ✓ "Write /src/api/users.ts — GET /users returns paginated list, POST /users creates user. Use existing db.ts patterns."
- ✗ "Handle the user API"
` : ""}`
}

