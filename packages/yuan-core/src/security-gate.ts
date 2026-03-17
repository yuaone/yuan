/**
 * @module security-gate
 * @description Deterministic security gate for tool inputs.
 * Prevents shell injection, dangerous commands, and credential leaks.
 * NO LLM, pure pattern matching.
 *
 * Unlike security.ts (which provides general blocked-executable lists and
 * path validators), this module provides pre-execution checks for tool
 * call arguments — catching injection patterns, reverse shells, and
 * credential leaks that slip past simple executable blocking.
 */

export type SecurityVerdict = "ALLOW" | "WARN" | "BLOCK";

export interface SecurityCheckResult {
  verdict: SecurityVerdict;
  reason?: string;
  pattern?: string;
}

// ─── Dangerous shell patterns ──────────────────────────────────────────────

const SHELL_BLOCK_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Destructive commands
  { pattern: /\brm\s+(-rf|-fr|--force)\b/i, reason: "Destructive recursive delete" },
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f/i, reason: "Destructive recursive delete" },
  { pattern: /\bmkfs\b/i, reason: "Filesystem format" },
  { pattern: /\bdd\s+if=/i, reason: "Direct disk write" },
  // Network exfiltration
  { pattern: /\bcurl\b.*\|\s*\b(sh|bash|zsh)\b/i, reason: "Remote code execution via pipe" },
  { pattern: /\bwget\b.*\|\s*\b(sh|bash|zsh)\b/i, reason: "Remote code execution via pipe" },
  { pattern: /\bcurl\b.*-o\s*\//, reason: "Download to system path" },
  // Reverse shells
  { pattern: /\bnc\b.*-[elp]/i, reason: "Netcat listener (possible reverse shell)" },
  { pattern: /\/dev\/tcp\//i, reason: "Bash TCP redirect (reverse shell)" },
  { pattern: /\bsocat\b/i, reason: "Socket relay (possible reverse shell)" },
  // Privilege escalation
  { pattern: /\bsudo\b/i, reason: "Privilege escalation" },
  { pattern: /\bchmod\s+[0-7]*7[0-7]*\b/i, reason: "World-writable permission" },
  { pattern: /\bchown\b.*root/i, reason: "Ownership change to root" },
  // Git destructive
  { pattern: /\bgit\s+push\s+.*--force\b/i, reason: "Force push" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "Hard reset" },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/i, reason: "Force clean" },
  // Environment manipulation
  { pattern: /\bexport\s+.*(?:PATH|LD_LIBRARY|LD_PRELOAD)\s*=/i, reason: "Environment path manipulation" },
  // SQL injection in shell
  { pattern: /;\s*(DROP|DELETE|TRUNCATE|ALTER)\s/i, reason: "SQL injection pattern" },
];

// ─── Dangerous file paths ──────────────────────────────────────────────────

const FILE_BLOCK_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^\/etc\//i, reason: "System config modification" },
  { pattern: /^\/usr\//i, reason: "System binary modification" },
  { pattern: /^\/var\/log\//i, reason: "System log modification" },
  { pattern: /^\/root\//i, reason: "Root home modification" },
  { pattern: /^\/(bin|sbin)\//i, reason: "System binary modification" },
  { pattern: /\.ssh\//i, reason: "SSH key modification" },
  { pattern: /\.env$/i, reason: "Environment file (may contain secrets)" },
  { pattern: /\.npmrc$/i, reason: "NPM config (may contain tokens)" },
];

// ─── Credential patterns in content ────────────────────────────────────────

const CREDENTIAL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(?:api[_-]?key|apikey|secret[_-]?key|auth[_-]?token|access[_-]?token)\s*[:=]\s*['"]?[a-zA-Z0-9_\-]{20,}/i, reason: "API key/token detected" },
  { pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"]{8,}/i, reason: "Password detected" },
  { pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/i, reason: "Private key detected" },
  { pattern: /ghp_[a-zA-Z0-9]{36}/i, reason: "GitHub personal access token" },
  { pattern: /sk-[a-zA-Z0-9]{48,}/i, reason: "OpenAI/Anthropic API key" },
  { pattern: /AIza[a-zA-Z0-9_\-]{35}/i, reason: "Google API key" },
];

// ─── Check functions ───────────────────────────────────────────────────────

/**
 * Check a shell command string against dangerous patterns.
 * Returns BLOCK if a dangerous pattern is matched, ALLOW otherwise.
 */
export function checkShellSecurity(command: string): SecurityCheckResult {
  for (const { pattern, reason } of SHELL_BLOCK_PATTERNS) {
    if (pattern.test(command)) {
      return { verdict: "BLOCK", reason, pattern: pattern.source };
    }
  }
  return { verdict: "ALLOW" };
}

/**
 * Check a file path (and optional content) against dangerous patterns.
 * Returns WARN for dangerous paths or credential-containing content,
 * ALLOW otherwise. File operations are WARN (not BLOCK) to allow
 * the agent to proceed with caution when necessary.
 */
export function checkFileSecurity(filePath: string, content?: string): SecurityCheckResult {
  // Check path
  for (const { pattern, reason } of FILE_BLOCK_PATTERNS) {
    if (pattern.test(filePath)) {
      return { verdict: "WARN", reason, pattern: pattern.source };
    }
  }
  // Check content for credentials
  if (content) {
    for (const { pattern, reason } of CREDENTIAL_PATTERNS) {
      if (pattern.test(content)) {
        return { verdict: "WARN", reason, pattern: pattern.source };
      }
    }
  }
  return { verdict: "ALLOW" };
}

/**
 * Main entry: check any tool call for security violations.
 *
 * - shell_exec / bash → check command against shell block patterns
 * - file_write / file_edit → check path + content against file/credential patterns
 * - git_ops → synthesize git command and check against shell block patterns
 * - All other tools → ALLOW
 */
export function securityCheck(toolName: string, args: Record<string, unknown>): SecurityCheckResult {
  if (toolName === "shell_exec" || toolName === "bash") {
    const cmd = String(args.command ?? args.script ?? "");
    return checkShellSecurity(cmd);
  }
  if (toolName === "file_write" || toolName === "file_edit") {
    const path = String(args.path ?? args.file_path ?? "");
    const content = String(args.content ?? args.new_string ?? "");
    return checkFileSecurity(path, content);
  }
  if (toolName === "git_ops") {
    const op = String(args.operation ?? "");
    const opArgs = String(args.args ?? "");
    return checkShellSecurity(`git ${op} ${opArgs}`);
  }
  return { verdict: "ALLOW" };
}
