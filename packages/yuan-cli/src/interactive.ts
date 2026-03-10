/**
 * YUAN CLI — Interactive Mode
 *
 * REPL loop for interactive agent sessions.
 * Supports slash commands, multiline input, and streaming responses.
 * Wired to @yuaone/core AgentLoop + @yuaone/tools for real LLM-powered execution.
 */

import * as readline from "node:readline";
import { TerminalRenderer, colors } from "./renderer.js";
import { SessionManager, type SessionData } from "./session.js";
import { ConfigManager } from "./config.js";
import {
  AgentLoop,
  BYOKClient,
  DEFAULT_LOOP_CONFIG,
  type AgentEvent,
  type AgentConfig,
  type BYOKConfig,
  type ApprovalRequest,
  type ApprovalResponse,
} from "@yuaone/core";
import { createDefaultRegistry } from "@yuaone/tools";
import { CloudClient, type AgentEvent as CloudAgentEvent } from "./cloud-client.js";
import { executeCommand, type CommandContext } from "./commands/index.js";

const ESC = "\x1b[";

function c(color: string, text: string): string {
  return `${color}${text}${ESC}0m`;
}

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
  private isStreaming = false;
  /** Track files changed during the session for /diff and /undo */
  private changedFiles: string[] = [];

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
      prompt: c(colors.cyan + colors.bold, ">>> "),
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
        this.rl.question(c(colors.cyan + colors.bold, ">>> "), async (input) => {
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
    const ctx: CommandContext = {
      output: (msg) => console.log(msg),
      config: this.configManager,
      version: "0.1.3",
      provider: this.session.provider,
      model: this.session.model,
      workDir: this.session.workDir,
      filesChanged: this.changedFiles,
      agentInfo: {
        status: this.isStreaming ? "streaming" : "idle",
        messageCount: this.session.messages.length,
        totalTokens: 0,
        tokensPerSecond: 0,
      },
      sessionInfo: {
        id: this.session.id,
        createdAt: this.session.createdAt,
      },
      onModelChange: (newModel) => {
        this.session.model = newModel;
        console.log(`Model changed to: ${newModel}`);
      },
      onModeChange: (newMode) => {
        console.log(`Mode changed to: ${newMode}`);
      },
    };

    const result = executeCommand(ctx, command);
    if (!result) {
      this.renderer.warn(`Unknown command: ${command}. Type /help for available commands.`);
      return true;
    }
    if (result.exit) {
      this.stop();
      return false;
    }
    if (result.clear) {
      console.clear();
      this.renderer.banner();
      return true;
    }
    if (result.output) {
      console.log();
      console.log(result.output);
      console.log();
    }
    return true;
  }

  /**
   * Process a user message — dispatches to local or cloud mode.
   */
  private async processMessage(message: string): Promise<void> {
    if (this.configManager.isCloudMode()) {
      return this.processMessageCloud(message);
    }
    return this.processMessageLocal(message);
  }

  /**
   * Process a user message via CloudClient (cloud mode).
   * Starts a remote session, streams SSE events, handles approvals.
   */
  private async processMessageCloud(message: string): Promise<void> {
    this.sessionManager.addMessage(this.session, "user", message);

    const config = this.configManager.get();
    if (!config.apiKey) {
      this.renderer.error("No API key configured. Run `yuan config` to set up.");
      return;
    }

    const client = new CloudClient(config.serverUrl, config.apiKey);
    const abortController = new AbortController();

    // Handle SIGINT during cloud streaming
    const sigintHandler = (): void => {
      abortController.abort();
    };
    process.on("SIGINT", sigintHandler);

    const spinner = this.renderer.thinking();
    this.isStreaming = false;
    let cloudSessionId: string | undefined;

    try {
      // Start remote session
      const { sessionId } = await client.startSession(message, {
        workDir: this.session.workDir,
        model: config.model,
      });
      cloudSessionId = sessionId;

      // Stream events
      await client.streamEvents(sessionId, (event: CloudAgentEvent) => {
        switch (event.kind) {
          case "thinking":
            if (!this.isStreaming) {
              spinner.update(event.content);
            }
            break;

          case "text_delta":
            if (!this.isStreaming) {
              spinner.stop();
              this.isStreaming = true;
              console.log();
            }
            this.renderer.streamToken(event.text);
            break;

          case "tool_call":
            if (this.isStreaming) {
              this.renderer.endStream();
              this.isStreaming = false;
            } else {
              spinner.stop();
            }
            this.renderer.toolCall(
              event.tool,
              typeof event.input === "string"
                ? event.input.slice(0, 100)
                : JSON.stringify(event.input, null, 0).slice(0, 100),
            );
            break;

          case "tool_result":
            this.renderer.toolResult(event.output);
            break;

          case "approval_needed":
            if (this.isStreaming) {
              this.renderer.endStream();
              this.isStreaming = false;
            } else {
              spinner.stop();
            }
            this.renderer.warn(
              `Approval required: ${event.description} [${event.risk}]`,
            );
            // Prompt user and send approval
            void this.promptCloudApproval(client, sessionId, event.actionId, event.tool).then(() => {
              // Approval sent — stream will continue via SSE
            });
            break;

          case "error":
            if (this.isStreaming) {
              this.renderer.endStream();
              this.isStreaming = false;
            } else {
              spinner.stop();
            }
            this.renderer.error(event.message);
            break;

          case "done":
            if (this.isStreaming) {
              this.renderer.endStream();
              this.isStreaming = false;
            } else {
              spinner.stop();
            }
            break;

          case "status_change":
            // Silent — could log if verbose
            break;
        }
      }, { signal: abortController.signal });

      spinner.stop();
      if (this.isStreaming) {
        this.renderer.endStream();
        this.isStreaming = false;
      }

      this.sessionManager.addMessage(this.session, "assistant", "[cloud session completed]");
    } catch (err) {
      spinner.stop();
      if (this.isStreaming) {
        this.renderer.endStream();
        this.isStreaming = false;
      }

      // If aborted (SIGINT), try to stop remote session
      if (err instanceof DOMException && err.name === "AbortError") {
        if (cloudSessionId) {
          await client.stop(cloudSessionId).catch(() => {});
        }
        this.renderer.info("Cancelled.");
        this.sessionManager.addMessage(this.session, "assistant", "[cancelled]");
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.renderer.error(`Cloud error: ${errorMsg}`);
        this.sessionManager.addMessage(this.session, "assistant", `[ERROR] ${errorMsg}`);
      }
    } finally {
      process.removeListener("SIGINT", sigintHandler);
    }
  }

  /**
   * Prompt the user for cloud-mode approval and send response to server.
   */
  private async promptCloudApproval(
    client: CloudClient,
    sessionId: string,
    actionId: string,
    toolName: string,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const approvalRl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      approvalRl.question(
        `\x1b[33m\x1b[1m  Approve? [Y/n] \x1b[0m`,
        async (answer) => {
          approvalRl.close();
          const trimmed = answer.trim().toLowerCase();
          const approved = trimmed !== "n" && trimmed !== "no";

          try {
            await client.approve(sessionId, actionId, {
              approved,
              message: approved ? undefined : "User rejected",
            });
          } catch (err) {
            this.renderer.error(`Approval send failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          resolve();
        },
      );
    });
  }

  /**
   * Process a user message through the local AgentLoop.
   * Creates BYOKClient + ToolExecutor, runs AgentLoop.run(), and renders events.
   */
  private async processMessageLocal(message: string): Promise<void> {
    // Save user message
    this.sessionManager.addMessage(this.session, "user", message);

    const config = this.configManager.get();

    // Check API key
    if (!config.apiKey) {
      this.renderer.error("No API key configured. Run `yuan config` to set up.");
      return;
    }

    // Build BYOK config
    const byokConfig: BYOKConfig = {
      provider: config.provider as "openai" | "anthropic" | "yua",
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
    };

    // Create tool registry and executor
    const registry = createDefaultRegistry();
    const workDir = this.session.workDir;
    const toolExecutor = registry.toExecutor(workDir);

    // Build agent config
    const agentConfig: AgentConfig = {
      byok: byokConfig,
      loop: {
        model: "coding",
        maxIterations: DEFAULT_LOOP_CONFIG.maxIterations,
        maxTokensPerIteration: DEFAULT_LOOP_CONFIG.maxTokensPerIteration,
        totalTokenBudget: DEFAULT_LOOP_CONFIG.totalTokenBudget,
        tools: toolExecutor.definitions,
        systemPrompt:
          "You are YUAN, an autonomous coding agent. " +
          "You have access to tools for reading, writing, editing files, running shell commands, and searching code. " +
          "Complete the user's coding tasks efficiently and correctly.",
        projectPath: workDir,
      },
    };

    // Create and run AgentLoop with approval handler
    const loop = new AgentLoop({
      config: agentConfig,
      toolExecutor,
      governorConfig: { planTier: "LOCAL" },
      approvalHandler: (request) => this.promptApproval(request),
      autoFixConfig: { maxRetries: 3, autoLint: true, autoBuild: true, autoTest: false },
    });

    // Listen to events for rendering
    const spinner = this.renderer.thinking();
    this.isStreaming = false;

    loop.on("event", (event: AgentEvent) => {
      switch (event.kind) {
        case "agent:thinking":
          if (!this.isStreaming) {
            spinner.update(event.content);
          }
          break;

        case "agent:text_delta":
          // Real-time streaming: stop spinner, write tokens directly
          if (!this.isStreaming) {
            spinner.stop();
            this.isStreaming = true;
            console.log(); // blank line before streaming output
          }
          this.renderer.streamToken(event.text);
          break;

        case "agent:tool_call":
          if (this.isStreaming) {
            this.renderer.endStream();
            this.isStreaming = false;
          } else {
            spinner.stop();
          }
          this.renderer.toolCall(
            event.tool,
            typeof event.input === "string"
              ? event.input.slice(0, 100)
              : JSON.stringify(event.input, null, 0).slice(0, 100)
          );
          break;

        case "agent:tool_result":
          this.renderer.toolResult(event.output);
          break;

        case "agent:file_change":
          // Track changed files for /undo and /diff
          if (!this.changedFiles.includes(event.path)) {
            this.changedFiles.push(event.path);
          }
          break;

        case "agent:error":
          if (this.isStreaming) {
            this.renderer.endStream();
            this.isStreaming = false;
          } else {
            spinner.stop();
          }
          this.renderer.error(event.message);
          break;

        case "agent:completed": {
          const wasStreaming = this.isStreaming;
          if (this.isStreaming) {
            this.renderer.endStream();
            this.isStreaming = false;
          } else {
            spinner.stop();
          }
          if (!wasStreaming) {
            console.log();
          }
          break;
        }

        case "agent:approval_needed":
          if (this.isStreaming) {
            this.renderer.endStream();
            this.isStreaming = false;
          } else {
            spinner.stop();
          }
          this.renderer.warn(
            `Approval required: ${event.action.description} [${event.action.risk}]`
          );
          break;

        case "agent:token_usage":
          // Silent tracking — could display in /session later
          break;

        default:
          break;
      }
    });

    try {
      const result = await loop.run(message);

      // Ensure spinner/stream is stopped
      if (this.isStreaming) {
        this.renderer.endStream();
        this.isStreaming = false;
      }
      spinner.stop();

      // Handle non-completed results
      if (result.reason !== "GOAL_ACHIEVED") {
        switch (result.reason) {
          case "MAX_ITERATIONS":
            this.renderer.warn(`Reached iteration limit: ${result.lastState}`);
            break;
          case "BUDGET_EXHAUSTED":
            this.renderer.warn(`Token budget exhausted: ${result.tokensUsed} tokens used`);
            break;
          case "USER_CANCELLED":
            this.renderer.info("Cancelled.");
            break;
          case "ERROR":
            this.renderer.error(`Agent error: ${result.error}`);
            break;
          case "NEEDS_APPROVAL":
            this.renderer.warn(`Approval needed: ${result.action.description}`);
            break;
        }
      }

      // Save assistant response summary
      const summary =
        result.reason === "GOAL_ACHIEVED"
          ? result.summary
          : `[${result.reason}]`;
      this.sessionManager.addMessage(this.session, "assistant", summary);
    } catch (err) {
      if (this.isStreaming) {
        this.renderer.endStream();
        this.isStreaming = false;
      }
      spinner.stop();
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.renderer.error(`Unexpected error: ${errorMsg}`);
      this.sessionManager.addMessage(this.session, "assistant", `[ERROR] ${errorMsg}`);
    }
  }

  /**
   * Prompt the user for approval of a dangerous action.
   * Shows the action details and waits for Y/N/A input.
   *
   * @param request The approval request from ApprovalManager
   * @returns 'approve', 'reject', or 'always_approve'
   */
  private async promptApproval(
    request: ApprovalRequest,
  ): Promise<ApprovalResponse> {
    const riskColor =
      request.riskLevel === "critical"
        ? colors.red
        : request.riskLevel === "high"
          ? colors.yellow
          : colors.cyan;

    console.log();
    console.log(
      c(colors.bold + riskColor, `  [${request.riskLevel.toUpperCase()}] Approval Required`)
    );
    console.log(c(colors.dim, "  " + "-".repeat(50)));
    console.log(`  ${c(colors.bold, "Tool:")}   ${c(colors.yellow, request.toolName)}`);
    console.log(`  ${c(colors.bold, "Reason:")} ${request.reason}`);

    if (request.diff) {
      console.log(c(colors.dim, "  Preview:"));
      const diffLines = request.diff.split("\n").slice(0, 10);
      for (const line of diffLines) {
        const lineColor = line.startsWith("+")
          ? colors.green
          : line.startsWith("-")
            ? colors.red
            : colors.dim;
        console.log(`  ${c(colors.dim, "|")} ${c(lineColor, line)}`);
      }
      if (request.diff.split("\n").length > 10) {
        console.log(c(colors.dim, "  | ... (truncated)"));
      }
    }

    console.log();
    console.log(
      c(colors.dim, "  [Y] Approve  [N] Reject  [A] Always approve this tool")
    );

    return new Promise<ApprovalResponse>((resolve) => {
      // Create a temporary readline interface for approval prompt
      const approvalRl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      approvalRl.question(
        c(colors.yellow + colors.bold, "  Approve? [Y/n/a] "),
        (answer) => {
          approvalRl.close();

          const trimmed = answer.trim().toLowerCase();
          if (trimmed === "n" || trimmed === "no") {
            this.renderer.info("Action rejected.");
            resolve("reject");
          } else if (trimmed === "a" || trimmed === "always") {
            this.renderer.success(
              `Always approving '${request.toolName}' for this session.`
            );
            resolve("always_approve");
          } else {
            this.renderer.success("Action approved.");
            resolve("approve");
          }
        },
      );
    });
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
