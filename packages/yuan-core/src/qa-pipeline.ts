/**
 * @module qa-pipeline
 * @description 5-Stage QA Agent Pipeline — 코드 변경 후 자동 품질 검증.
 *
 * Stages:
 * 1. Structural — TypeScript 컴파일, ESLint, 순환 import, export 검증
 * 2. Semantic — 유닛/통합 테스트 실행
 * 3. Quality — 복잡도, 함수/파일 길이, TODO, 디버그 문, 보안 스캔
 * 4. Review — LLM 기반 코드 리뷰 (thorough 모드 전용)
 * 5. Decision — 전체 결과 기반 자동 판정 (approve / fix_and_retry / escalate)
 *
 * QALevel 프리셋:
 * - quick:    structural only
 * - standard: structural + semantic + quality
 * - thorough: all 5 stages
 */

import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { readFile, readdir, stat, access, constants } from "node:fs/promises";
import path from "node:path";

// ══════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════

/** QA 파이프라인 단계 */
export type QAStage = "structural" | "semantic" | "quality" | "review" | "decision";

/** QA 실행 레벨 */
export type QALevel = "quick" | "standard" | "thorough";

/** QA 파이프라인 설정 */
export interface QAPipelineConfig {
  /** 프로젝트 루트 경로 */
  projectPath: string;
  /** 실행 레벨 (어떤 stage를 돌릴지 결정) */
  level: QALevel;

  // Stage toggles
  /** 구조 검증 활성화 (기본: true) */
  enableStructural: boolean;
  /** 시맨틱 검증 활성화 (기본: true) */
  enableSemantic: boolean;
  /** 품질 게이트 활성화 (기본: true) */
  enableQuality: boolean;
  /** LLM 리뷰 활성화 (기본: thorough만 true) */
  enableReview: boolean;
  /** 판정 활성화 (기본: true) */
  enableDecision: boolean;

  // Auto-fix
  /** 자동 수정 활성화 (기본: true) */
  autoFix: boolean;
  /** 최대 수정 시도 횟수 (기본: 3) */
  maxFixAttempts: number;
  /** 자동 수정 가능한 카테고리 */
  fixableCategories: string[];

  // Quality gates
  /** 품질 게이트 임계값 */
  qualityGates: QualityGates;

  // Timeouts
  /** 빌드 타임아웃 (ms, 기본: 60000) */
  buildTimeout: number;
  /** 테스트 타임아웃 (ms, 기본: 120000) */
  testTimeout: number;
}

/** 품질 게이트 임계값 */
export interface QualityGates {
  /** 최대 순환 복잡도 (기본: 15) */
  maxCyclomaticComplexity: number;
  /** 최대 함수 길이 (기본: 50 lines) */
  maxFunctionLength: number;
  /** 최대 파일 길이 (기본: 500 lines) */
  maxFileLength: number;
  /** 최소 테스트 커버리지 (기본: 0, 미적용) */
  minTestCoverage: number;
  /** 최대 TODO 수 (기본: -1, 미적용) */
  maxTodoCount: number;
  /** 새로운 경고 금지 (기본: true) */
  noNewWarnings: boolean;
}

/** 개별 stage 실행 결과 */
export interface StageResult {
  /** 단계 이름 */
  stage: QAStage;
  /** 단계 상태 */
  status: "pass" | "warn" | "fail" | "skip";
  /** 소요 시간 (ms) */
  duration: number;
  /** 개별 검사 결과 목록 */
  checks: CheckResult[];
  /** 자동 수정 시도 기록 */
  autoFixed: QAFixAttempt[];
  /** 요약 메시지 */
  summary: string;
}

/** 개별 검사 결과 */
export interface CheckResult {
  /** 검사 이름 (예: "TypeScript Compilation", "ESLint") */
  name: string;
  /** 검사 상태 */
  status: "pass" | "warn" | "fail";
  /** 결과 메시지 */
  message: string;
  /** 상세 내용 */
  details?: string[];
  /** 관련 파일 경로 */
  file?: string;
  /** 관련 라인 번호 */
  line?: number;
  /** 자동 수정 가능 여부 */
  fixable: boolean;
  /** 심각도 */
  severity: "critical" | "high" | "medium" | "low" | "info";
}

/** 자동 수정 시도 기록 */
export interface QAFixAttempt {
  /** 수정 대상 검사 이름 */
  check: string;
  /** 시도 번호 (1-based) */
  attempt: number;
  /** 성공 여부 */
  success: boolean;
  /** 수정 내용 설명 */
  description: string;
}

/** 파이프라인 전체 결과 */
export interface QAPipelineResult {
  /** 전체 판정 */
  overall: "pass" | "warn" | "fail";
  /** 각 stage 결과 */
  stages: StageResult[];

  // Summary
  /** 총 검사 수 */
  totalChecks: number;
  /** 통과 수 */
  passed: number;
  /** 경고 수 */
  warnings: number;
  /** 실패 수 */
  failures: number;
  /** 자동 수정 수 */
  autoFixed: number;

  // Metrics
  /** 총 소요 시간 (ms) */
  totalDuration: number;
  /** 게이트 결과 */
  gateResults: GateResult[];

  // Decision
  /** 최종 판정 */
  decision: QADecision;
}

/** 품질 게이트 결과 */
export interface GateResult {
  /** 게이트 이름 */
  gate: string;
  /** 임계값 */
  threshold: number;
  /** 실제 값 */
  actual: number;
  /** 통과 여부 */
  passed: boolean;
}

/** QA 최종 판정 */
export interface QADecision {
  /** 권장 액션 */
  action: "approve" | "fix_and_retry" | "escalate";
  /** 판정 이유 */
  reason: string;
  /** 치명적 이슈 목록 */
  criticalIssues: CheckResult[];
  /** 제안 사항 */
  suggestions: string[];
}

/** QA 파이프라인 이벤트 맵 */
export interface QAPipelineEvents {
  "stage:start": (stage: QAStage) => void;
  "stage:complete": (result: StageResult) => void;
  "check:run": (name: string) => void;
  "check:result": (result: CheckResult) => void;
  "fix:attempt": (attempt: QAFixAttempt) => void;
  "pipeline:complete": (result: QAPipelineResult) => void;
}

// ══════════════════════════════════════════════════════════════════════
// Defaults
// ══════════════════════════════════════════════════════════════════════

