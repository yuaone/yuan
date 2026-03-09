/**
 * @module memory-updater
 * @description YUAN Memory Auto-Updater — 완료된 에이전트 실행에서 풍부한 학습 신호를 추출.
 *
 * 기존 `updateMemoryAfterRun()`은 "Task X changed N files" 수준의 기록만 남겼지만,
 * MemoryUpdater는 도구 사용 패턴, 파일 공변 패턴, 성능 지표, 에러 해결 패턴,
 * 코딩 규칙 자동 탐지 등을 추출하여 MemoryManager에 전달한다.
 *
 * 모든 메서드는 동기(synchronous) — 파일 I/O는 MemoryManager가 담당.
 */

import { basename, dirname, extname } from "node:path";

// ─── Types ───

/** 도구 사용 패턴 */
export interface ToolPattern {
  /** 도구 이름 */
  tool: string;
  /** 호출 횟수 */
  count: number;
  /** 성공률 (0–1) */
  successRate: number;
  /** 평균 실행 시간 (ms) */
  avgDurationMs: number;
}

/** 파일 공변 패턴 — 함께 변경되는 파일 그룹 */
export interface CoChangePattern {
  /** 함께 변경된 파일 경로들 */
  files: string[];
  /** 발견 빈도 */
  frequency: number;
  /** 패턴 설명 (예: "test + implementation") */
  context: string;
}

/** 실행 성능 요약 */
export interface PerfSummary {
  /** 반복 횟수 */
  iterations: number;
  /** 총 토큰 사용량 */
  totalTokens: number;
  /** 반복당 토큰 사용량 */
  tokensPerIteration: number;
  /** 총 실행 시간 (ms) */
  durationMs: number;
  /** 효율성 (0–1, 유용한 작업 비율) */
  efficiency: number;
}

/** 에러 패턴 — 발생한 에러와 해결 방법 */
export interface ErrorPattern {
  /** 에러 유형 (예: "TypeScriptError", "LintError") */
  type: string;
  /** 에러 메시지 */
  message: string;
  /** 에러가 발생한 도구 */
  tool: string;
  /** 해결 방법 (null이면 미해결) */
  resolution: string | null;
  /** 발생 빈도 */
  frequency: number;
}

/** 실행 분석 결과 전체 */
export interface RunAnalysis {
  /** 도구 사용 패턴 */
  toolPatterns: ToolPattern[];
  /** 파일 공변 패턴 */
  coChangePatterns: CoChangePattern[];
  /** 성능 요약 */
  perfSummary: PerfSummary;
  /** 에러 패턴 */
  errorPatterns: ErrorPattern[];
  /** 탐지된 코딩 규칙 */
  conventions: string[];
}

/** MemoryUpdater 설정 */
export interface MemoryUpdaterConfig {
  /** 학습 저장 최소 확신도 (기본 0.2) */
  minConfidence?: number;
  /** 실행 1회당 최대 학습 수 (기본 5) */
  maxLearningsPerRun?: number;
  /** 코딩 규칙 자동 탐지 활성화 (기본 true) */
  detectConventions?: boolean;
}

/** analyzeRun 입력 파라미터 */
export interface AnalyzeRunParams {
  goal: string;
  termination: { reason: string; error?: string; summary?: string };
  toolResults: ToolResultEntry[];
  changedFiles: string[];
  messages: Array<{ role: string; content: string | null }>;
  tokensUsed: number;
  durationMs: number;
  iterations: number;
}

/** 도구 실행 결과 엔트리 */
export interface ToolResultEntry {
  name: string;
  output: string;
  success: boolean;
  durationMs?: number;
}

// ─── Constants ───

const DEFAULT_MIN_CONFIDENCE = 0.2;
const DEFAULT_MAX_LEARNINGS = 5;

