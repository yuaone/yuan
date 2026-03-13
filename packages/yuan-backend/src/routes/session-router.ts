// src/routes/session-router.ts
// YUAN Agent Backend — Session REST API
//
// Provides CRUD and control endpoints for agent sessions.
// All routes require Firebase auth (requireAuth middleware).

import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import path from "node:path";

import { requireAuth } from "../auth/firebase-auth.js";
import { ProcessManager } from "../agent/process-manager.js";
import { UsageTracker } from "../agent/usage-tracker.js";
import { AbuseDetector } from "../agent/abuse-detector.js";
import {
  createSession as dbCreateSession,
  getSession as dbGetSession,
  getUserSessions as dbGetUserSessions,
  updateSessionStatus as dbUpdateSessionStatus,
  incrementUsage as dbIncrementUsage,
  getPlanLimits,
} from "../db/session-repository.js";

/* ---------------------------------------------------------
 * Shared singletons (exported so other routers can reuse)
 * ------------------------------------------------------- */

export const processManager = new ProcessManager();
export const usageTracker = new UsageTracker();
export const abuseDetector = new AbuseDetector();

/* ---------------------------------------------------------
 * Validation helpers
 * ------------------------------------------------------- */

/** Allowlist-based work directory validation — only permits user home dirs and /tmp. */
function isValidWorkDir(dir: string): boolean {
  const resolved = path.resolve(dir);
  // Allowlist: only home directories and /tmp are permitted
  const ALLOWED_PREFIXES = ["/home/", "/tmp/", "/Users/"];
  if (!ALLOWED_PREFIXES.some((p) => resolved.startsWith(p))) {
    return false;
  }
  // Must not be a root-level home directory itself (need at least /home/user/project)
  const segments = resolved.split(path.sep).filter(Boolean);
  if (resolved.startsWith("/home/") && segments.length < 3) return false;
  if (resolved.startsWith("/Users/") && segments.length < 3) return false;
  return true;
}

/* ---------------------------------------------------------
 * In-memory active session cache (for running process tracking).
 * DB is the source of truth for completed sessions.
 * ------------------------------------------------------- */

export interface ActiveSessionRecord {
  id: string;
  userId: number;
  firebaseUid: string;
  goal: string;
  workDir: string;
  model: string;
  provider: string;
  status: "running" | "stopped" | "completed" | "failed" | "pending_approval";
  createdAt: number;
  updatedAt: number;
}

/** In-memory map for ACTIVE sessions only (process-manager needs it) */
export const activeSessions = new Map<string, ActiveSessionRecord>();

/** @deprecated Backward-compatible alias — other modules still import `sessions` */
export { activeSessions as sessions };

/** @deprecated Use ActiveSessionRecord instead */
export type SessionRecord = ActiveSessionRecord;

/* ---------------------------------------------------------
 * Router
 * ------------------------------------------------------- */

const router: import("express").Router = Router();

// All session routes require authentication
router.use(requireAuth);

/* ---- POST /session — Create a new agent session ---- */

