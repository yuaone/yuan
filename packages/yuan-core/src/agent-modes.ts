/**
 * @module agent-modes
 * @description YUAN Agent 실행 모드 프리셋.
 * 각 모드는 시스템 프롬프트 보충, 도구 제한, 반복 제한, 출력 형식을 정의한다.
 *
 * 사용법:
 * ```typescript
 * const mode = getAgentModeConfig("review");
 * // mode.allowedTools → 사용 가능 도구
 * // mode.systemPromptSuffix → 시스템 프롬프트에 추가
 * ```
 */

// ─── Types ───

/** 에이전트 실행 모드 */
export type AgentMode =
  | "code"
  | "report"
  | "review"
  | "security"
  | "debug"
  | "refactor"
  | "test"
  | "plan"
  | "architect";

/** 출력 형식 */
export type AgentOutputFormat = "streaming" | "report" | "checklist" | "diff";

/** 자동 승인 수준 */
export type AutoApproveLevel = "none" | "reads" | "safe_writes" | "all";

/** 에이전트 모드 설정 */
export interface AgentModeConfig {
  /** 모드 식별자 */
  mode: AgentMode;
  /** 시스템 프롬프트에 추가될 모드별 지시 */
  systemPromptSuffix: string;
  /** 이 모드에서 허용되는 도구 이름 목록 (빈 배열 = 전체 허용) */
  allowedTools: string[];
  /** 이 모드에서 명시적으로 거부되는 도구 이름 목록 */
  deniedTools?: string[];
  /** 최대 반복 횟수 오버라이드 */
  maxIterations: number;
  /** 파일 쓰기 가능 여부 */
  canWrite: boolean;
  /** 명령어 실행 가능 여부 */
  canExecute: boolean;
  /** 출력 형식 */
  outputFormat: AgentOutputFormat;
  /** 자동 승인 수준 */
  autoApprove: AutoApproveLevel;
  /** CLI help에 표시할 설명 */
  description: string;
}

// ─── Read-Only Tools ───

const READ_ONLY_TOOLS = [
  "file_read",
  "grep",
  "glob",
  "code_search",
] as const;

const GIT_READ_TOOLS = [
  "git_diff",
  "git_log",
  "git_status",
] as const;

const ALL_TOOLS_MARKER: string[] = [];

// ─── Mode Configs ───

const CODE_MODE: AgentModeConfig = {
  mode: "code",
  systemPromptSuffix: "",
  allowedTools: ALL_TOOLS_MARKER,
  maxIterations: 25,
  canWrite: true,
  canExecute: true,
  outputFormat: "streaming",
  autoApprove: "safe_writes",
  description: "Default autonomous coding mode. Full tool access with safe-write auto-approval.",
};

const REPORT_MODE: AgentModeConfig = {
  mode: "report",
  systemPromptSuffix: `You are a codebase analyst. Your job is to generate a comprehensive report about the project.

## Report Guidelines
- Start by understanding the project structure, entry points, and dependencies.
- Analyze code quality, architecture patterns, and potential issues.
- Generate a structured markdown report with sections:
  1. **Project Overview** — language, framework, structure
  2. **Architecture** — patterns, layers, data flow
  3. **Code Quality** — style consistency, complexity, duplication
  4. **Dependencies** — outdated, unused, security vulnerabilities
  5. **Recommendations** — prioritized list of improvements

## Constraints
- You are in READ-ONLY mode. Do not attempt to modify any files.
- Read as many files as needed to build a thorough understanding.
- Cite specific files and line numbers in your findings.`,
  allowedTools: [...READ_ONLY_TOOLS],
  deniedTools: ["file_write", "file_edit", "shell_exec", "git_commit", "git_push"],
  maxIterations: 50,
  canWrite: false,
  canExecute: false,
  outputFormat: "report",
  autoApprove: "reads",
  description: "Analyze codebase and generate a structured markdown report. Read-only.",
};

const REVIEW_MODE: AgentModeConfig = {
  mode: "review",
  systemPromptSuffix: `You are a senior code reviewer. Review the changes for bugs, style issues, security vulnerabilities, and best-practice violations.

## Review Process
1. Run \`git diff\` and \`git log\` to understand what changed.
2. Read the changed files in full context.
3. Check related files for potential breakage.
4. Generate a review checklist with severity levels.

## Output Format
For each issue found, output:
- **[CRITICAL]** — Bugs, security holes, data loss risks
- **[HIGH]** — Logic errors, missing error handling, race conditions
- **[MEDIUM]** — Style violations, code smells, missing tests
- **[LOW]** — Nitpicks, naming, documentation

## Constraints
- You are in READ-ONLY mode. Do not modify files.
- Focus on the diff, not the entire codebase.
- Be specific: cite file paths, line numbers, and concrete suggestions.`,
  allowedTools: [...READ_ONLY_TOOLS, ...GIT_READ_TOOLS],
  deniedTools: ["file_write", "file_edit", "shell_exec", "git_commit", "git_push"],
  maxIterations: 30,
  canWrite: false,
  canExecute: false,
  outputFormat: "checklist",
  autoApprove: "reads",
  description: "Code review mode. Analyzes git diff for bugs, style, and security issues. Read-only.",
};

