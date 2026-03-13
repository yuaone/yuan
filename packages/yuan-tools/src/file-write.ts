/**
 * @yuaone/tools — file_write tool
 *
 * Writes content to a file.
 * - Auto-creates directories (mkdir -p)
 * - Backs up existing files before overwrite (.yuan-backup)
 * - Detects and warns about sensitive files (.env, credentials, etc.)
 */

import { readFile, mkdir, stat, copyFile, open as fsOpen } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname } from 'node:path';
import type { ParameterDef, RiskLevel, ToolResult } from './types.js';
import { BaseTool } from './base-tool.js';
import { isSensitiveFile } from './validators.js';

export class FileWriteTool extends BaseTool {
  readonly name = 'file_write';
  readonly description =
    'Write content to a file. Creates directories automatically. ' +
    'Backs up existing files before overwrite.';
  readonly riskLevel: RiskLevel = 'high';

  readonly parameters: Record<string, ParameterDef> = {
    path: {
      type: 'string',
      description: 'Relative path from project root',
      required: true,
    },
    content: {
      type: 'string',
      description: 'File content to write',
      required: true,
    },
    createDirectories: {
      type: 'boolean',
      description: 'Auto-create intermediate directories (default: true)',
      required: false,
      default: true,
    },
  };

  async execute(args: Record<string, unknown>, workDir: string): Promise<ToolResult> {
    const toolCallId = (args._toolCallId as string) ?? '';
    const path = args.path as string | undefined;
    const content = args.content as string | undefined;
    const createDirectories = (args.createDirectories as boolean) ?? true;

    if (!path) {
      return this.fail(toolCallId, 'Missing required parameter: path');
    }
    if (content === undefined || content === null) {
      return this.fail(toolCallId, 'Missing required parameter: content');
    }

    let resolvedPath: string;
    try {
      resolvedPath = this.validatePath(path, workDir);
    } catch (err) {
      return this.fail(toolCallId, (err as Error).message);
    }

    // Sensitive file warning
    if (isSensitiveFile(path)) {
      return this.fail(
        toolCallId,
        `Sensitive file detected: "${path}". ` +
          'Writing to credential/secret files is blocked for security.'
      );
    }

    // Write size limit (10MB)
    const contentStr = String(content);
    const MAX_WRITE_SIZE = 10 * 1024 * 1024;
    if (Buffer.byteLength(contentStr, 'utf-8') > MAX_WRITE_SIZE) {
      return this.fail(toolCallId, `Content exceeds maximum write size (10MB)`);
    }

    // Check if file already exists
    let existed = false;
    try {
      const s = await stat(resolvedPath);
      if (s.isDirectory()) {
        return this.fail(toolCallId, `Path is a directory: ${path}`);
      }
      existed = true;
    } catch {
      // File doesn't exist — will be created
    }

    // Create directories if needed
    if (createDirectories) {
      try {
        await mkdir(dirname(resolvedPath), { recursive: true });
      } catch (err) {
        return this.fail(toolCallId, `Failed to create directories: ${(err as Error).message}`);
      }
    }

    // Backup existing file
    if (existed) {
      try {
        const backupPath = resolvedPath + '.yuan-backup';
        await copyFile(resolvedPath, backupPath);
      } catch {
        // Best-effort backup — don't block write on backup failure
      }
    }

    // Read old content for diff (before writing)
    let oldContent = '';
    if (existed) {
      try {
        oldContent = await readFile(resolvedPath, 'utf-8');
      } catch {
        // Could not read old content — diff will show all lines as additions
      }
    }

    try {
      const flags = existed
        ? fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW
        : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
      const fh = await fsOpen(resolvedPath, flags, 0o644);
      try {
        await fh.writeFile(contentStr, 'utf-8');
      } finally {
        await fh.close();
      }
      const bytesWritten = Buffer.byteLength(contentStr, 'utf-8');

      // Generate unified diff
      const diff = generateUnifiedDiff(oldContent, contentStr, path, existed);

      const header = existed
        ? `File overwritten: ${path} (${bytesWritten} bytes, backup created)`
        : `File created: ${path} (${bytesWritten} bytes)`;

      return this.ok(toolCallId, `${header}\n\n${diff}`, {
        bytesWritten,
        created: !existed,
      });
    } catch (err) {
      const msg = (err as NodeJS.ErrnoException).code === 'ELOOP'
        ? `Refusing to write through symlink: ${path}`
        : `Failed to write file: ${(err as Error).message}`;
      return this.fail(toolCallId, msg);
    }
  }
}

