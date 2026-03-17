/**
 * @module agent-decision
 * @description Main Agent Decision Orchestrator.
 * Single entry point: `agentDecide()` — called once per user message.
 * Produces an immutable, deep-frozen `AgentDecisionContext` (SSOT).
 *
 * Pure function (except `crypto.randomUUID()` for session ID in meta).
 * NO LLM calls, NO async.
 *
 * Design spec: docs/superpowers/specs/2026-03-17-yuan-agent-decision-engine-design.md, section 6
 */

import { randomUUID } from "node:crypto";

import type {
  AgentAffordanceVector,
  AgentCodeQualityPolicy,
  AgentComplexity,
  AgentComputePolicy,
  AgentContinuityCapsule,
  AgentDecisionContext,
  AgentDecisionCore,
  AgentFailureSurface,
  AgentFlowAnchor,
  AgentIntent,
  AgentLeadHint,
  AgentMemoryCategory,
  AgentMemoryIntent,
  AgentMemoryLoad,
  AgentNextAction,
  AgentPersonaHint,
  AgentPressureDecision,
  AgentProjectContext,
  AgentReasoningResult,
  AgentResponseHint,
  AgentSkillActivation,
  AgentStyleHint,
  AgentSubAgentPlan,
  AgentTaskContinuation,
  AgentToolBudget,
  AgentToolGate,
  AgentVetoFlags,
  ClarificationRequest,
  InteractionMode,
  RecoveryHint,
} from "./agent-decision-types.js";

import type { SubAgentRole } from "./sub-agent-prompts.js";

import { agentReason } from "./agent-reasoning-engine.js";
import { computeAgentAffordance, applyStuckBreaker } from "./agent-affordance.js";

// ─── Utilities ───

/** Clamp a number to [0, 1]. */
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Deep freeze utility — recursively freezes nested objects/arrays (GPT QA #1).
 * Returns the same object reference, frozen in place.
 */
function deepFreeze<T extends object>(obj: T): Readonly<T> {
  Object.freeze(obj);
  for (const val of Object.values(obj)) {
    if (val && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val as object);
    }
  }
  return obj;
}

// ─── ComputePolicy (§6.2) ───

const POLICY_TABLE: Record<AgentComplexity, AgentComputePolicy> = {
  trivial:  { maxIterations: 3,  maxTokenBudget: 8_000,   modelTier: "fast",     parallelAgents: 0 },
  simple:   { maxIterations: 8,  maxTokenBudget: 20_000,  modelTier: "fast",     parallelAgents: 0 },
  moderate: { maxIterations: 15, maxTokenBudget: 50_000,  modelTier: "standard", parallelAgents: 1 },
  complex:  { maxIterations: 30, maxTokenBudget: 100_000, modelTier: "standard", parallelAgents: 2 },
  massive:  { maxIterations: 50, maxTokenBudget: 200_000, modelTier: "deep",     parallelAgents: 3 },
};

function deriveComputePolicy(reasoning: AgentReasoningResult): AgentComputePolicy {
  const { complexity, depthHint } = reasoning;
  const base = POLICY_TABLE[complexity];

  // Deep hint override: promote fast → standard when deep analysis requested
  if (depthHint === "deep" && base.modelTier === "fast") {
    return { ...base, modelTier: "standard" };
  }

  return base;
}

// ─── FailureSurface (§6.4) ───

/**
 * Risk balance formula from YUA pipeline-lite: stability/risk-balance.ts
 * Adjusts risk threshold based on FP/FN cost asymmetry.
 * For coding: FP cost (unnecessary caution) = 0.3, FN cost (missed bug) = 0.7
 */
function computeRiskBalance(fpCost: number, fnCost: number, tau: number): number {
  return (tau + fpCost) / fnCost;
}

const RISK_BALANCE = computeRiskBalance(0.3, 0.7, 0.5); // ~1.14 — slightly risk-averse

const COMPLEXITY_RISK: Record<AgentComplexity, number> = {
  trivial: 0, simple: 0.1, moderate: 0.2, complex: 0.3, massive: 0.5,
};

const BLAST_RADIUS: Record<AgentComplexity, number> = {
  trivial: 0.05, simple: 0.1, moderate: 0.25, complex: 0.5, massive: 0.8,
};

