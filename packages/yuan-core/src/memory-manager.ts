/**
 * @module memory-manager
 * @description YUAN 프로젝트 메모리 — 세션 간 학습 + 프로젝트 지식 (.yuan/memory.json SSOT).
 *
 * YuanMemory(memory.ts)가 YUAN.md 파일의 읽기/쓰기를 담당한다면,
 * MemoryManager는 그 위에 구조화된 학습/패턴/실패 기록을 관리한다.
 *
 * YUAN.md 파일 구조:
 * ```markdown
 * # YUAN Project Memory
 *
 * ## Project Info
 * - Language: TypeScript
 * - Framework: Next.js
 * ...
 *
 * ## Conventions
 * - use camelCase for variables
 * ...
 *
 * ## Patterns
 * ...
 *
 * ## Learnings
 * ...
 *
 * ## Failed Approaches
 * ...
 * ```
 *
 * @example
 * ```typescript
 * const mm = new MemoryManager("/path/to/project");
 * const memory = await mm.load();
 *
 * mm.addLearning("build", "Must run tsc before jest for this project");
 * mm.addPattern({ name: "Repository Pattern", description: "...", files: ["src/repo/"], frequency: 5 });
 * mm.addFailedApproach("Tried swc for build", "Incompatible with decorators");
 *
 * await mm.save(mm.getMemory());
 * ```
 */

import { readFile, writeFile, access, mkdir, rename } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import {
  YUAN_DIRNAME,
  YUAN_MEMORY_JSON,
  YUAN_GITIGNORE_ENTRY,
  YUAN_MD_SEARCH_PATHS,
} from "./constants.js";
// ─── Types ───

/** 코드베이스에서 발견된 패턴 */
export interface CodePattern {
  /** 패턴 이름 */
  name: string;
  /** 패턴 설명 */
  description: string;
  /** 이 패턴이 사용된 파일 목록 */
  files: string[];
  /** 발견 빈도 (세션마다 증가) */
  frequency: number;
}

/** 세션에서 배운 지식 */
export interface Learning {
  /** 카테고리 ("build", "test", "deploy", "style", "api", "debug") */
  category: string;
  /** 학습 내용 */
  content: string;
  /** 확신도 (0–1, 반복 확인 시 증가) */
  confidence: number;
  /** 이 학습을 확인한 세션 수 */
  sessionCount: number;
  /** 최초 생성 시각 (epoch ms) */
  createdAt: number;
}

/** 실패한 접근 방식 기록 */
export interface FailedApproach {
  /** 시도한 접근 방식 */
  approach: string;
  /** 실패 이유 */
  reason: string;
  /** 기록 시각 (epoch ms) */
  timestamp: number;
}

/** 프로젝트 메모리 전체 구조 */
export interface ProjectMemory {
  /** 프로젝트 이름 */
  projectName: string;
  /** 주 프로그래밍 언어 */
  language: string;
  /** 프레임워크 */
  framework: string;
  /** 빌드 명령어 */
  buildCommand: string;
  /** 테스트 명령어 */
  testCommand: string;
  /** 코딩 규칙 목록 ("use camelCase", "prefer const" 등) */
  conventions: string[];
  /** 발견된 코드 패턴 목록 */
  patterns: CodePattern[];
  /** 학습 기록 */
  learnings: Learning[];
  /** 실패한 접근 방식 기록 */
  failedApproaches: FailedApproach[];
  /** 마지막 업데이트 시각 (epoch ms) */
  lastUpdated: number;
}

/** 태스크에 관련된 메모리 조회 결과 */
export interface RelevantMemories {
  /** 관련 코딩 규칙 */
  conventions: string[];
  /** 관련 코드 패턴 */
  patterns: CodePattern[];
  /** 주의해야 할 실패 기록 */
  warnings: string[];
  /** 빌드/테스트 정보 */
  buildInfo: { command: string; testCommand: string };
}

// ─── Constants ───

const MAX_LEARNINGS = 100;
const MAX_PATTERNS = 50;
const MAX_FAILED_APPROACHES = 30;
const CONFIDENCE_INCREMENT = 0.15;
const MAX_CONFIDENCE = 1.0;

// ─── MemoryManager ───

