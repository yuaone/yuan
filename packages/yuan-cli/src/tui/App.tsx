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

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import os from "node:os";
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
import { ApprovalPrompt, type ApprovalChoice } from "./components/ApprovalPrompt.js";
import { useSlashCommands } from "./hooks/useSlashCommands.js";
import { useTaskPanel } from "./hooks/useTaskPanel.js";
import { TaskPanel } from "./components/TaskPanel.js";
import { AgentBridge } from "./agent-bridge.js";
import type { AgentEvent, ApprovalResponse } from "@yuaone/core";
import { checkForUpdate, loadSettings, saveSettings } from "./lib/update-checker.js";
import { executeCommand, type CommandContext } from "../commands/index.js";
import type { ConfigManager } from "../config.js";

export interface AppProps {
  version: string;
  model: string;
  provider: string;
  bridge: AgentBridge;
  onExit?: () => void;
  configManager?: ConfigManager;
}

function App({
  version,
  model,
  provider,
  bridge,
  onExit,
  configManager,
}: AppProps): React.JSX.Element {
  const [currentModel, setCurrentModel] = useState(model);
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const agentStream = useAgentStream();
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;

  // Stable ref to agentStream.handleEvent to avoid useEffect re-runs
  const handleEventRef = useRef(agentStream.handleEvent);
  handleEventRef.current = agentStream.handleEvent;

  const [tokensPerSec, setTokensPerSec] = useState<number | undefined>();

  const lastMessageRef = useRef<string>("");

  // Approval state — bridges Promise-based callback to React state
  const approvalResolverRef = useRef<((response: ApprovalResponse) => void) | null>(null);
  const [approvalToolName, setApprovalToolName] = useState<string | null>(null);
  const [approvalToolArgs, setApprovalToolArgs] = useState<string | null>(null);

  // Pending message queue — typed while agent is running
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);

  // Slash command state
  const [slashState, slashActions] = useSlashCommands();
  const taskPanel = useTaskPanel();
  const [updateInfo, setUpdateInfo] = useState<{
    current: string;
    latest: string;
  } | null>(null);
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

    // Wire approval callback — when the agent needs approval, set React state
    // and return a Promise that resolves when the user selects an option.
    bridge.onApproval(async (request) => {
      // Summarize args for display
      const argsSummary = request.arguments
        ? (request.arguments.path as string) ||
          (request.arguments.file_path as string) ||
          (request.arguments.command as string)?.slice(0, 60) ||
          ""
        : "";

      setApprovalToolName(request.toolName);
      setApprovalToolArgs(argsSummary || null);

      // Emit approval_needed event to update useAgentStream status
      handleEventRef.current({
        kind: "agent:approval_needed",
        action: { tool: request.toolName, input: request.arguments },
      });

      return new Promise<ApprovalResponse>((resolve) => {
        approvalResolverRef.current = resolve;
      });
    });
  }, [bridge]);

  // Message submission
  const handleSubmit = useCallback(
    (value: string) => {
      agentStream.addUserMessage(value);
      agentStream.startAgent();
      setTokensPerSec(undefined);

      lastMessageRef.current = value;
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

  // Pending message handler — called when user submits while agent is running
  const pendingMessageRef = useRef<string | null>(null);
  const handleQueueMessage = useCallback(
    (value: string) => {
      pendingMessageRef.current = value;
      setPendingMessage(value);
    },
    [],
  );

  // Auto-send pending message when agent becomes idle/completed/interrupted
  const prevStatusRef = useRef(agentStream.state.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    const curr = agentStream.state.status;
    prevStatusRef.current = curr;

    const wasRunning = prev === "thinking" || prev === "streaming" || prev === "tool_running" || prev === "completed" || prev === "interrupted";
    const isNowIdle = curr === "idle";

    if (wasRunning && isNowIdle && pendingMessageRef.current) {
      const msg = pendingMessageRef.current;
      pendingMessageRef.current = null;
      setPendingMessage(null);
      // Small delay so the "idle" state is fully settled
      setTimeout(() => {
        handleSubmit(msg);
      }, 100);
    }
  }, [agentStream.state.status, handleSubmit]);

  // Interruption
  const handleInterrupt = useCallback(() => {
    bridgeRef.current.interrupt();
    agentStream.interrupt();
  }, [agentStream]);

  // Approval handler — resolves the pending Promise from the bridge callback
  const handleApproval = useCallback(
    (choice: ApprovalChoice) => {
      if (approvalResolverRef.current) {
        let response: ApprovalResponse;
        switch (choice) {
          case "allow":
            response = "approve";
            break;
          case "allow_always":
            response = "always_approve";
            break;
          case "deny":
            response = "reject";
            break;
        }
        approvalResolverRef.current(response);
        approvalResolverRef.current = null;
      }
      // Clear approval UI state
      setApprovalToolName(null);
      setApprovalToolArgs(null);
      // Reset status back to thinking
      agentStream.handleEvent({ kind: "agent:thinking", content: "" });
    },
    [agentStream],
  );

  // Slash commands — unified dispatcher
  const handleSlashCommand = useCallback(
    (cmd: string) => {
      slashActions.close();

      const ctx: CommandContext = {
        output: (msg) => agentStream.addSystemMessage(msg),
        config: undefined as any,
        configManager: configManager as any,
        version,
        provider,
        model,
        workDir: process.cwd(),
        filesChanged: bridgeRef.current.filesChanged,
        hasPendingApproval: !!approvalResolverRef.current,
        agentInfo: {
          status: agentStream.state.status,
          messageCount: agentStream.state.messages.length,
          totalTokens: agentStream.state.totalTokensUsed,
          tokensPerSecond: agentStream.state.tokensPerSecond,
        },
        sessionInfo: {
          id: "tui-session",
          createdAt: Date.now(),
        },
        onModelChange: (newModel) => {
          setCurrentModel(newModel);
          // Wire into bridge so next message uses the new model
          bridgeRef.current.updateModel(bridgeRef.current.activeProvider, newModel);
          agentStream.addSystemMessage(`Model → ${newModel}`);
        },
        onModeChange: (newMode) => {
          agentStream.addSystemMessage(`Mode changed to: ${newMode} (takes effect on next message)`);
        },
        onApprove: () => {
          if (approvalResolverRef.current) {
            approvalResolverRef.current("approve");
            approvalResolverRef.current = null;
            setApprovalToolName(null);
            setApprovalToolArgs(null);
          }
        },
        onReject: () => {
          if (approvalResolverRef.current) {
            approvalResolverRef.current("reject");
            approvalResolverRef.current = null;
            setApprovalToolName(null);
            setApprovalToolArgs(null);
          }
        },
        onRetry: () => {
          const last = lastMessageRef.current;
          if (last) {
            bridgeRef.current.sendMessage(last).catch(() => {});
          }
        },
        onCompact: () => bridgeRef.current.compact(),
        onRemoveLastChangedFile: () => bridgeRef.current.removeLastChangedFile(),
        onSetMode: (mode) => bridgeRef.current.setMode(mode),
      };

      const result = executeCommand(ctx, cmd);
      if (!result) {
        agentStream.addSystemMessage(`Unknown command: ${cmd}. Type /help for available commands.`);
        return;
      }
      if (result.exit) {
        onExit?.();
        exit();
        return;
      }
      if (result.clear) {
        agentStream.clearMessages();
        bridge.resetSession(); // Reset conversation history too
        return;
      }
      if (result.output) {
        agentStream.addSystemMessage(result.output);
      }
    },
    [agentStream, onExit, exit, slashActions, version, provider, model],
  );

  // Check for updates on mount (non-blocking)
  useEffect(() => {
   const timer = setTimeout(() => {
      checkForUpdate(version)
        .then((info) => {
          if (!info?.hasUpdate) return;

          setUpdateInfo({
            current: info.currentVersion,
            latest: info.latestVersion,
          });

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
                    : "Update failed. Run: pnpm install -g @yuaone/cli@latest",
                );
              });
            });
          } else if (settings.autoUpdate === "prompt") {
            agentStream.addSystemMessage(
              `Update available: ${info.currentVersion} → ${info.latestVersion}  Press U to install`,
            );
          }
        })
        .catch(() => {
          // Non-critical — silently ignore
        });
    }, 2000);

    return () => clearTimeout(timer);
  }, [version, agentStream]);

  // Insert welcome banner as system message (scrollable like chat)
  useEffect(() => {
    if (agentStream.state.messages.length === 0) {
      const cwd = process.cwd().replace(os.homedir(), "~");
      const meta = JSON.stringify({ model: currentModel, provider, cwd, version });
      agentStream.addSystemMessage(`YUAN v${version}\nAutonomous Coding Agent\nType /help for commands\nyuaone.com\n---META---\n${meta}`);
    }
  }, []);
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

  const st = agentStream.state.status;
  const isRunning = st !== "idle" && st !== "completed" && st !== "error" && st !== "interrupted";
  const isAwaitingApproval = st === "awaiting_approval";

  // U key — one-key update when a new version is available
  const isUpdatingRef = useRef(false);
  useInput((input, key) => {
    if (key.ctrl || key.meta) return;
    if (input !== "u" && input !== "U") return;
    if (isRunning || isAwaitingApproval) return;
    if (!updateInfo) return;
    if (isUpdatingRef.current) return;

    isUpdatingRef.current = true;
    const target = updateInfo.latest;
    agentStream.addSystemMessage(`Updating YUAN → ${target}...`);

    import("./lib/update-checker.js")
      .then(({ performUpdate }) => {
        performUpdate().then((ok) => {
          isUpdatingRef.current = false;
          setUpdateInfo(null);
          agentStream.addSystemMessage(
            ok
              ? `✓ Updated to ${target}. Restart yuan to apply.`
              : `✗ Update failed. Run: pnpm install -g @yuaone/cli@latest`,
          );
        });
      })
      .catch(() => {
        isUpdatingRef.current = false;
        agentStream.addSystemMessage(`✗ Update failed. Run: pnpm install -g @yuaone/cli@latest`);
      });
  });

  // Calculate how many rows the slash menu takes
  // items (max 8) + top/bottom border (2) + up/down "more" indicators (0-2)
  const slashMenuRows = useMemo(() => {
    if (!slashState.isOpen) return 0;
    const itemCount = Math.min(slashState.filtered.length, 8);
    const moreIndicators = slashState.filtered.length > 8 ? 2 : 0; // ↑ more + ↓ more
    return itemCount + 2 + moreIndicators;
  }, [slashState.isOpen, slashState.filtered.length]);

  // Task panel height when open
  const bgTasks = agentStream.state.backgroundTasks;
  const taskPanelRows = useMemo(() => {
    if (!taskPanel.isOpen || bgTasks.length === 0) return 0;
    if (taskPanel.mode === "detail") {
      const task = bgTasks.find((t) => t.id === taskPanel.detailTaskId);
      return Math.min(10, (task?.steps.length ?? 0) + 4);
    }
    return Math.min(bgTasks.length + 3, 8); // header + rows + footer padding
  }, [taskPanel.isOpen, taskPanel.mode, taskPanel.detailTaskId, bgTasks]);

  // Content area height = total rows - status(1) - footer(1) - input(1) - slashMenu(N) - taskPanel(N)
  const contentHeight = useMemo(
    () => Math.max(3, rows - 4 - slashMenuRows - taskPanelRows),
    [rows, slashMenuRows, taskPanelRows],
  );

