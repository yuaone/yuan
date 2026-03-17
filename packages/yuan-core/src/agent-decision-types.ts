/**
 * @module agent-decision-types
 * @description Type definitions for the YUAN Agent Decision Engine.
 * All types are defined here as SSOT — no duplication across modules.
 *
 * Ported from YUA Decision Orchestrator types into coding-agent domain.
 */

import type { SubAgentRole } from "./sub-agent-prompts.js";

// ─── Intent & Stage ───

/** Coding agent task intent (9 variants) */
export type AgentIntent =
  | "inspect"    // code exploration/understanding
  | "plan"       // design/architecture
  | "search"     // repo search/file finding
  | "read"       // file reading/analysis
  | "edit"       // code modification/creation
  | "test"       // test execution/writing
  | "verify"     // build/type-check verification
  | "refactor"   // refactoring
  | "fix";       // bug fixing

/** User's task readiness stage */
export type AgentTaskStage =
  | "underspecified"  // requirements unclear
  | "ready"           // ready to execute
  | "blocked"         // blocked by external factor
  | "iterating";      // iterative correction in progress

/** Task complexity */
export type AgentComplexity =
  | "trivial"   // 1-2 line change
  | "simple"    // single file
  | "moderate"  // 2-5 files
  | "complex"   // multi-file + tests
  | "massive";  // architecture-level change

/** Next execution direction hint */
export type AgentFlowAnchor =
  | "SEARCH_REPO"       // explore repo structure
  | "READ_FILES"        // read related files
  | "PREPARE_PATCH"     // prepare patch
  | "RUN_TESTS"         // run tests
  | "VERIFY_RESULT"     // verify result
  | "SUMMARIZE_CHANGE"; // summarize changes

/** Intent family for downstream branching (GPT QA #11) */
export type IntentFamily = "explore" | "modify" | "validate";

/** Decision Engine이 결정하는 실행 모드 */
export type InteractionMode =
  | "CHAT"    // 대화형: AgentLoop만, plan/verify 스킵, 빠른 응답
  | "AGENT"   // 코딩 에이전트: ExecutionEngine 풀 가동
  | "HYBRID"; // 중간: AgentLoop + 선택적 verify

export const INTENT_FAMILY: Record<AgentIntent, IntentFamily> = {
  inspect: "explore",
  read: "explore",
  search: "explore",
  plan: "explore",
  edit: "modify",
  refactor: "modify",
  fix: "modify",
  test: "validate",
  verify: "validate",
};

// ─── Reasoning Result ───

export interface AgentReasoningResult {
  intent: AgentIntent;
  taskStage: AgentTaskStage;
  complexity: AgentComplexity;
  confidence: number;             // 0~1, clamped to 0.85 max
  depthHint: "shallow" | "normal" | "deep";
  cognitiveLoad: "low" | "medium" | "high";
  nextAnchors: AgentFlowAnchor[]; // 1~3 items, never empty
}

// ─── Affordance Vector ───

/** 5D execution-tendency vector (not response style) */
export interface AgentAffordanceVector {
  explain_plan: number;   // 0~1: explain plan before executing
  inspect_more: number;   // 0~1: explore more vs proceed
  edit_now: number;       // 0~1: edit immediately vs analyze
  run_checks: number;     // 0~1: verify first vs move fast
  finalize: number;       // 0~1: wrap up vs continue working
}

// ─── Compute Policy ───

export interface AgentComputePolicy {
  maxIterations: number;
  maxTokenBudget: number;
  modelTier: "fast" | "standard" | "deep";
  parallelAgents: number;
}

// ─── Next Action (GPT QA #5) ───

/** Decision-determined next action mode */
export type AgentNextAction =
  | "proceed"            // normal execution
  | "ask_user"           // ask user (edit forbidden)
  | "blocked_external";  // blocked by external dependency

/** Structured clarification request for ask_user */
export interface ClarificationRequest {
  reason: string;
  missingFields: string[];
  suggestedOptions: string[];
  allowProceedWithAssumptions: boolean;
}

// ─── Failure Surface ───

export interface AgentFailureSurface {
  patchRisk: number;      // 0~1: code change risk
  buildRisk: number;      // 0~1: build breakage risk
  testRisk: number;       // 0~1: test failure risk
  blastRadius: number;    // 0~1: impact scope (file count based)
  ambiguityRisk: number;  // 0~1: requirement ambiguity
}

// ─── Veto Flags (GPT QA #6) ───

