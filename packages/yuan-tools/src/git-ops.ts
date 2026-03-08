/**
 * @yuan/tools — git_ops tool
 *
 * Git operations: status, diff, log, add, commit.
 * - commit requires approval (riskLevel dynamically elevated)
 * - Uses execFile (no shell interpretation)
 */

import { execFile } from 'node:child_process';
import type { ParameterDef, RiskLevel, ToolResult } from './types.js';
import { BaseTool } from './base-tool.js';

const GIT_TIMEOUT = 15_000; // 15s

export class GitOpsTool extends BaseTool {
  readonly name = 'git_ops';
  readonly description =
    'Perform git operations: status, diff, log, add, commit. ' +
    'commit operation requires user approval.';
  readonly riskLevel: RiskLevel = 'medium';

  readonly parameters: Record<string, ParameterDef> = {
    operation: {
      type: 'string',
      description: 'Git operation to perform',
      required: true,
      enum: ['status', 'diff', 'log', 'add', 'commit'],
    },
    message: {
      type: 'string',
      description: 'Commit message (required for commit operation)',
      required: false,
    },
    files: {
      type: 'array',
      description: 'Files to add/commit (default: all changed files for add)',
      required: false,
      items: { type: 'string', description: 'File path' },
    },
    count: {
      type: 'number',
      description: 'Number of log entries (default: 10, for log operation)',
      required: false,
      default: 10,
    },
  };

  async execute(args: Record<string, unknown>, workDir: string): Promise<ToolResult> {
    const toolCallId = (args._toolCallId as string) ?? '';
    const operation = args.operation as string | undefined;

    if (!operation) {
      return this.fail(toolCallId, 'Missing required parameter: operation');
    }

    const validOps = ['status', 'diff', 'log', 'add', 'commit'];
    if (!validOps.includes(operation)) {
      return this.fail(toolCallId, `Invalid operation: ${operation}. Must be one of: ${validOps.join(', ')}`);
    }

    try {
      switch (operation) {
        case 'status':
          return await this.gitStatus(toolCallId, workDir);
        case 'diff':
          return await this.gitDiff(toolCallId, workDir);
        case 'log':
          return await this.gitLog(toolCallId, workDir, (args.count as number) ?? 10);
        case 'add':
          return await this.gitAdd(toolCallId, workDir, args.files as string[] | undefined);
        case 'commit':
          return await this.gitCommit(toolCallId, workDir, args.message as string | undefined, args.files as string[] | undefined);
        default:
          return this.fail(toolCallId, `Unknown operation: ${operation}`);
      }
    } catch (err) {
      return this.fail(toolCallId, `Git operation failed: ${(err as Error).message}`);
    }
  }

  private async gitStatus(toolCallId: string, cwd: string): Promise<ToolResult> {
    const result = await runGit(['status', '--porcelain', '-u'], cwd);
    const output = result.stdout || '(clean working tree)';
    return this.ok(toolCallId, output, { operation: 'status' });
  }

  private async gitDiff(toolCallId: string, cwd: string): Promise<ToolResult> {
    // Show both staged and unstaged changes
    const [unstaged, staged] = await Promise.all([
      runGit(['diff'], cwd),
      runGit(['diff', '--cached'], cwd),
    ]);

    let output = '';
    if (staged.stdout) {
      output += `[Staged changes]\n${staged.stdout}\n`;
    }
    if (unstaged.stdout) {
      output += `[Unstaged changes]\n${unstaged.stdout}\n`;
    }
    if (!output) {
      output = '(no changes)';
    }

    return this.ok(toolCallId, output, { operation: 'diff' });
  }

  private async gitLog(toolCallId: string, cwd: string, count: number): Promise<ToolResult> {
    const safeCount = Math.min(Math.max(1, count), 50);
    const result = await runGit(
      ['log', `--max-count=${safeCount}`, '--oneline', '--decorate'],
      cwd
    );
    const output = result.stdout || '(no commits)';
    return this.ok(toolCallId, output, { operation: 'log' });
  }

  private async gitAdd(toolCallId: string, cwd: string, files?: string[]): Promise<ToolResult> {
    const gitArgs = ['add'];
    if (files && files.length > 0) {
      gitArgs.push('--', ...files);
    } else {
      gitArgs.push('-A');
    }

    await runGit(gitArgs, cwd);
    const statusResult = await runGit(['status', '--porcelain', '-u'], cwd);
    return this.ok(toolCallId, `Files staged.\n${statusResult.stdout}`, { operation: 'add' });
  }

  private async gitCommit(
    toolCallId: string,
    cwd: string,
    message?: string,
    files?: string[]
  ): Promise<ToolResult> {
    if (!message) {
      return this.fail(toolCallId, 'Missing required parameter: message (for commit operation)');
    }

    // If specific files provided, add them first
    if (files && files.length > 0) {
      await runGit(['add', '--', ...files], cwd);
    }

    const result = await runGit(['commit', '-m', message], cwd);
    return this.ok(toolCallId, result.stdout || 'Commit created.', { operation: 'commit' });
  }
}

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !stdout && !stderr) {
          reject(error);
          return;
        }
        resolve({
          stdout: String(stdout ?? '').trim(),
          stderr: String(stderr ?? '').trim(),
          exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        });
      }
    );
  });
}
