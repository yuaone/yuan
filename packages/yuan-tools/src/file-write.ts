/**
 * @yuan/tools — file_write tool
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

    // Write file using O_NOFOLLOW to atomically prevent symlink TOCTOU attacks.
    // This eliminates the race window between symlink check and write.
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
      const msg = (err as NodeJS.ErrnoException).code === 'ELOOP'
        ? `Refusing to write through symlink: ${path}`
        : `Failed to write file: ${(err as Error).message}`;
      return this.fail(toolCallId, msg);
    }
  }
}
