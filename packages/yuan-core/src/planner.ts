/**
 * @module planner
 * @description 작업 계획 수립.
 * 사용자 요청을 분석하여 ExecutionPlan을 생성하고,
 * 파일 의존관계를 추적하여 단계를 구성한다.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, extname, relative } from "node:path";
import type {
  ExecutionPlan,
  PlanStep,
  Message,
  ToolDefinition,
} from "./types.js";
import type { BYOKClient, LLMResponse } from "./llm-client.js";

/** Planner 설정 */
export interface PlannerConfig {
  /** 프로젝트 루트 경로 */
  projectPath: string;
  /** 사용 가능한 도구 목록 */
  availableTools: ToolDefinition[];
}

/** 파일 의존관계 */
export interface FileDependency {
  /** 파일 경로 */
  path: string;
  /** 이 파일이 import하는 파일들 */
  imports: string[];
  /** 이 파일을 import하는 파일들 */
  importedBy: string[];
}

/**
 * Planner — 사용자 요청을 ExecutionPlan으로 변환.
 *
 * 역할:
 * - LLM을 사용하여 자연어 요청을 구조화된 계획으로 변환
 * - 파일 의존관계 분석 (단순 import/require 추적)
 * - 독립 작업 식별 (병렬 실행 가능 여부)
 */
export class Planner {
  private readonly config: PlannerConfig;

  constructor(config: PlannerConfig) {
    this.config = config;
  }

  /**
   * LLM을 사용하여 사용자 요청에서 실행 계획을 생성.
   * @param userRequest 사용자의 자연어 요청
   * @param llmClient BYOK LLM 클라이언트
   * @returns 실행 계획
   */
  async createPlan(
    userRequest: string,
    llmClient: BYOKClient,
  ): Promise<ExecutionPlan> {
    const projectContext = await this.gatherProjectContext();

    const plannerPrompt = this.buildPlannerPrompt(
      userRequest,
      projectContext,
    );

    const messages: Message[] = [
      { role: "system", content: plannerPrompt },
      { role: "user", content: userRequest },
    ];

    const response: LLMResponse = await llmClient.chat(messages);

    return this.parsePlanResponse(response.content ?? "", userRequest);
  }

  /**
   * 프로젝트의 파일 의존관계를 분석.
   * TypeScript/JavaScript import/require 문을 추적.
   * @returns 파일별 의존관계 맵
   */
  async analyzeFileDependencies(): Promise<Map<string, FileDependency>> {
    const deps = new Map<string, FileDependency>();
    const files = await this.collectSourceFiles(this.config.projectPath);

    for (const file of files) {
      const relPath = relative(this.config.projectPath, file);
      const imports = await this.extractImports(file);

      deps.set(relPath, {
        path: relPath,
        imports,
        importedBy: [],
      });
    }

    // Build reverse lookup (importedBy)
    for (const [filePath, dep] of deps) {
      for (const imp of dep.imports) {
        const target = deps.get(imp);
        if (target) {
          target.importedBy.push(filePath);
        }
      }
    }

    return deps;
  }

  /**
   * 단순 계획 생성 (LLM 없이).
   * 단일 파일 작업이나 명확한 작업에 사용.
   * @param goal 목표
   * @param targetFiles 대상 파일
   * @param tools 필요한 도구
   */
  createSimplePlan(
    goal: string,
    targetFiles: string[],
    tools: string[] = ["file_read", "file_edit"],
  ): ExecutionPlan {
    const step: PlanStep = {
      id: "step-1",
      goal,
      targetFiles,
      readFiles: [],
      tools,
      estimatedIterations: Math.max(3, targetFiles.length * 2),
      dependsOn: [],
    };

    return {
      goal,
      steps: [step],
      estimatedTokens: step.estimatedIterations * 3000,
    };
  }

  // ─── Private ───

  private async gatherProjectContext(): Promise<string> {
    const parts: string[] = [];

    // package.json
    try {
      const pkgContent = await readFile(
        join(this.config.projectPath, "package.json"),
        "utf-8",
      );
      parts.push(`package.json:\n${pkgContent}`);
    } catch {
      // no package.json
    }

    // Directory listing (shallow)
    try {
      const entries = await readdir(this.config.projectPath, {
        withFileTypes: true,
      });
      const filtered = entries
        .filter(
          (e) =>
            !e.name.startsWith(".") &&
            e.name !== "node_modules" &&
            e.name !== "dist",
        )
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      parts.push(`Project files:\n${filtered.join("\n")}`);
    } catch {
      // can't list
    }

    return parts.join("\n\n");
  }

