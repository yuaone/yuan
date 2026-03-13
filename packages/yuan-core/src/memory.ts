/**
 * @module memory
 * @description YUAN.md 프로젝트 메모리 관리.
 * 프로젝트 루트의 YUAN.md를 읽고/쓰고/파싱하여 에이전트에 컨텍스트를 제공.
 */

import { readFile, writeFile, access, readdir, stat } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { YUAN_MD_SEARCH_PATHS, YUAN_DIRNAME, YUAN_MEMORY_JSON } from "./constants.js";

/** YUAN.md 파싱 결과 */
export interface YuanMemoryData {
  /** 원본 내용 */
  raw: string;
  /** 파일 경로 */
  filePath: string;
  /** 파싱된 섹션 */
  sections: Map<string, string>;
}

/** 프로젝트 구조 분석 결과 */
export interface ProjectStructure {
  /** 주 프로그래밍 언어 */
  primaryLanguage: string;
  /** 프레임워크 */
  framework: string;
  /** 패키지 매니저 */
  packageManager: string;
  /** 엔트리 포인트 */
  entryPoint: string;
  /** 디렉토리 트리 (depth 3) */
  treeView: string;
  /** 총 파일 수 */
  fileCount: number;
}

/**
 * YuanMemory — YUAN.md 기반 프로젝트 메모리.
 *
 * 역할:
 * - YUAN.md 자동 탐색 및 읽기
 * - 프로젝트 구조 자동 감지 (package.json, tsconfig 등)
 * - 메모리 업데이트/쓰기
 */
export class YuanMemory {
  private projectPath: string;
  private memoryData: YuanMemoryData | null = null;
  private projectStructure: ProjectStructure | null = null;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  /**
   * 메모리 요약 문서를 탐색하고 읽는다.
   * 우선순위:
   * 1) root YUAN.md
   * 2) legacy markdown paths
   * 3) 없으면 .yuan/memory.json을 요약 문자열로 노출
   *
   * @returns 파싱된 메모리 데이터 (없으면 null)
   */
  async load(): Promise<YuanMemoryData | null> {
    for (const searchPath of YUAN_MD_SEARCH_PATHS) {
      const fullPath = join(this.projectPath, searchPath);
      try {
        await access(fullPath);
        const content = await readFile(fullPath, "utf-8");
        this.memoryData = {
          raw: content,
          filePath: fullPath,
          sections: this.parseSections(content),
        };
        return this.memoryData;
      } catch {
        // 파일 없으면 다음 경로 시도
        continue;
      }
    }

   // 2) Fallback: .yuan/memory.json exists but YUAN.md summary not generated yet
    const jsonPath = join(this.projectPath, YUAN_DIRNAME, YUAN_MEMORY_JSON);
    try {
      await access(jsonPath);
      const rawJson = await readFile(jsonPath, "utf-8");
      const summary = [
        "# YUAN Project Memory",
        "",
        "> Loaded from .yuan/memory.json",
        "",
        "```json",
        rawJson,
        "```",
      ].join("\n");

      this.memoryData = {
        raw: summary,
        filePath: jsonPath,
        sections: this.parseSections(summary),
      };
      return this.memoryData;
    } catch {
      // continue
    }

    return null;
  }

  /**
   * 현재 로드된 메모리를 반환.
   */
  getMemory(): YuanMemoryData | null {
    return this.memoryData;
  }

  /**
   * 프로젝트 구조를 자동 감지.
   * package.json, tsconfig.json, Cargo.toml 등을 분석.
   */
  async analyzeProject(): Promise<ProjectStructure> {
    if (this.projectStructure) return this.projectStructure;

    const language = await this.detectLanguage();
    const framework = await this.detectFramework();
    const packageManager = await this.detectPackageManager();
    const entryPoint = await this.detectEntryPoint();
    const treeView = await this.buildTreeView(this.projectPath, 3);
    const fileCount = await this.countFiles(this.projectPath);

    this.projectStructure = {
      primaryLanguage: language,
      framework,
      packageManager,
      entryPoint,
      treeView,
      fileCount,
    };

    return this.projectStructure;
  }

  /**
   * YUAN.md에 섹션을 추가하거나 업데이트.
   * @param sectionName 섹션 이름 (## 헤더)
   * @param content 섹션 내용
   */
  async updateSection(
    sectionName: string,
    content: string,
  ): Promise<void> {
    if (!this.memoryData) {
      // YUAN.md 없으면 새로 생성
      const filePath = join(this.projectPath, "YUAN.md");
      const newContent = `# YUAN Project Memory\n\n## ${sectionName}\n${content}\n`;
      await writeFile(filePath, newContent, "utf-8");
      this.memoryData = {
        raw: newContent,
        filePath,
        sections: this.parseSections(newContent),
      };
      return;
    }

    // 기존 섹션이 있으면 교체, 없으면 추가
    const sections = this.memoryData.sections;
    sections.set(sectionName, content);

    const newRaw = this.sectionsToMarkdown(sections);
    await writeFile(this.memoryData.filePath, newRaw, "utf-8");
    this.memoryData.raw = newRaw;
  }

  /**
   * 시스템 프롬프트에 포함할 메모리 문자열 생성.
   */
  toPromptString(): string {
    if (!this.memoryData) return "";

    return [
      "## YUAN.md (Project Memory)",
      "",
      this.memoryData.raw,
    ].join("\n");
  }

  // ─── Private ───