function estimateFailureSurface(
  reasoning: AgentReasoningResult,
  projectContext?: AgentProjectContext,
): AgentFailureSurface {
  const { intent, complexity, taskStage, confidence } = reasoning;

  // Patch risk: edit/refactor/fix intents carry higher base risk
  // Risk balance (YUA FSLE): FP/FN cost-adjusted risk multiplier
  const isModifyIntent = intent === "edit" || intent === "refactor" || intent === "fix";
  let patchRisk = clamp01(
    ((isModifyIntent ? 0.3 : 0.1) + COMPLEXITY_RISK[complexity]) * RISK_BALANCE,
  );
  // High codebase complexity → patch risk bump
  if (projectContext?.avgCyclomaticComplexity && projectContext.avgCyclomaticComplexity > 15) {
    patchRisk = clamp01(patchRisk + 0.1);
  }
  if (projectContext?.maxFileComplexity && projectContext.maxFileComplexity > 50) {
    patchRisk = clamp01(patchRisk + 0.1);
  }

  // Build risk: higher for compiled languages + existing build errors
  const isCompiled = projectContext?.language !== "python" && projectContext?.language !== "shell";
  let buildRisk = clamp01(patchRisk * (isCompiled ? 1.2 : 0.5));
  if (projectContext?.hasBuildErrors) buildRisk = clamp01(buildRisk + 0.2);

  // Test risk: higher when project has no tests or has recent failures
  let testRisk = clamp01(patchRisk * (projectContext?.hasTests ? 0.6 : 1.3));
  if (projectContext?.recentFailureCount && projectContext.recentFailureCount > 0) {
    testRisk = clamp01(testRisk + 0.15);
  }

  // Blast radius: complexity-based + dirty tree bump
  let blastRadius = clamp01(BLAST_RADIUS[complexity]);
  if (projectContext?.dirtyWorkingTree) blastRadius = clamp01(blastRadius + 0.1);

  // Ambiguity risk: underspecified + low confidence + missing deps + conflicts
  let ambiguityRisk = clamp01(
    (taskStage === "underspecified" ? 0.5 : 0.1) + (1 - confidence) * 0.3,
  );
  if (projectContext?.missingDeps) ambiguityRisk = clamp01(ambiguityRisk + 0.15);
  if (projectContext?.hasConflicts) ambiguityRisk = clamp01(ambiguityRisk + 0.2);

  return { patchRisk, buildRisk, testRisk, blastRadius, ambiguityRisk };
}

// ─── VetoFlags (GPT QA #6) ───

function computeVetoFlags(
  surface: AgentFailureSurface,
  planRequired: boolean,
): AgentVetoFlags {
  return {
    editVetoed: surface.patchRisk >= 0.8 && !planRequired,
    verifyRequired: surface.blastRadius >= 0.6,
    clarifyForced: surface.ambiguityRisk >= 0.7,
    finalizeBlocked: surface.buildRisk >= 0.7,
  };
}

// ─── ToolBudget (§6.3) ───

interface BaseBudgetEntry {
  maxFileReads: number;
  maxEdits: number;
  maxShellExecs: number;
  maxTestRuns: number;
  maxSearches: number;
  maxWebLookups: number;
  shellCostUnits: number;
  maxSameFileEdits: number;
}

const BASE_BUDGET: Record<AgentComplexity, BaseBudgetEntry> = {
  trivial:  { maxFileReads: 3,  maxEdits: 2,  maxShellExecs: 1,  maxTestRuns: 1, maxSearches: 3,  maxWebLookups: 0, shellCostUnits: 1, maxSameFileEdits: 2 },
  simple:   { maxFileReads: 8,  maxEdits: 4,  maxShellExecs: 3,  maxTestRuns: 2, maxSearches: 8,  maxWebLookups: 1, shellCostUnits: 2, maxSameFileEdits: 3 },
  moderate: { maxFileReads: 15, maxEdits: 8,  maxShellExecs: 5,  maxTestRuns: 3, maxSearches: 15, maxWebLookups: 2, shellCostUnits: 3, maxSameFileEdits: 4 },
  complex:  { maxFileReads: 30, maxEdits: 15, maxShellExecs: 10, maxTestRuns: 5, maxSearches: 30, maxWebLookups: 3, shellCostUnits: 5, maxSameFileEdits: 5 },
  massive:  { maxFileReads: 60, maxEdits: 30, maxShellExecs: 20, maxTestRuns: 8, maxSearches: 60, maxWebLookups: 5, shellCostUnits: 8, maxSameFileEdits: 6 },
};

function deriveToolBudget(
  reasoning: AgentReasoningResult,
  affordance: AgentAffordanceVector,
): AgentToolBudget {
  const { complexity } = reasoning;
  const budget: AgentToolBudget = { ...BASE_BUDGET[complexity] };

  // Affordance-based adjustments
  if (affordance.inspect_more > 0.7) {
    budget.maxFileReads = Math.ceil(budget.maxFileReads * 1.5);
    budget.maxSearches = Math.ceil(budget.maxSearches * 1.5);
  }
  if (affordance.run_checks > 0.7) {
    budget.maxTestRuns = Math.ceil(budget.maxTestRuns * 1.5);
    budget.maxShellExecs = Math.ceil(budget.maxShellExecs * 1.3);
  }
  if (affordance.edit_now < 0.3) {
    budget.maxEdits = Math.ceil(budget.maxEdits * 0.5);
  }

  return budget;
}

// ─── MemoryIntent (§13.3) ───

