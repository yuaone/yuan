/**
 * @yuaone/tools — file_edit tool
 *
 * Performs exact string replacement in files.
 * - old_string must exist in file
 * - Ambiguity check: if old_string matches multiple times and replace_all=false → error
 * - Generates unified diff preview
 * - Fuzzy match suggestion on failure
 */

import { readFile, stat, open as fsOpen } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import type { ParameterDef, RiskLevel, ToolResult } from './types.js';
import { BaseTool } from './base-tool.js';
import { isSensitiveFile } from './validators.js';

export class FileEditTool extends BaseTool {
  readonly name = 'file_edit';
  readonly description =
    'Edit a file by replacing an exact string match. ' +
    'Fails if old_string is not found or is ambiguous (multiple matches without replace_all).';
  readonly riskLevel: RiskLevel = 'medium';

  readonly parameters: Record<string, ParameterDef> = {
    path: {
      type: 'string',
      description: 'Relative path from project root',
      required: true,
    },
    old_string: {
      type: 'string',
      description: 'Exact string to find and replace',
      required: true,
    },
    new_string: {
      type: 'string',
      description: 'Replacement string',
      required: true,
    },
    replace_all: {
      type: 'boolean',
      description: 'Replace all occurrences (default: false)',
      required: false,
      default: false,
    },
  };

  async execute(args: Record<string, unknown>, workDir: string): Promise<ToolResult> {
    const toolCallId = (args._toolCallId as string) ?? '';
    const path = args.path as string | undefined;
    const oldString = args.old_string as string | undefined;
    const newString = args.new_string as string | undefined;
    const replaceAll = (args.replace_all as boolean) ?? false;

    if (!path) return this.fail(toolCallId, 'Missing required parameter: path');
    if (oldString === undefined) return this.fail(toolCallId, 'Missing required parameter: old_string');
    if (newString === undefined) return this.fail(toolCallId, 'Missing required parameter: new_string');

    let resolvedPath: string;
    try {
      resolvedPath = this.validatePath(path, workDir);
    } catch (err) {
      return this.fail(toolCallId, (err as Error).message);
    }

    // Sensitive file check
    if (isSensitiveFile(path)) {
      return this.fail(
        toolCallId,
        `Sensitive file detected: "${path}". ` +
          'Editing credential/secret files is blocked for security.'
      );
    }

    // Check file exists
    try {
      const s = await stat(resolvedPath);
      if (s.isDirectory()) {
        return this.fail(toolCallId, `Path is a directory: ${path}`);
      }
    } catch {
      return this.fail(toolCallId, `File not found: ${path}`);
    }

    // Read file
    let content: string;
    try {
      content = await readFile(resolvedPath, 'utf-8');
    } catch (err) {
      return this.fail(toolCallId, `Failed to read file: ${(err as Error).message}`);
    }

    // Count occurrences
    const occurrences = countOccurrences(content, oldString);

    if (occurrences === 0) {
      // Idempotency check: if replace_all is true and new_string is already present,
      // the operation was likely already applied in a previous attempt. Treat as success
      // to prevent infinite recovery loops on retry.
      if (replaceAll && newString !== '' && content.includes(newString)) {
        return this.ok(
          toolCallId,
          `already applied (idempotent): new_string already present in ${path}, old_string not found — skipping replacement`,
          { replacements: 0, preview: 'No changes needed (already applied)' }
        );
      }

      // Try fuzzy match suggestion
      const suggestion = findFuzzyMatch(content, oldString);
      const msg = suggestion
        ? `old_string not found in ${path}. Did you mean:\n${suggestion}`
        : `old_string not found in ${path}. Verify the exact content to replace.`;
      return this.fail(toolCallId, msg);
    }

    if (occurrences > 1 && !replaceAll) {
      return this.fail(
        toolCallId,
        `old_string matches ${occurrences} times in ${path}. ` +
          'Set replace_all=true to replace all occurrences, ' +
          'or provide a more specific old_string with surrounding context.'
      );
    }

    // Perform replacement
    const newContent = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);

