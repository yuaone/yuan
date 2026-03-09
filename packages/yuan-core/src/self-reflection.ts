/**
 * @module self-reflection
 * @description Deep Self-Reflection & Self-Correction — 6-dimension 자기 검증,
 * 내적 독백(inner monologue), 반성 학습(reflection learning) 시스템.
 *
 * `continuous-reflection.ts`가 주기적 체크포인트/경량 검증을 담당한다면,
 * 이 모듈은 **심층 코드 검증**(6개 차원), **사고 과정 기록**, **실수 학습**을 담당한다.
 *
 * 6-Dimension Verification:
 * 1. **Correctness** — 코드가 올바른가?
 * 2. **Completeness** — 빠진 것은 없는가?
 * 3. **Consistency** — 기존 코드와 일관적인가?
 * 4. **Quality** — 더 나은 방법이 있는가?
 * 5. **Security** — 보안 취약점은 없는가?
 * 6. **Performance** — 성능 문제는 없는가?
 *
 * @example
 * ```typescript
 * const sr = new SelfReflection("session-123", {
 *   minScoreToPass: 70,
 *   criticalDimensions: ["correctness", "security"],
 * });
 *
 * // Inner monologue
 * sr.think("analyze", "이 파일은 Express 라우터이므로 미들웨어 패턴을 따라야 한다");
 * sr.recordDecision("plan", "어떤 패턴?", ["factory", "class"], "factory", "기존 코드가 모두 factory 패턴");
 *
 * // Deep verification
 * const result = await sr.deepVerify(
 *   "Add user authentication middleware",
 *   changedFiles,
 *   originalFiles,
 *   ["Use camelCase", "Express middleware pattern"],
 *   (prompt) => llm.complete(prompt),
 * );
 *
 * if (result.verdict === "fail") {
 *   // auto-fix or report
 * }
 *
 * // Persist learnings
 * await sr.persistLearnings(memoryManager);
 * ```
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import type { MemoryManager, ProjectMemory } from "./memory-manager.js";

// ─── Types ───────────────────────────────────────────────────────

/** 차원별 점수 */
export interface DimensionScore {
  /** 점수 (0–100) */
  score: number;
  /** 상태 */
  status: "pass" | "warning" | "fail";
  /** 발견된 이슈 */
  issues: string[];
  /** 판단 근거 */
  evidence: string[];
}

/** 자동 수정 제안 */
export interface SuggestedFix {
  /** 해당 차원 */
  dimension: keyof DeepVerifyResult["dimensions"];
  /** 심각도 */
  severity: "critical" | "high" | "medium" | "low";
  /** 설명 */
  description: string;
  /** 관련 파일 */
  file?: string;
  /** 제안 코드 */
  suggestedCode?: string;
  /** 자동 수정 가능 여부 */
  autoFixable: boolean;
}

/** 6-dimension 심층 검증 결과 */
export interface DeepVerifyResult {
  /** 최종 판정 */
  verdict: "pass" | "concern" | "fail";
  /** 종합 점수 (0–100) */
  overallScore: number;

  /** 6개 차원별 점수 */
  dimensions: {
    correctness: DimensionScore;
    completeness: DimensionScore;
    consistency: DimensionScore;
    quality: DimensionScore;
    security: DimensionScore;
    performance: DimensionScore;
  };

  /** 자가 비판 텍스트 */
  selfCritique: string;
  /** 수정 제안 목록 */
  suggestedFixes: SuggestedFix[];
  /** 판단 확신도 (0.0–1.0) */
  confidence: number;
}

/** 내적 독백 항목 */
export interface MonologueEntry {
  /** 기록 시각 (epoch ms) */
  timestamp: number;
  /** 단계 ("analyze" | "plan" | "implement" | "verify" 등) */
  phase: string;
  /** 사고 내용 */
  thought: string;
  /** 수행한 행동 */
  action?: string;
  /** 결과 요약 */
  result?: string;
  /** 의사결정 기록 */
  decision?: {
    question: string;
    options: string[];
    chosen: string;
    reasoning: string;
  };
}

/** 실수 유형 */
export type MistakeType =
  | "logic_error"
  | "pattern_violation"
  | "missing_edge_case"
  | "wrong_assumption"
  | "incomplete_change"
  | "security_issue"
  | "performance_issue"
  | "type_error";

/** 반성 학습 — 실수와 교정을 기록하여 향후 세션에 적용 */
export interface ReflectionLearning {
  /** 고유 ID */
  id: string;
  /** 세션 ID */
  sessionId: string;
  /** 기록 시각 (epoch ms) */
  timestamp: number;

  /** 실수 정보 */
  mistake: {
    type: MistakeType;
    description: string;
    file: string;
    line?: number;
  };

