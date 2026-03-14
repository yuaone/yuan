/**
 * @module research-loop
 * @description Hypothesis-driven engineering research loop.
 *
 * Takes a problem statement, generates hypotheses (template-based, no LLM),
 * searches code/docs via a caller-supplied searchFn, evaluates evidence,
 * and produces a strategy recommendation.
 *
 * Loop:
 *   problem → hypotheses → search (code/docs) → evaluate evidence → update strategy
 *
 * Constraints:
 * - ESM only (no require())
 * - No LLM calls — purely structural, deterministic
 * - Atomic writes (.tmp → renameSync)
 * - All errors caught — never blocks
 * - Emits agent:research_session_complete on completion
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ResearchHypothesis {
  id: string;
  statement: string;
  confidence: number; // 0..1
  supportingEvidence: string[];
  contradictingEvidence: string[];
  status: "active" | "confirmed" | "rejected" | "inconclusive";
}

export interface ResearchSession {
  id: string;
  problem: string;
  hypotheses: ResearchHypothesis[];
  searchResults: Array<{
    query: string;
    source: "code" | "docs" | "web" | "issues";
    snippets: string[];
    timestamp: string;
  }>;
  conclusion: string;
  recommendedStrategy: string;
  confidence: number;
  iterations: number;
  startedAt: string;
  completedAt?: string;
}

export interface ResearchLoopConfig {
  /** Max iterations per research session. Default: 5 */
  maxIterations?: number;
  /** Stop early when any hypothesis reaches this confidence. Default: 0.75 */
  minConfidenceToStop?: number;
  /** Directory to store sessions.json. Default: ~/.yuan/research/ */
  storageDir?: string;
}

// ─── Internal ────────────────────────────────────────────────────────────────

interface StorageFile {
  sessions: ResearchSession[];
}

/** Playbook name mapping from conclusion keywords */
const STRATEGY_PLAYBOOK: Array<{ keywords: string[]; strategy: string }> = [
  { keywords: ["error", "fail", "crash", "exception", "throw"], strategy: "error-diagnosis-playbook" },
  { keywords: ["import", "dependency", "module", "require", "resolve"], strategy: "dependency-resolution-playbook" },
  { keywords: ["config", "configuration", "mismatch", "env", "environment"], strategy: "configuration-audit-playbook" },
  { keywords: ["slow", "perf", "performance", "timeout", "latency", "bottleneck"], strategy: "performance-profiling-playbook" },
  { keywords: ["algorithm", "inefficient", "complexity", "loop", "iteration"], strategy: "algorithm-optimization-playbook" },
  { keywords: ["contention", "resource", "lock", "concurrency", "race"], strategy: "concurrency-analysis-playbook" },
  { keywords: ["test", "assert", "logic", "contract", "expect"], strategy: "test-logic-review-playbook" },
  { keywords: ["missing", "implement", "stub", "not found", "undefined"], strategy: "implementation-scaffold-playbook" },
  { keywords: ["interface", "type", "signature", "mismatch", "incompatible"], strategy: "interface-alignment-playbook" },
  { keywords: ["state", "corruption", "inconsistent", "mutation", "side effect"], strategy: "state-audit-playbook" },
];

const DEFAULT_STRATEGY = "general-investigation-playbook";
const MAX_STORED_SESSIONS = 100;
const SNIPPET_TRUNCATE = 300;

// ─── Hypothesis generation ───────────────────────────────────────────────────

interface HypothesisTemplate {
  keywords: string[];
  statements: string[];
}

const HYPOTHESIS_TEMPLATES: HypothesisTemplate[] = [
  {
    keywords: ["error", "fail", "crash", "exception", "throw", "broke"],
    statements: [
      "Root cause is a runtime error in the problem domain",
      "Dependency or import is missing or incompatible",
      "Configuration is mismatched between environments",
    ],
  },
  {
    keywords: ["slow", "perf", "performance", "timeout", "latency", "speed"],
    statements: [
      "Bottleneck exists in a hot code path",
      "Algorithm or data structure choice is inefficient",
      "Resource contention or blocking I/O is the limiting factor",
    ],
  },
  {
    keywords: ["test", "spec", "assert", "failing", "jest", "vitest", "mocha"],
    statements: [
      "Logic error exists in the implementation being tested",
      "Test environment or setup is misconfigured",
      "Contract between caller and implementation is violated",
    ],
  },
];

const DEFAULT_HYPOTHESES: string[] = [
  "Required implementation is missing or incomplete",
  "Interface or type contract is mismatched",
  "State corruption or unexpected mutation is occurring",
];

function generateHypotheses(problem: string): ResearchHypothesis[] {
  const lower = problem.toLowerCase();

  // Find first matching template
  let statements: string[] = DEFAULT_HYPOTHESES;
  for (const template of HYPOTHESIS_TEMPLATES) {
    if (template.keywords.some((kw) => lower.includes(kw))) {
      statements = template.statements;
      break;
    }
  }

  return statements.map((stmt) => ({
    id: randomUUID(),
    statement: stmt,
    confidence: 0.3, // start with low prior
    supportingEvidence: [],
    contradictingEvidence: [],
    status: "active" as const,
  }));
}

