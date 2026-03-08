/**
 * @yuan/tools — Common validation utilities
 *
 * Security-first validators for path traversal, shell injection,
 * sensitive file detection, binary detection, and output truncation.
 *
 * Security rules SSOT: @yuan/core/security.ts
 * This module delegates to the SSOT and provides tool-specific wrappers.
 */

import { resolve, relative, extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  validateCommand as coreValidateCommand,
  isSensitiveFile as securityIsSensitiveFile,
  SHELL_META_PATTERN,
} from '@yuan/core';

// ─── Path Traversal Defence ─────────────────────────────────────────

/**
 * Resolve and validate a path to ensure it stays within workDir.
 * Returns the resolved absolute path.
 * Throws on path traversal attempts.
 */
export function validatePath(inputPath: string, workDir: string): string {
  // Reject null bytes
  if (inputPath.includes('\0')) {
    throw new Error('Path contains null byte');
  }

  const resolved = resolve(workDir, inputPath);
  const rel = relative(workDir, resolved);

  // rel must not start with '..' and must not be absolute (outside workDir)
  if (rel.startsWith('..') || resolve(rel) === rel) {
    throw new Error(
      `Path traversal detected: "${inputPath}" resolves outside workDir "${workDir}"`
    );
  }

  return resolved;
}

// ─── Shell Metacharacter Defence ────────────────────────────────────

/**
 * Validate that neither executable nor args contain shell metacharacters.
 * Prevents shell injection when using execFile.
 * Delegates to SHELL_META_PATTERN from @yuan/core/security (SSOT).
 */
export function validateNoShellMeta(executable: string, args: string[]): void {
  if (SHELL_META_PATTERN.test(executable)) {
    throw new Error(`Shell metacharacter in executable: ${executable}`);
  }
  for (const arg of args) {
    if (SHELL_META_PATTERN.test(arg)) {
      throw new Error(`Shell metacharacter in arg: ${arg}`);
    }
  }
}

// ─── Blocked Commands (delegates to @yuan/core/security SSOT) ───────

/**
 * Check whether an executable + args combination is blocked.
 * Throws with explanation if blocked.
 * Delegates to @yuan/core/security.validateCommand (SSOT).
 */
export function validateCommand(executable: string, args: string[]): void {
  const result = coreValidateCommand(executable, args);
  if (!result.allowed) {
    throw new Error(result.reason ?? 'Command blocked by security policy');
  }
}

// ─── Sensitive File Detection (delegates to @yuan/core/security SSOT) ───

/**
 * Check whether a file path matches known sensitive file patterns.
 * Delegates to @yuan/core/security.isSensitiveFile (SSOT).
 */
export function isSensitiveFile(filePath: string): boolean {
  return securityIsSensitiveFile(filePath);
}

// ─── Binary File Detection ──────────────────────────────────────────

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.yaml', '.yml', '.toml', '.xml', '.html', '.htm',
  '.css', '.scss', '.less', '.sass',
  '.md', '.mdx', '.txt', '.csv', '.tsv',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.scala',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.swift', '.m',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.sql', '.graphql', '.gql', '.prisma',
  '.vue', '.svelte', '.astro',
  '.env', '.gitignore', '.dockerignore', '.editorconfig',
  '.lock', '.cfg', '.ini', '.conf',
  'Makefile', 'Dockerfile', 'Jenkinsfile', 'Procfile',
]);

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp',
  '.svg', '.ico', '.tiff', '.tif',
]);

/**
 * Check whether a file is likely binary by extension and (optionally) content sniffing.
 */
export async function isBinaryFile(filePath: string): Promise<boolean> {
  const ext = extname(filePath).toLowerCase();

  if (TEXT_EXTENSIONS.has(ext)) return false;
  if (IMAGE_EXTENSIONS.has(ext)) return true;

  // Sniff first 8KB for null bytes
  try {
    const buf = await readFile(filePath);
    const sample = buf.subarray(0, 8192);
    for (let i = 0; i < sample.length; i++) {
      if (sample[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Check whether a file is an image.
 */
export function isImageFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

// ─── Output Truncation ─────────────────────────────────────────────

const DEFAULT_MAX_BYTES = 50_000; // 50KB

/**
 * Truncate output to maxBytes. Uses head/tail strategy.
 */
export function truncateOutput(output: string, maxBytes: number = DEFAULT_MAX_BYTES): string {
  if (output.length <= maxBytes) return output;

  const head = Math.floor(maxBytes * 0.4);
  const tail = Math.floor(maxBytes * 0.4);
  const truncated = output.length - head - tail;

  return (
    output.slice(0, head) +
    `\n\n... (${truncated} chars truncated) ...\n\n` +
    output.slice(-tail)
  );
}

// ─── Language Detection (by extension) ──────────────────────────────

const EXT_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx',
  '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
  '.xml': 'xml', '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.md': 'markdown', '.mdx': 'mdx', '.txt': 'plaintext',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.scala': 'scala',
  '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
  '.cs': 'csharp', '.swift': 'swift',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'zsh',
  '.sql': 'sql', '.graphql': 'graphql',
  '.vue': 'vue', '.svelte': 'svelte',
  '.dockerfile': 'dockerfile',
};

export function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const basename = filePath.split('/').pop() ?? '';

  if (basename === 'Dockerfile') return 'dockerfile';
  if (basename === 'Makefile') return 'makefile';

  return EXT_TO_LANGUAGE[ext] ?? 'plaintext';
}
