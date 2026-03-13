/**
 * @module persona
 * @description YUAN Persona & User Adaptation System.
 *
 * YUAN의 고유 페르소나(톤, 스타일, 원칙)를 정의하고,
 * 유저의 코딩 스타일·커뮤니케이션 패턴·작업 습관을 학습하여
 * 응답을 자동으로 맞춤 조정한다.
 *
 * 학습 방식:
 * - 유저 메시지 분석 → 형식/기술 수준/언어 혼용 패턴 추출
 * - 유저 코드 분석 → 들여쓰기/따옴표/세미콜론/네이밍 관습 추출
 * - 명시적 규칙 → 유저가 직접 지정한 선호 사항
 * - 추론 규칙 → 반복 관찰에서 자동 추론 (minSamples 이상)
 *
 * @example
 * ```typescript
 * const pm = new PersonaManager({ userId: "user-123", enableLearning: true });
 * await pm.loadProfile();
 *
 * pm.analyzeUserMessage("ㅇㅇ 그거 pnpm으로 해줘 ㄱㄱ");
 * pm.analyzeUserCode('const foo = "bar";\n', "src/index.ts");
 * pm.updateProfile();
 *
 * const prompt = pm.buildPersonaPrompt();
 * await pm.saveProfile();
 * ```
 */

import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

// ─── Types ───

/** YUAN 에이전트의 기본 페르소나 */
export interface YUANPersona {
  name: "YUAN";
  role: string;
  tone: "professional" | "casual" | "technical" | "friendly";
  style: "concise" | "detailed" | "action-first" | "explanation-first";
  language: "ko" | "en" | "mixed" | "auto";
  principles: string[];
}

/** 유저의 코딩 스타일 프로필 */
export interface CodingStyle {
  indentation: "tabs" | "spaces-2" | "spaces-4" | "unknown";
  quotes: "single" | "double" | "unknown";
  semicolons: boolean | null;
  trailingComma: "all" | "es5" | "none" | "unknown";
  namingConvention: "camelCase" | "snake_case" | "PascalCase" | "unknown";
  commentStyle: "jsdoc" | "inline" | "minimal" | "unknown";
  maxLineLength: number;
  preferredPatterns: string[];
}

/** 유저의 커뮤니케이션 스타일 */
export interface CommunicationStyle {
  /** 0=극캐주얼 ~ 1=격식체 */
  formality: number;
  /** 0=초보 ~ 1=전문가 */
  techLevel: number;
  /** 0=최소 ~ 1=상세 */
  verbosity: number;
  language: "ko" | "en" | "mixed";
  usesEmoji: boolean;
  usesAbbreviations: boolean;
  preferredResponseLength: "short" | "medium" | "long";
}

/** 유저의 작업 패턴 */
export interface WorkPatterns {
  preferredTools: string[];
  commonTasks: string[];
  reviewStrictness: "strict" | "moderate" | "trusting";
  commitStyle: string;
  testingPreference: "tdd" | "test-after" | "minimal" | "unknown";
}

/** 유저가 설정했거나 추론된 규칙 */
export interface UserRule {
  id: string;
  /** 규칙 내용 (예: "always use pnpm, never npm") */
  rule: string;
  source: "explicit" | "inferred";
  /** 확신도 0-1 */
  confidence: number;
  /** 이 규칙이 관찰된 메시지 예시 */
  examples: string[];
  createdAt: number;
  lastConfirmedAt: number;
}

/** 유저 프로필 전체 */
export interface UserProfile {
  userId: string;
  codingStyle: CodingStyle;
  communication: CommunicationStyle;
  workPatterns: WorkPatterns;
  explicitRules: UserRule[];
  inferredRules: UserRule[];
  totalInteractions: number;
  lastInteraction: number;
  createdAt: number;
}

/** 유저 메시지 분석 결과 */
export interface SpeechAnalysis {
  formality: number;
  techLevel: number;
  verbosity: number;
  language: "ko" | "en" | "mixed";
  usesEmoji: boolean;
  usesAbbreviations: boolean;
  avgMessageLength: number;
  detectedPatterns: string[];
}

/** PersonaManager 설정 */
export interface PersonaConfig {
  userId: string;
  /** 프로필 저장 경로 (기본: ~/.yuan/profiles/{userId}.json) */
  profilePath?: string;
  /** 학습 활성화 여부 (기본: true) */
  enableLearning?: boolean;
  /** 추론에 필요한 최소 샘플 수 (기본: 5) */
  minSamplesForInference?: number;
  /** 최대 규칙 수 (기본: 50) */
  maxRules?: number;
}

// ─── Internal types for observation tracking ───

