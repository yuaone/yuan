// src/routes/stream-router.ts
// YUAN Agent Backend — SSE Streaming Endpoint
//
// Provides real-time Server-Sent Events for an active agent session.
// Clients connect with GET /stream?sessionId=xxx&lastEventId=0 and receive
// a continuous stream of agent events (tool calls, text, status changes).

import { Router, type Request, type Response } from "express";

import { requireAuth } from "../auth/firebase-auth.js";
import { processManager, sessions } from "./session-router.js";
import type { AgentProcessMessage } from "../agent/process-manager.js";

/* ---------------------------------------------------------
 * Event buffer — bounded per session for reconnection replay
 * ------------------------------------------------------- */

interface BufferedEvent {
  id: number;
  event: string;
  data: string;
}

const eventBuffers = new Map<string, BufferedEvent[]>();
const eventCounters = new Map<string, number>();
const MAX_BUFFER_PER_SESSION = 500;

/** Tracks when a process was first observed dead, for grace-period cleanup. */
const deadSince = new Map<string, number>();
const DEAD_GRACE_PERIOD_MS = 60_000; // keep buffers 60s after process death

function getNextEventId(sessionId: string): number {
  const current = eventCounters.get(sessionId) ?? 0;
  const next = current + 1;
  eventCounters.set(sessionId, next);
  return next;
}

function bufferEvent(sessionId: string, event: string, data: string): number {
  const id = getNextEventId(sessionId);
  let buf = eventBuffers.get(sessionId);
  if (!buf) {
    buf = [];
    eventBuffers.set(sessionId, buf);
  }
  buf.push({ id, event, data });
  // Evict oldest when full
  if (buf.length > MAX_BUFFER_PER_SESSION) {
    buf.splice(0, Math.ceil(MAX_BUFFER_PER_SESSION * 0.2));
  }
  return id;
}

/* ---------------------------------------------------------
 * SSE write helpers (UTF-8 safe, single atomic writes)
 * ------------------------------------------------------- */

function sseWrite(res: Response, event: string, data: string, id?: number): void {
  let frame = "";
  if (id !== undefined) frame += `id: ${id}\n`;
  frame += `event: ${event}\ndata: ${data}\n\n`;

  // Single atomic write — Buffer.from ensures correct UTF-8 byte boundaries
  // (important for Korean / CJK text streamed in chunks).
  res.write(Buffer.from(frame, "utf8"));
}

function sseComment(res: Response, comment: string): void {
  res.write(Buffer.from(`: ${comment}\n\n`, "utf8"));
}

/* ---------------------------------------------------------
 * Router
 * ------------------------------------------------------- */

const router = Router();

router.use(requireAuth);

/* ---- GET /stream — SSE event stream ---- */

router.get("/stream", (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string | undefined;
  const lastEventId = Number(req.query.lastEventId) || 0;

  if (!sessionId) {
    res.status(400).json({ ok: false, error: "sessionId query param is required" });
    return;
  }

  // Verify the session belongs to the authenticated user
  const session = sessions.get(sessionId);
  if (!session) {
    res.status(404).json({ ok: false, error: "Session not found" });
    return;
  }
  if (session.userId !== req.user!.userId && req.user!.role !== "admin") {
    res.status(403).json({ ok: false, error: "Forbidden" });
    return;
  }

  /* ---- SSE headers ---- */
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  sseComment(res, "stream-start");

  /* ---- Replay buffered events from lastEventId ---- */
  const buffer = eventBuffers.get(sessionId);
  if (buffer && lastEventId > 0) {
    for (const entry of buffer) {
      if (entry.id > lastEventId) {
        sseWrite(res, entry.event, entry.data, entry.id);
      }
    }
  }

  /* ---- Check if process is alive ---- */
  if (!processManager.isAlive(sessionId)) {
    sseComment(res, "stream-end (session not running)");
    res.end();
    return;
  }

  /* ---- Keep-alive ping every 15 s ---- */
  const pingInterval = setInterval(() => {
    sseComment(res, "ping");
  }, 15_000);

  /* ---- Subscribe to process messages ---- */
  const onMessage = (sid: string, msg: AgentProcessMessage) => {
    if (sid !== sessionId) return;

    const eventType = msg.method ?? "message";
    const payload = JSON.stringify(msg.params ?? msg.result ?? msg);
    const id = bufferEvent(sessionId, eventType, payload);
    sseWrite(res, eventType, payload, id);
  };

  const onExit = (sid: string, code: number | null) => {
    if (sid !== sessionId) return;
    const id = bufferEvent(sessionId, "done", JSON.stringify({ code }));
    sseWrite(res, "done", JSON.stringify({ code }), id);
    cleanup();
    res.end();
  };

  const onError = (sid: string, err: Error) => {
    if (sid !== sessionId) return;
    const id = bufferEvent(sessionId, "error", JSON.stringify({ message: err.message }));
    sseWrite(res, "error", JSON.stringify({ message: err.message }), id);
  };

  processManager.on("message", onMessage);
  processManager.on("exit", onExit);
  processManager.on("error", onError);

  /* ---- Cleanup on client disconnect ---- */
  const cleanup = () => {
    clearInterval(pingInterval);
    processManager.off("message", onMessage);
    processManager.off("exit", onExit);
    processManager.off("error", onError);
  };

  req.on("close", cleanup);
  req.on("error", cleanup);
});

/* ---------------------------------------------------------
 * Periodic buffer cleanup — drop buffers for sessions that
 * ended more than 5 minutes ago.
 * ------------------------------------------------------- */

setInterval(() => {
  const now = Date.now();
  for (const sessionId of eventBuffers.keys()) {
    if (!processManager.isAlive(sessionId)) {
      // Track when the process was first observed dead
      if (!deadSince.has(sessionId)) {
        deadSince.set(sessionId, now);
        continue;
      }
      // Only clean up after the grace period has elapsed
      const diedAt = deadSince.get(sessionId)!;
      if (now - diedAt >= DEAD_GRACE_PERIOD_MS) {
        eventBuffers.delete(sessionId);
        eventCounters.delete(sessionId);
        deadSince.delete(sessionId);
      }
    } else {
      // Process came back alive (e.g. restarted) — clear dead tracker
      deadSince.delete(sessionId);
    }
  }
}, 30_000); // check every 30s

/* ---------------------------------------------------------
 * Export
 * ------------------------------------------------------- */

export { router as streamRouter };
