/**
 * @yuaone/tools — glob tool
 *
 * Finds files matching glob patterns.
 * - Uses fast-glob for performance
 * - Auto-excludes node_modules, .git
 * - Max 100 results by default
 */

import fg from 'fast-glob';
import { resolve, dirname } from 'node:path';
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
      description:
        'Glob pattern (e.g., "src/**/*.tsx", "**/*.test.ts"). ' +
        'For directories outside the project use the `path` parameter instead of putting "../" in the pattern.',
      required: true,
    },
    path: {
      type: 'string',
      description:
        'Base directory to search from (default: project root). ' +
        'Can be an absolute path or relative path including "../" to reach sibling directories.',
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
    let resolvedPattern = pattern;

    if (basePath) {
      try {
        cwd = this.validatePath(basePath, workDir, true);
      } catch (err) {
        return this.fail(toolCallId, (err as Error).message);
      }
    } else if (/^\.\.[\\/]|^\//.test(pattern)) {
      // Pattern starts with ../ or ../../ etc — auto-split into cwd + pattern.
      // fast-glob does not support ".." traversal in patterns, so we extract
      // any leading path segments (up to the first glob character) as cwd.
      const firstGlob = pattern.search(/[*?{[]/);
      if (firstGlob > 0) {
        const pathPrefix = pattern.slice(0, firstGlob);
        // Strip trailing separator
        const cleanPrefix = pathPrefix.replace(/[\\/]+$/, '');
        resolvedPattern = pattern.slice(firstGlob);
        try {
          cwd = this.validatePath(cleanPrefix, workDir, true);
        } catch (err) {
          return this.fail(toolCallId, (err as Error).message);
        }
      } else if (firstGlob === -1) {
        // No glob chars at all — treat the whole pattern as a path to list
        const cleanPrefix = pattern.replace(/[\\/]+$/, '');
        resolvedPattern = '**';
        try {
          cwd = this.validatePath(cleanPrefix, workDir, true);
        } catch (err) {
          return this.fail(toolCallId, (err as Error).message);
        }
      }
    }

    try {
      const allFiles = await fg(resolvedPattern, {
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
