/**
 * @module task-classifier
 * @description 사용자 입력을 태스크 유형으로 분류하고, 최적 도구 시퀀스를 매핑한다.
 * 하드코딩된 도구 순서를 지능적 분류로 대체.
 */

import type { BYOKClient } from "./llm-client.js";

// ─── Task Type Enum ───

/** 태스크 유형 */
export enum TaskType {
  DEBUG = "debug",
  FEATURE = "feature",
  REFACTOR = "refactor",
  TEST = "test",
  EXPLAIN = "explain",
  SEARCH = "search",
  CONFIG = "config",
  DEPLOY = "deploy",
}

// ─── Classification Result ───

/** 태스크 분류 결과 */
export interface TaskClassification {
  /** 분류된 태스크 유형 */
  type: TaskType;
  /** 분류 신뢰도 (0–1) */
  confidence: number;
  /** 최적 도구 실행 순서 */
  toolSequence: string[];
  /** 우선 읽어야 할 파일/패턴 힌트 */
  contextHints: string[];
  /** 예상 복잡도 */
  estimatedComplexity: "trivial" | "simple" | "moderate" | "complex";
  /** grep/glob에 사용할 검색 패턴 */
  searchPatterns?: string[];
}

// ─── Keyword Patterns ───

interface KeywordRule {
  type: TaskType;
  /** 매칭 키워드 (한국어 + 영어) */
  keywords: string[];
  /** 가중치 (매칭 시 기본 점수) */
  weight: number;
}

const KEYWORD_RULES: KeywordRule[] = [
  {
    type: TaskType.DEBUG,
    keywords: [
      "버그", "에러", "fix", "broken", "crash", "안됨", "오류",
      "error", "bug", "issue", "fail", "failing", "wrong", "incorrect",
      "doesn't work", "안돼", "동작안", "문제", "exception", "traceback",
      "stack trace", "segfault", "panic",
    ],
    weight: 1.0,
  },
  {
    type: TaskType.FEATURE,
    keywords: [
      "추가", "만들", "add", "create", "implement", "새로",
      "new", "build", "feature", "구현", "만들어", "생성",
      "develop", "introduce", "write", "작성",
    ],
    weight: 1.0,
  },
  {
    type: TaskType.REFACTOR,
    keywords: [
      "리팩", "refactor", "clean", "정리", "개선",
      "restructure", "reorganize", "simplify", "optimize", "improve",
      "cleanup", "rename", "extract", "move", "split", "merge",
      "중복", "duplicate", "DRY",
    ],
    weight: 1.0,
  },
  {
    type: TaskType.TEST,
    keywords: [
      "테스트", "test", "검증", "커버리지",
      "coverage", "spec", "unit test", "integration test", "e2e",
      "assert", "expect", "mock", "stub", "fixture",
    ],
    weight: 1.0,
  },
  {
    type: TaskType.EXPLAIN,
    keywords: [
      "설명", "explain", "뭐야", "어떻게", "왜", "분석",
      "what is", "how does", "why", "describe", "understand",
      "analyze", "overview", "summary", "읽어", "알려",
    ],
    weight: 0.9,
  },
  {
    type: TaskType.SEARCH,
    keywords: [
      "찾아", "search", "find", "어디", "grep",
      "locate", "where", "which file", "look for", "검색",
      "파일 찾", "코드 찾",
    ],
    weight: 0.9,
  },
  {
    type: TaskType.CONFIG,
    keywords: [
      "설정", "config", "환경", "env", ".json", ".yaml",
      "configure", "configuration", "setting", "setup",
      ".toml", ".ini", "tsconfig", "eslint", "prettier",
      "package.json", "환경변수",
    ],
    weight: 0.9,
  },
  {
    type: TaskType.DEPLOY,
    keywords: [
      "배포", "deploy", "build", "release",
      "publish", "ship", "CI", "CD", "pipeline",
      "docker", "production", "staging", "pm2",
    ],
    weight: 0.9,
  },
];

