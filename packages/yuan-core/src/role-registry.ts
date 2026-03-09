/**
 * @module role-registry
 * @description 고정 에이전트 롤 8종의 설정 레지스트리.
 *
 * 각 롤에 추천 모델, 이터레이션 제한, 허용 도구, 우선순위,
 * 시스템 프롬프트 템플릿을 정의한다.
 */

import type { FixedAgentRole, AgentRole } from "./types.js";

// ─── RoleConfig ───

/** 고정 롤 설정 */
export interface RoleConfig {
  /** 대상 롤 */
  role: FixedAgentRole;
  /** 추천 모델 (BYOK에서 오버라이드 가능) */
  model: string;
  /** 롤별 최대 이터레이션 */
  maxIterations: number;
  /** 사용 가능 도구 목록 */
  allowedTools: string[];
  /** 스케줄링 우선순위 (1 = highest) */
  priority: number;
  /** 시스템 프롬프트 템플릿 — `{context}` 플레이스홀더 포함 */
  systemPromptTemplate: string;
}

// ─── Static registry (8 fixed roles) ───

const ROLE_CONFIGS: Record<FixedAgentRole, RoleConfig> = {
  orchestrator: {
    role: "orchestrator",
    model: "claude-opus",
    maxIterations: 10,
    allowedTools: ["planner", "dag"],
    priority: 1,
    systemPromptTemplate: [
      "You are the Orchestrator.",
      "Plan tasks, assign roles to sub-agents, manage token budget, and coordinate parallel execution.",
      "You have full visibility over the DAG and are responsible for re-planning on failure.",
      "",
      "Project context:",
      "{context}",
    ].join("\n"),
  },

  coder: {
    role: "coder",
    model: "claude-sonnet",
    maxIterations: 25,
    allowedTools: [
      "file_read",
      "file_write",
      "file_edit",
      "shell_exec",
      "grep",
      "glob",
      "git_ops",
      "test_run",
    ],
    priority: 2,
    systemPromptTemplate: [
      "You are a Coder agent.",
      "Write clean, secure, production-quality code.",
      "Follow the project's conventions, use existing patterns, and never duplicate shared types.",
      "Always verify your changes compile (tsc) before finishing.",
      "",
      "Project context:",
      "{context}",
    ].join("\n"),
  },

  reviewer: {
    role: "reviewer",
    model: "gemini-pro",
    maxIterations: 10,
    allowedTools: ["file_read", "grep", "glob", "shell_exec", "test_run"],
    priority: 3,
    systemPromptTemplate: [
      "You are a Reviewer agent.",
      "Validate code changes through a 2-stage pipeline:",
      "1. Structural: type-check, lint, build, test, import integrity, schema conformance.",
      "2. Semantic: goal achievement, code quality, regression safety, security, conventions.",
      "Report issues with actionable fix suggestions.",
      "",
      "Project context:",
      "{context}",
    ].join("\n"),
  },

  memory: {
    role: "memory",
    model: "gpt-4o-mini",
    maxIterations: 5,
    allowedTools: ["file_read", "file_write", "grep"],
    priority: 4,
    systemPromptTemplate: [
      "You are the Memory agent.",
      "Compress context, update YUAN.md with learnings, and manage session checkpoints.",
      "Keep summaries concise but preserve critical details for session continuation.",
      "",
      "Project context:",
      "{context}",
    ].join("\n"),
  },

  search: {
    role: "search",
    model: "gpt-4o",
    maxIterations: 10,
    allowedTools: ["web_fetch", "web_search", "grep", "glob", "code_search"],
    priority: 3,
    systemPromptTemplate: [
      "You are a Search agent.",
      "Find relevant code, documentation, and web resources.",
      "Use semantic code search for codebase exploration and web search for external knowledge.",
      "Return structured, actionable results.",
      "",
      "Project context:",
      "{context}",
    ].join("\n"),
  },

  security: {
    role: "security",
    model: "claude-sonnet",
    maxIterations: 10,
    allowedTools: ["file_read", "grep", "glob", "shell_exec"],
    priority: 2,
    systemPromptTemplate: [
      "You are a Security agent.",
      "Scan for vulnerabilities, exposed secrets, OWASP issues, and insecure patterns.",
      "Flag any secret literals, SQL injection vectors, XSS risks, or unsafe deserialization.",
      "Report findings with severity and remediation steps.",
      "",
      "Project context:",
      "{context}",
    ].join("\n"),
  },

  data: {
    role: "data",
    model: "gpt-4o",
    maxIterations: 15,
    allowedTools: ["file_read", "file_write", "shell_exec"],
    priority: 4,
    systemPromptTemplate: [
      "You are a Data agent.",
      "Analyze data, generate visualizations, transform datasets, and produce reports.",
      "Use shell commands for data processing when appropriate.",
      "",
      "Project context:",
      "{context}",
    ].join("\n"),
  },

  automation: {
    role: "automation",
    model: "gpt-4o-mini",
    maxIterations: 10,
    allowedTools: ["shell_exec", "web_fetch", "file_read", "file_write"],
    priority: 4,
    systemPromptTemplate: [
      "You are an Automation agent.",
      "Execute workflows, call external APIs, run scripts, and automate repetitive tasks.",
      "Always validate responses and handle errors gracefully.",
      "",
      "Project context:",
      "{context}",
    ].join("\n"),
  },
};

// ─── Fixed role set for O(1) lookups ───

const FIXED_ROLES = new Set<string>(Object.keys(ROLE_CONFIGS));

// ─── RoleConfigRegistry ───

/**
 * 고정 에이전트 롤 8종의 설정 레지스트리.
 *
 * - `getConfig(role)` — 롤 설정 조회
 * - `getAllRoles()` — 전체 고정 롤 목록
 * - `isFixedRole(role)` — AgentRole이 고정 롤인지 판별
 * - `getSystemPrompt(role, context)` — 컨텍스트를 주입한 시스템 프롬프트 생성
 */
export class RoleConfigRegistry {
  /**
   * 고정 롤의 설정을 반환한다.
   * @throws 존재하지 않는 롤이면 Error
   */
  getConfig(role: FixedAgentRole): RoleConfig {
    const config = ROLE_CONFIGS[role];
    if (!config) {
      throw new Error(`Unknown fixed role: ${role}`);
    }
    return config;
  }

  /** 모든 고정 롤 목록 반환 */
  getAllRoles(): FixedAgentRole[] {
    return Object.keys(ROLE_CONFIGS) as FixedAgentRole[];
  }

  /**
   * AgentRole이 고정 롤(FixedAgentRole)인지 판별한다.
   *
   * @returns `true`이면 role은 FixedAgentRole, `false`이면 DynamicAgentRole
   */
  isFixedRole(role: AgentRole): role is FixedAgentRole {
    return typeof role === "string" && FIXED_ROLES.has(role);
  }

  /**
   * 시스템 프롬프트 템플릿에 컨텍스트를 주입하여 완성된 프롬프트를 반환한다.
   *
   * @param role - 고정 롤
   * @param context - 프로젝트 컨텍스트 문자열 (파일 구조, YUAN.md 등)
   * @throws 존재하지 않는 롤이면 Error
   */
  getSystemPrompt(role: FixedAgentRole, context: string): string {
    const config = this.getConfig(role);
    return config.systemPromptTemplate.replace("{context}", context);
  }
}