// ─── Query generation from hypothesis ────────────────────────────────────────

function hypothesisToQuery(hypothesis: ResearchHypothesis, problem: string): string {
  // Extract the most specific noun phrases from hypothesis + first 6 words of problem
  const problemWords = problem
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 6)
    .join(" ");
  return `${hypothesis.statement} ${problemWords}`.slice(0, 120);
}

// ─── Evidence evaluation ──────────────────────────────────────────────────────

/** Extract keywords from a hypothesis statement (words >3 chars, no stopwords) */
function hypothesisKeywords(statement: string): string[] {
  const STOPWORDS = new Set([
    "root", "cause", "error", "code", "path", "that", "this", "from",
    "into", "when", "where", "with", "have", "been", "will", "does",
    "between", "missing", "existing", "problem", "domain",
  ]);
  return statement
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
}

/** Evaluate snippets against a hypothesis; update confidence and evidence */
function evaluateEvidence(
  hypothesis: ResearchHypothesis,
  snippets: string[],
  query: string,
): void {
  const keywords = hypothesisKeywords(hypothesis.statement);
  const queryKeywords = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3)
    .slice(0, 8);

  const allKeywords = Array.from(new Set([...keywords, ...queryKeywords]));

  for (const snippet of snippets) {
    const lower = snippet.toLowerCase();
    const hits = allKeywords.filter((kw) => lower.includes(kw)).length;
    const hitRatio = allKeywords.length > 0 ? hits / allKeywords.length : 0;

    if (hitRatio >= 0.25) {
      // Supporting evidence: snippet contains ≥25% of keywords
      const truncated = snippet.slice(0, SNIPPET_TRUNCATE);
      if (!hypothesis.supportingEvidence.includes(truncated)) {
        hypothesis.supportingEvidence.push(truncated);
        hypothesis.confidence = Math.min(1.0, hypothesis.confidence + 0.2);
      }
    } else if (hitRatio === 0 && snippet.length > 30) {
      // Contradicting evidence: snippet is non-trivial but has no keyword overlap
      const truncated = snippet.slice(0, SNIPPET_TRUNCATE);
      if (
        hypothesis.contradictingEvidence.length < 3 &&
        !hypothesis.contradictingEvidence.includes(truncated)
      ) {
        hypothesis.contradictingEvidence.push(truncated);
        hypothesis.confidence = Math.max(0.0, hypothesis.confidence - 0.1);
      }
    }
  }
}

// ─── Strategy selection from conclusion ──────────────────────────────────────

function selectStrategy(conclusion: string): string {
  const lower = conclusion.toLowerCase();
  for (const entry of STRATEGY_PLAYBOOK) {
    if (entry.keywords.some((kw) => lower.includes(kw))) {
      return entry.strategy;
    }
  }
  return DEFAULT_STRATEGY;
}

// ─── Conclusion generation ────────────────────────────────────────────────────

function buildConclusion(hypotheses: ResearchHypothesis[]): string {
  const sorted = [...hypotheses].sort((a, b) => b.confidence - a.confidence);
  const top = sorted[0];
  if (!top) return "No hypothesis reached sufficient confidence.";

  const evidence = top.supportingEvidence.length;
  const contra = top.contradictingEvidence.length;

  if (top.confidence >= 0.75) {
    return `High confidence: ${top.statement}. Supported by ${evidence} evidence snippet(s), ${contra} contradicting.`;
  } else if (top.confidence >= 0.5) {
    return `Moderate confidence: ${top.statement}. Supported by ${evidence} evidence snippet(s), ${contra} contradicting. Further investigation recommended.`;
  } else {
    return `Low confidence (${(top.confidence * 100).toFixed(0)}%): ${top.statement}. Insufficient evidence found. Manual review required.`;
  }
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

function defaultStorageDir(): string {
  return join(homedir(), ".yuan", "research");
}

function sessionsFilePath(storageDir: string): string {
  return join(storageDir, "sessions.json");
}

function loadSessions(storageDir: string): ResearchSession[] {
  const file = sessionsFilePath(storageDir);
  if (!existsSync(file)) return [];
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as StorageFile;
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}

function saveSessions(storageDir: string, sessions: ResearchSession[]): void {
  try {
    mkdirSync(storageDir, { recursive: true });
    const capped = sessions.slice(-MAX_STORED_SESSIONS);
    const file = sessionsFilePath(storageDir);
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify({ sessions: capped }, null, 2), "utf8");
    renameSync(tmp, file);
  } catch {
    // Non-fatal: storage failure should not crash the loop
  }
}

// ─── Similarity helpers ───────────────────────────────────────────────────────

/** Naive word-overlap similarity between two strings, 0..1 */
function similarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  return intersection / Math.max(wordsA.size, wordsB.size);
}

