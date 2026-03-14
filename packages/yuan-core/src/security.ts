/**
 * @module security
 * @description YUAN Agent 보안 규칙 SSOT (Single Source of Truth).
 *
 * QA에서 지적된 이슈 해결: Governor(constants.ts)와 tools/validators.ts에
 * 보안 규칙이 이중 정의되어 있던 문제를 이 모듈로 통일.
 *
 * Governor와 @yuaone/tools 모두 여기서 import.
 */

// ─── Types ─────────────────────────────────────────────────────────

/** 보안 검증 결과 */
export interface SecurityValidation {
  /** 검증 통과 여부 */
  allowed: boolean;
  /** 차단 사유 (allowed=false 일 때) */
  reason?: string;
  /** 위험도 */
  risk: "none" | "low" | "medium" | "high" | "critical";
}

// ─── Blocked Executables ───────────────────────────────────────────

/**
 * 완전 차단 명령어 — 어떤 인자 조합이든 실행 불가.
 * Governor + shell_exec 공통.
 */
const BLOCKED_EXECUTABLES = new Set([
  // Privilege escalation
  "sudo",
  "su",
  "doas",
  // Interactive editors (TTY 필요 → 에이전트 환경에서 hang)
  "vim",
  "vi",
  "nano",
  "emacs",
  "less",
  "more",
  "man",
  // Network access (기본 차단, allowlist로 해제 가능)
  "ssh",
  "scp",
  "sftp",
  "ftp",
  "telnet",
  "curl",
  "wget",
  // Destructive system commands
  "dd",
  "mkfs",
  "fdisk",
  "parted",
  // Power management
  "shutdown",
  "reboot",
  "poweroff",
  "halt",
  // Mount operations
  "mount",
  "umount",
  // Shell binaries — must not be invoked directly (bypass tool validation)
  "bash",
  "sh",
  "zsh",
  "dash",
  "csh",
  "ksh",
  "fish",
  // Container runtime — can escape sandbox restrictions
  "docker",
  "podman",
  // Command wrappers — can invoke arbitrary commands, bypassing security checks
  "env",
  "xargs",
  "nohup",
  "strace",
  "ltrace",
  "gdb",
  "script",
  "expect",
  "unbuffer",
  "setsid",
]);

// ─── Dangerous Command Patterns ───────────────────────────────────

/**
 * 위험 명령어 + 인자 패턴 — 특정 인자 조합에서만 차단.
 */
const DANGEROUS_ARG_PATTERNS: ReadonlyArray<{
  executable: string;
  argsPattern: RegExp;
  reason: string;
}> = [
  {
    executable: "rm",
    argsPattern: /-[^\s]*r[^\s]*f|--no-preserve-root/,
    reason: "Destructive rm blocked",
  },
  {
    executable: "chmod",
    argsPattern: /777/,
    reason: "chmod 777 blocked",
  },
  {
    executable: "chown",
    argsPattern: /.*/,
    reason: "chown blocked",
  },
  {
    executable: "git",
    argsPattern: /\bpush\b/,
    reason: "git push requires approval",
  },
  {
    executable: "git",
    argsPattern: /\breset\s+--hard\b/,
    reason: "git reset --hard blocked",
  },
  {
    executable: "git",
    argsPattern: /\bclean\s+-f/,
    reason: "git clean -f blocked",
  },
  {
    executable: "npm",
    argsPattern: /\bpublish\b/,
    reason: "npm publish requires approval",
  },
  {
    executable: "pip",
    argsPattern: /\binstall\b.*--break-system-packages/,
    reason: "pip --break-system-packages blocked",
  },
];

/**
 * 위험 명령어 정규식 패턴 — Governor의 full-command 문자열 검증용.
 * (레거시 호환: constants.ts에서 사용하던 패턴)
 */
