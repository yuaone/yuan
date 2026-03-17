/**
 * @module code-orchestrator
 * @description CodeOrchestrator — 코드 품질/분석/표준의 단일 진입점 (SSOT).
 *
 * AgentLoop, 외부 서비스(yua-backend 등)가 이 클래스 하나만 사용.
 * 내부적으로 CodingStandards, CodebaseContext, ArchSummarizer를 조율한다.
 *
 * 설계 원칙:
 * - 모든 메서드는 실패해도 throw하지 않고 null/빈값 반환
 * - 캐시 우선 (ArchSummarizer 24h TTL 활용)
 * - 기존 클래스를 조율만 하고 중복 구현하지 않음
 */

import {
  getCodingStandards,
  getGeneralStandards,
  detectLanguage,
} from "./coding-standards.js";
import { ArchSummarizer } from "./arch-summarizer.js";
import { CodebaseContext } from "./codebase-context.js";
import type { CodebaseIndex } from "./codebase-context.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** TODO/FIXME 감지 결과 항목 */
export interface TodoMatch {
  /** 키워드 (TODO, FIXME, HACK, XXX) */
  keyword: string;
  /** 감지된 줄 번호 (1-based, 코드가 줄로 분리된 경우) */
  line?: number;
  /** 해당 줄 전체 텍스트 */
  context: string;
}

/** 코드 품질 체크 결과 */
export interface QualityReport {
  /** TODO/FIXME/HACK/XXX 발견 개수 */
  todoCount: number;
  /** 발견된 TODO 목록 */
  todos: TodoMatch[];
  /** 언어 감지 결과 */
  detectedLanguage: string | null;
  /** 언어별 표준 존재 여부 */
  hasLanguageStandards: boolean;
}

// ─── CodeOrchestrator ─────────────────────────────────────────────────────────

/**
 * CodeOrchestrator — 코드 품질/분석/표준의 단일 진입점 (SSOT).
 *
 * @example
 * ```typescript
 * const orchestrator = new CodeOrchestrator();
 *
 * // system prompt 주입용 컨텍스트
 * const ctx = await orchestrator.getContextForLLM("/project");
 *
 * // 코드 품질 체크
 * const report = orchestrator.checkQuality(code, "src/api/users.ts");
 * if (report.todoCount > 0) {
 *   console.warn(`${report.todoCount} TODO(s) detected`);
 * }
 * ```
 */
