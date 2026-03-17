/**
 * @module agent-reasoning-engine
 * @description Pure heuristic reasoning engine for the Agent Decision Engine.
 *
 * **NO LLM, NO async, pure functions.**
 * Same input always yields same output (deterministic).
 * Confidence capped at 0.85 (anti-overconfidence, YUA formula).
 *
 * Design spec: docs/superpowers/specs/2026-03-17-yuan-agent-decision-engine-design.md, sections 4.1-4.6
 */

import type {
  AgentIntent,
  AgentTaskStage,
  AgentComplexity,
  AgentFlowAnchor,
  AgentReasoningResult,
  AgentProjectContext,
} from "./agent-decision-types.js";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Clamp a number to [0, 1]. */
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Sanitize user input before reasoning (YUA AOSS Lite pattern).
 * Masks personal information but preserves code content.
 * Does NOT block — just cleans sensitive data.
 */
export function sanitizeForReasoning(input: string): string {
  return input
    // Korean phone numbers: 010-1234-5678
    .replace(/\d{2,3}-\d{3,4}-\d{4}/g, "***-****-****")
    // Email addresses
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[email]")
    // Password mentions (mask the value, not the keyword)
    .replace(/(password|passwd|비밀번호|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[masked]")
    // Credit card patterns
    .replace(/\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}/g, "****-****-****-****")
    // Korean resident registration number
    .replace(/\d{6}-[1-4]\d{6}/g, "******-*******");
}

/**
 * Smooth confidence damping above a clip threshold.
 * YUA pipeline-lite: stability/overconfidence.ts
 * Instead of hard-clamping at 0.85, excess is dampened: clip + excess/(1+k*excess)
 * This produces a natural asymptotic curve instead of a hard ceiling.
 */
function suppressOverconfidence(p: number, clip = 0.85, k = 8): number {
  if (p <= clip) return p;
  const excess = p - clip;
  return clip + excess / (1 + k * excess);
}

// ────────────────────────────────────────────────────────────────────────────
// Pattern Rule
// ────────────────────────────────────────────────────────────────────────────

interface PatternRule<K extends string> {
  key: K;
  weight: number;
  patterns: RegExp[];
}

// ────────────────────────────────────────────────────────────────────────────
// Intent Classification (9 intents, Korean + English patterns)
// ────────────────────────────────────────────────────────────────────────────

const INTENT_RULES: PatternRule<AgentIntent>[] = [
  {
    key: "fix",
    weight: 1.8,
    patterns: [
      /(에러|오류|버그|깨짐|안됨|crash|error|fix|broken|failing)/i,
      /(고쳐|수정해|해결해|fix\s+this|debug)/i,
    ],
  },
  {
    key: "refactor",
    weight: 1.6,
    patterns: [
      /(리팩토링|리팩터|refactor|cleanup|clean up|정리|개선)/i,
      /(추출|extract|분리|decouple|simplify)/i,
    ],
  },
  {
    key: "plan",
    weight: 1.5,
    patterns: [
      /(설계|구조|아키텍처|architecture|design|패턴|스펙)/i,
      /(어떻게\s+(구현|설계|구조)|방법|전략)/i,
    ],
  },
  {
    key: "edit",
    weight: 1.4,
    patterns: [
      /(만들어|추가|생성|작성|구현|넣어|create|add|implement|write)/i,
      /(변경|바꿔|modify|change|update)/i,
    ],
  },
  {
    key: "test",
    weight: 1.4,
    patterns: [
      /(테스트|test|spec|jest|vitest|검증|확인해)/i,
    ],
  },
  {
    key: "verify",
    weight: 1.3,
    patterns: [
      /(빌드|build|compile|tsc|타입체크|lint)/i,
    ],
  },
  {
    key: "search",
    weight: 1.2,
    patterns: [
      /(찾아|검색|어디|grep|find|locate|where)/i,
    ],
  },
  {
    key: "read",
    weight: 1.1,
    patterns: [
      /(봐|읽어|보여|분석|explain|show|read|analyze|what does)/i,
    ],
  },
  {
    key: "inspect",
    weight: 1.0,
    patterns: [
      /(살펴|확인|check|look|review|scan)/i,
      /\?$/,  // ends with question mark
    ],
  },
];

// ────────────────────────────────────────────────────────────────────────────
// Task Stage Classification (4 stages)
// ────────────────────────────────────────────────────────────────────────────

const STAGE_RULES: PatternRule<AgentTaskStage>[] = [
  {
    key: "underspecified",
    weight: 1.6,
    patterns: [
      /(뭔가|대충|적당히|알아서|좀|somehow|maybe|something)/i,
      /(모르겠|헷갈|unclear|not sure|vague)/i,
    ],
  },
  {
    key: "blocked",
    weight: 1.5,
    patterns: [
      /(안 돼|안됨|막혀|stuck|blocked|can't|cannot|impossible)/i,
      /(에러가 계속|keeps failing|infinite loop)/i,
    ],
  },
  {
    key: "iterating",
    weight: 1.4,
    patterns: [
      /(다시|또|반복|여전히|still|again|retry|계속)/i,
      /(아까|이전|before|earlier|last time)/i,
    ],
  },
  {
    key: "ready",
    weight: 1.2,
    patterns: [
      /(이제|바로|ㄱㄱ|진행|시작|go|start|do it|해줘|해라)/i,
      /(구현해|만들어|적용해|implement|create|apply)/i,
    ],
  },
];

// ────────────────────────────────────────────────────────────────────────────
// Score-by-rules + pick-top (YUA ReasoningEngine pattern)
// ────────────────────────────────────────────────────────────────────────────

interface ScoreResult<K extends string> {
  key: K;
  score: number;
  secondBest: number;
  evidenceCount: number;
}

/**
 * Score all rules against the input and pick the highest.
 * Returns the winning key, its score, the second-best score, and total evidence count.
 */
function scoreByRules<K extends string>(
  message: string,
  rules: PatternRule<K>[],
  defaultKey: K,
): ScoreResult<K> {
  const scores = new Map<K, number>();
  const evidence = new Map<K, number>();

  for (const rule of rules) {
    let hitCount = 0;
    for (const pattern of rule.patterns) {
      if (pattern.test(message)) hitCount++;
    }
    if (hitCount > 0) {
      const prev = scores.get(rule.key) ?? 0;
      scores.set(rule.key, prev + rule.weight * Math.min(hitCount, 3));
      evidence.set(rule.key, (evidence.get(rule.key) ?? 0) + hitCount);
    }
  }

  let bestKey = defaultKey;
  let bestScore = 0;
  let secondBest = 0;
  let totalEvidence = 0;

  for (const [key, score] of scores) {
    totalEvidence += evidence.get(key) ?? 0;
    if (score > bestScore) {
      secondBest = bestScore;
      bestScore = score;
      bestKey = key;
    } else if (score > secondBest) {
      secondBest = score;
    }
  }

  return { key: bestKey, score: bestScore, secondBest, evidenceCount: totalEvidence };
}

// ────────────────────────────────────────────────────────────────────────────
// Complexity Computation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compute task complexity from message text and optional project context.
 * Absorbs the old `detectComplexityHeuristic()` logic.
 */
function computeComplexity(
  message: string,
  projectContext?: AgentProjectContext,
): AgentComplexity {
  let score = 0;
  const lower = message.toLowerCase();
  const len = message.length;

  // Length-based
  if (len > 500) score += 2;
  else if (len > 200) score += 1;

  // File extension mentions
  const fileCount = (lower.match(/\.(ts|js|tsx|jsx|py|go|rs|java|css|html)/g) ?? []).length;
  score += Math.min(fileCount, 4);

  // Complexity keywords
  if (/(architecture|아키텍처|설계|system|전체|all files)/i.test(lower)) score += 3;
  if (/(refactor|리팩토링|migration|마이그레이션)/i.test(lower)) score += 2;
  if (/(test|테스트|spec)/i.test(lower)) score += 1;
  if (/(simple|간단|just|only|딱)/i.test(lower)) score -= 1;

  // Multi-task markers
  const taskMarkers = lower.match(/(그리고|and then|또한|also|다음에|then)/gi) ?? [];
  score += taskMarkers.length;

  // Project context boost
  if (projectContext) {
    if (projectContext.monorepo) score += 1;
    if (projectContext.fileCount > 500) score += 1;
    if (projectContext.recentFailureCount > 2) score += 1;
  }

  if (score <= 0) return "trivial";
  if (score <= 2) return "simple";
  if (score <= 5) return "moderate";
  if (score <= 8) return "complex";
  return "massive";
}

// ────────────────────────────────────────────────────────────────────────────
// Confidence Computation (YUA formula)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compute confidence with YUA formula.
 * 0.25 + 0.35*lenScore + 0.25*evScore + 0.25*gapScore + stageBias
 * Capped at 0.85 (anti-overconfidence).
 */
function computeConfidence(params: {
  inputLen: number;
  evidenceCount: number;
  topGap: number;
  stage: AgentTaskStage;
}): number {
  const { inputLen, evidenceCount, topGap, stage } = params;

  const lenScore = clamp01(inputLen / 80);
  const evScore = clamp01(evidenceCount / 6);
  const gapScore = clamp01(topGap / 2.5);

  const stageBias =
    stage === "ready" ? 0.12
    : stage === "underspecified" ? -0.12
    : stage === "blocked" ? -0.08
    : stage === "iterating" ? -0.06
    : 0.04;

  const raw = 0.25 + 0.35 * lenScore + 0.25 * evScore + 0.25 * gapScore + stageBias;
  // YUA suppressOverconfidence: smooth damping above clip instead of hard clamp
  return Number(suppressOverconfidence(clamp01(raw), 0.85, 8).toFixed(2));
}

// ────────────────────────────────────────────────────────────────────────────
// Cognitive Load Estimation
// ────────────────────────────────────────────────────────────────────────────

/** Estimate cognitive load from message character length. */
function estimateCognitiveLoad(charLen: number): "low" | "medium" | "high" {
  if (charLen < 40) return "low";
  if (charLen < 200) return "medium";
  return "high";
}

// ────────────────────────────────────────────────────────────────────────────
// Depth Hint Estimation
// ────────────────────────────────────────────────────────────────────────────

/** Derive depth hint from intent, stage, and complexity. */
function estimateDepthHint(
  intent: AgentIntent,
  stage: AgentTaskStage,
  complexity: AgentComplexity,
): "shallow" | "normal" | "deep" {
  // Exploration intents are shallow unless complex
  if (
    (intent === "inspect" || intent === "read" || intent === "search") &&
    complexity !== "complex" &&
    complexity !== "massive"
  ) {
    return "shallow";
  }

  // Underspecified / trivial => shallow
  if (stage === "underspecified" || complexity === "trivial") return "shallow";

  // Massive / complex => deep
  if (complexity === "massive" || complexity === "complex") return "deep";

  return "normal";
}

// ────────────────────────────────────────────────────────────────────────────
// Next Anchors (deterministic decision table)
// ────────────────────────────────────────────────────────────────────────────

/** Infer 1~3 flow anchors from intent + stage. Never returns empty. */
function inferNextAnchors(
  intent: AgentIntent,
  stage: AgentTaskStage,
): AgentFlowAnchor[] {
  // Stage overrides
  if (stage === "underspecified") return ["SEARCH_REPO", "READ_FILES"];
  if (stage === "blocked") return ["READ_FILES", "VERIFY_RESULT"];

  switch (intent) {
    case "inspect":
    case "read":
    case "search":
      return ["SEARCH_REPO", "READ_FILES"];
    case "plan":
      return ["SEARCH_REPO", "READ_FILES", "PREPARE_PATCH"];
    case "edit":
    case "refactor":
      return ["READ_FILES", "PREPARE_PATCH", "VERIFY_RESULT"];
    case "fix":
      return ["READ_FILES", "PREPARE_PATCH", "RUN_TESTS"];
    case "test":
      return ["RUN_TESTS", "VERIFY_RESULT"];
    case "verify":
      return ["VERIFY_RESULT", "SUMMARIZE_CHANGE"];
    default:
      return ["SEARCH_REPO"];
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Code AST Analysis (lightweight, NO parser — pure regex heuristic)
// YUA reference: capability/code/code-ast-engine.ts
// ────────────────────────────────────────────────────────────────────────────

/** Error type classification for code/error messages */
export type CodeErrorType =
  | "TypeError"
  | "SyntaxError"
  | "ReferenceError"
  | "RuntimeError"
  | "BuildError"
  | "TestFailure"
  | "Unknown";

export interface CodeFeatures {
  detected: boolean;
  maxDepth: number;      // nesting depth estimate
  branchCount: number;   // if/switch/ternary count
  loopCount: number;     // for/while/do count
  functionCount: number; // function/arrow count
  hasAsync: boolean;     // async/await patterns
  hasEval: boolean;      // eval/new Function
  hasIO: boolean;        // fetch/fs/http/net
  mutationScore: number; // assignment density (0~1)
  errorType?: CodeErrorType;       // classified error type from code/message
  mentionedFiles: string[];        // file paths extracted from message/code
  hasStackTrace: boolean;          // stack trace pattern detected
}

/** Classify error type from code/message text */
function detectErrorType(text: string): CodeErrorType | undefined {
  if (/TypeError/i.test(text)) return "TypeError";
  if (/SyntaxError/i.test(text)) return "SyntaxError";
  if (/ReferenceError/i.test(text)) return "ReferenceError";
  if (/Error:|panic:|FATAL/i.test(text)) return "RuntimeError";
  if (/tsc|TS\d{4}|type error/i.test(text)) return "BuildError";
  if (/FAIL|test.*fail|assertion/i.test(text)) return "TestFailure";
  return undefined;
}

/** Extract file paths from text (source refs, stack traces) */
function extractFilePaths(text: string): string[] {
  const paths = new Set<string>();
  // Match file paths like src/foo/bar.ts, ./utils/helper.js, etc.
  const relMatches = text.match(
    /(?:\.\/|src\/|lib\/|app\/|pages\/|components\/)[a-zA-Z0-9_\-/]+\.[a-zA-Z]{1,5}/g,
  ) ?? [];
  for (const m of relMatches) paths.add(m);
  // Match "at file:line" patterns from stack traces
  const stackMatches = text.match(
    /at\s+(?:\S+\s+\()?(\/[^\s:)]+|[a-zA-Z0-9_\-.\/]+\.[a-zA-Z]{1,5})/g,
  ) ?? [];
  for (const m of stackMatches) {
    const cleaned = m.replace(/^at\s+(\S+\s+\()?/, "").replace(/[):]+$/, "");
    if (cleaned.includes(".")) paths.add(cleaned);
  }
  return [...paths].slice(0, 10); // max 10
}

function analyzeCodeInMessage(message: string): CodeFeatures {
  // Extract code blocks
  const codeBlockMatch = message.match(/```[\s\S]*?```/g);
  if (!codeBlockMatch || codeBlockMatch.length === 0) {
    // Check for inline code patterns (no fences)
    const hasCodePattern = /\b(function|const|let|var|class|import|export|return|async|await)\b/.test(message);
    if (!hasCodePattern) return { detected: false, maxDepth: 0, branchCount: 0, loopCount: 0, functionCount: 0, hasAsync: false, hasEval: false, hasIO: false, mutationScore: 0, mentionedFiles: [], hasStackTrace: false };
  }

  const code = codeBlockMatch ? codeBlockMatch.join("\n") : message;

  // Nesting depth estimate: count max sequential opening braces
  let maxDepth = 0;
  let currentDepth = 0;
  for (const char of code) {
    if (char === "{") { currentDepth++; maxDepth = Math.max(maxDepth, currentDepth); }
    else if (char === "}") currentDepth = Math.max(0, currentDepth - 1);
  }

  const branchCount = (code.match(/\b(if|switch|case|\?)\b/g) || []).length;
  const loopCount = (code.match(/\b(for|while|do)\b/g) || []).length;
  const functionCount = (code.match(/\b(function|=>)\b/g) || []).length;
  const hasAsync = /\b(async|await|Promise)\b/.test(code);
  const hasEval = /\b(eval|new\s+Function)\b/.test(code);
  const hasIO = /\b(fetch|require\s*\(\s*['"](?:fs|http|net|child_process)['"]|readFile|writeFile)\b/.test(code);
  const assignments = (code.match(/[^=!<>]=[^=]/g) || []).length;
  const mutationScore = clamp01(assignments / Math.max(1, code.split("\n").length) * 2);

  // Error classification + file extraction (P1 enhancement)
  const errorType = detectErrorType(code + " " + message);
  const mentionedFiles = extractFilePaths(code + " " + message);
  const hasStackTrace = /at\s+\S+\s*\(|stack\s*trace|Traceback/i.test(code + " " + message);

  return {
    detected: true,
    maxDepth,
    branchCount,
    loopCount,
    functionCount,
    hasAsync,
    hasEval,
    hasIO,
    mutationScore,
    errorType,
    mentionedFiles,
    hasStackTrace,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Math AST Analysis (lightweight, regex-based)
// YUA reference: capability/math/math-graph-engine.ts
// ────────────────────────────────────────────────────────────────────────────

interface MathFeatures {
  detected: boolean;
  hasIntegral: boolean;
  hasDerivative: boolean;
  hasSummation: boolean;
  operatorCount: number;
  nestingDepth: number;
  symbolicDensity: number;  // ratio of math symbols to total chars (0~1)
}

function analyzeMathInMessage(message: string): MathFeatures {
  // Math detection: symbols/keywords that indicate mathematical content
  const mathSymbols = /[∫∑∏∂∇√∞≈≠≤≥±×÷∈∉⊂⊃∪∩∀∃]/;
  const mathKeywords = /\b(integral|derivative|summation|equation|theorem|proof|matrix|vector|eigenvalue|gradient|divergence|laplacian)\b/i;
  const latexPattern = /\\(int|sum|prod|frac|sqrt|lim|partial|nabla|infty|begin\{)/;

  const hasMathContent = mathSymbols.test(message) || mathKeywords.test(message) || latexPattern.test(message);
  if (!hasMathContent) {
    // Check for dense arithmetic that isn't just code
    const pureArithmetic = /[=+\-*/^()]{3,}/.test(message) && !/function|class|=>|{|}/.test(message);
    if (!pureArithmetic) return { detected: false, hasIntegral: false, hasDerivative: false, hasSummation: false, operatorCount: 0, nestingDepth: 0, symbolicDensity: 0 };
  }

  const hasIntegral = /∫|\\int|\bintegral\b/i.test(message);
  const hasDerivative = /∂|\\partial|\bderivative\b|d\/d[xyz]/i.test(message);
  const hasSummation = /∑|\\sum|\bsummation\b|\bseries\b/i.test(message);
  const operatorCount = (message.match(/[+\-*/^=<>≈≠≤≥±×÷]/g) || []).length;

  // Nesting: count parentheses depth
  let nestingDepth = 0;
  let maxNesting = 0;
  for (const char of message) {
    if (char === "(") { nestingDepth++; maxNesting = Math.max(maxNesting, nestingDepth); }
    else if (char === ")") nestingDepth = Math.max(0, nestingDepth - 1);
  }

  // Symbolic density: ratio of non-alphanumeric non-space chars
  const symbolChars = (message.match(/[^a-zA-Z0-9가-힣\s]/g) || []).length;
  const symbolicDensity = clamp01(symbolChars / Math.max(1, message.length));

  return {
    detected: true,
    hasIntegral,
    hasDerivative,
    hasSummation,
    operatorCount,
    nestingDepth: maxNesting,
    symbolicDensity,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Narration Detection Helpers (for CLI pacer reuse)
// ────────────────────────────────────────────────────────────────────────────

/** Check if the message is a short continuation trigger (e.g. "ㄱㄱ", "go"). */
export function isShortContinuation(message: string): boolean {
  return /^(계속|다음|진행|ㄱㄱ|go|continue|next|이어서|ok|ㅇㅇ|넹|yes)$/i.test(
    message.trim(),
  );
}

/** Check if the message is likely a narration/explanation request (not an action). */
export function isNarrationRequest(message: string): boolean {
  return /^(설명|explain|뭐야|what is|how does|why|어떻게|왜)/i.test(
    message.trim(),
  );
}

/**
 * Casual action override (YUA isCasualActionRequest 이식).
 * 구어체 실행/안내 요청 감지 — underspecified 판정 취소에 사용.
 */
function isCasualAction(message: string): boolean {
  const m = message.trim();
  return (
    // 한국어 구어체 실행 요청
    /(해줘|알려줘|안내해줘|정리해줘|보여줘|말해줘|고쳐줘|만들어줘|실행해줘)$/i.test(m) ||
    // 한국어 단답 실행
    /^(ㄱㄱ|ㄱ|고고|시작|진행|해|가자|해라)$/i.test(m) ||
    // 영어 casual action
    /^(go|do it|fix it|start|just do it|run it)$/i.test(m)
  );
}

/** Check if the message references a previous turn. */
export function referencesPreviousTurn(message: string): boolean {
  return /(아까|이전|위에|방금|earlier|previous|that file|same|last)/i.test(
    message,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ────────────────────────────────────────────────────────────────────────────

/**
 * Pure heuristic reasoning. NO LLM, NO async, deterministic.
 *
 * @param message - User input message
 * @param projectContext - Optional project context for complexity boost
 * @returns AgentReasoningResult with intent, stage, complexity, confidence, depth, anchors
 */
export function agentReason(
  message: string,
  projectContext?: AgentProjectContext,
): AgentReasoningResult {
  // 1. Intent classification
  const intentResult = scoreByRules(message, INTENT_RULES, "inspect" as AgentIntent);

  // 2. Task stage classification
  const stageResult = scoreByRules(message, STAGE_RULES, "ready" as AgentTaskStage);

  // 3. Complexity
  const complexity = computeComplexity(message, projectContext);

  // 4. Confidence (YUA formula)
  const confidence = computeConfidence({
    inputLen: message.length,
    evidenceCount: intentResult.evidenceCount + stageResult.evidenceCount,
    topGap: intentResult.score - intentResult.secondBest,
    stage: stageResult.key,
  });

  // 4.5 Casual action override (YUA isCasualActionRequest 이식)
  // "ㄱㄱ", "해줘", "고쳐", "알려줘" 같은 구어체 실행 요청 →
  // underspecified로 판단됐어도 실행 의사가 명확하므로 ready로 승격
  let finalStage = stageResult.key;
  if (finalStage === "underspecified" && isCasualAction(message)) {
    finalStage = "ready";
  }

  // 5. Code/Math AST analysis (YUA capability porting — NO LLM, pure pattern)
  const codeFeatures = analyzeCodeInMessage(message);
  const mathFeatures = analyzeMathInMessage(message);

  // 5.5 Cognitive load — enhanced with AST features
  let cognitiveLoad = estimateCognitiveLoad(message.length);
  if (codeFeatures.detected) {
    // Deep nesting, many branches, async patterns → higher cognitive load
    if (codeFeatures.maxDepth >= 4 || codeFeatures.branchCount >= 5) cognitiveLoad = "high";
    else if (codeFeatures.maxDepth >= 2 || codeFeatures.branchCount >= 2) cognitiveLoad = cognitiveLoad === "low" ? "medium" : cognitiveLoad;
  }
  if (mathFeatures.detected) {
    if (mathFeatures.hasIntegral || mathFeatures.hasDerivative || mathFeatures.nestingDepth >= 3) cognitiveLoad = "high";
    else if (mathFeatures.symbolicDensity > 0.3) cognitiveLoad = cognitiveLoad === "low" ? "medium" : cognitiveLoad;
  }

  // 6. Depth hint — enhanced with AST
  let depthHint = estimateDepthHint(intentResult.key, finalStage, complexity);
  if ((codeFeatures.detected && codeFeatures.maxDepth >= 3) || (mathFeatures.detected && mathFeatures.hasIntegral)) {
    if (depthHint === "shallow") depthHint = "normal";
    if (cognitiveLoad === "high" && depthHint === "normal") depthHint = "deep";
  }

  // 7. Next anchors
  const nextAnchors = inferNextAnchors(intentResult.key, finalStage);

  return {
    intent: intentResult.key,
    taskStage: finalStage,
    complexity,
    confidence,
    depthHint,
    cognitiveLoad,
    nextAnchors,
  };
}
