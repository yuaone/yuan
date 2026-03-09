/**
 * Worker entry-point -- forked by ProcessManager.
 *
 * Reads agent config from `YUAN_AGENT_CONFIG` env or the first IPC `init`
 * message, instantiates the ExecutionEngine from @yuan/core, and relays
 * events back to the parent via `process.send()`.
 *
 * @module
 */

import { ExecutionEngine } from "@yuan/core";
import type { ExecutionEngineConfig, LLMProvider } from "@yuan/core";
import { createDefaultRegistry } from "@yuan/tools";

// ---------------------------------------------------------------------------
// Types (duplicated minimally to avoid importing parent code)
// ---------------------------------------------------------------------------

interface AgentWorkerConfig {
  sessionId: string;
  goal: string;
  provider: string;
  model: string;
  apiKey: string;
  maxIterations: number;
  workDir: string;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  method?: string;
  id?: number;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Send a JSON-RPC notification to the parent process. */
function notify(method: string, params: Record<string, unknown>): void {
  const msg: JsonRpcMessage = { jsonrpc: "2.0", method, params };
  if (process.send) {
    process.send(msg);
  }
}

/** Send a JSON-RPC error response. */
function sendError(
  id: number | undefined,
  code: number,
  message: string,
  data?: unknown,
): void {
  const msg: JsonRpcMessage = {
    jsonrpc: "2.0",
    id,
    error: { code, message, data },
  };
  if (process.send) {
    process.send(msg);
  }
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

function resolveConfigFromEnv(): Omit<AgentWorkerConfig, "apiKey"> | null {
  const raw = process.env["YUAN_AGENT_CONFIG"];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Omit<AgentWorkerConfig, "apiKey">;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Engine instance (module-level so abort/stop messages can reach it)
// ---------------------------------------------------------------------------

let engine: ExecutionEngine | null = null;

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------

let started = false;

async function run(config: AgentWorkerConfig): Promise<void> {
  if (started) return;
  started = true;

  notify("agent:status_change", {
    sessionId: config.sessionId,
    status: "running",
  });

  try {
    // Build tool registry and executor
    const registry = createDefaultRegistry();
    const toolExecutor = registry.toExecutor(config.workDir);

    // Map worker config to ExecutionEngineConfig
    const engineConfig: ExecutionEngineConfig = {
      byokConfig: {
        provider: config.provider as LLMProvider,
        apiKey: config.apiKey,
        model: config.model,
      },
      projectPath: config.workDir,
      toolExecutor,
      maxIterations: config.maxIterations,
    };

    engine = new ExecutionEngine(engineConfig);

    // ----- Wire engine events to IPC notifications -----

    engine.on("engine:start", (goal: string) => {
      notify("agent:event", {
        sessionId: config.sessionId,
        kind: "engine:start",
        goal,
      });
    });

    engine.on("phase:enter", (phase: string) => {
      notify("agent:event", {
        sessionId: config.sessionId,
        kind: "phase:enter",
        phase,
      });
    });

    engine.on("phase:exit", (phase: string) => {
      notify("agent:event", {
        sessionId: config.sessionId,
        kind: "phase:exit",
        phase,
      });
    });

    engine.on("tool:call", (name: string, input: unknown) => {
      notify("agent:event", {
        sessionId: config.sessionId,
        kind: "tool:call",
        tool: name,
        args: input as Record<string, unknown>,
      });
    });

    engine.on("tool:result", (name: string, output: string) => {
      notify("agent:event", {
        sessionId: config.sessionId,
        kind: "tool:result",
        tool: name,
        result: output,
      });
    });

    engine.on("text_delta", (text: string) => {
      notify("agent:event", {
        sessionId: config.sessionId,
        kind: "text_delta",
        text,
      });
    });

    engine.on("thinking", (text: string) => {
      notify("agent:event", {
        sessionId: config.sessionId,
        kind: "thinking",
        text,
      });
    });

    engine.on("monologue", (entry: unknown) => {
      notify("agent:event", {
        sessionId: config.sessionId,
        kind: "monologue",
        entry: entry as Record<string, unknown>,
      });
    });

    engine.on("verify:result", (result: unknown) => {
      notify("agent:event", {
        sessionId: config.sessionId,
        kind: "verify:result",
        result: result as Record<string, unknown>,
      });
    });

    engine.on("engine:delegate", (question: string) => {
      notify("agent:event", {
        sessionId: config.sessionId,
        kind: "engine:delegate",
        question,
      });
    });

    // Forward all debate events to parent process
    const debateEventNames = [
      "debate:start", "debate:round:start", "debate:round:end",
      "debate:coder", "debate:reviewer", "debate:revision",
      "debate:verifier", "debate:pass", "debate:fail",
      "debate:token_usage", "debate:abort",
    ] as const;
    for (const eventName of debateEventNames) {
      engine.on(eventName, (...args: unknown[]) => {
        notify("agent:event", {
          sessionId: config.sessionId,
          kind: eventName,
          data: args[0] ?? null,
        });
      });
    }

    engine.on("engine:error", (error: Error) => {
      notify("agent:error", {
        sessionId: config.sessionId,
        message: error.message,
      });
    });

    // ----- Execute -----

    const result = await engine.execute(config.goal);

    notify("agent:done", {
      sessionId: config.sessionId,
      success: result.success,
      summary: result.summary,
      finalPhase: result.finalPhase,
      changedFiles: result.changedFiles,
      totalTokens: result.totalTokens,
      totalIterations: result.totalIterations,
      totalToolCalls: result.totalToolCalls,
      durationMs: result.durationMs,
      termination: result.termination as unknown as Record<string, unknown>,
    });

    notify("agent:status_change", {
      sessionId: config.sessionId,
      status: result.success ? "completed" : "failed",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    notify("agent:error", { sessionId: config.sessionId, message });
    notify("agent:status_change", {
      sessionId: config.sessionId,
      status: "failed",
    });
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

// NOTE: Config from env intentionally excludes apiKey (security).
// The worker waits for the IPC `init` message which includes apiKey.
// resolveConfigFromEnv() returns partial config without apiKey.
const _envConfig = resolveConfigFromEnv();
// We do NOT start run() from env config alone because apiKey is missing.
// The IPC `init` message is the authoritative start trigger.

// Listen for IPC messages from the parent
process.on("message", (msg: JsonRpcMessage) => {
  if (msg.method === "init" && msg.params) {
    const config = msg.params as unknown as AgentWorkerConfig;
    void run(config);
    return;
  }

  if (msg.method === "abort") {
    if (engine) {
      engine.abort();
    }
    notify("agent:status_change", {
      sessionId: (msg.params?.["sessionId"] as string) ?? "unknown",
      status: "stopped",
    });
    return;
  }

  if (msg.method === "stop") {
    if (engine) {
      engine.abort();
    }
    notify("agent:status_change", {
      sessionId: (msg.params?.["sessionId"] as string) ?? "unknown",
      status: "stopped",
    });
    process.exit(0);
  }

  // Unknown method -- respond with error if it has an id (request)
  if (msg.id !== undefined) {
    sendError(msg.id, -32601, `Method not found: ${msg.method ?? "(none)"}`);
  }
});

// Graceful shutdown
function shutdown(): void {
  if (engine) {
    engine.abort();
  }
  notify("agent:log", { message: "Worker received shutdown signal." });
  // Allow a brief moment for abort to propagate before exiting
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Keep the event loop alive so the worker doesn't exit prematurely
// (once ExecutionEngine is wired in, its async work will keep it alive instead)
const keepAlive = setInterval(() => {
  // no-op tick
}, 60_000);

// Allow the process to exit naturally when there is no more work
keepAlive.unref();