/** 에러 유형 분류를 위한 패턴 매핑 */
const ERROR_TYPE_PATTERNS: Array<[RegExp, string]> = [
  [/TS\d{4,5}|typescript|tsc/i, "TypeScriptError"],
  [/eslint|lint/i, "LintError"],
  [/ENOENT|no such file/i, "FileNotFoundError"],
  [/permission denied|EACCES/i, "PermissionError"],
  [/FAIL|test (failed|failure)/i, "TestFailure"],
  [/syntax ?error/i, "SyntaxError"],
  [/module not found|cannot find module/i, "ModuleNotFoundError"],
  [/timeout|ETIMEDOUT/i, "TimeoutError"],
];

/** 테스트 파일 패턴 */
const TEST_FILE_PATTERNS = [/\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/, /__tests__\//];

// ─── MemoryUpdater ───

/**
 * MemoryUpdater — 완료된 에이전트 실행을 분석하여 학습 신호를 추출.
 *
 * 추출된 학습은 MemoryManager.addLearning()으로 저장할 수 있는
 * `{ category, content }` 형태로 변환된다.
 */
export class MemoryUpdater {
  private readonly minConfidence: number;
  private readonly maxLearningsPerRun: number;
  private readonly shouldDetectConventions: boolean;

  constructor(config?: MemoryUpdaterConfig) {
    this.minConfidence = config?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    this.maxLearningsPerRun = config?.maxLearningsPerRun ?? DEFAULT_MAX_LEARNINGS;
    this.shouldDetectConventions = config?.detectConventions ?? true;
  }

  /**
   * 완료된 실행을 분석하여 RunAnalysis를 반환.
   */
  analyzeRun(params: AnalyzeRunParams): RunAnalysis {
    const { toolResults, changedFiles, messages, tokensUsed, durationMs, iterations } = params;

    const toolPatterns = this.buildToolPatterns(toolResults);
    const coChangePatterns = this.detectCoChangePatterns(changedFiles);
    const perfSummary = this.buildPerfSummary(toolResults, tokensUsed, durationMs, iterations);
    const errorPatterns = this.extractErrorPatterns(toolResults, messages);
    const conventions = this.shouldDetectConventions ? this.detectConventions(toolResults) : [];

    return { toolPatterns, coChangePatterns, perfSummary, errorPatterns, conventions };
  }

  /**
   * RunAnalysis를 MemoryManager에 저장할 학습 목록으로 변환.
   * 확신도(minConfidence)를 넘는 항목만, 최대 maxLearningsPerRun개까지 반환.
   */
  extractLearnings(
    analysis: RunAnalysis,
    goal: string,
  ): Array<{ category: string; content: string }> {
    const candidates: Array<{ category: string; content: string; confidence: number }> = [];

    // 도구 패턴에서 학습 추출
    for (const tp of analysis.toolPatterns) {
      if (tp.count >= 3 && tp.successRate < 0.5) {
        candidates.push({
          category: "debug",
          content: `Tool "${tp.tool}" had low success rate (${(tp.successRate * 100).toFixed(0)}%) during: ${goal}`,
          confidence: 0.6,
        });
      }
      if (tp.count >= 5 && tp.successRate >= 0.9) {
        candidates.push({
          category: "style",
          content: `Tool "${tp.tool}" is highly effective (${tp.count} calls, ${(tp.successRate * 100).toFixed(0)}% success)`,
          confidence: 0.3,
        });
      }
    }

    // 에러 패턴에서 학습 추출 (해결된 것만)
    for (const ep of analysis.errorPatterns) {
      if (ep.resolution) {
        candidates.push({
          category: "debug",
          content: `${ep.type}: "${truncate(ep.message, 80)}" → fix: ${ep.resolution}`,
          confidence: 0.7,
        });
      }
    }

    // 공변 패턴에서 학습 추출
    for (const cp of analysis.coChangePatterns) {
      if (cp.frequency >= 2 || cp.files.length >= 3) {
        candidates.push({
          category: "style",
          content: `Co-change pattern (${cp.context}): ${cp.files.map((f) => basename(f)).join(", ")}`,
          confidence: 0.4,
        });
      }
    }

    // 규칙에서 학습 추출
    for (const conv of analysis.conventions) {
      candidates.push({
        category: "style",
        content: conv,
        confidence: 0.5,
      });
    }

    // 성능 관련 학습
    if (analysis.perfSummary.efficiency < 0.3 && analysis.perfSummary.iterations > 5) {
      candidates.push({
        category: "build",
        content: `Low efficiency run (${(analysis.perfSummary.efficiency * 100).toFixed(0)}%) for: ${truncate(goal, 60)} — consider breaking into smaller tasks`,
        confidence: 0.5,
      });
    }

    // 확신도 필터 → 정렬 → 상위 N개
    return candidates
      .filter((c) => c.confidence >= this.minConfidence)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, this.maxLearningsPerRun)
      .map(({ category, content }) => ({ category, content }));
  }

  /**
   * 도구 실행 결과에서 코딩 규칙을 자동 탐지.
   *
   * - file_read 출력: 들여쓰기 스타일 (탭 vs 공백, 2칸 vs 4칸)
   * - file_write/file_edit 출력: 네이밍 규칙 (camelCase, snake_case)
   * - shell_exec 출력: 테스트 프레임워크, 빌드 도구
   * - 성공 패턴: "항상 읽기 후 쓰기", "변경 후 테스트 실행"
   */
  detectConventions(
    toolResults: Array<{ name: string; output: string; success: boolean }>,
  ): string[] {
    const conventions: string[] = [];
    const seenConventions = new Set<string>();

    const addConvention = (conv: string): void => {
      if (!seenConventions.has(conv)) {
        seenConventions.add(conv);
        conventions.push(conv);
      }
    };

    // 들여쓰기 스타일 감지 (file_read 출력에서)
    const readOutputs = toolResults
      .filter((r) => r.name === "file_read" && r.success && r.output.length > 50)
      .map((r) => r.output);

    if (readOutputs.length > 0) {
      const indentStyle = this.detectIndentStyle(readOutputs);
      if (indentStyle) addConvention(indentStyle);
    }

    // 네이밍 규칙 감지 (file_write/file_edit 출력에서)
    const writeOutputs = toolResults
      .filter(
        (r) => (r.name === "file_write" || r.name === "file_edit") && r.success,
      )
      .map((r) => r.output);

    if (writeOutputs.length > 0) {
      const namingStyle = this.detectNamingConvention(writeOutputs);
      if (namingStyle) addConvention(namingStyle);
    }

    // 테스트/빌드 도구 감지 (shell_exec 출력에서)
    const shellOutputs = toolResults
      .filter((r) => r.name === "shell_exec" && r.success)
      .map((r) => r.output);

    for (const output of shellOutputs) {
      if (/jest/i.test(output)) addConvention("Test framework: Jest");
      if (/vitest/i.test(output)) addConvention("Test framework: Vitest");
      if (/mocha/i.test(output)) addConvention("Test framework: Mocha");
      if (/next build|next dev/i.test(output)) addConvention("Build tool: Next.js");
      if (/vite build/i.test(output)) addConvention("Build tool: Vite");
      if (/tsc --noEmit/i.test(output)) addConvention("Type checking: tsc --noEmit");
    }

    // 워크플로우 패턴 감지 — "항상 읽고 쓰기" 등
    const toolSequence = toolResults.map((r) => r.name);
    if (this.detectReadBeforeWrite(toolSequence)) {
      addConvention("Workflow: always read file before writing");
    }
    if (this.detectTestAfterChange(toolSequence)) {
      addConvention("Workflow: run tests after code changes");
    }

    return conventions;
  }

  /**
   * 에러 패턴과 해결 방법 추출.
   * 실패한 도구 호출 → 이후 메시지에서 수정 시도 탐지.
   */
  extractErrorPatterns(
    toolResults: Array<{ name: string; output: string; success: boolean }>,
    messages: Array<{ role: string; content: string | null }>,
  ): ErrorPattern[] {
    const errorMap = new Map<string, ErrorPattern>();

    for (let i = 0; i < toolResults.length; i++) {
      const result = toolResults[i];
      if (result.success) continue;

      const errorType = this.classifyErrorType(result.output);
      const errorMsg = this.extractErrorMessage(result.output);
      const key = `${errorType}:${truncate(errorMsg, 60)}`;

      if (errorMap.has(key)) {
        errorMap.get(key)!.frequency++;
        continue;
      }

      // 후속 메시지에서 해결 시도 탐색
      const resolution = this.findResolution(result, toolResults, i, messages);

      errorMap.set(key, {
        type: errorType,
        message: errorMsg,
        tool: result.name,
        resolution,
        frequency: 1,
      });
    }

    return Array.from(errorMap.values());
  }

  /**
   * 변경된 파일 목록에서 공변 패턴을 감지.
   *
   * - 같은 디렉토리의 파일 그룹
   * - test + implementation 쌍
   * - types + implementation 쌍
   * - index.ts (배럴 파일) 패턴
   */
  detectCoChangePatterns(changedFiles: string[]): CoChangePattern[] {
    if (changedFiles.length < 2) return [];

    const patterns: CoChangePattern[] = [];

    // 테스트 + 구현 파일 쌍 탐지
    const testPairs = this.findTestImplementationPairs(changedFiles);
    for (const pair of testPairs) {
      patterns.push({
        files: pair,
        frequency: 1,
        context: "test + implementation",
      });
    }

    // 타입 + 구현 파일 쌍 탐지
    const typePairs = this.findTypeImplementationPairs(changedFiles);
    for (const pair of typePairs) {
      patterns.push({
        files: pair,
        frequency: 1,
        context: "types + implementation",
      });
    }

    // 같은 디렉토리 내 파일 그룹 (3개 이상)
    const dirGroups = this.groupByDirectory(changedFiles);
    for (const [dir, files] of dirGroups) {
      if (files.length >= 3) {
        patterns.push({
          files,
          frequency: 1,
          context: `directory group: ${dir}`,
        });
      }
    }

    // index.ts 배럴 파일 포함 시
    const indexFiles = changedFiles.filter((f) => basename(f) === "index.ts" || basename(f) === "index.js");
    if (indexFiles.length > 0) {
      const nonIndex = changedFiles.filter((f) => !indexFiles.includes(f));
      if (nonIndex.length > 0) {
        patterns.push({
          files: [...indexFiles, ...nonIndex.slice(0, 3)],
          frequency: 1,
          context: "barrel export update with new modules",
        });
      }
    }

    return patterns;
  }

  // ─── Private helpers ───

  /** 도구별 사용 패턴 집계 */
  private buildToolPatterns(toolResults: ToolResultEntry[]): ToolPattern[] {
    const map = new Map<string, { count: number; successes: number; totalDuration: number }>();

    for (const r of toolResults) {
      const entry = map.get(r.name) ?? { count: 0, successes: 0, totalDuration: 0 };
      entry.count++;
      if (r.success) entry.successes++;
      entry.totalDuration += r.durationMs ?? 0;
      map.set(r.name, entry);
    }

    return Array.from(map.entries()).map(([tool, stats]) => ({
      tool,
      count: stats.count,
      successRate: stats.count > 0 ? stats.successes / stats.count : 0,
      avgDurationMs: stats.count > 0 ? Math.round(stats.totalDuration / stats.count) : 0,
    }));
  }

  /** 성능 요약 생성 */
  private buildPerfSummary(
    toolResults: ToolResultEntry[],
    tokensUsed: number,
    durationMs: number,
    iterations: number,
  ): PerfSummary {
    const successfulTools = toolResults.filter((r) => r.success).length;
    // 효율성: 성공한 도구 호출 비율 (실패가 많으면 비효율)
    const efficiency = toolResults.length > 0 ? successfulTools / toolResults.length : 1;

    return {
      iterations,
      totalTokens: tokensUsed,
      tokensPerIteration: iterations > 0 ? Math.round(tokensUsed / iterations) : 0,
      durationMs,
      efficiency: Math.round(efficiency * 100) / 100,
    };
  }

  /** 에러 유형 분류 */
  private classifyErrorType(output: string): string {
    for (const [pattern, type] of ERROR_TYPE_PATTERNS) {
      if (pattern.test(output)) return type;
    }
    return "UnknownError";
  }

  /** 에러 메시지 첫 줄 추출 */
  private extractErrorMessage(output: string): string {
    const lines = output.split("\n").filter((l) => l.trim().length > 0);
    // "error" 키워드가 포함된 첫 줄 우선
    const errorLine = lines.find((l) => /error/i.test(l));
    return truncate(errorLine ?? lines[0] ?? "Unknown error", 120);
  }

  /**
   * 실패한 도구 호출 이후 해결 시도를 탐색.
   * 같은 도구가 이후에 성공했으면 그 출력의 일부를 해결 방법으로 추출.
   */
  private findResolution(
    failedResult: ToolResultEntry,
    allResults: ToolResultEntry[],
    failedIndex: number,
    messages: Array<{ role: string; content: string | null }>,
  ): string | null {
    // 후속 5개 도구 결과 내에서 같은 도구 성공 탐색
    const lookAhead = Math.min(failedIndex + 6, allResults.length);
    for (let j = failedIndex + 1; j < lookAhead; j++) {
      const subsequent = allResults[j];
      if (subsequent.name === failedResult.name && subsequent.success) {
        return `Retried "${subsequent.name}" successfully`;
      }
      // file_edit로 수정한 경우
      if (subsequent.name === "file_edit" && subsequent.success) {
        return "Fixed via file edit";
      }
    }

    // 어시스턴트 메시지에서 "fix", "resolved", "수정" 키워드 탐색
    for (const msg of messages) {
      if (msg.role !== "assistant" || !msg.content) continue;
      const content = msg.content;
      if (/(?:fix(?:ed)?|resolv(?:ed|ing)|수정|해결)/i.test(content)) {
        // 해결 관련 메시지의 첫 문장 추출
        const sentence = content.split(/[.!\n]/)[0];
        if (sentence && sentence.length > 10) {
          return truncate(sentence.trim(), 100);
        }
      }
    }

    return null;
  }

  /** 들여쓰기 스타일 감지 — 탭 vs 공백, 2칸 vs 4칸 */
  private detectIndentStyle(fileContents: string[]): string | null {
    let tabs = 0;
    let spaces2 = 0;
    let spaces4 = 0;

    for (const content of fileContents) {
      const lines = content.split("\n").slice(0, 100); // 상위 100줄만 검사
      for (const line of lines) {
        if (line.startsWith("\t")) tabs++;
        else if (line.startsWith("    ")) spaces4++;
        else if (line.startsWith("  ") && !line.startsWith("   ")) spaces2++;
      }
    }

    const total = tabs + spaces2 + spaces4;
    if (total < 5) return null; // 표본 부족

    if (tabs > total * 0.6) return "Indent style: tabs";
    if (spaces2 > total * 0.6) return "Indent style: 2 spaces";
    if (spaces4 > total * 0.6) return "Indent style: 4 spaces";
    return null;
  }

  /** 네이밍 규칙 감지 — camelCase vs snake_case */
  private detectNamingConvention(writeOutputs: string[]): string | null {
    let camelCase = 0;
    let snakeCase = 0;

    // 함수/변수 선언 패턴 매칭
    const camelPattern = /(?:const|let|var|function)\s+[a-z][a-zA-Z0-9]*[A-Z]/g;
    const snakePattern = /(?:const|let|var|function)\s+[a-z]+_[a-z]/g;

    for (const output of writeOutputs) {
      camelCase += (output.match(camelPattern) ?? []).length;
      snakeCase += (output.match(snakePattern) ?? []).length;
    }

    const total = camelCase + snakeCase;
    if (total < 3) return null;

    if (camelCase > total * 0.7) return "Naming convention: camelCase";
    if (snakeCase > total * 0.7) return "Naming convention: snake_case";
    return null;
  }

  /** "읽기 후 쓰기" 패턴 감지 */
  private detectReadBeforeWrite(toolSequence: string[]): boolean {
    let readThenWrite = 0;
    let writeWithoutRead = 0;

    for (let i = 0; i < toolSequence.length; i++) {
      if (toolSequence[i] === "file_write" || toolSequence[i] === "file_edit") {
        // 직전 3개 이내에 file_read가 있는지 확인
        const lookBack = toolSequence.slice(Math.max(0, i - 3), i);
        if (lookBack.includes("file_read")) {
          readThenWrite++;
        } else {
          writeWithoutRead++;
        }
      }
    }

    const total = readThenWrite + writeWithoutRead;
    return total >= 3 && readThenWrite > total * 0.7;
  }

  /** "변경 후 테스트" 패턴 감지 */
  private detectTestAfterChange(toolSequence: string[]): boolean {
    let changesThenTest = 0;

    for (let i = 0; i < toolSequence.length; i++) {
      if (toolSequence[i] === "shell_exec") {
        // 직전에 file_write/file_edit가 있었는지 확인
        const lookBack = toolSequence.slice(Math.max(0, i - 5), i);
        if (lookBack.some((t) => t === "file_write" || t === "file_edit")) {
          changesThenTest++;
        }
      }
    }

    return changesThenTest >= 2;
  }

  /** 테스트 + 구현 파일 쌍 찾기 */
  private findTestImplementationPairs(files: string[]): string[][] {
    const pairs: string[][] = [];
    const testFiles = files.filter((f) => TEST_FILE_PATTERNS.some((p) => p.test(f)));
    const implFiles = files.filter((f) => !TEST_FILE_PATTERNS.some((p) => p.test(f)));

    for (const testFile of testFiles) {
      const testBase = basename(testFile)
        .replace(/\.test\.[jt]sx?$/, "")
        .replace(/\.spec\.[jt]sx?$/, "");

      const matchingImpl = implFiles.find((f) => {
        const implBase = basename(f).replace(extname(f), "");
        return implBase === testBase && dirname(f) === dirname(testFile).replace(/__tests__\/?/, "");
      });

      if (matchingImpl) {
        pairs.push([matchingImpl, testFile]);
      }
    }

    return pairs;
  }

  /** 타입 파일 + 구현 파일 쌍 찾기 */
  private findTypeImplementationPairs(files: string[]): string[][] {
    const pairs: string[][] = [];
    const typeFiles = files.filter(
      (f) => basename(f).includes("types") || basename(f).includes(".d.ts"),
    );
    const implFiles = files.filter(
      (f) => !basename(f).includes("types") && !basename(f).endsWith(".d.ts"),
    );

    for (const typeFile of typeFiles) {
      // 같은 디렉토리의 구현 파일과 매칭
      const typeDir = dirname(typeFile);
      const sameDir = implFiles.filter((f) => dirname(f) === typeDir);
      if (sameDir.length > 0) {
        pairs.push([typeFile, ...sameDir.slice(0, 2)]);
      }
    }

    return pairs;
  }

  /** 파일을 디렉토리별로 그룹화 */
  private groupByDirectory(files: string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const file of files) {
      const dir = dirname(file);
      const group = groups.get(dir) ?? [];
      group.push(file);
      groups.set(dir, group);
    }
    return groups;
  }
}

// ─── Utility ───

/** 문자열을 maxLen으로 자르고 말줄임 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}
