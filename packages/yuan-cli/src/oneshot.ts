/**
 * YUAN CLI — One-shot Mode
 *
 * Executes a single coding task and exits.
 * Usage: yuan code "Add error handling to auth.ts"
 */

import { TerminalRenderer } from "./renderer.js";
import { SessionManager } from "./session.js";
import { ConfigManager } from "./config.js";
import {
  AgentLoop,
  DEFAULT_LOOP_CONFIG,
  type AgentEvent,
  type AgentConfig,
  type BYOKConfig,
} from "@yuan/core";
import { createDefaultRegistry } from "@yuan/tools";

const ESC = "\x1b[";

function c(color: string, text: string): string {
  return `${color}${text}${ESC}0m`;
}

/**
 * Run a one-shot coding task.
 *
 * @param prompt - The coding task prompt
 * @param options - Command options (model override, etc.)
 * @returns Exit code (0 = success, 1 = failure)
 */
export async function runOneshot(
  prompt: string,
  options: { model?: string } = {}
): Promise<number> {
  const renderer = new TerminalRenderer();
  const configManager = new ConfigManager();
  const sessionManager = new SessionManager();

  // Check if API key is configured
  if (!configManager.isConfigured()) {
    renderer.error("No API key configured. Run `yuan config` to set up.");
    return 1;
  }

  const config = configManager.get();
  const model = options.model ?? configManager.getModel();

  renderer.banner();
  renderer.info(`Provider: ${config.provider} | Model: ${model}`);
  renderer.info(`Task: ${prompt}`);
  renderer.separator();

  // Create a session for this one-shot
  const session = sessionManager.create(process.cwd(), config.provider, model);
  sessionManager.addMessage(session, "user", prompt);

  // Build BYOK config
  const byokConfig: BYOKConfig = {
    provider: config.provider as "openai" | "anthropic" | "google",
    apiKey: config.apiKey,
    model: options.model ?? config.model,
    baseUrl: config.baseUrl,
  };

  // Create tool registry and executor
  const registry = createDefaultRegistry();
  const workDir = process.cwd();
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
        "Complete the user's coding task efficiently and correctly, then stop.",
      projectPath: workDir,
    },
  };

  // Create and run AgentLoop
  const loop = new AgentLoop({
    config: agentConfig,
    toolExecutor,
    governorConfig: { planTier: "FREE" },
  });

  // Handle SIGINT gracefully — restore cursor and exit
  const sigintHandler = (): void => {
    process.stdout.write("\x1b[?25h"); // restore cursor
    renderer.info("\nInterrupted.");
    process.exit(130);
  };
  process.on("SIGINT", sigintHandler);

  const spinner = renderer.thinking();
  let isStreaming = false;

  loop.on("event", (event: AgentEvent) => {
    switch (event.kind) {
      case "agent:thinking":
        if (!isStreaming) {
          spinner.update(event.content);
        }
        break;

      case "agent:text_delta":
        if (!isStreaming) {
          spinner.stop();
          isStreaming = true;
          console.log();
        }
        renderer.streamToken(event.text);
        break;

      case "agent:tool_call":
        if (isStreaming) {
          renderer.endStream();
          isStreaming = false;
        } else {
          spinner.stop();
        }
        renderer.toolCall(
          event.tool,
          typeof event.input === "string"
            ? event.input.slice(0, 100)
            : JSON.stringify(event.input, null, 0).slice(0, 100)
        );
        break;

      case "agent:tool_result":
        renderer.toolResult(event.output);
        break;

      case "agent:error":
        if (isStreaming) {
          renderer.endStream();
          isStreaming = false;
        } else {
          spinner.stop();
        }
        renderer.error(event.message);
        break;

      case "agent:completed": {
        const wasStreaming = isStreaming;
        if (isStreaming) {
          renderer.endStream();
          isStreaming = false;
        } else {
          spinner.stop();
        }
        if (!wasStreaming) {
          console.log();
        }
        break;
      }

      default:
        break;
    }
  });

  try {
    const result = await loop.run(prompt);
    if (isStreaming) {
      renderer.endStream();
      isStreaming = false;
    }
    spinner.stop();

    if (result.reason === "GOAL_ACHIEVED") {
      renderer.success("Task completed.");
      sessionManager.addMessage(session, "assistant", result.summary);
      return 0;
    }

    // Non-success termination
    switch (result.reason) {
      case "MAX_ITERATIONS":
        renderer.warn(`Reached iteration limit: ${result.lastState}`);
        break;
      case "BUDGET_EXHAUSTED":
        renderer.warn(`Token budget exhausted: ${result.tokensUsed} tokens used`);
        break;
      case "ERROR":
        renderer.error(`Agent error: ${result.error}`);
        break;
      default:
        renderer.warn(`Agent terminated: ${result.reason}`);
    }

    renderer.info(`Session ${session.id.slice(0, 8)} saved. Run \`yuan resume\` to continue.`);
    return 1;
  } catch (err) {
    if (isStreaming) {
      renderer.endStream();
    }
    spinner.stop();
    const errorMsg = err instanceof Error ? err.message : String(err);
    renderer.error(`Unexpected error: ${errorMsg}`);
    return 1;
  }
}
