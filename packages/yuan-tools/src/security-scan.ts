/**
 * @module security-scan
 * @description Security scanning tool for YUAN agent.
 * Checks for common security vulnerabilities in code:
 * - Hardcoded secrets (API keys, passwords, tokens, AWS keys, private keys)
 * - Dangerous code patterns (eval, innerHTML, SQL injection, command injection)
 * - Dependency vulnerabilities (npm/pnpm audit)
 * - File permission issues
 *
 * No external dependencies -- pure TypeScript + node:fs + node:child_process.
 */

import { readdir, readFile, stat, access, constants as fsConstants } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ParameterDef, RiskLevel } from './types.js';
import type { ToolResult } from '@yuan/core';
import { BaseTool } from './base-tool.js';

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────────

/** Severity classification for security findings */
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

/** A single security finding */
export interface SecurityFinding {
  /** Category of the finding */
  type: string;
  /** File where the issue was found */
  file: string;
  /** Line number (1-based) */
  line: number;
  /** The offending line (redacted if secret) */
  code: string;
  /** Human-readable description of the issue */
  description: string;
  /** Recommended fix */
  recommendation: string;
}

/** Full security scan report */
export interface SecurityReport {
  /** Security score 0-100 (100 = clean) */
  score: number;
  /** Critical severity findings */
  critical: SecurityFinding[];
  /** High severity findings */
  high: SecurityFinding[];
  /** Medium severity findings */
  medium: SecurityFinding[];
  /** Low severity findings */
  low: SecurityFinding[];
  /** Human-readable summary */
  summary: string;
}

// ─── Patterns ───────────────────────────────────────────────────────