/**
* MemoryManager — .yuan/memory.json 기반 구조화된 프로젝트 메모리.
 *
* YuanMemory가 YUAN.md human summary를 담당한다면,
 * MemoryManager는 구조화된 학습, 패턴, 실패 기록을 관리한다.
* 실제 SSOT는 .yuan/memory.json 이고, YUAN.md는 사람이 읽는 요약본이다.
 */
export class MemoryManager {
  private readonly workDir: string;
  private memory: ProjectMemory;

  constructor(workDir: string) {
    this.workDir = workDir;
    this.memory = this.createEmptyMemory();
  }

  /**
+   * .yuan/memory.json을 로드하거나, legacy YUAN.md를 import 하거나, 새로 생성한다.
+   * 절대 throw 없이 부트스트랩 가능해야 한다.
   *
   * @returns 로드된 프로젝트 메모리
   */
  async load(): Promise<ProjectMemory> {
    const { memoryJsonPath } = this.getStoragePaths();
// 1) New SSOT: .yuan/memory.json
    try {
      await access(memoryJsonPath);
      const raw = await readFile(memoryJsonPath, "utf-8");
      this.memory = this.parseMemoryJson(raw);
      return { ...this.memory };
    } catch {
      // continue
    }

    // 2) Legacy fallback: YUAN.md import
    const imported = await this.tryImportLegacyMarkdown();
    if (imported) {
      this.memory = imported;
      await this.save(this.memory);
      return { ...this.memory };
    }

    // 3) Fresh workspace bootstrap
    this.memory = this.createEmptyMemory();
    await this.detectProjectInfo();
    await this.save(this.memory);
   
    return { ...this.memory };
  }

  /**
 * 현재 메모리를 .yuan/memory.json + YUAN.md에 저장한다.
   *
   * @param memory 저장할 메모리 (미지정 시 현재 내부 상태)
   */
  async save(memory?: ProjectMemory): Promise<void> {
    if (memory) {
      this.memory = { ...memory };
    }
    this.memory.lastUpdated = Date.now();

    const { yuanDir, memoryJsonPath, humanSummaryPath } = this.getStoragePaths();
    await mkdir(yuanDir, { recursive: true });
    await this.ensureGitignoreEntry();

    const json = JSON.stringify(this.memory, null, 2);
    await this.atomicWrite(memoryJsonPath, json);
    await this.atomicWrite(humanSummaryPath, this.serializeToMarkdown(this.memory));
  }

  /**
   * 현재 메모리를 반환한다 (얕은 복사본).
   */
  getMemory(): ProjectMemory {
    return { ...this.memory };
  }

  /**
   * 세션에서 배운 지식을 추가한다.
   * 동일한 내용이 이미 있으면 confidence와 sessionCount를 증가시킨다.
   *
   * @param category 학습 카테고리 ("build", "test", "deploy", "style", "api", "debug")
   * @param content 학습 내용
   */
  addLearning(category: string, content: string): void {
    const existing = this.memory.learnings.find(
      (l) => l.category === category && l.content === content,
    );

    if (existing) {
      existing.sessionCount++;
      existing.confidence = Math.min(
        existing.confidence + CONFIDENCE_INCREMENT,
        MAX_CONFIDENCE,
      );
      return;
    }

    this.memory.learnings.push({
      category,
      content,
      confidence: CONFIDENCE_INCREMENT,
      sessionCount: 1,
      createdAt: Date.now(),
    });

    // 한도 초과 시 가장 낮은 confidence의 학습 제거
    if (this.memory.learnings.length > MAX_LEARNINGS) {
      this.memory.learnings.sort((a, b) => b.confidence - a.confidence);
      this.memory.learnings = this.memory.learnings.slice(0, MAX_LEARNINGS);
    }
  }

  /**
   * 코드베이스에서 발견된 패턴을 기록한다.
   * 동일한 이름의 패턴이 있으면 frequency를 증가시키고 파일 목록을 병합한다.
   *
   * @param pattern 발견된 코드 패턴
   */
  addPattern(pattern: CodePattern): void {
    const existing = this.memory.patterns.find(
      (p) => p.name === pattern.name,
    );

    if (existing) {
      existing.frequency += 1;
      existing.description = pattern.description || existing.description;
      // 파일 목록 병합 (중복 제거)
      const merged = new Set([...existing.files, ...pattern.files]);
      existing.files = [...merged];
      return;
    }

    this.memory.patterns.push({ ...pattern });

    if (this.memory.patterns.length > MAX_PATTERNS) {
      this.memory.patterns.sort((a, b) => b.frequency - a.frequency);
      this.memory.patterns = this.memory.patterns.slice(0, MAX_PATTERNS);
    }
  }

