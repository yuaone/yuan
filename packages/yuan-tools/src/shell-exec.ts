/**
 * @yuaone/tools — shell_exec tool
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

  async execute(args: Record<string, unknown>, workDir: string, abortSignal?: AbortSignal): Promise<ToolResult> {
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

    // Block shell binaries and command wrappers that can bypass tool validation
    const SHELL_BINARIES = new Set(['bash', 'sh', 'zsh', 'dash', 'csh', 'ksh', 'fish']);
    const COMMAND_WRAPPERS = new Set([
      'env', 'xargs', 'nohup', 'strace', 'ltrace', 'gdb',
      'script', 'expect', 'unbuffer', 'setsid', 'timeout',
    ]);
    const execBase = executable.split('/').pop() ?? executable;
    if (SHELL_BINARIES.has(execBase)) {
      return this.fail(
        toolCallId,
        `Shell binary "${execBase}" cannot be executed directly. ` +
          'Use specific tool commands instead (e.g., "node", "pnpm", "git").'
      );
    }
    if (COMMAND_WRAPPERS.has(execBase)) {
      return this.fail(
        toolCallId,
        `Command wrapper "${execBase}" is blocked — it can be used to bypass security controls. ` +
          'Execute the target command directly instead.'
      );
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
          // Check if already aborted before starting
          if (abortSignal?.aborted) {
            resolve({ stdout: '', stderr: '', exitCode: 1, timedOut: false });
            return;
          }

          const child = execFile(
            executable,
            execArgs,
            {
              cwd: resolvedCwd,
              timeout,
              maxBuffer: MAX_STDOUT + MAX_STDERR,
              env: env ? { ...process.env, ...sanitizeEnv(env) } : process.env,
            },
            (error, stdout, stderr) => {
              const execError = error as NodeJS.ErrnoException | null;
              let exitCode: number;
              if (execError && typeof execError.code === 'number') {
                exitCode = execError.code;
              } else if (execError && 'status' in execError && typeof (execError as { status?: unknown }).status === 'number') {
                exitCode = (execError as { status: number }).status;
              } else {
                exitCode = execError ? 1 : 0;
              }
              const timedOut = execError !== null && 'killed' in (execError ?? {}) && (execError as unknown as { killed?: boolean })?.killed === true;

              resolve({
                stdout: truncateStr(String(stdout ?? ''), MAX_STDOUT),
                stderr: truncateStr(String(stderr ?? ''), MAX_STDERR),
                exitCode: typeof exitCode === 'number' ? exitCode : 1,
                timedOut,
              });
            }
          );

          // Wire AbortSignal to kill the child process
          if (abortSignal) {
            const onAbort = () => {
              child.kill('SIGTERM');
              // If SIGTERM doesn't work, escalate to SIGKILL after 3s
              setTimeout(() => {
                if (!child.killed) {
                  child.kill('SIGKILL');
                }
              }, 3000).unref();
            };
            abortSignal.addEventListener('abort', onAbort, { once: true });
            // Clean up listener when child exits
            child.on('exit', () => {
              abortSignal.removeEventListener('abort', onAbort);
            });
          }
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
        tool_call_id: toolCallId,
        name: this.name,
        success: result.exitCode === 0 && !result.timedOut,
        output: this.truncateOutput(output),
        durationMs,
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

/**
 * Strip dangerous environment variables that could enable arbitrary code execution.
 * Blocks PATH override, dynamic linker injection, and interpreter hooks.
 */
const BLOCKED_ENV_VARS = new Set([
  'PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH', 'NODE_OPTIONS', 'PYTHONPATH', 'PYTHONSTARTUP',
  'PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'RUBYLIB',
  'SHELL', 'BASH_ENV', 'ENV', 'CDPATH',
  'IFS', 'SHELLOPTS', 'BASHOPTS',
]);

function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!BLOCKED_ENV_VARS.has(key.toUpperCase())) {
      safe[key] = value;
    }
  }
  return safe;
}

function truncateStr(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(-max) + `\n... (truncated, showing last ${max} chars)`;
}