const SECURITY_MODE: AgentModeConfig = {
  mode: "security",
  systemPromptSuffix: `You are a security auditor. Perform a comprehensive security audit of the codebase.

## Audit Checklist (OWASP Top 10 + More)
1. **Injection** — SQL injection, command injection, XSS, template injection
2. **Authentication** — hardcoded credentials, weak auth patterns
3. **Sensitive Data** — secrets in code, unencrypted storage, PII exposure
4. **Access Control** — missing authorization checks, IDOR
5. **Security Misconfiguration** — debug mode, default credentials, CORS
6. **Vulnerable Dependencies** — known CVEs in dependencies
7. **Path Traversal** — directory traversal, symlink attacks
8. **Deserialization** — unsafe JSON.parse, eval, Function constructor
9. **Logging** — sensitive data in logs, missing audit trails
10. **Supply Chain** — typosquatting, suspicious packages

## Process
1. Scan all source files for dangerous patterns (regex-based).
2. Check dependency manifests for known vulnerabilities.
3. Analyze configuration files for misconfigurations.
4. Review authentication and authorization flows.

## Output Format
For each finding:
- **Severity**: CRITICAL / HIGH / MEDIUM / LOW / INFO
- **Category**: OWASP category or custom
- **File**: path and line number
- **Description**: what the issue is
- **Recommendation**: how to fix it

## Constraints
- You may run limited shell commands: \`npm audit\`, \`pip audit\`, grep-based scans.
- You may NOT modify any files.
- You may NOT install packages or run arbitrary code.`,
  allowedTools: [...READ_ONLY_TOOLS, "shell_exec"],
  deniedTools: ["file_write", "file_edit", "git_commit", "git_push"],
  maxIterations: 40,
  canWrite: false,
  canExecute: true,
  outputFormat: "report",
  autoApprove: "reads",
  description: "Security audit mode. OWASP Top 10, dependency scan, secret detection. Limited execution.",
};

const DEBUG_MODE: AgentModeConfig = {
  mode: "debug",
  systemPromptSuffix: `You are a debugging expert. Systematically identify the root cause of bugs and fix them.

## Debugging Methodology
1. **Reproduce** — Understand the bug report. Run the code to confirm the issue.
2. **Isolate** — Narrow down the problem area using logs, breakpoints, or bisection.
3. **Diagnose** — Read the relevant code. Trace data flow. Identify the root cause.
4. **Fix** — Make the minimal change to fix the bug. Do not refactor unrelated code.
5. **Verify** — Run tests or reproduce the scenario to confirm the fix works.

## Guidelines
- Always explain your reasoning before making changes.
- If a fix requires modifying multiple files, explain the full change plan first.
- Check for similar bugs in related code paths.
- Add regression tests when possible.
- Prefer targeted fixes over broad rewrites.`,
  allowedTools: ALL_TOOLS_MARKER,
  maxIterations: 30,
  canWrite: true,
  canExecute: true,
  outputFormat: "streaming",
  autoApprove: "reads",
  description: "Debug mode. Systematic bug finding with reproduce-isolate-diagnose-fix-verify methodology.",
};

const REFACTOR_MODE: AgentModeConfig = {
  mode: "refactor",
  systemPromptSuffix: `You are a refactoring expert. Improve code quality without changing external behavior.

## Refactoring Process
1. **Baseline** — Run existing tests to confirm they pass before changes.
2. **Identify** — Find code smells: duplication, long functions, god classes, tight coupling.
3. **Plan** — Describe each refactoring step before executing it.
4. **Execute** — Apply one refactoring at a time. Commit after each step.
5. **Verify** — Run tests after each step to ensure no regressions.

## Refactoring Patterns
- Extract function/method for long blocks
- Rename for clarity
- Remove dead code
- Consolidate duplicates (DRY)
- Simplify conditionals
- Introduce interfaces for loose coupling
- Split large files

## Rules
- NEVER change external behavior (inputs, outputs, API contracts).
- ALWAYS run tests before AND after each refactoring step.
- Commit after each logical refactoring step with a descriptive message.
- If tests fail after a change, revert and try a different approach.`,
  allowedTools: ALL_TOOLS_MARKER,
  maxIterations: 40,
  canWrite: true,
  canExecute: true,
  outputFormat: "diff",
  autoApprove: "safe_writes",
  description: "Refactoring mode. Improves code quality with test-guarded, incremental changes.",
};