// ─── Tool Sequence Mappings ───

const TOOL_SEQUENCES: Record<TaskType, string[]> = {
  [TaskType.DEBUG]: ["grep", "file_read", "shell_exec", "file_edit", "test_run"],
  [TaskType.FEATURE]: ["glob", "file_read", "file_write", "file_edit", "test_run", "git_ops"],
  [TaskType.REFACTOR]: ["grep", "file_read", "code_search", "file_edit", "test_run"],
  [TaskType.TEST]: ["file_read", "file_write", "test_run", "file_edit", "test_run"],
  [TaskType.EXPLAIN]: ["grep", "file_read", "code_search"],
  [TaskType.SEARCH]: ["grep", "glob", "file_read", "code_search"],
  [TaskType.CONFIG]: ["file_read", "file_edit", "shell_exec"],
  [TaskType.DEPLOY]: ["git_ops", "shell_exec", "test_run"],
};

// ─── Complexity Patterns ───

interface ComplexitySignal {
  pattern: RegExp;
  delta: number; // positive = more complex
}

const COMPLEXITY_SIGNALS: ComplexitySignal[] = [
  // Complexity increasers
  { pattern: /multiple files|여러 파일|across.*files/i, delta: 2 },
  { pattern: /refactor.*entire|전체.*리팩|whole.*codebase/i, delta: 3 },
  { pattern: /migration|마이그레이션/i, delta: 2 },
  { pattern: /database|DB|스키마/i, delta: 1 },
  { pattern: /security|보안|auth/i, delta: 1 },
  { pattern: /performance|성능|optimize/i, delta: 1 },
  { pattern: /parallel|병렬|concurrent/i, delta: 2 },
  { pattern: /API|endpoint|라우터/i, delta: 1 },
  // Complexity reducers
  { pattern: /simple|간단|just|only|하나만/i, delta: -1 },
  { pattern: /typo|오타|rename|이름/i, delta: -2 },
  { pattern: /comment|주석/i, delta: -2 },
  { pattern: /log|로그|print/i, delta: -1 },
];

// ─── Context Hint Patterns ───

interface ContextHintRule {
  /** 입력에서 매칭할 패턴 */
  pattern: RegExp;
  /** 생성할 힌트 */
  hint: string;
}

const DEBUG_CONTEXT_HINTS: ContextHintRule[] = [
  { pattern: /test.*fail|테스트.*실패/i, hint: "Check recent test output and __tests__/ directory" },
  { pattern: /stack\s*trace|traceback/i, hint: "Look for error logs in stdout/stderr" },
  { pattern: /import.*error|모듈.*못/i, hint: "Check package.json dependencies and tsconfig paths" },
  { pattern: /type.*error|타입.*에러/i, hint: "Run tsc --noEmit to get full type error list" },
  { pattern: /runtime|런타임/i, hint: "Check process logs and error handlers" },
];

const FEATURE_CONTEXT_HINTS: ContextHintRule[] = [
  { pattern: /component|컴포넌트/i, hint: "Scan existing components/ for similar patterns" },
  { pattern: /API|endpoint|라우트/i, hint: "Check routes/ directory for existing API patterns" },
  { pattern: /hook|훅/i, hint: "Check hooks/ or use*.ts for existing hook patterns" },
  { pattern: /store|스토어|상태/i, hint: "Check stores/ for existing state management patterns" },
  { pattern: /type|타입|interface/i, hint: "Check types.ts or shared types for existing definitions" },
];

const REFACTOR_CONTEXT_HINTS: ContextHintRule[] = [
  { pattern: /import|의존/i, hint: "Trace import graph to identify affected files" },
  { pattern: /duplicate|중복|DRY/i, hint: "Search for duplicated code patterns across files" },
  { pattern: /extract|추출/i, hint: "Identify the extraction boundary and consumers" },
];

// ─── File Pattern Extraction ───

/**
 * 메시지에서 파일 경로나 파일 패턴을 추출한다.
 */