interface CodeObservation {
  indentation: "tabs" | "spaces-2" | "spaces-4";
  quotes: "single" | "double";
  semicolons: boolean;
  namingConvention: "camelCase" | "snake_case" | "PascalCase";
  trailingComma: "all" | "es5" | "none";
  lineLength: number;
}

interface MessageObservation {
  formality: number;
  techLevel: number;
  verbosity: number;
  language: "ko" | "en" | "mixed";
  usesEmoji: boolean;
  usesAbbreviations: boolean;
  length: number;
  patterns: string[];
}

// ─── Constants ───

const DEFAULT_PROFILE_DIR = join(homedir(), ".yuan", "profiles");
const CONFIDENCE_INCREMENT = 0.1;
const MAX_CONFIDENCE = 1.0;
const MAX_EXAMPLES_PER_RULE = 5;

/** 한국어 축약어 패턴 */
const KO_ABBREVIATIONS = ["ㅇㅇ", "ㄱㄱ", "ㅋㅋ", "ㅎㅎ", "ㄴㄴ", "ㅠㅠ", "ㄷㄷ", "ㅈㅈ", "ㅇㅋ", "ㅊㅊ"];

/** 격식체 마커 (한국어) */
const FORMAL_MARKERS = ["습니다", "합니다", "입니다", "주세요", "드리", "겠습"];

/** 비격식 마커 (한국어) */
const CASUAL_MARKERS = ["해줘", "해봐", "할게", "하자", "ㄱ", "함", "셈", "임", "잇"];

/** 기술 용어 (영어) */
const TECH_TERMS = [
  "async", "await", "import", "export", "api", "endpoint", "deploy",
  "commit", "pr", "merge", "rebase", "pipeline", "ci/cd", "docker",
  "kubernetes", "webpack", "vite", "typescript", "interface", "generic",
  "middleware", "mutation", "query", "schema", "migration", "orm",
  "ssr", "csr", "sse", "websocket", "graphql", "rest", "grpc",
];

/** 이모지 패턴 */
const EMOJI_REGEX = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

/** 한국어 문자 범위 */
const KOREAN_REGEX = /[\uAC00-\uD7AF\u3131-\u318E]/;

/** 영어 문자 범위 */
const ENGLISH_REGEX = /[a-zA-Z]/;

// ─── PersonaManager ───

/**
 * YUAN 페르소나 & 유저 적응 관리자.
 *
 * YUAN의 기본 페르소나를 정의하고, 유저와의 상호작용에서
 * 코딩 스타일·커뮤니케이션 패턴·작업 습관을 학습하여
 * 시스템 프롬프트를 자동으로 조정한다.
 */
export class PersonaManager {
  private readonly config: Required<PersonaConfig>;
  private persona: YUANPersona;
  private profile: UserProfile;

  /** Maximum observations kept in memory */
  private static readonly MAX_OBSERVATIONS = 200;

  /** 코드 관찰 기록 (추론용) */
  private codeObservations: CodeObservation[] = [];
  /** 메시지 관찰 기록 (추론용) */
  private messageObservations: MessageObservation[] = [];

  constructor(config: PersonaConfig) {
    // Sanitize userId to prevent path traversal in profile file paths
    const safeUserId = config.userId.replace(/[^a-zA-Z0-9_\-]/g, "_");
    this.config = {
      userId: safeUserId,
      profilePath: config.profilePath ?? join(DEFAULT_PROFILE_DIR, `${safeUserId}.json`),
      enableLearning: config.enableLearning ?? true,
      minSamplesForInference: config.minSamplesForInference ?? 5,
      maxRules: config.maxRules ?? 50,
    };
    this.persona = this.createDefaultPersona();
    this.profile = this.createDefaultProfile();
  }

  // ─── Persona ───

  /** YUAN의 기본 페르소나를 반환한다. */
  getPersona(): YUANPersona {
    return { ...this.persona };
  }

