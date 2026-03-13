/**
 * @yuaone/tools — Common validation utilities
 *
 * Security-first validators for path traversal, shell injection,
 * sensitive file detection, binary detection, and output truncation.
 *
 * Security rules SSOT: @yuaone/core/security.ts
 * This module delegates to the SSOT and provides tool-specific wrappers.
 */

import { resolve, relative, extname, sep, dirname } from 'node:path';
import { open } from 'node:fs/promises';
import { realpathSync, lstatSync, existsSync } from 'node:fs';
import {
  validateCommand as coreValidateCommand,
  isSensitiveFile as securityIsSensitiveFile,
  SHELL_META_PATTERN,
} from '@yuaone/core';

// ─── Symlink-Aware Path Resolution ──────────────────────────────────

/**
 * Resolve a path and verify that it (and its symlink target) stays within the
 * allowed project directory. Defends against symlink-based path traversal.
 *
 * @returns `{ valid, resolved, reason? }` — `resolved` is the real path if valid.
 */
export function resolveAndValidatePath(
  filePath: string,
  projectRoot: string,
): { valid: boolean; resolved: string; reason?: string } {
  const resolved = resolve(projectRoot, filePath);
  const normalizedRoot = resolve(projectRoot);

  // Check the resolved string first
  if (!resolved.startsWith(normalizedRoot + sep) && resolved !== normalizedRoot) {
    return { valid: false, resolved, reason: 'path escapes project directory' };
  }

  // If file exists, resolve symlinks and check again
  if (existsSync(resolved)) {
    try {
      const real = realpathSync(resolved);
      if (!real.startsWith(normalizedRoot + sep) && real !== normalizedRoot) {
        return { valid: false, resolved: real, reason: 'symlink target escapes project directory' };
      }
      return { valid: true, resolved: real };
    } catch {
      return { valid: false, resolved, reason: 'cannot resolve symlink' };
    }
  }

  // File doesn't exist yet — check parent directories for symlinks
  let current = dirname(resolved);
  while (current !== normalizedRoot && current.startsWith(normalizedRoot)) {
    if (existsSync(current)) {
      try {
        const realParent = realpathSync(current);
        if (!realParent.startsWith(normalizedRoot + sep) && realParent !== normalizedRoot) {
          return { valid: false, resolved, reason: 'parent directory is a symlink escaping project' };
        }
      } catch {
        // Can't resolve — safer to reject
        return { valid: false, resolved, reason: 'cannot resolve parent symlink' };
      }
      break; // Found existing parent, it's safe
    }
    current = dirname(current);
  }

  return { valid: true, resolved };
}

// ─── Path Traversal Defence ─────────────────────────────────────────

/** System directories that are always blocked even for read-only access */
const BLOCKED_SYSTEM_DIRS = ['/etc', '/proc', '/sys', '/dev', '/boot', '/root'];

function isBlockedSystemPath(resolvedPath: string): boolean {
  return BLOCKED_SYSTEM_DIRS.some(
    d => resolvedPath === d || resolvedPath.startsWith(d + '/')
  );
}

/**
 * Resolve and validate a path.
 * - readOnly=false (default): path must stay within workDir (write-safe)
 * - readOnly=true: path may go outside workDir but must not access system dirs
 *   (/etc, /proc, /sys, /dev, /boot, /root). Allows sibling project dirs (../foo).
 */
export function validatePath(inputPath: string, workDir: string, readOnly = false): string {
  // Reject null bytes always
  if (inputPath.includes('\0')) {
    throw new Error('Path contains null byte');
  }

  const resolved = resolve(workDir, inputPath);

  if (readOnly) {
    // For reads: only block known dangerous system paths
    if (isBlockedSystemPath(resolved)) {
      throw new Error(
        `Access to system path blocked: "${inputPath}" resolves to "${resolved}"`
      );
    }
    return resolved;
  }

  // For writes/exec: must stay within workDir
  const rel = relative(workDir, resolved);
  if (rel.startsWith('..') || resolve(rel) === rel) {
    throw new Error(
      `Path traversal detected: "${inputPath}" resolves outside workDir "${workDir}"`
    );
  }

  // Symlink defence for write paths
  const symlinkCheck = resolveAndValidatePath(inputPath, workDir);
  if (!symlinkCheck.valid) {
    throw new Error(
      `Symlink traversal blocked: "${inputPath}" — ${symlinkCheck.reason}`
    );
  }

  return symlinkCheck.resolved;
}

// ─── Shell Metacharacter Defence ────────────────────────────────────

/**
 * Validate that neither executable nor args contain shell metacharacters.
 * Prevents shell injection when using execFile.
 * Delegates to SHELL_META_PATTERN from @yuaone/core/security (SSOT).
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

// ─── Blocked Commands (delegates to @yuaone/core/security SSOT) ───────

/**
 * Check whether an executable + args combination is blocked.
 * Throws with explanation if blocked.
 * Delegates to @yuaone/core/security.validateCommand (SSOT).
 */
export function validateCommand(executable: string, args: string[]): void {
  const result = coreValidateCommand(executable, args);
  if (!result.allowed) {
    throw new Error(result.reason ?? 'Command blocked by security policy');
  }
}

// ─── Sensitive File Detection (delegates to @yuaone/core/security SSOT) ───

/**
 * Check whether a file path matches known sensitive file patterns.
 * Delegates to @yuaone/core/security.isSensitiveFile (SSOT).
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

  // Sniff first 8KB for null bytes (avoid reading entire file)
  try {
    const fh = await open(filePath, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fh.read(buf, 0, 8192, 0);
      const sample = buf.subarray(0, bytesRead);
      for (let i = 0; i < sample.length; i++) {
        if (sample[i] === 0) return true;
      }
      return false;
    } finally {
      await fh.close();
    }
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