function deriveMemoryIntent(reasoning: AgentReasoningResult): AgentMemoryIntent {
  const { intent, complexity } = reasoning;

  // Simple lookups don't need memory saves
  if (intent === "inspect" || intent === "read" || intent === "search") {
    return { shouldSave: false, categories: [], priority: "low", target: "local" };
  }

  const categories: AgentMemoryCategory[] = [];

  // Modify intents → tool_pattern + file_structure
  if (intent === "edit" || intent === "refactor" || intent === "fix") {
    categories.push("tool_pattern", "file_structure");
  }

  // Fix → error_pattern + failure_avoidance
  if (intent === "fix") {
    categories.push("error_pattern", "failure_avoidance");
  }

  // Test/verify → project_rule
  if (intent === "test" || intent === "verify") {
    categories.push("project_rule");
  }

  const priority: "low" | "normal" | "high" =
    complexity === "massive" || complexity === "complex" ? "high" : "normal";

  return {
    shouldSave: categories.length > 0,
    categories,
    priority,
    target: "local",
  };
}

// ─── Task Continuation (§14.3) ───

function detectTaskContinuation(
  message: string,
  prevDecision?: AgentDecisionContext,
): AgentTaskContinuation {
  if (!prevDecision) {
    return {
      isContinuation: false,
      continuityScore: 0,
      carryover: { modifiedFiles: [], failedAttempts: [] },
    };
  }

  let score = 0;

  // Reference to previous context
  if (/(아까|이전|위에|방금|earlier|previous|that file|same)/i.test(message)) {
    score += 0.3;
  }

  // Short continuation commands
  if (/^(계속|다음|진행|ㄱㄱ|go|continue|next|이어서)$/i.test(message.trim())) {
    score += 0.5;
  }

  // Retry/correction requests
  if (/(다시|다르게|수정|고쳐|retry|again|differently)/i.test(message)) {
    score += 0.4;
  }

  // Iterating stage from previous decision
  if (prevDecision.core.reasoning.taskStage === "iterating") {
    score += 0.2;
  }

  const isContinuation = score >= 0.4;

  return {
    isContinuation,
    continuityScore: clamp01(score),
    carryover: {
      modifiedFiles: [],
      failedAttempts: [],
      prevIntent: prevDecision.core.reasoning.intent,
      prevStage: prevDecision.core.reasoning.taskStage,
    },
  };
}

// ─── MicroPlan (GPT QA #17) ───

function deriveMicroPlan(anchors: readonly AgentFlowAnchor[]): string[] {
  return anchors.map((anchor) => {
    switch (anchor) {
      case "SEARCH_REPO":       return "Search the codebase for relevant files";
      case "READ_FILES":        return "Read and understand the target files";
      case "PREPARE_PATCH":     return "Prepare the code changes";
      case "RUN_TESTS":         return "Run tests to verify changes";
      case "VERIFY_RESULT":     return "Verify build and type-check pass";
      case "SUMMARIZE_CHANGE":  return "Summarize what was changed";
    }
  });
}

// ─── InteractionMode (Dual-Mode) ───

/**
 * Derive the interaction mode from reasoning result.
 * Deterministic: same reasoning always yields the same mode.
 *
 * Rules:
 * - CHAT: trivial + explore intents (inspect/read/search), OR underspecified
 * - AGENT: complex/massive, OR plan/refactor intent, OR fix+moderate+
 * - HYBRID: moderate edit/fix/test/verify, OR simple edit/fix
 * - Default: CHAT
 */
export function deriveInteractionMode(reasoning: AgentReasoningResult): InteractionMode {
  const { intent, complexity, taskStage } = reasoning;

  // CHAT: trivial complexity with explore-type intents
  if (complexity === "trivial" && (intent === "inspect" || intent === "read" || intent === "search")) {
    return "CHAT";
  }

  // CHAT: underspecified → clarification-only, no execution
  if (taskStage === "underspecified") {
    return "CHAT";
  }

  // AGENT: complex/massive complexity
  if (complexity === "complex" || complexity === "massive") {
    return "AGENT";
  }

  // AGENT: plan/refactor intents always need full agent
  if (intent === "plan" || intent === "refactor") {
    return "AGENT";
  }

  // AGENT: fix intent at moderate+ complexity
  if (intent === "fix" && complexity !== "simple") {
    return "AGENT";
  }

  // HYBRID: moderate complexity with any intent
  if (complexity === "moderate") {
    return "HYBRID";
  }

  // HYBRID: simple edit/fix/test/verify (verify is still useful)
  if (intent === "edit" || intent === "fix" || intent === "test" || intent === "verify") {
    return "HYBRID";
  }

  // Default: CHAT
  return "CHAT";
}

// ─── SubAgent Plan (Phase I SSOT) ───