  /**
   * 실패한 접근 방식을 기록하여 같은 실수를 반복하지 않도록 한다.
   *
   * @param approach 시도한 접근 방식
   * @param reason 실패 이유
   */
  addFailedApproach(approach: string, reason: string): void {
    // 중복 체크
    const exists = this.memory.failedApproaches.some(
      (f) => f.approach === approach,
    );
    if (exists) return;

    this.memory.failedApproaches.push({
      approach,
      reason,
      timestamp: Date.now(),
    });

    if (this.memory.failedApproaches.length > MAX_FAILED_APPROACHES) {
      // 오래된 것부터 제거
      this.memory.failedApproaches.sort((a, b) => b.timestamp - a.timestamp);
      this.memory.failedApproaches = this.memory.failedApproaches.slice(
        0,
        MAX_FAILED_APPROACHES,
      );
    }
  }

  /**
   * 코딩 규칙을 추가한다.
   *
   * @param convention 규칙 문자열 ("use camelCase" 등)
   */
  addConvention(convention: string): void {
    if (!this.memory.conventions.includes(convention)) {
      this.memory.conventions.push(convention);
    }
  }

  /**
   * 태스크 설명에 관련된 메모리를 조회한다.
   * 키워드 매칭으로 관련 학습, 패턴, 경고를 필터링한다.
   *
   * @param taskDescription 태스크 설명
   * @returns 관련 메모리
   */
  getRelevant(taskDescription: string): RelevantMemories {
    const keywords = this.extractKeywords(taskDescription);

    // 관련 규칙: 항상 전체 반환
    const conventions = [...this.memory.conventions];

    // 관련 패턴: 키워드 매칭
    const patterns = this.memory.patterns.filter((p) =>
      keywords.some(
        (kw) =>
          p.name.toLowerCase().includes(kw) ||
          p.description.toLowerCase().includes(kw) ||
          p.files.some((f) => f.toLowerCase().includes(kw)),
      ),
    );

    // 경고: 키워드와 매칭되는 실패 기록
    const warnings = this.memory.failedApproaches
      .filter((f) =>
        keywords.some(
          (kw) =>
            f.approach.toLowerCase().includes(kw) ||
            f.reason.toLowerCase().includes(kw),
        ),
      )
      .map((f) => `WARNING: "${f.approach}" failed because: ${f.reason}`);

    // 관련 학습도 경고에 추가 (높은 confidence만)
    const relevantLearnings = this.memory.learnings.filter(
      (l) =>
        l.confidence >= 0.5 &&
        keywords.some(
          (kw) =>
            l.content.toLowerCase().includes(kw) ||
            l.category.toLowerCase().includes(kw),
        ),
    );
    for (const l of relevantLearnings) {
      warnings.push(`TIP [${l.category}]: ${l.content}`);
    }

    return {
      conventions,
      patterns,
      warnings,
      buildInfo: {
        command: this.memory.buildCommand || "unknown",
        testCommand: this.memory.testCommand || "unknown",
      },
    };
  }

  /**
   * 오래되거나 신뢰도가 낮은 메모리를 정리한다.
   *
   * @param maxEntries 각 카테고리별 최대 항목 수 (기본값: 각 카테고리 기본 한도)
   */
  prune(maxEntries?: number): void {
    const maxL = maxEntries ?? MAX_LEARNINGS;
    const maxP = maxEntries ?? MAX_PATTERNS;
    const maxF = maxEntries ?? MAX_FAILED_APPROACHES;

    // 학습: confidence 순 유지
    if (this.memory.learnings.length > maxL) {
      this.memory.learnings.sort((a, b) => b.confidence - a.confidence);
      this.memory.learnings = this.memory.learnings.slice(0, maxL);
    }

    // 패턴: frequency 순 유지
    if (this.memory.patterns.length > maxP) {
      this.memory.patterns.sort((a, b) => b.frequency - a.frequency);
      this.memory.patterns = this.memory.patterns.slice(0, maxP);
    }

    // 실패: 최신 유지
    if (this.memory.failedApproaches.length > maxF) {
      this.memory.failedApproaches.sort((a, b) => b.timestamp - a.timestamp);
      this.memory.failedApproaches = this.memory.failedApproaches.slice(0, maxF);
    }

    // 오래된 실패 기록 제거 (90일 이상)
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    this.memory.failedApproaches = this.memory.failedApproaches.filter(
      (f) => f.timestamp > cutoff,
    );

    // 극도로 낮은 confidence 학습 제거
    this.memory.learnings = this.memory.learnings.filter(
      (l) => l.confidence > 0.05,
    );
  }

