/**
 * @yuan/tools — shell_exec tool
 *
 * Executes a command using execFile (no shell interpretation).
 * - executable + args[] pattern (not a string command)
 * - Shell metacharacter validation
 * - Blocked commands (rm -rf /, sudo, chmod 777, etc.)
 * - 30-second default timeout
 * - stdout/stderr separate return
 */

import { execFile } from 'node:child_process';
import type { ParameterDef, RiskLevel, ToolResult } from './types.js';
import { BaseTool } from './base-tool.js';
import { validateNoShellMeta, validateCommand, validatePath } from './validators.js';

const DEFAULT_TIMEOUT = 30_000;
const MAX_STDOUT = 100_000; // 100KB
const MAX_STDERR = 50_000;  // 50KB

export class ShellExecTool extends BaseTool {
  readonly name = 'shell_exec';
  readonly description =
    'Execute a command with explicit executable and args (no shell interpretation). ' +
    'Use for build tools, test runners, linters, etc.';
  readonly riskLevel: RiskLevel = 'critical';

  readonly parameters: Record<string, ParameterDef> = {
    executable: {
      type: 'string',
      description: 'Executable name or path (e.g., "npx", "tsc", "node")',
      required: true,
    },
    args: {
      type: 'array',
      description: 'Argument array (passed directly, no shell interpretation)',
      required: true,
      items: { type: 'string', description: 'A single argument' },
    },
    cwd: {
      type: 'string',
      description: 'Working directory (relative to project root, default: project root)',
      required: false,
    },
    timeout: {
      type: 'number',
      description: 'Timeout in milliseconds (default: 30000)',
      required: false,
      default: DEFAULT_TIMEOUT,
    },
    env: {
      type: 'object',
      description: 'Additional environment variables',
      required: false,
    },
  };

  async execute(args: Record<string, unknown>, workDir: string): Promise<ToolResult> {
    const toolCallId = (args._toolCallId as string) ?? '';
    const executable = args.executable as string | undefined;
    const execArgs = args.args as string[] | undefined;
    const cwd = args.cwd as string | undefined;
    const timeout = (args.timeout as number) ?? DEFAULT_TIMEOUT;
    const env = args.env as Record<string, string> | undefined;

    if (!executable) {
      return this.fail(toolCallId, 'Missing required parameter: executable');
    }
    if (!execArgs || !Array.isArray(execArgs)) {
      return this.fail(toolCallId, 'Missing required parameter: args (must be an array)');
    }

    // Validate no shell metacharacters
    try {
      validateNoShellMeta(executable, execArgs);
    } catch (err) {
      return this.fail(toolCallId, (err as Error).message);
    }

    // Validate command is not blocked
    try {
      validateCommand(executable, execArgs);
    } catch (err) {
      return this.fail(toolCallId, (err as Error).message);
    }

    // Resolve cwd
    let resolvedCwd = workDir;
    if (cwd) {
      try {
        resolvedCwd = validatePath(cwd, workDir);
      } catch (err) {
        return this.fail(toolCallId, (err as Error).message);
      }
    }

    // Execute
    const startTime = Date.now();

    try {
      const result = await new Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>(
        (resolve) => {
          const child = execFile(
            executable,
            execArgs,
            {
              cwd: resolvedCwd,
              timeout,
              maxBuffer: MAX_STDOUT + MAX_STDERR,
              env: env ? { ...process.env, ...env } : process.env,
            },
            (error, stdout, stderr) => {
              const exitCode = error && 'code' in error ? (error.code as number) ?? 1 : 0;
              const timedOut = error !== null && 'killed' in error && error.killed === true;

              resolve({
                stdout: truncateStr(String(stdout ?? ''), MAX_STDOUT),
                stderr: truncateStr(String(stderr ?? ''), MAX_STDERR),
                exitCode: typeof exitCode === 'number' ? exitCode : 1,
                timedOut,
              });
            }
          );

          // Safety: kill child on timeout (execFile handles this, but belt-and-suspenders)
          child.unref?.();
        }
      );

      const durationMs = Date.now() - startTime;

      let output = '';
      if (result.stdout) {
        output += `[stdout]\n${result.stdout}\n`;
      }
      if (result.stderr) {
        output += `[stderr]\n${result.stderr}\n`;
      }
      if (result.timedOut) {
        output += `\n[TIMED OUT after ${timeout}ms]`;
      }
      output += `\n[exit code: ${result.exitCode}] [duration: ${durationMs}ms]`;

      return {
        toolCallId,
        success: result.exitCode === 0 && !result.timedOut,
        output: this.truncateOutput(output),
        error: result.exitCode !== 0 ? `Process exited with code ${result.exitCode}` : undefined,
        metadata: {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs,
        },
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      return this.fail(
        toolCallId,
        `Execution failed: ${(err as Error).message} [duration: ${durationMs}ms]`
      );
    }
  }
}

function truncateStr(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(-max) + `\n... (truncated, showing last ${max} chars)`;
}