function deriveSubAgentPlan(reasoning: AgentReasoningResult): AgentSubAgentPlan {
  const { intent, complexity } = reasoning;

  // Only enable for complex+ tasks
  if (complexity === "trivial" || complexity === "simple" || complexity === "moderate") {
    return { enabled: false, maxAgents: 0, roles: [], strategy: "sequential" };
  }

  // complex/massive: intent-based role selection
  const roleMap: Partial<Record<AgentIntent, SubAgentRole[]>> = {
    fix: ["debugger", "coder", "tester"],
    refactor: ["planner", "refactorer", "tester"],
    edit: ["coder", "reviewer"],
    test: ["tester", "coder"],
    plan: ["planner"],
    verify: ["tester", "reviewer"],
  };

  const roles = roleMap[intent] ?? ["coder"];
  const maxAgents = complexity === "massive" ? 3 : 2;
  const strategy = complexity === "massive" ? "parallel" : "sequential";

  return { enabled: true, maxAgents, roles, strategy };
}

// ─── Persona Hint (Phase I+ SSOT) ───

function derivePersonaHint(message: string): AgentPersonaHint {
  // Detect language
  const hasKorean = /[가-힣]/.test(message);
  const language = hasKorean ? "ko" : "auto";

  // Detect tone from message patterns
  const isCasual = /ㄱㄱ|ㅋㅋ|ㅎㅎ|ㅇㅇ|해줘|고쳐|봐봐|알려줘/i.test(message);
  const isTechnical = /architecture|설계|구조|리팩토링|타입|인터페이스/i.test(message);

  const tone = isCasual ? "casual" : isTechnical ? "technical" : "professional";

  return { tone, language };
}

// ─── Memory Load (Phase I+ SSOT) ───

function deriveMemoryLoad(reasoning: AgentReasoningResult): AgentMemoryLoad {
  // Trivial tasks don't need memory
  if (reasoning.complexity === "trivial") {
    return { shouldLoad: false, categories: [] };
  }

  // Exploration: load file_structure + project_rule
  if (reasoning.intent === "inspect" || reasoning.intent === "read" || reasoning.intent === "search") {
    return { shouldLoad: true, categories: ["file_structure", "project_rule"] };
  }

  // Modify: load everything relevant
  if (reasoning.intent === "edit" || reasoning.intent === "refactor" || reasoning.intent === "fix") {
    return { shouldLoad: true, categories: ["tool_pattern", "error_pattern", "project_rule", "file_structure"] };
  }

  // Default: load basics
  return { shouldLoad: true, categories: ["project_rule"] };
}

// ─── Skill Activation (Phase I SSOT) ───

function deriveSkillActivation(reasoning: AgentReasoningResult): AgentSkillActivation {
  const { intent, complexity } = reasoning;
  const isModify = intent === "edit" || intent === "refactor" || intent === "fix";

  return {
    enableToolPlanning: isModify && complexity !== "trivial",
    enableSkillLearning: complexity !== "trivial",
    enablePlugins: true, // always on, runtime matching
    enableSpecialist: isModify && complexity !== "trivial" && complexity !== "simple",
    specialistDomain: undefined, // could infer from reasoning, MVP = undefined
  };
}

// ─── Code Quality Policy ───

function deriveCodeQualityPolicy(reasoning: AgentReasoningResult): AgentCodeQualityPolicy {
  const { intent, complexity } = reasoning;

  // Not a code task
  if (intent === "inspect" || intent === "read" || intent === "search") {
    return { isCodeTask: false, codeTaskType: "none", primaryRisk: "none", constraints: [], strictMode: false, preEditVerify: false };
  }

  // Map intent → code task type
  const taskTypeMap: Record<string, AgentCodeQualityPolicy["codeTaskType"]> = {
    edit: "generation",
    fix: "fix",
    refactor: "refactor",
    test: "test",
    verify: "review",
    plan: "none",
  };
  const codeTaskType = taskTypeMap[intent] ?? "none";

  // Map task type → primary risk
  const riskMap: Record<string, AgentCodeQualityPolicy["primaryRisk"]> = {
    generation: "extension_pain",
    fix: "async_race",
    refactor: "state_corruption",
    review: "state_corruption",
    test: "type_safety",
    none: "none",
  };
  const primaryRisk = riskMap[codeTaskType] ?? "none";

  // Constraints based on task type
  const constraints: string[] = [];

  if (codeTaskType === "generation") {
    constraints.push(
      "Write complete, production-ready code. No TODO, FIXME, placeholder, stub, or empty implementations.",
      "If requirements are unclear, state assumptions explicitly then implement fully based on those assumptions.",
      "Do NOT ask clarifying questions mid-implementation. Make reasonable assumptions and proceed.",
      "Each file must be a complete, working module. No partial implementations.",
    );
  }
  if (codeTaskType === "fix") {
    constraints.push(
      "Reproduce the issue mentally first. Identify root cause before writing any fix.",
      "Apply the minimal correct fix. Do not refactor unrelated code.",
      "Verify the fix does not introduce new issues (type-check, edge cases).",
    );
  }
  if (codeTaskType === "refactor") {
    constraints.push(
      "Do NOT change behavior. Only restructure.",
      "Verify all existing tests still pass after refactoring.",
      "Prefer smaller, incremental refactors over large rewrites.",
    );
  }
  if (codeTaskType === "test") {
    constraints.push(
      "Test behavior, not implementation details.",
      "Cover edge cases and failure paths.",
      "Tests must be deterministic — no random data, no timing dependencies.",
    );
  }
  if (codeTaskType === "review") {
    constraints.push(
      "Do NOT modify code. Only analyze and report.",
      "Cite specific file and line numbers for each issue found.",
      "Prioritize: correctness → security → performance → readability.",
    );
  }

  // Complexity-based additions
  if (complexity === "complex" || complexity === "massive") {
    constraints.push(
      "Break the implementation into clearly separated modules/functions.",
      "Add JSDoc comments for public APIs only (not for internal helpers).",
    );
  }

  // Risk-based additions
  if (primaryRisk === "extension_pain") {
    constraints.push("Design for extension: use interfaces/types at boundaries. Future requirements should not require rewriting core logic.");
  }
  if (primaryRisk === "type_safety") {
    constraints.push("Never use 'any'. Use proper TypeScript types. Validate at system boundaries.");
  }
  if (primaryRisk === "async_race") {
    constraints.push("Check for race conditions in async code. Ensure proper error handling in Promise chains.");
  }
  if (primaryRisk === "state_corruption") {
    constraints.push("Verify state mutations are atomic and predictable. No hidden side effects.");
  }

  const strictMode = codeTaskType !== "none" && codeTaskType !== "review";
  const preEditVerify = complexity !== "trivial" && complexity !== "simple" && codeTaskType !== "none";

  return { isCodeTask: codeTaskType !== "none", codeTaskType, primaryRisk, constraints, strictMode, preEditVerify };
}

