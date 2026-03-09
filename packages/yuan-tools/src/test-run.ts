/**
 * @yuaone/tools — test_run tool
 *
 * Test framework auto-detection + execution.
 *
 * Detection order:
 * 1. package.json scripts.test
 * 2. jest.config / vitest.config / pytest.ini config files
 * 3. Error if no framework detected
 *
 * Supports: Jest (--json), Vitest (--reporter=json), Pytest (--tb=short)
 *
 * riskLevel: 'medium' (tests execute code)
 */

import { execFile } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { ParameterDef, RiskLevel, ToolResult } from './types.js';
import { BaseTool } from './base-tool.js';

const DEFAULT_TIMEOUT = 60_000; // 60s
const MAX_OUTPUT = 100_000;     // 100KB

type Framework = 'jest' | 'vitest' | 'pytest';

interface TestSummary {
  passed: number;
  failed: number;
  skipped: number;
  coverage?: number;
  failedTests: Array<{ name: string; error: string }>;
  stdout: string;
}

export class TestRunTool extends BaseTool {
  readonly name = 'test_run';
  readonly description =
    'Run tests with auto-detected framework (Jest, Vitest, Pytest). ' +
    'Returns structured results with pass/fail counts and failure details.';
  readonly riskLevel: RiskLevel = 'medium';

  readonly parameters: Record<string, ParameterDef> = {
    testPath: {
      type: 'string',
      description: 'Specific test file or directory to run (relative to project root)',
      required: false,
    },
    framework: {
      type: 'string',
      description: 'Test framework to use (default: auto-detect)',
      required: false,
      enum: ['jest', 'vitest', 'pytest', 'auto'],
      default: 'auto',
    },
    coverage: {
      type: 'boolean',
      description: 'Include coverage report',
      required: false,
      default: false,
    },
  };