 private getStoragePaths(): {
    yuanDir: string;
    memoryJsonPath: string;
    humanSummaryPath: string;
  } {
    const yuanDir = join(this.workDir, YUAN_DIRNAME);
    return {
      yuanDir,
      memoryJsonPath: join(yuanDir, YUAN_MEMORY_JSON),
      humanSummaryPath: join(this.workDir, "YUAN.md"),
    };
  }

  private parseMemoryJson(raw: string): ProjectMemory {
 let parsed: Partial<ProjectMemory>;
 try {
   parsed = JSON.parse(raw);
 } catch {
   parsed = {};
 }
    const base = this.createEmptyMemory();

    return {
      ...base,
      ...parsed,
      conventions: Array.isArray(parsed.conventions) ? parsed.conventions : [],
      patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
      learnings: Array.isArray(parsed.learnings) ? parsed.learnings : [],
      failedApproaches: Array.isArray(parsed.failedApproaches)
        ? parsed.failedApproaches
        : [],
      lastUpdated:
        typeof parsed.lastUpdated === "number"
          ? parsed.lastUpdated
          : Date.now(),
    };
  }

  private async tryImportLegacyMarkdown(): Promise<ProjectMemory | null> {
    for (const relPath of YUAN_MD_SEARCH_PATHS) {
      const fullPath = join(this.workDir, relPath);
      try {
        await access(fullPath);
        const raw = await readFile(fullPath, "utf-8");
        return this.parseMemoryMarkdown(raw);
      } catch {
        continue;
      }
    }

    return null;
  }

  private async ensureGitignoreEntry(): Promise<void> {
    const gitignorePath = join(this.workDir, ".gitignore");

    try {
      let content = "";
      try {
        content = await readFile(gitignorePath, "utf-8");
      } catch {
        // no .gitignore yet
      }

      const hasEntry = content
        .split("\n")
        .map((line) => line.trim())
        .includes(YUAN_GITIGNORE_ENTRY);

      if (!hasEntry) {
        const next = content.trim().length > 0
          ? `${content.replace(/\s*$/, "")}\n${YUAN_GITIGNORE_ENTRY}\n`
          : `${YUAN_GITIGNORE_ENTRY}\n`;
        await this.atomicWrite(gitignorePath, next);
      }
    } catch {
      // gitignore write failure is non-fatal
    }
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await writeFile(tmpPath, content, "utf-8");
 try {
   await rename(tmpPath, filePath);
 } catch {
   await writeFile(filePath, content, "utf-8");
 }
  }

  // ─── Private: Serialization ───

  private serializeToMarkdown(memory: ProjectMemory): string {
    const sections: string[] = [];

    // Header
    sections.push(`# YUAN Project Memory\n`);
    sections.push(`> Auto-generated by YUAN Agent. Last updated: ${new Date(memory.lastUpdated).toISOString()}\n`);

    // Project Info
    sections.push(`## Project Info\n`);
    sections.push(`- **Name:** ${memory.projectName}`);
    sections.push(`- **Language:** ${memory.language}`);
    sections.push(`- **Framework:** ${memory.framework}`);
    sections.push(`- **Build:** \`${memory.buildCommand}\``);
    sections.push(`- **Test:** \`${memory.testCommand}\``);
    sections.push(`- **Persistence:** workspace-local`);
    sections.push(`- **Storage:** \`.yuan/${YUAN_MEMORY_JSON}\``);
    sections.push("");

    // Conventions
    if (memory.conventions.length > 0) {
      sections.push(`## Conventions\n`);
      for (const c of memory.conventions) {
        sections.push(`- ${c}`);
      }
      sections.push("");
    }

    // Patterns
    if (memory.patterns.length > 0) {
      sections.push(`## Patterns\n`);
      for (const p of memory.patterns) {
        sections.push(`### ${p.name} (freq: ${p.frequency})`);
        sections.push(p.description);
        if (p.files.length > 0) {
          sections.push(`Files: ${p.files.join(", ")}`);
        }
        sections.push("");
      }
    }

    // Learnings
    if (memory.learnings.length > 0) {
      sections.push(`## Learnings\n`);
      // 높은 confidence 먼저
      const sorted = [...memory.learnings].sort((a, b) => b.confidence - a.confidence);
      for (const l of sorted) {
        sections.push(
          `- [${l.category}] (confidence: ${l.confidence.toFixed(2)}, sessions: ${l.sessionCount}) ${l.content}`,
        );
      }
      sections.push("");
    }

    // Failed Approaches
    if (memory.failedApproaches.length > 0) {
      sections.push(`## Failed Approaches\n`);
      for (const f of memory.failedApproaches) {
        const date = new Date(f.timestamp).toISOString().split("T")[0];
        sections.push(`- [${date}] **${f.approach}** — ${f.reason}`);
      }
      sections.push("");
    }

    return sections.join("\n");
  }

