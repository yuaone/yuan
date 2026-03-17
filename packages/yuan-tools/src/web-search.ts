/**
 * @yuaone/tools — web_search tool
 *
 * Searches the web or fetches a URL and returns readable text.
 * - search: Gemini google_search grounding (if geminiConfig provided), else DDG HTML, else SearX
 * - fetch: Node.js built-in fetch, strips HTML, 50 000 char limit
 */

import type { ParameterDef, RiskLevel, ToolResult } from './types.js';
import { BaseTool } from './base-tool.js';

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_CHARS = 50_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; yuan-agent/1.0; +https://github.com/yuaone/yuan)';
const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';
const SEARX_URL = 'https://searx.be/search?q={query}&format=json';

/** Optional Gemini backend — uses native Google Search grounding (no API key needed beyond the Gemini key) */
export interface GeminiSearchConfig {
  apiKey: string;
  /** gemini-2.0-flash or gemini-2.5-pro recommended */
  model: string;
}

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

// ─── Gemini response types (partial) ─────────────────────────────────

interface GeminiGroundingChunk {
  web?: { uri?: string; title?: string };
}

interface GeminiGroundingSupport {
  segment?: { text?: string; startIndex?: number; endIndex?: number };
  groundingChunkIndices?: number[];
}

interface GeminiGroundingMetadata {
  webSearchQueries?: string[];
  groundingChunks?: GeminiGroundingChunk[];
  groundingSupports?: GeminiGroundingSupport[];
}

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }>; role?: string };
  groundingMetadata?: GeminiGroundingMetadata;
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
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

  constructor(private readonly geminiConfig?: GeminiSearchConfig) {
    super();
  }

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

  /** Exposed for parallel_web_search to reuse */
  async searchQuery(
    toolCallId: string,
    query: string,
    abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    return this.runSearch(toolCallId, query, abortSignal);
  }

  private async runSearch(
    toolCallId: string,
    query: string,
    abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    // 1. Gemini native Google Search (best quality — uses Google's index)
    if (this.geminiConfig) {
      try {
        const geminiResult = await this.geminiSearch(query, this.geminiConfig);
        if (geminiResult.items.length > 0) {
          return this.ok(toolCallId, this.formatResults(geminiResult.items, query, 'Google'));
        }
        // Gemini returned a text answer (no grounding chunks) — still useful
        if (geminiResult.textAnswer) {
          return this.ok(toolCallId, `Search results for: ${query} (via Gemini)\n\n${geminiResult.textAnswer}`);
        }
      } catch (err) {
        // Log and fall through to DDG
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[web-search] Gemini search error (falling back to DDG): ${msg}\n`);
      }
    }

    // 2. Try DuckDuckGo HTML (real web results)
    try {
      const results = await this.duckDuckGoHtml(query, abortSignal);
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

  private async geminiSearch(
    query: string,
    config: GeminiSearchConfig,
  ): Promise<{ items: Array<{ title: string; url: string; snippet: string }>; textAnswer: string | null }> {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: query }] }],
          tools: [{ google_search: {} }],
          generationConfig: { maxOutputTokens: 2048 },
        }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Gemini search HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    const data = (await resp.json()) as GeminiResponse;

    const candidate = data?.candidates?.[0];

    // Extract the text answer Gemini generated (always present when grounding runs)
    const textAnswer = candidate?.content?.parts
      ?.map((p) => p.text ?? '')
      .join('')
      .trim() || null;

    const meta = candidate?.groundingMetadata;
    if (!meta?.groundingChunks?.length) {
      return { items: [], textAnswer };
    }

    const items: Array<{ title: string; url: string; snippet: string }> = [];

    for (let i = 0; i < meta.groundingChunks.length; i++) {
      const chunk = meta.groundingChunks[i];
      if (!chunk?.web) continue;

      // Find snippet from groundingSupports that references this chunk
      const support = meta.groundingSupports?.find(
        (s) => s.groundingChunkIndices?.includes(i),
      );
      const snippet = support?.segment?.text ?? '';

      items.push({
        title: chunk.web.title ?? chunk.web.uri ?? '',
        url: chunk.web.uri ?? '',
        snippet,
      });
      if (items.length >= 5) break;
    }

    return { items, textAnswer };
  }

  private async duckDuckGoHtml(
    query: string,
    _abortSignal?: AbortSignal,
  ): Promise<Array<{ title: string; url: string; snippet: string }>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(DDG_HTML_URL, {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'text/html,application/xhtml+xml',
        },
        body: `q=${encodeURIComponent(query)}&b=&kl=us-en`,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) throw new Error(`DuckDuckGo HTTP ${resp.status}`);
    const html = await resp.text();

    const items: Array<{ title: string; url: string; snippet: string }> = [];

    // Extract result links: <a class="result__a" href="/l/?uddg=...">Title</a>
    const linkPattern = /class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    // Extract snippets: <a class="result__snippet"...>...</a>
    const snippetPattern = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    const links = [...html.matchAll(linkPattern)];
    const snippets = [...html.matchAll(snippetPattern)];

    for (let i = 0; i < Math.min(links.length, 8); i++) {
      const [, rawHref, rawTitle] = links[i];
      const rawSnippet = snippets[i]?.[1] ?? '';

      // DDG wraps URLs: /l/?uddg=<encoded> or /l/?kh=-1&uddg=<encoded>
      let url = rawHref;
      const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
      if (uddgMatch) {
        try { url = decodeURIComponent(uddgMatch[1]); } catch { /* keep raw */ }
      }

      // Skip DDG internal URLs
      if (url.startsWith('/') && !uddgMatch) continue;

      const title = stripHtml(rawTitle).trim();
      const snippet = stripHtml(rawSnippet).trim();
      if (!title && !snippet) continue;

      items.push({ title: title || url, url, snippet });
      if (items.length >= 5) break;
    }

    return items;
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
