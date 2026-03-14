/**
 * @module mcp-client
 * @description MCP (Model Context Protocol) Client Bridge
 *
 * Connects to external MCP servers (GitHub, Postgres, Slack, etc.) via stdio
 * transport, discovers their tools, and invokes them. This extends YUAN's
 * tool ecosystem dynamically at runtime.
 *
 * Protocol: JSON-RPC 2.0 over newline-delimited stdio
 * Spec: https://modelcontextprotocol.io/specification/2024-11-05
 *
 * Pure TypeScript — no @modelcontextprotocol/sdk dependency.
 * Uses only Node.js builtins: child_process, events, readline, crypto.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { ToolDefinition, ToolResult } from "./types.js";

// ─── Types ───

/** Configuration for a single MCP server connection. */
export interface MCPServerConfig {
  /** Unique server name (e.g., "github", "postgres", "slack") */
  name: string;
  /** Transport type — only "stdio" supported currently */
  transport: "stdio";
  /** Command to spawn (e.g., "npx", "node") */
  command: string;
  /** Arguments for the command (e.g., ["-y", "@modelcontextprotocol/server-github"]) */
  args: string[];
  /** Additional environment variables for the child process */
  env?: Record<string, string>;
  /** Connection timeout in ms (default: 30000) */
  timeout?: number;
  /** Auto-restart on crash (default: true) */
  retryOnCrash?: boolean;
}

/** Top-level MCP client configuration. */
export interface MCPClientConfig {
  /** Server configurations */
  servers: MCPServerConfig[];
  /** Connect all servers on init (default: true) */
  autoConnect: boolean;
  /** Prefix tool names with server name, e.g., "github_search_repos" (default: true) */
  toolPrefix: boolean;
  /** Max parallel tool calls across all servers (default: 5) */
  maxConcurrentCalls: number;
}

/** A tool discovered from an MCP server. */
export interface MCPTool {
  /** Original tool name from the server */
  name: string;
  /** Prefixed name: "serverName_toolName" */
  prefixedName: string;
  /** Which server this tool belongs to */
  serverName: string;
  /** Human-readable description */
  description: string;
  /** JSON Schema for the tool's input */
  inputSchema: Record<string, unknown>;
}

/** Result of an MCP tool invocation. */
export interface MCPCallResult {
  /** Content blocks returned by the tool */
  content: Array<{
    type: "text" | "image" | "resource";
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  /** Whether the tool returned an error */
  isError?: boolean;
}

/** Observable state of a single MCP server. */
export interface MCPServerState {
  /** Server name */
  name: string;
  /** Connection status */
  status: "disconnected" | "connecting" | "ready" | "error" | "crashed";
  /** Discovered tools */
  tools: MCPTool[];
  /** Child process PID */
  pid?: number;
  /** Error message if status is "error" or "crashed" */
  error?: string;
  /** Epoch ms of last successful connection */
  lastConnected?: number;
  /** Total tool calls made on this server */
  callCount: number;
}

/** JSON-RPC 2.0 message envelope. */
interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Pending JSON-RPC request awaiting a response. */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─── Defaults ───

const DEFAULT_CONFIG: Required<MCPClientConfig> = {
  servers: [],
  autoConnect: true,
  toolPrefix: true,
  maxConcurrentCalls: 5,
};

const DEFAULT_TIMEOUT = 30_000;
const REQUEST_TIMEOUT = 60_000;
const MCP_PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "yuan", version: "0.1.0" };

// ─── MCPServerConnection (internal) ───

/**
 * Manages the lifecycle of a single MCP server process.
 * Not exported — internal to MCPClient.
 */
class MCPServerConnection {
  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private state: MCPServerState;
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private requestIdCounter = 0;
  private config: MCPServerConfig;
  private toolPrefix: boolean;

  constructor(config: MCPServerConfig, toolPrefix: boolean) {
    this.config = config;
    this.toolPrefix = toolPrefix;
    this.state = {
      name: config.name,
      status: "disconnected",
      tools: [],
      callCount: 0,
    };
  }

  /** Current server state (immutable snapshot). */
  getState(): MCPServerState {
    return { ...this.state, tools: [...this.state.tools] };
  }

