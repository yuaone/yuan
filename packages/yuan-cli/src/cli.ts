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

const renderer = new TerminalRenderer();

const program = new Command();

program
  .name("yuan")
  .description("YUAN — Autonomous Coding Agent")
  .version("0.1.0");

// ─── Default: Interactive mode ───
program
  .action(async () => {
    const configManager = new ConfigManager();
    const sessionManager = new SessionManager();

    if (!configManager.isConfigured()) {
      renderer.banner();
      renderer.warn("No API key configured. Starting setup...");
      await configManager.interactiveSetup();
      console.log();
    }

    const session = new InteractiveSession(
      renderer,
      sessionManager,
      configManager
    );
    await session.start();
  });

// ─── yuan code <prompt> ───
program
  .command("code")
  .description("Run a one-shot coding task")
  .argument("<prompt>", "The coding task to execute")
  .option("-m, --model <model>", "Override the default model")
  .action(async (prompt: string, options: { model?: string }) => {
    const exitCode = await runOneshot(prompt, options);
    process.exit(exitCode);
  });

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
    const validProviders = ["openai", "anthropic", "google"] as const;
    if (!validProviders.includes(provider as typeof validProviders[number])) {
      renderer.error(`Invalid provider: ${provider}. Use: openai, anthropic, or google`);
      process.exit(1);
    }
    const configManager = new ConfigManager();
    configManager.setKey(provider as "openai" | "anthropic" | "google", key);
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

// ─── yuan resume ───
program
  .command("resume")
  .description("Resume the last agent session")
  .option("--id <sessionId>", "Resume a specific session by ID")
  .action(async (options: { id?: string }) => {
    const configManager = new ConfigManager();
    const sessionManager = new SessionManager();

    const session = options.id
      ? sessionManager.load(options.id)
      : sessionManager.loadLast();

    if (!session) {
      renderer.error("No session to resume. Start a new session with `yuan`.");
      process.exit(1);
    }

    renderer.info(`Resuming session ${session.id.slice(0, 8)}...`);
    renderer.info(`Messages in history: ${session.messages.length}`);

    const interactive = new InteractiveSession(
      renderer,
      sessionManager,
      configManager,
      session
    );
    await interactive.start();
  });

program.parse();
