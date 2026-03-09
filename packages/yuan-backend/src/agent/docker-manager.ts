/**
 * Docker-based session isolation manager.
 *
 * Runs each agent session in a separate Docker container with:
 * - Filesystem isolation (bind-mount only the project directory)
 * - Network isolation (--network=none by default)
 * - Resource limits (CPU, memory)
 * - Non-root execution
 * - Read-only root filesystem (except /tmp and workspace)
 *
 * @module
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DockerSessionConfig {
  /** Unique session identifier */
  sessionId: string;
  /** Project directory to bind-mount as /workspace */
  workDir: string;
  /** User's goal/prompt */
  goal: string;
  /** LLM model identifier */
  model?: string;
  /** Docker image name (default: 'yuan-worker:latest') */
  imageName?: string;
  /** CPU core limit (default: '2.0') */
  cpuLimit?: string;
  /** Memory limit (default: '2g') */
  memoryLimit?: string;
  /** Docker network mode (default: 'none') */
  networkMode?: string;
  /** Timeout before force-killing the container (default: 30 min) */
  timeoutMs?: number;
  /** Additional host paths to bind-mount as read-only */
  allowedPaths?: string[];
}

export interface DockerContainerStats {
  cpu: string;
  memory: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CPU_LIMIT = "2.0";
const DEFAULT_MEMORY_LIMIT = "2g";
const DEFAULT_NETWORK_MODE = "none";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// DockerSessionManager
// ---------------------------------------------------------------------------

export class DockerSessionManager extends EventEmitter {
  /** sessionId -> containerId */
  private containers = new Map<string, string>();

  /** sessionId -> timeout handle for auto-kill */
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly imageName: string;

  constructor(imageName = "yuan-worker:latest") {
    super();
    this.imageName = imageName;
  }

  // -----------------------------------------------------------------------
  // Docker availability
  // -----------------------------------------------------------------------