  /**
   * 시스템 프롬프트에 삽입할 페르소나 + 유저 선호 프롬프트를 생성한다.
   *
   * @returns 시스템 프롬프트 섹션 문자열
   */
  buildPersonaPrompt(): string {
    const sections: string[] = [];

    // YUAN Identity
    sections.push("## YUAN Identity");
    sections.push(`You are ${this.persona.name}, ${this.persona.role}.`);
    sections.push(`Tone: ${this.describeTone(this.persona.tone)}.`);
    sections.push(`Style: ${this.describeStyle(this.persona.style)}.`);
    sections.push(`Language: ${this.describeLanguage(this.persona.language, this.profile.communication.language)}.`);
    sections.push("");

    // Principles
    if (this.persona.principles.length > 0) {
      sections.push("### Principles");
      for (const p of this.persona.principles) {
        sections.push(`- ${p}`);
      }
      sections.push("");
    }

    // User Preferences
    const cs = this.profile.codingStyle;
    const cm = this.profile.communication;
    const hasKnownStyle = cs.indentation !== "unknown" || cs.quotes !== "unknown";
    const hasKnownComm = cm.formality > 0 || cm.techLevel > 0;

    if (hasKnownStyle || hasKnownComm) {
      sections.push("## User Preferences (Learned)");

      if (hasKnownStyle) {
        const parts: string[] = [];
        if (cs.indentation !== "unknown") parts.push(this.describeIndentation(cs.indentation));
        if (cs.quotes !== "unknown") parts.push(`${cs.quotes} quotes`);
        if (cs.semicolons !== null) parts.push(cs.semicolons ? "semicolons" : "no semicolons");
        if (cs.namingConvention !== "unknown") parts.push(cs.namingConvention);
        if (cs.trailingComma !== "unknown") parts.push(`trailing comma: ${cs.trailingComma}`);
        if (parts.length > 0) {
          sections.push(`- Coding: ${parts.join(", ")}`);
        }
      }

      if (hasKnownComm) {
        const commParts: string[] = [];
        commParts.push(`formality: ${cm.formality.toFixed(1)}`);
        commParts.push(`tech level: ${this.describeTechLevel(cm.techLevel)}`);
        commParts.push(`prefers ${cm.preferredResponseLength} responses`);
        sections.push(`- Communication: ${commParts.join(", ")}`);
      }

      sections.push("");
    }

    // Rules
    const allRules = [...this.profile.explicitRules, ...this.profile.inferredRules]
      .filter((r) => r.confidence >= 0.5)
      .sort((a, b) => b.confidence - a.confidence);

    if (allRules.length > 0) {
      sections.push("### User Rules");
      for (const r of allRules) {
        const tag = r.source === "explicit" ? "" : ` (inferred, ${(r.confidence * 100).toFixed(0)}%)`;
        sections.push(`- ${r.rule}${tag}`);
      }
      sections.push("");
    }

    return sections.join("\n").trim();
  }

  /**
   * 유저 프로필 기반으로 응답 스타일 가이드라인을 생성한다.
   *
   * @returns 응답 가이드라인 문자열
   */
  getResponseGuidelines(): string {
    const cm = this.profile.communication;
    const lines: string[] = ["## Response Guidelines"];

    // Language
    if (cm.language === "ko") {
      lines.push("- Respond in Korean.");
    } else if (cm.language === "en") {
      lines.push("- Respond in English.");
    } else {
      lines.push("- Mix Korean and English naturally, matching the user's pattern.");
    }

    // Formality
    if (cm.formality < 0.3) {
      lines.push("- Use casual tone. Short sentences. Skip pleasantries.");
    } else if (cm.formality > 0.7) {
      lines.push("- Use formal, polite tone with complete sentences.");
    } else {
      lines.push("- Use a balanced, professional but approachable tone.");
    }

    // Verbosity
    if (cm.verbosity < 0.3) {
      lines.push("- Be concise. Code over explanation. Minimal commentary.");
    } else if (cm.verbosity > 0.7) {
      lines.push("- Provide detailed explanations with context and rationale.");
    } else {
      lines.push("- Explain key decisions briefly. Focus on what matters.");
    }

    // Tech level
    if (cm.techLevel > 0.7) {
      lines.push("- Assume expert knowledge. Skip basic explanations.");
    } else if (cm.techLevel < 0.3) {
      lines.push("- Explain technical concepts. Provide examples.");
    }

    // Emoji
    if (!cm.usesEmoji) {
      lines.push("- Do not use emojis in responses.");
    }

    // Abbreviations
    if (cm.usesAbbreviations) {
      lines.push("- Korean abbreviations (ㅇㅇ, ㄱㄱ) are acceptable.");
    }

    return lines.join("\n");
  }

  // ─── User Profile ───

  /** 현재 유저 프로필을 반환한다 (복사본). */
  getProfile(): UserProfile {
    return JSON.parse(JSON.stringify(this.profile)) as UserProfile;
  }

  /**
   * 디스크에서 유저 프로필을 로드한다.
   * 파일이 없으면 기본 프로필을 반환한다.
   *
   * @returns 로드된 유저 프로필
   */
  async loadProfile(): Promise<UserProfile> {
    try {
      await access(this.config.profilePath);
      const raw = await readFile(this.config.profilePath, "utf-8");
try {
  const data = JSON.parse(raw) as UserProfile;
  this.profile = data;
} catch {
  this.profile = this.createDefaultProfile();
}
    } catch {
      // 파일 없음 — 기본 프로필 유지
      this.profile = this.createDefaultProfile();
    }
    return this.getProfile();
  }

