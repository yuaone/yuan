/**
 * @module mcp-config-loader
 * @description Loads MCP server configurations from ~/.yuan/mcp.json.
 *
 * Allows users to configure external MCP servers (GitHub, Postgres, Slack, etc.)
 * that YUAN will auto-connect to on startup — similar to how Claude Code reads
 * ~/.claude/mcp.json.
 *
 * Returns null gracefully if the file does not exist. Most users won't have it.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MCPClientConfig, MCPServerConfig } from "./mcp-client.js";

/** Default path for the MCP config file */
export const MCP_CONFIG_PATH = join(homedir(), ".yuan", "mcp.json");

/**
 * Raw shape of ~/.yuan/mcp.json as written by the user.
 * Looser than MCPClientConfig — only `servers` is required.
 */
interface RawMCPConfig {
  servers: Array<{
    name: string;
    transport?: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    timeout?: number;
    retryOnCrash?: boolean;
  }>;
  toolPrefix?: boolean;
  maxConcurrentCalls?: number;
}

/**
 * Load MCP server configurations from ~/.yuan/mcp.json.
 *
 * @returns Parsed MCPClientConfig, or null if the file does not exist.
 * @throws {Error} If the file exists but contains invalid JSON or invalid structure.
 *
 * @example
 * ```ts
 * const config = await loadMCPConfig();
 * if (config && config.servers.length > 0) {
 *   const client = new MCPClient(config);
 *   await client.connectAll();
 * }
 * ```
 */
export async function loadMCPConfig(): Promise<MCPClientConfig | null> {
  let raw: string;

  try {
    raw = await readFile(MCP_CONFIG_PATH, "utf-8");
  } catch (err) {
    // ENOENT → file doesn't exist, this is the normal case
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    // Permission error or other FS issue — re-throw so the caller can log it
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`~/.yuan/mcp.json is not valid JSON`);
  }

  if (typeof parsed !== "object" || parsed === null || !("servers" in parsed)) {
    throw new Error(`~/.yuan/mcp.json must have a "servers" array`);
  }

  const rawConfig = parsed as RawMCPConfig;

  if (!Array.isArray(rawConfig.servers)) {
    throw new Error(`~/.yuan/mcp.json "servers" must be an array`);
  }

  const servers: MCPServerConfig[] = rawConfig.servers.map((s, i) => {
    if (!s.name || typeof s.name !== "string") {
      throw new Error(`~/.yuan/mcp.json servers[${i}] must have a "name" string`);
    }
    if (!s.command || typeof s.command !== "string") {
      throw new Error(`~/.yuan/mcp.json servers[${i}] ("${s.name}") must have a "command" string`);
    }

    return {
      name: s.name,
      transport: "stdio" as const, // only stdio is supported
      command: s.command,
      args: Array.isArray(s.args) ? s.args : [],
      env: s.env,
      timeout: s.timeout,
      retryOnCrash: s.retryOnCrash,
    };
  });

  return {
    servers,
    autoConnect: true,
    toolPrefix: rawConfig.toolPrefix !== false, // default true
    maxConcurrentCalls: rawConfig.maxConcurrentCalls ?? 5,
  };
}
