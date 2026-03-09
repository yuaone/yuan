/**
 * @module git-intelligence
 * @description Git Intelligence module for the YUAN coding agent.
 * Provides smart commit message generation, PR description synthesis,
 * conflict prediction, history analysis, and branch management.
 *
 * Uses only `node:child_process` and `node:path` — no external dependencies.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execFile = promisify(execFileCb);

// ─── Types ───

/** Conventional commit type. */
export type CommitType =
  | "feat"
  | "fix"
  | "refactor"
  | "chore"
  | "test"
  | "docs"
  | "style"
  | "perf"
  | "ci"
  | "build";

/** Analysis of a diff for commit message generation. */
export interface CommitAnalysis {
  /** Conventional commit type */
  type: CommitType;
  /** Scope (e.g., "auth", "agent-loop", "core"), or null */
  scope: string | null;
  /** Short description of the change */
  description: string;
  /** Longer explanation, or null */
  body: string | null;
  /** Breaking change info, if any */
  breakingChange: BreakingChangeInfo | null;
  /** Number of files changed */
  filesChanged: number;
  /** Total inserted lines */
  insertions: number;
  /** Total deleted lines */
  deletions: number;
}

/** Details about a breaking change detected in a diff. */
export interface BreakingChangeInfo {
  /** Human-readable description of the breaking change */
  description: string;
  /** Exported symbols that are affected */
  affectedExports: string[];
}

/** A smart commit message with subject/body/footer. */
export interface SmartCommitMessage {
  /** Subject line: "feat(auth): add OAuth device flow" */
  subject: string;
  /** Optional body with details */
  body: string | null;
  /** Optional footer (e.g., "BREAKING CHANGE: ...") */
  footer: string | null;
  /** Full message combining subject + body + footer */
  fullMessage: string;
}

/** Auto-generated PR description. */
export interface PRDescription {
  /** Short PR title */
  title: string;
  /** Bullet-point summary */
  summary: string[];
  /** Per-file change breakdown */
  changesBreakdown: { file: string; description: string }[];
  /** Testing checklist */
  testPlan: string[];
  /** Breaking changes found */
  breakingChanges: string[];
  /** Suggested reviewers from git blame */
  reviewers: string[];
  /** Suggested labels */
  labels: string[];
}

/** Conflict prediction for a file. */
export interface ConflictPrediction {
  /** File path */
  file: string;
  /** Risk level */
  risk: "low" | "medium" | "high";
  /** Reason for the risk assessment */
  reason: string;
  /** Branch that may conflict */
  otherBranch?: string;
  /** Last modifier on the other branch */
  lastModifiedBy?: string;
  /** ISO date of last modification */
  lastModifiedAt?: string;
}

/** A frequently-changed file in the repository. */
export interface FileHotspot {
  /** File path */
  file: string;
  /** Number of commits touching this file */
  changeCount: number;
  /** Authors who have modified this file */
  authors: string[];
  /** ISO date of last change */
  lastChanged: string;
  /** Changes per week */
  churnRate: number;
  /** Percentage of changes that were bug fixes */
  bugFixRate: number;
}

/** Suggested branch name. */
export interface BranchSuggestion {
  /** Branch name, e.g. "feat/oauth-device-flow" */
  name: string;
  /** Base branch to branch from */
  basedOn: string;
  /** Reason for the suggestion */
  reason: string;
}

/** Current git status summary. */
export interface GitStats {
  /** Current branch name */
  currentBranch: string;
  /** Number of uncommitted (unstaged) changes */
  uncommittedChanges: number;
  /** Number of staged changes */
  stagedChanges: number;
  /** Commits ahead of remote */
  aheadOfRemote: number;
  /** Commits behind remote */
  behindRemote: number;
  /** Recent commit entries */
  recentCommits: { hash: string; subject: string; author: string; date: string }[];
}

/** Configuration for GitIntelligence. */
export interface GitIntelligenceConfig {
  /** Absolute path to the project/repo root */
  projectPath: string;
  /** Default branch name; auto-detected if not specified */
  defaultBranch?: string;
  /** Max commits to analyze for history; default 100 */
  maxHistoryDepth?: number;
  /** Use conventional commits format; default true */
  conventionalCommits?: boolean;
}

// ─── Internal Helpers ───

/** Parsed file info from a diff. */
interface ParsedDiffFile {
  path: string;
  hunks: string[];
}

/** Parsed diff stat entry. */
interface DiffStatEntry {
  file: string;
  insertions: number;
  deletions: number;
  status: string;
}

// ─── Constants ───

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$/;
const DOCS_FILE_RE = /\.(md|mdx|txt|rst)$|README|CHANGELOG|LICENSE/i;
const CONFIG_FILE_RE =
  /(package\.json|tsconfig.*\.json|\.eslintrc|\.prettierrc|jest\.config|vitest\.config|webpack\.config|vite\.config|rollup\.config|\.gitignore|\.npmrc|pnpm-workspace)/i;
const STYLE_FILE_RE = /\.(css|scss|sass|less|styl)$/;
const CI_FILE_RE = /(\.(github|gitlab)|Dockerfile|docker-compose|\.circleci|Jenkinsfile|\.travis)/i;
const BUILD_FILE_RE = /(Makefile|CMakeLists|\.cmake|build\.gradle|pom\.xml)/i;