const TEST_MODE: AgentModeConfig = {
  mode: "test",
  systemPromptSuffix: `You are a test engineer. Generate comprehensive tests for the codebase.

## Test Strategy
1. **Analyze** — Read source files to understand functions, classes, and modules.
2. **Plan** — Identify untested code paths, edge cases, and boundary conditions.
3. **Write** — Generate tests covering:
   - Happy path (normal usage)
   - Edge cases (empty, null, boundary values)
   - Error cases (invalid input, network failures)
   - Integration (module interactions)
4. **Run** — Execute the test suite to verify tests pass.

## Test Quality Guidelines
- Tests should be independent and idempotent.
- Use descriptive test names that explain the scenario.
- Follow the Arrange-Act-Assert pattern.
- Mock external dependencies (API calls, filesystem, database).
- Aim for meaningful coverage, not just line coverage.

## Constraints
- You may ONLY create or modify test files (files matching *test*, *spec*, __tests__).
- You may NOT modify source files.
- You may run the test runner via shell_exec.`,
  allowedTools: [...READ_ONLY_TOOLS, "file_write", "file_edit", "shell_exec"],
  maxIterations: 30,
  canWrite: true,
  canExecute: true,
  outputFormat: "streaming",
  autoApprove: "safe_writes",
  description: "Test generation mode. Creates comprehensive tests without modifying source files.",
};

const PLAN_MODE: AgentModeConfig = {
  mode: "plan",
  systemPromptSuffix: `You are a software architect creating a detailed implementation plan.

## Planning Process
1. **Understand** — Read the codebase to understand current architecture and conventions.
2. **Analyze** — Break down the task into concrete subtasks with dependencies.
3. **Estimate** — Provide rough time/complexity estimates for each subtask.
4. **Risk** — Identify risks, unknowns, and potential blockers.

## Output Format
Generate a structured plan:
\`\`\`
## Implementation Plan: [Task Title]

### Overview
[1-2 sentence summary]

### Tasks
1. **[Task Name]** (est: Xh, complexity: low/medium/high)
   - Files: [list of files to modify]
   - Description: [what to do]
   - Dependencies: [which tasks must complete first]

### Risks & Unknowns
- [Risk 1]: [mitigation]
- [Risk 2]: [mitigation]

### Testing Strategy
[How to verify the implementation]
\`\`\`

## Constraints
- You are in READ-ONLY mode. Do not modify any files.
- Do not execute any commands.
- Focus on creating an actionable plan that another agent or developer can follow.`,
  allowedTools: [...READ_ONLY_TOOLS],
  deniedTools: ["file_write", "file_edit", "shell_exec", "git_commit", "git_push"],
  maxIterations: 20,
  canWrite: false,
  canExecute: false,
  outputFormat: "report",
  autoApprove: "reads",
  description: "Planning mode. Creates detailed implementation plans without modifying files. Read-only.",
};

const ARCHITECT_MODE: AgentModeConfig = {
  mode: "architect",
  systemPromptSuffix: `You are a system architect. Analyze the codebase architecture, identify patterns and anti-patterns, and recommend improvements.

## Analysis Areas
1. **Structure** — Module organization, layer separation, dependency direction
2. **Patterns** — Design patterns in use (MVC, repository, factory, observer, etc.)
3. **Anti-Patterns** — God classes, circular dependencies, leaky abstractions, shotgun surgery
4. **Scalability** — Bottlenecks, single points of failure, horizontal scaling readiness
5. **Maintainability** — Coupling, cohesion, complexity metrics, test coverage
6. **Data Flow** — How data moves through the system (API → service → DB)

## Output Format
\`\`\`
## Architecture Analysis: [Project Name]

### Current Architecture
[Diagram or description of the current architecture]

### Patterns Identified
- [Pattern]: [where and how it's used]

### Anti-Patterns Found
- **[Anti-Pattern]** (severity: HIGH/MEDIUM/LOW)
  - Location: [files]
  - Impact: [what problems it causes]
  - Recommendation: [how to fix]

### Recommendations (Priority Order)
1. [Most impactful recommendation]
2. [Second recommendation]
...

### Migration Path
[If significant changes recommended, outline a migration strategy]
\`\`\`

## Constraints
- You are in READ-ONLY mode. Do not modify any files.
- Read broadly across the codebase to understand the full picture.
- Cite specific files and code patterns in your analysis.`,
  allowedTools: [...READ_ONLY_TOOLS],
  deniedTools: ["file_write", "file_edit", "shell_exec", "git_commit", "git_push"],
  maxIterations: 30,
  canWrite: false,
  canExecute: false,
  outputFormat: "report",
  autoApprove: "reads",
  description: "Architecture analysis mode. Identifies patterns, anti-patterns, and recommends improvements. Read-only.",
};

