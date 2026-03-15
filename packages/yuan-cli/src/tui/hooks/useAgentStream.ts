/**
 * useAgentStream — bridges AgentLoop events to TUI React state.
 * Converts agent events into TUIMessage updates, tracks streaming state,
 * real-time elapsed timer, reasoning stream, and status indicator metadata.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import type {
  TUIMessage,
  TUIToolCall,
  TUIPhaseEvent,
  AgentStreamState,
  AgentStatus,
  ReasoningNode,
  TUIBackgroundTask,
  TUIBGStep,
} from "../types.js";

export interface UseAgentStreamReturn {
  state: AgentStreamState;
  handleEvent: (event: AgentEventLike) => void;
  addUserMessage: (content: string) => void;
  addSystemMessage: (content: string) => void;
  addQueuedMessage: (content: string, id: string) => void;
  promoteQueuedMessage: (id: string) => void;
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
  const [backgroundTasks, setBackgroundTasks] = useState<TUIBackgroundTask[]>([]);
  const [progressLabel, setProgressLabel] = useState<string | undefined>(undefined);
  const [currentPhase, setCurrentPhase] = useState<"explore" | "implement" | "verify" | "finalize" | undefined>(undefined);

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
    }, 200);
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

  /** Append one sentence to thinkingContent of the current assistant message */
  const appendReasoningSentence = useCallback((sentence: string) => {
    updateCurrentMessage((msg) => ({
      ...msg,
      thinkingContent: msg.thinkingContent
        ? `${msg.thinkingContent}\n${sentence}`
        : sentence,
    }));
  }, [updateCurrentMessage]);

  /** Schedule next sentence from the queue (1.5-3s random delay) */
  const scheduleReasoningDrain = useCallback(() => {
    if (reasoningDrainTimerRef.current) return;
    if (reasoningSentenceQRef.current.length === 0) return;
    const delay = 1500 + Math.random() * 1500;
    reasoningDrainTimerRef.current = setTimeout(() => {
      reasoningDrainTimerRef.current = null;
      const sentence = reasoningSentenceQRef.current.shift();
      if (sentence) appendReasoningSentence(sentence);
      if (reasoningSentenceQRef.current.length > 0) scheduleReasoningDrain();
    }, delay);
  }, [appendReasoningSentence]);

  /** Flush all remaining queued reasoning immediately (on complete/error) */
  const flushReasoningQueue = useCallback(() => {
    if (reasoningDrainTimerRef.current) {
      clearTimeout(reasoningDrainTimerRef.current);
      reasoningDrainTimerRef.current = null;
    }
    const remaining = [
      ...reasoningSentenceQRef.current.splice(0),
      reasoningRawBufRef.current.trim(),
    ].filter(Boolean).join("\n");
    reasoningRawBufRef.current = "";
    if (remaining) {
      updateCurrentMessage((msg) => ({
        ...msg,
        thinkingContent: msg.thinkingContent
          ? `${msg.thinkingContent}\n${remaining}`
          : remaining,
      }));
    }
  }, [updateCurrentMessage]);

  const pendingTextRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastChunkRef = useRef<string>(""); // for dedup: track previous chunk
  const FLUSH_INTERVAL = 40;

  // Debounce buffer for thinking/reasoning lines to avoid per-token re-renders
  const pendingThinkingRef = useRef<string[]>([]);
  const thinkingFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const THINKING_FLUSH_INTERVAL = 80; // 80ms batch — fast thinking display, minimal flicker

  // ── Reasoning sentence pacing ─────────────────────────────────────────────
  // reasoning_delta tokens arrive fast; we drip them out sentence-by-sentence
  // at a natural 1.5-3s interval so the "thinking" feels deliberate.
  const reasoningRawBufRef = useRef(""); // incoming raw token accumulator
  const reasoningSentenceQRef = useRef<string[]>([]); // sentences ready to show
  const reasoningDrainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Extract complete sentences from text, returning {sentences, remainder} */
  const extractSentences = (text: string): { sentences: string[]; remainder: string } => {
    // Match up to and including a sentence-terminator (. ! ? \n)
    const re = /[^.!?\n]*[.!?\n]+\s*/g;
    const matches = text.match(re);
    if (!matches) return { sentences: [], remainder: text };
    const matched = matches.join("");
    return { sentences: matches.map((s) => s.trim()).filter(Boolean), remainder: text.slice(matched.length) };
  };

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

  const flushThinkingLines = useCallback(() => {
    if (thinkingFlushTimerRef.current) {
      clearTimeout(thinkingFlushTimerRef.current);
      thinkingFlushTimerRef.current = null;
    }
    const lines = pendingThinkingRef.current;
    if (lines.length === 0) return;
    pendingThinkingRef.current = [];

    const currentId = currentThinkingMsgIdRef.current;

    if (!currentId) {
      const id = `thinking-${Date.now()}`;
      currentThinkingMsgIdRef.current = id;
      const msg: TUIMessage = {
        id,
        role: "system",
        content: lines.join("\n"),
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

  const appendThinkingLines = useCallback((raw: string) => {
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => (line.startsWith("· ") ? line : `· ${line}`));

    if (lines.length === 0) return;

    // Buffer lines and flush after a short debounce window to reduce re-renders
    pendingThinkingRef.current.push(...lines);
    if (thinkingFlushTimerRef.current) clearTimeout(thinkingFlushTimerRef.current);
    thinkingFlushTimerRef.current = setTimeout(flushThinkingLines, THINKING_FLUSH_INTERVAL);
  }, [flushThinkingLines]);

  useEffect(() => {
    return () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      if (thinkingFlushTimerRef.current) clearTimeout(thinkingFlushTimerRef.current);
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

  const addQueuedMessage = useCallback((content: string, id: string) => {
    const msg: TUIMessage = {
      id,
      role: "queued_user",
      content,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, msg]);
  }, []);

  const promoteQueuedMessage = useCallback((id: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, role: "user" } : m))
    );
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
    setCurrentPhase("explore");
    tokenWindowRef.current = [];
    currentThinkingMsgIdRef.current = null;
    activeToolBatchIdRef.current = null;
    lastToolCallAtRef.current = 0;
    // Reset reasoning pacing state
    reasoningRawBufRef.current = "";
    reasoningSentenceQRef.current = [];
    if (reasoningDrainTimerRef.current) {
      clearTimeout(reasoningDrainTimerRef.current);
      reasoningDrainTimerRef.current = null;
    }
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
    const rText = String((event as { text?: string }).text ?? "");
    if (!rText) break;
    reasoningRawBufRef.current += rText;
    const { sentences, remainder } = extractSentences(reasoningRawBufRef.current);
    if (sentences.length > 0) {
      reasoningSentenceQRef.current.push(...sentences);
      reasoningRawBufRef.current = remainder;
      scheduleReasoningDrain();
    }
    break;
  }
        case "agent:thinking": {
          statusRef.current = "thinking";
          setStatus("thinking");
          setCurrentToolName(null);
          setCurrentToolArgs(null);
          const thinkContent = String(event.content ?? "");
          // Filter shadow/internal prefixes — go to ReasoningPanel via App.tsx, not chat
          const isInternalTrace = thinkContent.startsWith("[shadow]") ||
            thinkContent.startsWith("[File Skill:") ||
            thinkContent.startsWith("Phase: ");
          if (!isInternalTrace) {
            appendThinkingLines(thinkContent);
          }
          break;
        }

        case "progress:status": {
          // Fine-grained status from ReasoningProgressAdapter: analyzing/searching/coding/etc.
          const label = String((event as unknown as { status?: string }).status ?? "");
          if (label) setProgressLabel(label);
          break;
        }

        case "agent:text_delta": {
          const text = event.text as string;
          if (!text) break;
          // Only update status/tool state on the FIRST token of a stream — not every token
          if (!isStreamingRef.current) {
            isStreamingRef.current = true;
            lastChunkRef.current = ""; // reset dedup on new stream
            currentThinkingMsgIdRef.current = null;
            statusRef.current = "streaming";
            setStatus("streaming");
            setCurrentToolName(null);
            setCurrentToolArgs(null);
          }
          // Dedup: skip ONLY if this chunk is identical to the previous chunk
          // (pure repeat at chunk boundary). Avoid buffer-suffix matching which
          // incorrectly drops legitimate text that happens to match the buffer tail.
          if (text === lastChunkRef.current && text.length <= 20 && lastChunkRef.current.length > 0) {
            break;
          }
          lastChunkRef.current = text;
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
          flushReasoningQueue();
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
          flushReasoningQueue();
          flushPendingText();
          flushThinkingLines();
          stopTimer();
          statusRef.current = "completed";
          setStatus("completed");
          setStalledMs(0);
          setCurrentToolName(null);
          setCurrentToolArgs(null);

          const summary = (event.summary as string) ?? "";
          updateCurrentMessage((msg) => {
            // When the agent only made tool calls (no text output), content is "".
            // Emit a synthetic "Done." so the user sees a completion indication.
            const hasText = msg.content && msg.content.trim().length > 0;
            const hasSummary = summary && summary.trim().length > 0;
            return {
              ...msg,
              content: hasText ? msg.content : hasSummary ? summary : "Done.",
              isStreaming: false,
            };
          });

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
          const statusLabel = passed ? "✓ passed" : `✗ ${issues.length} issue(s)`;
          const stepType: TUIBGStep["type"] = passed ? "success" : "warning";
          const summary = issues.length > 0
            ? `${statusLabel}: ${issues[0]?.slice(0, 60) ?? ""}${issues.length > 1 ? ` (+${issues.length - 1} more)` : ""}`
            : statusLabel;
          const now = Date.now();
          const step: TUIBGStep = {
            id: `qa-${now}-${Math.random().toString(36).slice(2, 6)}`,
            label: `[QA ${stage}] ${summary}`,
            type: stepType,
            timestamp: now,
          };
          setBackgroundTasks((prev) => {
            const existing = prev.find((t) => t.id === "qa-pipeline");
            const newSteps = existing
              ? [...existing.steps, step].slice(-20)
              : [step];
            if (existing) {
              return prev.map((t) =>
                t.id === "qa-pipeline"
                  ? { ...t, status: passed ? "idle" : "running", steps: newSteps, lastUpdatedAt: now }
                  : t,
              );
            }
            return [...prev, {
              id: "qa-pipeline",
              label: "QA Pipeline",
              status: passed ? "idle" : "running",
              steps: newSteps,
              lastUpdatedAt: now,
            }];
          });
          break;
        }

        case "agent:evidence_report": {
          const ev = event as unknown as {
            filePath: string; tool: string;
            syntax: "ok" | "error" | "skipped";
            diffStats: { added: number; removed: number } | null;
            timestamp: number;
          };
          const { filePath, syntax, diffStats } = ev;
          const fileName = filePath.split("/").pop() ?? filePath;
          const syntaxLabel = syntax === "ok" ? "✓ syntax" : syntax === "error" ? "✗ syntax err" : "";
          const diffLabel = diffStats ? `+${diffStats.added}/-${diffStats.removed}` : "";
          const parts = [syntaxLabel, diffLabel].filter(Boolean).join("  ");
          const now = Date.now();
          const step: TUIBGStep = {
            id: `ev-${now}-${Math.random().toString(36).slice(2, 6)}`,
            label: `[evidence] ${fileName}${parts ? "  " + parts : ""}`,
            type: syntax === "error" ? "warning" : "success",
            timestamp: now,
          };
          setBackgroundTasks((prev) => {
            const existing = prev.find((t) => t.id === "evidence");
            const newSteps = existing
              ? [...existing.steps, step].slice(-20)
              : [step];
            if (existing) {
              return prev.map((t) =>
                t.id === "evidence"
                  ? { ...t, steps: newSteps, lastUpdatedAt: now }
                  : t,
              );
            }
            return [...prev, {
              id: "evidence",
              label: "Evidence",
              status: "idle" as const,
              steps: newSteps,
              lastUpdatedAt: now,
            }];
          });
          break;
        }

        case "agent:bg_update": {
          const { agentId, agentLabel, eventType, message, timestamp } = event as unknown as {
            agentId: string; agentLabel: string; eventType: TUIBGStep["type"]; message: string; timestamp: number;
          };
          const step: TUIBGStep = {
            id: `step-${timestamp}-${Math.random().toString(36).slice(2, 6)}`,
            label: message.length > 60 ? message.slice(0, 57) + "…" : message,
            type: eventType,
            timestamp,
          };
          setBackgroundTasks((prev) => {
            const existing = prev.find((t) => t.id === agentId);
            const MAX_STEPS = 20;
            if (existing) {
              const newSteps = [...existing.steps, step].slice(-MAX_STEPS);
              return prev.map((t) =>
                t.id === agentId
                  ? {
                      ...t,
                      status: eventType === "error" ? "error" : "running",
                      steps: newSteps,
                      lastUpdatedAt: timestamp,
                    }
                  : t,
              );
            }
            const newTask: TUIBackgroundTask = {
              id: agentId,
              label: agentLabel,
              status: eventType === "error" ? "error" : "running",
              steps: [step],
              lastUpdatedAt: timestamp,
            };
            return [...prev, newTask];
          });
          break;
        }

        case "agent:phase_transition": {
          const to = event.to as "explore" | "implement" | "verify" | "finalize";
          setCurrentPhase(to);
          // Append as a dim thinking line — no new message bubble, no status overlap
          appendThinkingLines(`phase: ${event.from as string} → ${to} (${event.trigger as string})`);
          break;
        }

        case "agent:subagent_phase": {
          // Route to task panel, not main message stream
          const taskId = event.taskId as string;
          const phase = event.phase as string;
          const now = Date.now();
          const step: TUIBGStep = {
            id: `step-${now}-${Math.random().toString(36).slice(2, 6)}`,
            label: phase.length > 60 ? phase.slice(0, 57) + "…" : phase,
            type: "info",
            timestamp: now,
          };
          setBackgroundTasks((prev) => {
            const existing = prev.find((t) => t.id === taskId);
            if (existing) {
              return prev.map((t) =>
                t.id === taskId
                  ? { ...t, status: "running" as const, steps: [...t.steps, step].slice(-20), lastUpdatedAt: now }
                  : t
              );
            }
            const newTask: TUIBackgroundTask = {
              id: taskId,
              label: taskId,
              status: "running",
              steps: [step],
              lastUpdatedAt: now,
            };
            return [...prev, newTask];
          });
          break;
        }

        case "agent:subagent_done": {
          const taskId = event.taskId as string;
          const success = event.success as boolean;
          const now = Date.now();
          const step: TUIBGStep = {
            id: `step-${now}-${Math.random().toString(36).slice(2, 6)}`,
            label: success ? "done" : "failed",
            type: success ? "success" : "error",
            timestamp: now,
          };
          setBackgroundTasks((prev) =>
            prev.map((t) =>
              t.id === taskId
                ? { ...t, status: success ? "idle" as const : "error" as const, steps: [...t.steps, step].slice(-20), lastUpdatedAt: now }
                : t
            )
          );
          break;
        }

        // ─── Phase 3: Autonomous Engineering Loop ───────────────────────
        case "agent:research_result": {
          const ev = event as unknown as {
            taskId: string; summary: string;
            sources: Array<{ title: string; url: string; snippet: string; source: string }>;
            confidence: number; timestamp: number;
          };
          const repoCount = ev.sources.filter(s => s.source === "repo").length;
          const webCount = ev.sources.filter(s => s.source !== "repo").length;
          const pct = Math.round(ev.confidence * 100);
          const phaseEvent: TUIPhaseEvent = {
            id: `research-${ev.timestamp}`,
            kind: "research",
            title: `Research  confidence:${pct}%  ${ev.sources.length} sources`,
            summary: ev.summary.split("\n")[0] ?? "",
            items: [
              `${repoCount} repo  ${webCount} web`,
              ...ev.sources.slice(0, 5).map(s => `${s.title.slice(0, 40)}: ${s.snippet.slice(0, 60)}`),
            ],
            status: "done",
            timestamp: ev.timestamp,
          };
          updateCurrentMessage((msg) => ({
            ...msg,
            phaseEvents: [...(msg.phaseEvents ?? []), phaseEvent],
          }));
          break;
        }

        case "agent:plan_generated": {
          const ev = event as unknown as {
            taskId: string;
            steps: Array<{ index: number; description: string; dependsOn: number[] }>;
            storedAt: string; timestamp: number;
          };
          const phaseEvent: TUIPhaseEvent = {
            id: `plan-${ev.timestamp}`,
            kind: "plan",
            title: `Plan  ${ev.steps.length} steps`,
            summary: ev.steps[0]?.description ?? "",
            items: ev.steps.map((s, i) => {
              const dep = s.dependsOn.length > 0 ? ` (after ${s.dependsOn.map(d => d + 1).join(",")})` : "";
              return `${i + 1}. ${s.description.slice(0, 70)}${dep}`;
            }),
            status: "done",
            timestamp: ev.timestamp,
          };
          updateCurrentMessage((msg) => ({
            ...msg,
            phaseEvents: [...(msg.phaseEvents ?? []), phaseEvent],
          }));
          break;
        }

        case "agent:tournament_result": {
          const ev = event as unknown as {
            taskId: string; winner: number; candidates: number;
            qualityScore: number; timestamp: number;
          };
          const pct = Math.round(ev.qualityScore * 100);
          const phaseEvent: TUIPhaseEvent = {
            id: `tournament-${ev.timestamp}`,
            kind: "tournament",
            title: `Tournament  winner:patch${ev.winner + 1}  score:${pct}%`,
            summary: `${ev.candidates} candidates evaluated`,
            items: [
              `Candidates: ${ev.candidates}`,
              `Winner: patch ${ev.winner + 1} of ${ev.candidates}`,
              `Quality score: ${pct}%`,
            ],
            status: ev.qualityScore > 0 ? "done" : "error",
            timestamp: ev.timestamp,
          };
          updateCurrentMessage((msg) => ({
            ...msg,
            phaseEvents: [...(msg.phaseEvents ?? []), phaseEvent],
          }));
          break;
        }

        case "agent:task_memory_update": {
          const ev = event as unknown as {
            taskId: string; phase: string; status: string; timestamp: number;
          };
          const statusIcon = ev.status === "completed" ? "✓" : ev.status === "failed" ? "✗" : "●";
          const phaseEvent: TUIPhaseEvent = {
            id: `task-${ev.timestamp}`,
            kind: "task",
            title: `Task  ${statusIcon} ${ev.status}  phase:${ev.phase}`,
            summary: `${ev.taskId.slice(0, 16)}…  ${ev.phase}`,
            items: [
              `Task: ${ev.taskId.slice(0, 32)}`,
              `Phase: ${ev.phase}`,
              `Status: ${ev.status}`,
            ],
            status: ev.status === "completed" ? "done" : ev.status === "failed" ? "error" : "running",
            timestamp: ev.timestamp,
          };
          updateCurrentMessage((msg) => ({
            ...msg,
            phaseEvents: [...(msg.phaseEvents ?? []), phaseEvent],
          }));
          break;
        }

        case "agent:debug_report": {
          const ev = event as unknown as {
            taskId: string; rootCause: string; suspectedFiles: string[];
            fixStrategy: string; confidence: number; timestamp: number;
          };
          const pct = Math.round(ev.confidence * 100);
          const phaseEvent: TUIPhaseEvent = {
            id: `debug-${ev.timestamp}`,
            kind: "debug",
            title: `Debug Report  confidence:${pct}%`,
            summary: ev.rootCause.slice(0, 80),
            items: [
              `Root cause: ${ev.rootCause.slice(0, 80)}`,
              `Suspected: ${ev.suspectedFiles.slice(0, 3).join(", ") || "none"}`,
              `Fix: ${ev.fixStrategy.slice(0, 80)}`,
            ],
            status: ev.confidence > 0.3 ? "done" : "error",
            timestamp: ev.timestamp,
          };
          updateCurrentMessage((msg) => ({
            ...msg,
            phaseEvents: [...(msg.phaseEvents ?? []), phaseEvent],
          }));
          break;
        }

        default:
          break;
      }

      // Clear progressLabel whenever agent goes to a terminal/non-thinking state
      const k = event.kind;
      if (k === "agent:done" || k === "agent:completed" || k === "agent:error" ||
          k === "agent:tool_call" || k === "agent:text_delta") {
        setProgressLabel(undefined);
      }
    },
    [appendThinkingLines, updateCurrentMessage, flushPendingText, flushThinkingLines, stopTimer],
  );

  const interrupt = useCallback(() => {
    flushPendingText();
    flushThinkingLines();
    stopTimer();
    statusRef.current = "interrupted";
    setStatus("interrupted");
    setStalledMs(0);
    setCurrentToolName(null);
    setCurrentToolArgs(null);
    setProgressLabel(undefined);

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
    if (thinkingFlushTimerRef.current) {
      clearTimeout(thinkingFlushTimerRef.current);
      thinkingFlushTimerRef.current = null;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    pendingTextRef.current = "";
    pendingThinkingRef.current = [];
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
    backgroundTasks,
    progressLabel,
    currentPhase,
  };

  return {
    state,
    handleEvent,
    addUserMessage,
    addSystemMessage,
    addQueuedMessage,
    promoteQueuedMessage,
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