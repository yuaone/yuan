/**
 * @module security-scanner
 * @description YUAN Security DAST (Dynamic Application Security Testing) module.
 *
 * Performs dynamic security analysis on code changes:
 * 1. Dependency Vulnerability Scanning — known CVE patterns in package.json
 * 2. Secret Detection — API keys, tokens, passwords, private keys
 * 3. Code Security Patterns — injection, XSS, SSRF, traversal, crypto
 * 4. Configuration Security — tsconfig, CSP, CORS, headers
 * 5. Report Generation — severity-based findings with pass/fail decision
 *
 * No external dependencies — Node builtins only.
 * All secrets in evidence are masked.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { randomUUID } from "node:crypto";

// ══════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════

/** Security finding severity level */
export type SecuritySeverity = "critical" | "high" | "medium" | "low" | "info";

/** Security finding category */
export type SecurityCategory =
  | "secret"
  | "injection"
  | "xss"
  | "dependency"
  | "config"
  | "crypto"
  | "traversal"
  | "ssrf";

/** A single security finding */
export interface SecurityFinding {
  /** Unique finding identifier */
  id: string;
  /** Severity level */
  severity: SecuritySeverity;
  /** Category of the finding */
  category: SecurityCategory;
  /** Rule name that triggered the finding */
  rule: string;
  /** File path (relative to project root) */
  file: string;
  /** Line number (1-based) */
  line: number;
  /** Column number (1-based, optional) */
  column?: number;
  /** Human-readable description */
  message: string;
  /** Evidence with secrets masked */
  evidence: string;
  /** Suggested remediation */
  suggestion: string;
  /** Confidence score (0-1) */
  confidence: number;
}

/** Configuration for a security scan */
export interface SecurityScanConfig {
  /** Project root path */
  projectPath: string;
  /** Enable secret scanning (default: true) */
  scanSecrets?: boolean;
  /** Enable dependency scanning (default: true) */
  scanDependencies?: boolean;
  /** Enable code pattern scanning (default: true) */
  scanCode?: boolean;
  /** Enable config scanning (default: true) */
  scanConfig?: boolean;
  /** Minimum severity to report (default: 'low') */
  severityThreshold?: SecuritySeverity;
  /** Additional custom patterns */
  customPatterns?: SecurityPattern[];
  /** Glob patterns for paths to ignore */
  ignorePaths?: string[];
  /** Rule names to ignore */
  ignoreRules?: string[];
}

/** A custom security pattern definition */
export interface SecurityPattern {
  /** Pattern name / rule identifier */
  name: string;
  /** Regex to match */
  regex: RegExp;
  /** Severity if matched */
  severity: SecuritySeverity;
  /** Category */
  category: SecurityCategory;
  /** Human-readable message */
  message: string;
  /** Suggested fix */
  suggestion: string;
}

/** Result of a complete security scan */
export interface SecurityScanResult {
  /** All findings */
  findings: SecurityFinding[];
  /** Count summary by severity */
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
    total: number;
  };
  /** Whether the scan passed (no findings above threshold) */
  passed: boolean;
  /** Scan duration in milliseconds */
  scanDuration: number;
  /** Number of files scanned */
  filesScanned: number;
}

// ══════════════════════════════════════════════════════════════════════
// Constants — Severity ordering
// ══════════════════════════════════════════════════════════════════════

const SEVERITY_ORDER: Record<SecuritySeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

// ══════════════════════════════════════════════════════════════════════
// Built-in Patterns
// ══════════════════════════════════════════════════════════════════════