export class CodeOrchestrator {
  private readonly archSummarizers = new Map<string, ArchSummarizer>();
  private readonly codebaseContexts = new Map<string, CodebaseContext>();

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * 언어별 코딩 표준 반환.
   * 내부적으로 CodingStandards 모듈에 위임.
   *
   * @param language 언어 이름 또는 확장자 (예: "typescript", ".ts", "python")
   * @returns 코딩 표준 문자열, 없으면 null
   */
  getStandards(language: string): string | null {
    try {
      // 먼저 직접 조회 시도
      const direct = getCodingStandards(language);
      if (direct != null) return direct;

      // 확장자 형태면 detectLanguage로 변환 후 재시도
      // detectLanguage는 파일명/확장자를 처리하므로 "file.ts" 형태로 래핑
      if (language.startsWith(".")) {
        const detected = detectLanguage(`file${language}`);
        if (detected) return getCodingStandards(detected) ?? null;
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * 프로젝트 전체 분석 (심볼 인덱스, 의존성 그래프).
   * CodebaseContext를 통해 분석하며, 결과는 내부적으로 캐시된다.
   *
   * @param projectPath 프로젝트 루트 경로
   * @returns 분석 결과 인덱스, 실패 시 null
   */
  async analyzeProject(projectPath: string): Promise<CodebaseIndex | null> {
    try {
      const ctx = this.getOrCreateContext(projectPath);
      return await ctx.buildIndex();
    } catch {
      return null;
    }
  }

  /**
   * 코드 품질 체크.
   * - TODO/FIXME/HACK/XXX 패턴 감지
   * - 언어 감지 및 표준 존재 여부 확인
   *
   * @param code 검사할 코드 문자열
   * @param filePath 파일 경로 (언어 감지용, 선택)
   * @returns 품질 보고서
   */
  checkQuality(code: string, filePath?: string): QualityReport {
    const todos = this.detectTodos(code);
    const detectedLanguage = filePath ? (detectLanguage(filePath) ?? null) : null;
    const hasLanguageStandards = detectedLanguage
      ? getCodingStandards(detectedLanguage) != null
      : false;

    return {
      todoCount: todos.length,
      todos,
      detectedLanguage,
      hasLanguageStandards,
    };
  }

  /**
   * LLM system prompt 주입용 컨텍스트 생성.
   * ArchSummarizer(아키텍처 요약) + CodingStandards(일반 표준) 조합.
   *
   * @param projectPath 프로젝트 루트 경로
   * @param question 현재 작업 질문 (언어 힌트 추출용, 선택)
   * @returns LLM에 주입할 컨텍스트 문자열
   */
  async getContextForLLM(
    projectPath: string,
    question?: string,
  ): Promise<string> {
    const parts: string[] = [];

    // 1. 아키텍처 요약 (캐시됨)
    try {
      const summarizer = this.getOrCreateSummarizer(projectPath);
      const summary = await summarizer.getSummary();
      if (summary) {
        parts.push(`## Project Architecture\n${summary}`);
      }
    } catch {
      // non-fatal
    }

    // 2. 일반 코딩 표준
    try {
      const general = getGeneralStandards();
      if (general) {
        parts.push(`## General Coding Standards\n${general}`);
      }
    } catch {
      // non-fatal
    }

    // 3. 질문에서 언어 힌트 추출해 언어별 표준 추가
    if (question) {
      const langHint = this.extractLanguageFromQuestion(question);
      if (langHint) {
        const standards = this.getStandards(langHint);
        if (standards) {
          parts.push(`## ${langHint} Coding Standards\n${standards}`);
        }
      }
    }

    return parts.join("\n\n");
  }

  /**
   * 코드에서 TODO/FIXME/HACK/XXX 패턴 감지.
   *
   * @param code 검사할 코드 문자열
   * @returns 감지된 TODO 목록
   */
  detectTodos(code: string): TodoMatch[] {
    const matches: TodoMatch[] = [];
    const lines = code.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const todoPattern = /\b(TODO|FIXME|HACK|XXX)\b/gi;
      let match: RegExpExecArray | null;

      while ((match = todoPattern.exec(line)) !== null) {
        matches.push({
          keyword: match[1].toUpperCase(),
          line: i + 1,
          context: line.trim(),
        });
      }
    }

    return matches;
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  private getOrCreateSummarizer(projectPath: string): ArchSummarizer {
    if (!this.archSummarizers.has(projectPath)) {
      this.archSummarizers.set(projectPath, new ArchSummarizer(projectPath));
    }
    return this.archSummarizers.get(projectPath)!;
  }

  private getOrCreateContext(projectPath: string): CodebaseContext {
    if (!this.codebaseContexts.has(projectPath)) {
      this.codebaseContexts.set(projectPath, new CodebaseContext(projectPath));
    }
    return this.codebaseContexts.get(projectPath)!;
  }

  /**
   * 질문 문자열에서 언어 힌트를 추출.
   * 예: "TypeScript 파일 작성", "Python 스크립트", "rust 코드"
   */
  private extractLanguageFromQuestion(question: string): string | null {
    const LANG_KEYWORDS: Record<string, string> = {
      typescript: "typescript",
      ts: "typescript",
      javascript: "javascript",
      js: "javascript",
      python: "python",
      py: "python",
      rust: "rust",
      rs: "rust",
      go: "go",
      golang: "go",
      java: "java",
      kotlin: "kotlin",
      swift: "swift",
      "c++": "cpp",
      cpp: "cpp",
      "c#": "csharp",
      csharp: "csharp",
      ruby: "ruby",
      php: "php",
      solidity: "solidity",
    };

    const lower = question.toLowerCase();
    for (const [keyword, lang] of Object.entries(LANG_KEYWORDS)) {
      if (lower.includes(keyword)) {
        return lang;
      }
    }
    return null;
  }
}

// ─── Singleton (편의용) ───────────────────────────────────────────────────────

/**
 * 전역 CodeOrchestrator 인스턴스.
 * AgentLoop, 외부 서비스 등에서 공통 사용.
 */
export const codeOrchestrator = new CodeOrchestrator();
