/**
 * ProcessManager — Spawns and manages yuan-core agent child processes.
 *
 * Communication with each child uses stdio JSON-RPC (process.send / 'message' event).
 * Each process is tracked by sessionId and auto-killed after a configurable timeout.
 *
 * @module
 */

import { type ChildProcess, fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  DockerSessionManager,
  type DockerSessionConfig,
} from "./docker-manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentProcessConfig {
  /** Working directory for the agent */
  workDir: string;
  /** User's goal/prompt */
  goal: string;
  /** LLM provider config */
  provider: string;
  /** Model to use */
  model: string;
  /** API key (BYOK) */
  apiKey: string;
  /** Max iterations */
  maxIterations: number;
  /** Session ID */
  sessionId: string;
  /** Owner user ID — used for per-user accounting */
  userId?: number;
  /** Timeout in ms before force-killing (default 30 min) */
  timeoutMs?: number;
}

export interface AgentProcessMessage {
  jsonrpc: "2.0";
  method?: string;
  id?: number;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ProcessStats {
  active: number;
  total: number;
  byUser: Map<string, number>;
}

// ---------------------------------------------------------------------------
// Internal bookkeeping
// ---------------------------------------------------------------------------

interface TrackedProcess {
  child: ChildProcess;
  sessionId: string;
  userId: number | undefined;
  spawnedAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// ProcessManager
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Default worker entry-point resolved relative to this file. */
const DEFAULT_WORKER_PATH = path.resolve(__dirname, "worker.js");

/** Server-wide hard cap on concurrent agent processes. */
const MAX_PROCESSES = 50;

/** Default process timeout: 30 minutes. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export class ProcessManager extends EventEmitter {
  private processes = new Map<string, TrackedProcess>();
  private totalSpawned = 0;

  /** When true, sessions run inside Docker containers instead of forked processes. */
  private useDocker = false;

  /** Lazy-initialized Docker session manager. */
  private dockerManager: DockerSessionManager | null = null;

  constructor() {
    super();
    this.setMaxListeners(200);
  }

  // -----------------------------------------------------------------------
  // Docker mode
  // -----------------------------------------------------------------------

  /**
   * Enable or disable Docker-based isolation.
   *
   * When enabled, `spawn()` delegates to DockerSessionManager instead of
   * `child_process.fork()`. The Docker manager is lazy-initialized on first use.
   */
  setUseDocker(enabled: boolean): void {
    this.useDocker = enabled;
  }

  /** Whether Docker mode is currently enabled. */
  getUseDocker(): boolean {
    return this.useDocker;
  }

  /**
   * Return the lazily-created DockerSessionManager instance.
   * Exposed for advanced usage (e.g. building images, streaming logs).
   */
  getDockerManager(): DockerSessionManager {
    if (!this.dockerManager) {
      this.dockerManager = new DockerSessionManager();

      // Forward Docker events
      this.dockerManager.on("timeout", (sessionId: string) => {
        this.removeTracked(sessionId);
        this.emit("timeout", sessionId);
      });

      this.dockerManager.on("stopped", (sessionId: string) => {
        this.removeTracked(sessionId);
        this.emit("exit", sessionId, null, null);
      });
    }
    return this.dockerManager;
  }

  // -----------------------------------------------------------------------
  // Spawn
  // -----------------------------------------------------------------------