  /**
   * Check whether the Docker daemon is reachable.
   */
  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync("docker", ["info"], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Build image
  // -----------------------------------------------------------------------

  /**
   * Build the yuan-worker Docker image from the repo context directory.
   *
   * @param contextDir - Path to the monorepo root (where Dockerfile.worker
   *                     is located relative to packages/yuan-backend/).
   */
  async buildImage(contextDir: string): Promise<void> {
    const dockerfilePath = "packages/yuan-backend/Dockerfile.worker";
    const { stderr } = await execFileAsync(
      "docker",
      ["build", "-t", this.imageName, "-f", dockerfilePath, "."],
      { cwd: contextDir, timeout: 300_000 },
    );
    if (stderr && stderr.includes("ERROR")) {
      throw new Error(`Docker build failed: ${stderr}`);
    }
  }

  // -----------------------------------------------------------------------
  // Start container
  // -----------------------------------------------------------------------

  /**
   * Start a new Docker container for an agent session.
   *
   * @returns The Docker container ID.
   */
  async start(config: DockerSessionConfig): Promise<string> {
    const {
      sessionId,
      workDir,
      goal,
      model,
      cpuLimit = DEFAULT_CPU_LIMIT,
      memoryLimit = DEFAULT_MEMORY_LIMIT,
      networkMode = DEFAULT_NETWORK_MODE,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      allowedPaths = [],
    } = config;

    const image = config.imageName ?? this.imageName;
    const containerName = `yuan-session-${sessionId}`;

    // Prevent duplicate containers for the same session
    if (this.containers.has(sessionId)) {
      throw new Error(
        `Docker container already exists for session ${sessionId}`,
      );
    }

    const args: string[] = [
      "run",
      "--rm",
      "-d",
      // Naming
      "--name",
      containerName,
      // Resource limits
      `--cpus=${cpuLimit}`,
      `--memory=${memoryLimit}`,
      // Network isolation
      `--network=${networkMode}`,
      // Read-only root filesystem with writable /tmp
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=512m",
      // Bind-mount the project workspace
      "-v",
      `${workDir}:/workspace:rw`,
      // Security hardening
      "--security-opt",
      "no-new-privileges",
      // Environment variables for the worker
      "-e",
      `YUAN_SESSION_ID=${sessionId}`,
      "-e",
      `YUAN_GOAL=${goal}`,
      "-e",
      `YUAN_WORK_DIR=/workspace`,
    ];

    // Optional model
    if (model) {
      args.push("-e", `YUAN_MODEL=${model}`);
    }

    // Additional read-only bind mounts
    for (const hostPath of allowedPaths) {
      args.push("-v", `${hostPath}:${hostPath}:ro`);
    }

    // Image
    args.push(image);

    const { stdout } = await execFileAsync("docker", args, {
      timeout: 30_000,
    });
    const containerId = stdout.trim();

    if (!containerId) {
      throw new Error(`Failed to start Docker container for session ${sessionId}`);
    }

    this.containers.set(sessionId, containerId);

    // Schedule auto-kill on timeout
    const timeoutHandle = setTimeout(() => {
      void this.stop(sessionId, true);
      this.emit("timeout", sessionId);
    }, timeoutMs);
    timeoutHandle.unref();
    this.timeouts.set(sessionId, timeoutHandle);

    this.emit("started", sessionId, containerId);

    return containerId;
  }

  // -----------------------------------------------------------------------
  // Stream logs
  // -----------------------------------------------------------------------

  /**
   * Stream container logs as an async generator.
   *
   * Each yielded string is a line from stdout (typically JSON-encoded events).
   * The generator completes when the container exits or the stream is closed.
   */
  async *streamLogs(sessionId: string): AsyncGenerator<string> {
    const containerId = this.containers.get(sessionId);
    if (!containerId) {
      throw new Error(`No container found for session ${sessionId}`);
    }

    const child = spawn("docker", ["logs", "-f", "--tail", "0", containerId], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Buffer for partial lines
    let buffer = "";

    const lines: string[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf-8");
      const parts = buffer.split("\n");
      // Last element is the incomplete line (or empty string if ending with \n)
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        if (line.length > 0) {
          lines.push(line);
          if (resolve) {
            const r = resolve;
            resolve = null;
            r();
          }
        }
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("close", () => {
      done = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r();
      }
    });

    child.on("error", () => {
      done = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r();
      }
    });

    try {
      while (true) {
        if (lines.length > 0) {
          yield lines.shift()!;
          continue;
        }
        if (done) break;
        // Wait for more data
        await new Promise<void>((r) => {
          resolve = r;
        });
      }
    } finally {
      child.kill("SIGTERM");
    }
  }

  // -----------------------------------------------------------------------
  // Stop container
  // -----------------------------------------------------------------------

  /**
   * Stop a running container.
   *
   * @param sessionId - Session to stop.
   * @param force - If true, uses `docker kill` instead of `docker stop`.
   */
  async stop(sessionId: string, force = false): Promise<void> {
    const containerId = this.containers.get(sessionId);
    if (!containerId) {
      return; // Already stopped or never started
    }

    // Clear timeout
    const timeoutHandle = this.timeouts.get(sessionId);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      this.timeouts.delete(sessionId);
    }

    try {
      if (force) {
        await execFileAsync("docker", ["kill", containerId], {
          timeout: 10_000,
        });
      } else {
        await execFileAsync("docker", ["stop", "-t", "10", containerId], {
          timeout: 20_000,
        });
      }
    } catch {
      // Container may have already exited (--rm removes it automatically)
    }

    this.containers.delete(sessionId);
    this.emit("stopped", sessionId);
  }

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  /**
   * Get the current status of a session's container.
   */
  async getStatus(
    sessionId: string,
  ): Promise<"running" | "exited" | "unknown"> {
    const containerId = this.containers.get(sessionId);
    if (!containerId) {
      return "unknown";
    }

    try {
      const { stdout } = await execFileAsync(
        "docker",
        ["inspect", "--format", "{{.State.Status}}", containerId],
        { timeout: 5000 },
      );
      const status = stdout.trim();
      if (status === "running") return "running";
      if (status === "exited" || status === "dead" || status === "removing") {
        return "exited";
      }
      return "unknown";
    } catch {
      // Container no longer exists (auto-removed by --rm)
      this.containers.delete(sessionId);
      return "exited";
    }
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /**
   * Force-stop and remove all tracked containers.
   */
  async cleanup(): Promise<void> {
    const sessions = Array.from(this.containers.keys());
    const stopPromises = sessions.map((sessionId) =>
      this.stop(sessionId, true),
    );
    await Promise.allSettled(stopPromises);
  }

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------

  /**
   * Get CPU and memory usage for a session's container.
   */
  async getStats(sessionId: string): Promise<DockerContainerStats> {
    const containerId = this.containers.get(sessionId);
    if (!containerId) {
      throw new Error(`No container found for session ${sessionId}`);
    }

    const { stdout } = await execFileAsync(
      "docker",
      ["stats", "--no-stream", "--format", "{{.CPUPerc}}|{{.MemUsage}}", containerId],
      { timeout: 10_000 },
    );

    const parts = stdout.trim().split("|");
    return {
      cpu: parts[0] ?? "0%",
      memory: parts[1] ?? "0B / 0B",
    };
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /** Return all active session IDs. */
  getActiveSessions(): string[] {
    return Array.from(this.containers.keys());
  }

  /** Check whether a session has a tracked container. */
  hasSession(sessionId: string): boolean {
    return this.containers.has(sessionId);
  }
}
