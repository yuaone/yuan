/**
 * @module background-agent
 * @description Background Agent — Long-running persistent agents for continuous monitoring.
 *
 * Provides a framework for background tasks that periodically check
 * project health: type checking, test watching, security scanning,
 * performance analysis, and dependency monitoring.
 */

import { EventEmitter } from "node:events";
import { exec } from "node:child_process";

// ─── Types ───

/** Configuration for a background agent */
export interface BackgroundAgentConfig {
  /** Unique agent ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** Agent type — determines default behavior */
  type:
    | "test-watcher"
    | "type-checker"
    | "security-scanner"
    | "perf-analyzer"
    | "dependency-watcher";
  /** Check interval in milliseconds */
  intervalMs: number;
  /** Whether this agent is enabled */
  enabled: boolean;
  /** Shell command to execute on each tick (optional) */
  command?: string;
  /** Working directory for command execution */
  cwd?: string;
}

/** Event emitted by a background agent */
export interface BackgroundEvent {
  /** Agent that emitted this event */
  agentId: string;
  /** Event severity */
  type: "info" | "warning" | "error" | "success";
  /** Human-readable message */
  message: string;
  /** Timestamp (epoch ms) */
  timestamp: number;
  /** Additional data */
  data?: Record<string, unknown>;
}

// ─── Constants ───

const DEFAULT_INTERVAL_MS = 30_000; // 30 seconds
const COMMAND_TIMEOUT_MS = 60_000; // 1 minute

/** Default agent configs per type */
const DEFAULT_CONFIGS: Record<
  BackgroundAgentConfig["type"],
  { name: string; intervalMs: number; command: string }
> = {
  "type-checker": {
    name: "TypeScript Type Checker",
    intervalMs: 60_000,
    command: "npx tsc --noEmit 2>&1",
  },
  "test-watcher": {
    name: "Test Watcher",
    intervalMs: 120_000,
    command: "npx jest --watchAll=false --bail 2>&1",
  },
  "security-scanner": {
    name: "Security Scanner",
    intervalMs: 300_000,
    command: "npm audit --json 2>&1 || true",
  },
  "perf-analyzer": {
    name: "Performance Analyzer",
    intervalMs: 600_000,
    command: "echo 'perf-check-placeholder'",
  },
  "dependency-watcher": {
    name: "Dependency Watcher",
    intervalMs: 3_600_000,
    command: "npx npm-check-updates --errorLevel 2 2>&1 || true",
  },
};

// ─── BackgroundAgent ───

export interface BackgroundAgentEvents {
  event: [BackgroundEvent];
  started: [string];
  stopped: [string];
  error: [Error];
}

/**
 * BackgroundAgent — a single persistent monitoring agent.
 *
 * Runs a check cycle at a configurable interval. Each tick either
 * executes a shell command or performs a type-specific check.
 * Emits BackgroundEvent on each result.
 */
export class BackgroundAgent extends EventEmitter<BackgroundAgentEvents> {
  private config: BackgroundAgentConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private isTickRunning = false;
  private tickCount = 0;

  constructor(config: BackgroundAgentConfig) {
    super();
    this.config = { ...config };
  }