/**
 * Generate a unified diff string between oldContent and newContent.
 * If the file is new (existed=false), all lines are shown as additions.
 * Truncates if more than 500 lines changed to avoid huge output.
 */
function generateUnifiedDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
  existed: boolean
): string {
  const oldLines = oldContent ? oldContent.split('\n') : [];
  const newLines = newContent.split('\n');

  // New file: all additions
  if (!existed || oldLines.length === 0) {
    const header = [`--- /dev/null`, `+++ b/${filePath}`, `@@ -0,0 +1,${newLines.length} @@`];
    const MAX_NEW_LINES = 500;
    if (newLines.length > MAX_NEW_LINES) {
      const shown = newLines.slice(0, MAX_NEW_LINES).map(l => `+${l}`);
      return [
        ...header,
        ...shown,
        `... (${newLines.length - MAX_NEW_LINES} more lines)`,
      ].join('\n');
    }
    return [...header, ...newLines.map(l => `+${l}`)].join('\n');
  }

  // Existing file: compute diff hunks
  const hunks = computeHunks(oldLines, newLines);
  if (hunks.length === 0) return 'No changes detected.';

  const result = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    ...hunks,
  ].join('\n');

  // Truncate if result is very large
  const MAX_DIFF_CHARS = 8000;
  if (result.length > MAX_DIFF_CHARS) {
    return result.slice(0, MAX_DIFF_CHARS) + '\n... (diff truncated)';
  }
  return result;
}

/**
 * Compute unified diff hunks between oldLines and newLines.
 * Uses a simple O(n) greedy approach: compare line-by-line with context.
 */