  /**
   * Spawn an agent worker in a Docker container.
   *
   * This is used internally when `useDocker` is enabled. The container
   * communicates via stdout JSON lines instead of IPC.
   *
   * @returns The sessionId.
   */
  private spawnDocker(config: AgentProcessConfig): string {
    const { sessionId } = config;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const dockerConfig: DockerSessionConfig = {
      sessionId,
      workDir: config.workDir,
      goal: config.goal,
      model: config.model,
      timeoutMs,
    };

    const manager = this.getDockerManager();

    // Start container asynchronously; track as a "process" with a null child
    // We create a placeholder TrackedProcess so isAlive() etc. still work.
    const timeoutHandle = setTimeout(() => {
      void manager.stop(sessionId, true);
      this.removeTracked(sessionId);
      this.emit("timeout", sessionId);
    }, timeoutMs);

    const tracked: TrackedProcess = {
      child: null as unknown as ChildProcess, // Docker mode — no ChildProcess
      sessionId,
      userId: config.userId,
      spawnedAt: Date.now(),
      timeoutHandle,
    };

    this.processes.set(sessionId, tracked);
    this.totalSpawned += 1;

    // Fire-and-forget container start + log streaming
    void (async () => {
      try {
        await manager.start(dockerConfig);
        this.emit("message", sessionId, {
          jsonrpc: "2.0" as const,
          method: "agent:status_change",
          params: { sessionId, status: "running" },
        });

        // Stream container logs and emit them as messages
        for await (const line of manager.streamLogs(sessionId)) {
          try {
            const parsed = JSON.parse(line) as AgentProcessMessage;
            this.emit("message", sessionId, parsed);
          } catch {
            // Non-JSON log line — emit as raw log
            this.emit("message", sessionId, {
              jsonrpc: "2.0" as const,
              method: "agent:log",
              params: { sessionId, message: line },
            });
          }
        }

        // Container exited
        this.removeTracked(sessionId);
        this.emit("exit", sessionId, 0, null);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.emit("error", sessionId, new Error(message));
        this.removeTracked(sessionId);
        this.emit("exit", sessionId, 1, null);
      }
    })();

    return sessionId;
  }

  /**
   * Fork a new agent worker process (or start a Docker container if Docker
   * mode is enabled).
   *
   * @returns The sessionId associated with the spawned process.
   * @throws If the server-wide process limit has been reached.
   */
  spawn(config: AgentProcessConfig): string {
    if (this.processes.size >= MAX_PROCESSES) {
      throw new Error(
        `Process limit reached (${MAX_PROCESSES}). Cannot spawn new agent.`,
      );
    }

    const { sessionId } = config;

    // Prevent duplicate session processes
    if (this.processes.has(sessionId)) {
      throw new Error(`Process already exists for session ${sessionId}`);
    }

    // Docker mode: delegate to DockerSessionManager
    if (this.useDocker) {
      return this.spawnDocker(config);
    }

    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Fork the worker. We pass non-secret config as a serialised env var so
    // the worker can read it synchronously at startup.
    // SECURITY: apiKey is intentionally excluded from the env var because
    // environment variables are visible via /proc/<pid>/environ on Linux.
    // The apiKey is sent only via the IPC `init` message below, which is
    // private to the parent-child stdio pipe.
    const child = fork(DEFAULT_WORKER_PATH, [], {
      cwd: config.workDir,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        YUAN_AGENT_CONFIG: JSON.stringify({
          sessionId: config.sessionId,
          goal: config.goal,
          provider: config.provider,
          model: config.model,
          maxIterations: config.maxIterations,
          workDir: config.workDir,
        }),
      },
      // Ensure the child is killed if the parent exits unexpectedly
      detached: false,
    });

    // Schedule forced kill on timeout
    const timeoutHandle = setTimeout(() => {
      this.kill(sessionId, "SIGKILL");
      this.emit("timeout", sessionId);
    }, timeoutMs);

    const tracked: TrackedProcess = {
      child,
      sessionId,
      userId: config.userId,
      spawnedAt: Date.now(),
      timeoutHandle,
    };

    this.processes.set(sessionId, tracked);
    this.totalSpawned += 1;

    // ----- Wire up event forwarding -----

    child.on("message", (msg: AgentProcessMessage) => {
      this.emit("message", sessionId, msg);
    });

    child.on("error", (err: Error) => {
      this.emit("error", sessionId, err);
    });

    child.on("exit", (code: number | null, signal: string | null) => {
      this.removeTracked(sessionId);
      this.emit("exit", sessionId, code, signal);
    });

    // Also send config via IPC for workers that prefer it
    child.send({
      jsonrpc: "2.0",
      method: "init",
      params: {
        sessionId: config.sessionId,
        goal: config.goal,
        provider: config.provider,
        model: config.model,
        apiKey: config.apiKey,
        maxIterations: config.maxIterations,
        workDir: config.workDir,
      },
    } satisfies AgentProcessMessage);