// ─── Mode Registry ───

/** All mode configurations indexed by mode name */
const MODE_REGISTRY: Record<AgentMode, AgentModeConfig> = {
  code: CODE_MODE,
  report: REPORT_MODE,
  review: REVIEW_MODE,
  security: SECURITY_MODE,
  debug: DEBUG_MODE,
  refactor: REFACTOR_MODE,
  test: TEST_MODE,
  plan: PLAN_MODE,
  architect: ARCHITECT_MODE,
};

// ─── Public API ───

/**
 * 모드 이름으로 설정을 가져온다.
 * @param mode 에이전트 모드 이름
 * @returns 해당 모드의 전체 설정
 */
export function getAgentModeConfig(mode: AgentMode): AgentModeConfig {
  return MODE_REGISTRY[mode];
}

/**
 * 등록된 모든 모드 목록을 반환한다.
 * @returns 모든 모드 설정 배열
 */
export function getAllAgentModes(): AgentModeConfig[] {
  return Object.values(MODE_REGISTRY);
}

/**
 * 모드 이름이 유효한지 검증한다.
 * @param mode 검증할 모드 이름
 * @returns 유효한 AgentMode이면 true
 */
export function isValidAgentMode(mode: string): mode is AgentMode {
  return mode in MODE_REGISTRY;
}

/**
 * 주어진 모드에서 특정 도구의 사용이 허용되는지 확인한다.
 * allowedTools가 빈 배열이면 모든 도구 허용 (deniedTools 제외).
 *
 * @param mode 에이전트 모드 이름
 * @param toolName 확인할 도구 이름
 * @returns 허용되면 true, 거부되면 false
 */
export function isToolAllowedInMode(mode: AgentMode, toolName: string): boolean {
  const config = MODE_REGISTRY[mode];

  // 명시적 거부 목록에 있으면 항상 거부
  if (config.deniedTools?.includes(toolName)) {
    return false;
  }
  // TEST MODE write 제한
  if (mode === "test" && (toolName === "file_write" || toolName === "file_edit")) {
    // 파일 경로 검증은 상위 executor에서 수행해야 함
    return true; // tool 자체는 허용하지만 path guard 필요
  }
  // allowedTools가 빈 배열이면 전체 허용 (deniedTools 제외)
  if (config.allowedTools.length === 0) {
    return true;
  }

  // 명시적 허용 목록에 있어야 허용
  return config.allowedTools.includes(toolName);
}

/**
 * 테스트 모드에서 파일 경로가 테스트 파일인지 검증한다.
 * test 모드는 테스트 파일만 쓰기 가능.
 *
 * @param filePath 검증할 파일 경로
 * @returns 테스트 파일이면 true
 */
export function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.includes("test") ||
    lower.includes("spec") ||
    lower.includes("__tests__") ||
    lower.endsWith(".test.ts") ||
    lower.endsWith(".test.js") ||
    lower.endsWith(".test.tsx") ||
    lower.endsWith(".test.jsx") ||
    lower.endsWith(".spec.ts") ||
    lower.endsWith(".spec.js") ||
    lower.endsWith(".spec.tsx") ||
    lower.endsWith(".spec.jsx")
  );
}

/**
 * 모드별 시스템 프롬프트 서픽스를 기존 시스템 프롬프트에 결합한다.
 * mode가 "code"이면 서픽스가 비어있으므로 원본을 그대로 반환.
 *
 * @param basePrompt 기본 시스템 프롬프트
 * @param mode 에이전트 모드 이름
 * @returns 결합된 시스템 프롬프트
 */
export function buildModeSystemPrompt(basePrompt: string, mode: AgentMode): string {
  const config = MODE_REGISTRY[mode];
  if (!config.systemPromptSuffix) {
    return basePrompt;
  }
  return `${basePrompt}\n\n---\n\n## Mode: ${mode.toUpperCase()}\n\n${config.systemPromptSuffix}`;
}
