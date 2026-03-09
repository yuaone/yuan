/**
 * @yuaone/tools — glob tool
 *
 * Finds files matching glob patterns.
 * - Uses fast-glob for performance
 * - Auto-excludes node_modules, .git
 * - Max 100 results by default
 */

import fg from 'fast-glob';
import type { ParameterDef, RiskLevel, ToolResult } from './types.js';
import { BaseTool } from './base-tool.js';

const DEFAULT_MAX_RESULTS = 100;

export class GlobTool extends BaseTool {
  readonly name = 'glob';
  readonly description =
    'Find files matching a glob pattern. ' +
    'Auto-excludes node_modules and .git directories.';
  readonly riskLevel: RiskLevel = 'low';

  readonly parameters: Record<string, ParameterDef> = {
    pattern: {
      type: 'string',
      description: 'Glob pattern (e.g., "src/**/*.tsx", "**/*.test.ts")',
      required: true,
    },
    path: {
      type: 'string',
      description: 'Base directory relative to project root (default: project root)',
      required: false,
    },
    maxResults: {
      type: 'number',
      description: `Maximum results (default: ${DEFAULT_MAX_RESULTS})`,
      required: false,
      default: DEFAULT_MAX_RESULTS,
    },
  };

  async execute(args: Record<string, unknown>, workDir: string): Promise<ToolResult> {
    const toolCallId = (args._toolCallId as string) ?? '';
    const pattern = args.pattern as string | undefined;
    const basePath = args.path as string | undefined;
    const maxResults = (args.maxResults as number) ?? DEFAULT_MAX_RESULTS;

    if (!pattern) {
      return this.fail(toolCallId, 'Missing required parameter: pattern');
    }

    // Resolve base directory
    let cwd = workDir;
    if (basePath) {
      try {
        cwd = this.validatePath(basePath, workDir);
      } catch (err) {
        return this.fail(toolCallId, (err as Error).message);
      }
    }

    try {
      const allFiles = await fg(pattern, {
        cwd,
        ignore: [
          '**/node_modules/**',
          '**/.git/**',
          '**/dist/**',
          '**/build/**',
          '**/.next/**',
          '**/coverage/**',
        ],
        onlyFiles: true,
        followSymbolicLinks: false,
      });

      const totalMatches = allFiles.length;
      const truncated = totalMatches > maxResults;
      const files = allFiles.slice(0, maxResults);

      let output: string;
      if (files.length === 0) {
        output = `No files found matching pattern: ${pattern}`;
      } else {
        output = files.join('\n');
        if (truncated) {
          output += `\n\n... (showing ${maxResults} of ${totalMatches} total matches)`;
        }
      }

      return this.ok(toolCallId, output, {
        totalMatches,
        filesReturned: files.length,
        truncated,
      });
    } catch (err) {
      return this.fail(toolCallId, `Glob search failed: ${(err as Error).message}`);
    }
  }
}
