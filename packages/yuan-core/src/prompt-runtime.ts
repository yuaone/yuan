/**
 * @module prompt-runtime
 * @description YUAN PromptRuntime -- Decision policy compiler.
 *
 * Rules:
 * 1. Consumes DecisionContext ONLY (no new decisions)
 * 2. Produces PromptEnvelope -> delegates to PromptBuilder
 * 3. agent-loop calls this instead of directly injecting system messages
 *
 * YUA reference: prompt-runtime.ts (876 lines)
 * YUAN difference: coding agent specialized (tool budget hints, veto hints, plan context)
 */

import type { PromptEnvelope, PromptSection } from "./prompt-envelope.js";
import { section } from "./prompt-envelope.js";
import { getSystemCoreSections, getReinforceSections } from "./system-core.js";
import type { AgentDecisionContext } from "./agent-decision-types.js";
import type { SystemPromptOptions } from "./system-prompt.js";

// ─── Input Type ───

/** PromptRuntime input -- provided by agent-loop */
/** Context window 토큰 예산 배분 */
export interface PromptTokenBudget {
  /** 모델 전체 컨텍스트 윈도우 (토큰) */
  contextWindow: number;
  /** system prompt 최대 비율 (0~1, 기본 0.25) */
  systemPromptRatio: number;
  /** conversation 비율 (0~1, 기본 0.40) */
  conversationRatio: number;
  /** tool results 비율 (0~1, 기본 0.20) */
  toolResultsRatio: number;
  /** LLM 출력 여유 비율 (0~1, 기본 0.15) */
  outputReserveRatio: number;
}

/** 모델별 기본 예산 */
export const DEFAULT_TOKEN_BUDGETS: Record<string, PromptTokenBudget> = {
  gemini: {
    contextWindow: 32_000,
    systemPromptRatio: 0.25,     // 8K
    conversationRatio: 0.40,     // 12.8K
    toolResultsRatio: 0.20,     // 6.4K
    outputReserveRatio: 0.15,   // 4.8K
  },
  claude: {
    contextWindow: 200_000,
    systemPromptRatio: 0.15,     // 30K — 큰 윈도우니까 비율 낮춰도 충분
    conversationRatio: 0.45,     // 90K
    toolResultsRatio: 0.25,     // 50K
    outputReserveRatio: 0.15,   // 30K
  },
  openai: {
    contextWindow: 128_000,
    systemPromptRatio: 0.20,     // 25.6K
    conversationRatio: 0.40,     // 51.2K
    toolResultsRatio: 0.25,     // 32K
    outputReserveRatio: 0.15,   // 19.2K
  },
  default: {
    contextWindow: 32_000,
    systemPromptRatio: 0.25,
    conversationRatio: 0.40,
    toolResultsRatio: 0.20,
    outputReserveRatio: 0.15,
  },
};

/** system prompt에 쓸 수 있는 최대 토큰 계산 */
export function getSystemPromptMaxTokens(budget: PromptTokenBudget): number {
  return Math.floor(budget.contextWindow * budget.systemPromptRatio);
}

export interface PromptRuntimeInput {
  /** Decision Engine result (null = legacy fallback) */
  decision: AgentDecisionContext | null;

  /** Existing buildSystemPrompt options (backward compat) */
  promptOptions: SystemPromptOptions;

  /** Per-run context (memory, persona, reflexion, etc.) */
  runContext?: {
    memoryContext?: string;
    personaSection?: string;
    reflexionGuidance?: string;
    taskMemory?: string;
    ragContext?: string;
    playbookHint?: string;
    continuationPrompt?: string;
    worldStateSection?: string;
    weaknessContext?: string;
    learnedSkills?: string;
    pluginSkills?: string;
  };

  /** Per-iteration ephemeral hints (QA, reflection, budget, etc.) */
  ephemeralHints?: string[];

  /** 토큰 예산 (없으면 default 사용) */
  tokenBudget?: PromptTokenBudget;
}

// ─── Main Compiler ───

/**
 * Decision + Context -> PromptEnvelope.
 * This function is the SOLE place that decides "what goes into the prompt".
 *
 * PromptRuntime does NOT make new decisions -- only reads DecisionContext.
 * PromptRuntime does NOT produce prompt strings -- only produces PromptEnvelope.
 */
