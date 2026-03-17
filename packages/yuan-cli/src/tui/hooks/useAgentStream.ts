/**
 * useAgentStream — bridges AgentLoop events to TUI React state.
 * Converts agent events into TUIMessage updates, tracks streaming state,
 * real-time elapsed timer, reasoning stream, and status indicator metadata.
 *
 * v2: Single-lane architecture — no more narration/final split.
 * One assistant message per agent turn. Tool calls attach to the same bubble.
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

// Debug logger — writes to ~/.yuan/logs/debug.log
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const _DLOG_FILE = path.join(os.homedir(), ".yuan", "logs", "debug.log");
function dlog(layer: string, msg: string, data?: unknown) {
  const now = new Date();
  const ts = `${now.getHours().toString().padStart(2,"0")}:${now.getMinutes().toString().padStart(2,"0")}:${now.getSeconds().toString().padStart(2,"0")}.${now.getMilliseconds().toString().padStart(3,"0")}`;
  const extra = data !== undefined ? " " + JSON.stringify(data) : "";
  const line = `[${ts}] [${layer}] ${msg}${extra}\n`;
  try { fs.appendFileSync(_DLOG_FILE, line); } catch {} // file only — no stderr (causes TUI jump)
}

export interface UseAgentStreamReturn {
  state: AgentStreamState;
  handleEvent: (event: AgentEventLike) => void;
  addUserMessage: (content: string) => void;
  addSystemMessage: (content: string) => void;
  addQueuedMessage: (content: string, id: string) => void;
  promoteQueuedMessage: (id: string) => void;
  updateQueuedMessage: (id: string, newContent: string) => void;
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

  // Single-lane: one current assistant message per agent turn
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

  // ── Single-lane text pipeline ─────────────────────────────────────────────
  // Raw tokens accumulate here. Every 60ms, whatever accumulated gets flushed
  // to the single current assistant message.
  const rawTextBufRef = useRef("");          // incoming token accumulator
  const pendingTextRef = rawTextBufRef;      // alias for flush call sites
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastChunkRef = useRef<string>(""); // for dedup: track previous chunk

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
  /* M10: idle timer ref to prevent race when startAgent clears previous timer */
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Extract complete sentences from text, returning {sentences, remainder}.
   * Used only for reasoning/thinking pacing (not for main text). */
  const extractSentences = (text: string): { sentences: string[]; remainder: string } => {
    const re = /[^.!?\n]*[.!?\n]+\s*/g;
    const matches = text.match(re);
    if (!matches) return { sentences: [], remainder: text };
    const matched = matches.join("");
    return { sentences: matches.map((s) => s.trim()).filter(Boolean), remainder: text.slice(matched.length).trimStart() };
  };

  /**
   * Ensure a single assistant message exists for the current agent turn.
   * Creates it lazily on first text/tool call — no empty bubbles.
   * Returns the message id.
   */
  function ensureAssistantMessage(): string {
    if (currentMsgIdRef.current) return currentMsgIdRef.current;
    const id = `asst-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    currentMsgIdRef.current = id;
    const msg: TUIMessage = {
      id,
      role: "assistant",
      streamKind: "final",
      content: "",
      timestamp: Date.now(),
      isStreaming: true,
      toolCalls: [],
    };
    setMessages((prev) => [...prev, msg]);
    return id;
  }

  /**
   * Throttled text flush — 60ms INTERVAL (not debounce).
   * Key difference: does NOT reset timer on each token.
   * Tokens accumulate in rawTextBufRef; every 60ms whatever has accumulated gets flushed.
   * This gives smooth, steady text output instead of dumping everything at once.
   */
  const scheduleTextFlush = useCallback(() => {
    // If timer already scheduled, don't reset — let it fire on schedule
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      const buf = rawTextBufRef.current;
      if (!buf) return;
      rawTextBufRef.current = "";
      updateCurrentMessage((msg) => ({
        ...msg,
        content: msg.content + buf,
      }));
    }, 60);
  }, [updateCurrentMessage]);

  // Legacy alias so call sites that used scheduleSentenceExtract still work
  const scheduleSentenceExtract = scheduleTextFlush;

  /** Force-flush: drain raw buffer to message content immediately. */
  const flushPendingText = useCallback(() => {
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }

    const raw = rawTextBufRef.current;
    if (raw) {
      rawTextBufRef.current = "";
      updateCurrentMessage((msg) => ({
        ...msg,
        content: msg.content + raw,
      }));
    }
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
      const id = `thinking-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
      id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: "user",
      content,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, msg]);
  }, []);

  const addSystemMessage = useCallback((content: string) => {
    const msg: TUIMessage = {
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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

  const updateQueuedMessage = useCallback((id: string, newContent: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, content: newContent } : m))
    );
  }, []);

  const startAgent = useCallback(() => {
    dlog("STREAM", `startAgent called`, { msgLength: 0 });
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
    // BUG #14 fix: finalize any orphaned streaming/thinking message from previous run
    if (currentThinkingMsgIdRef.current) {
      const orphanedThinkingId = currentThinkingMsgIdRef.current;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === orphanedThinkingId ? { ...m, isStreaming: false } : m,
        ),
      );
    }
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
    /* M10 fix: clear previous idle timer to prevent stale idle transition */
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }

    // Reset text buffer
    rawTextBufRef.current = "";
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }

    startTimer();

    // Deferred bubble creation: no assistant message created here.
    // ensureAssistantMessage() will create it lazily when the first
    // text_delta or tool_call arrives. This prevents empty bubbles.
    currentMsgIdRef.current = null;
  }, [startTimer]);

  const handleEvent = useCallback(
    (event: AgentEventLike) => {
      dlog("STREAM", `event received`, { kind: (event as {kind?: string}).kind ?? "unknown" });
      // Reset stall timer on every event
      lastEventAtRef.current = Date.now();
      setStalledMs(0);

      switch (event.kind) {
  case "agent:reasoning_delta": {
    const rText = String((event as { text?: string }).text ?? "");
    if (!rText) break;
    // BUG #28 fix: cap reasoning buffer to prevent unbounded memory growth
    const MAX_BUF = 50_000;
    if (reasoningRawBufRef.current.length > MAX_BUF) {
      reasoningRawBufRef.current = reasoningRawBufRef.current.slice(-40_000);
    }
    reasoningRawBufRef.current += rText;
    const { sentences, remainder } = extractSentences(reasoningRawBufRef.current);
    if (sentences.length > 0) {
      reasoningSentenceQRef.current.push(...sentences);
      reasoningRawBufRef.current = remainder;
      scheduleReasoningDrain();
    }
    // reasoning_delta goes to thinkingContent ONLY — never to message.content
    break;
  }
        case "agent:thinking": {
          statusRef.current = "thinking";
          setStatus("thinking");
          setCurrentToolName(null);
          setCurrentToolArgs(null);
          const thinkContent = String(event.content ?? "");
          // Filter internal-only events — never display in main chat transcript
          const isInternalTrace =
            thinkContent.startsWith("[shadow]") ||
            thinkContent.startsWith("[File Skill:") ||
            thinkContent.startsWith("[Phase:") ||
            thinkContent.startsWith("Phase: ") ||
            thinkContent.startsWith("phase: ") ||   // phase transition events
            thinkContent.startsWith("[nudge ") ||    // LLM reminder nudges
            thinkContent.startsWith("Token budget") || // token budget warnings
            thinkContent.startsWith("[token") ||
            thinkContent.startsWith("[verify") ||
            thinkContent.startsWith("[checkpoint");
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
          const text = typeof event.text === "string" ? event.text : String(event.text ?? "");
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
          if (text === lastChunkRef.current && text.length <= 20 && lastChunkRef.current.length > 0) {
            break;
          }
          lastChunkRef.current = text;

          // Ensure single assistant message exists (lazy creation)
          ensureAssistantMessage();

          // Accumulate in buffer; flush every 60ms
          rawTextBufRef.current += text;
          scheduleTextFlush();
          break;
        }

 case "agent:reasoning_timeline": {
  setReasoningTree(event.tree as ReasoningNode);
  break;
 }
        case "agent:tool_call": {
          // Flush any pending text BEFORE adding the tool call block.
          flushPendingText();
          isStreamingRef.current = false;

          // Ensure single assistant message exists (tool-only response)
          ensureAssistantMessage();

          const toolName = event.tool as string;
          dlog("STREAM", `tool call`, { toolName: (event as {toolName?: string}).toolName ?? toolName ?? "?" });

          // Filter internal protocol tools — task_complete is a completion signal, not a user-visible tool
          if (toolName === "task_complete") break;

          statusRef.current = "tool_running";
          setStatus("tool_running");

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
          const resultCallId = typeof event.callId === "string" ? event.callId : undefined;
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

              /* M9 fix: match by callId first (unique per invocation), fall back to toolName */
              const isMatch = resultCallId
                ? (call.callId === resultCallId && call.status === "running")
                : (call.toolName === toolName && call.status === "running");
              if (isMatch) {
                const completedAt = Date.now();

                let duration: number | undefined;
                if (durationMs) {
                  duration = durationMs / 1000;
                } else if (call.startedAt) {
                  duration = (completedAt - call.startedAt) / 1000;
                }

                // Truncate result content — storing full file content in React state
                // causes OOM when agent reads hundreds of files (each up to 100KB+).
                // TUI only shows a preview; full content is not needed in heap.
                const RESULT_PREVIEW_LIMIT = 1500;
                const truncatedOutput = output.length > RESULT_PREVIEW_LIMIT
                  ? output.slice(0, RESULT_PREVIEW_LIMIT) + `\n… (${output.length - RESULT_PREVIEW_LIMIT} chars truncated)`
                  : output;
                const kind = detectResultKind(toolName, output);
                const meta: { exitCode?: number; matchCount?: number; engine?: string } = {};
                if (kind === "bash_output") {
                  const ec = parseBashExitCode(output);
                  if (ec !== undefined) meta.exitCode = ec;
                } else if (kind === "grep_output") {
                  const mc = parseGrepMatchCount(output);
                  if (mc !== undefined) meta.matchCount = mc;
                }
                toolCalls[i] = {
                  ...call,
                  status: "success",
                  completedAt,
                  duration,
                  result: {
                    kind,
                    content: truncatedOutput,
                    lineCount: output.split("\n").length,
                    meta: Object.keys(meta).length > 0 ? meta : undefined,
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
          dlog("STREAM", `agent:error`, { message: (event as {message?: string}).message?.slice(0, 200) });
          flushReasoningQueue();
          const errMsg = event.message as string;
          setLastError(errMsg);
          stopTimer();
          statusRef.current = "error";
          setStatus("error");
          setStalledMs(0);
          setCurrentToolName(null);
          setCurrentToolArgs(null);

          // Flush text buffer
          if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
          rawTextBufRef.current = "";

          if (currentMsgIdRef.current) {
            updateCurrentMessage((msg) => ({
              ...msg,
              content: msg.content + `\n\nError: ${errMsg}`,
              isStreaming: false,
            }));
          } else {
            // No active message — show error as system message
            const errSysMsg: TUIMessage = {
              id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              role: "system",
              content: `Error: ${errMsg}`,
              timestamp: Date.now(),
            };
            setMessages((prev) => [...prev, errSysMsg]);
          }

          currentMsgIdRef.current = null;
          currentThinkingMsgIdRef.current = null;
          activeToolBatchIdRef.current = null;

          /* M10 fix: store idle timer ref for cancellation */
          if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
          idleTimerRef.current = setTimeout(() => {
            idleTimerRef.current = null;
            setStatus("idle");
          }, 3000);
          break;
        }

        case "agent:completed": {
          dlog("STREAM", `agent:complete`, { reason: (event as {reason?: string}).reason, tokensUsed: (event as {tokensUsed?: number}).tokensUsed });
          flushReasoningQueue();

          // Drain any pending text INLINE (not via flushPendingText) to avoid React batching
          // issue where completed's setMessages sees the pre-flush state (content still "").
          const pendingAtComplete = pendingTextRef.current;
          pendingTextRef.current = "";
          if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
          }

          flushThinkingLines();
          stopTimer();
          statusRef.current = "completed";
          setStatus("completed");
          setStalledMs(0);
          setCurrentToolName(null);
          setCurrentToolArgs(null);

          const summary = (event.summary as string) ?? "";

          if (currentMsgIdRef.current) {
            const id = currentMsgIdRef.current;
            setMessages((prev) => prev.map((m) => {
              if (m.id !== id) return m;
              const combined = m.content + pendingAtComplete;
              const hasText = combined.trim().length > 0;
              const hasSummary = summary && summary.trim().length > 0;
              return {
                ...m,
                content: hasText ? combined : hasSummary ? summary : "Done.",
                isStreaming: false,
              };
            }));
          }

          isStreamingRef.current = false;
          currentMsgIdRef.current = null;
          currentThinkingMsgIdRef.current = null;
          activeToolBatchIdRef.current = null;

          /* M10 fix: store idle timer ref for cancellation */
          if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
          idleTimerRef.current = setTimeout(() => {
            idleTimerRef.current = null;
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
            label: `QA ${stage}: ${summary}`,
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
          // Disabled — File Activity panel reserved for sub-agent background tasks only.
          // Regular file_read/tool results are already shown in the tool call tree.
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
          // Phase transition is internal — update footer only, never pollute chat transcript
          setProgressLabel(`${event.from as string} → ${to}`);
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
    [appendThinkingLines, updateCurrentMessage, flushPendingText, flushThinkingLines, flushReasoningQueue, scheduleReasoningDrain, scheduleSentenceExtract, scheduleTextFlush, stopTimer],
  );

  const interrupt = useCallback(() => {
    // BUG #9 fix: clear ALL timers including reasoningDrainTimerRef
    if (reasoningDrainTimerRef.current) {
      clearTimeout(reasoningDrainTimerRef.current);
      reasoningDrainTimerRef.current = null;
    }
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
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: "system",
      content: "Agent interrupted.",
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, sysMsg]);

    /* M10 fix: store idle timer ref for cancellation */
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null;
      setStatus("idle");
    }, 2000);
  }, [updateCurrentMessage, flushPendingText, flushThinkingLines, stopTimer]);

  const clearMessages = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (thinkingFlushTimerRef.current) {
      clearTimeout(thinkingFlushTimerRef.current);
      thinkingFlushTimerRef.current = null;
    }
    /* M11 fix: clear reasoningDrainTimer to prevent stale drain after /clear */
    if (reasoningDrainTimerRef.current) {
      clearTimeout(reasoningDrainTimerRef.current);
      reasoningDrainTimerRef.current = null;
    }
    /* M10 fix: also clear idle timer on /clear */
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
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
    updateQueuedMessage,
    startAgent,
    interrupt,
    clearMessages,
  };
}

function summarizeArgs(input: unknown): string {
  if (!input) return "";
  // LLM clients may emit arguments as a JSON string — parse it first
  let obj: Record<string, unknown>;
  if (typeof input === "string") {
    try { obj = JSON.parse(input) as Record<string, unknown>; }
    catch { return input.slice(0, 60); }
  } else if (typeof input === "object") {
    obj = input as Record<string, unknown>;
  } else {
    return "";
  }
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
): "text" | "diff" | "bash_output" | "grep_output" | "file_content" | "error" {
  const name = toolName.toLowerCase();
  if (name.includes("edit") || name.includes("diff")) return "diff";
  if (name === "bash" || name.includes("shell") || name.includes("exec")) return "bash_output";
  if (name === "grep") return "grep_output";
  if (name.includes("read") || name.includes("file")) return "file_content";
  return "text";
}

/** Parse bash exit code from output string "[exit 0] [123ms]" */
function parseBashExitCode(output: string): number | undefined {
  const m = output.match(/\[exit\s+(-?\d+)\]/);
  return m ? parseInt(m[1], 10) : undefined;
}

/** Parse grep match count from output string "(showing N of M total matches)" */
function parseGrepMatchCount(output: string): number | undefined {
  const m = output.match(/\(showing \d+ of (\d+) total matches\)/);
  if (m) return parseInt(m[1], 10);
  // No truncation message: count lines that look like "file:line: content"
  const lines = output.split("\n").filter(l => /^[^:]+:\d+:/.test(l));
  return lines.length > 0 ? lines.length : undefined;
}