  /**
   * 마크다운 ## 헤더 기준으로 섹션 분리.
   */
  private parseSections(content: string): Map<string, string> {
    const sections = new Map<string, string>();
    const lines = content.split("\n");
    let currentSection = "";
    let currentContent: string[] = [];

    for (const line of lines) {
      const headerMatch = line.match(/^##\s+(.+)$/);
      if (headerMatch) {
        if (currentSection) {
          sections.set(currentSection, currentContent.join("\n").trim());
        }
        currentSection = headerMatch[1];
        currentContent = [];
      } else {
        currentContent.push(line);
      }
    }

    if (currentSection) {
      sections.set(currentSection, currentContent.join("\n").trim());
    }

    return sections;
  }

  private sectionsToMarkdown(sections: Map<string, string>): string {
    const parts: string[] = ["# YUAN Project Memory\n"];
    for (const [name, content] of sections) {
      parts.push(`## ${name}\n${content}\n`);
    }
    return parts.join("\n");
  }

  private async detectLanguage(): Promise<string> {
    const indicators: Record<string, string> = {
      "tsconfig.json": "TypeScript",
      "package.json": "JavaScript",
      "Cargo.toml": "Rust",
      "go.mod": "Go",
      "pyproject.toml": "Python",
      "setup.py": "Python",
      "requirements.txt": "Python",
      "build.gradle": "Java",
      "pom.xml": "Java",
    };

    for (const [file, lang] of Object.entries(indicators)) {
      if (await this.fileExists(join(this.projectPath, file))) {
        return lang;
      }
    }
    return "Unknown";
  }

  private async detectFramework(): Promise<string> {
    try {
      const pkgPath = join(this.projectPath, "package.json");
      const content = await readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(content) as Record<string, unknown>;
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };

      if (deps.next) return "Next.js";
      if (deps.react) return "React";
      if (deps.vue) return "Vue";
      if (deps.svelte) return "Svelte";
      if (deps.express) return "Express";
      if (deps.fastify) return "Fastify";
      if (deps["@nestjs/core"]) return "NestJS";
      return "Node.js";
    } catch {
      // Rust
      if (await this.fileExists(join(this.projectPath, "Cargo.toml"))) {
        return "Cargo";
      }
      return "Unknown";
    }
  }

  private async detectPackageManager(): Promise<string> {
    if (await this.fileExists(join(this.projectPath, "pnpm-lock.yaml")))
      return "pnpm";
    if (await this.fileExists(join(this.projectPath, "yarn.lock")))
      return "yarn";
    if (await this.fileExists(join(this.projectPath, "package-lock.json")))
      return "npm";
    if (await this.fileExists(join(this.projectPath, "Cargo.lock")))
      return "cargo";
    if (await this.fileExists(join(this.projectPath, "go.sum")))
      return "go";
    if (
      await this.fileExists(join(this.projectPath, "requirements.txt"))
    )
      return "pip";
    return "Unknown";
  }

  private async detectEntryPoint(): Promise<string> {
    try {
      const pkgPath = join(this.projectPath, "package.json");
      const content = await readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(content) as Record<string, unknown>;
      if (pkg.main) return pkg.main as string;
      if ((pkg.scripts as Record<string, string> | undefined)?.start) return "npm start";
    } catch {
      // not a JS project
    }

    // Common entry points
    const candidates = [
      "src/index.ts",
      "src/main.ts",
      "src/index.js",
      "index.ts",
      "index.js",
      "main.py",
      "app.py",
      "src/main.rs",
      "main.go",
    ];

    for (const candidate of candidates) {
      if (
        await this.fileExists(join(this.projectPath, candidate))
      ) {
        return candidate;
      }
    }

    return "Unknown";
  }

  /**
   * 디렉토리 트리를 문자열로 생성 (depth 제한).
   */
  private async buildTreeView(
    dirPath: string,
    maxDepth: number,
    prefix = "",
    currentDepth = 0,
  ): Promise<string> {
    if (currentDepth >= maxDepth) return `${prefix}└── ...`;

    const SKIP = new Set([
      "node_modules",
      ".git",
      "dist",
      "build",
      ".next",
      "__pycache__",
      "target",
      ".cache",
      "coverage",
    ]);

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const filtered = entries
        .filter((e) => !SKIP.has(e.name) && !e.name.startsWith("."))
        .sort((a, b) => {
          // dirs first
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

      const lines: string[] = [];
      for (let i = 0; i < filtered.length; i++) {
        const entry = filtered[i];
        const isLast = i === filtered.length - 1;
        const connector = isLast ? "└── " : "├── ";
        const childPrefix = isLast ? "    " : "│   ";

        if (entry.isDirectory()) {
          lines.push(`${prefix}${connector}${entry.name}/`);
          const subtree = await this.buildTreeView(
            join(dirPath, entry.name),
            maxDepth,
            prefix + childPrefix,
            currentDepth + 1,
          );
          if (subtree) lines.push(subtree);
        } else {
          lines.push(`${prefix}${connector}${entry.name}`);
        }
      }

      return lines.join("\n");
    } catch {
      return "";
    }
  }

  /**
   * 프로젝트 내 파일 수 카운팅 (node_modules 등 제외).
   */
  private async countFiles(dirPath: string): Promise<number> {
    const SKIP = new Set([
      "node_modules",
      ".git",
      "dist",
      "build",
      ".next",
      "__pycache__",
      "target",
    ]);

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      let count = 0;

      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        if (entry.isDirectory()) {
          count += await this.countFiles(join(dirPath, entry.name));
        } else {
          count++;
        }
      }

      return count;
    } catch {
      return 0;
    }
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