export function compilePromptEnvelope(input: PromptRuntimeInput): PromptEnvelope {
  const { decision, promptOptions, runContext, ephemeralHints, tokenBudget } = input;

  // 0. Token budget calculation
  const budget = tokenBudget ?? DEFAULT_TOKEN_BUDGETS.default;
  const maxTokens = getSystemPromptMaxTokens(budget);

  // 1. SystemCore (immutable)
  const systemCoreSections = getSystemCoreSections();

  // 2. RuntimePolicy (Decision-based)
  const runtimePolicySections = compileRuntimePolicy(decision, promptOptions);

  // 3. Role (Decision-based)
  const roleSections = compileRole(decision, promptOptions);

  // 4. TaskContext (per-run)
  const taskContextSections = compileTaskContext(decision, promptOptions, runContext);

  // 5. Ephemeral (per-iteration)
  const ephemeralSections = compileEphemeral(ephemeralHints);

  // 6. Reinforce (U-curve end)
  const reinforceSections = getReinforceSections();

  return {
    systemCoreSections,
    runtimePolicySections,
    roleSections,
    taskContextSections,
    ephemeralSections,
    reinforceSections,
    maxTokens,
  };
}

// ─── RuntimePolicy Compiler ───

/** Decision -> execution policy sections */
function compileRuntimePolicy(
  decision: AgentDecisionContext | null,
  opts: SystemPromptOptions,
): PromptSection[] {
  const sections: PromptSection[] = [];

  // Execution mode (from decision or fallback)
  const mode = decision?.core.computePolicy.modelTier === "deep" ? "DEEP"
    : decision?.core.computePolicy.modelTier === "fast" ? "FAST"
    : opts.executionMode ?? "NORMAL";

  const modeRules: Record<string, string> = {
    FAST: "Mode: FAST — Smallest correct change. Minimal verification.",
    NORMAL: "Mode: NORMAL — Read related files. Normal build/test.",
    DEEP: "Mode: DEEP — Full verification. Check all references.",
    SUPERPOWER: "Mode: SUPERPOWER — Full pipeline. Self-reflection checkpoints.",
    COMPACT: "Mode: COMPACT — Resuming session. Trust prior context.",
  };
  sections.push(section("execution-mode", `# Execution Mode\n${modeRules[mode] ?? modeRules.NORMAL}`, { priority: 10 }));

  // Decision-specific policy sections
  if (decision) {
    // Next action contract
    if (decision.core.nextAction === "ask_user") {
      const c = decision.core.clarification;
      const lines = [
        "# Next Action: ASK USER",
        "- You MUST ask the user for clarification before doing anything else.",
        "- Do NOT read files. Do NOT edit files. Do NOT run commands.",
        "- Ask your question clearly, then STOP and wait for the user's response.",
      ];
      if (c?.reason) lines.push(`- Reason: ${c.reason}`);
      if (c?.missingFields?.length) lines.push(`- Missing: ${c.missingFields.join(", ")}`);
      if (c?.suggestedOptions?.length) lines.push(`- Options: ${c.suggestedOptions.join(" | ")}`);
      sections.push(section("next-action", lines.join("\n"), { priority: 2 })); // Very high priority, right after core
    } else if (decision.core.nextAction === "blocked_external") {
      sections.push(section("next-action", [
        "# Next Action",
        "- You are blocked by an external dependency, approval gate, or missing environment capability.",
        "- Explain the blocker clearly and stop before risky changes.",
      ].join("\n"), { priority: 4 }));
    } else if (decision.core.planRequired) {
      sections.push(section("planning-contract", [
        "# Planning Contract",
        "- A plan is required for this task.",
        "- Create or follow a bounded plan before broad edits.",
        "- Execute step by step; do not jump straight into large changes.",
      ].join("\n"), { priority: 9 }));
    }
    // Tool budget hint
    const tb = decision.core.toolBudget;
    sections.push(section("tool-budget", [
      "# Tool Budget",
      `- file reads: max ${tb.maxFileReads}`,
      `- edits: max ${tb.maxEdits}`,
      `- shell: max ${tb.maxShellExecs}`,
      `- tests: max ${tb.maxTestRuns}`,
      `- searches: max ${tb.maxSearches}`,
      "Stay within budget. If approaching limits, prioritize essential operations.",
    ].join("\n"), { priority: 12, droppable: true }));

    // Veto hints
    const veto = decision.core.vetoFlags;
    const vetoHints: string[] = [];
    if (veto.editVetoed) vetoHints.push("- EDIT VETOED: Do not modify files without creating a plan first.");
    if (veto.verifyRequired) vetoHints.push("- VERIFY REQUIRED: Run build/test after every change.");
    if (veto.finalizeBlocked) vetoHints.push("- FINALIZE BLOCKED: Do not mark task complete until verification passes.");
    if (vetoHints.length > 0) {
      sections.push(section("veto-constraints", `# Constraints\n${vetoHints.join("\n")}`, { priority: 11 }));
    }

    // Verify depth hint
    const vd = decision.core.verifyDepth;
    if (vd !== "skip") {
      const depthDesc = vd === "thorough"
        ? "Run full build + test suite after changes."
        : "Quick type-check after changes.";
      sections.push(section("verify-depth", `# Verification\nVerify depth: ${vd}. ${depthDesc}`, { priority: 13, droppable: true }));
    }

    // Scan breadth hint (Phase G: wire Decision.scanBreadth → prompt)
    if (decision.core.scanBreadth === "wide") {
      sections.push(section("scan-breadth", "# Exploration\nSearch extensively. Use grep, glob, code_search broadly. Read up to 20 related files before making changes.", { priority: 14, droppable: true }));
    } else if (decision.core.scanBreadth === "narrow") {
      sections.push(section("scan-breadth", "# Exploration\nFocus narrowly. Read only the directly relevant file(s). Minimize exploration.", { priority: 14, droppable: true }));
    }

   // Sub-agent policy (only when the tool actually exists)
    const hasSubAgentTool = opts.tools.some(t => t.name === "spawn_sub_agent");
    if (
      hasSubAgentTool &&
      decision.core.interactionMode !== "CHAT" &&
      (decision.core.planRequired || decision.core.scanBreadth === "wide")
    ) {
      sections.push(section("sub-agent-policy", [
        "# Sub-agent Policy",
        "- Use sub-agents only for bounded, independent subtasks.",
        "- Each sub-agent must get one clear goal, expected artifact, and stop condition.",
        "- Use sub-agents for parallel exploration/verification, not for vague recursive delegation.",
        "- Parent agent keeps responsibility for synthesis, verification, and completion.",
      ].join("\n"), { priority: 16, droppable: true }));
    }

    // Sub-agent delegation plan (Decision-specific rules when subAgentPlan is enabled)
    if (decision.core.subAgentPlan.enabled) {
      const sap = decision.core.subAgentPlan;
      sections.push(section("sub-agent-rules", [
        "# Sub-Agent Delegation",
        `- Strategy: ${sap.strategy}`,
        `- Max agents: ${sap.maxAgents}`,
        `- Roles: ${sap.roles.join(", ")}`,
        "- Spawn sub-agents for independent parallel subtasks",
        "- Each sub-agent gets its own tool budget",
        "- Do NOT spawn for sequential dependent tasks",
      ].join("\n"), { priority: 16, droppable: true }));
    }

    // Code quality policy (YUA implementationMode equivalent)
    if (decision.core.codeQuality.isCodeTask) {
      const cq = decision.core.codeQuality;

      const parts = [`# Code Quality — ${cq.codeTaskType.toUpperCase()} mode`];
      parts.push(`Primary risk: ${cq.primaryRisk}`);

      if (cq.strictMode) {
        parts.push("");
        parts.push("STRICT MODE — Zero tolerance for incomplete code:");
        parts.push("- No TODO, FIXME, HACK, XXX comments");
        parts.push("- No stub/placeholder/empty implementations");
        parts.push("- No 'throw new Error(\"not implemented\")'");
        parts.push("- Every function must have a real, working implementation");
      }

      if (cq.constraints.length > 0) {
        parts.push("");
        parts.push("Constraints:");
        for (const c of cq.constraints) {
          parts.push(`- ${c}`);
        }
      }

      sections.push(section("code-quality", parts.join("\n"), { priority: 7 }));
    }

    // LeadHint
    if (decision.core.leadHint === "HARD") {
      sections.push(section("lead-hint", "# Direction\nProvide clear, structured guidance. Recommend specific approaches. Do not leave decisions ambiguous.", { priority: 8, droppable: true }));
    } else if (decision.core.leadHint === "SOFT") {
      sections.push(section("lead-hint", "# Direction\nSuggest next steps gently after completing the current task.", { priority: 8, droppable: true }));
    }

    // ResponseHint
    const rh = decision.core.responseHint;
    const structureDesc: Record<string, string> = { direct_answer: "Answer directly", problem_solution: "Problem → Root cause → Fix", stepwise_explanation: "Step-by-step explanation", code_first: "Show code first, explain after" };
    const rhParts = [`# Output Structure\n- Format: ${structureDesc[rh.structure] ?? "Answer directly"}`, `- Detail level: ${rh.expansion}`];
    if (rh.forbid.metaComment) rhParts.push("- Do NOT use meta-comments like '설명해보면', '정리하면', 'Let me explain'");
    if (rh.forbid.apology) rhParts.push("- Do NOT apologize. No '죄송합니다', 'Sorry', 'I apologize'");
    sections.push(section("response-hint", rhParts.join("\n"), { priority: 6, droppable: true }));

    // ToolGate
    if (decision.core.toolGate.level === "READ_ONLY") {
      sections.push(section("tool-gate", "# Tool Access: READ-ONLY\nDo NOT write, edit, or delete any files. Only read and analyze.", { priority: 5 }));
    } else if (decision.core.toolGate.level === "LIMITED") {
      sections.push(section("tool-gate", `# Tool Access: LIMITED\nBlocked tools: ${decision.core.toolGate.blockedTools.join(", ")}. Verify before each write operation.`, { priority: 5 }));
    }

    // ResponsePressure
    if (decision.core.pressureDecision.pressure === "ASSERTIVE") {
      sections.push(section("pressure", "# Execution Pressure: ASSERTIVE\nPush forward decisively. Do not hesitate or over-explain. Execute and report results.", { priority: 9, droppable: true }));
    } else if (decision.core.pressureDecision.pressure === "GENTLE") {
      sections.push(section("pressure", "# Execution Pressure: GENTLE\nBe careful and deliberate. Explain reasoning. Ask if unsure.", { priority: 9, droppable: true }));
    }

    // ContinuityCapsule
    if (decision.core.continuityCapsule.enabled) {
      const capsuleRules = decision.core.continuityCapsule.rules.map(r => `- ${r}`).join("\n");
      sections.push(section("continuity-capsule", `# Continuation Context\n${capsuleRules}`, { priority: 3 })); // Very high priority
    }

    // StyleHint
    const sh = decision.core.styleHint;
    if (sh.formality === "casual") {
      sections.push(section("style", "# Style: Casual\nUse informal tone. 반말 OK. Keep it relaxed.", { priority: 10, droppable: true }));
    } else if (sh.formality === "formal") {
      sections.push(section("style", "# Style: Formal\nUse professional, polite language.", { priority: 10, droppable: true }));
    }
    if (sh.brevity === "terse") {
      sections.push(section("brevity", "# Brevity: Terse\nKeep responses very short. Code over explanation.", { priority: 10, droppable: true }));
    }

    // Mode-specific policy sections (CHAT/HYBRID/AGENT)
    sections.push(...compileModeSpecificPolicy(decision));
  }

  return sections;
}

