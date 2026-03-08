/**
 * @yuan/mcp-server — Tools Adapter
 *
 * Converts @yuan/tools ToolRegistry tools into MCP tool registrations.
 *
 * MCP tool schema:
 * - name: string
 * - description: string
 * - inputSchema: JSON Schema (type: "object", properties: {...}, required: [...])
 *
 * MCP tool handler:
 * - input: { arguments: Record<string, unknown> }
 * - output: { content: [{ type: "text", text: string }] }
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolRegistry } from "@yuan/tools";
import { z } from "zod";

/**
 * Convert a JSON Schema property type to a Zod schema.
 * MCP SDK uses Zod for input validation.
 */
function jsonSchemaPropertyToZod(prop: Record<string, unknown>): z.ZodTypeAny {
  const type = prop.type as string;
  const enumValues = prop.enum as string[] | undefined;

  switch (type) {
    case "string":
      if (enumValues && enumValues.length > 0) {
        // Zod enum requires at least one value
        return z.enum(enumValues as [string, ...string[]]);
      }
      return z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array": {
      const items = prop.items as Record<string, unknown> | undefined;
      if (items) {
        return z.array(jsonSchemaPropertyToZod(items));
      }
      return z.array(z.unknown());
    }
    case "object":
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}

/**
 * Convert a tool's JSON Schema parameters into a Zod shape for MCP registration.
 */
function buildZodShape(
  properties: Record<string, unknown>,
  required: string[] | undefined
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const requiredSet = new Set(required ?? []);

  for (const [key, propDef] of Object.entries(properties)) {
    const prop = propDef as Record<string, unknown>;
    let schema = jsonSchemaPropertyToZod(prop);

    // Add description
    const description = prop.description as string | undefined;
    if (description) {
      schema = schema.describe(description);
    }

    // Make optional if not required
    if (!requiredSet.has(key)) {
      schema = schema.optional();
    }

    shape[key] = schema;
  }

  return shape;
}

/**
 * Register all tools from a ToolRegistry onto an MCP server.
 *
 * @param server - McpServer instance
 * @param registry - YUAN ToolRegistry with all tools loaded
 * @param workDir - Working directory for tool execution
 */
export function registerToolsOnServer(
  server: McpServer,
  registry: ToolRegistry,
  workDir: string
): void {
  const definitions = registry.toDefinitions();

  for (const def of definitions) {
    const properties = (def.parameters.properties ?? {}) as Record<string, unknown>;
    const required = def.parameters.required as string[] | undefined;
    const zodShape = buildZodShape(properties, required);

    server.tool(
      def.name,
      def.description,
      zodShape,
      async (args: Record<string, unknown>) => {
        const toolCallId = `mcp-${def.name}-${Date.now()}`;
        const argsWithId = { ...args, _toolCallId: toolCallId };

        const result = await registry.execute(def.name, argsWithId, workDir);

        return {
          content: [
            {
              type: "text" as const,
              text: result.output,
            },
          ],
          isError: !result.success,
        };
      }
    );
  }
}
