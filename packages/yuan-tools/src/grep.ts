/**
 * @yuaone/tools — grep tool
 *
 * Searches file contents using ripgrep (rg) for performance.
 * Falls back to Node.js built-in if rg is not available.
 */

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import fg from 'fast-glob';
import type { ParameterDef, RiskLevel, ToolResult, GrepMatch } from './types.js';
import { BaseTool } from './base-tool.js';

const DEFAULT_MAX_RESULTS = 50;
const ABSOLUTE_MAX_RESULTS = 200;
const DEFAULT_CONTEXT = 0;
const MAX_OUTPUT = 100_000;

// ─── ripgrep JSON types ───────────────────────────────────────────────────────

interface RgMatchEvent {
  type: 'match';
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
    submatches: unknown[];
  };
}

interface RgContextEvent {
  type: 'context';
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
  };
}

type RgEvent = RgMatchEvent | RgContextEvent | { type: string; data: unknown };

// ─── ripgrep search ──────────────────────────────────────────────────────────

function runRipgrep(
  pattern: string,
  searchDir: string,
  globPattern: string | undefined,
  maxResults: number,
  contextLines: number,
): Promise<{ matches: GrepMatch[]; totalMatches: number; error?: string }> {
  return new Promise((resolve_) => {
    const args: string[] = [
      '--json',
      '--max-count', '1',          // 1 match per line (counting happens separately)
      '--glob', '!node_modules',
      '--glob', '!.git',
      '--glob', '!dist',
      '--glob', '!build',
      '--glob', '!.next',
      '--glob', '!coverage',
      '-e', pattern,
    ];

    if (globPattern) {
      args.push('--glob', globPattern);
    }
    if (contextLines > 0) {
      args.push('-C', String(contextLines));
    }

    args.push(searchDir);

    let stdout = '';
    let stderr = '';

    const child = execFile('rg', args, { maxBuffer: MAX_OUTPUT * 2 }, (err, out, errOut) => {
      stdout = out;
      stderr = errOut;

      // rg exits 1 when no matches (not an error)
      if (err && (err as NodeJS.ErrnoException).code !== 'ENOENT' && (err as { code?: number }).code !== 1) {
        // Exit code 2 = real error
        if ((err as { code?: number }).code === 2) {
          resolve_({ matches: [], totalMatches: 0, error: stderr.trim() });
          return;
        }
      }

      const matches: GrepMatch[] = [];
      let totalMatches = 0;

      // Parse JSON lines
      const contextBuffer: Map<string, { before: string[]; lineNum: number }> = new Map();

      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        let event: RgEvent;
        try {
          event = JSON.parse(line) as RgEvent;
        } catch {
          continue;
        }

        if (event.type === 'match') {
          const ev = event as RgMatchEvent;
          totalMatches++;
          if (matches.length >= maxResults) continue;

          const filePath = ev.data.path.text;
          const lineText = ev.data.lines.text.replace(/\n$/, '');
          const lineNum = ev.data.line_number;

          const relativePath = filePath.startsWith(searchDir)
            ? filePath.slice(searchDir.length).replace(/^[\\/]/, '')
            : filePath;

          const match: GrepMatch = {
            file: relativePath,
            line: lineNum,
            content: lineText,
          };

          // Attach context if collected
          const ctx = contextBuffer.get(filePath);
          if (ctx && contextLines > 0) {
            match.contextBefore = ctx.before.slice(-contextLines);
          }
          contextBuffer.delete(filePath);

          matches.push(match);
        } else if (event.type === 'context' && contextLines > 0) {
          const ev = event as RgContextEvent;
          const filePath = ev.data.path.text;
          const lineText = ev.data.lines.text.replace(/\n$/, '');
          const lineNum = ev.data.line_number;

          const existing = contextBuffer.get(filePath) ?? { before: [], lineNum };
          existing.before.push(lineText);
          if (existing.before.length > contextLines) existing.before.shift();
          contextBuffer.set(filePath, existing);

          // context after: attach to last match for that file
          const lastMatch = [...matches].reverse().find(m => m.file === filePath.slice(searchDir.length).replace(/^[\\/]/, '') );
          if (lastMatch && lastMatch.line < lineNum) {
            lastMatch.contextAfter = lastMatch.contextAfter ?? [];
            if (lastMatch.contextAfter.length < contextLines) {
              lastMatch.contextAfter.push(lineText);
            }
          }
        }
      }

      resolve_({ matches, totalMatches });
    });

    void child;
  });
}

