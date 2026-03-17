/**
 * @yuan/cli — Design Mode Entry Point
 *
 * `yuan design` command:
 * 1. Detect framework from package.json
 * 2. Start dev server (or detect existing)
 * 3. Launch Playwright headless browser
 * 4. Connect to dev server URL
 * 5. Enter design chat loop
 */

import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { DOMSnapshot, AgentTermination } from "@yuaone/core";
import { DesignRenderer } from "./design-renderer.js";
import { ConfigManager } from "./config.js";

export interface DesignOptions {
  port?: number;
  autoVision?: boolean;
  viewport?: string;
  devCommand?: string;
}

/** Parse viewport preset string to { width, height } */
function parseViewport(
  preset?: string,
): { width: number; height: number } | undefined {
  if (!preset) return undefined;
  const presets: Record<string, { width: number; height: number }> = {
    mobile: { width: 375, height: 812 },
    tablet: { width: 768, height: 1024 },
    desktop: { width: 1440, height: 900 },
  };
  return presets[preset.toLowerCase()];
}

export async function runDesignMode(
  options: DesignOptions = {},
): Promise<void> {
  const renderer = new DesignRenderer();
  const configManager = new ConfigManager();

  if (!configManager.isConfigured()) {
    await renderer.showError(
      "No API key configured. Run: yuan config set-key",
    );
    process.exit(1);
  }

  const workDir = resolve(process.cwd());

  // Dynamic imports to avoid loading Playwright at CLI boot
  const {
    DevServerManager,
    BrowserTool,
    createDesignTools,
    createDefaultRegistry,
    setDesignBrowserSession,
    clearDesignBrowserSession,
  } = await import("@yuaone/tools");
  const { DesignLoop, DEFAULT_LOOP_CONFIG } = await import("@yuaone/core");

  const serverManager = new DevServerManager();
  const browserTool = new BrowserTool();

  // Detect and start dev server
  const detected = await serverManager.detectFramework(workDir);
  await renderer.showInfo(
    `프레임워크 감지: ${detected.framework} (${detected.devCommand})`,
  );

  let serverState;
  try {
    serverState = await serverManager.start(workDir, {
      command: options.devCommand,
      port: options.port,
      timeout: 30_000,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await renderer.showError(`Dev 서버 시작 실패: ${msg}`);
    process.exit(1);
  }

  // Launch browser
  let sessionId: string;
  try {
    const openResult = await browserTool.execute(
      { action: "open", url: serverState.url, _toolCallId: "init" },
      workDir,
    );
    if (!openResult.success) throw new Error(openResult.output);

    const match = openResult.output.match(/Session:\s*(bs_\w+)/);
    sessionId = match?.[1] ?? "default";
    setDesignBrowserSession(sessionId, browserTool);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await renderer.showError(`브라우저 연결 실패: ${msg}`);
    await serverManager.stop();
    process.exit(1);
  }

  await renderer.showBanner(serverState);

  // Build AgentConfig matching the actual interface
  const userConfig = configManager.get();
  const registry = createDefaultRegistry();
  for (const tool of createDesignTools()) {
    registry.register(tool);
  }

  const toolExecutor = registry.toExecutor(workDir);
  const viewport = parseViewport(options.viewport);

  const designLoop = new DesignLoop({
    config: {
      byok: {
        provider: (userConfig.provider ?? "anthropic") as any,
        apiKey: userConfig.apiKey,
        model: userConfig.model,
        baseUrl: userConfig.baseUrl,
      },
      loop: {
        model: "coding" as const,
        maxIterations: 50,
        maxTokensPerIteration: DEFAULT_LOOP_CONFIG.maxTokensPerIteration,
        totalTokenBudget: DEFAULT_LOOP_CONFIG.totalTokenBudget,
        tools: toolExecutor.definitions,
        systemPrompt: "",
        projectPath: workDir,
      },
    },
    toolExecutor,
    governorConfig: { planTier: "PRO" },
    designConfig: {
      workDir,
      autoVision: options.autoVision,
      viewport,
      devCommand: options.devCommand,
      port: options.port,
    },
    getSnapshot: async (): Promise<DOMSnapshot> => {
      const result = await browserTool.execute(
        { action: "dom", session_id: sessionId, _toolCallId: "snap" },
        workDir,
      );
      return {
        accessibilityTree: result.output,
        url: serverState.url,
        title: "",
        timestamp: Date.now(),
      };
    },
    getScreenshot: async (): Promise<string> => {
      const result = await browserTool.execute(
        {
          action: "screenshot",
          session_id: sessionId,
          _toolCallId: "shot",
        },
        workDir,
      );
      return result.output;
    },
  });

  designLoop.on("design_event", async (event: any) => {
    await renderer.showEvent(event);
  });

  // REPL
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const cleanup = async () => {
    await renderer.showInfo("Design Mode 종료 중...");
    clearDesignBrowserSession();
    await browserTool.execute(
      { action: "close", session_id: sessionId, _toolCallId: "close" },
      workDir,
    );
    await serverManager.stop();
    rl.close();
    process.exit(0);
  };

  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  const askQuestion = (): void => {
    renderer.showPrompt().then(() => {
      rl.question("", async (input) => {
        const trimmed = input.trim();
        if (!trimmed) {
          askQuestion();
          return;
        }
        if (trimmed === "/quit" || trimmed === "/exit") {
          await cleanup();
          return;
        }

        try {
          await renderer.showAgentPrefix();
          const result: AgentTermination = await designLoop.run(trimmed);

          switch (result.reason) {
            case "GOAL_ACHIEVED":
              console.log(result.summary);
              break;
            case "MAX_ITERATIONS":
              console.log(result.lastState);
              break;
            case "ERROR":
              await renderer.showError(result.error);
              break;
            case "USER_CANCELLED":
              await renderer.showInfo("작업이 취소되었습니다.");
              break;
            case "BUDGET_EXHAUSTED":
              await renderer.showInfo(
                `토큰 예산 소진: ${result.tokensUsed} tokens`,
              );
              break;
            case "NEEDS_APPROVAL":
              await renderer.showInfo(
                "승인이 필요합니다. (Design Mode에서는 자동 승인)",
              );
              break;
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await renderer.showError(msg);
        }

        askQuestion();
      });
    });
  };

  askQuestion();
}