function computeHunks(oldLines: string[], newLines: string[]): string[] {
  const CONTEXT = 3;
  const MAX_CHANGED = 500;

  // Build edit script: for each position mark as equal, delete, or insert
  // We use a simple patience-like approach: find equal regions greedily
  const ops = diffLines(oldLines, newLines);

  // Count total changes
  const totalChanged = ops.filter(op => op.type !== 'equal').length;
  if (totalChanged === 0) return [];
  if (totalChanged > MAX_CHANGED) {
    // Just show summary line
    const addCount = ops.filter(op => op.type === 'insert').length;
    const delCount = ops.filter(op => op.type === 'delete').length;
    return [`@@ (large diff) @@\n... ${delCount} lines removed, ${addCount} lines added ...`];
  }

  // Group ops into hunks (continuous regions with context)
  const hunks: string[] = [];
  let i = 0;

  while (i < ops.length) {
    // Skip equal regions before next change
    if (ops[i]!.type === 'equal') {
      i++;
      continue;
    }

    // Found a change — find the hunk range
    const hunkStart = i;
    let hunkEnd = i;
    // Extend to include all changes within CONTEXT distance of each other
    while (hunkEnd < ops.length) {
      if (ops[hunkEnd]!.type !== 'equal') {
        hunkEnd++;
      } else {
        // Check if next change is within CONTEXT*2 equal lines
        let equalCount = 0;
        let j = hunkEnd;
        while (j < ops.length && ops[j]!.type === 'equal') {
          equalCount++;
          j++;
        }
        if (equalCount <= CONTEXT * 2 && j < ops.length && ops[j]!.type !== 'equal') {
          hunkEnd = j;
        } else {
          break;
        }
      }
    }

    // Build context around hunk
    const contextBefore = Math.max(0, hunkStart - CONTEXT);
    const contextAfter = Math.min(ops.length, hunkEnd + CONTEXT);

    // Compute old/new line numbers for hunk header
    let oldLine = 1;
    let newLine = 1;
    for (let k = 0; k < contextBefore; k++) {
      const op = ops[k]!;
      if (op.type === 'equal' || op.type === 'delete') oldLine++;
      if (op.type === 'equal' || op.type === 'insert') newLine++;
    }

    let oldCount = 0;
    let newCount = 0;
    const hunkLines: string[] = [];

    for (let k = contextBefore; k < contextAfter; k++) {
      const op = ops[k]!;
      if (op.type === 'equal') {
        hunkLines.push(` ${op.line}`);
        oldCount++;
        newCount++;
      } else if (op.type === 'delete') {
        hunkLines.push(`-${op.line}`);
        oldCount++;
      } else {
        hunkLines.push(`+${op.line}`);
        newCount++;
      }
    }

    hunks.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`);
    hunks.push(...hunkLines);

    i = hunkEnd;
  }

  return hunks;
}

type DiffOp =
  | { type: 'equal'; line: string }
  | { type: 'delete'; line: string }
  | { type: 'insert'; line: string };

/**
 * Simple line diff using LCS via dynamic programming (capped at 200 lines each for performance).
 * Falls back to full delete+insert for larger inputs.
 */
function diffLines(oldLines: string[], newLines: string[]): DiffOp[] {
  const MAX_LCS = 200;

  if (oldLines.length > MAX_LCS || newLines.length > MAX_LCS) {
    // Large file: use greedy block diff
    return greedyDiff(oldLines, newLines);
  }

  // LCS-based diff
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i]![j] = (dp[i + 1]![j + 1] ?? 0) + 1;
      } else {
        dp[i]![j] = Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
      }
    }
  }

  // Trace back
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      ops.push({ type: 'equal', line: oldLines[i]! });
      i++;
      j++;
    } else if (j < n && (i >= m || (dp[i]![j + 1] ?? 0) >= (dp[i + 1]![j] ?? 0))) {
      ops.push({ type: 'insert', line: newLines[j]! });
      j++;
    } else {
      ops.push({ type: 'delete', line: oldLines[i]! });
      i++;
    }
  }
  return ops;
}

/**
 * Greedy diff for large files: find matching blocks and emit deletes/inserts for gaps.
 */
function greedyDiff(oldLines: string[], newLines: string[]): DiffOp[] {
  const ops: DiffOp[] = [];
  let oi = 0;
  let ni = 0;

  // Build index of new lines for quick lookup
  const newIndex = new Map<string, number[]>();
  for (let i = 0; i < newLines.length; i++) {
    const line = newLines[i]!;
    const arr = newIndex.get(line);
    if (arr) arr.push(i);
    else newIndex.set(line, [i]);
  }

  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      ops.push({ type: 'equal', line: oldLines[oi]! });
      oi++;
      ni++;
    } else {
      // Find next match
      let bestOld = -1;
      let bestNew = -1;
      let bestScore = Infinity;

      for (let lookAhead = 0; lookAhead < 20; lookAhead++) {
        const checkOld = oi + lookAhead;
        if (checkOld < oldLines.length) {
          const candidates = newIndex.get(oldLines[checkOld]!) ?? [];
          for (const cn of candidates) {
            if (cn >= ni) {
              const score = lookAhead + (cn - ni);
              if (score < bestScore) {
                bestScore = score;
                bestOld = checkOld;
                bestNew = cn;
              }
              break;
            }
          }
        }
      }

      if (bestOld === -1) {
        // No match found in lookahead — emit remaining as delete/insert
        while (oi < oldLines.length) ops.push({ type: 'delete', line: oldLines[oi++]! });
        while (ni < newLines.length) ops.push({ type: 'insert', line: newLines[ni++]! });
        break;
      }

      // Emit deletions and insertions up to the match
      while (oi < bestOld) ops.push({ type: 'delete', line: oldLines[oi++]! });
      while (ni < bestNew) ops.push({ type: 'insert', line: newLines[ni++]! });
    }
  }

  return ops;
}