export interface AgentVetoFlags {
  /** patchRisk >= 0.8 and no plan -> direct edit forbidden */
  editVetoed: boolean;
  /** blastRadius >= 0.6 -> verifyDepth minimum quick */
  verifyRequired: boolean;
  /** ambiguityRisk >= 0.7 -> ask_user forced */
  clarifyForced: boolean;
  /** buildRisk >= 0.7 -> finalize forbidden, verify required */
  finalizeBlocked: boolean;
}

// ─── Tool Budget ───

export interface AgentToolBudget {
  // Count budgets
  maxFileReads: number;
  maxEdits: number;
  maxShellExecs: number;
  maxTestRuns: number;
  maxSearches: number;
  maxWebLookups: number;

  // Cost budgets (GPT QA #7)
  shellCostUnits: number;   // lightweight=1, heavyweight(test/build)=3
  maxSameFileEdits: number; // same-file edit cap (GPT QA #8 — patch churn prevention)
}

/** Budget enforcement mode (GPT QA #9) */
export type BudgetEnforcementMode =
  | "soft"    // system message warning at 80%
  | "hard";   // tool-router blocks + synthetic error at 100%

// ─── Memory Intent ───

export type AgentMemoryCategory =
  | "tool_pattern"
  | "error_pattern"
  | "project_rule"
  | "file_structure"
  | "user_preference"
  | "failure_avoidance";

export interface AgentMemoryIntent {
  shouldSave: boolean;
  categories: AgentMemoryCategory[];
  priority: "low" | "normal" | "high";
  target: "local" | "backend" | "both";
}

// ─── Task Continuation ───

export interface AgentTaskContinuation {
  isContinuation: boolean;
  continuityScore: number;
  carryover: {
    modifiedFiles: string[];
    failedAttempts: string[];
    prevIntent?: AgentIntent;
    prevStage?: AgentTaskStage;
  };
}

// ─── Project Context (GPT QA #21) ───

export interface AgentProjectContext {
  hasTests: boolean;
  fileCount: number;
  language: string;
  repoIndexed: boolean;
  monorepo: boolean;
  packageManager?: string;
  testFrameworkPresent: boolean;
  dirtyWorkingTree: boolean;
  currentBranchProtected: boolean;
  recentFailureCount: number;
  changedFilesCount: number;
  // WorldState 강화 필드
  hasBuildErrors: boolean;
  hasConflicts: boolean;
  missingDeps: boolean;
  buildTool?: string;
  testRunner?: string;
  // Codebase complexity (from CodebaseContext.getStats)
  avgCyclomaticComplexity?: number;
  avgCognitiveComplexity?: number;
  maxFileComplexity?: number;
  avgLoc?: number;
}

// ─── Recovery Hint (GPT QA #18) ───

/** FailureRecovery provides this hint — does NOT regenerate decision */
export interface RecoveryHint {
  action: "retry" | "rollback" | "skip" | "ask_user" | "alternative_approach";
  reason: string;
  /** Stage hint for next run (replaces prevDecision stage) */
  stageHint?: AgentTaskStage;
}

// ─── Sub-Agent Orchestration Plan ───

/** Sub-agent orchestration plan — Decision determines WHAT agents to use */
export interface AgentSubAgentPlan {
  /** Whether to use sub-agents at all */
  enabled: boolean;
  /** Maximum concurrent agents */
  maxAgents: number;
  /** Which roles to activate (from existing SubAgentRole type) */
  roles: SubAgentRole[];
  /** Execution strategy */
  strategy: "parallel" | "sequential" | "pipeline";
}

// ─── Skill/Plugin Activation ───

/** Skill/Plugin activation — Decision determines WHAT to enable */
export interface AgentSkillActivation {
  /** Enable ToolPlanner (tool sequence optimization) */
  enableToolPlanning: boolean;
  /** Enable SkillLearner (learn from execution patterns) */
  enableSkillLearning: boolean;
  /** Enable plugin system */
  enablePlugins: boolean;
  /** Enable specialist routing */
  enableSpecialist: boolean;
  /** Specialist domain (if detected from intent) */
  specialistDomain?: string;
}

// ─── Persona Hint ───

/** Persona/tone hint — Decision determines communication style */
export interface AgentPersonaHint {
  /** Tone for responses */
  tone: "casual" | "professional" | "technical" | "friendly";
  /** Preferred language */
  language: "ko" | "en" | "auto";
}

// ─── LeadHint ───

/** Direction strength for the agent's response */
export type AgentLeadHint = "NONE" | "SOFT" | "HARD";

// ─── ResponseHint (coding agent version) ───