  /**
   * 현재 유저 프로필을 디스크에 저장한다.
   * 디렉토리가 없으면 자동 생성한다.
   */
  async saveProfile(): Promise<void> {
    const dir = dirname(this.config.profilePath);
    try {
      await access(dir);
    } catch {
      await mkdir(dir, { recursive: true });
    }

    const json = JSON.stringify(this.profile, null, 2);
    await writeFile(this.config.profilePath, json, "utf-8");
  }

  // ─── Learning ───

  /**
   * 유저 메시지를 분석하여 커뮤니케이션 패턴을 학습한다.
   *
   * @param message 유저 메시지
   * @returns 분석 결과
   */
  analyzeUserMessage(message: string): SpeechAnalysis {
    if (!this.config.enableLearning) {
      return this.createEmptyAnalysis(message);
    }

    const language = this.detectLanguageMix(message);
    const usesEmoji = EMOJI_REGEX.test(message);
    const usesAbbreviations = this.detectAbbreviations(message);
    const formality = this.analyzeFormality([message]);
    const techLevel = this.analyzeTechLevel([message]);
    const verbosity = Math.min(message.length / 500, 1.0);
    const detectedPatterns: string[] = [];

    // Pattern detection
    if (usesAbbreviations) {
      const found = KO_ABBREVIATIONS.filter((ab) => message.includes(ab));
      for (const ab of found) {
        detectedPatterns.push(`uses "${ab}"`);
      }
    }
    if (language === "mixed") {
      detectedPatterns.push("mixes Korean and English");
    }
    if (usesEmoji) {
      detectedPatterns.push("uses emoji");
    }

    const observation: MessageObservation = {
      formality,
      techLevel,
      verbosity,
      language,
      usesEmoji,
      usesAbbreviations,
      length: message.length,
      patterns: detectedPatterns,
    };
    if (this.messageObservations.length >= PersonaManager.MAX_OBSERVATIONS) {
      this.messageObservations = this.messageObservations.slice(-Math.floor(PersonaManager.MAX_OBSERVATIONS / 2));
    }
    this.messageObservations.push(observation);

    // Update profile communication incrementally
    this.profile.communication.formality = this.mergeAnalysis(
      this.profile.communication.formality, formality, 0.3,
    );
    this.profile.communication.techLevel = this.mergeAnalysis(
      this.profile.communication.techLevel, techLevel, 0.3,
    );
    this.profile.communication.verbosity = this.mergeAnalysis(
      this.profile.communication.verbosity, verbosity, 0.2,
    );
    this.profile.communication.language = language;
    this.profile.communication.usesEmoji = usesEmoji || this.profile.communication.usesEmoji;
    this.profile.communication.usesAbbreviations = usesAbbreviations || this.profile.communication.usesAbbreviations;

    // Update response length preference
    if (verbosity < 0.3) {
      this.profile.communication.preferredResponseLength = "short";
    } else if (verbosity > 0.7) {
      this.profile.communication.preferredResponseLength = "long";
    } else {
      this.profile.communication.preferredResponseLength = "medium";
    }

    this.profile.totalInteractions++;
    this.profile.lastInteraction = Date.now();

    return {
      formality,
      techLevel,
      verbosity,
      language,
      usesEmoji,
      usesAbbreviations,
      avgMessageLength: message.length,
      detectedPatterns,
    };
  }

  /**
   * 유저의 코드를 분석하여 코딩 스타일을 학습한다.
   *
   * @param code 코드 문자열
   * @param filePath 파일 경로 (확장자 기반 필터링용)
   */
  analyzeUserCode(code: string, filePath: string): void {
    if (!this.config.enableLearning) return;

    // Only analyze code files
    const ext = extname(filePath).toLowerCase();
    const codeExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".vue", ".svelte"];
    if (!codeExtensions.includes(ext)) return;

    if (code.trim().length === 0) return;

    const observation: CodeObservation = {
      indentation: this.detectIndentation(code),
      quotes: this.detectQuoteStyle(code),
      semicolons: this.detectSemicolons(code),
      namingConvention: this.detectNamingConvention(code),
      trailingComma: this.detectTrailingComma(code),
      lineLength: this.detectMaxLineLength(code),
    };
    if (this.codeObservations.length >= PersonaManager.MAX_OBSERVATIONS) {
      this.codeObservations.shift();
    }
    this.codeObservations.push(observation);

    // Update profile coding style incrementally
    this.profile.codingStyle.indentation = observation.indentation;
    this.profile.codingStyle.quotes = observation.quotes;
    this.profile.codingStyle.semicolons = observation.semicolons;
    this.profile.codingStyle.namingConvention = observation.namingConvention;
    this.profile.codingStyle.trailingComma = observation.trailingComma;