// ─── LeadHint ───

function deriveLeadHint(reasoning: AgentReasoningResult, mode: InteractionMode): AgentLeadHint {
  if (mode === "CHAT") return "NONE";
  if (mode === "AGENT") return "HARD";
  // HYBRID: depends on intent
  if (reasoning.intent === "plan" || reasoning.intent === "refactor") return "HARD";
  if (reasoning.intent === "fix" || reasoning.intent === "edit") return "SOFT";
  return "NONE";
}

// ─── ResponseHint ───

function deriveResponseHint(reasoning: AgentReasoningResult, mode: InteractionMode): AgentResponseHint {
  const { intent, complexity } = reasoning;

  // Structure based on intent
  const structureMap: Record<string, AgentResponseHint["structure"]> = {
    inspect: "direct_answer",
    read: "direct_answer",
    search: "direct_answer",
    fix: "problem_solution",
    plan: "stepwise_explanation",
    refactor: "stepwise_explanation",
    edit: "code_first",
    test: "code_first",
    verify: "direct_answer",
  };

  // Expansion based on mode + complexity
  const expansion: AgentResponseHint["expansion"] =
    mode === "CHAT" ? "soft"
    : complexity === "trivial" ? "none"
    : complexity === "massive" ? "full"
    : "guided";

  return {
    structure: structureMap[intent] ?? "direct_answer",
    expansion,
    forbid: {
      metaComment: mode !== "CHAT",
      narration: false,  // coding agent needs narration for tool calls
      apology: true,     // never apologize
    },
  };
}

// ─── ToolGate ───

function deriveToolGate(reasoning: AgentReasoningResult, vetoFlags: AgentVetoFlags): AgentToolGate {
  const { intent, taskStage } = reasoning;

  // Read-only for inspect/read/search/review
  if (["inspect", "read", "search"].includes(intent) || vetoFlags.editVetoed) {
    return { level: "READ_ONLY", blockedTools: ["file_write", "file_edit", "git_ops"], verifierBudget: 0 };
  }

  // Limited for underspecified
  if (taskStage === "underspecified") {
    return { level: "LIMITED", blockedTools: ["file_write", "git_ops"], verifierBudget: 3 };
  }

  // Full for everything else
  return { level: "FULL", blockedTools: [], verifierBudget: 10 };
}

// ─── ResponsePressure ───

function deriveResponsePressure(
  reasoning: AgentReasoningResult,
  affordance: AgentAffordanceVector,
  mode: InteractionMode,
  codeQuality: AgentCodeQualityPolicy,
): AgentPressureDecision {
  // Code generation → always assertive
  if (codeQuality.isCodeTask && codeQuality.strictMode) {
    return { pressure: "ASSERTIVE", momentum: "HIGH" };
  }
  // CHAT mode → gentle
  if (mode === "CHAT") {
    return { pressure: "GENTLE", momentum: "LOW" };
  }
  // Underspecified → gentle
  if (reasoning.taskStage === "underspecified") {
    return { pressure: "GENTLE", momentum: "LOW" };
  }
  // Compute momentum from affordance
  const momentumScore = affordance.edit_now * 0.5 + affordance.run_checks * 0.3 + (1 - affordance.finalize) * 0.2;
  const momentum: AgentPressureDecision["momentum"] = momentumScore > 0.65 ? "HIGH" : momentumScore > 0.35 ? "MEDIUM" : "LOW";
  const pressure: AgentPressureDecision["pressure"] = momentum === "HIGH" ? "ASSERTIVE" : "NEUTRAL";
  return { pressure, momentum };
}

