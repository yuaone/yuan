/**
 * YUAN TUI — Root App component.
 * Fully wired to AgentBridge for real LLM-powered agent execution.
 *
 * Layout (top to bottom, Claude Code style):
 *   MessageList  (flexGrow=1 — all remaining space, includes banner as first item)
 *   StatusLine   (1 row, fixed)
 *   ApprovalPrompt (conditional)
 *   InputBox     (4 rows, fixed)
 *   FooterBar    (1 row, fixed)
 *   SlashMenu    (conditional)
 *   TaskPanel    (conditional)
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import os from "node:os";
import { render, Box, Text, useApp, useInput } from "ink";
import { enterTUI, exitTUI } from "./lib/ansi.js";
import { useTerminalSize } from "./hooks/useTerminalSize.js";
import { useAgentStream } from "./hooks/useAgentStream.js";
import { useKeyHandler } from "./hooks/useKeyHandler.js";
import { MessageList } from "./components/MessageList.js";
import { StatusLine } from "./components/StatusLine.js";
import { InputBox } from "./components/InputBox.js";
import { FooterBar } from "./components/FooterBar.js";
import { SlashMenu } from "./components/SlashMenu.js";
import {
  ApprovalPrompt,
  APPROVAL_PROMPT_HEIGHT,
  type ApprovalChoice,
} from "./components/ApprovalPrompt.js";
import { useSlashCommands } from "./hooks/useSlashCommands.js";
import { useTaskPanel } from "./hooks/useTaskPanel.js";
import { TaskPanel } from "./components/TaskPanel.js";
import { AgentBridge } from "./agent-bridge.js";
import type { AgentEvent, ApprovalResponse } from "@yuaone/core";
import { checkForUpdate, loadSettings, saveSettings } from "./lib/update-checker.js";
import { CompactBanner, COMPACT_BANNER_ROWS } from "./components/CompactBanner.js";
import { executeCommand, type CommandContext } from "../commands/index.js";
import type { ConfigManager } from "../config.js";

// Debug logger — writes to ~/.yuan/logs/debug.log
import fs from "node:fs";
import path from "node:path";
const _DLOG_FILE = path.join(os.homedir(), ".yuan", "logs", "debug.log");
function dlog(layer: string, msg: string, data?: unknown) {
  const now = new Date();
  const ts = `${now.getHours().toString().padStart(2,"0")}:${now.getMinutes().toString().padStart(2,"0")}:${now.getSeconds().toString().padStart(2,"0")}.${now.getMilliseconds().toString().padStart(3,"0")}`;
  const extra = data !== undefined ? " " + JSON.stringify(data) : "";
  const line = `[${ts}] [${layer}] ${msg}${extra}\n`;
  try { fs.appendFileSync(_DLOG_FILE, line); } catch {} // file only — no stderr
}

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

  // Multi-queue — preserve all queued messages in order
  const [queuedMessageIds, setQueuedMessageIds] = useState<string[]>([]);
  const dequeueInFlightRef = useRef(false);
  const [queueEditIndex, setQueueEditIndex] = useState<number | null>(null);

  // Reasoning content — streamed into ReasoningPanel (R key), inline shown in bubble
  const [reasoningContent, setReasoningContent] = useState("");

  const cwd = useMemo(() => process.cwd().replace(os.homedir(), "~"), []);

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

      // Stream reasoning delta directly into ReasoningPanel
      if (event.kind === "agent:reasoning_delta") {
        const text = (event as { text?: string }).text;
        if (text) {
          setReasoningContent((prev) => prev ? `${prev}${text}` : text);
        }
      }

      // Clear approval state if agent errors while approval is pending
      if (event.kind === "agent:error") {
        approvalResolverRef.current = null;
        setApprovalToolName(null);
        setApprovalToolArgs(null);
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
      setReasoningContent("");

      lastMessageRef.current = value;
      dlog("APP", `user submitted message`, { msgLength: value?.length ?? 0, isAgentRunning: agentStream.state.status !== "idle" && agentStream.state.status !== "completed" && agentStream.state.status !== "error" && agentStream.state.status !== "interrupted" });
      bridgeRef.current.sendMessage(value).then(() => {
        dlog("APP", `sendMessage returned`);
      }).catch((err: Error) => {
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
  // Appends queued message IDs in FIFO order so multiple queued prompts are preserved
  const handleQueueMessage = useCallback(
    (value: string) => {
      const id = `queued-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
      agentStream.addQueuedMessage(value, id);
      setQueuedMessageIds((prev) => [...prev, id]);                 // InputBox hint text
    },
    [agentStream],
  );
  const pendingMessage = useMemo(() => {
    const nextId = queuedMessageIds[0];
    if (!nextId) return null;
    return agentStream.state.messages.find((m) => m.id === nextId)?.content ?? null;
  }, [queuedMessageIds, agentStream.state.messages]);

  const pendingMessageCount = queuedMessageIds.length;
const getQueuedContent = useCallback(
  (id: string) =>
    agentStream.state.messages.find((m) => m.id === id)?.content ?? "",
  [agentStream.state.messages],
);
const deleteQueued = useCallback((index: number) => {
  setQueuedMessageIds((prev) => prev.filter((_, i) => i !== index));
}, []);
const moveQueued = useCallback((from: number, to: number) => {
  setQueuedMessageIds((prev) => {
    if (to < 0 || to >= prev.length) return prev;
    const next = [...prev];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  });
}, []);
const replaceQueued = useCallback((index: number, newContent: string) => {
  const oldId = queuedMessageIds[index];
  if (!oldId) return;
  // Update content in-place — no ghost messages, same ID preserved
  agentStream.updateQueuedMessage(oldId, newContent);
}, [agentStream, queuedMessageIds]);

  // Auto-send pending message when agent becomes idle/completed/interrupted
  // Ref to always read the latest messages inside dequeue timer (avoids stale closure)
  const latestMessagesRef = useRef(agentStream.state.messages);
  latestMessagesRef.current = agentStream.state.messages;

  const prevStatusRef = useRef(agentStream.state.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    const curr = agentStream.state.status;
    prevStatusRef.current = curr;

    const wasActivelyRunning = prev === "thinking" || prev === "streaming" || prev === "tool_running";
    const wasRunning = wasActivelyRunning || prev === "completed" || prev === "interrupted";
    const isNowIdle = curr === "idle";
    const isNowCompleted = curr === "completed";

    // Fast path: fire immediately on completed when queue has items (skip 3s idle delay)
    // Fallback: fire on idle transition (catches interrupted / manual stop)
    // Only fire on idle if it was NOT already handled by the completed transition
    const wasCompleted = prev === "completed";
    const shouldDequeue =
      (isNowCompleted && wasActivelyRunning && queuedMessageIds.length > 0) ||
      (isNowIdle && wasRunning && !wasCompleted);

    if (!shouldDequeue) return;
    if (dequeueInFlightRef.current) return;
    if (queuedMessageIds.length === 0) return;

    const queuedId = queuedMessageIds[0];
    const queuedMsg = agentStream.state.messages.find((m) => m.id === queuedId);

    // Queue and transcript got out of sync — drop the missing id and continue
    if (!queuedMsg) {
      setQueuedMessageIds((prevIds) => prevIds.filter((id) => id !== queuedId));
      return;
    }

    dequeueInFlightRef.current = true;

    const timer = setTimeout(() => {
      // Read the LATEST content from the ref to avoid stale closure (H8 fix)
      const freshMsg = latestMessagesRef.current.find((m) => m.id === queuedId);
      const content = freshMsg?.content ?? queuedMsg.content;

      // Remove from queue first so the next queued item becomes visible immediately
      setQueuedMessageIds((prevIds) => prevIds.filter((id) => id !== queuedId));

      // Promote ghost bubble (queued_user → user) in-place, then start agent
      agentStream.promoteQueuedMessage(queuedId);
      agentStream.startAgent();
      setTokensPerSec(undefined);
      setReasoningContent("");
      lastMessageRef.current = content;

      // Reset flag HERE — not in .finally(). sendMessage may be a long-running promise
      // (resolves only when agent completes), keeping the flag true for the entire run.
      // Resetting synchronously after dispatch lets the next queued message dequeue
      // when this agent's completed→idle transition fires.
      dequeueInFlightRef.current = false;

      dlog("APP", `dequeuing message`, { queueLen: queuedMessageIds.length });
      Promise.resolve(bridgeRef.current.sendMessage(content))
        .catch((err: Error) => {
          agentStream.handleEvent({
            kind: "agent:error",
            message: err.message,
            retryable: false,
          });
        });
    }, 100);

    return () => clearTimeout(timer);
  }, [agentStream.state.status, agentStream.state.messages, agentStream, queuedMessageIds]);
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

  // Input change → open/close slash menu
  const handleInputChange = useCallback(
    (value: string) => {
      if (value.startsWith("/")) {
        slashActions.filter(value);
      } else if (slashState.isOpen) {
        // Only close if actually open — prevents unnecessary state updates on every keystroke
        slashActions.close();
      }
      // If neither condition: slash menu closed + no slash prefix → no state change → no re-render
    },
    [slashActions, slashState.isOpen],
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
  const approvalSlotHeight = isAwaitingApproval ? APPROVAL_PROMPT_HEIGHT : 0;
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

  const messages = agentStream.state.messages;

  // Show banner only when terminal is tall enough
  const showBanner = rows >= 16;

  // Task panel height when open
  const bgTasks = agentStream.state.backgroundTasks;

return (
  <Box flexDirection="column" width={columns} height={rows}>

    {/* Banner — fixed at top, always visible */}
    {showBanner && (
      <Box flexShrink={0}>
        <CompactBanner
          version={version}
          model={currentModel}
          provider={provider}
          cwd={cwd}
          width={columns}
        />
      </Box>
    )}

    {/* MessageList gets ALL remaining space via flexGrow */}
    <Box flexGrow={1} flexShrink={1} overflow="hidden">
      <MessageList
        messages={messages}
        isThinking={isRunning}
        width={columns}
        reservedTopRows={showBanner ? COMPACT_BANNER_ROWS : 0}
      />
    </Box>

      {/* StatusLine — always 1 row */}
      <Box height={1} flexShrink={0} overflow="hidden">
        <StatusLine agentState={agentStream.state} />
      </Box>

      {/* Approval — only when needed */}
      {isAwaitingApproval && (
        <Box height={approvalSlotHeight} flexShrink={0} overflow="hidden">
          <ApprovalPrompt
            toolName={agentStream.state.currentToolName ?? "tool"}
            toolArgs={agentStream.state.currentToolArgs ?? undefined}
            onSelect={handleApproval}
          />
        </Box>
      )}

      {/* Input — above footer */}
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
        disabled={isAwaitingApproval}
        onQueueMessage={handleQueueMessage}
        pendingMessage={pendingMessage ?? undefined}
        pendingCount={pendingMessageCount}
      queuedMessages={queuedMessageIds.map(id=>getQueuedContent(id))}

  onQueueEdit={(index)=>{
    const id = queuedMessageIds[index];
    if(!id) return "";
    return getQueuedContent(id);
  }}

  onQueueDelete={(index)=>{
    deleteQueued(index);
  }}

  onQueueMove={(from,to)=>{
    moveQueued(from,to);
  }}
  onQueueReplace={(index, newContent) => {
    replaceQueued(index, newContent);
  }}
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

      {/* Footer — below input */}
      <FooterBar agentState={agentStream.state} slashMenuOpen={slashState.isOpen} hasReasoning={reasoningContent.length > 0} />

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
  dlog("APP", "launchTUI: enterTUI");
  enterTUI();
  dlog("APP", "launchTUI: calling render()");

  const { unmount } = render(
    <App {...props} />,
    { exitOnCtrlC: false },  // We handle Ctrl+C manually (double-press to exit)
  );
  dlog("APP", "launchTUI: render() returned");

  const cleanup = () => {
    exitTUI();
    unmount();
  };

  const sigintHandler = () => {
    cleanup();
    process.exit(0);
  };

  /* M8 fix: use .once() to prevent listener accumulation */
  process.once("exit", cleanup);
  process.once("SIGINT", sigintHandler);

  return {
    unmount: () => {
      process.removeListener("exit", cleanup);
      process.removeListener("SIGINT", sigintHandler);
      cleanup();
    },
    bridge: props.bridge,
  };
}
