/**
 * @module intent-inference
 * @description Intent Inference Engine — 모호한 사용자 입력을 구체적 태스크 명세로 변환.
 *
 * 프로젝트 컨텍스트(git 상태, 디렉토리 구조, 최근 에러 등)를 분석하여
 * 모호/간결한 입력도 실행 가능한 목표로 정제한다.
 * 한국어 슬랭/축약어도 이해한다.
 */

import { execSync, execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { BYOKClient } from "./llm-client.js";
import type { BYOKConfig } from "./types.js";

// ─── Types ───

/** Intent Inference 설정 */
export interface IntentConfig {
  /** BYOK config for LLM calls */
  byokConfig: BYOKConfig;
  /** Project root path */
  projectPath: string;
  /** Max context tokens for analysis (default: 4000) */
  maxContextTokens: number;
}

/** 의도 분류 카테고리 */
export type IntentCategory =
  | "bug_fix"    // Fix a bug/error
  | "feature"    // Add new functionality
  | "refactor"   // Improve existing code
  | "test"       // Write/fix tests
  | "docs"       // Documentation
  | "optimize"   // Performance improvement
  | "upgrade"    // Dependency/migration
  | "explore"    // Understand/explain code
  | "unknown";   // Can't determine

/** 추론된 의도 결과 */
export interface InferredIntent {
  /** Original user input */
  originalInput: string;
  /** Whether the input was vague/ambiguous */
  isAmbiguous: boolean;
  /** Classified intent category */
  category: IntentCategory;
  /** Confidence score 0-1 */
  confidence: number;
  /** Concrete task specification (the refined goal) */
  refinedGoal: string;
  /** Specific files likely involved */
  targetFiles: string[];
  /** Suggested approach */
  suggestedApproach: string;
  /** Context signals used for inference */
  signals: IntentSignal[];
}

/** 의도 추론에 사용된 컨텍스트 신호 */
export interface IntentSignal {
  source:
    | "git_status"
    | "recent_errors"
    | "project_structure"
    | "user_history"
    | "code_analysis"
    | "korean_nlp";
  description: string;
  relevance: number; // 0-1
}

// ─── Korean Pattern Definitions ───

/** 다국어 키워드 → 의도 카테고리 매핑 */
type LangPatterns = Record<string, { intent: IntentCategory; keywords: string[] }>;

const KOREAN_PATTERNS: LangPatterns = {
  bug_fix: { intent: "bug_fix", keywords: ["고쳐", "수정", "에러", "버그", "오류", "안됨", "안돼", "깨짐", "터짐", "뻑남"] },
  feature: { intent: "feature", keywords: ["추가", "만들어", "넣어", "구현", "기능"] },
  refactor: { intent: "refactor", keywords: ["리팩토링", "개선", "정리", "깔끔", "클린"] },
  optimize: { intent: "optimize", keywords: ["느려", "빠르게", "최적화", "성능", "속도"] },
  test: { intent: "test", keywords: ["테스트", "검증", "확인"] },
  docs: { intent: "docs", keywords: ["문서", "주석", "설명"] },
};

const JAPANESE_PATTERNS: LangPatterns = {
  bug_fix: { intent: "bug_fix", keywords: ["直して", "修正", "エラー", "バグ", "壊れ", "動かない", "落ちる", "クラッシュ"] },
  feature: { intent: "feature", keywords: ["追加", "作って", "実装", "機能", "新しい"] },
  refactor: { intent: "refactor", keywords: ["リファクタ", "改善", "整理", "きれい", "クリーン"] },
  optimize: { intent: "optimize", keywords: ["遅い", "速く", "最適化", "パフォーマンス", "高速"] },
  test: { intent: "test", keywords: ["テスト", "検証", "確認"] },
  docs: { intent: "docs", keywords: ["ドキュメント", "コメント", "説明", "文書"] },
};

const CHINESE_PATTERNS: LangPatterns = {
  bug_fix: { intent: "bug_fix", keywords: ["修复", "修改", "错误", "bug", "报错", "崩溃", "不行", "坏了"] },
  feature: { intent: "feature", keywords: ["添加", "新增", "实现", "功能", "创建"] },
  refactor: { intent: "refactor", keywords: ["重构", "改进", "整理", "优化代码", "清理"] },
  optimize: { intent: "optimize", keywords: ["慢", "快", "优化", "性能", "速度"] },
  test: { intent: "test", keywords: ["测试", "验证", "检查"] },
  docs: { intent: "docs", keywords: ["文档", "注释", "说明"] },
};

const ENGLISH_PATTERNS: LangPatterns = {
  bug_fix: { intent: "bug_fix", keywords: ["fix", "bug", "error", "broken", "crash", "failing", "doesn't work", "not working"] },
  feature: { intent: "feature", keywords: ["add", "create", "implement", "build", "new feature", "make"] },
  refactor: { intent: "refactor", keywords: ["refactor", "improve", "clean up", "reorganize", "simplify"] },
  optimize: { intent: "optimize", keywords: ["slow", "fast", "optimize", "performance", "speed up"] },
  test: { intent: "test", keywords: ["test", "verify", "check", "coverage"] },
  docs: { intent: "docs", keywords: ["document", "comment", "readme", "explain"] },
};

/** All language patterns merged for multi-language matching */
const ALL_LANG_PATTERNS: LangPatterns[] = [
  KOREAN_PATTERNS, JAPANESE_PATTERNS, CHINESE_PATTERNS, ENGLISH_PATTERNS,
];

/** 한국어 슬랭/축약어 → 의미 매핑 */
const KOREAN_SLANG: Record<string, string> = {
  "ㅇㅇ": "yes/확인",
  "ㄱㄱ": "go/진행",
  "ㄴㄴ": "no/아니오",
  "ㅎㅇ": "hi/인사",
  "ㅂㅂ": "bye/종료",
  "ㄱㅅ": "감사/thanks",
  "ㅈㅅ": "죄송/sorry",
};

/** 다국어 지시 대명사 (모호성 증가 신호) */
const DEMONSTRATIVES = [
  // Korean
  "이거", "저거", "그거", "여기", "거기", "저기",
  // Japanese
  "これ", "それ", "あれ", "ここ", "そこ", "あそこ",
  // Chinese
  "这个", "那个", "这里", "那里",
  // English
  "this thing", "that thing", "this one", "that one",
];

// ─── Engine ───

/**
 * Intent Inference Engine.
 *
 * 모호한 사용자 입력을 분석하고, 프로젝트 컨텍스트 신호를 수집하여
 * 구체적이고 실행 가능한 태스크 명세로 변환한다.
 */
export class IntentInferenceEngine {
  private readonly config: IntentConfig;
  private readonly llm: BYOKClient;

  constructor(config: IntentConfig) {
    this.config = config;
    this.llm = new BYOKClient(config.byokConfig);
  }

  /**
   * 리소스 정리. 내부 LLM 클라이언트를 해제한다.
   */
  destroy(): void {
    this.llm.destroy();
  }

  /**
   * 사용자 입력을 분석하여 구체적 의도를 추론한다.
   * @param userInput 사용자가 입력한 원본 텍스트
   * @returns 추론된 의도 결과
   */
  async infer(userInput: string): Promise<InferredIntent> {
    const trimmed = userInput.trim();

    // 1. Quick heuristic classification
    const classification = this.classifyInput(trimmed);

    // 2. Gather context signals in parallel
    const signals = await this.gatherSignals(trimmed);

    // 3. Identify target files
    const targetFiles = await this.identifyTargetFiles(trimmed, signals);

    // 4. Refine goal via LLM (if ambiguous or low confidence)
    const refinedGoal = await this.refineGoal(
      trimmed,
      signals,
      classification.category,
    );

    // 5. Generate suggested approach
    const suggestedApproach = this.buildApproach(
      classification.category,
      targetFiles,
      signals,
    );

    return {
      originalInput: trimmed,
      isAmbiguous: classification.isAmbiguous,
      category: classification.category,
      confidence: classification.confidence,
      refinedGoal,
      targetFiles,
      suggestedApproach,
      signals,
    };
  }

  // ─── Classification ───

  /**
   * 입력 텍스트를 휴리스틱으로 빠르게 분류한다.
   * LLM 호출 없이 패턴 매칭으로 1차 분류.
   */
  private classifyInput(input: string): {
    isAmbiguous: boolean;
    category: IntentCategory;
    confidence: number;
  } {
    const isAmbiguous = this.detectAmbiguity(input);

    // Try Korean pattern matching first
    const koreanMatch = this.matchKoreanPatterns(input);
    if (koreanMatch) {
      return {
        isAmbiguous,
        category: koreanMatch.category,
        confidence: isAmbiguous ? koreanMatch.confidence * 0.7 : koreanMatch.confidence,
      };
    }

    // English pattern matching
    const englishMatch = this.matchEnglishPatterns(input);
    if (englishMatch) {
      return {
        isAmbiguous,
        category: englishMatch.category,
        confidence: isAmbiguous ? englishMatch.confidence * 0.7 : englishMatch.confidence,
      };
    }

    return {
      isAmbiguous,
      category: "unknown",
      confidence: 0.1,
    };
  }

  /** 입력의 모호성을 판정한다. */
  private detectAmbiguity(input: string): boolean {
    // Very short input → likely ambiguous
    if (input.length < 20) return true;

    // Only Korean slang (ㅇㅇ, ㄱㄱ) → definitely ambiguous
    const slangOnly = input
      .replace(/\s+/g, "")
      .split("")
      .every((ch) => /[ㄱ-ㅎㅏ-ㅣ]/.test(ch));
    if (slangOnly && input.length < 10) return true;

    // Contains demonstratives without specifics
    const hasDemo = DEMONSTRATIVES.some((d) => input.includes(d));
    const hasFilePath = /[./\\][\w-]+\.\w+/.test(input) || /\/[\w-/]+/.test(input);
    if (hasDemo && !hasFilePath) return true;

    // Has specific signals → NOT ambiguous
    const hasFunctionName = /\b[a-zA-Z_]\w*\(/.test(input);
    const hasErrorMessage = /error|Error|exception|Exception|failed|Failed|Cannot|cannot/.test(input);
    if (hasFilePath || hasFunctionName || hasErrorMessage) return false;

    // No file paths mentioned → might be ambiguous
    if (!hasFilePath) return true;

    return false;
  }

  /** 한국어 키워드 패턴 매칭 */
  private matchKoreanPatterns(
    input: string,
  ): { category: IntentCategory; confidence: number } | null {
    // Match across all languages (Korean, Japanese, Chinese, English)
    let bestMatch: { category: IntentCategory; confidence: number } | null = null;
    let bestCount = 0;

    for (const langPatterns of ALL_LANG_PATTERNS) {
      for (const [, pattern] of Object.entries(langPatterns)) {
        const matchCount = pattern.keywords.filter((kw) =>
          input.toLowerCase().includes(kw.toLowerCase()),
        ).length;
        if (matchCount > bestCount) {
          bestCount = matchCount;
          bestMatch = {
            category: pattern.intent,
            confidence: Math.min(0.5 + matchCount * 0.15, 0.9),
          };
        }
      }
    }

    return bestMatch;
  }

  /** 영어 키워드 패턴 매칭 */
  private matchEnglishPatterns(
    input: string,
  ): { category: IntentCategory; confidence: number } | null {
    const lower = input.toLowerCase();

    const patterns: Array<{ category: IntentCategory; keywords: string[]; weight: number }> = [
      { category: "bug_fix", keywords: ["fix", "bug", "error", "broken", "crash", "issue", "wrong", "fail"], weight: 0.15 },
      { category: "feature", keywords: ["add", "create", "implement", "new", "build", "feature"], weight: 0.15 },
      { category: "refactor", keywords: ["refactor", "clean", "reorganize", "restructure", "simplify", "extract"], weight: 0.15 },
      { category: "test", keywords: ["test", "spec", "coverage", "assert", "mock", "jest", "vitest"], weight: 0.15 },
      { category: "docs", keywords: ["doc", "document", "readme", "comment", "jsdoc", "explain"], weight: 0.15 },
      { category: "optimize", keywords: ["optimize", "performance", "slow", "fast", "speed", "cache", "memory"], weight: 0.15 },
      { category: "upgrade", keywords: ["upgrade", "update", "migrate", "version", "dependency", "bump"], weight: 0.15 },
      { category: "explore", keywords: ["explain", "understand", "how", "what", "where", "find", "show", "list"], weight: 0.1 },
    ];

    let bestMatch: { category: IntentCategory; confidence: number } | null = null;
    let bestScore = 0;

    for (const pattern of patterns) {
      const matchCount = pattern.keywords.filter((kw) => lower.includes(kw)).length;
      const score = matchCount * pattern.weight;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = {
          category: pattern.category,
          confidence: Math.min(0.4 + score, 0.9),
        };
      }
    }

    return bestMatch;
  }

  // ─── Signal Gathering ───

  /**
   * 프로젝트 컨텍스트에서 의도 추론에 도움이 되는 신호를 수집한다.
   * git 상태, 프로젝트 구조, 최근 에러 등을 병렬로 수집.
   */
  private async gatherSignals(input: string): Promise<IntentSignal[]> {
    const signals: IntentSignal[] = [];

    // Gather in parallel
    const [gitSignals, structureSignals, errorSignals, koreanSignals] = await Promise.allSettled([
      this.gatherGitSignals(),
      this.gatherStructureSignals(),
      this.gatherErrorSignals(),
      Promise.resolve(this.gatherKoreanNLPSignals(input)),
    ]);

    if (gitSignals.status === "fulfilled") signals.push(...gitSignals.value);
    if (structureSignals.status === "fulfilled") signals.push(...structureSignals.value);
    if (errorSignals.status === "fulfilled") signals.push(...errorSignals.value);
    if (koreanSignals.status === "fulfilled") signals.push(...koreanSignals.value);

    // Sort by relevance
    signals.sort((a, b) => b.relevance - a.relevance);

    return signals;
  }

  /** Git 상태에서 신호 수집 */
  private async gatherGitSignals(): Promise<IntentSignal[]> {
    const signals: IntentSignal[] = [];
    const cwd = this.config.projectPath;

    try {
      // Uncommitted changes
      const status = execSync("git status --porcelain", {
        cwd,
        encoding: "utf-8",
        timeout: 5_000,
      }).trim();

      if (status) {
        const changedFiles = status
          .split("\n")
          .map((line) => line.slice(3).trim())
          .filter(Boolean);

        signals.push({
          source: "git_status",
          description: `Uncommitted changes in ${changedFiles.length} file(s): ${changedFiles.slice(0, 5).join(", ")}`,
          relevance: 0.8,
        });
      }

      // Recent commits
      const log = execSync("git log --oneline -5", {
        cwd,
        encoding: "utf-8",
        timeout: 5_000,
      }).trim();

      if (log) {
        signals.push({
          source: "git_status",
          description: `Recent commits:\n${log}`,
          relevance: 0.5,
        });
      }
    } catch {
      // Not a git repo or git unavailable — skip
    }

    return signals;
  }

  /** 프로젝트 구조에서 신호 수집 */
  private async gatherStructureSignals(): Promise<IntentSignal[]> {
    const signals: IntentSignal[] = [];
    const root = this.config.projectPath;

    try {
      // package.json
      const pkgPath = join(root, "package.json");
      const pkgRaw = await readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;

      const projectType = pkg.type === "module" ? "ESM" : "CommonJS";
      const deps = Object.keys((pkg.dependencies ?? {}) as Record<string, string>);
      const devDeps = Object.keys((pkg.devDependencies ?? {}) as Record<string, string>);

      signals.push({
        source: "project_structure",
        description: `Project: ${pkg.name ?? basename(root)} (${projectType}). Dependencies: ${deps.slice(0, 10).join(", ")}. DevDeps: ${devDeps.slice(0, 5).join(", ")}`,
        relevance: 0.6,
      });
    } catch {
      // No package.json — try other signals
    }

    try {
      // tsconfig check
      const tsconfigPath = join(root, "tsconfig.json");
      await readFile(tsconfigPath, "utf-8");
      signals.push({
        source: "project_structure",
        description: "TypeScript project (tsconfig.json found)",
        relevance: 0.4,
      });
    } catch {
      // Not TypeScript
    }

    try {
      // Top-level directory listing
      const entries = await readdir(root, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
        .map((e) => e.name);
      const files = entries
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .slice(0, 10);

      signals.push({
        source: "project_structure",
        description: `Top-level dirs: ${dirs.join(", ")}. Files: ${files.join(", ")}`,
        relevance: 0.3,
      });
    } catch {
      // Can't read directory
    }

    return signals;
  }

  /** 최근 에러/빌드 실패 신호 수집 */
  private async gatherErrorSignals(): Promise<IntentSignal[]> {
    const signals: IntentSignal[] = [];
    const cwd = this.config.projectPath;

    try {
      // Check recent git diff for error-related changes
      const diff = execSync("git diff HEAD --stat", {
        cwd,
        encoding: "utf-8",
        timeout: 5_000,
      }).trim();

      if (diff) {
        signals.push({
          source: "recent_errors",
          description: `Recent diff stats:\n${diff}`,
          relevance: 0.4,
        });
      }
    } catch {
      // No diff or git unavailable
    }

    // Check for common error log files
    const errorLogPaths = [
      "npm-debug.log",
      "yarn-error.log",
      ".next/error.log",
    ];

    for (const logPath of errorLogPaths) {
      try {
        const content = await readFile(join(cwd, logPath), "utf-8");
        // Only take last 500 chars to avoid context bloat
        const tail = content.slice(-500);
        signals.push({
          source: "recent_errors",
          description: `Error log found (${logPath}): ...${tail}`,
          relevance: 0.9,
        });
      } catch {
        // Log file doesn't exist — normal
      }
    }

    return signals;
  }

  /** 한국어 NLP 신호 수집 (슬랭, 축약어, 패턴) */
  private gatherKoreanNLPSignals(input: string): IntentSignal[] {
    const signals: IntentSignal[] = [];

    // Detect Korean slang
    for (const [slang, meaning] of Object.entries(KOREAN_SLANG)) {
      if (input.includes(slang)) {
        signals.push({
          source: "korean_nlp",
          description: `Korean slang detected: "${slang}" → ${meaning}`,
          relevance: 0.3,
        });
      }
    }

    // Detect demonstratives (context-dependent words)
    const foundDemos = DEMONSTRATIVES.filter((d) => input.includes(d));
    if (foundDemos.length > 0) {
      signals.push({
        source: "korean_nlp",
        description: `Demonstratives found: ${foundDemos.join(", ")} — needs contextual resolution`,
        relevance: 0.6,
      });
    }

    // Detect Korean intent keywords
    for (const [category, pattern] of Object.entries(KOREAN_PATTERNS)) {
      const matched = pattern.keywords.filter((kw) => input.includes(kw));
      if (matched.length > 0) {
        signals.push({
          source: "korean_nlp",
          description: `Korean intent keywords (${category}): ${matched.join(", ")}`,
          relevance: 0.7,
        });
      }
    }

    return signals;
  }

  // ─── Goal Refinement ───

  /**
   * LLM을 사용하여 모호한 입력을 구체적 태스크 명세로 변환한다.
   */
  private async refineGoal(
    input: string,
    signals: IntentSignal[],
    category: IntentCategory,
  ): Promise<string> {
    const signalsSummary = signals
      .filter((s) => s.relevance >= 0.3)
      .map((s) => `- [${s.source}] ${s.description}`)
      .join("\n");

    const prompt = [
      `User said: "${input}"`,
      "",
      "Context signals:",
      signalsSummary || "(no signals available)",
      "",
      `This appears to be a ${category} request.`,
      "",
      "Convert this into a specific, actionable task description.",
      "Include: what exactly to do, which files to modify, expected outcome.",
      "Be concrete and technical.",
      "If the input is in Korean, respond in Korean.",
      "Keep the response under 200 words.",
    ].join("\n");

    try {
      const response = await this.llm.chat([
        {
          role: "system",
          content:
            "You are a coding task specification engine. Convert vague user requests into precise, actionable task descriptions. Be technical and specific. Output ONLY the task description, no preamble.",
        },
        { role: "user", content: prompt },
      ]);

      return response.content?.trim() ?? input;
    } catch {
      // LLM call failed — fall back to original input with category prefix
      return `[${category}] ${input}`;
    }
  }

  // ─── Target File Identification ───

  /**
   * 입력 텍스트와 컨텍스트 신호에서 관련 파일을 추론한다.
   */
  private async identifyTargetFiles(
    input: string,
    signals: IntentSignal[],
  ): Promise<string[]> {
    const files = new Set<string>();

    // 1. Extract explicit file paths from input
    const filePathRegex = /(?:^|\s)((?:\.\/|\/)?[\w./-]+\.(?:ts|tsx|js|jsx|json|css|scss|md|yaml|yml|toml|py|go|rs|java|c|h|cpp))\b/g;
    let match: RegExpExecArray | null;
    while ((match = filePathRegex.exec(input)) !== null) {
      files.add(match[1]!);
    }

    // 2. Extract files from git status signals
    for (const signal of signals) {
      if (signal.source === "git_status" && signal.description.includes("Uncommitted changes")) {
        const fileList = signal.description
          .split(": ")
          .slice(1)
          .join(": ")
          .split(", ");
        for (const f of fileList) {
          if (f && !f.includes("...")) files.add(f.trim());
        }
      }
    }

    // 3. Try to find files matching keywords in input
    if (files.size === 0) {
      const identifiers = input.match(/\b[a-zA-Z][\w-]*(?:\.(?:ts|tsx|js|jsx))?/g) ?? [];
      const cwd = this.config.projectPath;

      for (const id of identifiers.slice(0, 5)) {
        // Only look for identifiers that look like file names
        if (id.length < 3 || /^(the|and|for|but|not|fix|add|get|set|new|old|use|can|has|was|are|did)$/i.test(id)) {
          continue;
        }
        // Sanitize: strip any characters that are not alphanumeric, dash, underscore, or dot
        const safeId = id.replace(/[^a-zA-Z0-9._-]/g, "");
        if (safeId.length < 3) continue;
        try {
          const found = execFileSync("find", [
            ".", "-name", `*${safeId}*`, "-type", "f",
            "-not", "-path", "*/node_modules/*",
            "-not", "-path", "*/.git/*",
          ], {
            cwd,
            encoding: "utf-8",
            timeout: 3_000,
            maxBuffer: 4096,
          }).trim();

          // Take only first 3 results
          const lines = found.split("\n").filter(Boolean).slice(0, 3);
          for (const f of lines) {
            files.add(f.replace(/^\.\//, ""));
          }
        } catch {
          // find failed — skip
        }
      }
    }

    return Array.from(files).slice(0, 20);
  }

  // ─── Approach Building ───

  /**
   * 카테고리와 대상 파일에 기반한 접근 방법 제안을 생성한다.
   */
  private buildApproach(
    category: IntentCategory,
    targetFiles: string[],
    signals: IntentSignal[],
  ): string {
    const fileList = targetFiles.length > 0
      ? `Target files: ${targetFiles.slice(0, 5).join(", ")}`
      : "No specific files identified yet — will scan project structure";

    const hasGitChanges = signals.some(
      (s) => s.source === "git_status" && s.description.includes("Uncommitted"),
    );

    const approaches: Record<IntentCategory, string> = {
      bug_fix: [
        "1. Reproduce the issue by examining error context",
        "2. Identify root cause in the relevant source files",
        "3. Apply minimal fix to resolve the issue",
        "4. Verify fix doesn't introduce regressions",
        fileList,
      ].join("\n"),

      feature: [
        "1. Understand the feature requirements",
        "2. Identify insertion points in existing code",
        "3. Implement the feature with proper types",
        "4. Add necessary exports and integrations",
        fileList,
      ].join("\n"),

      refactor: [
        "1. Analyze current code structure and dependencies",
        "2. Plan refactoring steps to minimize breakage",
        "3. Apply refactoring incrementally",
        "4. Verify all imports and references are updated",
        fileList,
      ].join("\n"),

      test: [
        "1. Identify testable units and coverage gaps",
        "2. Write test cases covering happy path and edge cases",
        "3. Ensure test infrastructure is set up",
        "4. Verify all tests pass",
        fileList,
      ].join("\n"),

      docs: [
        "1. Identify undocumented or poorly documented areas",
        "2. Write clear JSDoc/inline comments",
        "3. Update README or related docs if needed",
        fileList,
      ].join("\n"),

      optimize: [
        "1. Profile and identify performance bottlenecks",
        "2. Analyze algorithmic complexity",
        "3. Apply targeted optimizations",
        "4. Benchmark before and after",
        fileList,
      ].join("\n"),

      upgrade: [
        "1. Check current dependency versions",
        "2. Review changelogs for breaking changes",
        "3. Update dependencies incrementally",
        "4. Fix any breaking API changes",
        "5. Verify build and tests pass",
        fileList,
      ].join("\n"),

      explore: [
        "1. Scan project structure and entry points",
        "2. Trace the relevant code flow",
        "3. Summarize findings with code references",
        fileList,
      ].join("\n"),

      unknown: [
        "1. Clarify the user's intent from context",
        "2. Scan project for relevant patterns",
        "3. Propose a concrete action plan",
        fileList,
      ].join("\n"),
    };

    let approach = approaches[category];

    if (hasGitChanges) {
      approach += "\n\nNote: There are uncommitted git changes — consider reviewing them for context.";
    }

    return approach;
  }
}