// ─── ContinuityCapsule ───

function deriveContinuityCapsule(continuation: AgentTaskContinuation): AgentContinuityCapsule {
  if (!continuation.isContinuation) {
    return { enabled: false, rules: [] };
  }
  const rules = [
    "This is a continuation of a previous task. Do not start over.",
    "Do not ask 'what would you like me to do?' — the task is already defined.",
  ];
  if (continuation.carryover.prevIntent) {
    rules.push(`Previous intent was: ${continuation.carryover.prevIntent}. Continue in that direction.`);
  }
  if (continuation.carryover.modifiedFiles.length > 0) {
    rules.push(`Previously modified files: ${continuation.carryover.modifiedFiles.join(", ")}. Build on these changes.`);
  }
  return { enabled: true, rules };
}

// ─── StyleHint ───

function deriveStyleHint(message: string): AgentStyleHint {
  const hasKorean = /[가-힣]/.test(message);
  const hasEnglish = /[a-zA-Z]{3,}/.test(message);
  const hasSlang = /ㅋㅋ|ㅎㅎ|ㅇㅇ|ㄱㄱ|ㅅㅂ|lol|lmao|haha/i.test(message);
  const isFormal = /please|부탁|감사|요청|확인 부탁/i.test(message);
  const isShort = message.trim().length < 20;

  return {
    formality: hasSlang ? "casual" : isFormal ? "formal" : "neutral",
    language: hasKorean && hasEnglish ? "mixed" : hasKorean ? "ko" : "en",
    brevity: isShort ? "terse" : "normal",
  };
}

// ─── Main Orchestrator ───

/**
 * Single entry point for the Agent Decision Engine.
 * Called once per user message. Produces an immutable `AgentDecisionContext`.
 *
 * Pipeline:
 *   agentReason → computeAgentAffordance → deriveComputePolicy →
 *   estimateFailureSurface → computeVetoFlags → deriveToolBudget →
 *   deriveMemoryIntent → detectTaskContinuation → deriveMicroPlan → deepFreeze
 *
 * Supports recoveryHint (GPT QA #8): if provided, adjusts the reasoning stage.
 */