router.post("/session", async (req, res) => {
  const user = req.user!;
  const { goal, workDir, model, provider } = req.body as {
    goal?: string;
    workDir?: string;
    model?: string;
    provider?: string;
  };

  // Validate required fields
  if (!goal || typeof goal !== "string" || goal.trim().length === 0) {
    res.status(400).json({ ok: false, error: "goal is required" });
    return;
  }

  if (goal.length > 50_000) {
    res.status(400).json({ ok: false, error: "goal exceeds maximum length (50000 chars)" });
    return;
  }

  if (!workDir || typeof workDir !== "string" || workDir.trim().length === 0) {
    res.status(400).json({ ok: false, error: "workDir is required" });
    return;
  }

  if (!isValidWorkDir(workDir)) {
    res.status(400).json({ ok: false, error: "workDir is not allowed" });
    return;
  }

  // Validate model/provider strings — alphanumeric, dashes, dots, underscores, slashes
  const VALID_IDENTIFIER = /^[\w.\-/]{1,200}$/;
  if (model && !VALID_IDENTIFIER.test(model)) {
    res.status(400).json({ ok: false, error: "model contains invalid characters" });
    return;
  }
  if (provider && !VALID_IDENTIFIER.test(provider)) {
    res.status(400).json({ ok: false, error: "provider contains invalid characters" });
    return;
  }

  // Abuse check — use plan-based max concurrent
  let planLimits;
  try {
    planLimits = await getPlanLimits(user.plan);
  } catch {
    planLimits = { dailySessions: 20, maxIterations: 50, maxTokensPerSession: 200_000, maxConcurrent: 2, features: {} };
  }

  const userActiveSessions = processManager
    .getActiveProcesses()
    .filter((sid) => activeSessions.get(sid)?.userId === user.userId);

  const abuseResult = abuseDetector.check(user.userId, "create_session", {
    concurrentSessions: userActiveSessions.length,
    maxConcurrent: planLimits.maxConcurrent,
  });

  if (!abuseResult.allowed) {
    res.status(429).json({ ok: false, error: abuseResult.reason });
    return;
  }

  // Plan-limit check (uses plan from DB via req.user.plan)
  const limitResult = usageTracker.checkLimits(user.userId, user.plan);
  if (!limitResult.allowed) {
    res.status(429).json({ ok: false, error: limitResult.reason });
    return;
  }

  // Create session
  const sessionId = uuidv4();
  const now = Date.now();
  const resolvedModel = model?.trim() || "claude-sonnet-4-20250514";
  const resolvedProvider = provider?.trim() || "anthropic";
  const trimmedGoal = goal.trim();
  const trimmedWorkDir = workDir.trim();

  // Persist to in-memory active cache
  const activeRecord: ActiveSessionRecord = {
    id: sessionId,
    userId: user.userId,
    firebaseUid: user.firebaseUid,
    goal: trimmedGoal,
    workDir: trimmedWorkDir,
    model: resolvedModel,
    provider: resolvedProvider,
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
  activeSessions.set(sessionId, activeRecord);

  // Persist to DB (fire-and-forget with error logging)
  dbCreateSession({
    id: sessionId,
    userId: user.userId,
    goal: trimmedGoal,
    workDir: trimmedWorkDir,
    model: resolvedModel,
  }).catch((err) => {
    console.error("[YUAN] Failed to persist session to DB:", err instanceof Error ? err.message : err);
  });

  // Increment daily usage counter in DB
  dbIncrementUsage(user.userId, 0).catch((err) => {
    console.error("[YUAN] Failed to increment usage:", err instanceof Error ? err.message : err);
  });

  // Spawn agent process
  try {
    processManager.spawn({
      sessionId,
      goal: trimmedGoal,
      workDir: trimmedWorkDir,
      provider: resolvedProvider,
      model: resolvedModel,
      apiKey: "", // BYOK — resolved in worker from user config
      maxIterations: planLimits.maxIterations,
      userId: user.userId,
    });
  } catch (err) {
    activeRecord.status = "failed";
    activeRecord.updatedAt = Date.now();
    dbUpdateSessionStatus(sessionId, "failed", { error: err instanceof Error ? err.message : "spawn_failed" }).catch(() => {});
    const message = err instanceof Error ? err.message : "Failed to start agent";
    res.status(500).json({ ok: false, error: message });
    return;
  }

  const streamUrl = `/api/yuan/stream?sessionId=${sessionId}`;
  res.status(201).json({ ok: true, sessionId, streamUrl });
});

/* ---- GET /session/:id — Get session details ---- */

router.get("/session/:id", async (req, res) => {
  const user = req.user!;
  const sessionId = req.params.id!;

  // Check in-memory active cache first (fast path for running sessions)
  const activeRecord = activeSessions.get(sessionId);
  if (activeRecord) {
    if (activeRecord.userId !== user.userId && user.role !== "admin") {
      res.status(403).json({ ok: false, error: "Forbidden" });
      return;
    }
    res.json({ ok: true, session: activeRecord });
    return;
  }

  // Fall back to DB for completed/historical sessions
  try {
    const dbRecord = await dbGetSession(sessionId);
    if (!dbRecord) {
      res.status(404).json({ ok: false, error: "Session not found" });
      return;
    }
    if (dbRecord.userId !== user.userId && user.role !== "admin") {
      res.status(403).json({ ok: false, error: "Forbidden" });
      return;
    }
    res.json({ ok: true, session: dbRecord });
  } catch {
    res.status(404).json({ ok: false, error: "Session not found" });
  }
});

/* ---- GET /sessions — List user's sessions ---- */

router.get("/sessions", async (req, res) => {
  const user = req.user!;
  const status = req.query.status as string | undefined;
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  try {
    const result = await dbGetUserSessions(user.userId, limit, offset, status);
    res.json({ ok: true, sessions: result.sessions, total: result.total });
  } catch {
    // DB unavailable — fall back to in-memory active sessions
    let userSessions = Array.from(activeSessions.values())
      .filter((s) => s.userId === user.userId)
      .sort((a, b) => b.createdAt - a.createdAt);

    if (status) {
      userSessions = userSessions.filter((s) => s.status === status);
    }

    const total = userSessions.length;
    const page = userSessions.slice(offset, offset + limit);

    res.json({ ok: true, sessions: page, total });
  }
});

/* ---- POST /session/:id/stop — Stop a running session ---- */

router.post("/session/:id/stop", (req, res) => {
  const user = req.user!;
  const record = activeSessions.get(req.params.id!);

  if (!record) {
    res.status(404).json({ ok: false, error: "Session not found" });
    return;
  }

  if (record.userId !== user.userId && user.role !== "admin") {
    res.status(403).json({ ok: false, error: "Forbidden" });
    return;
  }

  processManager.kill(record.id);
  record.status = "stopped";
  record.updatedAt = Date.now();
  dbUpdateSessionStatus(record.id, "stopped").catch((err) => {
    console.error("[YUAN] Failed to persist stop status:", err instanceof Error ? err.message : err);
  });

  res.json({ ok: true });
});

/* ---- POST /session/:id/approve — Resolve pending approval ---- */

router.post("/session/:id/approve", (req, res) => {
  const user = req.user!;
  const record = activeSessions.get(req.params.id!);

  if (!record) {
    res.status(404).json({ ok: false, error: "Session not found" });
    return;
  }

  if (record.userId !== user.userId && user.role !== "admin") {
    res.status(403).json({ ok: false, error: "Forbidden" });
    return;
  }

  const { approved, message } = req.body as {
    approved?: boolean;
    message?: string;
  };

  if (typeof approved !== "boolean") {
    res.status(400).json({ ok: false, error: "approved (boolean) is required" });
    return;
  }

  // Forward approval decision to the agent process via IPC
  const sent = processManager.send(record.id, {
    jsonrpc: "2.0",
    method: "approval_response",
    params: { approved, message: message ?? "" },
  });

  if (!sent) {
    res.status(409).json({ ok: false, error: "Agent process is not running" });
    return;
  }

  record.status = "running";
  record.updatedAt = Date.now();

  res.json({ ok: true });
});

/* ---- POST /session/:id/interrupt — Soft/hard interrupt ---- */

router.post("/session/:id/interrupt", (req, res) => {
  const user = req.user!;
  const record = activeSessions.get(req.params.id!);

  if (!record) {
    res.status(404).json({ ok: false, error: "Session not found" });
    return;
  }

  if (record.userId !== user.userId && user.role !== "admin") {
    res.status(403).json({ ok: false, error: "Forbidden" });
    return;
  }

  const { type } = req.body as { type?: string };
  const validTypes = ["soft", "hard", "pause", "resume"];

  if (!type || !validTypes.includes(type)) {
    res.status(400).json({
      ok: false,
      error: `type must be one of: ${validTypes.join(", ")}`,
    });
    return;
  }

  if (type === "hard") {
    processManager.kill(record.id, "SIGKILL");
    record.status = "stopped";
    record.updatedAt = Date.now();
    dbUpdateSessionStatus(record.id, "stopped").catch((err) => {
      console.error("[YUAN] Failed to persist hard-stop status:", err instanceof Error ? err.message : err);
    });
    res.json({ ok: true });
    return;
  }

  // Soft / pause / resume — send IPC message to agent
  const sent = processManager.send(record.id, {
    jsonrpc: "2.0",
    method: "interrupt",
    params: { type },
  });

  if (!sent) {
    res.status(409).json({ ok: false, error: "Agent process is not running" });
    return;
  }

  record.updatedAt = Date.now();
  res.json({ ok: true });
});

/* ---------------------------------------------------------
 * Process event listeners — keep session status in sync
 * ------------------------------------------------------- */

processManager.on("exit", (sessionId: string, code: number | null) => {
  const record = activeSessions.get(sessionId);
  if (!record) return;
  const status = code === 0 ? "completed" : "failed";
  record.status = status;
  record.updatedAt = Date.now();
  // Persist final status to DB, then remove from active cache
  dbUpdateSessionStatus(sessionId, status).catch((err) => {
    console.error("[YUAN] Failed to persist exit status:", err instanceof Error ? err.message : err);
  });
  // Keep in active cache briefly for any in-flight requests, then evict
  setTimeout(() => activeSessions.delete(sessionId), 30_000);
});

processManager.on("timeout", (sessionId: string) => {
  const record = activeSessions.get(sessionId);
  if (!record) return;
  record.status = "failed";
  record.updatedAt = Date.now();
  dbUpdateSessionStatus(sessionId, "failed", { error: "timeout" }).catch((err) => {
    console.error("[YUAN] Failed to persist timeout status:", err instanceof Error ? err.message : err);
  });
  setTimeout(() => activeSessions.delete(sessionId), 30_000);
});

/* ---------------------------------------------------------
 * Export
 * ------------------------------------------------------- */

export { router as sessionRouter };