  /**
   * Spawn the child process, perform MCP handshake, and discover tools.
   * @throws {Error} On connection/initialization failure
   */
  async connect(): Promise<void> {
    if (this.state.status === "ready") return;

    this.state.status = "connecting";
    this.state.error = undefined;

    const timeout = this.config.timeout ?? DEFAULT_TIMEOUT;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.killProcess();
        const err = new Error(`MCP server "${this.config.name}" connection timed out after ${timeout}ms`);
        this.state.status = "error";
        this.state.error = err.message;
        reject(err);
      }, timeout);

      try {
        // Merge env: inherit process.env + server-specific env
        const env = { ...process.env, ...this.config.env };

        this.process = spawn(this.config.command, this.config.args, {
          stdio: ["pipe", "pipe", "pipe"],
          env,
          // Don't let the child keep our event loop alive
          
          detached: false,
        });

 if (!this.process.pid) {
   throw new Error(`Failed to spawn MCP server "${this.config.name}"`);
 }
        this.state.pid = this.process.pid;

        // Handle spawn errors
        this.process.on("error", (err: Error) => {
          clearTimeout(timer);
          this.handleProcessError(err);
          reject(err);
        });

        // Handle unexpected exit during init
        this.process.on("exit", (code: number | null) => {
          if (this.state.status === "connecting") {
            clearTimeout(timer);
            const err = new Error(
              `MCP server "${this.config.name}" exited during init with code ${code}`
            );
            this.state.status = "error";
            this.state.error = err.message;
            reject(err);
          } else {
            this.handleProcessExit(code ?? 1);
          }
        });

        // Set up stdout line reader for JSON-RPC messages
        if (!this.process.stdout) {
          clearTimeout(timer);
          const err = new Error(`MCP server "${this.config.name}": stdout not available`);
          this.state.status = "error";
          this.state.error = err.message;
          reject(err);
          return;
        }

        this.readline = createInterface({ input: this.process.stdout });
        this.readline.on("line", (line: string) => {
          this.handleStdoutLine(line);
        });

        // Stderr → log (not part of protocol)
        if (this.process.stderr) {
          this.process.stderr.on("data", (data: Buffer) => {
            // Silently consume stderr; could add debug logging here
            void data;
          });
        }

        // Perform MCP handshake
        this.initialize()
          .then(() => this.listTools())
          .then((tools) => {
            clearTimeout(timer);
            this.state.tools = tools;
            this.state.status = "ready";
            this.state.lastConnected = Date.now();
            resolve();
          })
          .catch((err: Error) => {
            clearTimeout(timer);
            this.state.status = "error";
            this.state.error = err.message;
            this.killProcess();
            reject(err);
          });
      } catch (err) {
        clearTimeout(timer);
        const error = err instanceof Error ? err : new Error(String(err));
        this.state.status = "error";
        this.state.error = error.message;
        reject(error);
      }
    });
  }

  /**
   * Gracefully disconnect the server.
   */
  async disconnect(): Promise<void> {
    this.rejectAllPending(new Error("Disconnecting"));
    this.killProcess();
    this.state.status = "disconnected";
    this.state.pid = undefined;
    this.state.tools = [];
  }

  /**
   * Invoke a tool on this MCP server.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<MCPCallResult> {
    if (this.state.status !== "ready") {
      throw new Error(`MCP server "${this.config.name}" is not ready (status: ${this.state.status})`);
    }

    this.state.callCount++;

    const result = (await this.sendRequest("tools/call", {
      name,
      arguments: args,
    })) as MCPCallResult;

    return result;
  }

  // ─── MCP Protocol Methods ───

  /**
   * Send the MCP `initialize` request and the `notifications/initialized` notification.
   */
  private async initialize(): Promise<void> {
    const result = (await this.sendRequest("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    })) as { protocolVersion: string; capabilities: unknown; serverInfo?: unknown };

    // After successful init, send the initialized notification
    this.sendNotification("notifications/initialized");

    void result;
  }

  /**
   * Request the tool list from the server.
   */
  private async listTools(): Promise<MCPTool[]> {
    const result = (await this.sendRequest("tools/list")) as {
      tools: Array<{
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
      }>;
    };

    return (result.tools ?? []).map((t) => ({
      name: t.name,
      prefixedName: this.toolPrefix
        ? `${this.config.name}_${t.name}`
        : t.name,
      serverName: this.config.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    }));
  }

  // ─── JSON-RPC Transport ───

  /**
   * Send a JSON-RPC request and wait for the response.
   */
  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin || this.process.stdin.destroyed) {
        reject(new Error(`MCP server "${this.config.name}": stdin not available`));
        return;
      }

      const id = ++this.requestIdCounter;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${REQUEST_TIMEOUT}ms`));
      }, REQUEST_TIMEOUT);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const message: JsonRpcMessage = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      const line = JSON.stringify(message) + "\n";
      this.process.stdin.write(line);
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  private sendNotification(method: string, params?: unknown): void {
    if (!this.process?.stdin || this.process.stdin.destroyed) return;

    const message: JsonRpcMessage = {
      jsonrpc: "2.0",
      method,
      params,
    };

    const line = JSON.stringify(message) + "\n";
    this.process.stdin.write(line);
  }

  /**
   * Handle a single line from stdout (newline-delimited JSON-RPC).
   */
  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      // Not valid JSON — skip (could be debug output)
      return;
    }

    if (message.jsonrpc !== "2.0") return;

    this.handleMessage(message);
  }

  /**
   * Route a parsed JSON-RPC message to the appropriate handler.
   */
  private handleMessage(message: JsonRpcMessage): void {
    // Response to a pending request
    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return; // Orphan response — ignore

      this.pendingRequests.delete(message.id);
      clearTimeout(pending.timer);

      if (message.error) {
        pending.reject(
          new Error(`MCP error ${message.error.code}: ${message.error.message}`)
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // Server-initiated notification — currently ignored
    // Future: handle tools/list_changed, resources/updated, etc.
  }

  /**
   * Handle child process unexpected exit.
   */
  private handleProcessExit(code: number): void {
    this.rejectAllPending(new Error(`MCP server "${this.config.name}" exited with code ${code}`));
    this.state.status = "crashed";
    this.state.error = `Process exited with code ${code}`;
    this.state.pid = undefined;
    this.process = null;
    this.readline = null;
  }

  /**
   * Handle child process error event.
   */
  private handleProcessError(err: Error): void {
    this.rejectAllPending(err);
    this.state.status = "error";
    this.state.error = err.message;
    this.state.pid = undefined;
    this.process = null;
    this.readline = null;
  }

  /**
   * Kill the child process if alive.
   */
  private killProcess(): void {
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }
    if (this.process) {
      try {
        this.process.kill("SIGTERM");
      } catch {
        // Already dead
      }
      this.process = null;
    }
  }

  /**
   * Reject all pending requests (used on disconnect/crash).
   */
  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pendingRequests.delete(id);
    }
  }
}

// ─── MCPClient (exported) ───

/**
 * MCP Client Bridge — connects to external MCP servers, discovers their tools,
 * and invokes them. Extends YUAN's tool ecosystem dynamically.
 *
 * @example
 * ```ts
 * const client = new MCPClient({
 *   servers: [
 *     {
 *       name: "github",
 *       transport: "stdio",
 *       command: "npx",
 *       args: ["-y", "@modelcontextprotocol/server-github"],
 *       env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_xxx" },
 *     },
 *   ],
 * });
 *
 * await client.connectAll();
 * const tools = client.getAvailableTools();
 * const result = await client.callTool("github_search_repositories", { query: "yuan" });
 * ```
 *
 * @fires MCPClient#server:connected
 * @fires MCPClient#server:disconnected
 * @fires MCPClient#server:error
 * @fires MCPClient#server:crashed
 * @fires MCPClient#tools:discovered
 * @fires MCPClient#tool:called
 * @fires MCPClient#tool:result
 */
export class MCPClient extends EventEmitter {
  private config: Required<MCPClientConfig>;
  private servers: Map<string, MCPServerConnection> = new Map();
  private allTools: Map<string, MCPTool> = new Map();
  private activeCalls = 0;
  private callQueue: Array<() => void> = [];

  constructor(config?: Partial<MCPClientConfig>) {
    super();
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      servers: config?.servers ? [...config.servers] : [],
    };
  }

  // ─── Lifecycle ───

  /**
   * Connect to all configured servers.
   * @returns Map of server name → state after connection attempt
   */
  async connectAll(): Promise<Map<string, MCPServerState>> {
    const results = new Map<string, MCPServerState>();

    const promises = this.config.servers.map(async (serverConfig) => {
      try {
        const state = await this.connect(serverConfig);
        results.set(serverConfig.name, state);
      } catch {
        results.set(serverConfig.name, this.getServerState(serverConfig.name) ?? {
          name: serverConfig.name,
          status: "error",
          tools: [],
          error: "Connection failed",
          callCount: 0,
        });
      }
    });

    await Promise.allSettled(promises);
    return results;
  }

  /**
   * Connect to a single MCP server.
   * @param serverConfig - Server configuration
   * @returns Server state after connection
   */
  async connect(serverConfig: MCPServerConfig): Promise<MCPServerState> {
    // Disconnect existing connection with same name
    if (this.servers.has(serverConfig.name)) {
      await this.disconnect(serverConfig.name);
    }

    const connection = new MCPServerConnection(serverConfig, this.config.toolPrefix);
    this.servers.set(serverConfig.name, connection);

    try {
      await connection.connect();

      const state = connection.getState();

      // Register discovered tools
      for (const tool of state.tools) {
        this.allTools.set(tool.prefixedName, tool);
      }

      this.emit("server:connected", { name: serverConfig.name, toolCount: state.tools.length });
      this.emit("tools:discovered", { serverName: serverConfig.name, tools: state.tools });

      return state;
    } catch (err) {
      const state = connection.getState();
      this.emit("server:error", {
        name: serverConfig.name,
        error: err instanceof Error ? err.message : String(err),
      });
      return state;
    }
  }

  /**
   * Disconnect a specific server by name.
   * @param serverName - Server to disconnect
   */
  async disconnect(serverName: string): Promise<void> {
    const connection = this.servers.get(serverName);
    if (!connection) return;

    // Remove this server's tools
    for (const [key, tool] of this.allTools) {
      if (tool.serverName === serverName) {
        this.allTools.delete(key);
      }
    }

    await connection.disconnect();
    this.servers.delete(serverName);
    this.emit("server:disconnected", { name: serverName });
  }

  /**
   * Disconnect all servers and clean up.
   */
  async disconnectAll(): Promise<void> {
    const names = [...this.servers.keys()];
    await Promise.allSettled(names.map((name) => this.disconnect(name)));
    this.allTools.clear();
    this.callQueue = [];
    this.activeCalls = 0;
  }

  /**
   * Add a server configuration at runtime (does not auto-connect).
   * @param config - Server configuration to add
   */
  addServer(config: MCPServerConfig): void {
    // Prevent duplicates
    this.config.servers = this.config.servers.filter((s) => s.name !== config.name);
    this.config.servers.push(config);
  }

  /**
   * Remove a server configuration and disconnect if connected.
   * @param name - Server name to remove
   */
  removeServer(name: string): void {
    this.config.servers = this.config.servers.filter((s) => s.name !== name);
    // Fire-and-forget disconnect
    void this.disconnect(name);
  }

  // ─── Tool Discovery ───

  /**
   * Get all available tools from all connected servers.
   * @returns Array of all discovered MCP tools
   */
  getAvailableTools(): MCPTool[] {
    return [...this.allTools.values()];
  }

  /**
   * Get tools from a specific server.
   * @param serverName - Server to get tools from
   * @returns Array of tools from the specified server
   */
  getServerTools(serverName: string): MCPTool[] {
    return [...this.allTools.values()].filter((t) => t.serverName === serverName);
  }

  /**
   * Find a tool by name (searches both prefixed and original names).
   * @param name - Tool name to search for
   * @returns The matching tool, or undefined if not found
   */
  findTool(name: string): MCPTool | undefined {
    // Direct lookup by prefixed name
    const direct = this.allTools.get(name);
    if (direct) return direct;

    // Search by original name (returns first match)
    for (const tool of this.allTools.values()) {
      if (tool.name === name) return tool;
    }

    return undefined;
  }

  /**
   * Convert all discovered MCP tools to YUAN ToolDefinition format.
   * Allows seamless integration with the AgentLoop tool system.
   * @returns Array of YUAN-compatible tool definitions
   */
  toToolDefinitions(): ToolDefinition[] {
    return [...this.allTools.values()].map((tool) => ({
      name: tool.prefixedName,
      description: `[MCP:${tool.serverName}] ${tool.description}`,
      parameters: {
        type: "object",
        properties: (tool.inputSchema.properties as Record<string, unknown>) ?? {},
        required: (tool.inputSchema.required as string[]) ?? [],
      },
      source: "mcp",
      serverName: tool.serverName,
      readOnly: false,
      requiresApproval: true,
      riskLevel: "critical",
    }));
  }

  // ─── Tool Invocation ───

  /**
   * Call a tool on an MCP server.
   * Respects maxConcurrentCalls — excess calls are queued.
   *
   * @param toolName - Tool name (prefixed or original)
   * @param args - Tool arguments
   * @returns Tool result
   * @throws {Error} If tool not found or server not ready
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<MCPCallResult> {
    const tool = this.findTool(toolName);
    if (!tool) {
      throw new Error(`MCP tool "${toolName}" not found`);
    }

    const connection = this.servers.get(tool.serverName);
    if (!connection) {
      throw new Error(`MCP server "${tool.serverName}" not connected`);
    }

    // Concurrency control
    await this.acquireCallSlot();

    this.emit("tool:called", {
      tool: tool.prefixedName,
      serverName: tool.serverName,
      args,
    });

    const startTime = Date.now();

    try {
      const result = await connection.callTool(tool.name, args);

      this.emit("tool:result", {
        tool: tool.prefixedName,
        serverName: tool.serverName,
        durationMs: Date.now() - startTime,
        isError: result.isError ?? false,
      });

      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      // Check if server crashed
      const state = connection.getState();
      if (state.status === "crashed") {
        this.emit("server:crashed", { name: tool.serverName, error: error.message });

        // Auto-restart if configured
        const serverConfig = this.config.servers.find((s) => s.name === tool.serverName);
        if (serverConfig?.retryOnCrash !== false) {
          void this.reconnectServer(serverConfig);
        }
      }

      throw error;
    } finally {
      this.releaseCallSlot();
    }
  }

  /**
   * Call a tool and convert the result to YUAN's ToolResult format.
   * Suitable for direct use in the AgentLoop.
   *
   * @param toolName - Tool name (prefixed or original)
   * @param args - Tool arguments
   * @param callId - Unique call ID for correlation
   * @returns YUAN-format ToolResult
   */
  async callToolAsYuan(
    toolName: string,
    args: Record<string, unknown>,
    callId: string
  ): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      const result = await this.callTool(toolName, args);
      const output = this.extractTextContent(result);

      return {
        tool_call_id: callId,
        name: toolName,
        output,
        success: !result.isError,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        tool_call_id: callId,
        name: toolName,
        output: `MCP tool error: ${err instanceof Error ? err.message : String(err)}`,
        success: false,
        durationMs: Date.now() - startTime,
      };
    }
  }

  // ─── Status ───

  /**
   * Get states of all registered servers.
   * @returns Array of server states
   */
  getServerStates(): MCPServerState[] {
    return [...this.servers.values()].map((conn) => conn.getState());
  }

  /**
   * Get state of a specific server.
   * @param name - Server name
   * @returns Server state or undefined if not registered
   */
  getServerState(name: string): MCPServerState | undefined {
    return this.servers.get(name)?.getState();
  }

  /**
   * Check if any servers are connected and ready.
   * @returns True if at least one server is in "ready" status
   */
  hasConnections(): boolean {
    for (const conn of this.servers.values()) {
      if (conn.getState().status === "ready") return true;
    }
    return false;
  }

  // ─── Private Helpers ───

  /**
   * Extract text content from an MCP call result.
   * Concatenates all text blocks, includes base64 image markers, and resource URIs.
   */
  private extractTextContent(result: MCPCallResult): string {
    const parts: string[] = [];

    for (const block of result.content) {
      switch (block.type) {
        case "text":
          if (block.text) parts.push(block.text);
          break;
        case "image":
          parts.push(`[image: ${block.mimeType ?? "unknown"}, ${(block.data?.length ?? 0)} bytes base64]`);
          break;
        case "resource":
          if (block.text) parts.push(block.text);
          else parts.push(`[resource: ${block.mimeType ?? "unknown"}]`);
          break;
      }
    }

    return parts.join("\n") || "(empty response)";
  }

  /**
   * Acquire a concurrency slot, or wait in queue.
   */
  private acquireCallSlot(): Promise<void> {
    if (this.activeCalls < this.config.maxConcurrentCalls) {
      this.activeCalls++;
      return Promise.resolve();
    }

    // Bound queue size to prevent unbounded memory growth
    const MAX_QUEUE_SIZE = 100;
if (this.callQueue.length >= MAX_QUEUE_SIZE) {
  return Promise.reject(
    new Error(`MCP call queue is full (max ${MAX_QUEUE_SIZE}).`)
  );
}

    return new Promise<void>((resolve) => {
      this.callQueue.push(() => {
        this.activeCalls++;
        resolve();
      });
    });
  }

  /**
   * Release a concurrency slot and dequeue the next waiter.
   */
  private releaseCallSlot(): void {
    this.activeCalls--;
    const next = this.callQueue.shift();
    if (next) next();
  }

  /**
   * Attempt to reconnect a crashed server after a brief delay.
   */
  private async reconnectServer(config?: MCPServerConfig): Promise<void> {
    if (!config) return;

    // Brief delay before reconnect
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));

    try {
      await this.connect(config);
    } catch {
      // Reconnect failed — server remains in error/crashed state
    }
  }
}