/** Structured output guidance — determines response format and forbidden patterns */
export interface AgentResponseHint {
  structure: "direct_answer" | "problem_solution" | "stepwise_explanation" | "code_first";
  expansion: "none" | "soft" | "guided" | "full";
  forbid: {
    metaComment: boolean;  // "설명해보면", "정리하면" 금지
    narration: boolean;    // 상태/진행 발언 금지 (tool narration은 별도)
    apology: boolean;      // "죄송합니다" 금지
  };
}

// ─── ToolGate (coding agent version) ───

/** Tool access level — determines which tools are available */
export type AgentToolLevel = "FULL" | "LIMITED" | "READ_ONLY";

/** Tool gate — controls tool access based on intent/risk */
export interface AgentToolGate {
  level: AgentToolLevel;
  blockedTools: string[];
  verifierBudget: number;  // how many tool calls before forcing verification
}

// ─── ResponsePressure (coding agent version) ───

/** Execution pressure — how assertively the agent pushes forward */
export type AgentResponsePressure = "GENTLE" | "NEUTRAL" | "ASSERTIVE";

/** Pressure + momentum combined decision */
export interface AgentPressureDecision {
  pressure: AgentResponsePressure;
  momentum: "LOW" | "MEDIUM" | "HIGH";
}

// ─── ContinuityCapsule (coding agent version) ───

/** Continuation context capsule — injected when resuming a previous task */
export interface AgentContinuityCapsule {
  enabled: boolean;
  summary?: string;
  rules: string[];
}

// ─── StyleHint (tone tracking) ───

/** Fine-grained style tracking derived from user message */
export interface AgentStyleHint {
  formality: "casual" | "neutral" | "formal";
  language: "ko" | "en" | "mixed";
  brevity: "terse" | "normal" | "verbose";
}

// ─── Memory Load ───

/** Memory load decision — what to load at init */
export interface AgentMemoryLoad {
  /** Whether to load memory at all */
  shouldLoad: boolean;
  /** Which categories to prioritize */
  categories: AgentMemoryCategory[];
}

// ─── Code Quality Policy ───

/** Code quality enforcement policy — set by Decision, consumed by PromptRuntime + AgentLoop */
export interface AgentCodeQualityPolicy {
  /** Whether this task involves code modification */
  isCodeTask: boolean;
  /** Code task subtype */
  codeTaskType: "generation" | "fix" | "refactor" | "review" | "test" | "none";
  /** Primary risk category */
  primaryRisk: "extension_pain" | "type_safety" | "async_race" | "state_corruption" | "blast_radius" | "none";
  /** Quality constraints injected into prompt */
  constraints: string[];
  /** Whether to enforce strict mode (no TODO/stub/placeholder) */
  strictMode: boolean;
  /** Pre-edit verification required */
  preEditVerify: boolean;
}

// ─── Decision Context (SSOT) ───

/** Deterministic core — same input yields same result */
export interface AgentDecisionCore {
  readonly reasoning: AgentReasoningResult;
  readonly affordance: AgentAffordanceVector;
  readonly computePolicy: AgentComputePolicy;
  readonly failureSurface: AgentFailureSurface;
  readonly vetoFlags: AgentVetoFlags;
  readonly toolBudget: AgentToolBudget;
  readonly nextAction: AgentNextAction;
  readonly clarification?: ClarificationRequest;
  readonly planRequired: boolean;
  readonly scanBreadth: "narrow" | "normal" | "wide";
  readonly verifyDepth: "skip" | "quick" | "thorough";
  readonly memoryIntent: AgentMemoryIntent;
  readonly continuation: AgentTaskContinuation;
  readonly microPlan?: readonly string[];
  readonly interactionMode: InteractionMode;
  readonly subAgentPlan: AgentSubAgentPlan;
  readonly skillActivation: AgentSkillActivation;
  readonly personaHint: AgentPersonaHint;
  readonly memoryLoad: AgentMemoryLoad;
  readonly codeQuality: AgentCodeQualityPolicy;
  readonly leadHint: AgentLeadHint;
  readonly responseHint: AgentResponseHint;
  readonly toolGate: AgentToolGate;
  readonly pressureDecision: AgentPressureDecision;
  readonly continuityCapsule: AgentContinuityCapsule;
  readonly styleHint: AgentStyleHint;
}

/** Runtime metadata — excluded from determinism verification (GPT QA #2) */
export interface AgentDecisionMeta {
  readonly sessionId: string;
  readonly createdAt: number;
  /** Consecutive same-intent+stage count (for stuck breaker) */
  readonly repeatCount: number;
}

/** Final SSOT — deep-frozen, immutable after creation (GPT QA #1) */
export interface AgentDecisionContext {
  readonly core: AgentDecisionCore;
  readonly meta: AgentDecisionMeta;
}
