/**
 * @yuaone/tools — bash tool
 *
 * Executes shell commands via bash -c "...".
 * Supports pipes, redirects, &&, ||, env vars, subshells.
 * Use when shell features are needed (shell_exec doesn't support these).
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ParameterDef, RiskLevel, ToolResult } from './types.js';
import { BaseTool } from './base-tool.js';

const DEFAULT_TIMEOUT = 60_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT = 150_000; // 150KB

// Hard-blocked patterns — catastrophic/irreversible operations
const BLOCKED_PATTERNS = [
  /rm\s+-[a-z]*r[a-z]*f\s+\/(?!\w)/i,   // rm -rf /
  /rm\s+-[a-z]*f[a-z]*r\s+\/(?!\w)/i,   // rm -fr /
  /:\s*\(\s*\)\s*\{.*:\|:.*\}/,           // fork bomb
  /dd\s+.*of=\/dev\/(sd|nvme|hd)/i,       // disk wipe
  /mkfs\./i,                               // filesystem format
  />\s*\/dev\/(sd|nvme|hd)/i,             // overwrite disk
  /shutdown|reboot|halt|poweroff/i,        // system shutdown
  /passwd\s+root/i,                        // root password change
];

function isBlocked(command: string): string | null {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return `Blocked dangerous pattern: ${pattern.source}`;
    }
  }
  return null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n...[truncated ${s.length - max} bytes]`;
}

export class BashTool extends BaseTool {
  readonly name = 'bash';
  readonly description =
    'Run a bash shell command. Supports pipes (|), redirects (>), ' +
    'logical operators (&&, ||), env vars, subshells, etc. ' +
    'Use for complex shell operations that shell_exec cannot handle.';
  readonly riskLevel: RiskLevel = 'critical';

  readonly parameters: Record<string, ParameterDef> = {
    command: {
      type: 'string',
      description: 'Shell command string to execute via bash -c',
      required: true,
    },
    cwd: {
      type: 'string',
      description: 'Working directory (default: project root)',
      required: false,
    },
    timeout: {
      type: 'number',
      description: `Timeout in ms (default: ${DEFAULT_TIMEOUT}, max: ${MAX_TIMEOUT})`,
      required: false,
    },
    env: {
      type: 'object',
      description: 'Extra environment variables to set',
      required: false,
    },
  };

  async execute(args: Record<string, unknown>, workDir: string): Promise<ToolResult> {
    const toolCallId = (args._toolCallId as string) ?? '';
    const command = args.command as string | undefined;
    const cwdArg = args.cwd as string | undefined;
    const timeoutArg = args.timeout as number | undefined;
    const envArg = args.env as Record<string, string> | undefined;

    if (!command || command.trim() === '') {
      return this.fail(toolCallId, 'Missing required parameter: command');
    }

    // Block catastrophic patterns
    const blocked = isBlocked(command);
    if (blocked) {
      return this.fail(toolCallId, blocked);
    }

    const timeout = Math.min(timeoutArg ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);

    // Resolve cwd
    let resolvedCwd = workDir;
    if (cwdArg) {
      try {
        resolvedCwd = resolve(workDir, cwdArg);
        mkdirSync(resolvedCwd, { recursive: true });
      } catch {
        return this.fail(toolCallId, `Invalid cwd: ${cwdArg}`);
      }
    }

    const env = envArg
      ? { ...process.env, ...envArg }
      : process.env;

    const startMs = Date.now();

    return new Promise<ToolResult>((resolve_) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const child = spawn('bash', ['-c', command], {
        cwd: resolvedCwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(-MAX_OUTPUT);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(-MAX_OUTPUT);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 3000);
      }, timeout);

      child.on('close', (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startMs;
        const exitCode = code ?? -1;

        let output = '';
        if (stdout) output += truncate(stdout, MAX_OUTPUT);
        if (stderr) output += (output ? '\n[stderr]\n' : '[stderr]\n') + truncate(stderr, MAX_OUTPUT);
        if (timedOut) output += `\n[TIMED OUT after ${timeout}ms]`;
        output += `\n[exit ${exitCode}] [${durationMs}ms]`;

        if (exitCode === 0) {
          resolve_(this.ok(toolCallId, output.trim(), { exitCode, durationMs }));
        } else {
          resolve_(this.fail(toolCallId, output.trim()));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve_(this.fail(toolCallId, `spawn error: ${err.message}`));
      });
    });
  }
}
