/**
 * YUAN CLI — Interactive Mode
 *
 * REPL loop for interactive agent sessions.
 * Supports slash commands, multiline input, and streaming responses.
 */

import * as readline from "node:readline";
import { TerminalRenderer, colors } from "./renderer.js";
import { SessionManager, type SessionData } from "./session.js";
import { ConfigManager } from "./config.js";

const ESC = "\x1b[";

function c(color: string, text: string): string {
  return `${color}${text}${ESC}0m`;
}

/** Slash commands available in interactive mode */
const SLASH_COMMANDS: Record<string, string> = {
  "/help": "Show this help message",
  "/clear": "Clear the screen",
  "/undo": "Undo the last agent action",
  "/diff": "Show current file changes",
  "/quit": "Exit YUAN (also: Ctrl+C)",
  "/config": "Show current configuration",
  "/session": "Show session info",
};

/**
 * InteractiveSession — the main REPL for `yuan` interactive mode
 */
export class InteractiveSession {
  private renderer: TerminalRenderer;
  private sessionManager: SessionManager;
  private configManager: ConfigManager;
  private session: SessionData;
  private rl: readline.Interface | null = null;
  private isRunning = false;

  constructor(
    renderer: TerminalRenderer,
    sessionManager: SessionManager,
    configManager: ConfigManager,
    existingSession?: SessionData
  ) {
    this.renderer = renderer;
    this.sessionManager = sessionManager;
    this.configManager = configManager;

    const config = this.configManager.get();
    this.session =
      existingSession ??
      this.sessionManager.create(
        process.cwd(),
        config.provider,
        this.configManager.getModel()
      );
  }

  /** Start the interactive REPL */
  async start(): Promise<void> {
    this.isRunning = true;

    this.renderer.banner();
    this.renderer.info(
      `Provider: ${c(colors.cyan, this.session.provider)} | Model: ${c(colors.cyan, this.session.model)}`
    );
    this.renderer.info(
      `Working directory: ${c(colors.dim, this.session.workDir)}`
    );
    this.renderer.info(
      `Session: ${c(colors.dim, this.session.id.slice(0, 8))}`
    );
    console.log(
      c(colors.dim, "  Type /help for commands, Ctrl+C to exit\n")
    );

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: c(colors.cyan + colors.bold, "❯ "),
    });

    // Handle Ctrl+C gracefully
    this.rl.on("close", () => {
      this.stop();
    });

    this.rl.on("SIGINT", () => {
      console.log(c(colors.dim, "\n  (Ctrl+C) Stopping..."));
      this.stop();
    });

    // REPL loop
    return new Promise<void>((resolve) => {
      const promptNext = (): void => {
        if (!this.isRunning || !this.rl) {
          resolve();
          return;
        }
        this.rl.question(c(colors.cyan + colors.bold, "❯ "), async (input) => {
          const trimmed = input.trim();

          if (!trimmed) {
            promptNext();
            return;
          }

          // Handle slash commands
          if (trimmed.startsWith("/")) {
            const shouldContinue = this.handleSlashCommand(trimmed);
            if (!shouldContinue) {
              resolve();
              return;
            }
            promptNext();
            return;
          }

          // Process user input as agent message
          await this.processMessage(trimmed);
          promptNext();
        });
      };

      promptNext();
    });
  }

  /** Handle a slash command. Returns false if session should end. */
  private handleSlashCommand(command: string): boolean {
    const cmd = command.toLowerCase().split(" ")[0];

    switch (cmd) {
      case "/help":
        this.showHelp();
        return true;

      case "/clear":
        console.clear();
        this.renderer.banner();
        return true;

      case "/undo":
        this.renderer.warn("Undo is not yet implemented (requires @yuan/core)");
        return true;

      case "/diff":
        this.renderer.warn("Diff view is not yet implemented (requires @yuan/tools)");
        return true;

      case "/quit":
      case "/exit":
      case "/q":
        this.stop();
        return false;

      case "/config":
        console.log();
        console.log(this.configManager.show());
        console.log();
        return true;

      case "/session":
        this.showSessionInfo();
        return true;

      default:
        this.renderer.warn(`Unknown command: ${cmd}. Type /help for available commands.`);
        return true;
    }
  }

  /** Show available slash commands */
  private showHelp(): void {
    console.log();
    console.log(c(colors.bold, "  Available Commands"));
    console.log(c(colors.dim, "  " + "─".repeat(40)));
    for (const [cmd, desc] of Object.entries(SLASH_COMMANDS)) {
      console.log(
        `  ${c(colors.cyan, cmd.padEnd(12))} ${c(colors.dim, desc)}`
      );
    }
    console.log();
  }

  /** Show current session info */
  private showSessionInfo(): void {
    const s = this.session;
    console.log();
    console.log(c(colors.bold, "  Session Info"));
    console.log(c(colors.dim, "  " + "─".repeat(40)));
    console.log(`  ID       : ${c(colors.dim, s.id)}`);
    console.log(`  Created  : ${c(colors.dim, new Date(s.createdAt).toLocaleString())}`);
    console.log(`  Messages : ${c(colors.dim, String(s.messages.length))}`);
    console.log(`  Work Dir : ${c(colors.dim, s.workDir)}`);
    console.log();
  }

  /**
   * Process a user message.
   * Currently a stub — full agent loop requires @yuan/core.
   */
  private async processMessage(message: string): Promise<void> {
    // Save user message
    this.sessionManager.addMessage(this.session, "user", message);

    // Simulate agent thinking
    const spinner = this.renderer.thinking();

    // Stub response — will be replaced by actual agent loop
    await new Promise((resolve) => setTimeout(resolve, 500));
    spinner.stop();

    const response =
      "Agent loop is not yet connected. " +
      "The @yuan/core package needs to be implemented to enable LLM-powered responses. " +
      "Your message has been saved to the session.";

    console.log();
    this.renderer.agentResponse(response);

    // Save assistant response
    this.sessionManager.addMessage(this.session, "assistant", response);
  }

  /** Stop the interactive session */
  private stop(): void {
    this.isRunning = false;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    console.log(c(colors.dim, "\n  Session saved. Run `yuan resume` to continue.\n"));
  }
}