export const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-rf?|--recursive)\b/,
  /\bsudo\b/,
  /\bcurl\b/,
  /\bwget\b/,
  /\bssh\b/,
  /\bdocker\b/,
  /\bdd\b/,
  /\bmkfs\b/,
  /\bchmod\s+777\b/,
  /\bchown\b/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-f/,
  /\bnpm\s+publish\b/,
  /\bpip\s+install\b.*--break-system-packages/,
  /[|&;`$]\s*\(/, // shell metacharacter injection
  /\$\(/, // command substitution
  />\s*\/dev\//, // device writes
];

// ─── Sensitive File Patterns ──────────────────────────────────────

/**
 * 민감 파일 패턴 — 비밀키, 인증 정보, 인증서 등.
 * Governor(파일 접근 차단) + tools/validators(경고) 공통.
 */
export const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /\.env($|\.)/,
  /\.env\.local$/,
  /credentials\.json$/i,
  /secrets?\.(json|ya?ml|toml)$/i,
  /\.pem$/,
  /\.key$/,
  /\.cert$/,
  /\.p12$/,
  /\.pfx$/,
  /id_rsa/,
  /id_ed25519/,
  /\.ssh\/config$/,
  /\.aws\/credentials$/,
  /\.npmrc$/,
  /\.pypirc$/,
  /kubeconfig/i,
  /token\.json$/,
  /service[_-]?account.*\.json$/i,
  /\.kube\/config/,
];

// ─── Allowed Executables ──────────────────────────────────────────

/**
 * 허용된 shell 명령어 — Phase 1 서브셋.
 */
export const ALLOWED_EXECUTABLES: string[] = [
  // Build
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "pip",
  "cargo",
  "go",
  "make",
  // Test
  "jest",
  "vitest",
  "pytest",
  // Lint
  "eslint",
  "prettier",
  "tsc",
  "mypy",
  // Git (safe subset — push/reset 등은 DANGEROUS_ARG_PATTERNS에서 제어)
  "git",
  // System (read-only / search)
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "find",
  "grep",
  "rg",
  "awk",
  "sed",
  "which",
  "echo",
  // Node
  "node",
  "tsx",
  "ts-node",
];

// ─── Interactive Commands ─────────────────────────────────────────

/**
 * 대화형 명령어 — TTY가 필요하여 에이전트 환경에서 hang 유발.
 * BLOCKED_EXECUTABLES에 포함되지만 명시적 목록도 제공.
 */
export const INTERACTIVE_COMMANDS: ReadonlySet<string> = new Set([
  "vim",
  "vi",
  "nano",
  "emacs",
  "less",
  "more",
  "man",
  "top",
  "htop",
  "screen",
  "tmux",
  // Shell binaries (also in BLOCKED_EXECUTABLES — listed here for explicit coverage)
  "bash",
  "sh",
  "zsh",
  "dash",
  "csh",
  "ksh",
  "fish",
]);

// ─── Path Traversal Patterns ──────────────────────────────────────

/**
 * Path traversal 공격 패턴.
 */
export const PATH_TRAVERSAL_PATTERNS: RegExp[] = [
  /\.\.\//,
  /\.\.\\/,
  /\.\.$/,
  /\0/, // null byte injection
];

// ─── Shell Metacharacter Pattern ──────────────────────────────────

/**
 * Shell 메타문자 패턴 — execFile에 전달 전 검증.
 */
export const SHELL_META_PATTERN: RegExp = /[;|`$()&><]/;

// ─── Node.js imports for path validation ──────────────────────────

import { resolve, relative } from "node:path";

// ─── Unified Validation Functions ─────────────────────────────────

// ─── Verification / Check Command Allowlist ────────────────────────

/**
 * Safe verification commands that should never be blocked.
 * These are read-only check/lint/typecheck tools with no side effects.
 * Risk level: "low" (verify only, cannot modify system state).
 */
const SAFE_VERIFY_EXECUTABLES: ReadonlySet<string> = new Set([
  "tsc",          // TypeScript type checker
  "ts-node",      // TypeScript runner
  "eslint",       // JavaScript/TypeScript linter
  "prettier",     // Code formatter (check mode)
  "jest",         // Test runner
  "vitest",       // Test runner
  "mocha",        // Test runner
  "mypy",         // Python type checker
]);

/**
 * Safe verification args patterns — these subcommands/flags make a command read-only.
 * Keyed by executable base name.
 */
const SAFE_VERIFY_ARGS_PATTERNS: ReadonlyArray<{ executable: string; argsPattern: RegExp }> = [
  { executable: "npx", argsPattern: /^(tsc|eslint|prettier|jest|vitest|mocha)\b/ },
  { executable: "pnpm", argsPattern: /^(build|test|lint|run\s+(build|test|lint|typecheck|type-check))\b/ },
  { executable: "npm", argsPattern: /^run\s+(build|test|lint|typecheck|type-check)\b/ },
];

/**
 * 명령어 + 인자 조합의 보안 검증.
 * Governor와 shell_exec 도구 모두 이 함수를 사용.
 *
 * @param executable 실행할 명령어
 * @param args 명령어 인자 배열
 * @returns 검증 결과
 */
