/**
 * @module autonomous/research-agent
 * @description Research Agent — combines MCP web search + repo search + docs fetch,
 * ranks sources, and emits a structured research_result event.
 *
 * Design:
 * - Does NOT call the LLM directly (keeps the main loop deterministic)
 * - Orchestrates: MCP search tools + local repo grep/glob via ToolExecutor
 * - Scoring: naive TF-IDF relevance ranking over snippets
 * - Output: agent:research_result event + ResearchResult object
 *
 * Constraints:
 * - All outputs emit events (observable)
 * - Integrates with TraceRecorder via event emission
 * - Goes through OverheadGovernor (caller must check shouldRunResearch())
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { ToolExecutor, AgentEvent } from "../types.js";
import { BOUNDS, truncate } from "../safe-bounds.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ResearchSource {
  title: string;
  url: string;
  snippet: string;
  /** "web" | "repo" | "docs" | "mcp:<server-name>" */
  source: string;
  /** 0.0–1.0 relevance score */
  relevance: number;
}

export interface ResearchResult {
  taskId: string;
  query: string;
  summary: string;
  sources: ResearchSource[];
  /** 0.0–1.0 confidence based on source count + relevance distribution */
  confidence: number;
  timestamp: number;
}

export interface ResearchAgentConfig {
  /** Max number of MCP search results to collect */
  maxMcpResults?: number;
  /** Max number of repo grep results to collect */
  maxRepoResults?: number;
  /** Project root for local repo search */
  projectPath?: string;
  /** MCP tool names that perform web search (prefix match) */
  mcpSearchTools?: string[];
}

// ─── ResearchAgent ────────────────────────────────────────────────────────────

export class ResearchAgent extends EventEmitter {
  private readonly config: Required<ResearchAgentConfig>;

  constructor(
    private readonly toolExecutor: ToolExecutor,
    config: ResearchAgentConfig = {},
  ) {
    super();
    this.config = {
      maxMcpResults: config.maxMcpResults ?? 10,
      maxRepoResults: config.maxRepoResults ?? 20,
      projectPath: config.projectPath ?? process.cwd(),
      mcpSearchTools: config.mcpSearchTools ?? [
        "brave_search", "spider_search", "fetch_fetch",
        "github_search_code", "github_search_repositories",
        "search", "web_search",
      ],
    };
  }

  /**
   * Run research for a query. Returns structured ResearchResult.
   * Emits agent:research_result when complete.
   */
  async research(query: string, taskId?: string): Promise<ResearchResult> {
    const resolvedTaskId = taskId ?? randomUUID();
    const timestamp = Date.now();
    const sources: ResearchSource[] = [];

    // 1. Repo search — grep for query terms in project
    const repoResults = await this.searchRepo(query);
    sources.push(...repoResults);

    // 2. MCP web/docs search (best-effort — fails gracefully)
    const mcpResults = await this.searchMcp(query);
    sources.push(...mcpResults);

    // 3. Rank by relevance
    const ranked = this.rankSources(query, sources)
      .slice(0, this.config.maxMcpResults + this.config.maxRepoResults);

    // 4. Build summary from top sources
    const summary = this.buildSummary(query, ranked);

    // 5. Compute confidence
    const confidence = this.computeConfidence(ranked);

    const result: ResearchResult = {
      taskId: resolvedTaskId,
      query,
      summary,
      sources: ranked,
      confidence,
      timestamp,
    };

    this.emitResult(result);
    return result;
  }

  // ─── private ───────────────────────────────────────────────────────────────

  private async searchRepo(query: string): Promise<ResearchSource[]> {
    const results: ResearchSource[] = [];
    // Extract meaningful terms (strip common words)
    const terms = query.split(/\s+/)
      .filter(t => t.length > 3 && !/^(the|and|for|with|that|this|from|into|when|where)$/i.test(t))
      .slice(0, 4);
    if (terms.length === 0) return results;

    const pattern = terms.join("|");
    try {
      const grepResult = await this.toolExecutor.execute({
        id: `research-grep-${Date.now()}`,
        name: "grep",
        arguments: JSON.stringify({
          pattern,
          path: this.config.projectPath,
          recursive: true,
          maxResults: this.config.maxRepoResults,
          include: "*.ts,*.tsx,*.js,*.jsx,*.md",
        }),
      });

      if (grepResult.success && grepResult.output) {
        const lines = grepResult.output.split("\n").filter(Boolean).slice(0, this.config.maxRepoResults);
        for (const line of lines) {
          const colonIdx = line.indexOf(":");
          if (colonIdx === -1) continue;
          const filePath = line.slice(0, colonIdx);
          const snippet = truncate(line.slice(colonIdx + 1).trim(), 200);
          results.push({
            title: filePath,
            url: `file://${filePath}`,
            snippet,
            source: "repo",
            relevance: 0, // will be scored later
          });
        }
      }
    } catch { /* non-fatal */ }

    return results;
  }