// ─── Node.js fallback ────────────────────────────────────────────────────────

async function searchNodeFallback(
  pattern: string,
  searchDir: string,
  globPattern: string | undefined,
  maxResults: number,
  contextLines: number,
  workDir: string,
): Promise<{ matches: GrepMatch[]; totalMatches: number }> {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'g');
  } catch {
    return { matches: [], totalMatches: 0 };
  }

  let isFile = false;
  try {
    const s = await stat(searchDir);
    isFile = s.isFile();
  } catch {
    return { matches: [], totalMatches: 0 };
  }

  let files: string[];
  if (isFile) {
    files = [searchDir];
  } else {
    try {
      files = await fg(globPattern ?? '**/*', {
        cwd: searchDir,
        absolute: true,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
        onlyFiles: true,
        followSymbolicLinks: false,
      });
    } catch {
      return { matches: [], totalMatches: 0 };
    }
  }

  const matches: GrepMatch[] = [];
  let totalMatches = 0;

  for (const filePath of files) {
    if (matches.length >= maxResults) break;
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (!regex.test(lines[i])) continue;
      totalMatches++;
      if (matches.length >= maxResults) continue;

      const relativePath = filePath.startsWith(workDir)
        ? filePath.slice(workDir.length + 1)
        : filePath;

      const match: GrepMatch = { file: relativePath, line: i + 1, content: lines[i] };
      if (contextLines > 0) {
        match.contextBefore = lines.slice(Math.max(0, i - contextLines), i);
        match.contextAfter = lines.slice(i + 1, Math.min(lines.length, i + 1 + contextLines));
      }
      matches.push(match);
    }
  }

  return { matches, totalMatches };
}

// ─── check rg availability (cached) ─────────────────────────────────────────

let rgAvailable: boolean | null = null;

async function hasRipgrep(): Promise<boolean> {
  if (rgAvailable !== null) return rgAvailable;
  return new Promise((res) => {
    execFile('rg', ['--version'], (err) => {
      rgAvailable = !err;
      res(rgAvailable);
    });
  });
}

// ─── Tool ────────────────────────────────────────────────────────────────────

export class GrepTool extends BaseTool {
  readonly name = 'grep';
  readonly description =
    'Search file contents using a regex pattern (powered by ripgrep). ' +
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
      ABSOLUTE_MAX_RESULTS,
    );
    const contextLines = (args.context as number) ?? DEFAULT_CONTEXT;

    if (!pattern) {
      return this.fail(toolCallId, 'Missing required parameter: pattern');
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

    // Try ripgrep first, fallback to Node.js
    let matches: GrepMatch[];
    let totalMatches: number;

    const useRg = await hasRipgrep();
    if (useRg) {
      const result = await runRipgrep(pattern, searchDir, globPattern, maxResults, contextLines);
      if (result.error) {
        return this.fail(toolCallId, `ripgrep error: ${result.error}`);
      }
      matches = result.matches;
      totalMatches = result.totalMatches;
    } else {
      const result = await searchNodeFallback(pattern, searchDir, globPattern, maxResults, contextLines, workDir);
      matches = result.matches;
      totalMatches = result.totalMatches;
    }

    if (matches.length === 0) {
      return this.ok(toolCallId, `No matches found for pattern: ${pattern}`, { totalMatches: 0 });
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
      outputLines.push(`${m.file}:${m.line}: ${m.content}`);
      if (m.contextAfter && m.contextAfter.length > 0) {
        for (let j = 0; j < m.contextAfter.length; j++) {
          outputLines.push(`  ${m.file}:${m.line + j + 1}: ${m.contextAfter[j]}`);
        }
      }
    }

    let output = outputLines.join('\n');
    if (truncated) {
      output += `\n\n... (showing ${maxResults} of ${totalMatches} total matches)`;
    }
    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT) + `\n...[truncated]`;
    }

    return this.ok(toolCallId, output, {
      totalMatches,
      matchesReturned: matches.length,
      truncated,
      engine: useRg ? 'ripgrep' : 'node',
    });
  }
}