// ─── Mode-Specific Policy ───

/**
 * Compile interaction-mode-specific prompt policy sections.
 * Translates the Decision Engine's interactionMode into natural-language
 * instructions that shape the LLM's behavior for this turn.
 */
function compileModeSpecificPolicy(
  decision: AgentDecisionContext,
): PromptSection[] {
  const mode = decision.core.interactionMode;
  const sections: PromptSection[] = [];

  switch (mode) {
    case "CHAT":
      sections.push(section("interaction-mode", [
        "# Mode: Conversational",
        "- Answer questions naturally. Explain clearly.",
        "- Use tools only when the answer needs project context.",
        "- Keep responses concise and direct.",
        "- Do not create plans or execution steps.",
      ].join("\n"), { priority: 8 }));
      break;

    case "HYBRID":
      sections.push(section("interaction-mode", [
        "# Mode: Hybrid",
        "- Execute the task directly, then verify.",
        "- Keep planning lightweight (2-3 steps max).",
        "- Run quick verification after changes.",
      ].join("\n"), { priority: 8 }));
      break;

    case "AGENT":
      sections.push(section("interaction-mode", [
        "# Mode: Full Agent",
        "- Follow the execution plan strictly.",
        "- Verify after every significant change.",
        "- Use all available tools within budget.",
        "- Report progress at each milestone.",
      ].join("\n"), { priority: 8 }));
      break;
  }

  return sections;
}