  private async searchMcp(query: string): Promise<ResearchSource[]> {
    const results: ResearchSource[] = [];
    // Try each MCP search tool — stop at first successful one
    for (const toolName of this.config.mcpSearchTools) {
      try {
        const mcpResult = await this.toolExecutor.execute({
          id: `research-mcp-${toolName}-${Date.now()}`,
          name: toolName,
          arguments: JSON.stringify({ query, q: query, search: query }),
        });
        if (!mcpResult.success || !mcpResult.output) continue;

        // Parse result — may be JSON array or plain text
        const parsed = this.parseMcpSearchOutput(mcpResult.output, toolName);
        results.push(...parsed.slice(0, this.config.maxMcpResults));
        if (results.length > 0) break; // first working tool is enough
      } catch { /* non-fatal — tool may not be loaded */ }
    }
    return results;
  }

  private parseMcpSearchOutput(output: string, toolName: string): ResearchSource[] {
    // Try JSON array first (structured MCP output)
    try {
      const parsed = JSON.parse(output) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.slice(0, 10).map((item: Record<string, unknown>) => ({
          title: String(item["title"] ?? item["name"] ?? ""),
          url: String(item["url"] ?? item["link"] ?? ""),
          snippet: truncate(String(item["snippet"] ?? item["description"] ?? item["body"] ?? ""), 300),
          source: `mcp:${toolName}`,
          relevance: 0,
        }));
      }
    } catch { /* not JSON */ }

    // Fallback: plain text, each non-empty line is a snippet
    const lines = output.split("\n").filter(l => l.trim().length > 20).slice(0, 5);
    return lines.map((line, i) => ({
      title: `Result ${i + 1}`,
      url: "",
      snippet: truncate(line, 300),
      source: `mcp:${toolName}`,
      relevance: 0,
    }));
  }

  private rankSources(query: string, sources: ResearchSource[]): ResearchSource[] {
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    return sources
      .map(s => ({
        ...s,
        relevance: this.scoreRelevance(
          `${s.title} ${s.snippet}`.toLowerCase(),
          queryTerms,
        ),
      }))
      .sort((a, b) => b.relevance - a.relevance);
  }

  /** Naive TF-IDF-like scoring: count query term hits / total terms */
  private scoreRelevance(text: string, queryTerms: string[]): number {
    if (queryTerms.length === 0) return 0.5;
    const hits = queryTerms.filter(t => text.includes(t)).length;
    return hits / queryTerms.length;
  }

  private buildSummary(query: string, sources: ResearchSource[]): string {
    if (sources.length === 0) {
      return `No sources found for: "${query}"`;
    }
    const repoCount = sources.filter(s => s.source === "repo").length;
    const webCount = sources.filter(s => s.source.startsWith("mcp:")).length;
    const top3 = sources.slice(0, 3)
      .map(s => `- ${s.title}: ${s.snippet.slice(0, 100)}`)
      .join("\n");
    return [
      `Research for: "${query}"`,
      `Found ${sources.length} sources (${repoCount} repo, ${webCount} web).`,
      `Top results:\n${top3}`,
    ].join("\n");
  }

  private computeConfidence(sources: ResearchSource[]): number {
    if (sources.length === 0) return 0;
    const avgRelevance = sources.reduce((s, r) => s + r.relevance, 0) / sources.length;
    const coverageFactor = Math.min(sources.length / 5, 1.0); // 5 sources = max coverage
    return Math.round(avgRelevance * coverageFactor * 100) / 100;
  }

  private emitResult(result: ResearchResult): void {
    const event: AgentEvent = {
      kind: "agent:research_result",
      taskId: result.taskId,
      summary: truncate(result.summary, BOUNDS.toolResultPersistence),
      sources: result.sources.slice(0, 20), // cap at 20 sources in event payload
      confidence: result.confidence,
      timestamp: result.timestamp,
    };
    this.emit("event", event);
  }
}