/** Secret detection patterns */
const SECRET_PATTERNS: SecurityPattern[] = [
  {
    name: "aws-access-key",
    regex: /\bAKIA[0-9A-Z]{16}\b/,
    severity: "critical",
    category: "secret",
    message: "AWS Access Key ID detected",
    suggestion: "Remove the key and rotate it immediately. Use environment variables or AWS IAM roles.",
  },
  {
    name: "aws-secret-key",
    regex: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/,
    severity: "medium",
    category: "secret",
    message: "Possible AWS Secret Access Key detected (40-char base64 string)",
    suggestion: "Verify if this is a secret key. Use environment variables instead of hardcoding.",
  },
  {
    name: "github-token",
    regex: /\b(ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36}|ghs_[a-zA-Z0-9]{36}|ghr_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59})\b/,
    severity: "critical",
    category: "secret",
    message: "GitHub token detected",
    suggestion: "Remove the token and revoke it. Use GITHUB_TOKEN environment variable.",
  },
  {
    name: "generic-api-key",
    regex: /(?:api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*["']([a-zA-Z0-9_\-]{20,})["']/i,
    severity: "high",
    category: "secret",
    message: "Hardcoded API key detected",
    suggestion: "Move API keys to environment variables or a secrets manager.",
  },
  {
    name: "generic-password",
    regex: /(?:password|passwd|pwd|secret)\s*[:=]\s*["']([^"']{8,})["']/i,
    severity: "high",
    category: "secret",
    message: "Hardcoded password or secret detected",
    suggestion: "Never hardcode passwords. Use environment variables or a secrets manager.",
  },
  {
    name: "private-key",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
    severity: "critical",
    category: "secret",
    message: "Private key detected in source code",
    suggestion: "Remove the private key immediately. Store keys in a secure vault.",
  },
  {
    name: "jwt-token",
    regex: /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/,
    severity: "high",
    category: "secret",
    message: "JWT token detected in source code",
    suggestion: "Remove hardcoded JWT tokens. Generate them at runtime.",
  },
  {
    name: "slack-token",
    regex: /\bxox[bpors]-[a-zA-Z0-9-]{10,}\b/,
    severity: "critical",
    category: "secret",
    message: "Slack token detected",
    suggestion: "Remove the token and revoke it. Use environment variables.",
  },
  {
    name: "stripe-key",
    regex: /\b[sr]k_(live|test)_[a-zA-Z0-9]{20,}\b/,
    severity: "critical",
    category: "secret",
    message: "Stripe API key detected",
    suggestion: "Remove the key and rotate it. Use environment variables.",
  },
  {
    name: "google-api-key",
    regex: /\bAIza[a-zA-Z0-9_-]{35}\b/,
    severity: "high",
    category: "secret",
    message: "Google API key detected",
    suggestion: "Remove the key and restrict it. Use environment variables.",
  },
  {
    name: "env-file-reference",
    regex: /\.env(?:\.local|\.production|\.staging|\.development)?$/,
    severity: "medium",
    category: "secret",
    message: ".env file should not be committed to version control",
    suggestion: "Add .env files to .gitignore. Use .env.example for templates.",
  },
  {
    name: "base64-secret",
    regex: /(?:secret|token|key|password|credential)\s*[:=]\s*["'](?:[A-Za-z0-9+/]{32,}={0,2})["']/i,
    severity: "medium",
    category: "secret",
    message: "Possible base64-encoded secret detected",
    suggestion: "Verify if this is a secret. Use environment variables for sensitive data.",
  },
  {
    name: "connection-string",
    regex: /(?:mongodb|postgres|mysql|redis|amqp):\/\/[^"'\s]+:[^"'\s]+@/i,
    severity: "high",
    category: "secret",
    message: "Database connection string with credentials detected",
    suggestion: "Use environment variables for connection strings. Never hardcode credentials.",
  },
];

/** SQL injection patterns */
const INJECTION_PATTERNS: SecurityPattern[] = [
  {
    name: "sql-string-concat",
    regex: /(?:query|execute|exec|raw)\s*\(\s*(?:["'`].*?\b(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b.*?["'`]\s*\+|`[^`]*\$\{)/i,
    severity: "high",
    category: "injection",
    message: "Possible SQL injection via string concatenation or template literal",
    suggestion: "Use parameterized queries or an ORM. Never concatenate user input into SQL.",
  },
  {
    name: "sql-template-literal",
    regex: /\b(?:query|execute|exec|raw)\s*\(\s*`[^`]*\$\{[^}]+\}[^`]*(?:WHERE|AND|OR|SET|VALUES)\b/i,
    severity: "high",
    category: "injection",
    message: "SQL query with template literal interpolation",
    suggestion: "Use parameterized queries. Template literals in SQL are injection vectors.",
  },
  {
    name: "command-injection-exec",
    regex: /\b(?:exec|execSync|spawn|spawnSync)\s*\(\s*(?:.*?\+|`[^`]*\$\{)/,
    severity: "critical",
    category: "injection",
    message: "Possible command injection via exec/spawn with dynamic input",
    suggestion: "Use execFile with argument arrays. Never pass user input to exec().",
  },
  {
    name: "command-injection-shell",
    regex: /\bchild_process\b.*?\bexec\s*\(/,
    severity: "high",
    category: "injection",
    message: "Use of child_process.exec which runs in a shell",
    suggestion: "Prefer execFile() over exec() to avoid shell interpretation.",
  },
  {
    name: "eval-usage",
    regex: /\beval\s*\(\s*(?!["'`])/,
    severity: "critical",
    category: "injection",
    message: "Use of eval() with potentially dynamic input",
    suggestion: "Avoid eval(). Use JSON.parse() for data, or Function constructor with caution.",
  },
  {
    name: "new-function",
    regex: /new\s+Function\s*\(\s*(?:.*?\+|`[^`]*\$\{)/,
    severity: "high",
    category: "injection",
    message: "Dynamic Function constructor with interpolated input",
    suggestion: "Avoid new Function() with dynamic input. Use safer alternatives.",
  },
];

/** XSS patterns */
const XSS_PATTERNS: SecurityPattern[] = [
  {
    name: "innerhtml-assignment",
    regex: /\.innerHTML\s*=\s*(?!["'`]\s*$)/,
    severity: "high",
    category: "xss",
    message: "Direct innerHTML assignment — potential XSS vector",
    suggestion: "Use textContent for text or a sanitization library (DOMPurify) for HTML.",
  },
  {
    name: "dangerously-set-innerhtml",
    regex: /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*(?!.*sanitize|.*DOMPurify|.*purify)/i,
    severity: "high",
    category: "xss",
    message: "dangerouslySetInnerHTML without apparent sanitization",
    suggestion: "Always sanitize HTML with DOMPurify before using dangerouslySetInnerHTML.",
  },
  {
    name: "document-write",
    regex: /document\.write\s*\(/,
    severity: "medium",
    category: "xss",
    message: "document.write() usage — potential XSS and performance issues",
    suggestion: "Use DOM manipulation methods instead of document.write().",
  },
  {
    name: "outerhtml-assignment",
    regex: /\.outerHTML\s*=/,
    severity: "medium",
    category: "xss",
    message: "outerHTML assignment — potential XSS vector",
    suggestion: "Use DOM manipulation methods. Sanitize input if HTML is required.",
  },
  {
    name: "jquery-html",
    regex: /\$\s*\([^)]*\)\s*\.html\s*\(\s*(?!["'`]\s*\))/,
    severity: "medium",
    category: "xss",
    message: "jQuery .html() with potentially unsanitized input",
    suggestion: "Use .text() for text content or sanitize HTML input.",
  },
];

/** Path traversal patterns */
const TRAVERSAL_PATTERNS: SecurityPattern[] = [
  {
    name: "path-traversal-user-input",
    regex: /(?:readFile|readFileSync|createReadStream|writeFile|writeFileSync|unlink|unlinkSync|stat|statSync|access|accessSync)\s*\(\s*(?:.*?\+|`[^`]*\$\{|.*?req\.|.*?params\.|.*?query\.|.*?body\.)/,
    severity: "high",
    category: "traversal",
    message: "File operation with potentially user-controlled path",
    suggestion: "Validate and sanitize file paths. Use path.resolve() and verify the result stays within allowed directories.",
  },
  {
    name: "path-join-user-input",
    regex: /path\.(?:join|resolve)\s*\([^)]*(?:req\.|params\.|query\.|body\.)/,
    severity: "medium",
    category: "traversal",
    message: "path.join/resolve with user-controlled input",
    suggestion: "Validate that resolved paths stay within expected directories. Check for '..' sequences.",
  },
];

/** Insecure crypto patterns */
const CRYPTO_PATTERNS: SecurityPattern[] = [
  {
    name: "md5-usage",
    regex: /\bcreateHash\s*\(\s*["']md5["']\s*\)/,
    severity: "medium",
    category: "crypto",
    message: "MD5 hash detected — cryptographically weak",
    suggestion: "Use SHA-256 or SHA-3 for security purposes. MD5 is only suitable for checksums.",
  },
  {
    name: "sha1-usage",
    regex: /\bcreateHash\s*\(\s*["']sha1["']\s*\)/,
    severity: "medium",
    category: "crypto",
    message: "SHA-1 hash detected — deprecated for security",
    suggestion: "Use SHA-256 or SHA-3. SHA-1 is deprecated for security purposes.",
  },
  {
    name: "weak-random",
    regex: /Math\.random\s*\(\s*\)/,
    severity: "low",
    category: "crypto",
    message: "Math.random() is not cryptographically secure",
    suggestion: "Use crypto.randomBytes() or crypto.randomUUID() for security-sensitive random values.",
  },
  {
    name: "hardcoded-iv",
    regex: /createCipheriv\s*\([^,]+,\s*[^,]+,\s*(?:Buffer\.from\s*\(\s*["']|["'])/,
    severity: "high",
    category: "crypto",
    message: "Hardcoded initialization vector (IV) in cipher",
    suggestion: "Generate a random IV with crypto.randomBytes() for each encryption operation.",
  },
];

/** SSRF patterns */
const SSRF_PATTERNS: SecurityPattern[] = [
  {
    name: "ssrf-fetch",
    regex: /\bfetch\s*\(\s*(?:.*?req\.|.*?params\.|.*?query\.|.*?body\.|.*?\+|`[^`]*\$\{)/,
    severity: "high",
    category: "ssrf",
    message: "fetch() with potentially user-controlled URL — SSRF risk",
    suggestion: "Validate and whitelist URLs before fetching. Block internal/private IP ranges.",
  },
  {
    name: "ssrf-http-request",
    regex: /\b(?:http|https)\.(?:get|request)\s*\(\s*(?:.*?req\.|.*?params\.|.*?query\.|.*?body\.|.*?\+|`[^`]*\$\{)/,
    severity: "high",
    category: "ssrf",
    message: "HTTP request with potentially user-controlled URL — SSRF risk",
    suggestion: "Validate and whitelist URLs. Block requests to internal networks (127.0.0.1, 10.x, 172.16.x, 192.168.x).",
  },
  {
    name: "ssrf-axios",
    regex: /\baxios\s*\.?\s*(?:get|post|put|patch|delete|request)\s*\(\s*(?:.*?req\.|.*?params\.|.*?query\.|.*?body\.|.*?\+|`[^`]*\$\{)/,
    severity: "high",
    category: "ssrf",
    message: "Axios request with potentially user-controlled URL — SSRF risk",
    suggestion: "Validate and whitelist URLs before making requests.",
  },
];

/** Prototype pollution patterns */
const POLLUTION_PATTERNS: SecurityPattern[] = [
  {
    name: "prototype-pollution-merge",
    regex: /(?:Object\.assign|_\.merge|_\.defaultsDeep|_\.set|_\.setWith)\s*\(\s*(?:.*?req\.|.*?body\.|.*?params\.)/,
    severity: "high",
    category: "injection",
    message: "Object merge with user input — prototype pollution risk",
    suggestion: "Validate keys before merging. Block '__proto__', 'constructor', and 'prototype' keys.",
  },
  {
    name: "bracket-notation-user-input",
    regex: /\[[^\]]*(?:req\.|params\.|query\.|body\.)[^\]]*\]\s*=/,
    severity: "medium",
    category: "injection",
    message: "Bracket notation assignment with user input — prototype pollution risk",
    suggestion: "Validate property names. Block '__proto__', 'constructor', and 'prototype'.",
  },
];

/** Known vulnerable package patterns (subset of well-known CVEs) */
const VULNERABLE_PACKAGES: Array<{
  name: string;
  vulnerableVersions: string;
  severity: SecuritySeverity;
  cve?: string;
  message: string;
  suggestion: string;
}> = [
  {
    name: "lodash",
    vulnerableVersions: "<4.17.21",
    severity: "high",
    cve: "CVE-2021-23337",
    message: "lodash < 4.17.21 has prototype pollution vulnerabilities",
    suggestion: "Upgrade lodash to >= 4.17.21.",
  },
  {
    name: "minimist",
    vulnerableVersions: "<1.2.6",
    severity: "high",
    cve: "CVE-2021-44906",
    message: "minimist < 1.2.6 has prototype pollution vulnerability",
    suggestion: "Upgrade minimist to >= 1.2.6.",
  },
  {
    name: "node-forge",
    vulnerableVersions: "<1.3.0",
    severity: "high",
    cve: "CVE-2022-24771",
    message: "node-forge < 1.3.0 has signature verification bypass",
    suggestion: "Upgrade node-forge to >= 1.3.0.",
  },
  {
    name: "jsonwebtoken",
    vulnerableVersions: "<9.0.0",
    severity: "high",
    cve: "CVE-2022-23529",
    message: "jsonwebtoken < 9.0.0 has insecure key retrieval vulnerability",
    suggestion: "Upgrade jsonwebtoken to >= 9.0.0.",
  },
  {
    name: "express",
    vulnerableVersions: "<4.19.2",
    severity: "medium",
    cve: "CVE-2024-29041",
    message: "express < 4.19.2 has open redirect vulnerability",
    suggestion: "Upgrade express to >= 4.19.2.",
  },
  {
    name: "axios",
    vulnerableVersions: "<1.6.0",
    severity: "medium",
    cve: "CVE-2023-45857",
    message: "axios < 1.6.0 has CSRF vulnerability via cookie exposure",
    suggestion: "Upgrade axios to >= 1.6.0.",
  },
  {
    name: "semver",
    vulnerableVersions: "<7.5.2",
    severity: "medium",
    cve: "CVE-2022-25883",
    message: "semver < 7.5.2 has ReDoS vulnerability",
    suggestion: "Upgrade semver to >= 7.5.2.",
  },
  {
    name: "tar",
    vulnerableVersions: "<6.2.1",
    severity: "high",
    cve: "CVE-2024-28863",
    message: "tar < 6.2.1 has denial of service vulnerability",
    suggestion: "Upgrade tar to >= 6.2.1.",
  },
  {
    name: "xml2js",
    vulnerableVersions: "<0.5.0",
    severity: "medium",
    cve: "CVE-2023-0842",
    message: "xml2js < 0.5.0 has prototype pollution vulnerability",
    suggestion: "Upgrade xml2js to >= 0.5.0.",
  },
  {
    name: "tough-cookie",
    vulnerableVersions: "<4.1.3",
    severity: "medium",
    cve: "CVE-2023-26136",
    message: "tough-cookie < 4.1.3 has prototype pollution vulnerability",
    suggestion: "Upgrade tough-cookie to >= 4.1.3.",
  },
];

/** Deprecated/unmaintained packages */
const DEPRECATED_PACKAGES: Array<{
  name: string;
  severity: SecuritySeverity;
  message: string;
  suggestion: string;
}> = [
  {
    name: "request",
    severity: "low",
    message: "'request' package is deprecated and unmaintained",
    suggestion: "Migrate to 'node-fetch', 'axios', or native fetch().",
  },
  {
    name: "querystring",
    severity: "info",
    message: "'querystring' module is deprecated in Node.js",
    suggestion: "Use URLSearchParams or the 'qs' package.",
  },
  {
    name: "uuid",
    vulnerableVersions: "<9.0.0",
    severity: "info",
    message: "Consider using Node.js built-in crypto.randomUUID() instead of uuid package",
    suggestion: "Use crypto.randomUUID() (Node 19+) or keep uuid >= 9.0.0.",
  } as { name: string; severity: SecuritySeverity; message: string; suggestion: string },
];

// ══════════════════════════════════════════════════════════════════════
// File extensions to scan
// ══════════════════════════════════════════════════════════════════════

const SCANNABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".env",
  ".sh",
  ".bash",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".rb",
  ".php",
  ".vue",
  ".svelte",
]);

const DEFAULT_IGNORE_PATHS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  "__pycache__",
  ".cache",
  "vendor",
];

// ══════════════════════════════════════════════════════════════════════
// SecurityScanner
// ══════════════════════════════════════════════════════════════════════

/**
 * DAST Security Scanner — performs dynamic security analysis on code changes.
 *
 * Scans for secrets, injection vulnerabilities, XSS, SSRF, insecure crypto,
 * dependency vulnerabilities, and configuration issues.
 *
 * @example
 * ```typescript
 * const scanner = new SecurityScanner({
 *   projectPath: '/path/to/project',
 *   scanSecrets: true,
 *   scanCode: true,
 * });
 * const result = await scanner.scan();
 * console.log(result.summary);
 * ```
 */
export class SecurityScanner {
  private readonly config: Required<SecurityScanConfig>;

  constructor(config: SecurityScanConfig) {
    this.config = {
      projectPath: config.projectPath,
      scanSecrets: config.scanSecrets ?? true,
      scanDependencies: config.scanDependencies ?? true,
      scanCode: config.scanCode ?? true,
      scanConfig: config.scanConfig ?? true,
      severityThreshold: config.severityThreshold ?? "low",
      customPatterns: config.customPatterns ?? [],
      ignorePaths: config.ignorePaths ?? [],
      ignoreRules: config.ignoreRules ?? [],
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // Full scan
  // ────────────────────────────────────────────────────────────────────

  /**
   * Run a full security scan on the project.
   *
   * @param files Optional list of specific file paths to scan (relative to projectPath).
   *              If omitted, discovers files recursively.
   * @returns Scan result with findings, summary, and pass/fail decision.
   */
  async scan(files?: string[]): Promise<SecurityScanResult> {
    const start = Date.now();
    const findings: SecurityFinding[] = [];
    let filesScanned = 0;

    // Discover or use provided files
    const filePaths = files ?? (await this.discoverFiles(this.config.projectPath));

    // Collect file contents
    const fileContents = new Map<string, string>();
    for (const fp of filePaths) {
      if (this.isIgnored(fp)) continue;
      try {
        const absPath = fp.startsWith("/") ? fp : join(this.config.projectPath, fp);
        const content = await readFile(absPath, "utf-8");
        const relPath = fp.startsWith("/")
          ? relative(this.config.projectPath, fp)
          : fp;
        fileContents.set(relPath, content);
        filesScanned++;
      } catch {
        // Skip unreadable files
      }
    }

    // Run scans
    for (const [filePath, content] of fileContents) {
      if (this.config.scanSecrets) {
        findings.push(...this.scanFileForSecrets(content, filePath));
      }
      if (this.config.scanCode) {
        findings.push(...this.scanFileForInjection(content, filePath));
        findings.push(...this.scanFileForXSS(content, filePath));
        findings.push(...this.scanFileForTraversal(content, filePath));
        findings.push(...this.scanFileForCrypto(content, filePath));
        findings.push(...this.scanFileForSSRF(content, filePath));
        findings.push(...this.scanFileForPrototypePollution(content, filePath));
        findings.push(...this.scanFileWithCustomPatterns(content, filePath));
      }

      // Dependency scan for package.json files
      if (this.config.scanDependencies && filePath.endsWith("package.json")) {
        findings.push(...this.scanDependencies(content));
      }
    }

    // Config scan
    if (this.config.scanConfig) {
      findings.push(...this.scanConfig(fileContents));
    }

    // Filter by threshold and ignored rules
    const filtered = findings.filter((f) => {
      if (this.config.ignoreRules.includes(f.rule)) return false;
      return SEVERITY_ORDER[f.severity] >= SEVERITY_ORDER[this.config.severityThreshold];
    });

    // Build summary
    const summary = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
      total: filtered.length,
    };
    for (const f of filtered) {
      summary[f.severity]++;
    }

    // Pass/fail: no critical or high findings
    const passed = summary.critical === 0 && summary.high === 0;

    return {
      findings: filtered,
      summary,
      passed,
      scanDuration: Date.now() - start,
      filesScanned,
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // Individual scans — Secrets
  // ────────────────────────────────────────────────────────────────────

  /**
   * Scan file contents for hardcoded secrets, API keys, and tokens.
   *
   * @param content File content to scan
   * @param filePath Relative file path for reporting
   * @returns Array of findings
   */
  scanFileForSecrets(content: string, filePath: string): SecurityFinding[] {
    // Check if this is a .env file being scanned (the file itself is a finding)
    const findings: SecurityFinding[] = [];

    if (/\.env(?:\.|$)/.test(filePath)) {
      findings.push({
        id: randomUUID(),
        severity: "medium",
        category: "secret",
        rule: "env-file-committed",
        file: filePath,
        line: 1,
        message: ".env file detected — should not be committed to version control",
        evidence: filePath,
        suggestion: "Add .env files to .gitignore. Use .env.example for templates.",
        confidence: 1.0,
      });
    }

    return [
      ...findings,
      ...this.scanWithPatterns(content, filePath, SECRET_PATTERNS),
    ];
  }

  // ────────────────────────────────────────────────────────────────────
  // Individual scans — Injection
  // ────────────────────────────────────────────────────────────────────

  /**
   * Scan file contents for injection vulnerabilities (SQL, command, eval).
   *
   * @param content File content to scan
   * @param filePath Relative file path for reporting
   * @returns Array of findings
   */
  scanFileForInjection(content: string, filePath: string): SecurityFinding[] {
    return this.scanWithPatterns(content, filePath, INJECTION_PATTERNS);
  }

  // ────────────────────────────────────────────────────────────────────
  // Individual scans — XSS
  // ────────────────────────────────────────────────────────────────────

  /**
   * Scan file contents for XSS vulnerabilities.
   *
   * @param content File content to scan
   * @param filePath Relative file path for reporting
   * @returns Array of findings
   */
  scanFileForXSS(content: string, filePath: string): SecurityFinding[] {
    return this.scanWithPatterns(content, filePath, XSS_PATTERNS);
  }

  // ────────────────────────────────────────────────────────────────────
  // Individual scans — Dependencies
  // ────────────────────────────────────────────────────────────────────

  /**
   * Scan package.json content for known vulnerable and deprecated dependencies.
   *
   * @param packageJsonContent Raw package.json content string
   * @returns Array of findings
   */
  scanDependencies(packageJsonContent: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];

    let pkg: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    try {
      pkg = JSON.parse(packageJsonContent) as typeof pkg;
    } catch {
      return findings;
    }

    const allDeps: Record<string, string> = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };

    // Check vulnerable packages
    for (const vuln of VULNERABLE_PACKAGES) {
      if (allDeps[vuln.name]) {
        const version = allDeps[vuln.name].replace(/^[\^~>=<]*/g, "");
        if (this.isVersionVulnerable(version, vuln.vulnerableVersions)) {
          findings.push({
            id: randomUUID(),
            severity: vuln.severity,
            category: "dependency",
            rule: `vuln-${vuln.name}`,
            file: "package.json",
            line: this.findDepLine(packageJsonContent, vuln.name),
            message: `${vuln.message}${vuln.cve ? ` (${vuln.cve})` : ""}`,
            evidence: `${vuln.name}@${allDeps[vuln.name]}`,
            suggestion: vuln.suggestion,
            confidence: 0.9,
          });
        }
      }
    }

    // Check deprecated packages
    for (const dep of DEPRECATED_PACKAGES) {
      if (allDeps[dep.name]) {
        findings.push({
          id: randomUUID(),
          severity: dep.severity,
          category: "dependency",
          rule: `deprecated-${dep.name}`,
          file: "package.json",
          line: this.findDepLine(packageJsonContent, dep.name),
          message: dep.message,
          evidence: `${dep.name}@${allDeps[dep.name]}`,
          suggestion: dep.suggestion,
          confidence: 0.8,
        });
      }
    }

    return findings;
  }

  // ────────────────────────────────────────────────────────────────────
  // Individual scans — Config
  // ────────────────────────────────────────────────────────────────────

  /**
   * Scan configuration files for security issues.
   *
   * @param files Map of relative file paths to their contents
   * @returns Array of findings
   */
  scanConfig(files: Map<string, string>): SecurityFinding[] {
    const findings: SecurityFinding[] = [];

    for (const [filePath, content] of files) {
      // tsconfig strict mode check
      if (filePath.endsWith("tsconfig.json") || filePath.endsWith("tsconfig.base.json")) {
        findings.push(...this.scanTsConfig(content, filePath));
      }

      // Check for permissive CORS
      if (this.isCodeFile(filePath)) {
        findings.push(...this.scanForCorsIssues(content, filePath));
        findings.push(...this.scanForMissingSecurityHeaders(content, filePath));
        findings.push(...this.scanForUnsafeCSP(content, filePath));
      }
    }

    return findings;
  }

  // ────────────────────────────────────────────────────────────────────
  // Diff-based scan
  // ────────────────────────────────────────────────────────────────────

  /**
   * Scan git diff output for security issues in newly added lines.
   * Only scans lines that start with '+' (additions).
   *
   * @param diffContent Raw git diff output
   * @returns Array of findings for newly added code
   */
  scanDiff(diffContent: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const lines = diffContent.split("\n");

    let currentFile = "";
    let currentLine = 0;

    for (const line of lines) {
      // Track current file from diff headers
      const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
      if (fileMatch) {
        currentFile = fileMatch[1];
        continue;
      }

      // Track line numbers from hunk headers
      const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
      if (hunkMatch) {
        currentLine = parseInt(hunkMatch[1], 10);
        continue;
      }

      // Only scan added lines
      if (line.startsWith("+") && !line.startsWith("+++")) {
        const addedContent = line.slice(1);

        const allPatterns = [
          ...SECRET_PATTERNS,
          ...INJECTION_PATTERNS,
          ...XSS_PATTERNS,
          ...TRAVERSAL_PATTERNS,
          ...CRYPTO_PATTERNS,
          ...SSRF_PATTERNS,
          ...POLLUTION_PATTERNS,
          ...this.config.customPatterns,
        ];

        for (const pattern of allPatterns) {
          if (this.config.ignoreRules.includes(pattern.name)) continue;
          const match = pattern.regex.exec(addedContent);
          if (match) {
            findings.push({
              id: randomUUID(),
              severity: pattern.severity,
              category: pattern.category,
              rule: pattern.name,
              file: currentFile,
              line: currentLine,
              column: match.index + 1,
              message: pattern.message,
              evidence: this.maskSecret(match[0]),
              suggestion: pattern.suggestion,
              confidence: this.patternConfidence(pattern),
            });
          }
        }
        currentLine++;
      } else if (!line.startsWith("-")) {
        // Context line (no prefix) — increment line counter
        currentLine++;
      }
    }

    return findings;
  }

  // ────────────────────────────────────────────────────────────────────
  // Utility methods
  // ────────────────────────────────────────────────────────────────────

  /**
   * Mask a secret value for safe display.
   * Shows at most the first 4 and last 2 characters.
   *
   * @param value The secret value to mask
   * @returns Masked string (e.g., "AKIA****xy")
   */
  maskSecret(value: string): string {
    if (value.length <= 6) return "****";
    if (value.length <= 10) {
      return value.slice(0, 2) + "****" + value.slice(-2);
    }
    return value.slice(0, 4) + "****" + value.slice(-2);
  }

  /**
   * Check whether a file path should be ignored based on config.
   *
   * @param filePath File path to check (relative or absolute)
   * @returns true if the path should be ignored
   */
  isIgnored(filePath: string): boolean {
    const relPath = filePath.startsWith("/")
      ? relative(this.config.projectPath, filePath)
      : filePath;

    const allIgnore = [...DEFAULT_IGNORE_PATHS, ...this.config.ignorePaths];

    for (const pattern of allIgnore) {
      if (relPath.includes(pattern)) return true;
    }
    return false;
  }

  // ────────────────────────────────────────────────────────────────────
  // Private helpers
  // ────────────────────────────────────────────────────────────────────

  /**
   * Scan content with a set of patterns and return findings.
   */
  private scanWithPatterns(
    content: string,
    filePath: string,
    patterns: SecurityPattern[],
  ): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of patterns) {
        if (this.config.ignoreRules.includes(pattern.name)) continue;

        // Reset regex lastIndex for safety
        const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
        const match = regex.exec(line);
        if (match) {
          findings.push({
            id: randomUUID(),
            severity: pattern.severity,
            category: pattern.category,
            rule: pattern.name,
            file: filePath,
            line: i + 1,
            column: match.index + 1,
            message: pattern.message,
            evidence: this.maskSecret(match[0]),
            suggestion: pattern.suggestion,
            confidence: this.patternConfidence(pattern),
          });
        }
      }
    }

    return findings;
  }

  /** Scan for path traversal patterns */
  private scanFileForTraversal(content: string, filePath: string): SecurityFinding[] {
    return this.scanWithPatterns(content, filePath, TRAVERSAL_PATTERNS);
  }

  /** Scan for insecure crypto patterns */
  private scanFileForCrypto(content: string, filePath: string): SecurityFinding[] {
    return this.scanWithPatterns(content, filePath, CRYPTO_PATTERNS);
  }

  /** Scan for SSRF patterns */
  private scanFileForSSRF(content: string, filePath: string): SecurityFinding[] {
    return this.scanWithPatterns(content, filePath, SSRF_PATTERNS);
  }

  /** Scan for prototype pollution patterns */
  private scanFileForPrototypePollution(content: string, filePath: string): SecurityFinding[] {
    return this.scanWithPatterns(content, filePath, POLLUTION_PATTERNS);
  }

  /** Scan with custom patterns */
  private scanFileWithCustomPatterns(content: string, filePath: string): SecurityFinding[] {
    if (this.config.customPatterns.length === 0) return [];
    return this.scanWithPatterns(content, filePath, this.config.customPatterns);
  }

  /** Check tsconfig for strict mode */
  private scanTsConfig(content: string, filePath: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    try {
      const config = JSON.parse(content) as {
        compilerOptions?: {
          strict?: boolean;
          noImplicitAny?: boolean;
          strictNullChecks?: boolean;
        };
      };

      if (config.compilerOptions && config.compilerOptions.strict !== true) {
        // Check if it's not extending a base that has strict
        if (!content.includes('"extends"')) {
          findings.push({
            id: randomUUID(),
            severity: "medium",
            category: "config",
            rule: "tsconfig-no-strict",
            file: filePath,
            line: 1,
            message: "TypeScript strict mode is not enabled",
            evidence: '"strict": false or missing',
            suggestion: 'Enable "strict": true in compilerOptions for stronger type safety.',
            confidence: 0.8,
          });
        }
      }
    } catch {
      // Skip unparseable tsconfig
    }
    return findings;
  }

  /** Check for permissive CORS configuration */
  private scanForCorsIssues(content: string, filePath: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // origin: "*" or origin: '*'
      if (/origin\s*:\s*["']\*["']/.test(line)) {
        findings.push({
          id: randomUUID(),
          severity: "medium",
          category: "config",
          rule: "cors-wildcard-origin",
          file: filePath,
          line: i + 1,
          message: "Wildcard CORS origin detected — allows any domain",
          evidence: 'origin: "*"',
          suggestion:
            "Restrict CORS to specific allowed origins. Use a whitelist in production.",
          confidence: 0.9,
        });
      }

      // Access-Control-Allow-Origin: *
      if (/Access-Control-Allow-Origin["']\s*,\s*["']\*["']/.test(line) ||
          /["']Access-Control-Allow-Origin["'].*["']\*["']/.test(line)) {
        findings.push({
          id: randomUUID(),
          severity: "medium",
          category: "config",
          rule: "cors-header-wildcard",
          file: filePath,
          line: i + 1,
          message: "Wildcard Access-Control-Allow-Origin header",
          evidence: "Access-Control-Allow-Origin: *",
          suggestion: "Restrict to specific origins in production.",
          confidence: 0.9,
        });
      }
    }

    return findings;
  }

  /** Check for missing security headers */
  private scanForMissingSecurityHeaders(content: string, filePath: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];

    // Only check files that look like server configuration
    if (!/(express|helmet|next\.config|server\.(ts|js)|app\.(ts|js)|middleware\.(ts|js))/.test(filePath)) {
      return findings;
    }

    // Check if it's an Express/server file without helmet
    if (/\bexpress\s*\(/.test(content) && !/helmet/.test(content)) {
      findings.push({
        id: randomUUID(),
        severity: "medium",
        category: "config",
        rule: "missing-helmet",
        file: filePath,
        line: 1,
        message: "Express app without helmet — missing security headers",
        evidence: "express() without helmet()",
        suggestion: "Install and use 'helmet' middleware for secure HTTP headers.",
        confidence: 0.7,
      });
    }

    return findings;
  }

  /** Check for unsafe CSP directives */
  private scanForUnsafeCSP(content: string, filePath: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/['"]unsafe-inline['"]/.test(line) && /script-src/.test(line)) {
        findings.push({
          id: randomUUID(),
          severity: "medium",
          category: "config",
          rule: "csp-unsafe-inline",
          file: filePath,
          line: i + 1,
          message: "CSP allows 'unsafe-inline' for scripts — weakens XSS protection",
          evidence: "script-src 'unsafe-inline'",
          suggestion:
            "Use nonces or hashes instead of 'unsafe-inline' in script-src.",
          confidence: 0.8,
        });
      }

      if (/['"]unsafe-eval['"]/.test(line) && /script-src/.test(line)) {
        findings.push({
          id: randomUUID(),
          severity: "high",
          category: "config",
          rule: "csp-unsafe-eval",
          file: filePath,
          line: i + 1,
          message: "CSP allows 'unsafe-eval' for scripts — enables eval() attacks",
          evidence: "script-src 'unsafe-eval'",
          suggestion:
            "Remove 'unsafe-eval' from CSP. Refactor code to avoid eval().",
          confidence: 0.9,
        });
      }
    }

    return findings;
  }

  /** Recursively discover files to scan */
  private async discoverFiles(dir: string, basePath?: string): Promise<string[]> {
    const root = basePath ?? dir;
    const files: string[] = [];

    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const relPath = relative(root, fullPath);

        if (this.isIgnored(relPath)) continue;

        try {
          const st = await stat(fullPath);
          if (st.isDirectory()) {
            files.push(...(await this.discoverFiles(fullPath, root)));
          } else if (st.isFile()) {
            const ext = extname(entry).toLowerCase();
            if (SCANNABLE_EXTENSIONS.has(ext) || entry === "package.json" || entry.startsWith(".env")) {
              files.push(relPath);
            }
          }
        } catch {
          // Skip inaccessible entries
        }
      }
    } catch {
      // Skip unreadable directories
    }

    return files;
  }

  /** Simple semver-like check: is the given version within a vulnerable range */
  private isVersionVulnerable(version: string, vulnerableRange: string): boolean {
    // Parse "<X.Y.Z" pattern
    const ltMatch = /^<(\d+)\.(\d+)\.(\d+)$/.exec(vulnerableRange);
    if (!ltMatch) return false;

    const parts = version.split(".").map((p) => parseInt(p, 10));
    const vulnParts = [parseInt(ltMatch[1], 10), parseInt(ltMatch[2], 10), parseInt(ltMatch[3], 10)];

    // version < vulnVersion
    if (isNaN(parts[0]) || isNaN(parts[1]) || isNaN(parts[2])) return false;

    if (parts[0] < vulnParts[0]) return true;
    if (parts[0] > vulnParts[0]) return false;
    if (parts[1] < vulnParts[1]) return true;
    if (parts[1] > vulnParts[1]) return false;
    return parts[2] < vulnParts[2];
  }

  /** Find the line number of a dependency in package.json */
  private findDepLine(content: string, depName: string): number {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`"${depName}"`)) return i + 1;
    }
    return 1;
  }

  /** Check if a file is a code file worth scanning */
  private isCodeFile(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext);
  }

  /** Get confidence score based on pattern category */
  private patternConfidence(pattern: SecurityPattern): number {
    switch (pattern.category) {
      case "secret":
        // Specific token patterns get higher confidence
        if (pattern.name.includes("aws-access") || pattern.name.includes("github-token") ||
            pattern.name.includes("stripe") || pattern.name.includes("slack") ||
            pattern.name.includes("private-key")) {
          return 0.95;
        }
        return 0.7;
      case "injection":
        return pattern.name.includes("eval") ? 0.9 : 0.75;
      case "xss":
        return 0.8;
      case "dependency":
        return 0.9;
      case "config":
        return 0.8;
      case "crypto":
        return pattern.name === "weak-random" ? 0.5 : 0.85;
      case "traversal":
        return 0.7;
      case "ssrf":
        return 0.7;
      default:
        return 0.6;
    }
  }
}
