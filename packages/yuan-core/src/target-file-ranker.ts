/**
 * @module target-file-ranker
 * @description Post-retrieval file candidate reranker.
 * Scores and reranks file candidates from glob/grep/search results.
 * Role: RERANKER only. Does NOT perform file search.
 * Budget-aware: returns top-k within toolBudget.maxFileReads.
 */

export interface FileCandidateScore {
  path: string;
  score: number;      // 0~100
  reasons: string[];
}

export interface RankerInput {
  candidates: string[];           // from glob/grep results
  userMessage: string;            // for keyword matching
  errorStackFiles?: string[];     // from CodeFeatures.mentionedFiles
  recentlyChangedFiles?: string[];
  recentlyReadFiles?: string[];   // already read this session -- score decay
  maxResults: number;             // from toolBudget.maxFileReads
}

/**
 * Rank and rerank file candidates by relevance signals.
 * Pure function, deterministic, no I/O.
 *
 * Scoring rubric (additive):
 *   +40  error stack trace match
 *   +30  filename mentioned in user message
 *   +20  recently changed file
 *   +10  test pair exists in candidate set
 *   +10  same package as a recently changed file
 *    +5  source file (not config/lock)
 *    +5  index/entry point file
 *   -15  already read this session (decay)
 */
export function rankFileCandidates(input: RankerInput): FileCandidateScore[] {
  const { candidates, userMessage, errorStackFiles, recentlyChangedFiles, recentlyReadFiles, maxResults } = input;
  const msg = userMessage.toLowerCase();

  const scored: FileCandidateScore[] = candidates.map(path => {
    let score = 0;
    const reasons: string[] = [];
    const name = path.split("/").pop() ?? "";
    const lower = path.toLowerCase();

    // Error stack trace match (+40)
    if (errorStackFiles?.some(f => path.includes(f) || f.includes(name))) {
      score += 40;
      reasons.push("error stack match");
    }

    // User message mentions filename (+30)
    if (msg.includes(name.toLowerCase()) || msg.includes(lower)) {
      score += 30;
      reasons.push("mentioned in message");
    }

    // Recently changed file (+20)
    if (recentlyChangedFiles?.includes(path)) {
      score += 20;
      reasons.push("recently changed");
    }

    // Test pair (+10) -- foo.ts <-> foo.test.ts
    const testPair = path.replace(/\.(ts|js|tsx|jsx)$/, ".test.$1");
    const srcPair = path.replace(/\.test\.(ts|js|tsx|jsx)$/, ".$1");
    if (candidates.includes(testPair) || candidates.includes(srcPair)) {
      score += 10;
      reasons.push("test pair exists");
    }

    // Same package as changed files (+10)
    if (recentlyChangedFiles?.some(cf => {
      const cfPkg = cf.match(/^(?:packages|apps|libs)\/([^/]+)\//)?.[1];
      const myPkg = path.match(/^(?:packages|apps|libs)\/([^/]+)\//)?.[1];
      return cfPkg && myPkg && cfPkg === myPkg;
    })) {
      score += 10;
      reasons.push("same package");
    }

    // Source file over config (+5)
    if (/\.(ts|js|tsx|jsx|py|go|rs)$/.test(path)) {
      score += 5;
      reasons.push("source file");
    }

    // Already read decay (-15)
    if (recentlyReadFiles?.includes(path)) {
      score -= 15;
      reasons.push("already read");
    }

    // Index/entry files boost (+5)
    if (/index\.[jt]sx?$|main\.[jt]sx?$|app\.[jt]sx?$/.test(name)) {
      score += 5;
      reasons.push("entry point");
    }

    return { path, score: Math.max(0, score), reasons };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

/** Format ranked results as a prompt hint string */
export function formatRankingHint(ranked: FileCandidateScore[]): string {
  if (ranked.length === 0) return "";
  return "Suggested file reading order:\n" + ranked
    .map((f, i) => `${i + 1}. ${f.path} (score: ${f.score}, ${f.reasons.join(", ")})`)
    .join("\n");
}
