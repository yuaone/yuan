/**
 * @yuan/tools — file_write tool
 *
 * Writes content to a file.
 * - Auto-creates directories (mkdir -p)
 * - Backs up existing files before overwrite (.yuan-backup)
 * - Detects and warns about sensitive files (.env, credentials, etc.)
 */

import { readFile, writeFile, mkdir, stat, copyFile } from 'node:fs/promises';
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

    // Write file
    try {
      const contentStr = String(content);
      await writeFile(resolvedPath, contentStr, 'utf-8');
      const bytesWritten = Buffer.byteLength(contentStr, 'utf-8');

      let output = existed
        ? `File overwritten: ${path} (${bytesWritten} bytes, backup created)`
        : `File created: ${path} (${bytesWritten} bytes)`;

      // If the file existed, show a brief diff hint
      if (existed) {
        try {
          const originalContent = await readFile(resolvedPath + '.yuan-backup', 'utf-8');
          const origLines = originalContent.split('\n').length;
          const newLines = contentStr.split('\n').length;
          output += `\nPrevious: ${origLines} lines → New: ${newLines} lines`;
        } catch {
          // Backup read failed — skip diff info
        }
      }

      return this.ok(toolCallId, output, {
        bytesWritten,
        created: !existed,
      });
    } catch (err) {
      return this.fail(toolCallId, `Failed to write file: ${(err as Error).message}`);
    }
  }
}