export function agentDecide(input: {
  message: string;
  projectContext?: AgentProjectContext;
  prevDecision?: AgentDecisionContext;
  recoveryHint?: RecoveryHint;
}): AgentDecisionContext {
  const { message, projectContext, prevDecision, recoveryHint } = input;

  // Step 1: Reasoning (pure heuristic, NO LLM)
  const reasoning = agentReason(message, projectContext);

  // Apply recovery hint stage override if present (GPT QA #18)
  if (recoveryHint?.stageHint) {
    (reasoning as { taskStage: string }).taskStage = recoveryHint.stageHint;
  }

  // Step 2: Affordance (pure math) + stuck breaker
  let repeatCount = 0;
  if (prevDecision) {
    const prev = prevDecision.core.reasoning;
    if (prev.intent === reasoning.intent && prev.taskStage === reasoning.taskStage) {
      repeatCount = prevDecision.meta.repeatCount + 1;
    }
  }
  let affordance = computeAgentAffordance(reasoning, prevDecision?.core.affordance);
  if (repeatCount >= 3) {
    affordance = applyStuckBreaker(affordance, repeatCount);
  }

  // Step 3: Compute Policy (complexity → budget table)
  const computePolicy = deriveComputePolicy(reasoning);

  // Step 4: Failure Surface (intent × complexity × project context)
  const failureSurface = estimateFailureSurface(reasoning, projectContext);

  // Step 5: Tool Budget (complexity × affordance)
  const toolBudget = deriveToolBudget(reasoning, affordance);

  // Step 6: Plan required (GPT QA #4 — not just complexity, also intent/stage/surface)
  const planRequired =
    reasoning.complexity === "complex" || reasoning.complexity === "massive" ||
    reasoning.intent === "plan" || reasoning.intent === "refactor" ||
    reasoning.taskStage === "underspecified" || reasoning.taskStage === "blocked" ||
    failureSurface.blastRadius >= 0.6 ||
    (affordance.run_checks > 0.7 && reasoning.complexity !== "trivial");

  // Update veto with final planRequired
  const vetoFlags = computeVetoFlags(failureSurface, planRequired);

  // Step 8: Next action (GPT QA #5 — clarify path)
  let nextAction: AgentNextAction = "proceed";
  let clarification: ClarificationRequest | undefined;

  if (vetoFlags.clarifyForced || (reasoning.taskStage === "underspecified" && reasoning.confidence < 0.4)) {
    nextAction = "ask_user";
    clarification = {
      reason: `Task is ${reasoning.taskStage} with confidence ${reasoning.confidence}`,
      missingFields: reasoning.taskStage === "underspecified"
        ? ["specific files", "expected behavior"]
        : [],
      suggestedOptions: [],
      allowProceedWithAssumptions: reasoning.confidence > 0.25,
    };
  }

  // Blocked stage → blocked_external (QA #10)
  if (reasoning.taskStage === "blocked" && nextAction === "proceed") {
    nextAction = "blocked_external";
  }

  // Recovery hint may force ask_user
  if (recoveryHint?.action === "ask_user") {
    nextAction = "ask_user";
    if (!clarification) {
      clarification = {
        reason: recoveryHint.reason,
        missingFields: [],
        suggestedOptions: [],
        allowProceedWithAssumptions: false,
      };
    }
  }

  // Step 9: Execution strategy
  const scanBreadth: "narrow" | "normal" | "wide" =
    reasoning.complexity === "massive" ? "wide"
    : reasoning.complexity === "complex" ? "normal"
    : "narrow";

  // Step 10: Verify depth (GPT QA #14 — finalize guard)
  let verifyDepth: "skip" | "quick" | "thorough" =
    affordance.run_checks > 0.6 ? "thorough"
    : affordance.run_checks > 0.3 ? "quick"
    : "skip";

  // verifyRequired veto: minimum quick
  if (vetoFlags.verifyRequired && verifyDepth === "skip") {
    verifyDepth = "quick";
  }

  // Affordance finalize guard (GPT QA #14): verify not run → cap finalize
  if (verifyDepth !== "skip") {
    affordance.finalize = Math.min(affordance.finalize, 0.25);
  }
  if (vetoFlags.finalizeBlocked) {
    affordance.finalize = Math.min(affordance.finalize, 0.1);
  }

  // Step 11: Continuation detection
  const continuation = detectTaskContinuation(message, prevDecision);

  // Continuation adjustments (§14.4)
  if (continuation.isContinuation) {
    affordance.inspect_more = clamp01(affordance.inspect_more * 0.5);
    affordance.edit_now = clamp01(affordance.edit_now * 1.3);
    affordance.explain_plan = clamp01(affordance.explain_plan * 0.3);

    // Previous failures increase patch risk
    if (continuation.carryover.failedAttempts.length > 0) {
      failureSurface.patchRisk = clamp01(failureSurface.patchRisk * 1.3);
      // Recompute veto flags after failureSurface mutation (QA fix #2)
      Object.assign(vetoFlags, computeVetoFlags(failureSurface, planRequired));
    }
  }

  // Step 12: Memory intent
  const memoryIntent = deriveMemoryIntent(reasoning);

  // Step 13: MicroPlan (GPT QA #13 — disabled for ask_user/blocked_external)
  const resolvedAction: AgentNextAction = nextAction;
  const microPlan: string[] | undefined =
    resolvedAction === "proceed"
      ? deriveMicroPlan(reasoning.nextAnchors)
      : undefined;

  // Step 14: InteractionMode (Dual-Mode)
  const interactionMode = deriveInteractionMode(reasoning);

  // Step 15: SubAgent Plan & Skill Activation (Phase I SSOT)
  const subAgentPlan = deriveSubAgentPlan(reasoning);
  const skillActivation = deriveSkillActivation(reasoning);

  // Step 15b: Persona Hint & Memory Load (Phase I+ SSOT)
  const personaHint = derivePersonaHint(message);
  const memoryLoad = deriveMemoryLoad(reasoning);

  // Step 15c: Code Quality Policy (deterministic, no LLM)
  const codeQuality = deriveCodeQualityPolicy(reasoning);

  // Step 15d: LeadHint, ResponseHint, ToolGate, ResponsePressure, ContinuityCapsule, StyleHint
  const leadHint = deriveLeadHint(reasoning, interactionMode);
  const responseHint = deriveResponseHint(reasoning, interactionMode);
  const toolGate = deriveToolGate(reasoning, vetoFlags);
  const pressureDecision = deriveResponsePressure(reasoning, affordance, interactionMode, codeQuality);
  const continuityCapsule = deriveContinuityCapsule(continuation);
  const styleHint = deriveStyleHint(message);

  // Step 16: Assemble core (GPT QA #2 — core vs meta separation)
  const core: AgentDecisionCore = {
    reasoning,
    affordance,
    computePolicy,
    failureSurface,
    vetoFlags,
    toolBudget,
    nextAction,
    clarification,
    planRequired,
    scanBreadth,
    verifyDepth,
    memoryIntent,
    continuation,
    microPlan,
    interactionMode,
    subAgentPlan,
    skillActivation,
    personaHint,
    memoryLoad,
    codeQuality,
    leadHint,
    responseHint,
    toolGate,
    pressureDecision,
    continuityCapsule,
    styleHint,
  };

  // Step 17: Deep freeze and return (GPT QA #1)
  return deepFreeze({
    core,
    meta: {
      sessionId: randomUUID(),
      createdAt: Date.now(),
      repeatCount,
    },
  });
}