const FIX_KEYWORDS_RE =
  /\b(fix|bug|error|crash|issue|patch|resolve|hotfix|regression|broken|typo|wrong|incorrect|NaN|undefined|null\s+check)\b/i;

const FEAT_KEYWORDS_RE = /\b(add|create|implement|introduce|new|support|enable|feature)\b/i;
const REFACTOR_KEYWORDS_RE = /\b(refactor|restructure|reorganize|simplify|extract|inline|rename|move|clean\s*up)\b/i;
const PERF_KEYWORDS_RE = /\b(perf|performance|optimize|speed|fast|cache|memoize|lazy|debounce|throttle)\b/i;

/** Pattern for detecting removed exports. */
const REMOVED_EXPORT_RE = /^-\s*export\s+(function|class|interface|type|enum|const|let|var)\s+(\w+)/gm;
/** Pattern for detecting renamed/changed exports. */
const CHANGED_SIGNATURE_RE = /^-\s*export\s+(?:function|const)\s+(\w+)\s*\(([^)]*)\)/gm;

const MAX_BRANCH_NAME_LEN = 50;

// ─── GitIntelligence Class ───

/**
 * Git Intelligence engine for the YUAN coding agent.
 *
 * Analyzes git history, diffs, and blame data to generate smart commit messages,
 * PR descriptions, conflict predictions, and codebase hotspot analysis.
 *
 * @example
 * ```ts
 * const gi = new GitIntelligence({ projectPath: "/home/user/project" });
 * const msg = await gi.generateCommitMessage(true);
 * console.log(msg.fullMessage);
 * ```
 */
export class GitIntelligence {
  private config: Required<GitIntelligenceConfig>;
  private defaultBranch: string | null = null;

  constructor(config: GitIntelligenceConfig) {
    this.config = {
      projectPath: config.projectPath,
      defaultBranch: config.defaultBranch ?? "",
      maxHistoryDepth: config.maxHistoryDepth ?? 100,
      conventionalCommits: config.conventionalCommits ?? true,
    };
  }

  // ─── Commit Intelligence ───

  /**
   * Analyze staged or unstaged changes and generate a smart commit message.
   * @param staged - If true, analyze staged changes (`--cached`). Default: true.
   */
  async generateCommitMessage(staged = true): Promise<SmartCommitMessage> {
    const diffArgs = staged ? ["diff", "--cached"] : ["diff"];
    const diff = await this.git(diffArgs);

    if (!diff.trim()) {
      return {
        subject: "chore: empty commit",
        body: null,
        footer: null,
        fullMessage: "chore: empty commit",
      };
    }

    const analysis = this.analyzeDiff(diff);

    // Build subject
    const scopePart = analysis.scope ? `(${analysis.scope})` : "";
    const subject = `${analysis.type}${scopePart}: ${analysis.description}`;

    // Build body (list changed files if > 3)
    let body: string | null = null;
    if (analysis.filesChanged > 3) {
      const statDiff = staged
        ? await this.git(["diff", "--cached", "--stat"])
        : await this.git(["diff", "--stat"]);
      const lines = statDiff
        .split("\n")
        .filter((l) => l.includes("|"))
        .map((l) => `- ${l.trim()}`)
        .slice(0, 10);
      body = lines.join("\n");
    }
    if (analysis.body) {
      body = analysis.body + (body ? "\n\n" + body : "");
    }

    // Build footer (breaking changes)
    let footer: string | null = null;
    if (analysis.breakingChange) {
      footer = `BREAKING CHANGE: ${analysis.breakingChange.description}`;
      if (analysis.breakingChange.affectedExports.length > 0) {
        footer += `\nAffected exports: ${analysis.breakingChange.affectedExports.join(", ")}`;
      }
    }

    // Combine
    const parts = [subject];
    if (body) parts.push("", body);
    if (footer) parts.push("", footer);

    return {
      subject,
      body,
      footer,
      fullMessage: parts.join("\n"),
    };
  }

  /**
   * Analyze a raw diff string and produce a CommitAnalysis.
   * @param diff - Raw `git diff` output.
   */
  analyzeDiff(diff: string): CommitAnalysis {
    const parsed = this.parseDiff(diff);
    const files = parsed.files.map((f) => f.path);
    const allHunks = parsed.files.flatMap((f) => f.hunks).join("\n");

    // Count insertions/deletions from diff lines
    let insertions = 0;
    let deletions = 0;
    for (const line of diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) insertions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }

    const type = this.inferCommitType(diff, files);
    const scope = this.inferScope(files);
    const description = this.generateDescription(allHunks, type);
    const breakingChanges = this.detectBreakingChanges(diff);
    const breakingChange = breakingChanges.length > 0 ? breakingChanges[0]! : null;

