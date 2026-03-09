#!/usr/bin/env node

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

const renderer = new TerminalRenderer();

const program = new Command();

program
  .name("yuan")
  .description("YUAN — Autonomous Coding Agent")
  .version("0.1.0");

// ─── Default: Interactive mode (TUI) ───
program
  .option("--classic", "Use classic readline REPL instead of full-screen TUI")
  .action(async (options: { classic?: boolean }) => {
    const configManager = new ConfigManager();
    const sessionManager = new SessionManager();

    if (!configManager.isConfigured()) {
      renderer.banner();
      renderer.warn("No API key configured. Starting setup...");
      await configManager.interactiveSetup();
      console.log();
    }

    // Use classic mode if requested or not a TTY
    if (options.classic || !process.stdout.isTTY) {
      const session = new InteractiveSession(
        renderer,
        sessionManager,
        configManager
      );
      await session.start();
      return;
    }

    // Full-screen TUI mode (default)
    const { launchTUI } = await import("./tui/App.js");
    const { AgentBridge } = await import("./tui/agent-bridge.js");
    const config = configManager.get();

    const bridge = new AgentBridge({
      provider: config.provider || "openai",
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
      workDir: process.cwd(),
    });

    launchTUI({
      version: "0.1.3",
      model: configManager.getModel(),
      provider: config.provider || "openai",
      bridge,
      onExit: () => {
        process.exit(0);
      },
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
  .argument("<provider>", "Provider: openai, anthropic, or google")
  .argument("<key>", "API key")
  .action((provider: string, key: string) => {
    const validProviders = ["openai", "anthropic", "google", "yua", "deepseek"] as const;
    if (!validProviders.includes(provider as typeof validProviders[number])) {
      renderer.error(`Invalid provider: ${provider}. Use: openai, anthropic, google, yua, or deepseek`);
      process.exit(1);
    }
    const configManager = new ConfigManager();
    configManager.setKey(provider as "openai" | "anthropic" | "google" | "yua" | "deepseek", key);
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