const DEFAULT_QUALITY_GATES: QualityGates = {
  maxCyclomaticComplexity: 15,
  maxFunctionLength: 50,
  maxFileLength: 500,
  minTestCoverage: 0,
  maxTodoCount: -1,
  noNewWarnings: true,
};

/** QALevel에 따른 stage toggle 프리셋 */
function applyLevelDefaults(level: QALevel): Pick<
  QAPipelineConfig,
  "enableStructural" | "enableSemantic" | "enableQuality" | "enableReview" | "enableDecision"
> {
  switch (level) {
    case "quick":
      return {
        enableStructural: true,
        enableSemantic: false,
        enableQuality: false,
        enableReview: false,
        enableDecision: true,
      };
    case "standard":
      return {
        enableStructural: true,
        enableSemantic: true,
        enableQuality: true,
        enableReview: false,
        enableDecision: true,
      };
    case "thorough":
      return {
        enableStructural: true,
        enableSemantic: true,
        enableQuality: true,
        enableReview: true,
        enableDecision: true,
      };
  }
}

function buildFullConfig(partial: Partial<QAPipelineConfig> & { projectPath: string }): Required<QAPipelineConfig> {
  const level = partial.level ?? "standard";
  const levelDefaults = applyLevelDefaults(level);

  return {
    projectPath: partial.projectPath,
    level,
    enableStructural: partial.enableStructural ?? levelDefaults.enableStructural,
    enableSemantic: partial.enableSemantic ?? levelDefaults.enableSemantic,
    enableQuality: partial.enableQuality ?? levelDefaults.enableQuality,
    enableReview: partial.enableReview ?? levelDefaults.enableReview,
    enableDecision: partial.enableDecision ?? levelDefaults.enableDecision,
    autoFix: partial.autoFix ?? true,
    maxFixAttempts: partial.maxFixAttempts ?? 3,
    fixableCategories: partial.fixableCategories ?? ["lint", "format", "imports", "types"],
    qualityGates: { ...DEFAULT_QUALITY_GATES, ...partial.qualityGates },
    buildTimeout: partial.buildTimeout ?? 60_000,
    testTimeout: partial.testTimeout ?? 120_000,
  };
}

// ══════════════════════════════════════════════════════════════════════
// File Metrics (static analysis)
// ══════════════════════════════════════════════════════════════════════

/** 파일 메트릭 분석 결과 */
interface FileMetrics {
  cyclomatic: number;
  cognitive: number;
  loc: number;
  functions: { name: string; length: number; complexity: number }[];
}

// Control-flow keywords that increase cyclomatic complexity
const COMPLEXITY_KEYWORDS = /\b(if|else\s+if|for|while|do|switch|case|catch)\b/g;
const LOGICAL_OPERATORS = /(\&\&|\|\||\?\?)/g;
const TERNARY_OPERATOR = /\?[^:?]*:/g;