export function validateCommand(
  executable: string,
  args: string[],
): SecurityValidation {
  const base = executable.split("/").pop() ?? executable;
  const argsStr = args.join(" ");

  // 0. Safe verification commands — always allowed, never blocked
  //    These are read-only check/typecheck/lint/test tools.
  if (SAFE_VERIFY_EXECUTABLES.has(base)) {
    return { allowed: true, risk: "low" };
  }
  // Also check npx/pnpm/npm invocations of verify tools
  for (const safe of SAFE_VERIFY_ARGS_PATTERNS) {
    if (base === safe.executable && safe.argsPattern.test(argsStr)) {
      return { allowed: true, risk: "low" };
    }
  }

  // 1. 완전 차단 명령어 검사
  if (BLOCKED_EXECUTABLES.has(base)) {
    return {
      allowed: false,
      reason: `Blocked command: "${base}" is not allowed`,
      risk: "critical",
    };
  }

  // 2. 대화형 명령어 검사
  if (INTERACTIVE_COMMANDS.has(base)) {
    return {
      allowed: false,
      reason: `Interactive command: "${base}" requires TTY and cannot run in agent mode`,
      risk: "high",
    };
  }

  // 3. 위험 인자 패턴 검사
  for (const pattern of DANGEROUS_ARG_PATTERNS) {
    if (base === pattern.executable && pattern.argsPattern.test(argsStr)) {
      return {
        allowed: false,
        reason: pattern.reason,
        risk: "high",
      };
    }
  }

  // 4. Allowlist enforcement — reject executables not in ALLOWED_EXECUTABLES
  if (!ALLOWED_EXECUTABLES.includes(base)) {
    return {
      allowed: false,
      reason: `Executable "${base}" is not in the allowed list. Allowed: ${ALLOWED_EXECUTABLES.join(', ')}`,
      risk: "high",
    };
  }

  // 5. Shell 메타문자 검사
  if (SHELL_META_PATTERN.test(executable)) {
    return {
      allowed: false,
      reason: `Shell metacharacter in executable: ${executable}`,
      risk: "critical",
    };
  }
  for (const arg of args) {
    if (SHELL_META_PATTERN.test(arg)) {
      return {
        allowed: false,
        reason: `Shell metacharacter in arg: ${arg}`,
        risk: "high",
      };
    }
  }

  return { allowed: true, risk: "none" };
}

/**
 * 파일 경로의 보안 검증.
 * 경로 탈출과 민감 파일 접근을 검증.
 *
 * @param filePath 검증할 파일 경로
 * @param workDir 작업 디렉토리 (sandbox root)
 * @returns 검증 결과
 */
export function validateFilePath(
  filePath: string,
  workDir: string,
): SecurityValidation {
  // 1. Null byte 검사
  if (filePath.includes("\0")) {
    return {
      allowed: false,
      reason: "Path contains null byte",
      risk: "critical",
    };
  }

  // 2. Path traversal 검사 — read-only 경로는 sibling dirs 허용, 시스템 경로만 차단
  const resolved = resolve(workDir, filePath);
  const rel = relative(workDir, resolved);
  const isOutside = rel.startsWith("..") || resolve(rel) === rel;

  if (isOutside) {
    // Block known dangerous system paths absolutely
    const BLOCKED = ['/etc', '/proc', '/sys', '/dev', '/boot', '/root'];
    const isSystemPath = BLOCKED.some(d => resolved === d || resolved.startsWith(d + '/'));
    if (isSystemPath) {
      return {
        allowed: false,
        reason: `System path access blocked: "${filePath}" resolves to "${resolved}"`,
        risk: "critical",
      };
    }
    // For reads outside workDir: warn but allow (user may be scanning sibling projects)
    return { allowed: true, risk: "low" };
  }

  // 3. 민감 파일 검사
  if (isSensitiveFile(filePath)) {
    return {
      allowed: false,
      reason: `Sensitive file: "${filePath}" matches known sensitive pattern`,
      risk: "high",
    };
  }

  return { allowed: true, risk: "none" };
}

/**
 * 민감 파일 여부 검사.
 *
 * @param filePath 검사할 파일 경로
 * @returns true면 민감 파일
 */
export function isSensitiveFile(filePath: string): boolean {
  return SENSITIVE_FILE_PATTERNS.some((p) => p.test(filePath));
}

/**
 * 위험 명령어 여부 검사 (full command string 기반).
 * Governor의 레거시 패턴 매칭과 호환.
 *
 * @param command 전체 명령어 문자열
 * @returns true면 위험 명령어
 */
export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(command));
}

/**
 * 대화형 명령어 여부 검사.
 *
 * @param executable 실행할 명령어
 * @returns true면 대화형 명령어
 */
export function isInteractiveCommand(executable: string): boolean {
  const base = executable.split("/").pop() ?? executable;
  return INTERACTIVE_COMMANDS.has(base);
}

/**
 * Safe verification command check (full command string version).
 * Used by Governor when checking full command strings (legacy path).
 *
 * @param fullCmd Full command string (e.g. "npx tsc --noEmit", "pnpm build")
 * @returns true if the command is a safe read-only verification tool
 */
export function isSafeVerifyCommand(fullCmd: string): boolean {
  // Extract the leading executable from the command string
  const parts = fullCmd.trim().split(/\s+/);
  const firstPart = parts[0] ?? "";
  const base = firstPart.split("/").pop() ?? firstPart;

  // Direct safe verify executables
  if (SAFE_VERIFY_EXECUTABLES.has(base)) return true;

  // npx/pnpm/npm invocations of safe verify tools
  const rest = parts.slice(1).join(" ");
  for (const safe of SAFE_VERIFY_ARGS_PATTERNS) {
    if (base === safe.executable && safe.argsPattern.test(rest)) return true;
  }

  return false;
}

/**
 * 차단 명령어 여부 검사.
 *
 * @param executable 실행할 명령어
 * @returns true면 차단 명령어
 */
export function isBlockedExecutable(executable: string): boolean {
  const base = executable.split("/").pop() ?? executable;
  return BLOCKED_EXECUTABLES.has(base);
}