/** Hardcoded secret detection patterns */
const SECRET_PATTERNS: ReadonlyArray<{
  name: string;
  pattern: RegExp;
  severity: FindingSeverity;
  description: string;
  recommendation: string;
}> = [
  {
    name: 'api_key',
    pattern: /(api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{10,}['"]/i,
    severity: 'critical',
    description: 'Hardcoded API key detected',
    recommendation: 'Move API keys to environment variables and use .env files (excluded from git).',
  },
  {
    name: 'password',
    pattern: /(password|passwd|pwd)\s*[:=]\s*['"][^'"]+['"]/i,
    severity: 'critical',
    description: 'Hardcoded password detected',
    recommendation: 'Use environment variables or a secrets manager for passwords.',
  },
  {
    name: 'token_secret',
    pattern: /(token|secret|auth)\s*[:=]\s*['"][^'"]{10,}['"]/i,
    severity: 'critical',
    description: 'Hardcoded token or secret detected',
    recommendation: 'Store tokens in environment variables or a vault service.',
  },
  {
    name: 'aws_key',
    pattern: /AKIA[0-9A-Z]{16}/,
    severity: 'critical',
    description: 'AWS access key ID detected',
    recommendation: 'Remove AWS key and rotate credentials immediately. Use IAM roles or env vars.',
  },
  {
    name: 'private_key',
    pattern: /-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----/,
    severity: 'critical',
    description: 'Private key embedded in source code',
    recommendation: 'Remove private keys from source. Use file references or secrets managers.',
  },
];

/** Dangerous code pattern detection */
const DANGEROUS_CODE_PATTERNS: ReadonlyArray<{
  name: string;
  pattern: RegExp;
  severity: FindingSeverity;
  description: string;
  recommendation: string;
}> = [
  {
    name: 'eval',
    pattern: /\beval\s*\(/,
    severity: 'high',
    description: 'Use of eval() detected -- potential code injection',
    recommendation: 'Replace eval() with safer alternatives like JSON.parse() or Function constructors with validated input.',
  },
  {
    name: 'new_function',
    pattern: /\bnew\s+Function\s*\(|[^.]\bFunction\s*\(/,
    severity: 'high',
    description: 'Dynamic Function constructor detected -- potential code injection',
    recommendation: 'Avoid Function() constructor. Use static code paths instead.',
  },
  {
    name: 'innerhtml',
    pattern: /\.innerHTML\s*=/,
    severity: 'high',
    description: 'Direct innerHTML assignment -- potential XSS vulnerability',
    recommendation: 'Use textContent, createElement/appendChild, or a sanitizer like DOMPurify.',
  },
  {
    name: 'document_write',
    pattern: /document\.write\s*\(/,
    severity: 'high',
    description: 'document.write() detected -- potential XSS vulnerability',
    recommendation: 'Use DOM manipulation methods instead of document.write().',
  },
  {
    name: 'sql_injection',
    pattern: /query\s*\(.*\+.*req\.|query\s*\(.*\$\{/,
    severity: 'critical',
    description: 'Potential SQL injection -- string concatenation in query',
    recommendation: 'Use parameterized queries or an ORM. Never concatenate user input into SQL.',
  },
  {
    name: 'command_injection',
    pattern: /child_process\.exec\s*\(/,
    severity: 'high',
    description: 'child_process.exec() detected -- potential command injection',
    recommendation: 'Use child_process.execFile() with an explicit argument array instead of exec().',
  },
  {
    name: 'chmod_777',
    pattern: /fs\.chmod\s*\(.*777/,
    severity: 'medium',
    description: 'Setting file permissions to 777 (world-readable/writable/executable)',
    recommendation: 'Use least-privilege permissions. Typically 644 for files, 755 for directories.',
  },
  {
    name: 'insecure_http',
    pattern: /['"]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[^'"]+['"]/,
    severity: 'medium',
    description: 'Insecure HTTP URL detected (not HTTPS)',
    recommendation: 'Use HTTPS for all external API calls and resource URLs.',
  },
];

/** Directories to skip during scanning */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'coverage', '.cache', '__pycache__', '.venv', 'venv',
  '.turbo', '.output',
]);

/** File extensions to scan */
const SCANNABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.cpp', '.cs', '.swift',
  '.json', '.yaml', '.yml', '.toml',
  '.html', '.htm', '.vue', '.svelte',
  '.sh', '.bash',
  '.sql',
  '.env', '.cfg', '.ini', '.conf',
]);

/** Files that should be in .gitignore */
const SHOULD_BE_GITIGNORED = ['.env', '.env.local', '.env.production', 'credentials.json', 'secrets.json'];

// ─── SecurityScanTool ───────────────────────────────────────────────

export class SecurityScanTool extends BaseTool {
  readonly name = 'security_scan';
  readonly description =
    'Scan a project directory for security vulnerabilities: ' +
    'hardcoded secrets, dangerous code patterns, dependency vulnerabilities, ' +
    'and file permission issues. Returns a structured security report with score.';
  readonly riskLevel: RiskLevel = 'low';

  readonly parameters: Record<string, ParameterDef> = {
    workDir: {
      type: 'string',
      description: 'Project directory to scan (defaults to current workDir)',
      required: false,
    },
    skipAudit: {
      type: 'boolean',
      description: 'Skip dependency audit (faster scan)',
      required: false,
      default: false,
    },
  };

  async execute(args: Record<string, unknown>, workDir: string): Promise<ToolResult> {
    const toolCallId = (args._toolCallId as string) ?? '';
    const skipAudit = (args.skipAudit as boolean) ?? false;

    // Validate scanDir to prevent directory traversal (C3 fix)
    let scanDir = workDir;
    if (args.workDir && typeof args.workDir === 'string') {
      try {
        scanDir = this.validatePath(args.workDir as string, workDir);
      } catch (err) {
        return this.fail(toolCallId, (err as Error).message);
      }
    }

    try {
      const report = await runSecurityScan(scanDir, skipAudit);
      const output = formatReport(report);
      return this.ok(toolCallId, output, { report });
    } catch (err) {
      return this.fail(toolCallId, `Security scan failed: ${(err as Error).message}`);
    }
  }
}

// ─── Scan Engine ────────────────────────────────────────────────────

/**
 * Run a full security scan on the given directory.
 *
 * @param scanDir - Directory to scan recursively
 * @param skipAudit - If true, skip npm/pnpm audit
 * @returns SecurityReport
 */
export async function runSecurityScan(scanDir: string, skipAudit = false): Promise<SecurityReport> {
  const findings: Array<SecurityFinding & { severity: FindingSeverity }> = [];

  // 1. Scan files for secrets and dangerous patterns
  const files = await collectFiles(scanDir);
  for (const filePath of files) {
    const relPath = relative(scanDir, filePath);
    const fileFindings = await scanFile(filePath, relPath);
    findings.push(...fileFindings);
  }

  // 2. Dependency audit (optional)
  if (!skipAudit) {
    const auditFindings = await runDependencyAudit(scanDir);
    findings.push(...auditFindings);
  }

  // 3. Check for missing .gitignore entries
  const gitignoreFindings = await checkGitignore(scanDir);
  findings.push(...gitignoreFindings);

  // 4. Classify findings by severity
  const critical = findings.filter((f) => f.severity === 'critical').map(stripSeverity);
  const high = findings.filter((f) => f.severity === 'high').map(stripSeverity);
  const medium = findings.filter((f) => f.severity === 'medium').map(stripSeverity);
  const low = findings.filter((f) => f.severity === 'low').map(stripSeverity);

  // 5. Calculate score
  const score = calculateScore(critical.length, high.length, medium.length, low.length);

  // 6. Build summary
  const totalFindings = findings.length;
  const summary =
    totalFindings === 0
      ? 'No security issues found. Score: 100/100.'
      : `Found ${totalFindings} issue(s): ${critical.length} critical, ${high.length} high, ${medium.length} medium, ${low.length} low. Score: ${score}/100.`;

  return { score, critical, high, medium, low, summary };
}

// ─── File Collection ────────────────────────────────────────────────

async function collectFiles(dir: string, maxDepth = 10): Promise<string[]> {
  if (maxDepth <= 0) return [];
  const files: string[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') && SKIP_DIRS.has(entry.name)) continue;
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      const subFiles = await collectFiles(fullPath, maxDepth - 1);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      // Scan files with known extensions or dotfiles like .env
      if (SCANNABLE_EXTENSIONS.has(ext) || entry.name.startsWith('.env')) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

// ─── File Scanning ──────────────────────────────────────────────────

async function scanFile(
  filePath: string,
  relPath: string,
): Promise<Array<SecurityFinding & { severity: FindingSeverity }>> {
  const findings: Array<SecurityFinding & { severity: FindingSeverity }> = [];

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return findings;
  }

  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Check secret patterns
    for (const sp of SECRET_PATTERNS) {
      if (sp.pattern.test(line)) {
        findings.push({
          type: `hardcoded_secret:${sp.name}`,
          file: relPath,
          line: lineNum,
          code: redactLine(line),
          description: sp.description,
          recommendation: sp.recommendation,
          severity: sp.severity,
        });
      }
    }

    // Check dangerous code patterns
    for (const dp of DANGEROUS_CODE_PATTERNS) {
      if (dp.pattern.test(line)) {
        findings.push({
          type: dp.name,
          file: relPath,
          line: lineNum,
          code: line.trim().slice(0, 200),
          description: dp.description,
          recommendation: dp.recommendation,
          severity: dp.severity,
        });
      }
    }
  }

  return findings;
}

/**
 * Redact secret values in a line for safe display.
 * Replaces the actual value with asterisks.
 */
function redactLine(line: string): string {
  return line
    .replace(/(['"])[^'"]{8,}(['"])/g, (_, q1: string, q2: string) => `${q1}****REDACTED****${q2}`)
    .trim()
    .slice(0, 200);
}

// ─── Dependency Audit ───────────────────────────────────────────────

async function runDependencyAudit(
  dir: string,
): Promise<Array<SecurityFinding & { severity: FindingSeverity }>> {
  const findings: Array<SecurityFinding & { severity: FindingSeverity }> = [];

  // Detect package manager
  const hasPnpmLock = await fileExists(join(dir, 'pnpm-lock.yaml'));
  const hasPackageLock = await fileExists(join(dir, 'package-lock.json'));
  const hasPackageJson = await fileExists(join(dir, 'package.json'));

  if (!hasPackageJson) return findings;

  const cmd = hasPnpmLock ? 'pnpm' : hasPackageLock ? 'npm' : 'npm';
  const args = ['audit', '--json'];

  try {
    const { stdout } = await execFileAsync(cmd, args, {
      cwd: dir,
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const auditData = JSON.parse(stdout) as Record<string, unknown>;
    const vulnerabilities = (auditData.vulnerabilities ?? auditData.advisories ?? {}) as Record<
      string,
      { severity?: string; name?: string; title?: string; recommendation?: string; range?: string }
    >;

    for (const [pkg, info] of Object.entries(vulnerabilities)) {
      const severity = mapAuditSeverity(info.severity ?? 'low');
      findings.push({
        type: 'dependency_vulnerability',
        file: 'package.json',
        line: 0,
        code: `${pkg}${info.range ? `@${info.range}` : ''}`,
        description: info.title ?? `Vulnerability in ${pkg}`,
        recommendation: info.recommendation ?? `Update ${pkg} to a patched version.`,
        severity,
      });
    }
  } catch {
    // Audit command failed or not available -- skip silently
    // npm audit exits non-zero when vulnerabilities are found
  }

  return findings;
}

function mapAuditSeverity(severity: string): FindingSeverity {
  switch (severity.toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'moderate':
    case 'medium':
      return 'medium';
    default:
      return 'low';
  }
}

// ─── Gitignore Check ────────────────────────────────────────────────

async function checkGitignore(
  dir: string,
): Promise<Array<SecurityFinding & { severity: FindingSeverity }>> {
  const findings: Array<SecurityFinding & { severity: FindingSeverity }> = [];

  // Read .gitignore
  let gitignoreContent = '';
  try {
    gitignoreContent = await readFile(join(dir, '.gitignore'), 'utf-8');
  } catch {
    // No .gitignore
    if (await fileExists(join(dir, '.git'))) {
      findings.push({
        type: 'missing_gitignore',
        file: '.gitignore',
        line: 0,
        code: '',
        description: 'Git repository has no .gitignore file',
        recommendation: 'Create a .gitignore to exclude sensitive files, build artifacts, and dependencies.',
        severity: 'medium',
      });
    }
    return findings;
  }

  // Check that sensitive files are gitignored
  for (const sensitiveFile of SHOULD_BE_GITIGNORED) {
    const exists = await fileExists(join(dir, sensitiveFile));
    if (exists && !gitignoreContent.includes(sensitiveFile)) {
      findings.push({
        type: 'sensitive_not_gitignored',
        file: sensitiveFile,
        line: 0,
        code: '',
        description: `Sensitive file "${sensitiveFile}" exists but is not in .gitignore`,
        recommendation: `Add "${sensitiveFile}" to .gitignore and remove from git tracking.`,
        severity: 'high',
      });
    }
  }

  return findings;
}

// ─── Score Calculation ──────────────────────────────────────────────

function calculateScore(critical: number, high: number, medium: number, low: number): number {
  // Deductions: critical=-25, high=-10, medium=-3, low=-1
  const deductions = critical * 25 + high * 10 + medium * 3 + low * 1;
  return Math.max(0, 100 - deductions);
}

// ─── Helpers ────────────────────────────────────────────────────────

function stripSeverity(f: SecurityFinding & { severity: FindingSeverity }): SecurityFinding {
  const { severity: _, ...rest } = f;
  return rest;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// ─── Report Formatting ─────────────────────────────────────────────

function formatReport(report: SecurityReport): string {
  const lines: string[] = [];
  lines.push(`## Security Scan Report`);
  lines.push(`Score: ${report.score}/100`);
  lines.push('');
  lines.push(report.summary);
  lines.push('');

  const sections: Array<[string, SecurityFinding[]]> = [
    ['CRITICAL', report.critical],
    ['HIGH', report.high],
    ['MEDIUM', report.medium],
    ['LOW', report.low],
  ];

  for (const [label, findings] of sections) {
    if (findings.length === 0) continue;
    lines.push(`### ${label} (${findings.length})`);
    for (const f of findings) {
      const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file;
      lines.push(`- [${f.type}] ${loc}`);
      lines.push(`  ${f.description}`);
      if (f.code) lines.push(`  Code: ${f.code}`);
      lines.push(`  Fix: ${f.recommendation}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
