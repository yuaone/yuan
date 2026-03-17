/**
 * @yuaone/tools — parallel_web_search tool
 *
 * Runs multiple web searches in parallel (up to 5 queries simultaneously).
 * Delegates each query to WebSearchTool, which uses:
 *   1. Gemini native Google Search (if configured)
 *   2. DuckDuckGo HTML fallback
 *   3. SearX fallback
 */

import type { ParameterDef, RiskLevel, ToolResult } from './types.js';
import { BaseTool } from './base-tool.js';
import { WebSearchTool, type GeminiSearchConfig } from './web-search.js';

const MAX_PARALLEL_QUERIES = 5;

export class ParallelWebSearchTool extends BaseTool {
  readonly name = 'parallel_web_search';
  readonly description =
    'Search the web for multiple queries in parallel. Returns combined results. Use when you need to research several different topics or compare sources simultaneously.';
  readonly riskLevel: RiskLevel = 'low';

  readonly parameters: Record<string, ParameterDef> = {
    queries: {
      type: 'array',
      description: `List of search queries to run in parallel (max ${MAX_PARALLEL_QUERIES})`,
      required: true,
      items: { type: 'string', description: 'A search query' },
    },
  };

  private readonly searcher: WebSearchTool;

  constructor(geminiConfig?: GeminiSearchConfig) {
    super();
    this.searcher = new WebSearchTool(geminiConfig);
  }

  async execute(
    args: Record<string, unknown>,
    workDir: string,
    abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    const toolCallId = (args._toolCallId as string) ?? '';
    const rawQueries = args.queries;

    if (!Array.isArray(rawQueries) || rawQueries.length === 0) {
      return this.fail(toolCallId, 'queries must be a non-empty array of strings');
    }

    const queries = (rawQueries as unknown[])
      .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
      .slice(0, MAX_PARALLEL_QUERIES);

    if (queries.length === 0) {
      return this.fail(toolCallId, 'queries array must contain at least one non-empty string');
    }

    // Run all searches in parallel
    const settled = await Promise.allSettled(
      queries.map((q) =>
        this.searcher.searchQuery(toolCallId, q, abortSignal),
      ),
    );

    const lines: string[] = [
      `Parallel search — ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}\n`,
    ];

    for (let i = 0; i < settled.length; i++) {
      lines.push(`${'─'.repeat(60)}`);
      lines.push(`Query ${i + 1}: "${queries[i]}"`);
      lines.push('');

      const r = settled[i];
      if (r.status === 'fulfilled') {
        lines.push(r.value.output);
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        lines.push(`Error: ${msg}`);
      }
      lines.push('');
    }

    return this.ok(toolCallId, lines.join('\n'));
  }
}
