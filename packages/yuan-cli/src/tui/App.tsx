/**
 * YUAN TUI — Root App component.
 * Fully wired to AgentBridge for real LLM-powered agent execution.
 *
 * Layout (top to bottom):
 *   StatusBar  (1 row)
 *   MessageList (dynamic height — shrinks when SlashMenu opens)
 *   SlashMenu  (0 or N rows — pushes input down, squeezes messages up)
 *   InputBox   (1 row)
 *   FooterBar  (1 row)
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { render, Box, useApp, useInput } from "ink";
import { enterTUI, exitTUI } from "./lib/ansi.js";
import { useTerminalSize } from "./hooks/useTerminalSize.js";
import { useAgentStream } from "./hooks/useAgentStream.js";
import { useKeyHandler } from "./hooks/useKeyHandler.js";
import { StatusBar } from "./components/StatusBar.js";
import { MessageList } from "./components/MessageList.js";
import { InputBox } from "./components/InputBox.js";
import { FooterBar } from "./components/FooterBar.js";
import { SlashMenu } from "./components/SlashMenu.js";
import { useSlashCommands } from "./hooks/useSlashCommands.js";
import { AgentBridge } from "./agent-bridge.js";
import type { AgentEvent } from "@yuaone/core";
import { checkForUpdate, loadSettings, saveSettings } from "./lib/update-checker.js";

export interface AppProps {
  version: string;
  model: string;
  provider: string;
  bridge: AgentBridge;
  onExit?: () => void;
}

function App({
  version,
  model,
  provider,
  bridge,
  onExit,
}: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const agentStream = useAgentStream();
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;

  // Stable ref to agentStream.handleEvent to avoid useEffect re-runs
  const handleEventRef = useRef(agentStream.handleEvent);
  handleEventRef.current = agentStream.handleEvent;

  const [tokensPerSec, setTokensPerSec] = useState<number | undefined>();

  // Slash command state
  const [slashState, slashActions] = useSlashCommands();

  // Wire bridge events to useAgentStream — runs once on mount
  useEffect(() => {
    bridge.onEvent((event: AgentEvent) => {
      handleEventRef.current(event);

      if (event.kind === "agent:token_usage") {
        const input = event.input as number;
        const output = event.output as number;
        setTokensPerSec(input + output);
      }
    });

    bridge.onTermination(() => {
      // useAgentStream handles this via agent:completed event
    });
  }, [bridge]);

  // Message submission
  const handleSubmit = useCallback(
    (value: string) => {
      agentStream.addUserMessage(value);
      agentStream.startAgent();
      setTokensPerSec(undefined);

      bridgeRef.current.sendMessage(value).catch((err: Error) => {
        agentStream.handleEvent({
          kind: "agent:error",
          message: err.message,
          retryable: false,
        });
      });
    },
    [agentStream],
  );

  // Interruption
  const handleInterrupt = useCallback(() => {
    bridgeRef.current.interrupt();
    agentStream.interrupt();
  }, [agentStream]);

  // Slash commands
  const handleSlashCommand = useCallback(
    (cmd: string) => {
      slashActions.close();

      if (cmd === "/exit" || cmd === "/quit" || cmd === "/q") {
        onExit?.();
        exit();
        return;
      }
      if (cmd === "/clear") {
        agentStream.clearMessages();
        return;
      }
      if (cmd === "/help" || cmd === "/h") {
        agentStream.addSystemMessage([
          "Available commands:",
          "  /help      — Show this help",
          "  /status    — Model, tokens, session info",
          "  /clear     — Clear conversation",
          "  /model     — Change model",
          "  /config    — Show configuration",
          "  /session   — Session info",
          "  /diff      — Show file changes",
          "  /undo      — Undo last change",
          "  /settings  — Auto-update preferences",
          "  /exit      — Exit YUAN",
          "",
          "  yuaone.com",
        ].join("\n"));
        return;
      }
      if (cmd === "/status") {
        const s = agentStream.state;
        const files = bridgeRef.current.filesChanged;
        agentStream.addSystemMessage([
          `YUAN v${version}`,
          `  Provider : ${provider}`,
          `  Model    : ${model}`,
          `  Status   : ${s.status}`,
          `  Messages : ${s.messages.length}`,
          `  Tokens   : ${s.totalTokensUsed.toLocaleString()} total`,
          s.tokensPerSecond > 0 ? `  Speed    : ${s.tokensPerSecond} tok/s` : "",
          `  Files    : ${files.length} changed`,
          "",
          "  yuaone.com",
        ].filter(Boolean).join("\n"));
        return;
      }
      if (cmd === "/diff") {
        const files = bridgeRef.current.filesChanged;
        const content = files.length > 0
          ? `Changed files:\n${files.map((f) => `  ${f}`).join("\n")}`
          : "No files changed in this session.";
        agentStream.addSystemMessage(content);
        return;
      }
      if (cmd === "/settings") {
        const settings = loadSettings();
        const current = settings.autoUpdate;
        const options = ["prompt", "auto", "never"] as const;
        const currentIdx = options.indexOf(current);
        // Cycle to next option
        const nextIdx = (currentIdx + 1) % options.length;
        const next = options[nextIdx];
        settings.autoUpdate = next;
        saveSettings(settings);

        const labels = {
          prompt: "Ask before updating",
          auto: "Auto-update on launch",
          never: "Never check for updates",
        };
        agentStream.addSystemMessage(
          `Auto-update: ${labels[next]}\n` +
          `  1. prompt — ${current === "prompt" ? "●" : "○"} Ask before updating\n` +
          `  2. auto   — ${current === "auto" ? "●" : "○"} Auto-update on launch\n` +
          `  3. never  — ${current === "never" ? "●" : "○"} Never check\n` +
          `\n  Changed to: ${labels[next]} (run /settings again to cycle)`,
        );
        return;
      }
      agentStream.addSystemMessage(`Unknown command: ${cmd}. Type /help for available commands.`);
    },
    [agentStream, onExit, exit, slashActions],
  );

  // Check for updates on mount (non-blocking)
  useEffect(() => {
    checkForUpdate(version).then((info) => {
      if (info?.hasUpdate) {
        const settings = loadSettings();
        if (settings.autoUpdate === "auto") {
          agentStream.addSystemMessage(
            `Updating YUAN ${info.currentVersion} → ${info.latestVersion}...`,
          );
          import("./lib/update-checker.js").then(({ performUpdate }) => {
            performUpdate().then((ok) => {
              agentStream.addSystemMessage(
                ok
                  ? `Updated to ${info.latestVersion}. Restart to apply.`
                  : "Update failed. Run: npm i -g @yuaone/cli@latest",
              );
            });
          });
        } else if (settings.autoUpdate === "prompt") {
          agentStream.addSystemMessage(
            `Update available: ${info.currentVersion} → ${info.latestVersion}\n` +
            `  Run: npm i -g @yuaone/cli@latest\n` +
            `  Or: /settings to enable auto-update`,
          );
        }
      }
    }).catch(() => {
      // Non-critical — silently ignore
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Input change → open/close slash menu
  const handleInputChange = useCallback(
    (value: string) => {
      if (value.startsWith("/")) {
        slashActions.filter(value);
      } else {
        slashActions.close();
      }
    },
    [slashActions],
  );

  // Slash menu navigation
  const handleSlashNavigate = useCallback(
    (direction: "up" | "down") => {
      if (direction === "up") {
        slashActions.selectPrev();
      } else {
        slashActions.selectNext();
      }
    },
    [slashActions],
  );

  // Slash menu select → return command name
  const handleSlashSelect = useCallback((): string | null => {
    const selected = slashActions.getSelected();
    return selected?.name ?? null;
  }, [slashActions]);

  // Double Ctrl+C to exit — first press shows hint, second press exits.
  // This allows terminal's native Ctrl+C copy to work during text selection.
  const ctrlCTimerRef = useRef<number>(0);

  useKeyHandler({
    onExit: () => {
      const now = Date.now();
      if (now - ctrlCTimerRef.current < 2000) {
        // Double press within 2s → exit
        onExit?.();
        exit();
      } else {
        ctrlCTimerRef.current = now;
        agentStream.addSystemMessage("Press Ctrl+C again to exit.");
      }
    },
  });

  const isRunning = agentStream.state.status !== "idle";

  // Calculate how many rows the slash menu takes
  const slashMenuRows = slashState.isOpen
    ? Math.min(slashState.filtered.length, 8) + 2  // items + top/bottom border
    : 0;

  // Content area height = total rows - status(1) - slashMenu(N) - input(1) - footer(1) - padding(2)
  const contentHeight = Math.max(3, rows - 5 - slashMenuRows);

  const messages = agentStream.state.messages;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {/* Top bar */}
      <StatusBar
        version={version}
        model={model}
        provider={provider}
        tokensPerSec={agentStream.state.tokensPerSecond || tokensPerSec}
        isRunning={isRunning}
      />

      {/* Message area — shrinks when slash menu opens */}
      <MessageList
        messages={messages}
        isThinking={isRunning}
        maxHeight={contentHeight}
      />

      {/* Slash menu — appears between messages and input, pushes input down */}
      {slashState.isOpen && (
        <SlashMenu
          commands={slashState.filtered}
          selectedIndex={slashState.selectedIndex}
          isOpen={slashState.isOpen}
          width={columns}
        />
      )}

      {/* Input */}
      <InputBox
        onSubmit={handleSubmit}
        onInterrupt={handleInterrupt}
        onSlashCommand={handleSlashCommand}
        onInputChange={handleInputChange}
        slashMenuOpen={slashState.isOpen}
        onSlashNavigate={handleSlashNavigate}
        onSlashSelect={handleSlashSelect}
        onSlashClose={slashActions.close}
        isRunning={isRunning}
      />

      {/* Bottom keybind hints */}
      <FooterBar isRunning={isRunning} slashMenuOpen={slashState.isOpen} />
    </Box>
  );
}

/**
 * Public API to control the TUI from outside the React tree.
 */
export interface TUIController {
  unmount: () => void;
  bridge: AgentBridge;
}

/**
 * Launch the TUI. Returns a controller.
 */
export function launchTUI(props: Omit<AppProps, "bridge"> & { bridge: AgentBridge }): TUIController {
  enterTUI();

  const { unmount } = render(
    <App {...props} />,
    { exitOnCtrlC: false },  // We handle Ctrl+C manually (double-press to exit)
  );

  const cleanup = () => {
    exitTUI();
    unmount();
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  return {
    unmount: cleanup,
    bridge: props.bridge,
  };
}