    return {
      type,
      scope,
      description,
      body: null,
      breakingChange,
      filesChanged: files.length,
      insertions,
      deletions,
    };
  }

  /**
   * Detect breaking changes in a diff by looking for removed/changed exports.
   * @param diff - Raw `git diff` output.
   */
  detectBreakingChanges(diff: string): BreakingChangeInfo[] {
    const results: BreakingChangeInfo[] = [];
    const affectedExports: string[] = [];

    // Detect removed exports
    let match: RegExpExecArray | null;
    const removedRe = new RegExp(REMOVED_EXPORT_RE.source, "gm");
    while ((match = removedRe.exec(diff)) !== null) {
      affectedExports.push(match[2]!);
    }

    // Detect changed function signatures
    const changedRe = new RegExp(CHANGED_SIGNATURE_RE.source, "gm");
    const changedNames: string[] = [];
    while ((match = changedRe.exec(diff)) !== null) {
      changedNames.push(match[1]!);
    }

    // Check if the same function was re-added with different signature
    for (const name of changedNames) {
      const addedRe = new RegExp(
        `^\\+\\s*export\\s+(?:function|const)\\s+${name}\\s*\\(([^)]*)\\)`,
        "m",
      );
      const addedMatch = addedRe.exec(diff);
      if (addedMatch) {
        // Signature changed
        if (!affectedExports.includes(name)) {
          affectedExports.push(name);
        }
      }
    }

    if (affectedExports.length > 0) {
      results.push({
        description: `Exported API changed: ${affectedExports.join(", ")}`,
        affectedExports,
      });
    }

    return results;
  }

  // ─── PR Intelligence ───

  /**
   * Generate a PR description by analyzing the diff between current branch and base.
   * @param baseBranch - Base branch to diff against; auto-detected if omitted.
   */
  async generatePRDescription(baseBranch?: string): Promise<PRDescription> {
    const base = baseBranch ?? (await this.detectDefaultBranch());
    const currentBranch = (await this.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();

    // Get commits on this branch
    const logOutput = await this.git([
      "log",
      `${base}..HEAD`,
      "--oneline",
      "--format=%H|%s|%an|%aI",
    ]);
    const commits = this.parseLog(logOutput);

    // Get diff summary
    const diffSummary = await this.getDiffSummary(base);

    // Analyze each commit
    const analyses: CommitAnalysis[] = [];
    for (const commit of commits.slice(0, 20)) {
      const commitDiff = await this.git(["show", commit.hash, "--format="]);
      if (commitDiff.trim()) {
        analyses.push(this.analyzeDiff(commitDiff));
      }
    }

    // Determine primary type
    const typeCounts = new Map<string, number>();
    for (const a of analyses) {
      typeCounts.set(a.type, (typeCounts.get(a.type) ?? 0) + 1);
    }
    const primaryType =
      [...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "chore";

    // Primary scope
    const scopeCounts = new Map<string, number>();
    for (const a of analyses) {
      if (a.scope) scopeCounts.set(a.scope, (scopeCounts.get(a.scope) ?? 0) + 1);
    }
    const primaryScope =
      [...scopeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    // Title
    const scopePart = primaryScope ? `(${primaryScope})` : "";
    const title = `${primaryType}${scopePart}: ${commits[0]?.subject ?? currentBranch}`;

    // Summary bullets
    const summary = commits.map((c) => c.subject);

    // Changes breakdown
    const changesBreakdown = diffSummary.map((entry) => {
      const desc =
        entry.status === "A"
          ? "New file"
          : entry.status === "D"
            ? "Deleted"
            : `Modified (+${entry.insertions}/-${entry.deletions})`;
      return { file: entry.file, description: desc };
    });

    // Breaking changes
    const breakingChanges: string[] = [];
    for (const a of analyses) {
      if (a.breakingChange) {
        breakingChanges.push(a.breakingChange.description);
      }
    }

    // Reviewers
    const changedFiles = diffSummary.map((d) => d.file);
    const reviewers = await this.suggestReviewers(changedFiles);

    // Labels
    const labels = this.suggestLabelsFromAnalyses(analyses);

    // Test plan
    const testPlan = this.generateTestPlan(diffSummary, analyses);

    return {
      title: title.length > 70 ? title.slice(0, 67) + "..." : title,
      summary,
      changesBreakdown,
      testPlan,
      breakingChanges,
      reviewers,
      labels,
    };
  }

  /**
   * Suggest reviewers based on git blame of the given files.
   * @param files - File paths to check; if omitted, uses files changed vs default branch.
   */
  async suggestReviewers(files?: string[]): Promise<string[]> {
    const fileList =
      files ??
      (await this.git(["diff", "--name-only", `${await this.detectDefaultBranch()}..HEAD`]))
        .trim()
        .split("\n")
        .filter(Boolean);

    const authorCounts = new Map<string, number>();
    const currentUser = (await this.git(["config", "user.name"]).catch(() => "")).trim();

    for (const file of fileList.slice(0, 10)) {
      try {
        const blameOutput = await this.git(["blame", "--porcelain", "-L", "1,50", "--", file]);
        const parsed = this.parseBlame(blameOutput);
        for (const entry of parsed) {
          if (entry.author && entry.author !== currentUser && entry.author !== "Not Committed Yet") {
            authorCounts.set(entry.author, (authorCounts.get(entry.author) ?? 0) + 1);
          }
        }
      } catch {
        // File may not exist on current branch, skip
      }
    }

    return [...authorCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name]) => name);
  }

  /**
   * Suggest labels based on a CommitAnalysis.
   * @param analysis - The commit analysis to derive labels from.
   */
  suggestLabels(analysis: CommitAnalysis): string[] {
    return this.suggestLabelsFromAnalyses([analysis]);
  }

  // ─── Branch Intelligence ───

  /**
   * Suggest a branch name based on a task description.
   * @param taskDescription - Natural-language description of the task.
   */
  suggestBranchName(taskDescription: string): BranchSuggestion {
    const lower = taskDescription.toLowerCase();

    let type: string;
    if (FIX_KEYWORDS_RE.test(lower)) {
      type = "fix";
    } else if (FEAT_KEYWORDS_RE.test(lower)) {
      type = "feat";
    } else if (REFACTOR_KEYWORDS_RE.test(lower)) {
      type = "refactor";
    } else if (PERF_KEYWORDS_RE.test(lower)) {
      type = "perf";
    } else if (/\b(doc|readme|changelog)\b/i.test(lower)) {
      type = "docs";
    } else if (/\b(test|spec|coverage)\b/i.test(lower)) {
      type = "test";
    } else if (/\b(ci|deploy|pipeline|workflow)\b/i.test(lower)) {
      type = "ci";
    } else {
      type = "feat";
    }

    const slug = this.sanitizeBranchName(taskDescription);
    const name = `${type}/${slug}`;
    const basedOn = this.config.defaultBranch || "main";

    return {
      name,
      basedOn,
      reason: `Detected "${type}" intent from task description`,
    };
  }

  /**
   * Detect the default branch of the repository (main, master, develop, etc.).
   * Caches the result after first detection.
   */
  async detectDefaultBranch(): Promise<string> {
    if (this.config.defaultBranch) return this.config.defaultBranch;
    if (this.defaultBranch) return this.defaultBranch;

    // Try origin/HEAD
    try {
      const ref = (await this.git(["symbolic-ref", "refs/remotes/origin/HEAD"])).trim();
      const branch = ref.replace("refs/remotes/origin/", "");
      if (branch) {
        this.defaultBranch = branch;
        return branch;
      }
    } catch {
      // Not set
    }

    // Check for common branch names
    for (const candidate of ["main", "master", "develop"]) {
      try {
        await this.git(["rev-parse", "--verify", candidate]);
        this.defaultBranch = candidate;
        return candidate;
      } catch {
        // Branch doesn't exist
      }
    }

    this.defaultBranch = "main";
    return "main";
  }

  /**
   * Predict potential merge conflicts between current branch and a target branch.
   * @param targetBranch - Branch to check against; defaults to default branch.
   */
  async predictConflicts(targetBranch?: string): Promise<ConflictPrediction[]> {
    const target = targetBranch ?? (await this.detectDefaultBranch());
    const predictions: ConflictPrediction[] = [];

    // Files changed on current branch
    let ourFiles: string[];
    try {
      ourFiles = (await this.git(["diff", "--name-only", `${target}...HEAD`]))
        .trim()
        .split("\n")
        .filter(Boolean);
    } catch {
      return [];
    }

    // Files changed on target branch since merge base
    let theirFiles: string[];
    try {
      theirFiles = (await this.git(["diff", "--name-only", `HEAD...${target}`]))
        .trim()
        .split("\n")
        .filter(Boolean);
    } catch {
      return [];
    }

    // Find intersection
    const theirSet = new Set(theirFiles);
    const overlapping = ourFiles.filter((f) => theirSet.has(f));

    for (const file of overlapping) {
      let lastModifiedBy: string | undefined;
      let lastModifiedAt: string | undefined;

      try {
        const logLine = (
          await this.git(["log", "-1", `--format=%an|%aI`, target, "--", file])
        ).trim();
        const parts = logLine.split("|");
        if (parts.length >= 2) {
          lastModifiedBy = parts[0];
          lastModifiedAt = parts[1];
        }
      } catch {
        // skip
      }

      // Estimate risk by checking if same hunks are modified
      let risk: "low" | "medium" | "high" = "medium";
      let reason = `File modified on both branches`;

      try {
        // Get our changes to the file
        const ourDiff = await this.git(["diff", `${target}...HEAD`, "--", file]);
        const theirDiff = await this.git(["diff", `HEAD...${target}`, "--", file]);

        // Extract line ranges from hunks
        const ourRanges = this.extractHunkRanges(ourDiff);
        const theirRanges = this.extractHunkRanges(theirDiff);

        // Check for overlapping ranges
        const hasOverlap = ourRanges.some((ourRange) =>
          theirRanges.some(
            (theirRange) => ourRange.start <= theirRange.end && theirRange.start <= ourRange.end,
          ),
        );

        if (hasOverlap) {
          risk = "high";
          reason = "Same code regions modified on both branches";
        } else if (ourRanges.length > 0 && theirRanges.length > 0) {
          risk = "medium";
          reason = "Different regions modified in the same file";
        } else {
          risk = "low";
          reason = "Changes are in non-overlapping areas";
        }
      } catch {
        // Could not do detailed analysis, keep medium
      }

      predictions.push({
        file,
        risk,
        reason,
        otherBranch: target,
        lastModifiedBy,
        lastModifiedAt,
      });
    }

    // Sort by risk: high → medium → low
    const riskOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    predictions.sort((a, b) => (riskOrder[a.risk] ?? 1) - (riskOrder[b.risk] ?? 1));

    return predictions;
  }

  // ─── History Analysis ───

  /**
   * Find frequently-changed files (hotspots) in the repository.
   * @param days - Number of days to look back; default 30.
   */
  async findHotspots(days = 30): Promise<FileHotspot[]> {
    const since = `${days} days ago`;

    // Get file change counts
    const logOutput = await this.git([
      "log",
      `--since=${since}`,
      "--name-only",
      "--format=COMMIT:%H|%aI|%s",
    ]);

    const lines = logOutput.split("\n");
    const fileCounts = new Map<string, { count: number; dates: string[]; subjects: string[] }>();
    const fileAuthors = new Map<string, Set<string>>();

    let currentDate = "";
    let currentSubject = "";

    for (const line of lines) {
      if (line.startsWith("COMMIT:")) {
        const parts = line.slice(7).split("|");
        currentDate = parts[1] ?? "";
        currentSubject = parts.slice(2).join("|");
        continue;
      }
      const file = line.trim();
      if (!file) continue;

      const entry = fileCounts.get(file) ?? { count: 0, dates: [], subjects: [] };
      entry.count++;
      if (currentDate) entry.dates.push(currentDate);
      entry.subjects.push(currentSubject);
      fileCounts.set(file, entry);

      // Track authors per file
      if (!fileAuthors.has(file)) fileAuthors.set(file, new Set());
    }

    // Get authors for top files
    const sorted = [...fileCounts.entries()].sort((a, b) => b[1].count - a[1].count);
    const topFiles = sorted.slice(0, 30);

    for (const [file] of topFiles) {
      try {
        const authorLog = await this.git([
          "log",
          `--since=${since}`,
          "--format=%an",
          "--",
          file,
        ]);
        const authors = new Set(authorLog.trim().split("\n").filter(Boolean));
        fileAuthors.set(file, authors);
      } catch {
        // skip
      }
    }

    const weeks = Math.max(days / 7, 1);

    return topFiles.map(([file, data]) => {
      const bugFixCount = data.subjects.filter((s) => FIX_KEYWORDS_RE.test(s)).length;
      const lastDate = data.dates.sort().pop() ?? new Date().toISOString();

      return {
        file,
        changeCount: data.count,
        authors: [...(fileAuthors.get(file) ?? [])],
        lastChanged: lastDate,
        churnRate: Math.round((data.count / weeks) * 100) / 100,
        bugFixRate: data.count > 0 ? Math.round((bugFixCount / data.count) * 100) : 0,
      };
    });
  }

  /**
   * Get the change frequency (commit count) for specific files.
   * @param files - File paths to check.
   */
  async getChangeFrequency(files: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const depth = this.config.maxHistoryDepth;

    for (const file of files) {
      try {
        const output = await this.git([
          "log",
          `--max-count=${depth}`,
          "--oneline",
          "--",
          file,
        ]);
        const count = output.trim().split("\n").filter(Boolean).length;
        result.set(file, count);
      } catch {
        result.set(file, 0);
      }
    }

    return result;
  }

  /**
   * Get contributors for a specific file.
   * @param file - File path relative to repo root.
   */
  async getFileContributors(
    file: string,
  ): Promise<{ name: string; commits: number; lastCommit: string }[]> {
    try {
      const output = await this.git([
        "log",
        `--max-count=${this.config.maxHistoryDepth}`,
        "--format=%an|%aI",
        "--",
        file,
      ]);

      const authorMap = new Map<string, { commits: number; lastCommit: string }>();

      for (const line of output.trim().split("\n").filter(Boolean)) {
        const [name, date] = line.split("|");
        if (!name || !date) continue;

        const entry = authorMap.get(name);
        if (entry) {
          entry.commits++;
          if (date > entry.lastCommit) entry.lastCommit = date;
        } else {
          authorMap.set(name, { commits: 1, lastCommit: date });
        }
      }

      return [...authorMap.entries()]
        .map(([name, data]) => ({ name, ...data }))
        .sort((a, b) => b.commits - a.commits);
    } catch {
      return [];
    }
  }

  /**
   * Analyze commit patterns for the repo or a specific file.
   * @param file - Optional file path to narrow analysis.
   */
  async analyzeCommitPatterns(
    file?: string,
  ): Promise<{
    totalCommits: number;
    typeBreakdown: Record<string, number>;
    busyDays: string[];
    avgCommitsPerWeek: number;
  }> {
    const args = [
      "log",
      `--max-count=${this.config.maxHistoryDepth}`,
      "--format=%aI|%s",
    ];
    if (file) args.push("--", file);

    const output = await this.git(args);
    const lines = output.trim().split("\n").filter(Boolean);

    const typeBreakdown: Record<string, number> = {};
    const dayCounts = new Map<string, number>();
    const dates: string[] = [];

    for (const line of lines) {
      const pipeIdx = line.indexOf("|");
      if (pipeIdx < 0) continue;
      const dateStr = line.slice(0, pipeIdx);
      const subject = line.slice(pipeIdx + 1);
      const day = dateStr.slice(0, 10); // YYYY-MM-DD

      dates.push(dateStr);
      dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);

      // Detect type from conventional commit prefix
      const conventionalMatch = /^(\w+)(?:\([^)]*\))?!?:/.exec(subject);
      const type = conventionalMatch ? conventionalMatch[1]! : "other";
      typeBreakdown[type] = (typeBreakdown[type] ?? 0) + 1;
    }

    // Busy days (top 5)
    const busyDays = [...dayCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([day]) => day);

    // Average commits per week
    let avgCommitsPerWeek = 0;
    if (dates.length >= 2) {
      const oldest = new Date(dates[dates.length - 1]!);
      const newest = new Date(dates[0]!);
      const diffMs = newest.getTime() - oldest.getTime();
      const weeks = Math.max(diffMs / (7 * 24 * 60 * 60 * 1000), 1);
      avgCommitsPerWeek = Math.round((lines.length / weeks) * 100) / 100;
    }

    return {
      totalCommits: lines.length,
      typeBreakdown,
      busyDays,
      avgCommitsPerWeek,
    };
  }

  // ─── Status ───

  /**
   * Get a summary of the current git status.
   */
  async getStatus(): Promise<GitStats> {
    const branch = (await this.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();

    // Count staged/unstaged
    const statusOutput = await this.git(["status", "--porcelain"]);
    const statusLines = statusOutput.trim().split("\n").filter(Boolean);

    let stagedChanges = 0;
    let uncommittedChanges = 0;
    for (const line of statusLines) {
      const index = line[0];
      const worktree = line[1];
      if (index && index !== " " && index !== "?") stagedChanges++;
      if (worktree && worktree !== " " && worktree !== "?") uncommittedChanges++;
      if (index === "?") uncommittedChanges++;
    }

    // Ahead/behind
    let aheadOfRemote = 0;
    let behindRemote = 0;
    try {
      const abOutput = (
        await this.git(["rev-list", "--left-right", "--count", `HEAD...@{upstream}`])
      ).trim();
      const parts = abOutput.split(/\s+/);
      aheadOfRemote = parseInt(parts[0] ?? "0", 10) || 0;
      behindRemote = parseInt(parts[1] ?? "0", 10) || 0;
    } catch {
      // No upstream configured
    }

    // Recent commits
    const logOutput = await this.git([
      "log",
      "--max-count=10",
      "--format=%H|%s|%an|%aI",
    ]);
    const recentCommits = this.parseLog(logOutput);

    return {
      currentBranch: branch,
      uncommittedChanges,
      stagedChanges,
      aheadOfRemote,
      behindRemote,
      recentCommits,
    };
  }

  /**
   * Check whether the working directory is clean (no staged or unstaged changes).
   */
  async isClean(): Promise<boolean> {
    const status = await this.git(["status", "--porcelain"]);
    return status.trim().length === 0;
  }

  /**
   * Get a per-file diff summary against a base branch.
   * @param baseBranch - Base branch for comparison; defaults to default branch.
   */
  async getDiffSummary(
    baseBranch?: string,
  ): Promise<DiffStatEntry[]> {
    const base = baseBranch ?? (await this.detectDefaultBranch());
    const output = await this.git(["diff", "--numstat", `${base}..HEAD`]);
    const results: DiffStatEntry[] = [];

    for (const line of output.trim().split("\n").filter(Boolean)) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;

      const insertions = parts[0] === "-" ? 0 : parseInt(parts[0]!, 10) || 0;
      const deletions = parts[1] === "-" ? 0 : parseInt(parts[1]!, 10) || 0;
      const file = parts[2]!;

      // Determine status
      let status = "M";
      try {
        const nameStatus = await this.git([
          "diff",
          "--name-status",
          `${base}..HEAD`,
          "--",
          file,
        ]);
        const s = nameStatus.trim().split("\t")[0];
        if (s) status = s[0]!;
      } catch {
        // keep M
      }

      results.push({ file, insertions, deletions, status });
    }

    return results;
  }

  // ─── Private Methods ───

  /**
   * Execute a git command in the project directory.
   * @param args - Arguments to pass to `git`.
   * @returns stdout output.
   */
  private async git(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFile("git", args, {
        cwd: this.config.projectPath,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        timeout: 30_000,
      });
      return stdout;
    } catch (err: unknown) {
      const error = err as { stderr?: string; message?: string };
      throw new Error(`git ${args.join(" ")} failed: ${error.stderr ?? error.message ?? "unknown"}`);
    }
  }

  /**
   * Parse raw `git diff` output into structured file/hunk data.
   * @param diff - Raw diff output.
   */
  private parseDiff(diff: string): { files: ParsedDiffFile[] } {
    const files: ParsedDiffFile[] = [];
    const fileSections = diff.split(/^diff --git /m).filter(Boolean);

    for (const section of fileSections) {
      // Extract file path from "a/path b/path"
      const headerMatch = /^a\/(.+?) b\/(.+)/m.exec(section);
      const path = headerMatch?.[2] ?? headerMatch?.[1] ?? "unknown";

      // Extract hunks (@@...@@)
      const hunks: string[] = [];
      const hunkParts = section.split(/^@@/m);
      for (let i = 1; i < hunkParts.length; i++) {
        hunks.push("@@" + hunkParts[i]!);
      }

      files.push({ path, hunks });
    }

    return { files };
  }

  /**
   * Infer the conventional commit type from diff content and file paths.
   */
  private inferCommitType(diff: string, files: string[]): CommitType {
    // Check file patterns first
    const allTest = files.length > 0 && files.every((f) => TEST_FILE_RE.test(f));
    if (allTest) return "test";

    const allDocs = files.length > 0 && files.every((f) => DOCS_FILE_RE.test(f));
    if (allDocs) return "docs";

    const allStyle = files.length > 0 && files.every((f) => STYLE_FILE_RE.test(f));
    if (allStyle) return "style";

    const allCI = files.length > 0 && files.every((f) => CI_FILE_RE.test(f));
    if (allCI) return "ci";

    const allBuild = files.length > 0 && files.every((f) => BUILD_FILE_RE.test(f));
    if (allBuild) return "build";

    const allConfig = files.length > 0 && files.every((f) => CONFIG_FILE_RE.test(f));
    if (allConfig) return "chore";

    // Check diff content for keywords
    const hunkContent = diff
      .split("\n")
      .filter((l) => l.startsWith("+") || l.startsWith("-"))
      .join("\n");

    if (FIX_KEYWORDS_RE.test(hunkContent)) return "fix";
    if (PERF_KEYWORDS_RE.test(hunkContent)) return "perf";

    // Count additions vs deletions
    let additions = 0;
    let deletions = 0;
    for (const line of diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }

    // Mostly new files or more additions = feat
    const hasNewFiles = diff.includes("new file mode");
    if (hasNewFiles || (additions > deletions * 2)) return "feat";

    // More deletions than additions = refactor
    if (deletions > additions) return "refactor";

    return "feat";
  }

  /**
   * Infer a scope from file paths by finding a common directory.
   */
  private inferScope(files: string[]): string | null {
    if (files.length === 0) return null;

    // Extract meaningful directory segments
    const segments = files.map((f) => {
      const parts = f.split("/").filter(Boolean);
      // Skip top-level generic dirs
      const skip = new Set(["src", "lib", "dist", "build", "packages"]);
      const meaningful = parts.filter((p) => !skip.has(p));
      return meaningful.length > 0 ? meaningful[0]! : parts[parts.length - 1] ?? null;
    });

    // If all files share the same segment, use it
    const unique = [...new Set(segments.filter(Boolean))];
    if (unique.length === 1) {
      return this.cleanScopeName(unique[0]!);
    }

    // If there are 2 segments, use the more specific one
    if (unique.length === 2 && files.length <= 5) {
      // Check for a common parent
      const dirs = files.map((f) => f.split("/").slice(0, -1).join("/"));
      const commonDir = this.longestCommonPrefix(dirs);
      if (commonDir) {
        const lastPart = commonDir.split("/").filter(Boolean).pop();
        if (lastPart) return this.cleanScopeName(lastPart);
      }
    }

    return null;
  }

  /**
   * Clean a scope name by removing file extensions and trimming.
   */
  private cleanScopeName(name: string): string {
    return name.replace(/\.\w+$/, "").replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
  }

  /**
   * Find the longest common prefix among strings.
   */
  private longestCommonPrefix(strs: string[]): string {
    if (strs.length === 0) return "";
    let prefix = strs[0]!;
    for (let i = 1; i < strs.length; i++) {
      while (!strs[i]!.startsWith(prefix)) {
        prefix = prefix.slice(0, -1);
        if (!prefix) return "";
      }
    }
    return prefix;
  }

  /**
   * Generate a short description from diff hunks and commit type.
   */
  private generateDescription(hunks: string, type: string): string {
    const lines = hunks.split("\n");

    // Collect added lines (skip diff metadata)
    const added: string[] = [];
    const removed: string[] = [];
    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++") && !line.startsWith("@@")) {
        const content = line.slice(1).trim();
        if (content && !content.startsWith("//") && !content.startsWith("*")) {
          added.push(content);
        }
      } else if (line.startsWith("-") && !line.startsWith("---") && !line.startsWith("@@")) {
        const content = line.slice(1).trim();
        if (content && !content.startsWith("//") && !content.startsWith("*")) {
          removed.push(content);
        }
      }
    }

    // Try to find a meaningful first added line
    const significantAdded = added.find((l) => {
      return (
        /^(export\s+)?(function|class|interface|type|enum|const|let|var)\s+\w+/.test(l) ||
        /^(async\s+)?(\w+)\s*\(/.test(l) ||
        l.length > 10
      );
    });

    if (significantAdded) {
      // Extract a symbol name
      const symbolMatch =
        /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+(\w+)/.exec(
          significantAdded,
        );
      if (symbolMatch) {
        const verb =
          type === "feat" ? "add" : type === "fix" ? "fix" : type === "refactor" ? "refactor" : "update";
        return `${verb} ${symbolMatch[1]}`;
      }
    }

    // Fall back to describing the action
    if (added.length > 0 && removed.length === 0) {
      return `add new code (${added.length} lines)`;
    }
    if (removed.length > 0 && added.length === 0) {
      return `remove unused code (${removed.length} lines)`;
    }
    if (added.length > 0 && removed.length > 0) {
      return `update code (+${added.length}/-${removed.length} lines)`;
    }

    return "update files";
  }

  /**
   * Parse git log output in the format `%H|%s|%an|%aI`.
   */
  private parseLog(
    output: string,
  ): { hash: string; subject: string; author: string; date: string }[] {
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("|");
        return {
          hash: parts[0] ?? "",
          subject: parts[1] ?? "",
          author: parts[2] ?? "",
          date: parts[3] ?? "",
        };
      })
      .filter((e) => e.hash.length > 0);
  }

  /**
   * Parse git blame --porcelain output.
   */
  private parseBlame(
    output: string,
  ): { author: string; line: number; date: string }[] {
    const results: { author: string; line: number; date: string }[] = [];
    const lines = output.split("\n");

    let currentAuthor = "";
    let currentDate = "";
    let currentLine = 0;

    for (const line of lines) {
      // Header line: "hash origLine finalLine numLines"
      const headerMatch = /^[0-9a-f]{40}\s+\d+\s+(\d+)/.exec(line);
      if (headerMatch) {
        currentLine = parseInt(headerMatch[1]!, 10);
        continue;
      }

      if (line.startsWith("author ")) {
        currentAuthor = line.slice(7);
      } else if (line.startsWith("author-time ")) {
        const ts = parseInt(line.slice(12), 10);
        currentDate = new Date(ts * 1000).toISOString();
      } else if (line.startsWith("\t")) {
        // Content line — marks end of this entry
        results.push({ author: currentAuthor, line: currentLine, date: currentDate });
      }
    }

    return results;
  }

  /**
   * Sanitize a string into a valid git branch name.
   */
  private sanitizeBranchName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, MAX_BRANCH_NAME_LEN);
  }

  /**
   * Extract hunk line ranges from a diff for conflict overlap analysis.
   */
  private extractHunkRanges(diff: string): { start: number; end: number }[] {
    const ranges: { start: number; end: number }[] = [];
    const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;

    let match: RegExpExecArray | null;
    while ((match = hunkRe.exec(diff)) !== null) {
      const start = parseInt(match[1]!, 10);
      const count = parseInt(match[2] ?? "1", 10);
      ranges.push({ start, end: start + count - 1 });
    }

    return ranges;
  }

  /**
   * Suggest labels from multiple commit analyses.
   */
  private suggestLabelsFromAnalyses(analyses: CommitAnalysis[]): string[] {
    const labels = new Set<string>();

    for (const a of analyses) {
      // Type-based labels
      switch (a.type) {
        case "feat":
          labels.add("enhancement");
          break;
        case "fix":
          labels.add("bug");
          break;
        case "docs":
          labels.add("documentation");
          break;
        case "test":
          labels.add("testing");
          break;
        case "perf":
          labels.add("performance");
          break;
        case "refactor":
          labels.add("refactor");
          break;
        case "ci":
          labels.add("ci/cd");
          break;
        case "build":
          labels.add("build");
          break;
        case "chore":
          labels.add("chore");
          break;
        case "style":
          labels.add("style");
          break;
      }

      // Size-based labels
      const totalChanges = a.insertions + a.deletions;
      if (totalChanges > 500) labels.add("size/large");
      else if (totalChanges > 100) labels.add("size/medium");
      else labels.add("size/small");

      // Breaking change
      if (a.breakingChange) labels.add("breaking-change");
    }

    return [...labels];
  }

  /**
   * Generate a test plan checklist based on changed files and analyses.
   */
  private generateTestPlan(
    diffSummary: DiffStatEntry[],
    analyses: CommitAnalysis[],
  ): string[] {
    const plan: string[] = [];

    // Check if any source files changed
    const hasSourceChanges = diffSummary.some(
      (d) => !TEST_FILE_RE.test(d.file) && !DOCS_FILE_RE.test(d.file) && !CONFIG_FILE_RE.test(d.file),
    );

    if (hasSourceChanges) {
      plan.push("[ ] Verify TypeScript compilation (`tsc --noEmit`)");
      plan.push("[ ] Run existing test suite");
    }

    // Check for test file changes
    const hasTestChanges = diffSummary.some((d) => TEST_FILE_RE.test(d.file));
    if (hasTestChanges) {
      plan.push("[ ] Verify new/updated tests pass");
    } else if (hasSourceChanges) {
      plan.push("[ ] Consider adding tests for new functionality");
    }

    // Breaking changes
    const hasBreaking = analyses.some((a) => a.breakingChange);
    if (hasBreaking) {
      plan.push("[ ] Verify backward compatibility or document migration path");
      plan.push("[ ] Check downstream consumers for breakage");
    }

    // Config changes
    const hasConfigChanges = diffSummary.some((d) => CONFIG_FILE_RE.test(d.file));
    if (hasConfigChanges) {
      plan.push("[ ] Verify configuration changes work in dev and prod");
    }

    // New files
    const newFiles = diffSummary.filter((d) => d.status === "A");
    if (newFiles.length > 0) {
      plan.push(`[ ] Review ${newFiles.length} new file(s) for correctness`);
    }

    if (plan.length === 0) {
      plan.push("[ ] Smoke test the affected area");
    }

    return plan;
  }
}
