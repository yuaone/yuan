/**
 * @yuan/mcp-server — MCP Resources
 *
 * Exposes YUAN project resources via MCP:
 * - yuan://memory   — YUAN.md contents (project memory)
 * - yuan://project  — Project structure tree
 * - yuan://tools    — Available tools listing
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolRegistry } from "@yuaone/tools";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Register MCP resources on the server.
 *
 * @param server - McpServer instance
 * @param registry - ToolRegistry for tools listing
 * @param workDir - Project working directory
 */
export function registerResources(
  server: McpServer,
  registry: ToolRegistry,
  workDir: string
): void {
  // Resource: YUAN.md project memory
  server.resource(
    "memory",
    "yuan://memory",
    { description: "YUAN.md project memory file contents", mimeType: "text/markdown" },
    async () => {
      const candidates = [
        join(workDir, "YUAN.md"),
        join(workDir, "yuan.md"),
        join(workDir, "CLAUDE.md"),
      ];

      let content = "No YUAN.md or CLAUDE.md found in project root.";
      for (const candidate of candidates) {
        try {
          content = await readFile(candidate, "utf-8");
          break;
        } catch {
          // Try next candidate
        }
      }

      return {
        contents: [
          {
            uri: "yuan://memory",
            mimeType: "text/markdown",
            text: content,
          },
        ],
      };
    }
  );

  // Resource: Available tools listing
  server.resource(
    "tools",
    "yuan://tools",
    { description: "List of all available YUAN tools with descriptions", mimeType: "text/plain" },
    async () => {
      const defs = registry.toDefinitions();
      const lines = defs.map((d) => {
        const params = Object.keys(
          (d.parameters.properties ?? {}) as Record<string, unknown>
        ).join(", ");
        return `- ${d.name}(${params}): ${d.description}`;
      });

      return {
        contents: [
          {
            uri: "yuan://tools",
            mimeType: "text/plain",
            text: `YUAN Tools (${defs.length} available):\n\n${lines.join("\n")}`,
          },
        ],
      };
    }
  );

  // Resource: Project info
  server.resource(
    "project",
    "yuan://project",
    { description: "Current project working directory info", mimeType: "text/plain" },
    async () => {
      return {
        contents: [
          {
            uri: "yuan://project",
            mimeType: "text/plain",
            text: `YUAN MCP Server\nWorking directory: ${workDir}\nTools loaded: ${registry.size}`,
          },
        ],
      };
    }
  );
}