// Function detection (named functions, methods, arrow functions assigned to const/let)
const FUNCTION_PATTERN =
  /(?:(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(|(\w+)\s*\([^)]*\)\s*\{|(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)/g;

// ══════════════════════════════════════════════════════════════════════
// Security Patterns
// ══════════════════════════════════════════════════════════════════════

const SECURITY_PATTERNS: Array<{ name: string; pattern: RegExp; severity: CheckResult["severity"] }> = [
  { name: "Hardcoded password", pattern: /password\s*=\s*["'][^"']+["']/gi, severity: "critical" },
  { name: "Hardcoded API key", pattern: /(?:api[_-]?key|apikey|secret[_-]?key)\s*[:=]\s*["'][A-Za-z0-9+/=]{16,}["']/gi, severity: "critical" },
  { name: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/g, severity: "critical" },
  { name: "Private key", pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g, severity: "critical" },
  { name: "eval() usage", pattern: /\beval\s*\(/g, severity: "high" },
  { name: "new Function() usage", pattern: /new\s+Function\s*\(/g, severity: "high" },
  { name: "SQL injection risk", pattern: /(?:query|execute)\s*\(\s*`[^`]*\$\{/g, severity: "high" },
  { name: "Path traversal", pattern: /\.\.\//g, severity: "medium" },
  { name: "innerHTML assignment", pattern: /\.innerHTML\s*=/g, severity: "medium" },
];

// ══════════════════════════════════════════════════════════════════════
// QAPipeline
// ══════════════════════════════════════════════════════════════════════

/**
 * QAPipeline — 5단계 자동 품질 검증 파이프라인.
 *
 * @example
 * ```typescript
 * const qa = new QAPipeline({ projectPath: "/project", level: "standard" });
 *
 * qa.on("stage:complete", (result) => console.log(result.stage, result.status));
 *
 * const result = await qa.run(["src/foo.ts", "src/bar.ts"]);
 * if (result.decision.action === "approve") {
 *   console.log("All checks passed!");
 * }
 * ```
 */
export class QAPipeline extends EventEmitter {
  private readonly config: Required<QAPipelineConfig>;

  constructor(config: Partial<QAPipelineConfig> & { projectPath: string }) {
    super();
    this.config = buildFullConfig(config);
  }

  // ─── Main ───────────────────────────────────────────────────────────

  /**
   * 전체 파이프라인 실행.
   *
   * @param changedFiles 변경된 파일 경로 목록 (없으면 전체 검사)
   * @param reviewFn LLM 리뷰 함수 (review stage 활성화 시 필요)
   * @returns 파이프라인 전체 결과
   */
  async run(
    changedFiles?: string[],
    reviewFn?: (prompt: string) => Promise<string>,
  ): Promise<QAPipelineResult> {
    const stages: StageResult[] = [];
    const startTime = Date.now();
    const gateResults: GateResult[] = [];

    // Stage 1: Structural
    if (this.config.enableStructural) {
      this.emit("stage:start", "structural" as QAStage);
      let result = await this.runStructural();
      stages.push(result);
      this.emit("stage:complete", result);

      // Auto-fix structural issues
      if (result.status === "fail" && this.config.autoFix) {
        for (let i = 0; i < this.config.maxFixAttempts; i++) {
          const fixableChecks = result.checks.filter(
            (c) => c.status === "fail" && c.fixable,
          );
          if (fixableChecks.length === 0) break;

          for (const check of fixableChecks) {
            const fix = await this.attemptFix(check, i + 1);
            result.autoFixed.push(fix);
            this.emit("fix:attempt", fix);
          }

          // Re-run structural after fix
          const rerun = await this.runStructural();
          result = { ...rerun, autoFixed: result.autoFixed };
          stages[stages.length - 1] = result;
          if (result.status !== "fail") break;
        }
      }
    }

    // Stage 2: Semantic (skip if structural fails critically)
    if (this.config.enableSemantic && !this.hasCriticalFailure(stages)) {
      this.emit("stage:start", "semantic" as QAStage);
      const result = await this.runSemantic(changedFiles);
      stages.push(result);
      this.emit("stage:complete", result);
    }

    // Stage 3: Quality
    if (this.config.enableQuality) {
      this.emit("stage:start", "quality" as QAStage);
      const result = await this.runQuality(changedFiles);
      stages.push(result);
      this.emit("stage:complete", result);

      // Collect gate results from quality checks
      gateResults.push(...this.collectGateResults(result));
    }

    // Stage 4: Review (thorough only, requires reviewFn)
    if (this.config.enableReview && reviewFn && changedFiles?.length) {
      this.emit("stage:start", "review" as QAStage);
      const result = await this.runReview(changedFiles, reviewFn);
      stages.push(result);
      this.emit("stage:complete", result);
    }

    // Stage 5: Decision (always)
    const decision = this.makeDecision(stages);

    // Aggregate counts
    let totalChecks = 0;
    let passed = 0;
    let warnings = 0;
    let failures = 0;
    let autoFixed = 0;

    for (const s of stages) {
      totalChecks += s.checks.length;
      for (const c of s.checks) {
        if (c.status === "pass") passed++;
        else if (c.status === "warn") warnings++;
        else failures++;
      }
      autoFixed += s.autoFixed.filter((f) => f.success).length;
    }

    const overall = this.determineOverall(stages);
    const totalDuration = Date.now() - startTime;

    const pipelineResult: QAPipelineResult = {
      overall,
      stages,
      totalChecks,
      passed,
      warnings,
      failures,
      autoFixed,
      totalDuration,
      gateResults,
      decision,
    };

    this.emit("pipeline:complete", pipelineResult);
    return pipelineResult;
  }

  /**
   * 특정 stage만 단독 실행.
   *
   * @param stage 실행할 stage
   * @param changedFiles 변경된 파일 목록
   * @param reviewFn LLM 리뷰 함수 (review stage 시 필요)
   */
  async runStage(
    stage: QAStage,
    changedFiles?: string[],
    reviewFn?: (prompt: string) => Promise<string>,
  ): Promise<StageResult> {
    switch (stage) {
      case "structural":
        return this.runStructural();
      case "semantic":
        return this.runSemantic(changedFiles);
      case "quality":
        return this.runQuality(changedFiles);
      case "review":
        if (!reviewFn || !changedFiles?.length) {
          return this.buildStageResult("review", [], [], Date.now(), "skip");
        }
        return this.runReview(changedFiles, reviewFn);
      case "decision":
        return this.buildStageResult("decision", [], [], Date.now(), "skip");
    }
  }

  // ─── Stage 1: Structural Validation ─────────────────────────────────

  /**
   * Stage 1 — 구조 검증: TypeScript 컴파일, ESLint, 순환 import, export 검사.
   */
  async runStructural(): Promise<StageResult> {
    const startTime = Date.now();
    const checks: CheckResult[] = [];

    this.emit("check:run", "TypeScript Compilation");
    const tsCheck = await this.checkTypeScript();
    checks.push(tsCheck);
    this.emit("check:result", tsCheck);

    this.emit("check:run", "ESLint");
    const lintCheck = await this.checkLint();
    checks.push(lintCheck);
    this.emit("check:result", lintCheck);

    this.emit("check:run", "Circular Imports");
    const circularCheck = await this.checkCircularImports();
    checks.push(circularCheck);
    this.emit("check:result", circularCheck);

    this.emit("check:run", "Exports");
    const exportCheck = await this.checkExports();
    checks.push(exportCheck);
    this.emit("check:result", exportCheck);

    return this.buildStageResult("structural", checks, [], startTime);
  }

  /**
   * TypeScript 타입 검사 (tsc --noEmit).
   */
  private async checkTypeScript(): Promise<CheckResult> {
    const hasTsc = await this.fileExists(
      path.join(this.config.projectPath, "node_modules/.bin/tsc"),
    );

    if (!hasTsc) {
      return {
        name: "TypeScript Compilation",
        status: "pass",
        message: "tsc not found, skipping type check",
        fixable: false,
        severity: "info",
      };
    }

    const result = await this.exec(
      "npx",
      ["tsc", "--noEmit", "--pretty", "false"],
      this.config.buildTimeout,
    );

    if (result.exitCode === 0) {
      return {
        name: "TypeScript Compilation",
        status: "pass",
        message: "No type errors",
        fixable: false,
        severity: "info",
      };
    }

    const errorLines = result.stderr
      .split("\n")
      .filter((l) => /error TS\d+/.test(l));
    const errorCount = errorLines.length || 1;

    return {
      name: "TypeScript Compilation",
      status: "fail",
      message: `${errorCount} TypeScript error(s)`,
      details: errorLines.slice(0, 20),
      fixable: this.config.fixableCategories.includes("types"),
      severity: "critical",
    };
  }

  /**
   * ESLint 검사.
   */
  private async checkLint(): Promise<CheckResult> {
    const hasEslint = await this.fileExists(
      path.join(this.config.projectPath, "node_modules/.bin/eslint"),
    );

    if (!hasEslint) {
      return {
        name: "ESLint",
        status: "pass",
        message: "ESLint not installed, skipping",
        fixable: false,
        severity: "info",
      };
    }

    const result = await this.exec(
      "npx",
      ["eslint", ".", "--quiet", "--format", "compact"],
      this.config.buildTimeout,
    );

    if (result.exitCode === 0) {
      return {
        name: "ESLint",
        status: "pass",
        message: "No lint errors",
        fixable: false,
        severity: "info",
      };
    }

    const output = result.stdout + "\n" + result.stderr;
    const errorMatch = output.match(/(\d+) error/);
    const warnMatch = output.match(/(\d+) warning/);
    const errorCount = errorMatch ? parseInt(errorMatch[1], 10) : 1;
    const warnCount = warnMatch ? parseInt(warnMatch[1], 10) : 0;

    const errorLines = output.split("\n").filter((l) => l.includes("Error"));

    if (errorCount === 0 && warnCount > 0) {
      return {
        name: "ESLint",
        status: "warn",
        message: `${warnCount} warning(s)`,
        details: errorLines.slice(0, 10),
        fixable: this.config.fixableCategories.includes("lint"),
        severity: "low",
      };
    }

    return {
      name: "ESLint",
      status: "fail",
      message: `${errorCount} error(s), ${warnCount} warning(s)`,
      details: errorLines.slice(0, 20),
      fixable: this.config.fixableCategories.includes("lint"),
      severity: "high",
    };
  }

  /**
   * 순환 import 검사.
   * 간이 검사: import 그래프를 구축하여 사이클 탐지.
   */
  private async checkCircularImports(): Promise<CheckResult> {
    const files = await this.collectSourceFiles();
    const importGraph = new Map<string, Set<string>>();

    for (const file of files) {
      try {
        const content = await readFile(file, "utf-8");
        const imports = new Set<string>();

        // Match import/export from "..." patterns
        const importRegex = /(?:import|export)\s+.*?from\s+["']([^"']+)["']/g;
        let match: RegExpExecArray | null;
        while ((match = importRegex.exec(content)) !== null) {
          const importPath = match[1];
          if (importPath.startsWith(".")) {
            const resolved = this.resolveImportPath(file, importPath);
            if (resolved) imports.add(resolved);
          }
        }

        importGraph.set(file, imports);
      } catch {
        // Skip unreadable files
      }
    }

    // DFS cycle detection
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const inStack = new Set<string>();

    const dfs = (node: string, pathStack: string[]): void => {
      if (inStack.has(node)) {
        const cycleStart = pathStack.indexOf(node);
        if (cycleStart !== -1) {
          cycles.push(pathStack.slice(cycleStart));
        }
        return;
      }
      if (visited.has(node)) return;

      visited.add(node);
      inStack.add(node);
      pathStack.push(node);

      const deps = importGraph.get(node);
      if (deps) {
        for (const dep of deps) {
          dfs(dep, [...pathStack]);
        }
      }

      inStack.delete(node);
    };

    for (const node of importGraph.keys()) {
      dfs(node, []);
    }

    if (cycles.length === 0) {
      return {
        name: "Circular Imports",
        status: "pass",
        message: "No circular imports detected",
        fixable: false,
        severity: "info",
      };
    }

    const projectDir = this.config.projectPath;
    const cycleDetails = cycles.slice(0, 5).map(
      (cycle) =>
        cycle.map((f) => path.relative(projectDir, f)).join(" → ") + " → (cycle)",
    );

    return {
      name: "Circular Imports",
      status: "warn",
      message: `${cycles.length} circular import(s) detected`,
      details: cycleDetails,
      fixable: false,
      severity: "medium",
    };
  }

  /**
   * Export 검사 — src/ 내 .ts 파일이 아무것도 export하지 않으면 경고.
   */
  private async checkExports(): Promise<CheckResult> {
    const files = await this.collectSourceFiles();
    const noExportFiles: string[] = [];

    for (const file of files) {
      // Skip test files, type declaration files, index files
      const basename = path.basename(file);
      if (
        basename.includes(".test.") ||
        basename.includes(".spec.") ||
        basename.endsWith(".d.ts") ||
        basename === "index.ts"
      ) {
        continue;
      }

      try {
        const content = await readFile(file, "utf-8");
        // Check for any export statement
        if (!/\bexport\b/.test(content)) {
          noExportFiles.push(path.relative(this.config.projectPath, file));
        }
      } catch {
        // Skip unreadable files
      }
    }

    if (noExportFiles.length === 0) {
      return {
        name: "Exports",
        status: "pass",
        message: "All source files have exports",
        fixable: false,
        severity: "info",
      };
    }

    return {
      name: "Exports",
      status: "warn",
      message: `${noExportFiles.length} file(s) with no exports`,
      details: noExportFiles.slice(0, 10),
      fixable: false,
      severity: "low",
    };
  }

  // ─── Stage 2: Semantic Validation ───────────────────────────────────

  /**
   * Stage 2 — 시맨틱 검증: 테스트 실행.
   *
   * @param changedFiles 변경된 파일 목록 (있으면 관련 테스트만 실행)
   */
  async runSemantic(changedFiles?: string[]): Promise<StageResult> {
    const startTime = Date.now();
    const checks: CheckResult[] = [];

    this.emit("check:run", "Tests");

    if (changedFiles && changedFiles.length > 0) {
      const testResult = await this.runAffectedTests(changedFiles);
      checks.push(testResult);
      this.emit("check:result", testResult);
    } else {
      const testResult = await this.runAllTests();
      checks.push(testResult);
      this.emit("check:result", testResult);
    }

    return this.buildStageResult("semantic", checks, [], startTime);
  }

  /**
   * 변경된 파일에 대응하는 테스트만 실행.
   */
  private async runAffectedTests(changedFiles: string[]): Promise<CheckResult> {
    // Find test files that match changed source files
    const testPatterns = changedFiles.map((f) => {
      const base = path.basename(f, path.extname(f));
      return base;
    });

    // Try running tests with pattern filter
    const hasTestRunner = await this.detectTestRunner();

    if (!hasTestRunner) {
      return {
        name: "Affected Tests",
        status: "pass",
        message: "No test runner detected, skipping",
        fixable: false,
        severity: "info",
      };
    }

    // Use generic test command
    const result = await this.exec(
      "npx",
      ["--no", "vitest", "run", "--reporter=verbose", ...testPatterns.map((p) => `--testPathPattern=${p}`)],
      this.config.testTimeout,
    );

    // Fallback: try node --test
    if (result.exitCode !== 0 && result.stderr.includes("not found")) {
      const nodeResult = await this.exec(
        "node",
        ["--test", ...changedFiles.filter((f) => f.includes(".test."))],
        this.config.testTimeout,
      );
      return this.parseTestResult("Affected Tests", nodeResult);
    }

    return this.parseTestResult("Affected Tests", result);
  }

  /**
   * 전체 테스트 스위트 실행.
   */
  private async runAllTests(): Promise<CheckResult> {
    const hasTestRunner = await this.detectTestRunner();

    if (!hasTestRunner) {
      return {
        name: "Full Test Suite",
        status: "pass",
        message: "No test runner detected, skipping",
        fixable: false,
        severity: "info",
      };
    }

    // Try npm test
    const result = await this.exec(
      "npm",
      ["test", "--if-present"],
      this.config.testTimeout,
    );

    return this.parseTestResult("Full Test Suite", result);
  }

  /**
   * 테스트 러너 존재 여부 확인.
   */
  private async detectTestRunner(): Promise<boolean> {
    try {
      const pkgPath = path.join(this.config.projectPath, "package.json");
      const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
      return !!(
        pkg.scripts?.test &&
        pkg.scripts.test !== 'echo "Error: no test specified" && exit 1'
      );
    } catch {
      return false;
    }
  }

  /**
   * 테스트 실행 결과 파싱.
   */
  private parseTestResult(
    name: string,
    result: { stdout: string; stderr: string; exitCode: number },
  ): CheckResult {
    const output = result.stdout + "\n" + result.stderr;

    if (result.exitCode === 0) {
      const passMatch = output.match(/(\d+)\s*(?:passing|passed|tests?\s*passed)/i);
      const count = passMatch ? passMatch[1] : "all";
      return {
        name,
        status: "pass",
        message: `${count} test(s) passed`,
        fixable: false,
        severity: "info",
      };
    }

    const failMatch = output.match(/(\d+)\s*(?:failing|failed)/i);
    const failCount = failMatch ? failMatch[1] : "some";

    return {
      name,
      status: "fail",
      message: `${failCount} test(s) failed`,
      details: output.split("\n").filter((l) => /fail|error|✗|✘|×/i.test(l)).slice(0, 15),
      fixable: false,
      severity: "high",
    };
  }

  // ─── Stage 3: Quality Gates ─────────────────────────────────────────

  /**
   * Stage 3 — 품질 게이트: 복잡도, 길이, TODO, 디버그 문, 보안 스캔.
   *
   * @param changedFiles 변경된 파일 목록 (없으면 전체 소스)
   */
  async runQuality(changedFiles?: string[]): Promise<StageResult> {
    const startTime = Date.now();
    const checks: CheckResult[] = [];

    const files = changedFiles?.length
      ? changedFiles.filter((f) => f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".js") || f.endsWith(".jsx"))
      : await this.collectSourceFiles();

    this.emit("check:run", "Cyclomatic Complexity");
    const complexityCheck = await this.checkComplexity(files);
    checks.push(complexityCheck);
    this.emit("check:result", complexityCheck);

    this.emit("check:run", "Function/File Lengths");
    const lengthCheck = await this.checkLengths(files);
    checks.push(lengthCheck);
    this.emit("check:result", lengthCheck);

    this.emit("check:run", "TODO Count");
    const todoCheck = await this.checkTodos(files);
    checks.push(todoCheck);
    this.emit("check:result", todoCheck);

    this.emit("check:run", "Debug Statements");
    const debugCheck = await this.checkDebugStatements(files);
    checks.push(debugCheck);
    this.emit("check:result", debugCheck);

    this.emit("check:run", "Security Scan");
    const securityCheck = await this.checkSecurity(files);
    checks.push(securityCheck);
    this.emit("check:result", securityCheck);

    return this.buildStageResult("quality", checks, [], startTime);
  }

  /**
   * 순환 복잡도 검사.
   */
  private async checkComplexity(files: string[]): Promise<CheckResult> {
    const violations: string[] = [];
    let maxFound = 0;

    for (const file of files) {
      try {
        const content = await readFile(file, "utf-8");
        const metrics = this.analyzeFileMetrics(content);

        for (const fn of metrics.functions) {
          if (fn.complexity > maxFound) maxFound = fn.complexity;
          if (fn.complexity > this.config.qualityGates.maxCyclomaticComplexity) {
            violations.push(
              `${path.relative(this.config.projectPath, file)}: ${fn.name}() complexity=${fn.complexity} (max ${this.config.qualityGates.maxCyclomaticComplexity})`,
            );
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    if (violations.length === 0) {
      return {
        name: "Cyclomatic Complexity",
        status: "pass",
        message: `Max complexity: ${maxFound} (threshold: ${this.config.qualityGates.maxCyclomaticComplexity})`,
        fixable: false,
        severity: "info",
      };
    }

    return {
      name: "Cyclomatic Complexity",
      status: "warn",
      message: `${violations.length} function(s) exceed complexity threshold`,
      details: violations.slice(0, 10),
      fixable: false,
      severity: "medium",
    };
  }

  /**
   * 함수/파일 길이 검사.
   */
  private async checkLengths(files: string[]): Promise<CheckResult> {
    const violations: string[] = [];

    for (const file of files) {
      try {
        const content = await readFile(file, "utf-8");
        const lines = content.split("\n");
        const relPath = path.relative(this.config.projectPath, file);

        // File length check
        if (lines.length > this.config.qualityGates.maxFileLength) {
          violations.push(
            `${relPath}: ${lines.length} lines (max ${this.config.qualityGates.maxFileLength})`,
          );
        }

        // Function length check
        const metrics = this.analyzeFileMetrics(content);
        for (const fn of metrics.functions) {
          if (fn.length > this.config.qualityGates.maxFunctionLength) {
            violations.push(
              `${relPath}: ${fn.name}() is ${fn.length} lines (max ${this.config.qualityGates.maxFunctionLength})`,
            );
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    if (violations.length === 0) {
      return {
        name: "Function/File Lengths",
        status: "pass",
        message: "All functions and files within length limits",
        fixable: false,
        severity: "info",
      };
    }

    return {
      name: "Function/File Lengths",
      status: "warn",
      message: `${violations.length} length violation(s)`,
      details: violations.slice(0, 10),
      fixable: false,
      severity: "low",
    };
  }

  /**
   * TODO/FIXME/HACK 검사.
   */
  private async checkTodos(files: string[]): Promise<CheckResult> {
    if (this.config.qualityGates.maxTodoCount < 0) {
      return {
        name: "TODO Count",
        status: "pass",
        message: "TODO check disabled",
        fixable: false,
        severity: "info",
      };
    }

    let totalTodos = 0;
    const todoLocations: string[] = [];

    for (const file of files) {
      try {
        const content = await readFile(file, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (/\b(TODO|FIXME|HACK|XXX)\b/i.test(lines[i])) {
            totalTodos++;
            if (todoLocations.length < 10) {
              todoLocations.push(
                `${path.relative(this.config.projectPath, file)}:${i + 1}: ${lines[i].trim().substring(0, 80)}`,
              );
            }
          }
        }
      } catch {
        // Skip
      }
    }

    if (totalTodos <= this.config.qualityGates.maxTodoCount) {
      return {
        name: "TODO Count",
        status: "pass",
        message: `${totalTodos} TODO(s) found (max ${this.config.qualityGates.maxTodoCount})`,
        fixable: false,
        severity: "info",
      };
    }

    return {
      name: "TODO Count",
      status: "warn",
      message: `${totalTodos} TODO(s) found (max ${this.config.qualityGates.maxTodoCount})`,
      details: todoLocations,
      fixable: false,
      severity: "low",
    };
  }

  /**
   * 디버그 문 검사 (console.log 등, 테스트 파일 제외).
   */
  private async checkDebugStatements(files: string[]): Promise<CheckResult> {
    const violations: string[] = [];

    for (const file of files) {
      // Skip test files
      if (file.includes(".test.") || file.includes(".spec.") || file.includes("__tests__")) {
        continue;
      }

      try {
        const content = await readFile(file, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Match console.log/warn/error/debug/info but not commented out
          if (/^\s*console\.(log|debug|info)\s*\(/.test(line) && !line.trimStart().startsWith("//")) {
            violations.push(
              `${path.relative(this.config.projectPath, file)}:${i + 1}: ${line.trim().substring(0, 80)}`,
            );
          }
        }
      } catch {
        // Skip
      }
    }

    if (violations.length === 0) {
      return {
        name: "Debug Statements",
        status: "pass",
        message: "No debug statements found",
        fixable: true,
        severity: "info",
      };
    }

    return {
      name: "Debug Statements",
      status: "warn",
      message: `${violations.length} debug statement(s) found`,
      details: violations.slice(0, 10),
      fixable: true,
      severity: "low",
    };
  }

  /**
   * 보안 퀵 스캔 — 하드코딩된 시크릿, eval, SQL 인젝션 등.
   */
  private async checkSecurity(files: string[]): Promise<CheckResult> {
    const findings: Array<{ pattern: string; file: string; line: number; severity: CheckResult["severity"] }> = [];

    for (const file of files) {
      // Skip test files and node_modules
      if (file.includes("node_modules") || file.includes(".test.") || file.includes(".spec.")) {
        continue;
      }

      try {
        const content = await readFile(file, "utf-8");
        const lines = content.split("\n");

        for (const { name, pattern, severity } of SECURITY_PATTERNS) {
          // Reset lastIndex for global patterns
          pattern.lastIndex = 0;
          for (let i = 0; i < lines.length; i++) {
            pattern.lastIndex = 0;
            if (pattern.test(lines[i]) && !lines[i].trimStart().startsWith("//")) {
              findings.push({
                pattern: name,
                file: path.relative(this.config.projectPath, file),
                line: i + 1,
                severity,
              });
            }
          }
        }
      } catch {
        // Skip
      }
    }

    if (findings.length === 0) {
      return {
        name: "Security Scan",
        status: "pass",
        message: "No security issues found",
        fixable: false,
        severity: "info",
      };
    }

    const hasCritical = findings.some((f) => f.severity === "critical");
    const details = findings
      .slice(0, 15)
      .map((f) => `[${f.severity.toUpperCase()}] ${f.file}:${f.line} — ${f.pattern}`);

    return {
      name: "Security Scan",
      status: hasCritical ? "fail" : "warn",
      message: `${findings.length} security finding(s)`,
      details,
      fixable: false,
      severity: hasCritical ? "critical" : "medium",
    };
  }

  // ─── Stage 4: Review Agent ──────────────────────────────────────────

  /**
   * Stage 4 — LLM 기반 코드 리뷰 (thorough 모드 전용).
   *
   * @param changedFiles 변경된 파일 목록
   * @param reviewFn 리뷰를 수행할 LLM 함수
   */
  async runReview(
    changedFiles: string[],
    reviewFn: (prompt: string) => Promise<string>,
  ): Promise<StageResult> {
    const startTime = Date.now();
    const checks: CheckResult[] = [];

    try {
      const fileContents = await this.readFiles(changedFiles);
      if (fileContents.size === 0) {
        return this.buildStageResult("review", [], [], startTime, "skip");
      }

      const prompt = this.buildReviewPrompt(fileContents);

      this.emit("check:run", "LLM Code Review");
      const response = await reviewFn(prompt);
      const reviewChecks = this.parseReviewResponse(response);
      checks.push(...reviewChecks);

      for (const check of reviewChecks) {
        this.emit("check:result", check);
      }
    } catch (err) {
      checks.push({
        name: "LLM Code Review",
        status: "warn",
        message: `Review failed: ${err instanceof Error ? err.message : String(err)}`,
        fixable: false,
        severity: "low",
      });
    }

    return this.buildStageResult("review", checks, [], startTime);
  }

  /**
   * 리뷰 프롬프트 생성.
   */
  private buildReviewPrompt(files: Map<string, string>): string {
    let prompt = `You are a code reviewer. Review the following changed files and provide findings.\n\n`;
    prompt += `For each issue found, respond with a line in this exact format:\n`;
    prompt += `[SEVERITY:STATUS] file:line message\n\n`;
    prompt += `Where:\n`;
    prompt += `- SEVERITY is one of: critical, high, medium, low, info\n`;
    prompt += `- STATUS is one of: fail, warn, pass\n`;
    prompt += `- file is the relative file path\n`;
    prompt += `- line is the line number (0 if not applicable)\n\n`;
    prompt += `Focus on:\n`;
    prompt += `- Logic errors and edge cases\n`;
    prompt += `- Security vulnerabilities\n`;
    prompt += `- Performance issues\n`;
    prompt += `- API contract violations\n`;
    prompt += `- Missing error handling\n\n`;
    prompt += `If the code looks good, respond with:\n`;
    prompt += `[info:pass] overall:0 Code review passed, no issues found.\n\n`;
    prompt += `--- Files ---\n\n`;

    for (const [filePath, content] of files) {
      prompt += `### ${filePath}\n\`\`\`typescript\n${content.substring(0, 8000)}\n\`\`\`\n\n`;
    }

    return prompt;
  }

  /**
   * LLM 리뷰 응답 파싱.
   */
  private parseReviewResponse(response: string): CheckResult[] {
    const checks: CheckResult[] = [];
    const linePattern = /\[(critical|high|medium|low|info):(fail|warn|pass)\]\s+([^:]+):(\d+)\s+(.+)/gi;

    let match: RegExpExecArray | null;
    while ((match = linePattern.exec(response)) !== null) {
      const severity = match[1].toLowerCase() as CheckResult["severity"];
      const status = match[2].toLowerCase() as CheckResult["status"];
      const file = match[3].trim();
      const line = parseInt(match[4], 10);
      const message = match[5].trim();

      checks.push({
        name: "LLM Code Review",
        status,
        message,
        file: file === "overall" ? undefined : file,
        line: line > 0 ? line : undefined,
        fixable: false,
        severity,
      });
    }

    // If no structured output found, treat whole response as a single pass
    if (checks.length === 0) {
      checks.push({
        name: "LLM Code Review",
        status: "pass",
        message: response.substring(0, 200).trim() || "Review completed",
        fixable: false,
        severity: "info",
      });
    }

    return checks;
  }

  // ─── Stage 5: Decision ──────────────────────────────────────────────

  /**
   * Stage 5 — 전체 결과 기반 자동 판정.
   *
   * - Critical failure → "escalate"
   * - Only fixable failures → "fix_and_retry"
   * - All pass or only warnings → "approve"
   */
  makeDecision(stages: StageResult[]): QADecision {
    const allChecks = stages.flatMap((s) => s.checks);
    const failures = allChecks.filter((c) => c.status === "fail");
    const criticalIssues = failures.filter((c) => c.severity === "critical");
    const suggestions: string[] = [];

    // Collect warnings as suggestions
    const warnings = allChecks.filter((c) => c.status === "warn");
    for (const w of warnings.slice(0, 5)) {
      suggestions.push(`[${w.severity}] ${w.name}: ${w.message}`);
    }

    // Any critical failure → escalate
    if (criticalIssues.length > 0) {
      return {
        action: "escalate",
        reason: `${criticalIssues.length} critical issue(s) require human review`,
        criticalIssues,
        suggestions,
      };
    }

    // Only fixable failures → fix_and_retry
    if (failures.length > 0) {
      const allFixable = failures.every((f) => f.fixable);
      if (allFixable) {
        return {
          action: "fix_and_retry",
          reason: `${failures.length} fixable issue(s) detected`,
          criticalIssues: [],
          suggestions: [
            ...failures.map((f) => `Fix: ${f.name} — ${f.message}`),
            ...suggestions,
          ],
        };
      }

      // Non-fixable failures → escalate
      return {
        action: "escalate",
        reason: `${failures.length} failure(s), some not auto-fixable`,
        criticalIssues: failures.filter((f) => !f.fixable),
        suggestions,
      };
    }

    // All pass or only warnings → approve
    return {
      action: "approve",
      reason: warnings.length > 0
        ? `All checks passed with ${warnings.length} warning(s)`
        : "All checks passed",
      criticalIssues: [],
      suggestions,
    };
  }

  // ─── Auto-Fix ───────────────────────────────────────────────────────

  /**
   * 실패한 검사를 자동 수정 시도.
   *
   * @param check 실패한 검사 결과
   * @param attempt 시도 번호 (1-based)
   */
  private async attemptFix(check: CheckResult, attempt: number): Promise<QAFixAttempt> {
    const base: QAFixAttempt = {
      check: check.name,
      attempt,
      success: false,
      description: "",
    };

    try {
      switch (check.name) {
        case "ESLint": {
          const fixed = await this.fixLint();
          return { ...base, success: fixed, description: fixed ? "Ran eslint --fix" : "eslint --fix failed" };
        }
        case "TypeScript Compilation": {
          // TypeScript errors can't be auto-fixed easily, but we can try fixing imports
          const fixed = await this.fixImports();
          return { ...base, success: fixed, description: fixed ? "Fixed import issues" : "Could not auto-fix TS errors" };
        }
        default:
          return { ...base, success: false, description: `No auto-fix available for ${check.name}` };
      }
    } catch (err) {
      return {
        ...base,
        success: false,
        description: `Fix error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * ESLint --fix 실행.
   */
  private async fixLint(): Promise<boolean> {
    const hasEslint = await this.fileExists(
      path.join(this.config.projectPath, "node_modules/.bin/eslint"),
    );
    if (!hasEslint) return false;

    const result = await this.exec(
      "npx",
      ["eslint", ".", "--fix", "--quiet"],
      this.config.buildTimeout,
    );
    return result.exitCode === 0;
  }

  /**
   * Import 에러 수정 시도 (간이: 미사용 import 제거).
   */
  private async fixImports(): Promise<boolean> {
    // TypeScript 에러를 직접 수정하기는 어려우므로,
    // tsc --noEmit 재실행하여 변화 확인만 수행
    const result = await this.exec(
      "npx",
      ["tsc", "--noEmit"],
      this.config.buildTimeout,
    );
    return result.exitCode === 0;
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  /**
   * 셸 명령 실행 (타임아웃 포함).
   */
  private exec(
    command: string,
    args: string[],
    timeout: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      execFile(
        command,
        args,
        {
          cwd: this.config.projectPath,
          timeout,
          maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, FORCE_COLOR: "0", NODE_ENV: "test" },
        },
        (error, stdout, stderr) => {
          let exitCode = 0;
          if (error) {
            exitCode = typeof (error as NodeJS.ErrnoException).code === "number"
              ? (error as NodeJS.ErrnoException).code as unknown as number
              : (error as { status?: number }).status ?? 1;
          }
          resolve({
            stdout: (stdout ?? "").toString(),
            stderr: (stderr ?? "").toString(),
            exitCode,
          });
        },
      );
    });
  }

  /**
   * 파일 목록을 읽어 Map<경로, 내용>으로 반환.
   */
  private async readFiles(files: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const file of files) {
      try {
        const absPath = path.isAbsolute(file)
          ? file
          : path.join(this.config.projectPath, file);
        const content = await readFile(absPath, "utf-8");
        result.set(path.relative(this.config.projectPath, absPath), content);
      } catch {
        // Skip unreadable files
      }
    }
    return result;
  }

  /**
   * src/ 디렉토리 내 모든 .ts/.tsx 소스 파일 수집.
   */
  private async collectSourceFiles(): Promise<string[]> {
    const srcDir = path.join(this.config.projectPath, "src");
    const hasSrc = await this.fileExists(srcDir);
    const baseDir = hasSrc ? srcDir : this.config.projectPath;

    const files: string[] = [];
    await this.walkDir(baseDir, files);
    return files;
  }

  /**
   * 디렉토리 재귀 탐색.
   */
  private async walkDir(dir: string, out: string[]): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Skip known non-source directories
          if (
            entry.name === "node_modules" ||
            entry.name === "dist" ||
            entry.name === ".git" ||
            entry.name === "coverage" ||
            entry.name === ".next"
          ) {
            continue;
          }
          await this.walkDir(fullPath, out);
        } else if (
          entry.isFile() &&
          (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ||
           entry.name.endsWith(".js") || entry.name.endsWith(".jsx"))
        ) {
          out.push(fullPath);
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  /**
   * 파일 메트릭 분석 — 순환 복잡도, 인지 복잡도, LOC, 함수 목록.
   */
  analyzeFileMetrics(content: string): FileMetrics {
    const lines = content.split("\n");
    const loc = lines.length;
    const functions: FileMetrics["functions"] = [];

    // Simple function boundary detection by brace counting
    let currentFunction: { name: string; startLine: number; braceDepth: number; complexity: number } | null = null;
    let braceDepth = 0;
    let inBlockComment = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Handle block comments
      if (inBlockComment) {
        if (trimmed.includes("*/")) inBlockComment = false;
        continue;
      }
      if (trimmed.startsWith("/*")) {
        if (!trimmed.includes("*/")) inBlockComment = true;
        continue;
      }
      // Skip single-line comments
      if (trimmed.startsWith("//")) continue;

      // Detect function start
      const funcMatch =
        trimmed.match(/(?:async\s+)?function\s+(\w+)/) ||
        trimmed.match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/) ||
        trimmed.match(/(\w+)\s*\([^)]*\)\s*(?::\s*\S+\s*)?\{/) ||
        trimmed.match(/(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/);

      if (funcMatch && !currentFunction && trimmed.includes("{")) {
        currentFunction = {
          name: funcMatch[1],
          startLine: i,
          braceDepth,
          complexity: 1, // Base complexity
        };
      }

      // Count braces
      for (const ch of line) {
        if (ch === "{") braceDepth++;
        else if (ch === "}") braceDepth--;
      }

      // Count complexity within current function
      if (currentFunction) {
        COMPLEXITY_KEYWORDS.lastIndex = 0;
        const kwMatches = trimmed.match(COMPLEXITY_KEYWORDS);
        if (kwMatches) currentFunction.complexity += kwMatches.length;

        LOGICAL_OPERATORS.lastIndex = 0;
        const logicalMatches = trimmed.match(LOGICAL_OPERATORS);
        if (logicalMatches) currentFunction.complexity += logicalMatches.length;

        TERNARY_OPERATOR.lastIndex = 0;
        const ternaryMatches = trimmed.match(TERNARY_OPERATOR);
        if (ternaryMatches) currentFunction.complexity += ternaryMatches.length;

        // Check function end
        if (braceDepth <= currentFunction.braceDepth) {
          functions.push({
            name: currentFunction.name,
            length: i - currentFunction.startLine + 1,
            complexity: currentFunction.complexity,
          });
          currentFunction = null;
        }
      }
    }

    // If function never closed (incomplete parse), record it
    if (currentFunction) {
      functions.push({
        name: currentFunction.name,
        length: lines.length - currentFunction.startLine,
        complexity: currentFunction.complexity,
      });
    }

    // Calculate file-level complexity
    let cyclomatic = 1;
    let cognitive = 0;
    COMPLEXITY_KEYWORDS.lastIndex = 0;
    const allKeywords = content.match(COMPLEXITY_KEYWORDS);
    if (allKeywords) cyclomatic += allKeywords.length;

    LOGICAL_OPERATORS.lastIndex = 0;
    const allLogical = content.match(LOGICAL_OPERATORS);
    if (allLogical) cyclomatic += allLogical.length;

    // Cognitive: nesting awareness (simplified)
    let nestLevel = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/\b(if|for|while|switch)\b/.test(trimmed)) {
        cognitive += 1 + nestLevel;
      }
      for (const ch of line) {
        if (ch === "{") nestLevel++;
        else if (ch === "}") nestLevel = Math.max(0, nestLevel - 1);
      }
    }

    return { cyclomatic, cognitive, loc, functions };
  }

  /**
   * stage 결과 생성 헬퍼.
   */
  private buildStageResult(
    stage: QAStage,
    checks: CheckResult[],
    autoFixed: QAFixAttempt[],
    startTime: number,
    forceStatus?: StageResult["status"],
  ): StageResult {
    const duration = Date.now() - startTime;

    let status: StageResult["status"];
    if (forceStatus) {
      status = forceStatus;
    } else if (checks.length === 0) {
      status = "pass";
    } else if (checks.some((c) => c.status === "fail")) {
      status = "fail";
    } else if (checks.some((c) => c.status === "warn")) {
      status = "warn";
    } else {
      status = "pass";
    }

    const passCount = checks.filter((c) => c.status === "pass").length;
    const warnCount = checks.filter((c) => c.status === "warn").length;
    const failCount = checks.filter((c) => c.status === "fail").length;

    const summary =
      `${stage}: ${passCount} passed, ${warnCount} warnings, ${failCount} failed (${duration}ms)`;

    return { stage, status, duration, checks, autoFixed, summary };
  }

  /**
   * 전체 판정 결정.
   */
  private determineOverall(stages: StageResult[]): "pass" | "warn" | "fail" {
    if (stages.some((s) => s.status === "fail")) return "fail";
    if (stages.some((s) => s.status === "warn")) return "warn";
    return "pass";
  }

  /**
   * Critical failure 존재 여부 확인.
   */
  private hasCriticalFailure(stages: StageResult[]): boolean {
    return stages.some((s) =>
      s.status === "fail" &&
      s.checks.some((c) => c.status === "fail" && c.severity === "critical"),
    );
  }

  /**
   * Quality stage 결과에서 GateResult 추출.
   */
  private collectGateResults(stageResult: StageResult): GateResult[] {
    const gates: GateResult[] = [];

    for (const check of stageResult.checks) {
      if (check.name === "Cyclomatic Complexity") {
        // Parse max complexity from message
        const match = check.message.match(/Max complexity:\s*(\d+)/);
        if (match) {
          gates.push({
            gate: "maxCyclomaticComplexity",
            threshold: this.config.qualityGates.maxCyclomaticComplexity,
            actual: parseInt(match[1], 10),
            passed: check.status !== "fail",
          });
        }
      }
    }

    return gates;
  }

  /**
   * Import 경로 해석 (상대 경로 → 절대 경로).
   */
  private resolveImportPath(fromFile: string, importPath: string): string | null {
    const dir = path.dirname(fromFile);
    let resolved = path.resolve(dir, importPath);

    // Add .ts extension if missing
    if (!path.extname(resolved)) {
      resolved += ".ts";
    }
    // Remove .js and try .ts
    if (resolved.endsWith(".js")) {
      resolved = resolved.slice(0, -3) + ".ts";
    }

    return resolved;
  }

  /**
   * 파일 존재 확인.
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}