const messages = agentStream.state.messages;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {/* Top bar */}
      <StatusBar
        version={version}
        model={currentModel}
        provider={provider}
        tokensPerSec={agentStream.state.tokensPerSecond || tokensPerSec}
        isRunning={isRunning}
        updateAvailable={updateInfo}
      />

      {/* Message area — shrinks when slash menu opens below input */}
     <MessageList
        messages={messages}
        isThinking={isRunning}
        maxHeight={contentHeight}
        pendingMessage={pendingMessage ?? undefined}
      />

      {/* Approval prompt — shown when agent needs user approval for a tool call */}
      {agentStream.state.status === "awaiting_approval" && (
        <ApprovalPrompt
     toolName={agentStream.state.currentToolName ?? "tool"}
     toolArgs={agentStream.state.currentToolArgs ?? undefined}
          onSelect={handleApproval}
        />
      )}

      {/* Status indicator */}
      <FooterBar agentState={agentStream.state} slashMenuOpen={slashState.isOpen} />

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
        onQueueMessage={handleQueueMessage}
        pendingMessage={pendingMessage ?? undefined}
        taskPanelOpen={taskPanel.isOpen}
        onTaskNavigate={(dir) => {
          if (dir === "up") taskPanel.navigateUp();
          else taskPanel.navigateDown(bgTasks.length);
        }}
        onTaskExpand={() => taskPanel.expandSelected(bgTasks)}
        onTaskPanelClose={taskPanel.mode === "detail" ? taskPanel.closeDetail : taskPanel.close}
        onTaskPanelOpen={taskPanel.open}
        hasBackgroundTasks={bgTasks.length > 0}
      />

      {/* Task panel — background agent list / detail view */}
      {taskPanel.isOpen && bgTasks.length > 0 && (
        <TaskPanel
          tasks={bgTasks}
          mode={taskPanel.mode}
          selectedIndex={taskPanel.selectedIndex}
          detailTaskId={taskPanel.detailTaskId}
          width={columns}
        />
      )}

      {/* Slash menu — appears BELOW input (Claude Code style) */}
      {slashState.isOpen && (
        <SlashMenu
          commands={slashState.filtered}
          selectedIndex={slashState.selectedIndex}
          isOpen={slashState.isOpen}
          width={columns}
        />
      )}
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
