/**
 * @yuan/tools — code_search tool
 *
 * Phase 1: Symbol-based code search using regex patterns.
 * (Embedding-based semantic search planned for Phase 2)
 *
 * Search modes:
 * 1. symbol: Find function/class/variable/type/interface definitions by name
 * 2. reference: Find usages of a specific symbol
 * 3. definition: Find where a symbol is defined
 *
 * Supports: TypeScript, JavaScript, Python
 * Excludes: node_modules, dist, .git, build, coverage, __pycache__
 *
 * riskLevel: 'low' (read-only)
 */

import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import fg from 'fast-glob';
import type { ParameterDef, RiskLevel, ToolResult } from './types.js';
import { BaseTool } from './base-tool.js';

const MAX_RESULTS = 50;
const MAX_FILE_SIZE = 512_000; // 512KB — skip huge files
const SNIPPET_CONTEXT_LINES = 3;

/** Language-specific definition patterns. */
const DEFINITION_PATTERNS: Record<string, (name: string) => RegExp[]> = {
  typescript: (name) => [
    new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegex(name)}\\s*[(<]`, 'gm'),
    new RegExp(`(?:export\\s+)?class\\s+${escapeRegex(name)}\\s*[{<]`, 'gm'),
    new RegExp(`(?:export\\s+)?interface\\s+${escapeRegex(name)}\\s*[{<]`, 'gm'),
    new RegExp(`(?:export\\s+)?type\\s+${escapeRegex(name)}\\s*[=<]`, 'gm'),
    new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${escapeRegex(name)}\\s*[=:]`, 'gm'),
    new RegExp(`(?:export\\s+)?enum\\s+${escapeRegex(name)}\\s*\\{`, 'gm'),
    // Method definitions
    new RegExp(`^\\s*(?:async\\s+)?${escapeRegex(name)}\\s*\\(`, 'gm'),
  ],
  javascript: (name) => [
    new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegex(name)}\\s*[(<]`, 'gm'),
    new RegExp(`(?:export\\s+)?class\\s+${escapeRegex(name)}\\s*[{<]`, 'gm'),
    new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${escapeRegex(name)}\\s*[=:]`, 'gm'),
    new RegExp(`^\\s*(?:async\\s+)?${escapeRegex(name)}\\s*\\(`, 'gm'),
  ],
  python: (name) => [
    new RegExp(`^\\s*def\\s+${escapeRegex(name)}\\s*\\(`, 'gm'),
    new RegExp(`^\\s*class\\s+${escapeRegex(name)}\\s*[:(]`, 'gm'),
    new RegExp(`^${escapeRegex(name)}\\s*=`, 'gm'),
  ],
};

/** Map file extensions to language keys. */
const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python',
};

/** File globs per language. */
const LANG_GLOBS: Record<string, string[]> = {
  typescript: ['**/*.ts', '**/*.tsx'],
  javascript: ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
  python: ['**/*.py'],
};

const IGNORE_DIRS = [
  '**/node_modules/**', '**/dist/**', '**/.git/**', '**/build/**',
  '**/coverage/**', '**/__pycache__/**', '**/.next/**', '**/.nuxt/**',
  '**/vendor/**', '**/.venv/**', '**/venv/**',
];

interface SearchResult {
  file: string;
  line: number;
  column: number;
  content: string;
  kind: string;
}

export class CodeSearchTool extends BaseTool {
  readonly name = 'code_search';
  readonly description =
    'Search for code symbols (functions, classes, types, variables) by name. ' +
    'Modes: symbol (definitions), reference (usages), definition (where defined). ' +
    'Supports TypeScript, JavaScript, Python.';
  readonly riskLevel: RiskLevel = 'low';

  readonly parameters: Record<string, ParameterDef> = {
    query: {
      type: 'string',
      description: 'Symbol name or pattern to search for',
      required: true,
    },
    mode: {
      type: 'string',
      description: 'Search mode: symbol (find definitions), reference (find usages), definition (find where defined)',
      required: false,
      enum: ['symbol', 'reference', 'definition'],
      default: 'symbol',
    },
    path: {
      type: 'string',
      description: 'Search scope directory (relative to project root, default: entire project)',
      required: false,
    },
    language: {
      type: 'string',
      description: 'Language filter: typescript, javascript, python (default: all supported)',
      required: false,
      enum: ['typescript', 'javascript', 'python'],
    },
    maxResults: {
      type: 'number',
      description: 'Maximum results to return (default: 20)',
      required: false,
      default: 20,
    },
  };