  /** 교정 결과 */
  correction: {
    approach: string;
    result: "fixed" | "partially_fixed" | "needs_human";
  };

  /** 학습된 지식 */
  learning: {
    /** 학습된 규칙 */
    rule: string;
    /** 확신도 (0–1) */
    confidence: number;
    /** 적용 가능 컨텍스트 */
    appliesTo: string[];
    /** 카테고리 */
    category: string;
  };
}

/** SelfReflection 설정 */
export interface SelfReflectionConfig {
  /** 심층 검증 활성화 (기본 true) */
  enableDeepVerify: boolean;
  /** 내적 독백 활성화 (기본 true) */
  enableMonologue: boolean;
  /** 학습 기록 활성화 (기본 true) */
  enableLearning: boolean;
  /** 내적 독백 최대 항목 수 (기본 200) */
  monologueMaxEntries: number;
  /** 학습 기록 최대 항목 수 (기본 100) */
  learningMaxEntries: number;
  /** 통과 최소 점수 (기본 70) */
  minScoreToPass: number;
  /** 반드시 통과해야 하는 차원 (기본 ["correctness", "security"]) */
  criticalDimensions: (keyof DeepVerifyResult["dimensions"])[];
}

/** SelfReflection 이벤트 맵 */
export interface SelfReflectionEvents {
  /** 새 사고/결정 기록 */
  "monologue:entry": [entry: MonologueEntry];
  /** 심층 검증 시작 */
  "verify:start": [goal: string];
  /** 심층 검증 완료 */
  "verify:complete": [result: DeepVerifyResult];
  /** 새 학습 기록 */
  "learning:recorded": [learning: ReflectionLearning];
  /** 학습 메모리 저장 완료 */
  "learning:persisted": [count: number];
}

// ─── Constants ───────────────────────────────────────────────────

/** 기본 설정 */
const DEFAULT_CONFIG: Required<SelfReflectionConfig> = {
  enableDeepVerify: true,
  enableMonologue: true,
  enableLearning: true,
  monologueMaxEntries: 200,
  learningMaxEntries: 100,
  minScoreToPass: 70,
  criticalDimensions: ["correctness", "security"],
};

/** 차원 이름 목록 */
const DIMENSION_NAMES: readonly (keyof DeepVerifyResult["dimensions"])[] = [
  "correctness",
  "completeness",
  "consistency",
  "quality",
  "security",
  "performance",
] as const;

