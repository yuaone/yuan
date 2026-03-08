/**
 * @module system-prompt
 * @description 시스템 프롬프트 생성.
 * YUAN.md 내용 + 도구 목록 + 프로젝트 구조를 조합하여
 * 에이전트의 시스템 프롬프트를 구성한다.
 */

import type { ToolDefinition } from "./types.js";
import type { ProjectStructure } from "./memory.js";

/** 시스템 프롬프트 빌드 옵션 */
export interface SystemPromptOptions {
  /** 프로젝트 구조 분석 결과 */
  projectStructure?: ProjectStructure;
  /** YUAN.md 내용 */
  yuanMdContent?: string;
  /** 사용 가능한 도구 목록 */
  tools: ToolDefinition[];
  /** 추가 규칙/지시 */
  additionalRules?: string[];
}

/**
 * 에이전트 시스템 프롬프트를 생성.
 * @param options 프롬프트 빌드 옵션
 * @returns 완성된 시스템 프롬프트 문자열
 */
export function buildSystemPrompt(options: SystemPromptOptions): string {
  const sections: string[] = [];

  // 1. 에이전트 역할 정의
  sections.push(AGENT_ROLE);

  // 2. 프로젝트 컨텍스트
  if (options.projectStructure) {
    sections.push(buildProjectSection(options.projectStructure));
  }

  // 3. YUAN.md 내용
  if (options.yuanMdContent) {
    sections.push(
      `## Project Memory (YUAN.md)\n\n${options.yuanMdContent}`,
    );
  }

  // 4. 도구 목록
  if (options.tools.length > 0) {
    sections.push(buildToolsSection(options.tools));
  }

  // 5. 규칙
  sections.push(AGENT_RULES);

  // 6. 추가 규칙
  if (options.additionalRules?.length) {
    sections.push(
      `## Additional Rules\n\n${options.additionalRules.map((r) => `- ${r}`).join("\n")}`,
    );
  }

  return sections.join("\n\n---\n\n").trim();
}

// ─── Prompt Sections ───

const AGENT_ROLE = `You are YUAN, an expert AI coding agent. You have full access to the user's project through tools.

Your job is to understand the user's request, explore the codebase, make changes, and verify correctness.

You operate in a loop: think about what to do, use tools to explore or modify the project, observe results, and repeat until the task is complete.`;

function buildProjectSection(structure: ProjectStructure): string {
  return `## Project Context

- **Language:** ${structure.primaryLanguage}
- **Framework:** ${structure.framework}
- **Package Manager:** ${structure.packageManager}
- **Entry Point:** ${structure.entryPoint}
- **Total Files:** ${structure.fileCount}

### Project Structure
\`\`\`
${structure.treeView}
\`\`\``;
}

function buildToolsSection(tools: ToolDefinition[]): string {
  const toolDescriptions = tools
    .map((t) => {
      const params = t.parameters.properties
        ? Object.keys(t.parameters.properties as Record<string, unknown>).join(", ")
        : "none";
      return `- **${t.name}**(${params}): ${t.description}`;
    })
    .join("\n");

  return `## Available Tools

You can use the following tools to explore and modify the project:

${toolDescriptions}

When you need to use a tool, include it as a tool_call in your response.`;
}

const AGENT_RULES = `## Rules

1. **Always read a file before editing it.** Understand the context first.
2. **Make minimal, focused changes.** Don't refactor unnecessarily.
3. **Run tests/build after changes** to verify correctness (when possible).
4. **Check dependencies** before changes that might break other files.
5. **Ask for user approval** before destructive operations (delete, overwrite large files).
6. **Keep the user informed** with brief status updates about your progress.
7. **Never modify files outside the project directory.**
8. **Never expose secrets** (API keys, passwords, tokens) in your responses.
9. **When done**, provide a clear summary of all changes made.`;
