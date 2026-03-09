/**
 * useAgentStream — bridges AgentLoop events to TUI React state.
 * Converts agent events into TUIMessage updates, tracks streaming state.
 */

import { useState, useCallback, useRef } from "react";
import type { TUIMessage, TUIToolCall, AgentStreamState } from "../types.js";

export interface UseAgentStreamReturn {
  state: AgentStreamState;
  /** Process an incoming agent event */
  handleEvent: (event: AgentEventLike) => void;
  /** Add a user message */
  addUserMessage: (content: string) => void;
  /** Add a system message (for slash commands, etc.) */
  addSystemMessage: (content: string) => void;
  /** Mark agent as started */
  startAgent: () => void;
  /** Interrupt and reset to idle */
  interrupt: () => void;
  /** Clear all messages */
  clearMessages: () => void;
}

/** Minimal agent event shape (matches @yuaone/core AgentEvent) */
export interface AgentEventLike {
  kind: string;
  [key: string]: unknown;
}

export function useAgentStream(): UseAgentStreamReturn {
  const [messages, setMessages] = useState<TUIMessage[]>([]);
  const [status, setStatus] = useState<AgentStreamState["status"]>("idle");
  const [streamBuffer, setStreamBuffer] = useState("");
  const [tokensPerSecond, setTokensPerSecond] = useState(0);
  const [totalTokensUsed, setTotalTokensUsed] = useState(0);

  const currentMsgIdRef = useRef<string | null>(null);
  const tokenWindowRef = useRef<{ time: number; tokens: number }[]>([]);

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
    setStatus("thinking");
    setStreamBuffer("");
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
  }, []);

  const updateCurrentMessage = useCallback(
    (updater: (msg: TUIMessage) => TUIMessage) => {
      const id = currentMsgIdRef.current;
      if (!id) return;
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? updater(m) : m)),
      );
    },
    [],
  );

  const handleEvent = useCallback(
    (event: AgentEventLike) => {
      switch (event.kind) {
        case "agent:thinking":
          setStatus("thinking");
          break;

        case "agent:text_delta": {
          const text = event.text as string;
          setStreamBuffer((prev) => prev + text);
          setStatus("streaming");
          updateCurrentMessage((msg) => ({
            ...msg,
            content: msg.content + text,
          }));
          break;
        }

        case "agent:tool_call": {
          setStatus("tool_running");
          const tc: TUIToolCall = {
            id: `tc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            toolName: event.tool as string,
            argsSummary: summarizeArgs(event.input),
            status: "running",
            isExpanded: false,
          };
          updateCurrentMessage((msg) => ({
            ...msg,
            toolCalls: [...(msg.toolCalls ?? []), tc],
          }));
          break;
        }

        case "agent:tool_result": {
          const toolName = event.tool as string;
          const output = event.output as string;
          const durationMs = event.durationMs as number;
          updateCurrentMessage((msg) => {
            const toolCalls = [...(msg.toolCalls ?? [])];
            // Find the last running tool call with this name
            for (let i = toolCalls.length - 1; i >= 0; i--) {
              if (toolCalls[i].toolName === toolName && toolCalls[i].status === "running") {
                toolCalls[i] = {
                  ...toolCalls[i],
                  status: "success",
                  duration: durationMs / 1000,
                  result: {
                    kind: detectResultKind(toolName, output),
                    content: output,
                    lineCount: output.split("\n").length,
                  },
                };
                break;
              }
            }
            return { ...msg, toolCalls };
          });
          break;
        }

        case "agent:error": {
          const errMsg = event.message as string;
          updateCurrentMessage((msg) => ({
            ...msg,
            content: msg.content + `\n\nError: ${errMsg}`,
            isStreaming: false,
          }));
          setStatus("idle");
          currentMsgIdRef.current = null;
          break;
        }

        case "agent:completed": {
          const summary = event.summary as string;
          updateCurrentMessage((msg) => ({
            ...msg,
            content: msg.content || summary,
            isStreaming: false,
          }));
          setStatus("idle");
          setStreamBuffer("");
          currentMsgIdRef.current = null;
          break;
        }

        case "agent:token_usage": {
          const input = event.input as number;
          const output = event.output as number;
          const total = input + output;
          setTotalTokensUsed((prev) => prev + total);

          // Rolling 3-second window for tokens/sec
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

        case "agent:approval_needed":
          setStatus("awaiting_approval");
          break;

        default:
          break;
      }
    },
    [updateCurrentMessage],
  );

  const interrupt = useCallback(() => {
    updateCurrentMessage((msg) => ({
      ...msg,
      isStreaming: false,
      content: msg.content + "\n\n[Interrupted]",
    }));
    setStatus("idle");
    setStreamBuffer("");
    currentMsgIdRef.current = null;

    const sysMsg: TUIMessage = {
      id: `sys-${Date.now()}`,
      role: "system",
      content: "Agent interrupted.",
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, sysMsg]);
  }, [updateCurrentMessage]);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setStreamBuffer("");
    setStatus("idle");
    currentMsgIdRef.current = null;
  }, []);

  const state: AgentStreamState = {
    status,
    streamBuffer,
    messages,
    tokensPerSecond,
    totalTokensUsed,
  };

  return { state, handleEvent, addUserMessage, addSystemMessage, startAgent, interrupt, clearMessages };
}

function summarizeArgs(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  // Common patterns: file path, command, query
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