  async execute(args: Record<string, unknown>, workDir: string): Promise<ToolResult> {
    const toolCallId = (args._toolCallId as string) ?? '';
    const query = args.query as string | undefined;
    const mode = (args.mode as string) ?? 'symbol';
    const searchPath = args.path as string | undefined;
    const language = args.language as string | undefined;
    const maxResults = Math.min((args.maxResults as number) ?? 20, MAX_RESULTS);

    if (!query) {
      return this.fail(toolCallId, 'Missing required parameter: query');
    }

    // Validate path if provided
    let searchDir = workDir;
    if (searchPath) {
      try {
        searchDir = this.validatePath(searchPath, workDir);
      } catch (err) {
        return this.fail(toolCallId, (err as Error).message);
      }
    }

    try {
      // Collect file globs
      let globs: string[];
      if (language && LANG_GLOBS[language]) {
        globs = LANG_GLOBS[language];
      } else {
        globs = Object.values(LANG_GLOBS).flat();
      }

      // Find files
      const files = await fg(globs, {
        cwd: searchDir,
        ignore: IGNORE_DIRS,
        absolute: true,
        onlyFiles: true,
        followSymbolicLinks: false,
      });

      // Search files
      const results: SearchResult[] = [];

      for (const filePath of files) {
        if (results.length >= maxResults) break;

        try {
          const content = await readFile(filePath, 'utf-8');
          if (content.length > MAX_FILE_SIZE) continue;

          const relPath = relative(workDir, filePath);
          const ext = filePath.match(/\.[^.]+$/)?.[0] ?? '';
          const lang = EXT_TO_LANG[ext];
          if (!lang) continue;

          const fileResults = this.searchFile(content, relPath, lang, query, mode);
          for (const r of fileResults) {
            if (results.length >= maxResults) break;
            results.push(r);
          }
        } catch {
          // Skip unreadable files
        }
      }

      // Format output
      const output = this.formatResults(results, query, mode);
      return this.ok(toolCallId, output);
    } catch (err) {
      return this.fail(toolCallId, `Code search failed: ${(err as Error).message}`);
    }
  }

  /**
   * Search a single file for matching symbols.
   */
  private searchFile(
    content: string,
    relPath: string,
    lang: string,
    query: string,
    mode: string
  ): SearchResult[] {
    const lines = content.split('\n');
    const results: SearchResult[] = [];

    if (mode === 'symbol' || mode === 'definition') {
      // Find definitions of the symbol
      const patterns = DEFINITION_PATTERNS[lang]?.(query) ?? DEFINITION_PATTERNS.typescript(query);

      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const lineNumber = content.slice(0, match.index).split('\n').length;
          const lineContent = lines[lineNumber - 1]?.trim() ?? '';
          const kind = this.inferKind(lineContent, lang);
          const column = match.index - content.lastIndexOf('\n', match.index - 1);

          results.push({
            file: relPath,
            line: lineNumber,
            column,
            content: this.getSnippet(lines, lineNumber),
            kind,
          });
        }
      }
    } else if (mode === 'reference') {
      // Find all usages of the symbol (excluding definitions for cleaner results)
      const refPattern = new RegExp(`\\b${escapeRegex(query)}\\b`, 'g');
      const defPatterns = DEFINITION_PATTERNS[lang]?.(query) ?? DEFINITION_PATTERNS.typescript(query);

      // Collect definition line numbers to exclude
      const defLines = new Set<number>();
      for (const dp of defPatterns) {
        dp.lastIndex = 0;
        let m;
        while ((m = dp.exec(content)) !== null) {
          const ln = content.slice(0, m.index).split('\n').length;
          defLines.add(ln);
        }
      }

      let match;
      while ((match = refPattern.exec(content)) !== null) {
        const lineNumber = content.slice(0, match.index).split('\n').length;
        if (defLines.has(lineNumber)) continue; // Skip definition lines

        const lineContent = lines[lineNumber - 1]?.trim() ?? '';
        const column = match.index - content.lastIndexOf('\n', match.index - 1);

        results.push({
          file: relPath,
          line: lineNumber,
          column,
          content: lineContent,
          kind: 'reference',
        });
      }
    }

    return results;
  }

  /**
   * Infer the kind of symbol from the line content.
   */
  private inferKind(line: string, lang: string): string {
    if (lang === 'python') {
      if (/^\s*def\s/.test(line)) return 'function';
      if (/^\s*class\s/.test(line)) return 'class';
      return 'variable';
    }
    // TypeScript / JavaScript
    if (/\bfunction\b/.test(line)) return 'function';
    if (/\bclass\b/.test(line)) return 'class';
    if (/\binterface\b/.test(line)) return 'interface';
    if (/\btype\b/.test(line)) return 'type';
    if (/\benum\b/.test(line)) return 'enum';
    if (/\bconst\b|\blet\b|\bvar\b/.test(line)) return 'variable';
    if (/\basync\b/.test(line)) return 'function';
    return 'symbol';
  }

  /**
   * Get a snippet with context lines around a match.
   */
  private getSnippet(lines: string[], lineNumber: number): string {
    const start = Math.max(0, lineNumber - 1 - SNIPPET_CONTEXT_LINES);
    const end = Math.min(lines.length, lineNumber + SNIPPET_CONTEXT_LINES);
    return lines
      .slice(start, end)
      .map((l, i) => {
        const ln = start + i + 1;
        const marker = ln === lineNumber ? '>' : ' ';
        return `${marker} ${ln}: ${l}`;
      })
      .join('\n');
  }

  /**
   * Format results for output.
   */
  private formatResults(results: SearchResult[], query: string, mode: string): string {
    if (results.length === 0) {
      return `No results found for "${query}" (mode: ${mode})`;
    }

    const lines: string[] = [];
    lines.push(`[Code Search: "${query}" — mode: ${mode}]`);
    lines.push(`Found ${results.length} result(s)\n`);

    for (const r of results) {
      lines.push(`--- ${r.file}:${r.line} [${r.kind}] ---`);
      lines.push(r.content);
      lines.push('');
    }

    return lines.join('\n');
  }
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
