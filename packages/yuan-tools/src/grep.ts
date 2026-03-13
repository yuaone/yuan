/**
 * @yuaone/tools — grep tool
 *
 * Searches file contents using regex patterns.
 * - Node.js built-in implementation (no ripgrep dependency)
 * - Glob-based file filtering
 * - Context lines support
 * - Max 100 result lines
 */

import { readFile, stat } from 'node:fs/promises';
import fg from 'fast-glob';
import type { ParameterDef, RiskLevel, ToolResult, GrepMatch } from './types.js';
import { BaseTool } from './base-tool.js';

const DEFAULT_MAX_RESULTS = 50;
const ABSOLUTE_MAX_RESULTS = 100;
const DEFAULT_CONTEXT = 0;

export class GrepTool extends BaseTool {
  readonly name = 'grep';
  readonly description =
    'Search file contents using a regex pattern. ' +
    'Returns matching lines with file paths and line numbers.';
  readonly riskLevel: RiskLevel = 'low';

  readonly parameters: Record<string, ParameterDef> = {
    pattern: {
      type: 'string',
      description: 'Regular expression pattern to search for',
      required: true,
    },
    path: {
      type: 'string',
      description: 'Search path relative to project root (default: project root)',
      required: false,
    },
    glob: {
      type: 'string',
      description: 'File pattern filter (e.g., "*.ts", "*.{ts,tsx}")',
      required: false,
    },
    maxResults: {
      type: 'number',
      description: `Maximum results to return (default: ${DEFAULT_MAX_RESULTS}, max: ${ABSOLUTE_MAX_RESULTS})`,
      required: false,
      default: DEFAULT_MAX_RESULTS,
    },
    context: {
      type: 'number',
      description: 'Number of context lines before and after each match (default: 0)',
      required: false,
      default: DEFAULT_CONTEXT,
    },
  };

  async execute(args: Record<string, unknown>, workDir: string): Promise<ToolResult> {
    const toolCallId = (args._toolCallId as string) ?? '';
    const pattern = args.pattern as string | undefined;
    const searchPath = args.path as string | undefined;
    const globPattern = args.glob as string | undefined;
    const maxResults = Math.min(
      (args.maxResults as number) ?? DEFAULT_MAX_RESULTS,
      ABSOLUTE_MAX_RESULTS
    );
    const contextLines = (args.context as number) ?? DEFAULT_CONTEXT;

    if (!pattern) {
      return this.fail(toolCallId, 'Missing required parameter: pattern');
    }

    // Compile regex
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'g');
    } catch (err) {
      return this.fail(toolCallId, `Invalid regex pattern: ${(err as Error).message}`);
    }

    // Resolve search path
    let searchDir = workDir;
    if (searchPath) {
      try {
        searchDir = this.validatePath(searchPath, workDir, true);
      } catch (err) {
        return this.fail(toolCallId, (err as Error).message);
      }
    }

    // Check if searchDir is a file or directory
    let isFile = false;
    try {
      const s = await stat(searchDir);
      isFile = s.isFile();
    } catch {
      return this.fail(toolCallId, `Path not found: ${searchPath ?? '.'}`);
    }

    // Collect files to search
    let files: string[];
    if (isFile) {
      files = [searchDir];
    } else {
      const fileGlob = globPattern ?? '**/*';
      try {
        files = await fg(fileGlob, {
          cwd: searchDir,
          absolute: true,
          ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
          onlyFiles: true,
          followSymbolicLinks: false,
        });
      } catch (err) {
        return this.fail(toolCallId, `Glob error: ${(err as Error).message}`);
      }
    }

    // Search files
    const matches: GrepMatch[] = [];
    let totalMatches = 0;

    for (const filePath of files) {
      if (matches.length >= maxResults) break;

      let content: string;
      try {
        content = await readFile(filePath, 'utf-8');
      } catch {
        continue; // Skip unreadable files (binary, permissions, etc.)
      }

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        // Reset regex state
        regex.lastIndex = 0;
        if (!regex.test(lines[i])) continue;

        totalMatches++;
        if (matches.length >= maxResults) continue; // Keep counting but stop collecting

        const relativePath = filePath.startsWith(workDir)
          ? filePath.slice(workDir.length + 1)
          : filePath;

        const match: GrepMatch = {
          file: relativePath,
          line: i + 1,
          content: lines[i],
        };

        if (contextLines > 0) {
          match.contextBefore = lines.slice(
            Math.max(0, i - contextLines),
            i
          );
          match.contextAfter = lines.slice(
            i + 1,
            Math.min(lines.length, i + 1 + contextLines)
          );
        }

        matches.push(match);
      }
    }

    const truncated = totalMatches > maxResults;

    // Format output
    const outputLines: string[] = [];
    for (const m of matches) {
      if (m.contextBefore && m.contextBefore.length > 0) {
        for (let j = 0; j < m.contextBefore.length; j++) {
          const lineNum = m.line - m.contextBefore.length + j;
          outputLines.push(`  ${m.file}:${lineNum}: ${m.contextBefore[j]}`);
        }
      }
      outputLines.push(`> ${m.file}:${m.line}: ${m.content}`);
      if (m.contextAfter && m.contextAfter.length > 0) {
        for (let j = 0; j < m.contextAfter.length; j++) {
          outputLines.push(`  ${m.file}:${m.line + 1 + j}: ${m.contextAfter[j]}`);
        }
      }
      if (m.contextBefore || m.contextAfter) {
        outputLines.push('--');
      }
    }

    if (truncated) {
      outputLines.push(`\n... (showing ${matches.length} of ${totalMatches} total matches)`);
    }

    const output = outputLines.length > 0
      ? outputLines.join('\n')
      : `No matches found for pattern: ${pattern}`;

    return this.ok(toolCallId, output, {
      totalMatches,
      matchesReturned: matches.length,
      truncated,
    });
  }
}
