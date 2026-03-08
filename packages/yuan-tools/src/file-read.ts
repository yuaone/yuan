/**
 * @yuan/tools — file_read tool
 *
 * Reads a file with optional offset/limit.
 * - 50KB size limit (auto-split guidance on overflow)
 * - UTF-8 decoding
 * - Binary file detection and rejection
 * - Image file base64 conversion
 */

import { readFile, stat } from 'node:fs/promises';
import type { ParameterDef, RiskLevel, ToolResult } from './types.js';
import { BaseTool } from './base-tool.js';
import { isBinaryFile, isImageFile, detectLanguage } from './validators.js';

const MAX_FILE_SIZE = 50_000; // 50KB

export class FileReadTool extends BaseTool {
  readonly name = 'file_read';
  readonly description =
    'Read a file from the project. Returns content with line numbers. ' +
    'Use offset/limit for large files (>50KB).';
  readonly riskLevel: RiskLevel = 'low';

  readonly parameters: Record<string, ParameterDef> = {
    path: {
      type: 'string',
      description: 'Relative path from project root',
      required: true,
    },
    offset: {
      type: 'number',
      description: 'Start line number (1-based)',
      required: false,
    },
    limit: {
      type: 'number',
      description: 'Number of lines to read',
      required: false,
    },
  };

  async execute(args: Record<string, unknown>, workDir: string): Promise<ToolResult> {
    const toolCallId = (args._toolCallId as string) ?? '';
    const path = args.path as string | undefined;

    if (!path) {
      return this.fail(toolCallId, 'Missing required parameter: path');
    }

    let resolvedPath: string;
    try {
      resolvedPath = this.validatePath(path, workDir);
    } catch (err) {
      return this.fail(toolCallId, (err as Error).message);
    }

    // Check if file exists and get size
    let fileStat;
    try {
      fileStat = await stat(resolvedPath);
    } catch {
      return this.fail(toolCallId, `File not found: ${path}`);
    }

    if (fileStat.isDirectory()) {
      return this.fail(toolCallId, `Path is a directory, not a file: ${path}`);
    }

    // Image file → base64
    if (isImageFile(resolvedPath)) {
      try {
        const buf = await readFile(resolvedPath);
        const b64 = buf.toString('base64');
        const language = detectLanguage(resolvedPath);
        return this.ok(toolCallId, `[base64 image: ${language}]\n${b64}`, {
          totalLines: 0,
          language,
          truncated: false,
        });
      } catch (err) {
        return this.fail(toolCallId, `Failed to read image: ${(err as Error).message}`);
      }
    }

    // Binary file → reject
    if (await isBinaryFile(resolvedPath)) {
      return this.fail(
        toolCallId,
        `Binary file detected: ${path}. Use a specialized tool or download it directly.`
      );
    }

    // Check size limit (without offset/limit)
    const offset = (args.offset as number | undefined) ?? undefined;
    const limit = (args.limit as number | undefined) ?? undefined;

    if (fileStat.size > MAX_FILE_SIZE && offset === undefined && limit === undefined) {
      const totalLines = await countLines(resolvedPath);
      return this.fail(
        toolCallId,
        `File is ${fileStat.size} bytes (limit: ${MAX_FILE_SIZE}). ` +
          `Total lines: ${totalLines}. ` +
          `Use offset and limit parameters to read in chunks.`
      );
    }

    // Read file
    try {
      const raw = await readFile(resolvedPath, 'utf-8');
      const allLines = raw.split('\n');
      const totalLines = allLines.length;

      // Apply offset/limit
      const startLine = offset !== undefined ? Math.max(1, offset) : 1;
      const endLine = limit !== undefined ? startLine + limit - 1 : totalLines;
      const selectedLines = allLines.slice(startLine - 1, endLine);

      // Format with line numbers
      const numbered = selectedLines
        .map((line, i) => `${String(startLine + i).padStart(6, ' ')}\t${line}`)
        .join('\n');

      const truncated = endLine < totalLines || startLine > 1;
      const language = detectLanguage(resolvedPath);

      // Check output size after formatting
      const output = this.truncateOutput(numbered);

      return this.ok(toolCallId, output, {
        totalLines,
        language,
        truncated,
      });
    } catch (err) {
      return this.fail(toolCallId, `Failed to read file: ${(err as Error).message}`);
    }
  }
}

async function countLines(filePath: string): Promise<number> {
  const content = await readFile(filePath, 'utf-8');
  return content.split('\n').length;
}
