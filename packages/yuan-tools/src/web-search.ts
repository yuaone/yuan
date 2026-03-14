/**
 * @yuaone/tools — web_search tool
 *
 * Searches the web or fetches a URL and returns readable text.
 * - search: DuckDuckGo Instant Answer API (no key required), fallback to SearX
 * - fetch: Node.js built-in fetch, strips HTML, 50 000 char limit
 */

import type { ParameterDef, RiskLevel, ToolResult } from './types.js';
import { BaseTool } from './base-tool.js';

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_CHARS = 50_000;
const USER_AGENT = 'yuan-agent/1.0 (+https://github.com/yuaone/yuan)';
const DDG_URL = 'https://api.duckduckgo.com/?q={query}&format=json&no_html=1&skip_disambig=1';
const SEARX_URL = 'https://searx.be/search?q={query}&format=json';

// ─── Helpers ─────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildUrl(template: string, query: string): string {
  return template.replace('{query}', encodeURIComponent(query));
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ─── DuckDuckGo result types (partial) ───────────────────────────────

interface DdgRelatedTopic {
  Text?: string;
  FirstURL?: string;
  Topics?: DdgRelatedTopic[];
}

interface DdgResult {
  Text?: string;
  FirstURL?: string;
}

interface DdgResponse {
  AbstractText?: string;
  AbstractURL?: string;
  RelatedTopics?: DdgRelatedTopic[];
  Results?: DdgResult[];
}

// ─── SearX result types (partial) ────────────────────────────────────

interface SearxResult {
  title?: string;
  content?: string;
  url?: string;
}

interface SearxResponse {
  results?: SearxResult[];
}

// ─── Tool ────────────────────────────────────────────────────────────

export class WebSearchTool extends BaseTool {
  readonly name = 'web_search';
  readonly description =
    'Search the web or fetch a URL. Use for researching libraries, APIs, error messages, or documentation.';
  readonly riskLevel: RiskLevel = 'low';

  readonly parameters: Record<string, ParameterDef> = {
    operation: {
      type: 'string',
      description: '"search" to query the web, "fetch" to retrieve a URL',
      required: true,
      enum: ['search', 'fetch'],
    },
    query: {
      type: 'string',
      description: 'Search query (required when operation is "search")',
      required: false,
    },
    url: {
      type: 'string',
      description: 'URL to fetch (required when operation is "fetch")',
      required: false,
    },
  };

  async execute(
    args: Record<string, unknown>,
    _workDir: string,
    abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    const toolCallId = (args._toolCallId as string) ?? '';
    const operation = args.operation as string | undefined;

    if (!operation) {
      return this.fail(toolCallId, 'Missing required parameter: operation');
    }

    if (operation === 'search') {
      const query = args.query as string | undefined;
      if (!query) {
        return this.fail(toolCallId, 'Missing required parameter: query');
      }
      return this.runSearch(toolCallId, query, abortSignal);
    }

    if (operation === 'fetch') {
      const url = args.url as string | undefined;
      if (!url) {
        return this.fail(toolCallId, 'Missing required parameter: url');
      }
      return this.runFetch(toolCallId, url, abortSignal);
    }

    return this.fail(toolCallId, `Unknown operation: ${operation}. Must be "search" or "fetch".`);
  }

  // ─── search ────────────────────────────────────────────────────────

  private async runSearch(
    toolCallId: string,
    query: string,
    abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    // 1. Try DuckDuckGo
    try {
      const results = await this.duckDuckGo(query, abortSignal);
      if (results.length > 0) {
        return this.ok(toolCallId, this.formatResults(results, query, 'DuckDuckGo'));
      }
    } catch {
      // fall through to SearX
    }

    // 2. Fallback to SearX
    try {
      const results = await this.searx(query, abortSignal);
      if (results.length > 0) {
        return this.ok(toolCallId, this.formatResults(results, query, 'SearX'));
      }
    } catch (err) {
      return this.fail(
        toolCallId,
        `Search failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return this.ok(toolCallId, `No results found for: ${query}`);
  }

  private async duckDuckGo(
    query: string,
    abortSignal?: AbortSignal,
  ): Promise<Array<{ title: string; url: string; snippet: string }>> {
    const url = buildUrl(DDG_URL, query);
    const resp = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    if (!resp.ok) throw new Error(`DuckDuckGo HTTP ${resp.status}`);

    const data = (await resp.json()) as DdgResponse;
    const items: Array<{ title: string; url: string; snippet: string }> = [];

    // Abstract (top answer)
    if (data.AbstractText) {
      items.push({ title: 'Abstract', url: data.AbstractURL ?? '', snippet: data.AbstractText });
    }

    // Instant results
    for (const r of data.Results ?? []) {
      if (r.Text) {
        items.push({ title: r.Text.slice(0, 80), url: r.FirstURL ?? '', snippet: r.Text });
      }
      if (items.length >= 5) break;
    }

    // Related topics
    for (const t of data.RelatedTopics ?? []) {
      if (items.length >= 5) break;
      if (t.Text) {
        items.push({ title: t.Text.slice(0, 80), url: t.FirstURL ?? '', snippet: t.Text });
      }
    }

    return items.slice(0, 5);
  }

  private async searx(
    query: string,
    _abortSignal?: AbortSignal,
  ): Promise<Array<{ title: string; url: string; snippet: string }>> {
    const url = buildUrl(SEARX_URL, query);
    const resp = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    if (!resp.ok) throw new Error(`SearX HTTP ${resp.status}`);

    const data = (await resp.json()) as SearxResponse;
    const items: Array<{ title: string; url: string; snippet: string }> = [];

    for (const r of data.results ?? []) {
      if (items.length >= 5) break;
      items.push({
        title: r.title ?? r.url ?? '',
        url: r.url ?? '',
        snippet: r.content ?? '',
      });
    }

    return items;
  }

  private formatResults(
    results: Array<{ title: string; url: string; snippet: string }>,
    query: string,
    source: string,
  ): string {
    const lines: string[] = [`Search results for: "${query}" (via ${source})\n`];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`${i + 1}. ${r.title}`);
      if (r.url) lines.push(`   URL: ${r.url}`);
      if (r.snippet) lines.push(`   ${r.snippet}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  // ─── fetch ─────────────────────────────────────────────────────────

  private async runFetch(
    toolCallId: string,
    url: string,
    _abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    // Validate URL scheme
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return this.fail(toolCallId, `Invalid URL (must start with http:// or https://): ${url}`);
    }

    let resp: Response;
    try {
      resp = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    } catch (err) {
      return this.fail(
        toolCallId,
        `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!resp.ok) {
      return this.fail(toolCallId, `HTTP ${resp.status} ${resp.statusText} — ${url}`);
    }

    let body: string;
    try {
      body = await resp.text();
    } catch (err) {
      return this.fail(
        toolCallId,
        `Failed to read response body: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const contentType = resp.headers.get('content-type') ?? '';
    if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      body = stripHtml(body);
    }

    if (body.length > FETCH_MAX_CHARS) {
      body = body.slice(0, FETCH_MAX_CHARS) + '\n\n[... output truncated at 50,000 characters]';
    }

    return this.ok(toolCallId, `URL: ${url}\nContent-Type: ${contentType}\n\n${body}`);
  }
}