    return sessionId;
  }

  // -----------------------------------------------------------------------
  // Send
  // -----------------------------------------------------------------------

  /**
   * Send a JSON-RPC message to an agent process.
   *
   * @returns `true` if the message was sent, `false` if the session does not
   *          exist or the channel is closed.
   */
  send(sessionId: string, message: AgentProcessMessage): boolean {
    const tracked = this.processes.get(sessionId);
    if (!tracked) return false;

    // Docker mode: IPC is not available (no child process)
    if (this.useDocker || !tracked.child) return false;

    if (!tracked.child.connected) return false;
    return tracked.child.send(message);
  }

  // -----------------------------------------------------------------------
  // Abort (graceful)
  // -----------------------------------------------------------------------

  /**
   * Send an abort message to an agent process via IPC.
   *
   * This triggers `engine.abort()` in the worker, allowing the
   * ExecutionEngine to stop at its next checkpoint and clean up gracefully.
   *
   * @returns `true` if the message was sent, `false` if the session does
   *          not exist or the channel is closed.
   */
  abort(sessionId: string): boolean {
    // Docker mode: stop the container gracefully
    if (this.useDocker && this.dockerManager?.hasSession(sessionId)) {
      void this.dockerManager.stop(sessionId, false);
      return true;
    }

    return this.send(sessionId, {
      jsonrpc: "2.0",
      method: "abort",
      params: { sessionId },
    });
  }

  // -----------------------------------------------------------------------
  // Kill
  // -----------------------------------------------------------------------

  /**
   * Kill an agent process.
   *
   * @returns `true` if the process existed and was signalled.
   */
  kill(sessionId: string, signal: NodeJS.Signals = "SIGTERM"): boolean {
    const tracked = this.processes.get(sessionId);
    if (!tracked) {
      return false;
    }

    // Docker mode: force-stop the container
    if (this.useDocker && this.dockerManager?.hasSession(sessionId)) {
      const force = signal === "SIGKILL";
      void this.dockerManager.stop(sessionId, force);
      return true;
    }

    // Fork mode: signal the child process
    if (!tracked.child) return false;

    tracked.child.kill(signal);

    // Follow-up SIGKILL if process doesn't exit within 5 seconds
    if (signal !== "SIGKILL") {
      const forceKillTimer = setTimeout(() => {
        if (this.processes.has(sessionId)) {
          try {
            tracked.child.kill("SIGKILL");
          } catch {
            // Process may have already exited
          }
        }
      }, 5000);
      forceKillTimer.unref();
    }

    // Don't remove tracking here — let the 'exit' event handler do it
    return true;
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /** Return all active session IDs. */
  getActiveProcesses(): string[] {
    return Array.from(this.processes.keys());
  }

  /** Aggregate stats about current and historical processes. */
  getStats(): ProcessStats {
    const byUser = new Map<string, number>();
    for (const tracked of this.processes.values()) {
      const key = String(tracked.userId ?? "unknown");
      byUser.set(key, (byUser.get(key) ?? 0) + 1);
    }
    return {
      active: this.processes.size,
      total: this.totalSpawned,
      byUser,
    };
  }

  /** Check whether a session process is alive. */
  isAlive(sessionId: string): boolean {
    return this.processes.has(sessionId);
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /** Force-kill all remaining processes (e.g. on server shutdown). */
  cleanup(): void {
    // Docker mode: delegate cleanup to DockerSessionManager
    if (this.dockerManager) {
      void this.dockerManager.cleanup();
    }

    for (const [sessionId, tracked] of this.processes) {
      clearTimeout(tracked.timeoutHandle);
      // In Docker mode tracked.child is a placeholder — skip kill
      if (tracked.child && typeof tracked.child.kill === "function") {
        try {
          tracked.child.kill("SIGKILL");
        } catch {
          // Process may have already exited
        }
      }
      this.processes.delete(sessionId);
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private removeTracked(sessionId: string): void {
    const tracked = this.processes.get(sessionId);
    if (tracked) {
      clearTimeout(tracked.timeoutHandle);
      this.processes.delete(sessionId);
    }
  }
}