function extractFilePatterns(message: string): string[] {
  const patterns: string[] = [];

  // Match explicit file paths (e.g., src/foo/bar.ts, ./package.json)
  const filePathRegex = /(?:^|\s)(\.?\/?[\w./-]+\.(?:ts|tsx|js|jsx|json|yaml|yml|toml|css|scss|md|env))/gi;
  let match: RegExpExecArray | null;
  while ((match = filePathRegex.exec(message)) !== null) {
    patterns.push(match[1].trim());
  }

  // Match glob patterns (e.g., **/*.ts, src/**/*.tsx)
  const globRegex = /(?:^|\s)([\w./*-]+\*[\w./*-]*)/g;
  while ((match = globRegex.exec(message)) !== null) {
    patterns.push(match[1].trim());
  }

  return patterns;
}

/**
 * 메시지에서 검색에 유용한 grep/glob 패턴을 추출한다.
 */
function extractSearchPatterns(message: string, type: TaskType): string[] {
  const patterns: string[] = [];

  // Extract quoted strings as potential search terms
  const quotedRegex = /["'`]([^"'`]+)["'`]/g;
  let match: RegExpExecArray | null;
  while ((match = quotedRegex.exec(message)) !== null) {
    patterns.push(match[1]);
  }

  // Extract function/class/variable names (camelCase, PascalCase, snake_case)
  const identifierRegex = /\b([A-Z][a-zA-Z0-9]+|[a-z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+)\b/g;
  while ((match = identifierRegex.exec(message)) !== null) {
    const ident = match[1];
    // Filter out common English words that match camelCase pattern
    if (ident.length > 3 && !COMMON_WORDS.has(ident.toLowerCase())) {
      patterns.push(ident);
    }
  }

  // For debug tasks, extract error message fragments
  if (type === TaskType.DEBUG) {
    const errorRegex = /(?:error|Error|ERROR)[:\s]+(.+?)(?:\.|$)/gm;
    while ((match = errorRegex.exec(message)) !== null) {
      patterns.push(match[1].trim());
    }
  }

  return [...new Set(patterns)];
}

const COMMON_WORDS = new Set([
  "this", "that", "with", "from", "have", "been", "were", "they",
  "some", "what", "when", "where", "which", "there", "their",
  "about", "would", "could", "should", "after", "before",
  "other", "these", "those", "than", "then", "also", "just",
  "into", "over", "such", "only", "very", "make", "like",
]);

// ─── LLM Classification Prompt ───

const LLM_CLASSIFICATION_PROMPT = `You are a task classifier for a coding agent. Classify the user's message into exactly one task type.

Task types:
- debug: Fix bugs, errors, crashes, failing tests
- feature: Add new functionality, create new files/components
- refactor: Restructure, clean up, optimize existing code
- test: Write, fix, or improve tests
- explain: Explain code, analyze architecture, answer questions
- search: Find files, code patterns, or specific implementations
- config: Modify configuration files, environment settings
- deploy: Build, release, deploy, CI/CD operations

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "type": "<task_type>",
  "confidence": <0.0-1.0>,
  "estimatedComplexity": "<trivial|simple|moderate|complex>",
  "contextHints": ["<hint1>", "<hint2>"],
  "searchPatterns": ["<pattern1>", "<pattern2>"]
}`;

// ─── TaskClassifier Class ───

/**
 * 사용자 입력을 태스크 유형으로 분류하고 최적 도구 시퀀스를 매핑하는 분류기.
 *
 * 두 가지 모드:
 * 1. `classify()` — 키워드 기반 휴리스틱 (LLM 호출 없이 빠름)
 * 2. `classifyWithLLM()` — LLM 강화 분류 (모호한 경우)
 */
export class TaskClassifier {
  /**
   * 휴리스틱 기반 태스크 분류 (LLM 호출 없음, 빠름).
   *
   * @param message - 사용자 입력 메시지
   * @param projectContext - 프로젝트 컨텍스트 (선택, 예: 파일 구조 요약)
   * @returns 태스크 분류 결과
   */
  classify(message: string, projectContext?: string): TaskClassification {
    const normalizedMessage = message.toLowerCase();
    const scores = new Map<TaskType, number>();

    // Initialize scores
    for (const taskType of Object.values(TaskType)) {
      scores.set(taskType, 0);
    }

    // Score each task type based on keyword matches
    for (const rule of KEYWORD_RULES) {
      let matchCount = 0;
      for (const keyword of rule.keywords) {
        if (normalizedMessage.includes(keyword.toLowerCase())) {
          matchCount++;
        }
      }
      if (matchCount > 0) {
        const currentScore = scores.get(rule.type) ?? 0;
        // Diminishing returns for multiple matches on same type
        scores.set(rule.type, currentScore + rule.weight * (1 + Math.log(matchCount)));
      }
    }

    // Apply project context boost if available
    if (projectContext) {
      this.applyContextBoost(scores, normalizedMessage, projectContext);
    }

    // Find the best match
    let bestType = TaskType.FEATURE; // default fallback
    let bestScore = 0;
    let secondBestScore = 0;

    for (const [type, score] of scores) {
      if (score > bestScore) {
        secondBestScore = bestScore;
        bestScore = score;
        bestType = type;
      } else if (score > secondBestScore) {
        secondBestScore = score;
      }
    }

    // Calculate confidence
    const confidence = this.calculateConfidence(bestScore, secondBestScore);

    // Estimate complexity
    const estimatedComplexity = this.estimateComplexity(message);

    // Generate context hints
    const contextHints = this.generateContextHints(bestType, message);

    // Extract file patterns from message
    const filePatterns = extractFilePatterns(message);
    if (filePatterns.length > 0) {
      contextHints.push(...filePatterns.map((p) => `Referenced file: ${p}`));
    }

    // Extract search patterns
    const searchPatterns = extractSearchPatterns(message, bestType);

    // Get tool sequence
    const toolSequence = this.getToolSequence(bestType);

    return {
      type: bestType,
      confidence,
      toolSequence,
      contextHints,
      estimatedComplexity,
      ...(searchPatterns.length > 0 ? { searchPatterns } : {}),
    };
  }

  /**
   * LLM 강화 태스크 분류 (모호한 경우 사용).
   *
   * @param message - 사용자 입력 메시지
   * @param llmClient - BYOK LLM 클라이언트
   * @returns 태스크 분류 결과
   */
  async classifyWithLLM(
    message: string,
    llmClient: BYOKClient,
  ): Promise<TaskClassification> {
    // First, get heuristic classification as fallback
    const heuristic = this.classify(message);

    // If heuristic is confident enough, skip LLM call
    if (heuristic.confidence >= 0.8) {
      return heuristic;
    }

    try {
      const response = await llmClient.chat([
        { role: "system", content: LLM_CLASSIFICATION_PROMPT },
        { role: "user", content: message },
      ]);

      if (!response.content) {
        return heuristic;
      }

      const parsed = this.parseLLMClassification(response.content);
      if (!parsed) {
        return heuristic;
      }

      // Merge LLM result with heuristic hints
      const toolSequence = this.getToolSequence(parsed.type);
      const mergedHints = [
        ...new Set([...parsed.contextHints, ...heuristic.contextHints]),
      ];
      const mergedPatterns = [
        ...new Set([
          ...(parsed.searchPatterns ?? []),
          ...(heuristic.searchPatterns ?? []),
        ]),
      ];

      return {
        type: parsed.type,
        confidence: parsed.confidence,
        toolSequence,
        contextHints: mergedHints,
        estimatedComplexity: parsed.estimatedComplexity,
        ...(mergedPatterns.length > 0 ? { searchPatterns: mergedPatterns } : {}),
      };
    } catch {
      // LLM call failed — fall back to heuristic
      return heuristic;
    }
  }

  /**
   * 태스크 유형에 대한 최적 도구 실행 순서를 반환한다.
   *
   * @param type - 태스크 유형
   * @returns 도구 이름 배열 (실행 순서)
   */
  getToolSequence(type: TaskType): string[] {
    return [...TOOL_SEQUENCES[type]];
  }

  /**
   * 분류 결과를 시스템 프롬프트 주입용 문자열로 포맷한다.
   *
   * @param classification - 태스크 분류 결과
   * @returns 시스템 프롬프트에 삽입할 문자열
   */
  formatForSystemPrompt(classification: TaskClassification): string {
    const lines: string[] = [
      `<task-classification>`,
      `Task Type: ${classification.type}`,
      `Confidence: ${(classification.confidence * 100).toFixed(0)}%`,
      `Complexity: ${classification.estimatedComplexity}`,
      ``,
      `Recommended Tool Order:`,
      ...classification.toolSequence.map((tool, i) => `  ${i + 1}. ${tool}`),
    ];

    if (classification.contextHints.length > 0) {
      lines.push(``, `Context Hints:`);
      for (const hint of classification.contextHints) {
        lines.push(`  - ${hint}`);
      }
    }

    if (classification.searchPatterns && classification.searchPatterns.length > 0) {
      lines.push(``, `Search Patterns:`);
      for (const pattern of classification.searchPatterns) {
        lines.push(`  - ${pattern}`);
      }
    }

    lines.push(`</task-classification>`);
    return lines.join("\n");
  }

  // ─── Private Helpers ───

  /**
   * 프로젝트 컨텍스트를 기반으로 점수를 보정한다.
   */
  private applyContextBoost(
    scores: Map<TaskType, number>,
    message: string,
    projectContext: string,
  ): void {
    const ctx = projectContext.toLowerCase();

    // If project context mentions tests and message mentions related files
    if (ctx.includes("test") || ctx.includes("spec")) {
      if (message.includes("test") || message.includes("테스트")) {
        const current = scores.get(TaskType.TEST) ?? 0;
        scores.set(TaskType.TEST, current + 0.3);
      }
    }

    // If project context mentions CI/CD
    if (ctx.includes("ci") || ctx.includes("pipeline") || ctx.includes("deploy")) {
      if (message.includes("deploy") || message.includes("배포") || message.includes("build")) {
        const current = scores.get(TaskType.DEPLOY) ?? 0;
        scores.set(TaskType.DEPLOY, current + 0.3);
      }
    }

    // If project context mentions config files
    if (ctx.includes("config") || ctx.includes(".env") || ctx.includes("tsconfig")) {
      if (message.includes("설정") || message.includes("config") || message.includes("env")) {
        const current = scores.get(TaskType.CONFIG) ?? 0;
        scores.set(TaskType.CONFIG, current + 0.3);
      }
    }
  }

  /**
   * 1위와 2위 점수 차이를 기반으로 신뢰도를 계산한다.
   */
  private calculateConfidence(bestScore: number, secondBestScore: number): number {
    if (bestScore === 0) {
      // No matches at all — very low confidence, default to feature
      return 0.2;
    }

    // Gap-based confidence
    const gap = bestScore - secondBestScore;
    const ratio = gap / bestScore;

    // Map ratio to confidence range [0.4, 1.0]
    const confidence = 0.4 + ratio * 0.6;
    return Math.min(1.0, Math.max(0.0, confidence));
  }

  /**
   * 메시지 복잡도 시그널을 기반으로 복잡도를 추정한다.
   */
  private estimateComplexity(
    message: string,
  ): "trivial" | "simple" | "moderate" | "complex" {
    let score = 0;

    // Base score from message length
    if (message.length > 500) score += 2;
    else if (message.length > 200) score += 1;

    // Apply complexity signals
    for (const signal of COMPLEXITY_SIGNALS) {
      if (signal.pattern.test(message)) {
        score += signal.delta;
      }
    }

    // Count file references (more files = more complex)
    const filePatterns = extractFilePatterns(message);
    score += Math.min(filePatterns.length, 3);

    if (score <= -1) return "trivial";
    if (score <= 1) return "simple";
    if (score <= 4) return "moderate";
    return "complex";
  }

  /**
   * 태스크 유형 및 메시지 내용을 기반으로 컨텍스트 힌트를 생성한다.
   */
  private generateContextHints(type: TaskType, message: string): string[] {
    const hints: string[] = [];
    let rules: ContextHintRule[];

    switch (type) {
      case TaskType.DEBUG:
        rules = DEBUG_CONTEXT_HINTS;
        break;
      case TaskType.FEATURE:
        rules = FEATURE_CONTEXT_HINTS;
        break;
      case TaskType.REFACTOR:
        rules = REFACTOR_CONTEXT_HINTS;
        break;
      default:
        rules = [];
        break;
    }

    for (const rule of rules) {
      if (rule.pattern.test(message)) {
        hints.push(rule.hint);
      }
    }

    // Generic hints based on task type
    switch (type) {
      case TaskType.DEBUG:
        if (hints.length === 0) {
          hints.push("Search for error patterns in recent logs");
          hints.push("Check git diff for recent changes that may have introduced the bug");
        }
        break;
      case TaskType.FEATURE:
        if (hints.length === 0) {
          hints.push("Scan existing code for similar implementations to follow patterns");
        }
        break;
      case TaskType.TEST:
        hints.push("Check existing test files for testing patterns and utilities");
        break;
      case TaskType.CONFIG:
        hints.push("Read current config before making changes");
        break;
      case TaskType.DEPLOY:
        hints.push("Verify build passes before deployment");
        hints.push("Check git status for uncommitted changes");
        break;
      case TaskType.SEARCH:
        hints.push("Use glob for file discovery, grep for content search");
        break;
      case TaskType.EXPLAIN:
        hints.push("Read the target files and trace their dependencies");
        break;
      case TaskType.REFACTOR:
        if (hints.length === 0) {
          hints.push("Map the dependency graph of affected files before refactoring");
        }
        break;
    }

    return hints;
  }

  /**
   * LLM 응답 JSON을 파싱하여 분류 결과로 변환한다.
   */
  private parseLLMClassification(
    raw: string,
  ): {
    type: TaskType;
    confidence: number;
    estimatedComplexity: "trivial" | "simple" | "moderate" | "complex";
    contextHints: string[];
    searchPatterns?: string[];
  } | null {
    try {
      // Strip potential markdown code fences
      let cleaned = raw.trim();
      if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
      }

      const parsed = JSON.parse(cleaned) as Record<string, unknown>;

      // Validate type
      const typeStr = parsed.type as string | undefined;
      if (!typeStr || !Object.values(TaskType).includes(typeStr as TaskType)) {
        return null;
      }

      // Validate confidence
      const confidence = typeof parsed.confidence === "number"
        ? Math.min(1.0, Math.max(0.0, parsed.confidence))
        : 0.5;

      // Validate complexity
      const validComplexities = ["trivial", "simple", "moderate", "complex"] as const;
      const complexity = validComplexities.includes(
        parsed.estimatedComplexity as typeof validComplexities[number],
      )
        ? (parsed.estimatedComplexity as typeof validComplexities[number])
        : "moderate";

      // Extract hints
      const contextHints = Array.isArray(parsed.contextHints)
        ? (parsed.contextHints as unknown[]).filter((h): h is string => typeof h === "string")
        : [];

      // Extract search patterns
      const searchPatterns = Array.isArray(parsed.searchPatterns)
        ? (parsed.searchPatterns as unknown[]).filter((p): p is string => typeof p === "string")
        : undefined;

      return {
        type: typeStr as TaskType,
        confidence,
        estimatedComplexity: complexity,
        contextHints,
        searchPatterns,
      };
    } catch {
      return null;
    }
  }
}
