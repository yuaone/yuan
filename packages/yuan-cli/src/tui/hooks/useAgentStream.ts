/**
 * useAgentStream — bridges AgentLoop events to TUI React state.
 * Converts agent events into TUIMessage updates, tracks streaming state,
 * real-time elapsed timer, reasoning stream, and status indicator metadata.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import type { 
  TUIMessage, 
  TUIToolCall, 
  AgentStreamState, 
  AgentStatus,
  ReasoningNode
} from "../types.js";

export interface UseAgentStreamReturn {
  state: AgentStreamState;
  handleEvent: (event: AgentEventLike) => void;
  addUserMessage: (content: string) => void;
  addSystemMessage: (content: string) => void;
  startAgent: () => void;
  interrupt: () => void;
  clearMessages: () => void;
}

/** Minimal agent event shape (matches @yuaone/core AgentEvent) */
export interface AgentEventLike {
  kind: string;
  [key: string]: unknown;
}

export function useAgentStream(): UseAgentStreamReturn {
  const [messages, setMessages] = useState<TUIMessage[]>([]);
  const [status, setStatus] = useState<AgentStatus>("idle");
  const isStreamingRef = useRef(false);
  const [tokensPerSecond, setTokensPerSecond] = useState(0);
  const [totalTokensUsed, setTotalTokensUsed] = useState(0);

  const [elapsedMs, setElapsedMs] = useState(0);
  const [lastElapsedMs, setLastElapsedMs] = useState<number | null>(null);
  const [currentToolName, setCurrentToolName] = useState<string | null>(null);
  const [currentToolArgs, setCurrentToolArgs] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [filesChangedCount, setFilesChangedCount] = useState(0);
  const [reasoningTree, setReasoningTree] = useState<ReasoningNode | undefined>(undefined);

  const currentMsgIdRef = useRef<string | null>(null);
  const tokenWindowRef = useRef<{ time: number; tokens: number }[]>([]);
  const currentThinkingMsgIdRef = useRef<string | null>(null);
  const activeToolBatchIdRef = useRef<string | null>(null);
  const lastToolCallAtRef = useRef<number>(0);

  const startTimeRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Stall detection
  const lastEventAtRef = useRef<number>(Date.now());
  const [stalledMs, setStalledMs] = useState<number>(0);
  const statusRef = useRef<AgentStatus>("idle");

  // Stall check: every 5s, if active and no events for >20s → show warning
  useEffect(() => {
    const interval = setInterval(() => {
      const st = statusRef.current;
      const isActive = st === "thinking" || st === "streaming" || st === "tool_running";
      if (isActive) {
        const ms = Date.now() - lastEventAtRef.current;
        setStalledMs(ms > 20_000 ? ms : 0);
      } else {
        setStalledMs(0);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const startTimer = useCallback(() => {
    startTimeRef.current = Date.now();
    setElapsedMs(0);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      if (startTimeRef.current) {
        setElapsedMs(Date.now() - startTimeRef.current);
      }
    }, 1000);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (startTimeRef.current) {
      const final = Date.now() - startTimeRef.current;
      setElapsedMs(final);
      setLastElapsedMs(final);
      startTimeRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const updateCurrentMessage = useCallback(
    (updater: (msg: TUIMessage) => TUIMessage) => {
      const id = currentMsgIdRef.current;
      if (!id) return;
      setMessages((prev) => prev.map((m) => (m.id === id ? updater(m) : m)));
    },
    [],
  );

  const pendingTextRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const FLUSH_INTERVAL = 120;

  const flushPendingText = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const text = pendingTextRef.current;
    if (text.length === 0) return;
    pendingTextRef.current = "";
    updateCurrentMessage((msg) => ({
      ...msg,
      content: msg.content + text,
    }));
  }, [updateCurrentMessage]);

  const appendThinkingLines = useCallback((raw: string) => {
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => (line.startsWith("· ") ? line : `· ${line}`));

    if (lines.length === 0) return;

    const nextBlock = lines.join("\n");
    const currentId = currentThinkingMsgIdRef.current;

    if (!currentId) {
      const id = `thinking-${Date.now()}`;
      currentThinkingMsgIdRef.current = id;
      const msg: TUIMessage = {
        id,
        role: "system",
        content: nextBlock,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, msg]);
      return;
    }

    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== currentId) return m;

        const existing = new Set(m.content.split("\n"));
        const deduped = lines.filter((line) => !existing.has(line));
        if (deduped.length === 0) return m;

        return {
          ...m,
          content: `${m.content}\n${deduped.join("\n")}`,
        };
      }),
    );
  }, []);

  useEffect(() => {
    return () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, []);

  const addUserMessage = useCallback((content: string) => {
    const msg: TUIMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, msg]);
  }, []);

  const addSystemMessage = useCallback((content: string) => {
    const msg: TUIMessage = {
      id: `sys-${Date.now()}`,
      role: "system",
      content,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, msg]);
  }, []);

  const startAgent = useCallback(() => {
    statusRef.current = "thinking";
    setStatus("thinking");
    lastEventAtRef.current = Date.now();
    setStalledMs(0);
    isStreamingRef.current = false;
    setCurrentToolName(null);
    setCurrentToolArgs(null);
    setLastError(null);
    setFilesChangedCount(0);
    setTokensPerSecond(0);
    tokenWindowRef.current = [];
    currentThinkingMsgIdRef.current = null;
    activeToolBatchIdRef.current = null;
    lastToolCallAtRef.current = 0;
    startTimer();

    const msgId = `assistant-${Date.now()}`;
    currentMsgIdRef.current = msgId;
    const msg: TUIMessage = {
      id: msgId,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      isStreaming: true,
      toolCalls: [],
    };
    setMessages((prev) => [...prev, msg]);
  }, [startTimer]);

  const handleEvent = useCallback(
    (event: AgentEventLike) => {
      // Reset stall timer on every event
      lastEventAtRef.current = Date.now();
      setStalledMs(0);

      switch (event.kind) {
  case "agent:reasoning_delta": {
    appendThinkingLines(String(event.text ?? ""));
    break;
  }
        case "agent:thinking": {
          statusRef.current = "thinking";
          setStatus("thinking");
          setCurrentToolName(null);
          setCurrentToolArgs(null);
          appendThinkingLines(String(event.content ?? ""));
          break;
        }

        case "agent:text_delta": {
          const text = event.text as string;
          // Only update status/tool state on the FIRST token of a stream — not every token
          if (!isStreamingRef.current) {
            isStreamingRef.current = true;
            // Reset thinking message ID so post-stream thinking events create a NEW message
            // rather than appending to the old thinking block (prevents reasoning overlap)
            currentThinkingMsgIdRef.current = null;
            statusRef.current = "streaming";
            setStatus("streaming");
            setCurrentToolName(null);
            setCurrentToolArgs(null);
          }
          pendingTextRef.current += text;
          if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
          flushTimerRef.current = setTimeout(flushPendingText, FLUSH_INTERVAL);
          break;
        }
 case "agent:reasoning_timeline": {
  setReasoningTree(event.tree as ReasoningNode);
  break;
 }
        case "agent:tool_call": {
          isStreamingRef.current = false;
          statusRef.current = "tool_running";
          setStatus("tool_running");
          const toolName = event.tool as string;
          const args = summarizeArgs(event.input as Record<string, unknown>);
          setCurrentToolName(toolName);
          setCurrentToolArgs(args);

          const now = Date.now();
          const shouldReuseBatch =
            activeToolBatchIdRef.current !== null &&
            now - lastToolCallAtRef.current <= 180;

          const batchId = shouldReuseBatch
            ? activeToolBatchIdRef.current!
            : `batch-${now}`;

          activeToolBatchIdRef.current = batchId;
          lastToolCallAtRef.current = now;

          const tl = toolName.toLowerCase();
          if (tl.includes("write") || tl.includes("edit")) {
            setFilesChangedCount((prev) => prev + 1);
          }

          const tc: TUIToolCall = {
            id: `tc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            callId: typeof event.callId === "string" ? event.callId : undefined,
            toolName,
            argsSummary: args,
            status: "running",
            isExpanded: false,
            startedAt: now,
            batchId,
          };

          updateCurrentMessage((msg) => ({
            ...msg,
            toolCalls: [...(msg.toolCalls ?? []), tc],
          }));
          break;
        }

 case "agent:tool_batch": {
  activeToolBatchIdRef.current =
    typeof event.batchId === "string" ? event.batchId : null;
  break;
 }

        case "agent:tool_result": {
          const toolName = event.tool as string;
          const output = event.output as string;
          const durationMs = event.durationMs as number;

          setCurrentToolName(null);
          setCurrentToolArgs(null);

          let hasRunningTool = false;

          updateCurrentMessage((msg) => {
            const toolCalls = [...(msg.toolCalls ?? [])];

            for (let i = toolCalls.length - 1; i >= 0; i--) {
              const call = toolCalls[i];
              if (!call) continue;

              if (call.toolName === toolName && call.status === "running") {
                const completedAt = Date.now();

                let duration: number | undefined;
                if (durationMs) {
                  duration = durationMs / 1000;
                } else if (call.startedAt) {
                  duration = (completedAt - call.startedAt) / 1000;
                }

                toolCalls[i] = {
                  ...call,
                  status: "success",
                  completedAt,
                  duration,
                  result: {
                    kind: detectResultKind(toolName, output),
                    content: output,
                    lineCount: output.split("\n").length,
                  },
                };
                break;
              }
            }

            hasRunningTool = toolCalls.some((call) => call.status === "running");
            return { ...msg, toolCalls };
          });

          if (!hasRunningTool) activeToolBatchIdRef.current = null;
          break;
        }

        case "agent:error": {
          const errMsg = event.message as string;
          setLastError(errMsg);
          stopTimer();
          statusRef.current = "error";
          setStatus("error");
          setStalledMs(0);
          setCurrentToolName(null);
          setCurrentToolArgs(null);

          updateCurrentMessage((msg) => ({
            ...msg,
            content: msg.content + `\n\nError: ${errMsg}`,
            isStreaming: false,
          }));

          currentMsgIdRef.current = null;
          currentThinkingMsgIdRef.current = null;
          activeToolBatchIdRef.current = null;

          setTimeout(() => {
            setStatus("idle");
          }, 3000);
          break;
        }

        case "agent:completed": {
          flushPendingText();
          stopTimer();
          statusRef.current = "completed";
          setStatus("completed");
          setStalledMs(0);
          setCurrentToolName(null);
          setCurrentToolArgs(null);

          const summary = event.summary as string;
          updateCurrentMessage((msg) => ({
            ...msg,
            content: msg.content || summary,
            isStreaming: false,
          }));

          isStreamingRef.current = false;
          currentMsgIdRef.current = null;
          currentThinkingMsgIdRef.current = null;
          activeToolBatchIdRef.current = null;

          setTimeout(() => {
            setStatus("idle");
          }, 3000);
          break;
        }

        case "agent:token_usage": {
          const input = event.input as number;
          const output = event.output as number;
          const total = input + output;
          setTotalTokensUsed((prev) => prev + total);

          const now = Date.now();
          tokenWindowRef.current.push({ time: now, tokens: total });
          tokenWindowRef.current = tokenWindowRef.current.filter(
            (e) => now - e.time < 3000,
          );

          const windowTokens = tokenWindowRef.current.reduce((s, e) => s + e.tokens, 0);
          const windowMs = Math.max(1, now - (tokenWindowRef.current[0]?.time ?? now));
          setTokensPerSecond(Math.round((windowTokens / windowMs) * 1000));
          break;
        }

        case "agent:approval_needed": {
  statusRef.current = "awaiting_approval";
  setStatus("awaiting_approval");
  setStalledMs(0);

  const action = event.action as any;

  if (action?.tool) {
    setCurrentToolName(action.tool);
  }

  const args = summarizeArgs(action?.input);
  if (args) {
    setCurrentToolArgs(args);
  }

  // DO NOT append system message
  // approval will be rendered by ApprovalPrompt UI
          break;
        }

        case "agent:qa_result": {
          const passed = event.passed as boolean;
          const stage = event.stage as string;
          const issues = event.issues as string[];
          const statusLabel = passed ? "passed" : `${issues.length} issue(s)`;
          const lines = [`[QA ${stage}] ${statusLabel}`, ...issues.slice(0, 5)];
          appendThinkingLines(lines.join("\n"));
          break;
        }

        default:
          break;
      }
    },
    [appendThinkingLines, updateCurrentMessage, flushPendingText, stopTimer],
  );

  const interrupt = useCallback(() => {
    flushPendingText();
    stopTimer();
    statusRef.current = "interrupted";
    setStatus("interrupted");
    setStalledMs(0);
    setCurrentToolName(null);
    setCurrentToolArgs(null);

    updateCurrentMessage((msg) => ({
      ...msg,
      isStreaming: false,
      content: msg.content + "\n\n[Interrupted]",
    }));

    currentMsgIdRef.current = null;
    currentThinkingMsgIdRef.current = null;
    activeToolBatchIdRef.current = null;

    const sysMsg: TUIMessage = {
      id: `sys-${Date.now()}`,
      role: "system",
      content: "Agent interrupted.",
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, sysMsg]);

    setTimeout(() => {
      setStatus("idle");
    }, 2000);
  }, [updateCurrentMessage, flushPendingText, stopTimer]);

  const clearMessages = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    pendingTextRef.current = "";
    startTimeRef.current = null;
    setMessages([]);
    isStreamingRef.current = false;
    setStatus("idle");
    setElapsedMs(0);
    setLastElapsedMs(null);
    setCurrentToolName(null);
    setCurrentToolArgs(null);
    setLastError(null);
    setFilesChangedCount(0);

    currentThinkingMsgIdRef.current = null;
    activeToolBatchIdRef.current = null;
    currentMsgIdRef.current = null;
  }, []);

  const state: AgentStreamState = {
    status,
    messages,
    tokensPerSecond,
    totalTokensUsed,
    elapsedMs,
    lastElapsedMs,
    currentToolName,
    currentToolArgs,
    lastError,
    filesChangedCount,
    reasoningTree,
    stalledMs,
  };

  return {
    state,
    handleEvent,
    addUserMessage,
    addSystemMessage,
    startAgent,
    interrupt,
    clearMessages,
  };
}

function summarizeArgs(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  if (obj.path) return String(obj.path);
  if (obj.file_path) return String(obj.file_path);
  if (obj.command) return String(obj.command).slice(0, 60);
  if (obj.pattern) return String(obj.pattern);
  if (obj.query) return String(obj.query).slice(0, 40);
  return "";
}

function detectResultKind(
  toolName: string,
  _output: string,
): "text" | "diff" | "bash_output" | "file_content" | "error" {
  const name = toolName.toLowerCase();
  if (name.includes("edit") || name.includes("diff")) return "diff";
  if (name.includes("bash") || name.includes("shell") || name.includes("exec")) return "bash_output";
  if (name.includes("read") || name.includes("file")) return "file_content";
  return "text";
}