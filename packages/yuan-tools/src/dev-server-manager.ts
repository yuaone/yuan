/**
 * @yuaone/tools — DevServerManager
 *
 * Detects framework, starts/stops dev servers, detects port from stdout.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { EventEmitter } from "node:events";
import type { DesignFramework, DevServerState } from "@yuaone/core";

const FRAMEWORK_DETECTORS: Array<{
  key: string;
  framework: DesignFramework;
  defaultCommand: string;
}> = [
  { key: "next", framework: "nextjs", defaultCommand: "next dev" },
  { key: "vite", framework: "vite", defaultCommand: "vite" },
  { key: "react-scripts", framework: "cra", defaultCommand: "react-scripts start" },
  { key: "astro", framework: "astro", defaultCommand: "astro dev" },
  { key: "svelte", framework: "svelte", defaultCommand: "vite" },
];

const PORT_PATTERNS = [
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)/,
  /port\s+(\d+)/i,
  /listening\s+(?:on\s+)?(?:port\s+)?(\d+)/i,
];

export interface DevServerManagerEvents {
  started: [state: DevServerState];
  stdout: [line: string];
  stderr: [line: string];
  error: [error: Error];
  stopped: [];
}

export class DevServerManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private state: DevServerState | null = null;

  async detectFramework(workDir: string): Promise<{
    framework: DesignFramework;
    devCommand: string;
  }> {
    try {
      const raw = await readFile(join(workDir, "package.json"), "utf8");
      const pkg = JSON.parse(raw);
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

      for (const detector of FRAMEWORK_DETECTORS) {
        if (allDeps[detector.key]) {
          const devScript = pkg.scripts?.dev ?? detector.defaultCommand;
          return { framework: detector.framework, devCommand: devScript };
        }
      }

      if (pkg.scripts?.dev) {
        return { framework: "unknown", devCommand: pkg.scripts.dev };
      }

      return { framework: "unknown", devCommand: "npm run dev" };
    } catch {
      return { framework: "unknown", devCommand: "npm run dev" };
    }
  }

  async isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(true));
      server.once("listening", () => {
        server.close();
        resolve(false);
      });
      server.listen(port, "127.0.0.1");
    });
  }

  async start(
    workDir: string,
    options?: { command?: string; port?: number; timeout?: number }
  ): Promise<DevServerState> {
    const { framework, devCommand } = await this.detectFramework(workDir);
    const command = options?.command ?? devCommand;
    const timeout = options?.timeout ?? 30_000;
    const expectedPort = options?.port ?? 3000;

    if (await this.isPortInUse(expectedPort)) {
      const state: DevServerState = {
        framework,
        command,
        url: `http://localhost:${expectedPort}`,
        port: expectedPort,
        pid: 0,
        managed: false,
      };
      this.state = state;
      this.emit("started", state);
      return state;
    }

    let pm = "npm";
    try {
      await readFile(join(workDir, "pnpm-lock.yaml"), "utf8");
      pm = "pnpm";
    } catch {
      try {
        await readFile(join(workDir, "yarn.lock"), "utf8");
        pm = "yarn";
      } catch {
        // npm default
      }
    }

    const fullCommand = command.startsWith(pm) ? command : `${pm} run dev`;

    return new Promise((resolve, reject) => {
      const [cmd, ...args] = fullCommand.split(/\s+/);
      this.process = spawn(cmd, args, {
        cwd: workDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0" },
        shell: true,
      });

      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          const state: DevServerState = {
            framework,
            command: fullCommand,
            url: `http://localhost:${expectedPort}`,
            port: expectedPort,
            pid: this.process?.pid ?? 0,
            managed: true,
          };
          this.state = state;
          this.emit("started", state);
          resolve(state);
        }
      }, timeout);

      const handleOutput = (data: Buffer) => {
        const text = data.toString();
        this.emit("stdout", text);

        if (resolved) return;

        for (const pattern of PORT_PATTERNS) {
          const match = text.match(pattern);
          if (match) {
            resolved = true;
            clearTimeout(timer);
            const port = parseInt(match[1], 10);
            const state: DevServerState = {
              framework,
              command: fullCommand,
              url: `http://localhost:${port}`,
              port,
              pid: this.process?.pid ?? 0,
              managed: true,
            };
            this.state = state;
            this.emit("started", state);
            resolve(state);
            return;
          }
        }
      };

      this.process.stdout?.on("data", handleOutput);
      this.process.stderr?.on("data", (data: Buffer) => {
        this.emit("stderr", data.toString());
        handleOutput(data);
      });

      this.process.on("error", (err) => {
        clearTimeout(timer);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
        this.emit("error", err);
      });

      this.process.on("exit", () => {
        this.emit("stopped");
      });
    });
  }

  async stop(): Promise<void> {
    if (this.process && this.state?.managed) {
      this.process.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.process?.kill("SIGKILL");
          resolve();
        }, 3000);
        this.process?.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.process = null;
    this.state = null;
  }

  getState(): DevServerState | null {
    return this.state;
  }

  isRunning(): boolean {
    return this.state !== null;
  }
}