  private buildPlannerPrompt(
    _userRequest: string,
    projectContext: string,
  ): string {
    const toolNames = this.config.availableTools
      .map((t) => t.name)
      .join(", ");

    return `You are a code planning assistant. Analyze the user's request and create a structured execution plan.

## Project Context
${projectContext}

## Available Tools
${toolNames}

## Output Format
Respond with a JSON execution plan:
{
  "goal": "overall goal description",
  "steps": [
    {
      "id": "step-1",
      "goal": "step description",
      "targetFiles": ["file paths to modify"],
      "readFiles": ["file paths to read only"],
      "tools": ["tool names needed"],
      "estimatedIterations": 5,
      "dependsOn": []
    }
  ],
  "estimatedTokens": 30000
}

Rules:
- Break complex tasks into independent steps when possible
- Identify file dependencies to order steps correctly
- Estimate iterations conservatively (2-5 per file)
- Use dependsOn to mark sequential dependencies between steps`;
  }

  private parsePlanResponse(
    content: string,
    fallbackGoal: string,
  ): ExecutionPlan {
    // Try to extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as {
          goal?: string;
          steps?: Array<{
            id?: string;
            goal?: string;
            targetFiles?: string[];
            readFiles?: string[];
            tools?: string[];
            estimatedIterations?: number;
            dependsOn?: string[];
          }>;
          estimatedTokens?: number;
        };

        return {
          goal: parsed.goal ?? fallbackGoal,
          steps: (parsed.steps ?? []).map((s, i) => ({
            id: s.id ?? `step-${i + 1}`,
            goal: s.goal ?? "",
            targetFiles: s.targetFiles ?? [],
            readFiles: s.readFiles ?? [],
            tools: s.tools ?? ["file_read", "file_edit"],
            estimatedIterations: s.estimatedIterations ?? 5,
            dependsOn: s.dependsOn ?? [],
          })),
          estimatedTokens: parsed.estimatedTokens ?? 30_000,
        };
      } catch {
        // JSON parse failed, fall through to default
      }
    }

    // Default: single-step plan
    return this.createSimplePlan(fallbackGoal, []);
  }

  /**
   * 소스 파일을 재귀적으로 수집 (TS/JS).
   */
  private async collectSourceFiles(dirPath: string): Promise<string[]> {
    const SOURCE_EXTS = new Set([
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
    ]);
    const SKIP = new Set([
      "node_modules",
      ".git",
      "dist",
      "build",
      ".next",
    ]);

    const files: string[] = [];

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;

        const fullPath = join(dirPath, entry.name);

        if (entry.isDirectory()) {
          const subFiles = await this.collectSourceFiles(fullPath);
          files.push(...subFiles);
        } else if (SOURCE_EXTS.has(extname(entry.name))) {
          files.push(fullPath);
        }
      }
    } catch {
      // can't read directory
    }

    return files;
  }

  /**
   * 파일에서 import/require 문을 추출하여 상대 경로를 반환.
   */
  private async extractImports(filePath: string): Promise<string[]> {
    try {
      const content = await readFile(filePath, "utf-8");
      const imports: string[] = [];

      // ES import: import ... from '...'
      const esImportRegex = /import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = esImportRegex.exec(content)) !== null) {
        const source = match[1];
        if (source.startsWith(".")) {
          imports.push(this.resolveImportPath(filePath, source));
        }
      }

      // Dynamic import: import('...')
      const dynamicRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      while ((match = dynamicRegex.exec(content)) !== null) {
        const source = match[1];
        if (source.startsWith(".")) {
          imports.push(this.resolveImportPath(filePath, source));
        }
      }

      // require: require('...')
      const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      while ((match = requireRegex.exec(content)) !== null) {
        const source = match[1];
        if (source.startsWith(".")) {
          imports.push(this.resolveImportPath(filePath, source));
        }
      }

      return imports;
    } catch {
      return [];
    }
  }

  private resolveImportPath(
    fromFile: string,
    importSource: string,
  ): string {
    const dir = join(fromFile, "..");
    const resolved = join(dir, importSource);
    return relative(this.config.projectPath, resolved);
  }
}
