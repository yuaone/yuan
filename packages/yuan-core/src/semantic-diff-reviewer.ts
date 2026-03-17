/**
 * @module semantic-diff-reviewer
 * @description Classifies the semantic meaning of code changes.
 * Determines: was this a style change? behavior change? signature change?
 * Role: RECOMMENDER only. Outputs recommendedVerifyDepth, NOT final decision.
 * Language-aware: TS/JS primary, other languages use conservative fallback.
 */

// ─── Types ───

export type SemanticChangeKind =
  | "SIGNATURE_CHANGE"     // function/class signature modified
  | "CONTROL_FLOW_CHANGE"  // if/for/switch/try structure changed
  | "IMPORT_CHANGE"        // import/require/export changed
  | "CONFIG_CHANGE"        // config file modified
  | "TEST_ONLY"            // only test files changed
  | "BEHAVIOR_CHANGE"      // logic/data flow changed
  | "STYLE_ONLY";          // whitespace/formatting/rename only

export interface SemanticDiffReview {
  path: string;
  changes: SemanticChangeKind[];
  recommendedRiskBoost: number;                        // 0~0.3 addition to failureSurface
  recommendedVerifyDepth: "skip" | "quick" | "thorough";  // recommendation only
}

// ─── Internal Detection Patterns ───