  async execute(args: Record<string, unknown>, workDir: string): Promise<ToolResult> {
    const toolCallId = (args._toolCallId as string) ?? '';
    const testPath = args.testPath as string | undefined;
    const requestedFramework = (args.framework as string) ?? 'auto';
    const coverage = (args.coverage as boolean) ?? false;

    // Validate testPath if provided
    if (testPath) {
      try {
        this.validatePath(testPath, workDir);
      } catch (err) {
        return this.fail(toolCallId, (err as Error).message);
      }
    }

    // Detect framework
    let framework: Framework;
    if (requestedFramework === 'auto') {
      const detected = await this.detectFramework(workDir);
      if (!detected) {
        return this.fail(
          toolCallId,
          'Could not detect test framework. No test script in package.json and no config files found (jest.config, vitest.config, pytest.ini).'
        );
      }
      framework = detected;
    } else {
      framework = requestedFramework as Framework;
    }

    // Build command
    const { executable, cmdArgs } = this.buildCommand(framework, testPath, coverage);

    // Execute
    const startTime = Date.now();
    try {
      const result = await this.runTest(executable, cmdArgs, workDir, DEFAULT_TIMEOUT);
      const durationMs = Date.now() - startTime;

      // Parse results
      const summary = this.parseResults(framework, result.stdout, result.stderr);

      const output = this.formatOutput(framework, summary, durationMs, result.exitCode);

      return {
        tool_call_id: toolCallId,
        name: this.name,
        success: summary.failed === 0 && result.exitCode === 0,
        output: this.truncateOutput(output),
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      return this.fail(
        toolCallId,
        `Test execution failed: ${(err as Error).message} [duration: ${durationMs}ms]`
      );
    }
  }

  /**
   * Detect test framework from project configuration.
   */
  private async detectFramework(workDir: string): Promise<Framework | null> {
    // 1. Check package.json scripts.test
    try {
      const pkgPath = join(workDir, 'package.json');
      const pkgContent = await readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(pkgContent) as Record<string, unknown>;
      const scripts = pkg.scripts as Record<string, string> | undefined;

      if (scripts?.test) {
        const testScript = scripts.test;
        if (testScript.includes('vitest')) return 'vitest';
        if (testScript.includes('jest')) return 'jest';
        if (testScript.includes('pytest')) return 'pytest';
      }
    } catch {
      // No package.json or invalid — continue checking config files
    }

    // 2. Check config files
    const configChecks: Array<{ files: string[]; framework: Framework }> = [
      { files: ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts'], framework: 'vitest' },
      { files: ['jest.config.ts', 'jest.config.js', 'jest.config.cjs', 'jest.config.mjs'], framework: 'jest' },
      { files: ['pytest.ini', 'pyproject.toml', 'setup.cfg'], framework: 'pytest' },
    ];

    for (const check of configChecks) {
      for (const file of check.files) {
        try {
          await access(join(workDir, file));
          // For pyproject.toml, verify it has pytest config
          if (file === 'pyproject.toml') {
            const content = await readFile(join(workDir, file), 'utf-8');
            if (!content.includes('[tool.pytest') && !content.includes('pytest')) continue;
          }
          if (file === 'setup.cfg') {
            const content = await readFile(join(workDir, file), 'utf-8');
            if (!content.includes('[tool:pytest]')) continue;
          }
          return check.framework;
        } catch {
          // File doesn't exist — continue
        }
      }
    }

    return null;
  }

  /**
   * Build the executable and args for the detected framework.
   */
  private buildCommand(
    framework: Framework,
    testPath?: string,
    coverage?: boolean
  ): { executable: string; cmdArgs: string[] } {
    switch (framework) {
      case 'jest': {
        const cmdArgs = ['--json', '--no-coverage'];
        if (coverage) {
          cmdArgs[1] = '--coverage';
          cmdArgs.push('--coverageReporters=json-summary');
        }
        if (testPath) cmdArgs.push(testPath);
        return { executable: 'npx', cmdArgs: ['jest', ...cmdArgs] };
      }
      case 'vitest': {
        const cmdArgs = ['--reporter=json', '--run'];
        if (coverage) cmdArgs.push('--coverage');
        if (testPath) cmdArgs.push(testPath);
        return { executable: 'npx', cmdArgs: ['vitest', ...cmdArgs] };
      }
      case 'pytest': {
        const cmdArgs = ['--tb=short', '-q'];
        if (coverage) cmdArgs.push('--cov', '--cov-report=term');
        if (testPath) cmdArgs.push(testPath);
        return { executable: 'python3', cmdArgs: ['-m', 'pytest', ...cmdArgs] };
      }
    }
  }

  /**
   * Execute the test command using execFile (no shell injection).
   */
  private runTest(
    executable: string,
    args: string[],
    cwd: string,
    timeout: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      execFile(
        executable,
        args,
        {
          cwd,
          timeout,
          maxBuffer: MAX_OUTPUT * 2,
          env: { ...process.env, FORCE_COLOR: '0', CI: 'true' },
        },
        (error, stdout, stderr) => {
          const exitCode = error && typeof error.code === 'number' ? error.code : (error ? 1 : 0);
          resolve({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            exitCode,
          });
        }
      );
    });
  }

  /**
   * Parse test output into structured results.
   */
  private parseResults(framework: Framework, stdout: string, stderr: string): TestSummary {
    switch (framework) {
      case 'jest':
        return this.parseJestResults(stdout, stderr);
      case 'vitest':
        return this.parseVitestResults(stdout, stderr);
      case 'pytest':
        return this.parsePytestResults(stdout, stderr);
    }
  }

  private parseJestResults(stdout: string, stderr: string): TestSummary {
    // Jest --json outputs JSON to stdout
    try {
      // Find JSON in output (Jest may prepend non-JSON text)
      const jsonStart = stdout.indexOf('{');
      if (jsonStart >= 0) {
        const json = JSON.parse(stdout.slice(jsonStart)) as {
          numPassedTests?: number;
          numFailedTests?: number;
          numPendingTests?: number;
          testResults?: Array<{
            testResults?: Array<{
              title?: string;
              status?: string;
              failureMessages?: string[];
            }>;
          }>;
        };

        const failedTests: Array<{ name: string; error: string }> = [];
        if (json.testResults) {
          for (const suite of json.testResults) {
            if (suite.testResults) {
              for (const test of suite.testResults) {
                if (test.status === 'failed' && test.failureMessages) {
                  failedTests.push({
                    name: test.title ?? 'unknown',
                    error: test.failureMessages.join('\n').slice(0, 500),
                  });
                }
              }
            }
          }
        }

        return {
          passed: json.numPassedTests ?? 0,
          failed: json.numFailedTests ?? 0,
          skipped: json.numPendingTests ?? 0,
          failedTests,
          stdout: stdout + stderr,
        };
      }
    } catch {
      // JSON parse failed — fall through to raw output
    }

    return this.parseRawOutput(stdout, stderr);
  }