// ─── DEFAULT_DECISION ───

/**
 * Safe default decision — used when agentDecide() fails or is skipped.
 * Trivial/CHAT/proceed = most conservative, safest behavior.
 * This ensures Decision is NEVER null in the pipeline.
 */
export const DEFAULT_DECISION: AgentDecisionContext = deepFreeze({
  core: {
    reasoning: {
      intent: "inspect" as const,
      taskStage: "ready" as const,
      complexity: "simple" as const,
      confidence: 0.5,
      depthHint: "shallow" as const,
      cognitiveLoad: "low" as const,
      nextAnchors: ["SEARCH_REPO" as const, "READ_FILES" as const],
    },
    affordance: {
      explain_plan: 0.3,
      inspect_more: 0.5,
      edit_now: 0.3,
      run_checks: 0.3,
      finalize: 0.3,
    },
    computePolicy: {
      maxIterations: 15,
      maxTokenBudget: 50_000,
      modelTier: "standard" as const,
      parallelAgents: 0,
    },
    failureSurface: {
      patchRisk: 0.1,
      buildRisk: 0.1,
      testRisk: 0.1,
      blastRadius: 0.1,
      ambiguityRisk: 0.2,
    },
    vetoFlags: {
      editVetoed: false,
      verifyRequired: false,
      clarifyForced: false,
      finalizeBlocked: false,
    },
    toolBudget: {
      maxFileReads: 8,
      maxEdits: 4,
      maxShellExecs: 3,
      maxTestRuns: 2,
      maxSearches: 8,
      maxWebLookups: 1,
      shellCostUnits: 10,
      maxSameFileEdits: 5,
    },
    nextAction: "proceed" as const,
    clarification: undefined,
    planRequired: false,
    scanBreadth: "narrow" as const,
    verifyDepth: "skip" as const,
    memoryIntent: { shouldSave: false, categories: [] as AgentMemoryCategory[], priority: "low" as const, target: "local" as const },
    continuation: { isContinuation: false, continuityScore: 0, carryover: { modifiedFiles: [] as string[], failedAttempts: [] as string[] } },
    microPlan: undefined,
    interactionMode: "CHAT" as const,
    subAgentPlan: { enabled: false, maxAgents: 0, roles: [] as SubAgentRole[], strategy: "sequential" as const },
    skillActivation: { enableToolPlanning: false, enableSkillLearning: true, enablePlugins: true, enableSpecialist: false, specialistDomain: undefined },
    personaHint: { tone: "casual" as const, language: "auto" as const },
    memoryLoad: { shouldLoad: true, categories: ["project_rule"] as AgentMemoryCategory[] },
    codeQuality: { isCodeTask: false, codeTaskType: "none" as const, primaryRisk: "none" as const, constraints: [] as string[], strictMode: false, preEditVerify: false },
    leadHint: "NONE" as const,
    responseHint: { structure: "direct_answer" as const, expansion: "soft" as const, forbid: { metaComment: false, narration: false, apology: true } },
    toolGate: { level: "FULL" as const, blockedTools: [] as string[], verifierBudget: 10 },
    pressureDecision: { pressure: "NEUTRAL" as const, momentum: "LOW" as const },
    continuityCapsule: { enabled: false, rules: [] as string[] },
    styleHint: { formality: "neutral" as const, language: "en" as const, brevity: "normal" as const },
  },
  meta: {
    sessionId: "default",
    createdAt: 0,
    repeatCount: 0,
  },
}) as AgentDecisionContext;

// ─── WorldState → ProjectContext Converter ───

/**
 * Convert a WorldStateSnapshot into AgentProjectContext for Decision Engine input.
 * This bridges the gap between runtime world state and decision-time project context.
 */
export function worldStateToProjectContext(
  ws: import("./world-state.js").WorldStateSnapshot,
): AgentProjectContext {
  return {
    hasTests: ws.test.testRunner !== "unknown",
    fileCount: ws.files.totalFiles,
    language: "typescript",
    repoIndexed: true,
    monorepo: false,
    packageManager: ws.deps.packageManager !== "unknown" ? ws.deps.packageManager : undefined,
    testFrameworkPresent: ws.test.testRunner !== "unknown",
    dirtyWorkingTree: ws.git.uncommittedFiles.length > 0,
    currentBranchProtected: ws.git.branch === "main" || ws.git.branch === "master",
    recentFailureCount: ws.test.failingTests.length + ws.errors.recentRuntimeErrors.length,
    changedFilesCount: ws.files.recentlyChanged.length,
    hasBuildErrors: ws.build.lastResult === "fail",
    hasConflicts: ws.git.hasConflicts,
    missingDeps: ws.deps.missing.length > 0,
    buildTool: ws.build.buildTool !== "unknown" ? ws.build.buildTool : undefined,
    testRunner: ws.test.testRunner !== "unknown" ? ws.test.testRunner : undefined,
  };
}