/** 심각도 우선순위 (정렬용) */
const SEVERITY_ORDER: Record<SuggestedFix["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** 차원별 실패 임계값 */
const DIMENSION_FAIL_THRESHOLD = 40;

/** 차원별 경고 임계값 */
const DIMENSION_WARNING_THRESHOLD = 70;

// ─── SelfReflection ──────────────────────────────────────────────

/**
 * SelfReflection — 6-dimension 심층 자기 검증, 내적 독백, 반성 학습.
 *
 * LLM 호출은 외부에서 주입(`verifyFn`)하여 결합도를 낮춘다.
 * MemoryManager와 연동하여 학습을 세션 간 지속한다.
 */
export class SelfReflection extends EventEmitter {
  private readonly config: Required<SelfReflectionConfig>;
  private readonly monologue: MonologueEntry[] = [];
  private readonly learnings: ReflectionLearning[] = [];
  private readonly sessionId: string;

  /** 마지막 검증 결과 (getSummary용) */
  private lastVerdict: DeepVerifyResult["verdict"] | undefined;

  constructor(sessionId: string, config?: Partial<SelfReflectionConfig>) {
    super();
    this.sessionId = sessionId;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Deep Verification ───────────────────────────────────────

  /**
   * 전체 6-dimension 심층 검증을 실행한다.
   *
   * LLM에 구조화된 프롬프트를 전달하고, 응답을 파싱하여
   * 6개 차원의 점수와 수정 제안을 반환한다.
   *
   * @param goal - 에이전트가 달성하려는 목표
   * @param changedFiles - 변경된 파일 (파일경로 → 내용)
   * @param originalFiles - 원본 파일 (파일경로 → 원본 내용, diff 생성용)
   * @param projectPatterns - 프로젝트 규칙/패턴 목록
   * @param verifyFn - LLM 호출 콜백 (프롬프트 → 응답)
   * @returns 6-dimension 검증 결과
   */
  async deepVerify(
    goal: string,
    changedFiles: Map<string, string>,
    originalFiles: Map<string, string>,
    projectPatterns: string[],
    verifyFn: (prompt: string) => Promise<string>,
  ): Promise<DeepVerifyResult> {
    if (!this.config.enableDeepVerify) {
      return this.createPassResult();
    }

    this.emit("verify:start", goal);
    this.think("verify", `Starting deep verification for goal: ${goal}`);

    const prompt = this.buildDeepVerifyPrompt(
      goal,
      changedFiles,
      originalFiles,
      projectPatterns,
    );

    try {
      const response = await verifyFn(prompt);
      const result = this.parseDeepVerifyResponse(response);

      this.lastVerdict = result.verdict;
      this.emit("verify:complete", result);

      this.think(
        "verify",
        `Deep verification complete: ${result.verdict} (score: ${result.overallScore})`,
      );

      // 실패한 차원이 있으면 학습 기록
      if (this.config.enableLearning && result.verdict === "fail") {
        this.recordVerificationLearnings(result, changedFiles);
      }

      return result;
    } catch (error) {
      this.think(
        "verify",
        `Deep verification failed with error: ${error instanceof Error ? error.message : String(error)}`,
      );

      // 검증 자체 실패 시 안전한 기본값 반환
      return this.createErrorResult(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * 빠른 검증 — critical 차원(correctness + security)만 확인.
   *
   * 전체 6-dimension 검증보다 가볍고, 각 iteration 후에 실행하기 적합하다.
   *
   * @param changedFiles - 변경된 파일 (파일경로 → 내용)
   * @param verifyFn - LLM 호출 콜백
   * @returns 검증 결과 (non-critical 차원은 기본값)
   */
  async quickVerify(
    changedFiles: Map<string, string>,
    verifyFn: (prompt: string) => Promise<string>,
  ): Promise<DeepVerifyResult> {
    if (!this.config.enableDeepVerify) {
      return this.createPassResult();
    }

    const prompt = this.buildQuickVerifyPrompt(changedFiles);

    try {
      const response = await verifyFn(prompt);
      const partial = this.parseDeepVerifyResponse(response);

      // non-critical 차원은 기본 pass로 설정
      for (const dim of DIMENSION_NAMES) {
        if (!this.config.criticalDimensions.includes(dim)) {
          partial.dimensions[dim] = {
            score: 80,
            status: "pass",
            issues: [],
            evidence: ["Skipped in quick verify"],
          };
        }
      }

      // 종합 점수 재계산
      partial.overallScore = this.calculateOverallScore(partial.dimensions);
      partial.verdict = this.determineVerdict(partial);

      this.lastVerdict = partial.verdict;
      return partial;
    } catch {
      return this.createPassResult();
    }
  }

  // ─── Inner Monologue ─────────────────────────────────────────

  /**
   * 사고를 기록한다.
   *
   * @param phase - 현재 단계 ("analyze", "plan", "implement", "verify" 등)
   * @param thought - 사고 내용
   */
  think(phase: string, thought: string): void {
    if (!this.config.enableMonologue) return;

    const entry: MonologueEntry = {
      timestamp: Date.now(),
      phase,
      thought,
    };

    this.addMonologueEntry(entry);
  }

  /**
   * 사고와 행동을 함께 기록한다.
   *
   * @param phase - 현재 단계
   * @param thought - 사고 내용
   * @param action - 수행한 행동 (도구 호출 등)
   * @param result - 결과 요약
   */
  thinkAndAct(
    phase: string,
    thought: string,
    action: string,
    result?: string,
  ): void {
    if (!this.config.enableMonologue) return;

    const entry: MonologueEntry = {
      timestamp: Date.now(),
      phase,
      thought,
      action,
      result,
    };

    this.addMonologueEntry(entry);
  }

  /**
   * 의사결정을 기록한다.
   *
   * 여러 선택지 중 하나를 골랐을 때 근거와 함께 기록한다.
   *
   * @param phase - 현재 단계
   * @param question - 의사결정 질문
   * @param options - 선택지 목록
   * @param chosen - 선택한 옵션
   * @param reasoning - 선택 근거
   */
  recordDecision(
    phase: string,
    question: string,
    options: string[],
    chosen: string,
    reasoning: string,
  ): void {
    if (!this.config.enableMonologue) return;

    const entry: MonologueEntry = {
      timestamp: Date.now(),
      phase,
      thought: `Decision: ${question} → ${chosen}`,
      decision: { question, options, chosen, reasoning },
    };

    this.addMonologueEntry(entry);
  }

  /**
   * 내적 독백을 포맷된 텍스트로 반환한다 (유저 표시용).
   *
   * @param lastN - 최근 N개 항목만 반환 (미지정 시 전체)
   * @returns 포맷된 독백 텍스트
   */
  getMonologueText(lastN?: number): string {
    const entries =
      lastN !== undefined
        ? this.monologue.slice(-lastN)
        : this.monologue;

    if (entries.length === 0) return "(no monologue entries)";

    const lines: string[] = [];

    for (const entry of entries) {
      const time = new Date(entry.timestamp).toISOString().slice(11, 19);
      const phase = entry.phase.toUpperCase().padEnd(10);

      lines.push(`[${time}] ${phase} ${entry.thought}`);

      if (entry.action) {
        lines.push(`           ACTION: ${entry.action}`);
      }
      if (entry.result) {
        lines.push(`           RESULT: ${entry.result}`);
      }
      if (entry.decision) {
        lines.push(`           OPTIONS: ${entry.decision.options.join(" | ")}`);
        lines.push(`           CHOSEN: ${entry.decision.chosen}`);
        lines.push(`           REASON: ${entry.decision.reasoning}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * 내적 독백 항목 전체를 반환한다 (읽기 전용).
   */
  getMonologue(): readonly MonologueEntry[] {
    return this.monologue;
  }

  /**
   * 내적 독백을 초기화한다.
   */
  clearMonologue(): void {
    this.monologue.length = 0;
  }

  // ─── Learning ────────────────────────────────────────────────

  /**
   * 실수와 교정을 기록한다.
   *
   * id, sessionId, timestamp는 자동 생성된다.
   *
   * @param learning - 학습 데이터 (id/sessionId/timestamp 제외)
   */
  recordLearning(
    learning: Omit<ReflectionLearning, "id" | "sessionId" | "timestamp">,
  ): void {
    if (!this.config.enableLearning) return;

    const entry: ReflectionLearning = {
      id: randomUUID(),
      sessionId: this.sessionId,
      timestamp: Date.now(),
      ...learning,
    };

    this.learnings.push(entry);

    // 한도 초과 시 가장 낮은 confidence 제거
    if (this.learnings.length > this.config.learningMaxEntries) {
      this.learnings.sort(
        (a, b) => b.learning.confidence - a.learning.confidence,
      );
      this.learnings.length = this.config.learningMaxEntries;
    }

    this.emit("learning:recorded", entry);

    this.think(
      "learning",
      `Learned: [${entry.mistake.type}] ${entry.learning.rule}`,
    );
  }

  /**
   * 현재 태스크에 관련된 학습을 반환한다.
   *
   * 태스크 설명 또는 파일 목록과 키워드 매칭으로 필터링한다.
   *
   * @param taskDescription - 태스크 설명
   * @param files - 작업 대상 파일 목록
   * @returns 관련 학습 목록
   */
  getRelevantLearnings(
    taskDescription: string,
    files: string[],
  ): ReflectionLearning[] {
    const keywords = this.extractKeywords(taskDescription);
    const fileKeywords = files.flatMap((f) =>
      f.split("/").filter((seg) => seg.length > 2),
    );
    const allKeywords = [...new Set([...keywords, ...fileKeywords])];

    return this.learnings.filter((l) => {
      // 파일 경로 매칭
      if (files.some((f) => l.mistake.file.includes(f) || f.includes(l.mistake.file))) {
        return true;
      }

      // 키워드 매칭 (규칙, 설명, 적용 대상)
      const searchText = [
        l.learning.rule,
        l.mistake.description,
        ...l.learning.appliesTo,
        l.learning.category,
      ]
        .join(" ")
        .toLowerCase();

      return allKeywords.some((kw) => searchText.includes(kw));
    });
  }

  /**
   * 모든 학습 기록을 반환한다 (읽기 전용).
   */
  getAllLearnings(): readonly ReflectionLearning[] {
    return this.learnings;
  }

  /**
   * 학습 기록을 MemoryManager에 저장한다.
   *
   * ReflectionLearning을 MemoryManager의 Learning + FailedApproach로 변환하여
   * 세션 간 지속되도록 한다.
   *
   * @param memoryManager - 저장 대상 MemoryManager
   * @returns 저장된 학습 수
   */
  async persistLearnings(memoryManager: MemoryManager): Promise<number> {
    if (this.learnings.length === 0) return 0;

    let persisted = 0;

    for (const l of this.learnings) {
      // Learning으로 저장 (높은 confidence만)
      if (l.learning.confidence >= 0.3) {
        memoryManager.addLearning(
          l.learning.category,
          `[${l.mistake.type}] ${l.learning.rule}`,
        );
        persisted++;
      }

      // 실패한 접근방식도 기록
      if (l.correction.result !== "fixed") {
        memoryManager.addFailedApproach(
          `${l.mistake.type}: ${l.mistake.description}`,
          `${l.correction.approach} → ${l.correction.result}`,
        );
      }
    }

    // MemoryManager.save()는 호출 측에서 별도로 수행
    this.emit("learning:persisted", persisted);
    return persisted;
  }

  /**
   * ProjectMemory에서 기존 학습을 로드한다.
   *
   * MemoryManager.load()로 읽은 ProjectMemory를 전달하면
   * 관련 학습을 ReflectionLearning으로 변환하여 내부 목록에 추가한다.
   *
   * @param memory - 로드된 프로젝트 메모리
   */
  loadFromMemory(memory: ProjectMemory): void {
    // 기존 Learning 중 self-reflection에서 기록한 것을 복원
    for (const l of memory.learnings) {
      const typeMatch = l.content.match(
        /^\[(logic_error|pattern_violation|missing_edge_case|wrong_assumption|incomplete_change|security_issue|performance_issue|type_error)\]\s*(.+)$/,
      );

      if (typeMatch) {
        const existing = this.learnings.find(
          (rl) => rl.learning.rule === typeMatch[2],
        );
        if (existing) continue;

        this.learnings.push({
          id: randomUUID(),
          sessionId: "restored",
          timestamp: l.createdAt,
          mistake: {
            type: typeMatch[1] as MistakeType,
            description: typeMatch[2],
            file: "",
          },
          correction: {
            approach: "previous session",
            result: "fixed",
          },
          learning: {
            rule: typeMatch[2],
            confidence: l.confidence,
            appliesTo: [l.category],
            category: l.category,
          },
        });
      }
    }
  }

  // ─── Integration ─────────────────────────────────────────────

  /**
   * 6-dimension 심층 검증 프롬프트를 생성한다.
   *
   * LLM에 구조화된 JSON 출력을 요청하는 프롬프트를 만든다.
   *
   * @param goal - 에이전트 목표
   * @param changedFiles - 변경된 파일 (경로 → 내용)
   * @param originalFiles - 원본 파일 (경로 → 내용)
   * @param patterns - 프로젝트 규칙/패턴
   * @returns LLM에 전달할 프롬프트
   */
  buildDeepVerifyPrompt(
    goal: string,
    changedFiles: Map<string, string>,
    originalFiles: Map<string, string>,
    patterns: string[],
  ): string {
    const sections: string[] = [];

    sections.push(
      "You are a meticulous code reviewer performing a 6-dimension self-verification.",
    );
    sections.push(
      "Analyze the changes critically and score each dimension honestly.",
    );
    sections.push("");

    // Goal
    sections.push("## Goal");
    sections.push(goal);
    sections.push("");

    // Changed Files
    sections.push("## Changed Files");
    for (const [filePath, content] of changedFiles) {
      const original = originalFiles.get(filePath);
      sections.push(`### ${filePath}`);
      if (original) {
        sections.push("#### Original");
        sections.push("```");
        sections.push(this.truncateContent(original, 3000));
        sections.push("```");
        sections.push("#### Modified");
      }
      sections.push("```");
      sections.push(this.truncateContent(content, 3000));
      sections.push("```");
      sections.push("");
    }

    // New files (in changed but not in original)
    const newFiles = [...changedFiles.keys()].filter(
      (f) => !originalFiles.has(f),
    );
    if (newFiles.length > 0) {
      sections.push(`New files: ${newFiles.join(", ")}`);
      sections.push("");
    }

    // Project Conventions
    if (patterns.length > 0) {
      sections.push("## Project Conventions");
      for (const p of patterns) {
        sections.push(`- ${p}`);
      }
      sections.push("");
    }

    // Previous Learnings
    const relevant = this.getRelevantLearnings(
      goal,
      [...changedFiles.keys()],
    );
    if (relevant.length > 0) {
      sections.push("## Previous Learnings (mistakes to avoid)");
      for (const l of relevant.slice(0, 10)) {
        sections.push(
          `- [${l.mistake.type}] ${l.learning.rule} (confidence: ${l.learning.confidence.toFixed(2)})`,
        );
      }
      sections.push("");
    }

    // Scoring instructions
    sections.push("## Instructions");
    sections.push(
      "Score each dimension 0-100 and list specific issues with evidence.",
    );
    sections.push("");
    sections.push(
      '1. **Correctness** — Does the code do what was intended? Any logic errors, off-by-one, null checks?',
    );
    sections.push(
      '2. **Completeness** — Are all necessary changes made? Missing imports, error handling, cleanup?',
    );
    sections.push(
      '3. **Consistency** — Does the code follow project patterns and naming conventions?',
    );
    sections.push(
      '4. **Quality** — Is the code clean, readable, maintainable? Code smells? Better alternatives?',
    );
    sections.push(
      '5. **Security** — Any hardcoded secrets, injection risks, unsafe operations, path traversal?',
    );
    sections.push(
      '6. **Performance** — Any O(n\u00B2) algorithms, memory leaks, unnecessary iterations, blocking calls?',
    );
    sections.push("");

    // Output format
    sections.push("## Output Format");
    sections.push("Respond with ONLY a JSON object (no markdown fencing):");
    sections.push(JSON.stringify(this.getOutputTemplate(), null, 2));
    sections.push("");
    sections.push(
      "IMPORTANT: Be honest and critical. A score of 100 should be rare. " +
        "List concrete issues, not vague statements.",
    );

    return sections.join("\n");
  }

  /**
   * LLM 응답을 DeepVerifyResult로 파싱한다.
   *
   * JSON 파싱 실패 시 안전한 기본값을 반환한다.
   *
   * @param response - LLM 응답 문자열
   * @returns 파싱된 검증 결과
   */
  parseDeepVerifyResponse(response: string): DeepVerifyResult {
    try {
      // JSON 블록 추출 (```json ... ``` 또는 순수 JSON)
      const jsonStr = this.extractJson(response);
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

      const dimensions = this.parseDimensions(
        parsed.dimensions as Record<string, unknown> | undefined,
      );

      const suggestedFixes = this.parseSuggestedFixes(
        parsed.suggestedFixes as unknown[] | undefined,
      );

      const selfCritique =
        typeof parsed.selfCritique === "string"
          ? parsed.selfCritique
          : "No critique provided";

      const confidence =
        typeof parsed.confidence === "number"
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5;

      const overallScore = this.calculateOverallScore(dimensions);

      const result: DeepVerifyResult = {
        verdict: "pass", // determined below
        overallScore,
        dimensions,
        selfCritique,
        suggestedFixes: suggestedFixes.sort(
          (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
        ),
        confidence,
      };

      result.verdict = this.determineVerdict(result);

      return result;
    } catch {
      return this.createErrorResult("Failed to parse LLM verification response");
    }
  }

  /**
   * 현재 상태 요약을 반환한다 (컨텍스트 주입용).
   */
  getSummary(): {
    monologueCount: number;
    learningCount: number;
    lastVerdict?: string;
  } {
    return {
      monologueCount: this.monologue.length,
      learningCount: this.learnings.length,
      lastVerdict: this.lastVerdict,
    };
  }

  // ─── Private: Monologue ──────────────────────────────────────

  /**
   * 독백 항목을 추가하고 한도를 초과하면 오래된 항목을 제거한다.
   */
  private addMonologueEntry(entry: MonologueEntry): void {
    this.monologue.push(entry);

    if (this.monologue.length > this.config.monologueMaxEntries) {
      // 앞에서 20% 제거 (최근 데이터 유지)
      const removeCount = Math.floor(this.config.monologueMaxEntries * 0.2);
      this.monologue.splice(0, removeCount);
    }

    this.emit("monologue:entry", entry);
  }

  // ─── Private: Verification Helpers ───────────────────────────

  /**
   * quick verify용 경량 프롬프트를 생성한다.
   */
  private buildQuickVerifyPrompt(
    changedFiles: Map<string, string>,
  ): string {
    const sections: string[] = [];

    sections.push(
      "Quick code review. Check ONLY correctness and security. Be concise.",
    );
    sections.push("");
    sections.push("## Files");

    for (const [filePath, content] of changedFiles) {
      sections.push(`### ${filePath}`);
      sections.push("```");
      sections.push(this.truncateContent(content, 2000));
      sections.push("```");
      sections.push("");
    }

    sections.push("## Output (JSON only, no markdown fencing)");
    sections.push(
      JSON.stringify(
        {
          dimensions: {
            correctness: {
              score: 0,
              status: "pass",
              issues: [],
              evidence: [],
            },
            security: {
              score: 0,
              status: "pass",
              issues: [],
              evidence: [],
            },
          },
          selfCritique: "",
          suggestedFixes: [],
          confidence: 0,
        },
        null,
        2,
      ),
    );

    return sections.join("\n");
  }

  /**
   * 검증 실패 시 자동으로 학습을 기록한다.
   */
  private recordVerificationLearnings(
    result: DeepVerifyResult,
    changedFiles: Map<string, string>,
  ): void {
    const files = [...changedFiles.keys()];
    const primaryFile = files[0] ?? "unknown";

    for (const [dimName, dimScore] of Object.entries(result.dimensions)) {
      if (dimScore.status === "fail" && dimScore.issues.length > 0) {
        const mistakeType = this.dimensionToMistakeType(
          dimName as keyof DeepVerifyResult["dimensions"],
        );

        this.recordLearning({
          mistake: {
            type: mistakeType,
            description: dimScore.issues[0],
            file: primaryFile,
          },
          correction: {
            approach: "Deep verification flagged issue",
            result: "needs_human",
          },
          learning: {
            rule: `Avoid: ${dimScore.issues[0]}`,
            confidence: (dimScore.score / 100) * 0.5 + 0.2, // 낮은 점수 → 높은 학습 가치
            appliesTo: files,
            category: dimName,
          },
        });
      }
    }
  }

  /**
   * 차원 이름을 MistakeType으로 변환한다.
   */
  private dimensionToMistakeType(
    dimension: keyof DeepVerifyResult["dimensions"],
  ): MistakeType {
    const mapping: Record<
      keyof DeepVerifyResult["dimensions"],
      MistakeType
    > = {
      correctness: "logic_error",
      completeness: "incomplete_change",
      consistency: "pattern_violation",
      quality: "pattern_violation",
      security: "security_issue",
      performance: "performance_issue",
    };
    return mapping[dimension];
  }

  /**
   * 6개 차원의 점수를 종합한다.
   *
   * critical 차원에 가중치를 부여한다 (1.5x).
   */
  private calculateOverallScore(
    dimensions: DeepVerifyResult["dimensions"],
  ): number {
    let totalWeight = 0;
    let weightedSum = 0;

    for (const dimName of DIMENSION_NAMES) {
      const weight = this.config.criticalDimensions.includes(dimName)
        ? 1.5
        : 1.0;
      weightedSum += dimensions[dimName].score * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
  }

  /**
   * 종합 판정을 결정한다.
   *
   * - fail: 종합 점수 < minScoreToPass 또는 critical 차원이 fail
   * - concern: 종합 점수 >= minScoreToPass 이지만 warning인 차원 존재
   * - pass: 모든 조건 통과
   */
  private determineVerdict(result: DeepVerifyResult): DeepVerifyResult["verdict"] {
    // Critical 차원이 하나라도 fail이면 전체 fail
    for (const dim of this.config.criticalDimensions) {
      if (result.dimensions[dim].status === "fail") {
        return "fail";
      }
    }

    // 종합 점수 미달
    if (result.overallScore < this.config.minScoreToPass) {
      return "fail";
    }

    // Warning 차원이 있으면 concern
    for (const dimName of DIMENSION_NAMES) {
      if (result.dimensions[dimName].status === "warning") {
        return "concern";
      }
    }

    return "pass";
  }

  /**
   * LLM 응답에서 JSON 블록을 추출한다.
   */
  private extractJson(text: string): string {
    // ```json ... ``` 패턴
    const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenced) return fenced[1].trim();

    // 순수 JSON 객체 찾기 (첫 번째 { ... 마지막 })
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return text.slice(firstBrace, lastBrace + 1);
    }

    return text.trim();
  }

  /**
   * LLM 응답에서 dimensions를 파싱한다.
   */
  private parseDimensions(
    raw: Record<string, unknown> | undefined,
  ): DeepVerifyResult["dimensions"] {
    const defaults = this.createDefaultDimensions();
    if (!raw || typeof raw !== "object") return defaults;

    for (const dimName of DIMENSION_NAMES) {
      const dimRaw = raw[dimName] as Record<string, unknown> | undefined;
      if (!dimRaw || typeof dimRaw !== "object") continue;

      const score =
        typeof dimRaw.score === "number"
          ? Math.max(0, Math.min(100, Math.round(dimRaw.score)))
          : 50;

      const issues = Array.isArray(dimRaw.issues)
        ? dimRaw.issues.filter((i): i is string => typeof i === "string")
        : [];

      const evidence = Array.isArray(dimRaw.evidence)
        ? dimRaw.evidence.filter((e): e is string => typeof e === "string")
        : [];

      let status: DimensionScore["status"];
      if (
        typeof dimRaw.status === "string" &&
        ["pass", "warning", "fail"].includes(dimRaw.status)
      ) {
        status = dimRaw.status as DimensionScore["status"];
      } else {
        // 점수 기반 자동 결정
        if (score < DIMENSION_FAIL_THRESHOLD) status = "fail";
        else if (score < DIMENSION_WARNING_THRESHOLD) status = "warning";
        else status = "pass";
      }

      defaults[dimName] = { score, status, issues, evidence };
    }

    return defaults;
  }

  /**
   * LLM 응답에서 suggestedFixes를 파싱한다.
   */
  private parseSuggestedFixes(raw: unknown[] | undefined): SuggestedFix[] {
    if (!Array.isArray(raw)) return [];

    const validDimensions = new Set<string>(DIMENSION_NAMES);
    const validSeverities = new Set(["critical", "high", "medium", "low"]);

    return raw
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null,
      )
      .map((item) => ({
        dimension: validDimensions.has(item.dimension as string)
          ? (item.dimension as keyof DeepVerifyResult["dimensions"])
          : "quality",
        severity: validSeverities.has(item.severity as string)
          ? (item.severity as SuggestedFix["severity"])
          : "medium",
        description:
          typeof item.description === "string"
            ? item.description
            : "No description",
        file: typeof item.file === "string" ? item.file : undefined,
        suggestedCode:
          typeof item.suggestedCode === "string"
            ? item.suggestedCode
            : undefined,
        autoFixable:
          typeof item.autoFixable === "boolean" ? item.autoFixable : false,
      }));
  }

  /**
   * 기본 차원 점수를 생성한다.
   */
  private createDefaultDimensions(): DeepVerifyResult["dimensions"] {
    const defaultDim: DimensionScore = {
      score: 50,
      status: "warning",
      issues: ["Unable to verify"],
      evidence: [],
    };
    return {
      correctness: { ...defaultDim },
      completeness: { ...defaultDim },
      consistency: { ...defaultDim },
      quality: { ...defaultDim },
      security: { ...defaultDim },
      performance: { ...defaultDim },
    };
  }

  /**
   * 검증 통과 기본 결과를 생성한다 (비활성화 시 사용).
   */
  private createPassResult(): DeepVerifyResult {
    const passDim: DimensionScore = {
      score: 80,
      status: "pass",
      issues: [],
      evidence: ["Deep verify disabled or skipped"],
    };
    return {
      verdict: "pass",
      overallScore: 80,
      dimensions: {
        correctness: { ...passDim },
        completeness: { ...passDim },
        consistency: { ...passDim },
        quality: { ...passDim },
        security: { ...passDim },
        performance: { ...passDim },
      },
      selfCritique: "Verification skipped",
      suggestedFixes: [],
      confidence: 1.0,
    };
  }

  /**
   * 검증 에러 시 안전한 기본 결과를 반환한다.
   */
  private createErrorResult(errorMessage: string): DeepVerifyResult {
    const errorDim: DimensionScore = {
      score: 50,
      status: "warning",
      issues: [`Verification error: ${errorMessage}`],
      evidence: [],
    };
    return {
      verdict: "concern",
      overallScore: 50,
      dimensions: {
        correctness: { ...errorDim },
        completeness: { ...errorDim },
        consistency: { ...errorDim },
        quality: { ...errorDim },
        security: { ...errorDim },
        performance: { ...errorDim },
      },
      selfCritique: `Verification failed: ${errorMessage}`,
      suggestedFixes: [],
      confidence: 0,
    };
  }

  /**
   * 출력 JSON 템플릿을 반환한다 (프롬프트에 포함).
   */
  private getOutputTemplate(): Record<string, unknown> {
    return {
      dimensions: {
        correctness: {
          score: 85,
          status: "pass",
          issues: [],
          evidence: ["Logic flows correctly for all branches"],
        },
        completeness: {
          score: 70,
          status: "warning",
          issues: ["Missing error handling for network timeout"],
          evidence: ["fetch() call at line 42 has no timeout"],
        },
        consistency: {
          score: 90,
          status: "pass",
          issues: [],
          evidence: ["Follows existing camelCase convention"],
        },
        quality: {
          score: 75,
          status: "warning",
          issues: ["Function is 80+ lines, consider splitting"],
          evidence: ["processData() handles 3 separate concerns"],
        },
        security: {
          score: 95,
          status: "pass",
          issues: [],
          evidence: ["No hardcoded secrets, inputs validated"],
        },
        performance: {
          score: 60,
          status: "warning",
          issues: ["Nested loop creates O(n*m) complexity"],
          evidence: ["Lines 55-68 iterate users inside items loop"],
        },
      },
      selfCritique:
        "The implementation achieves the goal but has completeness and performance concerns...",
      suggestedFixes: [
        {
          dimension: "completeness",
          severity: "medium",
          description: "Add timeout to fetch call",
          file: "src/api.ts",
          suggestedCode: "const controller = new AbortController(); ...",
          autoFixable: true,
        },
      ],
      confidence: 0.85,
    };
  }

  // ─── Private: Utilities ──────────────────────────────────────

  /**
   * 텍스트에서 검색 키워드를 추출한다.
   */
  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be",
      "to", "of", "and", "in", "that", "have", "it",
      "for", "not", "on", "with", "as", "do", "at",
      "this", "but", "from", "or", "by", "will",
    ]);

    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));
  }

  /**
   * 긴 내용을 최대 길이로 잘라낸다.
   */
  private truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) return content;

    const half = Math.floor(maxLength / 2);
    return (
      content.slice(0, half) +
      "\n\n... [truncated] ...\n\n" +
      content.slice(-half)
    );
  }
}