  private parseVitestResults(stdout: string, stderr: string): TestSummary {
    // Vitest --reporter=json outputs JSON to stdout
    try {
      const jsonStart = stdout.indexOf('{');
      if (jsonStart >= 0) {
        const json = JSON.parse(stdout.slice(jsonStart)) as {
          numPassedTests?: number;
          numFailedTests?: number;
          numPendingTests?: number;
          testResults?: Array<{
            assertionResults?: Array<{
              title?: string;
              status?: string;
              failureMessages?: string[];
            }>;
          }>;
        };

        const failedTests: Array<{ name: string; error: string }> = [];
        if (json.testResults) {
          for (const suite of json.testResults) {
            if (suite.assertionResults) {
              for (const test of suite.assertionResults) {
                if (test.status === 'failed' && test.failureMessages) {
                  failedTests.push({
                    name: test.title ?? 'unknown',
                    error: test.failureMessages.join('\n').slice(0, 500),
                  });
                }
              }
            }
          }
        }

        return {
          passed: json.numPassedTests ?? 0,
          failed: json.numFailedTests ?? 0,
          skipped: json.numPendingTests ?? 0,
          failedTests,
          stdout: stdout + stderr,
        };
      }
    } catch {
      // Fall through
    }

    return this.parseRawOutput(stdout, stderr);
  }

  private parsePytestResults(stdout: string, stderr: string): TestSummary {
    const combined = stdout + stderr;
    const failedTests: Array<{ name: string; error: string }> = [];

    // Parse pytest summary line: "X passed, Y failed, Z skipped"
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    const summaryMatch = combined.match(/(\d+)\s+passed/);
    if (summaryMatch) passed = parseInt(summaryMatch[1], 10);

    const failedMatch = combined.match(/(\d+)\s+failed/);
    if (failedMatch) failed = parseInt(failedMatch[1], 10);

    const skippedMatch = combined.match(/(\d+)\s+skipped/);
    if (skippedMatch) skipped = parseInt(skippedMatch[1], 10);

    // Extract FAILED test names
    const failedPattern = /FAILED\s+(\S+)/g;
    let match;
    while ((match = failedPattern.exec(combined)) !== null) {
      failedTests.push({ name: match[1], error: '' });
    }

    return { passed, failed, skipped, failedTests, stdout: combined };
  }

  /**
   * Fallback parser for raw text output when JSON parsing fails.
   */
  private parseRawOutput(stdout: string, stderr: string): TestSummary {
    const combined = stdout + stderr;
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    // Try to extract numbers from common patterns
    const passMatch = combined.match(/(\d+)\s+(?:pass(?:ed|ing)?|✓)/i);
    if (passMatch) passed = parseInt(passMatch[1], 10);

    const failMatch = combined.match(/(\d+)\s+(?:fail(?:ed|ing|ure)?|✗|✕)/i);
    if (failMatch) failed = parseInt(failMatch[1], 10);

    const skipMatch = combined.match(/(\d+)\s+(?:skip(?:ped)?|pending|todo)/i);
    if (skipMatch) skipped = parseInt(skipMatch[1], 10);

    return { passed, failed, skipped, failedTests: [], stdout: combined };
  }

  /**
   * Format the output for the agent.
   */
  private formatOutput(
    framework: string,
    summary: TestSummary,
    durationMs: number,
    exitCode: number
  ): string {
    const lines: string[] = [];
    lines.push(`[Test Results — ${framework}]`);
    lines.push(`Passed: ${summary.passed} | Failed: ${summary.failed} | Skipped: ${summary.skipped}`);
    if (summary.coverage !== undefined) {
      lines.push(`Coverage: ${summary.coverage}%`);
    }
    lines.push(`Duration: ${durationMs}ms | Exit code: ${exitCode}`);

    if (summary.failedTests.length > 0) {
      lines.push('');
      lines.push('[Failed Tests]');
      for (const t of summary.failedTests.slice(0, 20)) {
        lines.push(`  ✗ ${t.name}`);
        if (t.error) {
          lines.push(`    ${t.error.split('\n')[0]}`);
        }
      }
      if (summary.failedTests.length > 20) {
        lines.push(`  ... and ${summary.failedTests.length - 20} more`);
      }
    }

    lines.push('');
    lines.push('[Raw Output]');
    lines.push(summary.stdout.slice(0, MAX_OUTPUT));

    return lines.join('\n');
  }
}
