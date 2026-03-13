/**
 * @module constants
 * @description YUAN Agent 상수 정의.
 *
 * 보안 관련 패턴(DANGEROUS_PATTERNS, SENSITIVE_FILE_PATTERNS, ALLOWED_EXECUTABLES)은
 * security.ts가 SSOT이며, 여기서는 re-export만 한다.
 */

import type { PlanLimits, PlanTier, LLMProvider } from "./types.js";

// Security constants (DANGEROUS_PATTERNS, SENSITIVE_FILE_PATTERNS, ALLOWED_EXECUTABLES)
// are defined in security.ts (SSOT) and exported directly from index.ts.
// Do NOT re-export them here to avoid duplicate export paths.

/**
 * 플랜별 리소스 제한 (SSOT — 설계 문서 11.2 기준)
 */
export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  LOCAL: {
    dailyExecutions: Infinity,
    maxIterations: 200,
    maxParallelAgents: Infinity,
    tokensPerRequest: Infinity,
    sessionTtlMs: 24 * 60 * 60 * 1000, // 24시간
    concurrentSessions: Infinity,
  },
  FREE: {
    dailyExecutions: 3,
    maxIterations: 5,
    maxParallelAgents: 1,
    tokensPerRequest: 20_000,
    sessionTtlMs: 5 * 60 * 1000, // 5분
    concurrentSessions: 1,
  },
  PRO: {
    dailyExecutions: 15,
    maxIterations: 25,
    maxParallelAgents: 3,
    tokensPerRequest: 72_000,
    sessionTtlMs: 30 * 60 * 1000, // 30분
    concurrentSessions: 2,
  },
  BUSINESS: {
    dailyExecutions: 50,
    maxIterations: 50,
    maxParallelAgents: 7,
    tokensPerRequest: 140_000,
    sessionTtlMs: 2 * 60 * 60 * 1000, // 2시간
    concurrentSessions: 5,
  },
  ENTERPRISE: {
    dailyExecutions: 150,
    maxIterations: 100,
    maxParallelAgents: Infinity,
    tokensPerRequest: 240_000,
    sessionTtlMs: 8 * 60 * 60 * 1000, // 8시간
    concurrentSessions: 20,
  },
  MAX: {
    dailyExecutions: Infinity,
    maxIterations: 200,
    maxParallelAgents: Infinity,
    tokensPerRequest: Infinity,
    sessionTtlMs: 24 * 60 * 60 * 1000, // 24시간
    concurrentSessions: Infinity,
  },
};

/**
 * 프로바이더별 기본 모델
 */
export const MODEL_DEFAULTS: Record<LLMProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-20250514",
  yua: "yua-normal",
  google: "gemini-2.5-flash",
};

/**
 * 프로바이더별 API Base URL
 */
export const PROVIDER_BASE_URLS: Record<LLMProvider, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  yua: "https://yuaone.com/api/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai/",
};

/**
 * 도구 결과 크기 제한 (바이트)
 */
export const TOOL_RESULT_LIMITS: Record<string, number> = {
  file_read: 50_000,
  shell_exec: 100_000,
  grep: 10_000,
  glob: 5_000,
  test_run: 20_000,
};

/**
 * 히스토리 압축 설정
 */
export const HISTORY_COMPACTION = {
  /** 원본 유지하는 최근 iteration 수 */
  recentWindow: 5,
  /** 도구 결과만 요약으로 교체하는 범위 */
  summaryWindow: 10,
} as const;


/**
 * Workspace-local YUAN storage
 * 오픈소스 배포 기준으로 repo 내부 숨김 폴더를 SSOT로 사용한다.
 */
export const YUAN_DIRNAME = ".yuan";
export const YUAN_MEMORY_JSON = "memory.json";
export const YUAN_SESSIONS_DIRNAME = "sessions";
export const YUAN_LAST_SESSION_FILENAME = "last-session";
export const YUAN_GITIGNORE_ENTRY = ".yuan/";

/**
 * Human-readable summary file
 */

/**
 * YUAN.md 탐색 경로 (우선순위 순)
 */
export const YUAN_MD_SEARCH_PATHS: string[] = [
  "YUAN.md",
  ".yuan/config.md",
  ".yuan/YUAN.md",
  "docs/YUAN.md",
];

/**
 * 기본 AgentLoop 설정값
 */
export const DEFAULT_LOOP_CONFIG = {
  maxIterations: 25,
  maxTokensPerIteration: 8_000,
  totalTokenBudget: 200_000,
} as const;

/**
 * Timeout constants — configurable via AgentConfig.timeouts.
 *
 * Bug 4 fix: shell_exec default increased from 30s → 60s.
 * Agent session minimum is 300s for all plan tiers.
 */
export const TIMEOUT_DEFAULTS = {
  /** Default shell_exec timeout (ms). Configurable per-call via `timeout` arg. */
  shellExecMs: 60_000,
  /** Hard cap on shell_exec timeout. Prevents runaway processes. */
  shellExecMaxMs: 600_000,
  /** Minimum agent session TTL (ms) — enforced across all plan tiers. */
  agentSessionMinMs: 300_000,
  /** Default agent session TTL for LOCAL/MAX plans (ms). */
  agentSessionDefaultMs: 24 * 60 * 60 * 1000,
} as const;

/** Design Mode: allowed edit paths (Governor enforced) */
export const DESIGN_ALLOWED_PATHS = [
  "src/",
  "app/",
  "components/",
  "styles/",
  "pages/",
  "public/",
  "assets/",
];

/** Design Mode: blocked edit paths */
export const DESIGN_BLOCKED_PATHS = [
  "node_modules/",
  ".env",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  ".git/",
];

/** Design Mode: security scan patterns */
export const DESIGN_SECURITY_PATTERNS: Record<string, RegExp[]> = {
  xss: [
    /dangerouslySetInnerHTML/,
    /\bonclick\s*=/i,
    /\bonerror\s*=/i,
    /\bonload\s*=/i,
    /javascript:/i,
  ],
  csp: [
    /style\s*=\s*["']/,
    /<script[^>]*>/i,
  ],
  injection: [
    /\$\{[^}]*(?:user|input|query|param)/i,
  ],
};
