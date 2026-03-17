#!/usr/bin/env node

// ─── Heap size guard ───────────────────────────────────────────────────────
// Linux env shebang doesn't support args (--max-old-space-size=4096).
// If NODE_OPTIONS doesn't include max-old-space-size, re-exec with it set.
if (!process.env.NODE_OPTIONS?.includes("max-old-space-size")) {
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync(process.execPath, process.argv.slice(1), {
      stdio: "inherit",
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=4096`.trim() },
    });
  } catch (e: unknown) {
    process.exit((e as { status?: number }).status ?? 1);
  }
  process.exit(0);
}

/**
 * YUAN CLI — Main Entry Point
 *
 * Usage:
 *   yuan                    → Interactive agent mode (default)
 *   yuan code <prompt>      → One-shot coding task
 *   yuan config             → BYOK key setup (interactive)
 *   yuan config set-key     → Set API key
 *   yuan config show        → Show current settings
 *   yuan resume             → Resume last session
 *   yuan --version          → Version
 *   yuan --help             → Help
 */

import { Command } from "commander";
import { ConfigManager } from "./config.js";
import { TerminalRenderer } from "./renderer.js";
import { InteractiveSession } from "./interactive.js";
import { SessionManager } from "./session.js";
import { runOneshot } from "./oneshot.js";
import { login, logout, getAuth } from "./auth.js";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function cliLog(msg: string): void {
  try {
    mkdirSync(join(homedir(), ".yuan"), { recursive: true });
    const line = `[${new Date().toISOString()}] [CLI] ${msg}\n`;
    appendFileSync(join(homedir(), ".yuan", "debug.log"), line);
  } catch { /* non-fatal */ }
}

// Module-level log: runs immediately on import
cliLog("cli.ts module loaded");

const require = createRequire(import.meta.url);
const PKG_VERSION: string = (require("../package.json") as { version: string }).version;

const renderer = new TerminalRenderer();

const program = new Command();

program
  .name("yuan")
  .description("YUAN — Coding Agent")
  .version(PKG_VERSION);

// ─── PID lock — kills zombie yuan on next launch ───────────────────────────

const YUAN_DIR = join(homedir(), ".yuan");
const PID_FILE = join(YUAN_DIR, "yuan.pid");

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killZombieYuan(): void {
  if (!existsSync(PID_FILE)) return;
  try {
    const raw = readFileSync(PID_FILE, "utf-8").trim();
    const pid = parseInt(raw, 10);
    if (!pid || pid === process.pid) return;

    if (isProcessAlive(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
      // Give it 800ms to die, then SIGKILL
      const deadline = Date.now() + 800;
      while (Date.now() < deadline && isProcessAlive(pid)) {
        // busy wait is fine — this is startup, runs once
      }
      if (isProcessAlive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
      }
    }
  } catch { /* corrupt PID file — ignore */ }
}

function writePidFile(): void {
  try {
    mkdirSync(YUAN_DIR, { recursive: true });
    writeFileSync(PID_FILE, String(process.pid), "utf-8");
  } catch { /* non-fatal */ }
}

function removePidFile(): void {
  try { unlinkSync(PID_FILE); } catch { /* already gone */ }
}

// ─── Default: Interactive mode ───
program
  .option("--classic", "Use classic readline REPL instead of stream renderer")
  .option("--tui-legacy", "Use legacy full-screen Ink TUI (deprecated)")
  .action(async (options: { classic?: boolean; tuiLegacy?: boolean }) => {
    // Kill any zombie yuan from a previous crashed session, then claim the PID slot
    cliLog("action start: killZombieYuan");
    killZombieYuan();
    cliLog("killZombieYuan done: writePidFile");
    writePidFile();
    cliLog("writePidFile done");
    // Clean up PID file on any exit (normal, crash, signal)
    const _cleanup = () => removePidFile();
    process.once("exit", _cleanup);
    process.once("SIGINT",  () => { removePidFile(); process.exit(130); });
    process.once("SIGTERM", () => { removePidFile(); process.exit(143); });
    process.once("uncaughtException", (err) => { removePidFile(); console.error(err); process.exit(1); });

    const configManager = new ConfigManager();
    const sessionManager = new SessionManager();
    cliLog(`isConfigured: ${configManager.isConfigured()}`);

    if (!configManager.isConfigured()) {
      renderer.banner();
      renderer.warn("No API key configured. Starting setup...");
      await configManager.interactiveSetup();
      console.log();
    }

    const config = configManager.get();

    cliLog(`isTTY: ${process.stdout.isTTY}, classic: ${options.classic}, tuiLegacy: ${options.tuiLegacy}`);

    // Classic mode: old readline REPL (for piped/non-TTY or explicit)
    if (options.classic || !process.stdout.isTTY) {
      const session = new InteractiveSession(
        renderer,
        sessionManager,
        configManager
      );
      await session.start();
      return;
    }

    // Legacy Ink TUI mode (deprecated — kept for --tui-legacy flag only)
    if (options.tuiLegacy) {
      cliLog("legacy TUI mode requested");
      try {
        if (process.stdin.isTTY && (process.stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw) {
          process.stdin.setRawMode(false);
        }
        const { execSync } = await import("node:child_process");
        execSync("stty sane 2>/dev/null", { stdio: "inherit" });
      } catch { /* non-TTY or stty unavailable */ }

      const { launchTUI } = await import("./tui/App.js");
      const { AgentBridge } = await import("./tui/agent-bridge.js");
      const bridge = new AgentBridge({
        provider: config.provider || "openai",
        apiKey: config.apiKey,
        apiKeys: config.apiKeys,
        model: config.model,
        baseUrl: config.baseUrl,
        workDir: process.cwd(),
      });
      launchTUI({
        version: PKG_VERSION,
        model: configManager.getModel(),
        provider: config.provider || "openai",
        bridge,
        configManager,
        onExit: () => { process.exit(0); },
      });
      return;
    }

    // ── Default: Native stream renderer (NEW — no Ink, no Yoga) ──
    cliLog("stream renderer mode (default)");
    const { AgentBridge } = await import("./tui/agent-bridge.js");
    const { launchStreamRenderer } = await import("./stream-renderer.js");

    const bridge = new AgentBridge({
      provider: config.provider || "openai",
      apiKey: config.apiKey,
      apiKeys: config.apiKeys,
      model: config.model,
      baseUrl: config.baseUrl,
      workDir: process.cwd(),
    });

    cliLog("bridge created, launching stream renderer...");
    launchStreamRenderer({
      version: PKG_VERSION,
      model: configManager.getModel(),
      provider: config.provider || "openai",
      bridge,
      configManager,
      onExit: () => { process.exit(0); },
    });
  });

// ─── yuan code <prompt> / yuan run <prompt> ───
const oneshotAction = async (prompt: string, options: { model?: string }): Promise<void> => {
  const exitCode = await runOneshot(prompt, options);
  process.exit(exitCode);
};

program
  .command("code")
  .description("Run a one-shot coding task")
  .argument("<prompt>", "The coding task to execute")
  .option("-m, --model <model>", "Override the default model")
  .action(oneshotAction);

program
  .command("run")
  .description("Run a one-shot coding task (alias for 'code')")
  .argument("<prompt>", "The coding task to execute")
  .option("-m, --model <model>", "Override the default model")
  .action(oneshotAction);

// ─── yuan config ───
const configCmd = program
  .command("config")
  .description("Manage YUAN configuration");

configCmd
  .action(async () => {
    const configManager = new ConfigManager();
    await configManager.interactiveSetup();
  });

configCmd
  .command("set-key")
  .description("Set API key for a provider")
  .argument("<provider>", "Provider: openai, anthropic, yua, or google")
  .argument("<key>", "API key")
  .action((provider: string, key: string) => {
    const validProviders = ["openai", "anthropic", "yua", "google"] as const;
    if (!validProviders.includes(provider as typeof validProviders[number])) {
      renderer.error(`Invalid provider: ${provider}. Use: openai, anthropic, yua, or google`);
      process.exit(1);
    }
    const configManager = new ConfigManager();
    configManager.setKey(provider as "openai" | "anthropic" | "yua" | "google", key);
    renderer.success(`API key saved for ${provider}`);
  });

configCmd
  .command("show")
  .description("Show current configuration")
  .action(() => {
    const configManager = new ConfigManager();
    console.log();
    console.log(configManager.show());
    console.log();
  });

configCmd
  .command("set-mode")
  .description("Set execution mode: local or cloud")
  .argument("<mode>", "Mode: local or cloud")
  .action((mode: string) => {
    if (mode !== "local" && mode !== "cloud") {
      renderer.error(`Invalid mode: ${mode}. Use: local or cloud`);
      process.exit(1);
    }
    const configManager = new ConfigManager();
    configManager.setMode(mode);
    renderer.success(`Mode set to ${mode}`);
  });

configCmd
  .command("set-server")
  .description("Set cloud server URL")
  .argument("<url>", "Server URL (e.g. https://api.yuaone.com)")
  .action((url: string) => {
    const configManager = new ConfigManager();
    configManager.setServerUrl(url);
    renderer.success(`Server URL set to ${url}`);
  });

// ─── yuan resume ───
program
  .command("resume")
  .description("Resume the last agent session")
  .option("--id <sessionId>", "Resume a specific session by ID")
  .option("--list", "List recent sessions")
  .action(async (options: { id?: string; list?: boolean }) => {
    const configManager = new ConfigManager();
    const sessionManager = new SessionManager();

    // List mode
    if (options.list) {
      const sessions = sessionManager.listRecent(10);
      if (sessions.length === 0) {
        renderer.info("No saved sessions found.");
        process.exit(0);
      }

      console.log();
      renderer.info("Recent Sessions:");
      console.log("  " + "-".repeat(72));
      for (const s of sessions) {
        const statusIcon = {
          running: "\u25B6",
          paused: "\u23F8",
          completed: "\u2713",
          crashed: "\u2717",
        }[s.status] ?? "?";
        const date = new Date(s.updatedAt).toLocaleString();
        const dir = s.workDir.length > 30
          ? "..." + s.workDir.slice(-27)
          : s.workDir;
        console.log(
          `  ${statusIcon} ${s.id.slice(0, 8)}  ${s.status.padEnd(10)} ${date}  ${dir}  (${s.messages.length} msgs, iter ${s.iteration})`
        );
      }
      console.log();
      renderer.info("Use `yuan resume --id <sessionId>` to resume a specific session.");
      process.exit(0);
    }

    // Resume mode
    const session = options.id
      ? sessionManager.load(options.id)
      : sessionManager.loadLast();

    if (!session) {
      renderer.error("No session to resume. Start a new session with `yuan`.");
      renderer.info("Use `yuan resume --list` to see available sessions.");
      process.exit(1);
    }

    const statusLabel = session.status === "crashed"
      ? " (recovering from crash)"
      : session.status === "paused"
        ? " (paused)"
        : "";

    renderer.info(`Resuming session ${session.id.slice(0, 8)}...${statusLabel}`);
    renderer.info(`Status: ${session.status} | Messages: ${session.messages.length} | Iterations: ${session.iteration}`);
    renderer.info(`Tokens used: ${session.tokenUsage.input + session.tokenUsage.output} (in: ${session.tokenUsage.input}, out: ${session.tokenUsage.output})`);

    // Mark session as running
    await sessionManager.updateStatus(session, "running");

    const interactive = new InteractiveSession(
      renderer,
      sessionManager,
      configManager,
      session
    );
    await interactive.start();
  });

// ─── yuan benchmark ───
program
  .command("benchmark")
  .description("Run YUAN agent benchmarks against a task suite")
  .argument("[config]", "Path to benchmark config JSON, or 'sample' to run built-in sample tasks")
  .option("--results-dir <dir>", "Directory to save results", ".yuan/benchmarks")
  .option("--no-save", "Do not save results to disk")
  .option("--no-baseline", "Skip baseline comparison")
  .option("--report", "Print Markdown report to stdout after run")
  .option("--concurrent <n>", "Max concurrent tasks (default 1)", parseInt)
  .action(async (configArg: string | undefined, options: {
    resultsDir: string;
    save: boolean;
    baseline: boolean;
    report: boolean;
    concurrent?: number;
  }) => {
    const { BenchmarkRunner } = await import("@yuaone/core");

    const runner = new BenchmarkRunner({
      resultsDir: options.resultsDir,
      maxConcurrent: options.concurrent ?? 1,
      saveResults: options.save,
      compareBaseline: options.baseline,
    });

    // Load tasks: 'sample' or path to JSON file
    let tasks: import("@yuaone/core").BenchmarkTask[] = [];

    if (!configArg || configArg === "sample") {
      tasks = BenchmarkRunner.getSampleTasks();
      console.log(`\nRunning ${tasks.length} built-in sample tasks...\n`);
    } else {
      const { readFile } = await import("node:fs/promises");
      try {
        const raw = await readFile(configArg, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          tasks = parsed;
        } else if (parsed.tasks && Array.isArray(parsed.tasks)) {
          tasks = parsed.tasks;
        } else {
          console.error(`Error: config must be a JSON array of tasks or { tasks: [...] }`);
          process.exit(1);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error loading benchmark config: ${msg}`);
        process.exit(1);
      }
      console.log(`\nLoaded ${tasks.length} benchmark tasks from ${configArg}\n`);
    }

    // Note: BenchmarkRunner does not call AgentLoop directly (no circular dep).
    // Without an agent result map, tasks will report 'no_execution'.
    // For a full run, integrate AgentLoop externally and pass taskResults map.
    const summary = await runner.runSuite(tasks);

    // Print summary
    console.log(`\nBenchmark Results:`);
    console.log(`  Total:    ${summary.totalTasks}`);
    console.log(`  Passed:   ${summary.passed}`);
    console.log(`  Failed:   ${summary.failed}`);
    console.log(`  Rate:     ${(summary.successRate * 100).toFixed(1)}%`);
    console.log(`  Est Cost: $${summary.totalCostEstimateUSD.toFixed(4)}`);

    if (summary.regressions.length > 0) {
      console.log(`\n  Regressions: ${summary.regressions.join(", ")}`);
    }
    if (summary.improvements.length > 0) {
      console.log(`  Improvements: ${summary.improvements.join(", ")}`);
    }

    if (options.report) {
      console.log("\n" + runner.generateReport(summary));
    }

    if (options.save) {
      const savedPath = await runner.saveResults(summary);
      console.log(`\nResults saved to: ${savedPath}`);
    }

    process.exit(summary.failed > 0 ? 1 : 0);
  });

// ─── yuan design ───
program
  .command("design")
  .description("Enter Design Mode — AI-powered real-time design collaboration")
  .option("-p, --port <port>", "Dev server port", parseInt)
  .option("--auto-vision", "Auto-capture screenshot after every change")
  .option("--viewport <preset>", "Viewport preset: mobile, tablet, desktop")
  .option("--dev-command <cmd>", "Custom dev server command")
  .action(async (options) => {
    const { runDesignMode } = await import("./design.js");
    await runDesignMode(options);
  });

// ─── yuan login ───
program
  .command("login")
  .description("Login to YUA Platform")
  .option("--url <url>", "Platform URL", "https://platform.yuaone.com")
  .action(async (opts: { url: string }) => {
    await login(opts.url);
  });

// ─── yuan logout ───
program
  .command("logout")
  .description("Logout from YUA Platform")
  .action(async () => {
    await logout();
  });

// ─── yuan whoami ───
program
  .command("whoami")
  .description("Show current user info")
  .action(async () => {
    const auth = await getAuth();
    if (!auth) {
      console.log("Not logged in. Run: yuan login");
      return;
    }
    console.log(`${auth.user.email} (${auth.plan.name})`);
  });

program.parse();