// ─── ResearchLoop ─────────────────────────────────────────────────────────────

export class ResearchLoop extends EventEmitter {
  private readonly maxIterations: number;
  private readonly minConfidenceToStop: number;
  private readonly storageDir: string;
  private sessions: ResearchSession[];

  constructor(config: ResearchLoopConfig = {}) {
    super();
    this.maxIterations = config.maxIterations ?? 5;
    this.minConfidenceToStop = config.minConfidenceToStop ?? 0.75;
    this.storageDir = config.storageDir ?? defaultStorageDir();
    this.sessions = loadSessions(this.storageDir);
  }

  /**
   * Run a hypothesis-driven research session for the given problem.
   * - Generates 2-3 initial hypotheses (template-based, no LLM)
   * - For each iteration, selects the lowest-confidence hypothesis, generates
   *   a search query, calls searchFn for "code" and "docs", evaluates evidence
   * - Stops early when minConfidenceToStop is reached
   * - Returns completed ResearchSession with conclusion + recommendedStrategy
   * - Emits agent:research_session_complete on completion
   */
  async research(
    problem: string,
    searchFn: (query: string, source: "code" | "docs") => Promise<string[]>,
    sessionId?: string,
  ): Promise<ResearchSession> {
    const id = sessionId ?? randomUUID();
    const startedAt = new Date().toISOString();

    const hypotheses = generateHypotheses(problem);
    const searchResults: ResearchSession["searchResults"] = [];

    let iterations = 0;
    let stoppedEarly = false;

    for (let i = 0; i < this.maxIterations; i++) {
      iterations++;

      // Select hypothesis with lowest confidence and fewest evidence
      const active = hypotheses.filter((h) => h.status === "active");
      if (active.length === 0) break;

      const target = active.reduce((best, h) => {
        const score = h.confidence + h.supportingEvidence.length * 0.05;
        const bestScore = best.confidence + best.supportingEvidence.length * 0.05;
        return score < bestScore ? h : best;
      });

      // Generate search query
      const query = hypothesisToQuery(target, problem);

      // Search code and docs (errors are non-fatal)
      for (const source of ["code", "docs"] as const) {
        let snippets: string[] = [];
        try {
          snippets = await searchFn(query, source);
        } catch {
          snippets = [];
        }

        if (snippets.length > 0) {
          searchResults.push({
            query,
            source,
            snippets: snippets.slice(0, 10),
            timestamp: new Date().toISOString(),
          });
        }

        // Evaluate evidence against all active hypotheses
        for (const hyp of active) {
          evaluateEvidence(hyp, snippets, query);
        }
      }

      // Check early stop: any hypothesis reached minConfidenceToStop?
      const confident = hypotheses.find(
        (h) => h.confidence >= this.minConfidenceToStop,
      );
      if (confident) {
        confident.status = "confirmed";
        stoppedEarly = true;
        break;
      }
    }

    // Finalize hypothesis statuses
    for (const h of hypotheses) {
      if (h.status === "active") {
        if (h.confidence >= this.minConfidenceToStop) {
          h.status = "confirmed";
        } else if (h.confidence <= 0.1) {
          h.status = "rejected";
        } else {
          h.status = "inconclusive";
        }
      }
    }

    const conclusion = buildConclusion(hypotheses);
    const recommendedStrategy = selectStrategy(conclusion);
    const topConfidence = Math.max(...hypotheses.map((h) => h.confidence));
    const completedAt = new Date().toISOString();

    const session: ResearchSession = {
      id,
      problem,
      hypotheses,
      searchResults,
      conclusion,
      recommendedStrategy,
      confidence: Math.round(topConfidence * 100) / 100,
      iterations,
      startedAt,
      completedAt,
    };

    // Persist (atomic write, non-fatal on failure)
    this.sessions.push(session);
    saveSessions(this.storageDir, this.sessions);

    // Emit completion event
    this.emit("event", {
      kind: "agent:research_session_complete",
      sessionId: id,
      problem,
      conclusion,
      recommendedStrategy,
      confidence: session.confidence,
      iterations,
      stoppedEarly,
      timestamp: completedAt,
    });

    return session;
  }

  /**
   * Return all research sessions loaded from storage (+ any run in this instance).
   */
  getSessions(): ResearchSession[] {
    return [...this.sessions];
  }

  /**
   * Find the most relevant past session for a given problem using word-overlap
   * similarity. Returns null if no session has similarity ≥ 0.3.
   */
  findRelevant(problem: string): ResearchSession | null {
    const SIMILARITY_THRESHOLD = 0.3;
    let best: ResearchSession | null = null;
    let bestScore = 0;

    for (const session of this.sessions) {
      const score = similarity(problem, session.problem);
      if (score > bestScore) {
        bestScore = score;
        best = session;
      }
    }

    return bestScore >= SIMILARITY_THRESHOLD ? best : null;
  }
}