// ─── Role Compiler ───

/** Decision -> role section */
function compileRole(
  _decision: AgentDecisionContext | null,
  opts: SystemPromptOptions,
): PromptSection[] {
  const role = opts.agentRole ?? "generalist";
  if (role === "generalist") return [];

  const roleRules: Record<string, string> = {
    planner: "Role: PLANNER — Analyze structure, create execution plan. Do not write code.",
    coder: "Role: CODER — Write correct code changes. Follow the plan. Verify after each change.",
    critic: "Role: CRITIC — Review changes for bugs, security, performance. Cite file+line.",
    verifier: "Role: VERIFIER — Run build/test/lint. Report pass/fail. Do not fix.",
    specialist: "Role: SPECIALIST — Focus on assigned domain.",
    recovery: "Role: RECOVERY — Diagnose failure, apply conservative fix, verify.",
  };

  const ruleText = roleRules[role];
  if (!ruleText) return [];

  return [section("agent-role", `# Agent Role\n${ruleText}`, { priority: 15 })];
}

// ─── TaskContext Compiler ───

/** Decision + Context -> task context sections */
function compileTaskContext(
  decision: AgentDecisionContext | null,
  opts: SystemPromptOptions,
  ctx?: PromptRuntimeInput["runContext"],
): PromptSection[] {
  const sections: PromptSection[] = [];

  // Environment
  if (opts.environment || opts.projectPath) {
    const parts = ["# Environment"];
    if (opts.projectPath) parts.push(`- dir: ${opts.projectPath}`);
    if (opts.environment?.os) parts.push(`- os: ${opts.environment.os}`);
    if (opts.environment?.shell) parts.push(`- shell: ${opts.environment.shell}`);
    if (opts.environment?.nodeVersion) parts.push(`- node: ${opts.environment.nodeVersion}`);
    if (opts.environment?.gitBranch) parts.push(`- branch: ${opts.environment.gitBranch}`);
    sections.push(section("environment", parts.join("\n"), { priority: 20 }));
  }

  // Project structure
  if (opts.projectStructure) {
    const tree = opts.projectStructure.treeView.length > 2000
      ? opts.projectStructure.treeView.slice(0, 2000) + "\n..."
      : opts.projectStructure.treeView;
    sections.push(section("project", [
      "# Project",
      `- lang: ${opts.projectStructure.primaryLanguage}, framework: ${opts.projectStructure.framework}`,
      "```",
      tree,
      "```",
    ].join("\n"), { priority: 21, droppable: true }));
  }

  // YUAN.md
  if (opts.yuanMdContent) {
    let content = opts.yuanMdContent;
    if (content.length > 6000) content = content.slice(0, 6000) + "\n[...truncated]";
    sections.push(section("yuan-md", `# Project Memory (YUAN.md)\n${content}`, { priority: 22, droppable: true }));
  }

  // Tools
  if (opts.tools.length > 0) {
    sections.push(section("tools", buildToolSectionCompact(opts.tools, opts.activeToolNames), { priority: 25 }));
  }

 // Skills / strategies / experience / additional rules
  if (opts.activeSkills?.length) {
    sections.push(section(
      "active-skills",
      `# Active Skills\n${opts.activeSkills.map(s => `- ${s.skillName}: ${s.summary}`).join("\n")}`,
      { priority: 23, droppable: true },
    ));
  }
  if (opts.activeStrategies?.length) {
    sections.push(section(
      "active-strategies",
      `# Active Strategies\n${opts.activeStrategies.map(s => `- ${s.name}: ${s.description}`).join("\n")}`,
      { priority: 24, droppable: true },
    ));
  }
  if (opts.experienceHints?.length) {
    sections.push(section(
      "experience-hints",
      `# Experience\n${opts.experienceHints.map(h => `- ${h}`).join("\n")}`,
      { priority: 26, droppable: true },
    ));
  }
  if (opts.additionalRules?.length) {
    sections.push(section(
      "additional-rules",
      `# Additional Rules\n${opts.additionalRules.map(r => `- ${r}`).join("\n")}`,
      { priority: 27, droppable: true },
    ));
  }

  // Per-run context sections (from runContext)
  if (ctx?.memoryContext) {
    sections.push(section("memory", `# Memory\n${ctx.memoryContext}`, { priority: 30, droppable: true }));
  }
  if (ctx?.personaSection) {
    sections.push(section("persona", ctx.personaSection, { priority: 31, droppable: true }));
  }
  if (ctx?.reflexionGuidance) {
    sections.push(section("reflexion", ctx.reflexionGuidance, { priority: 32, droppable: true }));
  }
  if (ctx?.taskMemory) {
    sections.push(section("task-memory", ctx.taskMemory, { priority: 33, droppable: true }));
  }
  if (ctx?.ragContext) {
    sections.push(section("rag", `# RAG Context\n${ctx.ragContext}`, { priority: 34, droppable: true }));
  }
  if (ctx?.playbookHint) {
    sections.push(section("playbook", ctx.playbookHint, { priority: 35, droppable: true }));
  }
  if (ctx?.worldStateSection) {
    sections.push(section("world-state", ctx.worldStateSection, { priority: 36, droppable: true }));
  }
  if (ctx?.weaknessContext) {
    sections.push(section("weakness", ctx.weaknessContext, { priority: 37, droppable: true }));
  }
  if (ctx?.learnedSkills) {
    sections.push(section("learned-skills", ctx.learnedSkills, { priority: 38, droppable: true }));
  }
  if (ctx?.pluginSkills) {
    sections.push(section("plugin-skills", ctx.pluginSkills, { priority: 39, droppable: true }));
  }

  // Decision-based context
  if (decision) {
    const r = decision.core.reasoning;
    sections.push(section("decision-hint", [
      "# Task Analysis",
      `- intent: ${r.intent} (${decision.core.reasoning.complexity})`,
      `- stage: ${r.taskStage}`,
      `- plan: ${decision.core.planRequired ? "required" : "not needed"}`,
      `- next: ${r.nextAnchors.join(" \u2192 ")}`,
    ].join("\n"), { priority: 28 }));

    // MicroPlan
    if (decision.core.microPlan?.length) {
      sections.push(section("micro-plan", `# Execution Steps\n${decision.core.microPlan.map((s, i) => `${i + 1}. ${s}`).join("\n")}`, { priority: 29 }));
    }

    // Continuation context (QA fix: wire unused continuation field)
    if (decision.core.continuation.isContinuation) {
      const c = decision.core.continuation;
      const parts = ["# Continuation Context", `- Continuing from previous task (score: ${c.continuityScore.toFixed(2)})`];
      if (c.carryover.prevIntent) parts.push(`- Previous intent: ${c.carryover.prevIntent}`);
      if (c.carryover.modifiedFiles.length > 0) parts.push(`- Previously modified: ${c.carryover.modifiedFiles.join(", ")}`);
      if (c.carryover.failedAttempts.length > 0) parts.push(`- Previous failures: ${c.carryover.failedAttempts.join(", ")}`);
      sections.push(section("continuation", parts.join("\n"), { priority: 27, droppable: true }));
    }

    // Persona hint (Phase I+ SSOT)
    if (decision.core.personaHint) {
      const ph = decision.core.personaHint;
      const toneDesc: Record<string, string> = {
        casual: "Use casual, conversational tone. Short sentences. 반말 OK.",
        professional: "Use clear, professional tone.",
        technical: "Use precise technical language. Include specifics.",
        friendly: "Be friendly and approachable. Explain clearly.",
      };
      sections.push(section("persona-hint", `# Communication Style\n${toneDesc[ph.tone]}`, { priority: 9, droppable: true }));
    }
  }

  return sections;
}