    const replacements = replaceAll ? occurrences : 1;

    // Generate preview (unified diff style)
    const preview = generatePreview(content, newContent, path);

    // Write file using O_NOFOLLOW to prevent symlink TOCTOU attacks
    try {
      const fh = await fsOpen(
        resolvedPath,
        fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW
      );
      try {
        await fh.writeFile(newContent, 'utf-8');
      } finally {
        await fh.close();
      }
    } catch (err) {
      const msg = (err as NodeJS.ErrnoException).code === 'ELOOP'
        ? `Refusing to edit through symlink: ${path}`
        : `Failed to write file: ${(err as Error).message}`;
      return this.fail(toolCallId, msg);
    }

    return this.ok(
      toolCallId,
      `${replacements} replacement(s) in ${path}\n\n${preview}`,
      { replacements, preview }
    );
  }
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = content.indexOf(search, pos);
    if (idx === -1) break;
    count++;
    pos = idx + search.length;
  }
  return count;
}

/**
 * Generate a unified-diff-style preview showing changed lines.
 */
function generatePreview(oldContent: string, newContent: string, filePath: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const diffs: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];

  // Simple line-by-line diff with context
  const contextSize = 3;
  const changedLineIndices = new Set<number>();

  // Find changed ranges
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (oldLines[i] !== newLines[i]) {
      for (let c = Math.max(0, i - contextSize); c <= Math.min(maxLen - 1, i + contextSize); c++) {
        changedLineIndices.add(c);
      }
    }
  }

  if (changedLineIndices.size === 0) return 'No changes detected.';

  // Build hunks
  const sortedIndices = [...changedLineIndices].sort((a, b) => a - b);
  if (sortedIndices.length === 0) return 'No changes detected.';
  let hunkStart = sortedIndices[0]!;
  let hunkLines: string[] = [];

  for (const idx of sortedIndices) {
    const oldLine = idx < oldLines.length ? oldLines[idx] : undefined;
    const newLine = idx < newLines.length ? newLines[idx] : undefined;

    if (oldLine === newLine) {
      hunkLines.push(` ${oldLine ?? ''}`);
    } else {
      if (oldLine !== undefined) hunkLines.push(`-${oldLine}`);
      if (newLine !== undefined) hunkLines.push(`+${newLine}`);
    }
  }

  diffs.push(`@@ -${hunkStart + 1} @@`);
  diffs.push(...hunkLines);

  // Limit preview size
  const result = diffs.join('\n');
  if (result.length > 2000) {
    return result.slice(0, 2000) + '\n... (preview truncated)';
  }
  return result;
}

/**
 * Try to find a fuzzy match in the content when exact match fails.
 * Returns a suggestion string or null.
 */
function findFuzzyMatch(content: string, search: string): string | null {
  // Trim whitespace and try again
  const trimmed = search.trim();
  if (trimmed !== search && content.includes(trimmed)) {
    return `"${trimmed}" (whitespace-trimmed version found)`;
  }

  // Try case-insensitive match
  const lowerContent = content.toLowerCase();
  const lowerSearch = search.toLowerCase();
  const idx = lowerContent.indexOf(lowerSearch);
  if (idx !== -1) {
    const found = content.slice(idx, idx + search.length);
    return `"${found}" (case-insensitive match found)`;
  }

  // Try first line match
  const firstLine = search.split('\n')[0].trim();
  if (firstLine.length > 10) {
    const lineIdx = content.indexOf(firstLine);
    if (lineIdx !== -1) {
      const lineStart = content.lastIndexOf('\n', lineIdx) + 1;
      const lineEnd = content.indexOf('\n', lineIdx + firstLine.length);
      const contextEnd = lineEnd === -1 ? content.length : lineEnd;
      return `First line found at offset ${lineIdx}. Context:\n${content.slice(lineStart, contextEnd)}`;
    }
  }

  return null;
}