  private parseMemoryMarkdown(raw: string): ProjectMemory {
    const memory = this.createEmptyMemory();
    const lines = raw.split("\n");

    let currentSection = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Section header detection
      const h2Match = line.match(/^## (.+)$/);
      if (h2Match) {
        currentSection = h2Match[1].trim();
        continue;
      }

      switch (currentSection) {
        case "Project Info":
          this.parseProjectInfoLine(line, memory);
          break;
        case "Conventions":
          this.parseConventionLine(line, memory);
          break;
        case "Patterns": {
          const h3Match = line.match(/^### (.+?) \(freq: (\d+)\)$/);
          if (h3Match) {
            const pattern: CodePattern = {
              name: h3Match[1],
              description: "",
              files: [],
              frequency: parseInt(h3Match[2], 10),
            };

            // 다음 줄들에서 description과 files 파싱
            let j = i + 1;
            while (j < lines.length && !lines[j].startsWith("##") && !lines[j].startsWith("### ")) {
              const pLine = lines[j].trim();
              if (pLine.startsWith("Files: ")) {
                pattern.files = pLine
                  .slice(7)
                  .split(", ")
                  .map((f) => f.trim())
                  .filter(Boolean);
              } else if (pLine.length > 0) {
                pattern.description = pLine;
              }
              j++;
            }
            i = j - 1;
            memory.patterns.push(pattern);
          }
          break;
        }
        case "Learnings":
          this.parseLearningLine(line, memory);
          break;
        case "Failed Approaches":
          this.parseFailedApproachLine(line, memory);
          break;
      }
    }

    return memory;
  }

  private parseProjectInfoLine(line: string, memory: ProjectMemory): void {
    const kvMatch = line.match(/^- \*\*(.+?):\*\*\s*`?(.+?)`?\s*$/);
    if (!kvMatch) return;

    const key = kvMatch[1].toLowerCase();
    const value = kvMatch[2];

    switch (key) {
      case "name":
        memory.projectName = value;
        break;
      case "language":
        memory.language = value;
        break;
      case "framework":
        memory.framework = value;
        break;
      case "build":
        memory.buildCommand = value;
        break;
      case "test":
        memory.testCommand = value;
        break;
    }
  }

  private parseConventionLine(line: string, memory: ProjectMemory): void {
    const match = line.match(/^- (.+)$/);
    if (match) {
      memory.conventions.push(match[1].trim());
    }
  }

  private parseLearningLine(line: string, memory: ProjectMemory): void {
    // Format: - [category] (confidence: 0.30, sessions: 2) content
    const match = line.match(
      /^- \[(.+?)\] \(confidence: ([\d.]+), sessions: (\d+)\) (.+)$/,
    );
    if (match) {
      memory.learnings.push({
        category: match[1],
        confidence: parseFloat(match[2]),
        sessionCount: parseInt(match[3], 10),
        content: match[4],
        createdAt: Date.now(),
      });
    }
  }

  private parseFailedApproachLine(line: string, memory: ProjectMemory): void {
    // Format: - [YYYY-MM-DD] **approach** — reason
    const match = line.match(
      /^- \[(\d{4}-\d{2}-\d{2})\] \*\*(.+?)\*\* — (.+)$/,
    );
    if (match) {
      memory.failedApproaches.push({
        approach: match[2],
        reason: match[3],
        timestamp: new Date(match[1]).getTime(),
      });
    }
  }

  // ─── Private: Project Detection ───

  private async detectProjectInfo(): Promise<void> {
    // 프로젝트 이름: 디렉토리 이름
this.memory.projectName = basename(this.workDir) || "unknown";

    // package.json에서 정보 추출
    try {
      const pkgPath = join(this.workDir, "package.json");
      const raw = await readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(raw) as Record<string, unknown>;

      if (pkg.name) {
        this.memory.projectName = String(pkg.name);
      }

      const scripts = pkg.scripts as Record<string, string> | undefined;
      if (scripts?.build) {
        this.memory.buildCommand = `npm run build`;
      }
      if (scripts?.test) {
        this.memory.testCommand = `npm run test`;
      }

      // 패키지 매니저 감지
      const hasLock = await this.detectPackageManager();
      if (hasLock) {
  if (this.memory.buildCommand.includes("npm")) {
    this.memory.buildCommand = this.memory.buildCommand.replace("npm", hasLock);
  }
  if (this.memory.testCommand.includes("npm")) {
    this.memory.testCommand = this.memory.testCommand.replace("npm", hasLock);
  }
      }

      // 언어/프레임워크 감지
      await this.detectLanguageAndFramework(pkg);
    } catch {
      // package.json 없음 — 다른 감지 방법 시도
      await this.detectNonNodeProject();
    }
  }

  private async detectPackageManager(): Promise<string | null> {
    const checks: [string, string][] = [
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["package-lock.json", "npm"],
    ];

    for (const [file, manager] of checks) {
      try {
        await access(join(this.workDir, file));
        return manager;
      } catch {
        continue;
      }
    }
    return null;
  }

  private async detectLanguageAndFramework(
    pkg: Record<string, unknown>,
  ): Promise<void> {
    // TypeScript check
    try {
      await access(join(this.workDir, "tsconfig.json"));
      this.memory.language = "TypeScript";
    } catch {
      this.memory.language = "JavaScript";
    }

    // Framework from dependencies
    const deps: Record<string, string> = {
      ...(pkg.dependencies as Record<string, string> | undefined),
      ...(pkg.devDependencies as Record<string, string> | undefined),
    };

    if (deps.next) this.memory.framework = "Next.js";
    else if (deps.react) this.memory.framework = "React";
    else if (deps.vue) this.memory.framework = "Vue";
    else if (deps.svelte) this.memory.framework = "Svelte";
    else if (deps.express) this.memory.framework = "Express";
    else if (deps.fastify) this.memory.framework = "Fastify";
    else if (deps["@nestjs/core"]) this.memory.framework = "NestJS";
    else this.memory.framework = "Node.js";
  }

  private async detectNonNodeProject(): Promise<void> {
    const indicators: [string, string, string][] = [
      ["Cargo.toml", "Rust", "Cargo"],
      ["go.mod", "Go", "Go"],
      ["pyproject.toml", "Python", "Python"],
      ["setup.py", "Python", "Python"],
      ["requirements.txt", "Python", "Python"],
      ["build.gradle", "Java", "Gradle"],
      ["pom.xml", "Java", "Maven"],
    ];

    for (const [file, lang, framework] of indicators) {
      try {
        await access(join(this.workDir, file));
        this.memory.language = lang;
        this.memory.framework = framework;
        return;
      } catch {
        continue;
      }
    }
  }

  // ─── Private: Helpers ───

  private createEmptyMemory(): ProjectMemory {
    return {
      projectName: "",
      language: "",
      framework: "",
      buildCommand: "",
      testCommand: "",
      conventions: [],
      patterns: [],
      learnings: [],
      failedApproaches: [],
      lastUpdated: Date.now(),
    };
  }

  /**
   * 태스크 설명에서 검색용 키워드를 추출한다.
   * 소문자로 변환하고 불용어를 제거한다.
   */
  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be",
      "to", "of", "and", "in", "that", "have", "it",
      "for", "not", "on", "with", "as", "do", "at",
      "this", "but", "from", "or", "by", "will", "my",
      "all", "can", "had", "her", "one", "our", "out",
    ]);

    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));
  }
}
