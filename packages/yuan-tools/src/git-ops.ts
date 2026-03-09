/**
 * @yuan/tools — git_ops tool
 *
 * Git operations: status, diff, log, add, commit, create_branch, stash, restore.
 * - commit/create_branch require approval (riskLevel dynamically elevated)
 * - Uses execFile (no shell interpretation)
 */

import { execFile } from 'node:child_process';
import type { ParameterDef, RiskLevel, ToolResult } from './types.js';
import { BaseTool } from './base-tool.js';
import { validatePath, isSensitiveFile } from './validators.js';

const GIT_TIMEOUT = 15_000; // 15s

export class GitOpsTool extends BaseTool {
  readonly name = 'git_ops';
  readonly description =
    'Perform git operations: status, diff, log, add, commit, create_branch, stash, restore. ' +
    'commit and create_branch operations require user approval.';
  readonly riskLevel: RiskLevel = 'medium';

  readonly parameters: Record<string, ParameterDef> = {
    operation: {
      type: 'string',
      description: 'Git operation to perform',
      required: true,
      enum: ['status', 'diff', 'log', 'add', 'commit', 'create_branch', 'stash', 'restore'],
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
    branch: {
      type: 'string',
      description: 'Branch name (for create_branch operation)',
      required: false,
    },
  };

  async execute(args: Record<string, unknown>, workDir: string): Promise<ToolResult> {
    const toolCallId = (args._toolCallId as string) ?? '';
    const operation = args.operation as string | undefined;

    if (!operation) {
      return this.fail(toolCallId, 'Missing required parameter: operation');
    }

    const validOps = ['status', 'diff', 'log', 'add', 'commit', 'create_branch', 'stash', 'restore'];
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
        case 'create_branch':
          return await this.gitCreateBranch(toolCallId, workDir, args.branch as string | undefined);
        case 'stash':
          return await this.gitStash(toolCallId, workDir, args.message as string | undefined);
        case 'restore':
          return await this.gitRestore(toolCallId, workDir, args.files as string[] | undefined);
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
      // Validate each file path
      for (const f of files) {
        try {
          validatePath(f, cwd);
        } catch (err) {
          return this.fail(toolCallId, (err as Error).message);
        }
      }
      gitArgs.push('--', ...files);
    } else {
      gitArgs.push('-A');
    }

    await runGit(gitArgs, cwd);

    // Warn about sensitive files when using -A
    if (!files || files.length === 0) {
      const statusResult = await runGit(['status', '--porcelain', '-u'], cwd);
      const stagedFiles = statusResult.stdout.split('\n').filter(Boolean);
      const sensitiveFiles = stagedFiles
        .map((line) => line.slice(3).trim())
        .filter((f) => isSensitiveFile(f));
      if (sensitiveFiles.length > 0) {
        return this.ok(
          toolCallId,
          `Files staged.\n${statusResult.stdout}\n\n⚠️ WARNING: Sensitive files staged: ${sensitiveFiles.join(', ')}. Consider unstaging them before commit.`,
          { operation: 'add', sensitiveFiles }
        );
      }
      return this.ok(toolCallId, `Files staged.\n${statusResult.stdout}`, { operation: 'add' });
    }

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

    // If specific files provided, validate paths and add them first
    if (files && files.length > 0) {
      for (const f of files) {
        try {
          validatePath(f, cwd);
        } catch (err) {
          return this.fail(toolCallId, (err as Error).message);
        }
      }
      await runGit(['add', '--', ...files], cwd);
    }

    const result = await runGit(['commit', '-m', message], cwd);
    return this.ok(toolCallId, result.stdout || 'Commit created.', { operation: 'commit' });
  }

  private async gitCreateBranch(toolCallId: string, cwd: string, branch?: string): Promise<ToolResult> {
    if (!branch) {
      return this.fail(toolCallId, 'Missing required parameter: branch (for create_branch operation)');
    }

    // Validate branch name: no spaces, no shell metacharacters
    if (!/^[a-zA-Z0-9._\-/]+$/.test(branch)) {
      return this.fail(toolCallId, `Invalid branch name: "${branch}". Use alphanumeric, dots, hyphens, underscores, and slashes only.`);
    }

    const result = await runGit(['checkout', '-b', branch], cwd);
    return this.ok(toolCallId, result.stdout || `Branch "${branch}" created and checked out.`, { operation: 'create_branch' });
  }

  private async gitStash(toolCallId: string, cwd: string, message?: string): Promise<ToolResult> {
    const gitArgs = ['stash', 'push'];
    if (message) {
      gitArgs.push('-m', message);
    }

    const result = await runGit(gitArgs, cwd);
    return this.ok(toolCallId, result.stdout || 'Changes stashed.', { operation: 'stash' });
  }

  private async gitRestore(toolCallId: string, cwd: string, files?: string[]): Promise<ToolResult> {
    const gitArgs = ['restore'];
    if (files && files.length > 0) {
      // Validate each file path to prevent argument injection
      for (const f of files) {
        try {
          validatePath(f, cwd);
        } catch (err) {
          return this.fail(toolCallId, (err as Error).message);
        }
      }
      gitArgs.push('--', ...files);
    } else {
      gitArgs.push('.');
    }
    const result = await runGit(gitArgs, cwd);
    return this.ok(toolCallId, result.stdout || 'Files restored.', { operation: 'restore' });
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
