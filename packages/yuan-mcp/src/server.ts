#!/usr/bin/env node
/**
 * YUAN MCP Server
 *
 * stdio-based MCP server that exposes YUAN's 9 coding tools to external
 * AI agents (Claude Code, etc.) via the Model Context Protocol.
 *
 * Usage:
 * 1. Add to claude_desktop_config.json:
 *    { "mcpServers": { "yuan": { "command": "npx", "args": ["@yuan/mcp-server"] } } }
 * 2. Or in Claude Code: /mcp add yuan npx @yuan/mcp-server
 * 3. Or directly: yuan-mcp [--workdir /path/to/project]
 *
 * Environment variables:
 * - YUAN_WORK_DIR: Override the working directory (default: cwd)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDefaultRegistry } from "@yuan/tools";
import { registerToolsOnServer } from "./tools-adapter.js";
import { registerResources } from "./resources.js";

/**
 * Parse CLI arguments for --workdir flag.
 */
function parseArgs(): { workDir: string } {
  const args = process.argv.slice(2);
  let workDir = process.env["YUAN_WORK_DIR"] ?? process.cwd();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--workdir" && args[i + 1]) {
      workDir = args[i + 1];
      i++; // skip next
    }
  }

  return { workDir };
}

async function main(): Promise<void> {
  const { workDir } = parseArgs();

  // Create MCP server
  const server = new McpServer({
    name: "yuan",
    version: "0.1.0",
  });

  // Create YUAN tool registry with all 9 built-in tools
  const registry = createDefaultRegistry();

  // Register all YUAN tools as MCP tools
  registerToolsOnServer(server, registry, workDir);

  // Register MCP resources (memory, tools listing, project info)
  registerResources(server, registry, workDir);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is used by MCP protocol)
  process.stderr.write(
    `YUAN MCP Server started — ${registry.size} tools registered, workDir: ${workDir}\n`
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`YUAN MCP Server fatal error: ${String(err)}\n`);
  process.exit(1);
});