    // Rolling average for line length
    if (this.profile.codingStyle.maxLineLength === 0) {
      this.profile.codingStyle.maxLineLength = observation.lineLength;
    } else {
      this.profile.codingStyle.maxLineLength = Math.round(
        this.profile.codingStyle.maxLineLength * 0.7 + observation.lineLength * 0.3,
      );
    }
  }

  /**
   * 유저가 명시적으로 지정한 규칙을 추가한다.
   *
   * @param rule 규칙 문자열 (예: "always use pnpm, never npm")
   * @param examples 규칙이 언급된 메시지 예시
   */
  addExplicitRule(rule: string, examples: string[] = []): void {
    // Check for duplicate
    const existing = this.profile.explicitRules.find(
      (r) => r.rule.toLowerCase() === rule.toLowerCase(),
    );
    if (existing) {
      existing.lastConfirmedAt = Date.now();
      existing.confidence = Math.min(existing.confidence + CONFIDENCE_INCREMENT, MAX_CONFIDENCE);
      for (const ex of examples) {
        if (!existing.examples.includes(ex) && existing.examples.length < MAX_EXAMPLES_PER_RULE) {
          existing.examples.push(ex);
        }
      }
      return;
    }

    const newRule: UserRule = {
      id: randomUUID(),
      rule,
      source: "explicit",
      confidence: 1.0,
      examples: examples.slice(0, MAX_EXAMPLES_PER_RULE),
      createdAt: Date.now(),
      lastConfirmedAt: Date.now(),
    };
    this.profile.explicitRules.push(newRule);

    this.enforceMaxRules();
  }

  /**
   * 규칙을 ID로 제거한다.
   *
   * @param ruleId 제거할 규칙 ID
   */
  removeRule(ruleId: string): void {
    this.profile.explicitRules = this.profile.explicitRules.filter((r) => r.id !== ruleId);
    this.profile.inferredRules = this.profile.inferredRules.filter((r) => r.id !== ruleId);
  }

  /**
   * 누적된 관찰 데이터를 기반으로 프로필을 업데이트하고 규칙을 추론한다.
   * minSamplesForInference 이상의 관찰이 있을 때만 추론을 실행한다.
   */
  updateProfile(): void {
    if (!this.config.enableLearning) return;

    // Infer rules from code observations
    if (this.codeObservations.length >= this.config.minSamplesForInference) {
      this.inferCodeRules();
    }

    // Infer rules from message observations
    if (this.messageObservations.length >= this.config.minSamplesForInference) {
      this.inferMessageRules();
    }

    this.enforceMaxRules();
  }

  // ─── Code Style Detection ───

  /**
   * 코드에서 들여쓰기 스타일을 감지한다.
   *
   * @param code 소스 코드
   * @returns 감지된 들여쓰기 스타일
   */
  detectIndentation(code: string): "tabs" | "spaces-2" | "spaces-4" {
    const lines = code.split("\n").filter((l) => l.length > 0 && /^\s+/.test(l));
    let tabs = 0;
    let spaces2 = 0;
    let spaces4 = 0;

    for (const line of lines) {
      const match = line.match(/^(\s+)/);
      if (!match) continue;
      const ws = match[1];

      if (ws.includes("\t")) {
        tabs++;
      } else {
        const len = ws.length;
        if (len % 4 === 0) spaces4++;
        if (len % 2 === 0) spaces2++;
      }
    }

    if (tabs > spaces2 && tabs > spaces4) return "tabs";
    if (spaces4 >= spaces2) return "spaces-4";
    return "spaces-2";
  }

  /**
   * 코드에서 따옴표 스타일을 감지한다.
   * 템플릿 리터럴(백틱)과 import 구문 내 따옴표는 포함하되
   * 실제 사용 빈도로 판단한다.
   *
   * @param code 소스 코드
   * @returns 감지된 따옴표 스타일
   */
  detectQuoteStyle(code: string): "single" | "double" {
    // Count string literals (simple heuristic: unescaped quotes not inside template literals)
    const singleCount = (code.match(/(?<!\\)'/g) || []).length;
    const doubleCount = (code.match(/(?<!\\)"/g) || []).length;

    return singleCount >= doubleCount ? "single" : "double";
  }

  /**
   * 코드에서 세미콜론 사용 여부를 감지한다.
   *
   * @param code 소스 코드
   * @returns true=세미콜론 사용, false=미사용
   */
  detectSemicolons(code: string): boolean {
    const lines = code.split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));

    // Count lines ending with semicolons vs those that don't
    // Exclude lines that end with { } , or are blank
    const statementLines = lines.filter((l) => {
      const last = l[l.length - 1];
      return last !== "{" && last !== "}" && last !== "," && last !== "(" && last !== ")";
    });

    if (statementLines.length === 0) return true;

    const withSemicolon = statementLines.filter((l) => l.endsWith(";")).length;
    return withSemicolon / statementLines.length > 0.5;
  }

  /**
   * 코드에서 네이밍 관습을 감지한다.
   *
   * @param code 소스 코드
   * @returns 감지된 네이밍 관습
   */
  detectNamingConvention(code: string): "camelCase" | "snake_case" | "PascalCase" {
    // Extract variable/function names
    const camelCaseRegex = /(?:const|let|var|function)\s+([a-z][a-zA-Z0-9]*)/g;
    const snakeCaseRegex = /(?:const|let|var|function)\s+([a-z][a-z0-9_]*_[a-z0-9_]*)/g;
    const pascalCaseRegex = /(?:class|interface|type|enum)\s+([A-Z][a-zA-Z0-9]*)/g;

    const camelMatches = (code.match(camelCaseRegex) || []).length;
    const snakeMatches = (code.match(snakeCaseRegex) || []).length;
    const pascalMatches = (code.match(pascalCaseRegex) || []).length;

    // For variable naming, camelCase vs snake_case is most relevant
    if (snakeMatches > camelMatches && snakeMatches > pascalMatches) return "snake_case";
    if (pascalMatches > camelMatches && pascalMatches > snakeMatches) return "PascalCase";
    return "camelCase";
  }

  /**
   * 코드에서 트레일링 콤마 사용 패턴을 감지한다.
   *
   * @param code 소스 코드
   * @returns 감지된 트레일링 콤마 스타일
   */
  detectTrailingComma(code: string): "all" | "es5" | "none" {
    // Look for patterns like:
    //   value,\n} or value,\n]
    const trailingCommaPattern = /,\s*\n\s*[}\]]/g;
    const noTrailingPattern = /[^,\s]\s*\n\s*[}\]]/g;

    const trailingCount = (code.match(trailingCommaPattern) || []).length;
    const noTrailingCount = (code.match(noTrailingPattern) || []).length;

    if (trailingCount === 0 && noTrailingCount === 0) return "es5";
    if (trailingCount === 0) return "none";

    const ratio = trailingCount / (trailingCount + noTrailingCount);
    if (ratio > 0.8) return "all";
    if (ratio > 0.3) return "es5";
    return "none";
  }

  // ─── Speech Pattern Analysis ───

  /**
   * 메시지 목록에서 형식성(formality) 수준을 분석한다.
   *
   * @param messages 유저 메시지 목록
   * @returns 0(극캐주얼) ~ 1(격식체)
   */
  analyzeFormality(messages: string[]): number {
    if (messages.length === 0) return 0.5;

    let totalFormal = 0;
    let totalCasual = 0;

    for (const msg of messages) {
      for (const marker of FORMAL_MARKERS) {
        if (msg.includes(marker)) totalFormal++;
      }
      for (const marker of CASUAL_MARKERS) {
        if (msg.includes(marker)) totalCasual++;
      }
      // Abbreviations are casual
      if (this.detectAbbreviations(msg)) totalCasual += 2;
    }

    const total = totalFormal + totalCasual;
    if (total === 0) return 0.5;

    return Math.min(totalFormal / total, 1.0);
  }

  /**
   * 메시지 목록에서 기술 수준을 분석한다.
   *
   * @param messages 유저 메시지 목록
   * @returns 0(초보) ~ 1(전문가)
   */
  analyzeTechLevel(messages: string[]): number {
    if (messages.length === 0) return 0.5;

    let techTermCount = 0;
    let totalWords = 0;

    for (const msg of messages) {
      const words = msg.toLowerCase().split(/\s+/);
      totalWords += words.length;
      for (const word of words) {
        if (TECH_TERMS.includes(word.replace(/[^a-z/]/g, ""))) {
          techTermCount++;
        }
      }
    }

    if (totalWords === 0) return 0.5;

    // Tech density — capped at 1.0
    const density = techTermCount / totalWords;
    return Math.min(density * 10, 1.0);
  }

  /**
   * 메시지에서 한국어/영어 혼용 패턴을 감지한다.
   *
   * @param message 유저 메시지
   * @returns 감지된 언어 종류
   */
  detectLanguageMix(message: string): "ko" | "en" | "mixed" {
    const chars = message.replace(/\s+/g, "");
    if (chars.length === 0) return "en";

    let koCount = 0;
    let enCount = 0;

    for (const ch of chars) {
      if (KOREAN_REGEX.test(ch)) koCount++;
      else if (ENGLISH_REGEX.test(ch)) enCount++;
    }

    const total = koCount + enCount;
    if (total === 0) return "en";

    const koRatio = koCount / total;
    const enRatio = enCount / total;

    if (koRatio > 0.8) return "ko";
    if (enRatio > 0.8) return "en";
    return "mixed";
  }

  /**
   * 메시지에서 한국어 축약어 사용을 감지한다.
   *
   * @param message 유저 메시지
   * @returns 축약어 사용 여부
   */
  detectAbbreviations(message: string): boolean {
    return KO_ABBREVIATIONS.some((ab) => message.includes(ab));
  }

  // ─── Private ───

  /** 기본 유저 프로필을 생성한다. */
  private createDefaultProfile(): UserProfile {
    return {
      userId: this.config.userId,
      codingStyle: {
        indentation: "unknown",
        quotes: "unknown",
        semicolons: null,
        trailingComma: "unknown",
        namingConvention: "unknown",
        commentStyle: "unknown",
        maxLineLength: 0,
        preferredPatterns: [],
      },
      communication: {
        formality: 0.5,
        techLevel: 0.5,
        verbosity: 0.5,
        language: "mixed",
        usesEmoji: false,
        usesAbbreviations: false,
        preferredResponseLength: "medium",
      },
      workPatterns: {
        preferredTools: [],
        commonTasks: [],
        reviewStrictness: "moderate",
        commitStyle: "conventional",
        testingPreference: "unknown",
      },
      explicitRules: [],
      inferredRules: [],
      totalInteractions: 0,
      lastInteraction: Date.now(),
      createdAt: Date.now(),
    };
  }

  /** 기본 YUAN 페르소나를 생성한다. */
  private createDefaultPersona(): YUANPersona {
    return {
      name: "YUAN",
      role: "a senior software engineer and autonomous coding agent",
      tone: "professional",
      style: "action-first",
      language: "auto",
      principles: [
        "Read before writing. Understand context first.",
        "Minimal, focused changes. No unnecessary refactoring.",
        "Verify with build/test after every change.",
        "Be transparent about what you changed and why.",
        "Never expose secrets or credentials.",
        "Ask before destructive operations.",
      ],
    };
  }

  /** 코드 관찰에서 규칙을 추론한다. */
  private inferCodeRules(): void {
    const obs = this.codeObservations;
    const total = obs.length;

    // Indentation rule
    const indentCounts = this.countValues(obs.map((o) => o.indentation));
    const topIndent = this.topValue(indentCounts);
    if (topIndent && indentCounts[topIndent] / total > 0.7) {
      this.addInferredRule(
        `Use ${this.describeIndentation(topIndent as "tabs" | "spaces-2" | "spaces-4")} for indentation`,
        indentCounts[topIndent] / total,
      );
    }

    // Quote rule
    const quoteCounts = this.countValues(obs.map((o) => o.quotes));
    const topQuote = this.topValue(quoteCounts);
    if (topQuote && quoteCounts[topQuote] / total > 0.7) {
      this.addInferredRule(
        `Use ${topQuote} quotes for strings`,
        quoteCounts[topQuote] / total,
      );
    }

    // Semicolon rule
    const semiTrue = obs.filter((o) => o.semicolons).length;
    const semiFalse = obs.filter((o) => !o.semicolons).length;
    if (semiTrue / total > 0.7) {
      this.addInferredRule("Use semicolons at end of statements", semiTrue / total);
    } else if (semiFalse / total > 0.7) {
      this.addInferredRule("No semicolons (ASI style)", semiFalse / total);
    }

    // Naming convention rule
    const namingCounts = this.countValues(obs.map((o) => o.namingConvention));
    const topNaming = this.topValue(namingCounts);
    if (topNaming && namingCounts[topNaming] / total > 0.7) {
      this.addInferredRule(
        `Use ${topNaming} for variable/function naming`,
        namingCounts[topNaming] / total,
      );
    }
  }

  /** 메시지 관찰에서 규칙을 추론한다. */
  private inferMessageRules(): void {
    const obs = this.messageObservations;
    const total = obs.length;

    // Language rule
    const langCounts = this.countValues(obs.map((o) => o.language));
    const topLang = this.topValue(langCounts);
    if (topLang && langCounts[topLang] / total > 0.7) {
      const desc = topLang === "ko" ? "Korean" : topLang === "en" ? "English" : "mixed Korean/English";
      this.addInferredRule(`User prefers ${desc} communication`, langCounts[topLang] / total);
    }

    // Abbreviation rule
    const abbrCount = obs.filter((o) => o.usesAbbreviations).length;
    if (abbrCount / total > 0.5) {
      this.addInferredRule("User uses Korean abbreviations — casual style OK", abbrCount / total);
    }

    // Verbosity rule
    const avgVerbosity = obs.reduce((sum, o) => sum + o.verbosity, 0) / total;
    if (avgVerbosity < 0.3) {
      this.addInferredRule("User prefers concise messages — keep responses short", 0.5 + avgVerbosity);
    } else if (avgVerbosity > 0.7) {
      this.addInferredRule("User writes detailed messages — detailed responses OK", avgVerbosity);
    }
  }

  /**
   * 추론 규칙을 추가하거나 기존 규칙의 confidence를 업데이트한다.
   *
   * @param rule 규칙 문자열
   * @param confidence 초기 확신도
   */
  private addInferredRule(rule: string, confidence: number): void {
    const existing = this.profile.inferredRules.find(
      (r) => r.rule.toLowerCase() === rule.toLowerCase(),
    );

    if (existing) {
      existing.confidence = Math.min(
        existing.confidence + CONFIDENCE_INCREMENT,
        MAX_CONFIDENCE,
      );
      existing.lastConfirmedAt = Date.now();
      return;
    }

    this.profile.inferredRules.push({
      id: randomUUID(),
      rule,
      source: "inferred",
      confidence: Math.max(0.5, Math.min(confidence, MAX_CONFIDENCE)),
      examples: [],
      createdAt: Date.now(),
      lastConfirmedAt: Date.now(),
    });
  }

  /** 최대 규칙 수를 초과하면 낮은 confidence 규칙을 제거한다. */
  private enforceMaxRules(): void {
    const maxPerType = Math.floor(this.config.maxRules / 2);

    if (this.profile.explicitRules.length > maxPerType) {
      this.profile.explicitRules.sort((a, b) => b.confidence - a.confidence);
      this.profile.explicitRules = this.profile.explicitRules.slice(0, maxPerType);
    }

    if (this.profile.inferredRules.length > maxPerType) {
      this.profile.inferredRules.sort((a, b) => b.confidence - a.confidence);
      this.profile.inferredRules = this.profile.inferredRules.slice(0, maxPerType);
    }
  }

  /**
   * 기존 값과 새 값을 가중 병합한다 (exponential moving average).
   *
   * @param existing 기존 값
   * @param newValue 새 값
   * @param weight 새 값의 가중치 (0-1)
   * @returns 병합된 값
   */
  private mergeAnalysis(existing: number, newValue: number, weight: number): number {
    return existing * (1 - weight) + newValue * weight;
  }

  /** 코드에서 최대 줄 길이를 감지한다. */
  private detectMaxLineLength(code: string): number {
    const lines = code.split("\n");
    let maxLen = 0;
    for (const line of lines) {
      if (line.length > maxLen) maxLen = line.length;
    }
    return maxLen;
  }

  /** 빈 분석 결과를 생성한다 (학습 비활성화 시). */
  private createEmptyAnalysis(message: string): SpeechAnalysis {
    return {
      formality: 0.5,
      techLevel: 0.5,
      verbosity: 0.5,
      language: "en",
      usesEmoji: false,
      usesAbbreviations: false,
      avgMessageLength: message.length,
      detectedPatterns: [],
    };
  }

  // ─── Helpers ───

  /** 배열에서 각 값의 출현 횟수를 센다. */
  private countValues(values: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const v of values) {
      counts[v] = (counts[v] || 0) + 1;
    }
    return counts;
  }

  /** 가장 많은 값을 반환한다. */
  private topValue(counts: Record<string, number>): string | null {
    let top: string | null = null;
    let max = 0;
    for (const [key, count] of Object.entries(counts)) {
      if (count > max) {
        max = count;
        top = key;
      }
    }
    return top;
  }

  /** 톤 설명 문자열을 반환한다. */
  private describeTone(tone: YUANPersona["tone"]): string {
    switch (tone) {
      case "professional": return "Professional but approachable";
      case "casual": return "Casual and relaxed";
      case "technical": return "Technical and precise";
      case "friendly": return "Friendly and warm";
    }
  }

  /** 스타일 설명 문자열을 반환한다. */
  private describeStyle(style: YUANPersona["style"]): string {
    switch (style) {
      case "concise": return "Keep it short, code speaks louder";
      case "detailed": return "Explain thoroughly with context";
      case "action-first": return "Lead with action, explain when asked";
      case "explanation-first": return "Explain the plan, then execute";
    }
  }

  /** 언어 설명 문자열을 반환한다. */
  private describeLanguage(personaLang: YUANPersona["language"], userLang: string): string {
    if (personaLang === "auto") {
      return `Match the user's language (currently: ${userLang})`;
    }
    switch (personaLang) {
      case "ko": return "Korean";
      case "en": return "English";
      case "mixed": return "Mixed Korean/English";
      default: return "Auto-detect";
    }
  }

  /** 들여쓰기 설명 문자열을 반환한다. */
  private describeIndentation(indent: "tabs" | "spaces-2" | "spaces-4"): string {
    switch (indent) {
      case "tabs": return "tabs";
      case "spaces-2": return "2-space indentation";
      case "spaces-4": return "4-space indentation";
    }
  }

  /** 기술 수준 설명 문자열을 반환한다. */
  private describeTechLevel(level: number): string {
    if (level > 0.7) return "expert";
    if (level > 0.4) return "intermediate";
    return "beginner";
  }
}