  /** Start periodic checks */
  start(): void {
    if (this.running) return;
    if (!this.config.enabled) return;

    this.running = true;
    this.emit("started", this.config.id);

    // Run first tick immediately
    void this.tick();

    // Schedule subsequent ticks
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.intervalMs);
  }

  /** Stop the agent */
  stop(): void {
    if (!this.running) return;

    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.emit("stopped", this.config.id);
  }

  /** Check if the agent is currently running */
  isRunning(): boolean {
    return this.running;
  }

  /** Get agent configuration */
  getConfig(): BackgroundAgentConfig {
    return { ...this.config };
  }

  /** Get tick count */
  getTickCount(): number {
    return this.tickCount;
  }

  /** Execute one check cycle */
  private async tick(): Promise<void> {
    if (!this.running) return;
    if (this.isTickRunning) return; // skip if previous tick still running

    this.isTickRunning = true;
    try {
      this.tickCount++;

      if (this.config.command) {
        await this.executeCommand(this.config.command);
      } else {
        // No command — emit a heartbeat
        this.emitEvent("info", `${this.config.name} heartbeat (tick #${this.tickCount})`);
      }
    } finally {
      this.isTickRunning = false;
    }
  }

  /** Execute a shell command and emit results */
  private async executeCommand(command: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const cwd = this.config.cwd ?? process.cwd();

      exec(
        command,
        { timeout: COMMAND_TIMEOUT_MS, cwd, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            const output = stderr || stdout || error.message;
            this.emitEvent("error", `${this.config.name}: ${truncateOutput(output)}`, {
              exitCode: error.code,
              stderr: truncateOutput(stderr),
              stdout: truncateOutput(stdout),
            });
          } else {
            const output = stdout.trim();
            if (output.length === 0 || /^(ok|pass)/i.test(output)) {
              this.emitEvent("success", `${this.config.name}: clean`);
            } else if (/warn/i.test(output)) {
              this.emitEvent("warning", `${this.config.name}: ${truncateOutput(output)}`, {
                stdout: truncateOutput(output),
              });
            } else {
              this.emitEvent("info", `${this.config.name}: ${truncateOutput(output)}`, {
                stdout: truncateOutput(output),
              });
            }
          }

          resolve();
        },
      );
    });
  }

  /** Emit a typed BackgroundEvent */
  private emitEvent(
    type: BackgroundEvent["type"],
    message: string,
    data?: Record<string, unknown>,
  ): void {
    const event: BackgroundEvent = {
      agentId: this.config.id,
      type,
      message,
      timestamp: Date.now(),
      data,
    };
    this.emit("event", event);
  }
}

// ─── BackgroundAgentManager ───

/**
 * BackgroundAgentManager — manages multiple background agents.
 *
 * Registers, starts, stops, and lists background monitoring agents.
 * Provides a `createDefaults` method to set up standard agents
 * for a project.
 */
export class BackgroundAgentManager {
  private agents: Map<string, BackgroundAgent> = new Map();

  /** Register and start a background agent */
  register(config: BackgroundAgentConfig): BackgroundAgent {
    // Stop existing agent with same ID
    this.unregister(config.id);

    const agent = new BackgroundAgent(config);
    this.agents.set(config.id, agent);

    if (config.enabled) {
      agent.start();
    }

    return agent;
  }

  /** Stop and remove an agent */
  unregister(id: string): void {
    const agent = this.agents.get(id);
    if (agent) {
      agent.stop();
      agent.removeAllListeners();
      this.agents.delete(id);
    }
  }

  /** Get an agent by ID */
  get(id: string): BackgroundAgent | undefined {
    return this.agents.get(id);
  }

  /** List all agent configs */
  list(): BackgroundAgentConfig[] {
    return Array.from(this.agents.values()).map((a) => a.getConfig());
  }

  /** Stop all agents */
  stopAll(): void {
    for (const agent of this.agents.values()) {
      agent.stop();
    }
  }

  /** Remove all agents */
  clear(): void {
    this.stopAll();
    for (const agent of this.agents.values()) {
      agent.removeAllListeners();
    }
    this.agents.clear();
  }

  /**
   * Create default background agents for a project.
   * Registers but does not start agents — they start based on `enabled` flag.
   *
   * Default set:
   * - type-checker (enabled)
   * - test-watcher (disabled by default — can be expensive)
   * - security-scanner (enabled, low frequency)
   * - dependency-watcher (enabled, very low frequency)
   */
  createDefaults(projectRoot: string): void {
    const types: Array<{
      type: BackgroundAgentConfig["type"];
      enabled: boolean;
    }> = [
      { type: "type-checker", enabled: true },
      { type: "test-watcher", enabled: false },
      { type: "security-scanner", enabled: true },
      { type: "dependency-watcher", enabled: true },
    ];

    for (const { type, enabled } of types) {
      const defaults = DEFAULT_CONFIGS[type];
      this.register({
        id: `default:${type}`,
        name: defaults.name,
        type,
        intervalMs: defaults.intervalMs,
        enabled,
        command: defaults.command,
        cwd: projectRoot,
      });
    }
  }
}

// ─── Utility ───

function truncateOutput(str: string, maxLen: number = 500): string {
  if (!str) return "";
  const trimmed = str.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen - 3) + "...";
}