/** Detect signature-level changes (function/class/interface/type declarations) */
const SIGNATURE_PATTERNS = [
  /^\s*(export\s+)?(function|class|interface|type|enum)\s+\w+/,
  /^\s*(export\s+)?(const|let|var)\s+\w+\s*[=:]\s*(async\s+)?\(/,
  /^\s*(public|private|protected|static|readonly|async)\s+\w+\s*\(/,
  /^\s*constructor\s*\(/,
];

/** Detect control flow structures */
const CONTROL_FLOW_PATTERNS = [
  /^\s*(if|else\s+if|else|for|while|do|switch|case|try|catch|finally)\b/,
  /^\s*return\b/,
  /^\s*throw\b/,
  /\?\s*\w+.*:/,  // ternary
];

/** Detect import/export lines */
const IMPORT_PATTERNS = [
  /^\s*(import|export)\s+/,
  /^\s*require\s*\(/,
  /^\s*module\.exports\s*/,
];

/** Lines that are purely style (comments, whitespace) */
function isStyleOnlyLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "") return true;
  if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return true;
  return false;
}

/** Compute a simple line-level diff: lines unique to old vs new */
function diffLines(oldLines: string[], newLines: string[]): { removed: string[]; added: string[] } {
  const oldSet = new Set(oldLines.map(l => l.trim()));
  const newSet = new Set(newLines.map(l => l.trim()));

  const removed = oldLines.filter(l => !newSet.has(l.trim()));
  const added = newLines.filter(l => !oldSet.has(l.trim()));

  return { removed, added };
}

/** Check if a language is TS/JS family */
function isTsJs(language?: string): boolean {
  if (!language) return true; // default: assume TS/JS
  const lang = language.toLowerCase();
  return /typescript|javascript|tsx?|jsx?/.test(lang);
}

// ─── Public API ───

/** Analyze a file's changes semantically */
export function reviewFileDiff(params: {
  path: string;
  oldContent: string;
  newContent: string;
  language?: string;
}): SemanticDiffReview {
  const { path, oldContent, newContent, language } = params;
  const changes: SemanticChangeKind[] = [];

  // Test-only detection
  if (/\.(test|spec)\.[jt]sx?$/.test(path) || /\/__tests__\//.test(path)) {
    return { path, changes: ["TEST_ONLY"], recommendedRiskBoost: 0, recommendedVerifyDepth: "skip" };
  }

  // Config detection
  if (/(tsconfig|package\.json|\.eslintrc|jest\.config|vitest\.config|rollup\.config|webpack\.config|vite\.config|\.prettierrc|\.babelrc)/.test(path)) {
    return { path, changes: ["CONFIG_CHANGE"], recommendedRiskBoost: 0.15, recommendedVerifyDepth: "thorough" };
  }

  // If not TS/JS, use conservative fallback
  if (!isTsJs(language)) {
    // Cannot reliably classify — assume behavior change
    return { path, changes: ["BEHAVIOR_CHANGE"], recommendedRiskBoost: 0.2, recommendedVerifyDepth: "thorough" };
  }

  // Diff the old vs new content
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const { removed, added } = diffLines(oldLines, newLines);
  const changedLines = [...removed, ...added];

  // No changes at all
  if (changedLines.length === 0) {
    return { path, changes: ["STYLE_ONLY"], recommendedRiskBoost: 0, recommendedVerifyDepth: "skip" };
  }

  // Check if ALL changed lines are style-only
  const allStyle = changedLines.every(l => isStyleOnlyLine(l));
  if (allStyle) {
    changes.push("STYLE_ONLY");
    return { path, changes, recommendedRiskBoost: 0, recommendedVerifyDepth: "skip" };
  }

  // Detect specific change kinds from changed lines
  let hasSignature = false;
  let hasControlFlow = false;
  let hasImport = false;

  for (const line of changedLines) {
    if (!hasSignature && SIGNATURE_PATTERNS.some(p => p.test(line))) {
      hasSignature = true;
    }
    if (!hasControlFlow && CONTROL_FLOW_PATTERNS.some(p => p.test(line))) {
      hasControlFlow = true;
    }
    if (!hasImport && IMPORT_PATTERNS.some(p => p.test(line))) {
      hasImport = true;
    }
  }

  if (hasSignature) changes.push("SIGNATURE_CHANGE");
  if (hasControlFlow) changes.push("CONTROL_FLOW_CHANGE");
  if (hasImport) changes.push("IMPORT_CHANGE");

  // If none of the specific patterns matched but we have non-style changes, it's behavior
  if (changes.length === 0) {
    changes.push("BEHAVIOR_CHANGE");
  }

  // Calculate risk boost and verify recommendation
  let riskBoost = 0;
  let verifyDepth: "skip" | "quick" | "thorough" = "quick";

  if (changes.includes("SIGNATURE_CHANGE")) {
    riskBoost = Math.max(riskBoost, 0.25);
    verifyDepth = "thorough";
  }
  if (changes.includes("CONTROL_FLOW_CHANGE")) {
    riskBoost = Math.max(riskBoost, 0.2);
    verifyDepth = "thorough";
  }
  if (changes.includes("BEHAVIOR_CHANGE")) {
    riskBoost = Math.max(riskBoost, 0.15);
    verifyDepth = "thorough";
  }
  if (changes.includes("IMPORT_CHANGE")) {
    riskBoost = Math.max(riskBoost, 0.1);
    if (verifyDepth !== "thorough") verifyDepth = "quick";
  }

  // Clamp risk boost to 0~0.3
  riskBoost = Math.min(riskBoost, 0.3);

  return { path, changes, recommendedRiskBoost: riskBoost, recommendedVerifyDepth: verifyDepth };
}

/** Review multiple files and produce aggregate recommendation */
export function reviewDiffBatch(reviews: SemanticDiffReview[]): {
  overallRiskBoost: number;
  overallVerifyRecommendation: "skip" | "quick" | "thorough";
  summary: string;
} {
  if (reviews.length === 0) {
    return { overallRiskBoost: 0, overallVerifyRecommendation: "skip", summary: "No files to review" };
  }

  // Aggregate: worst-case verify depth, max risk boost
  let overallRiskBoost = 0;
  let overallVerify: "skip" | "quick" | "thorough" = "skip";
  const depthOrder: Record<string, number> = { skip: 0, quick: 1, thorough: 2 };
  const depthReverse = ["skip", "quick", "thorough"] as const;

  const kindCounts: Partial<Record<SemanticChangeKind, number>> = {};

  for (const review of reviews) {
    overallRiskBoost = Math.max(overallRiskBoost, review.recommendedRiskBoost);
    if (depthOrder[review.recommendedVerifyDepth]! > depthOrder[overallVerify]!) {
      overallVerify = review.recommendedVerifyDepth;
    }
    for (const kind of review.changes) {
      kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
    }
  }

  // Ensure the result is typed correctly
  const overallVerifyRecommendation = depthReverse[depthOrder[overallVerify]!]!;

  // Build summary
  const parts: string[] = [`${reviews.length} files reviewed`];
  for (const [kind, count] of Object.entries(kindCounts)) {
    parts.push(`${kind}: ${count}`);
  }

  return {
    overallRiskBoost: Math.min(overallRiskBoost, 0.3),
    overallVerifyRecommendation,
    summary: parts.join(", "),
  };
}
