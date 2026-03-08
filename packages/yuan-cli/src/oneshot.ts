/**
 * YUAN CLI — One-shot Mode
 *
 * Executes a single coding task and exits.
 * Usage: yuan code "Add error handling to auth.ts"
 */

import { TerminalRenderer } from "./renderer.js";
import { SessionManager } from "./session.js";
import { ConfigManager } from "./config.js";

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

  // Agent execution (stub — requires @yuan/core)
  const spinner = renderer.thinking();

  await new Promise((resolve) => setTimeout(resolve, 500));
  spinner.stop();

  renderer.warn(
    "Agent loop is not yet connected. The @yuan/core package needs to be implemented."
  );
  renderer.info(`Session ${session.id.slice(0, 8)} saved. Run \`yuan resume\` to continue.`);

  return 0;
}