// ─── Ephemeral Compiler ───

/** Ephemeral hints -> sections (max 7 hints, max 3000 tokens total) */
function compileEphemeral(hints?: string[]): PromptSection[] {
  if (!hints?.length) return [];

  const MAX_HINTS = 7;
  const MAX_TOKENS = 3000;
  let tokenCount = 0;
  const sections: PromptSection[] = [];

  for (const hint of hints.slice(0, MAX_HINTS)) {
    const tokens = Math.ceil(hint.length / 3.5);
    if (tokenCount + tokens > MAX_TOKENS) break;
    tokenCount += tokens;
    sections.push(section(`ephemeral-${sections.length}`, hint, { priority: 60, droppable: true }));
  }

  return sections;
}

// ─── Helpers ───

/** Compact tool section builder */
function buildToolSectionCompact(
  tools: Array<{ name: string; description: string }>,
  activeNames?: string[],
): string {
  const activeSet = new Set(activeNames ?? []);
  const visible = activeNames?.length
    ? tools.filter(t => activeSet.has(t.name))
    : tools;
  const list = visible.map(t => `- **${t.name}**: ${t.description}`).join("\n");
  const focus = activeNames?.length
    ? `## Active tool subset\n${activeNames.map(n => `- ${n}`).join("\n")}\n\n`
    : "";
  const hasSubAgent = visible.some(t => t.name === "spawn_sub_agent");
  const suffix = hasSubAgent
    ? "\n\n- spawn_sub_agent is available for bounded independent subtasks only."
    : "";
  return `# Tools\n${focus}${list}${suffix}`;
}
