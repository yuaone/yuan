// src/routes/usage-router.ts
// YUAN Agent Backend — Usage Tracking & Reporting API
//
// Exposes user-facing usage summaries, per-model breakdowns, and
// session-level usage history.

import { Router } from "express";

import { requireAuth } from "../auth/firebase-auth.js";
import { usageTracker } from "./session-router.js";
import {
  getDailyUsage as dbGetDailyUsage,
  getPlanLimits,
} from "../db/session-repository.js";

/* ---------------------------------------------------------
 * Router
 * ------------------------------------------------------- */

const router: import("express").Router = Router();

router.use(requireAuth);

/* ---- GET /usage — User's usage summary ---- */

router.get("/usage", async (req, res) => {
  const user = req.user!;
  const plan = user.plan;

  const summary = usageTracker.getSummary(user.userId, plan);

  // Fetch plan limits and DB usage in parallel
  let planLimits;
  let dbUsage;
  try {
    [planLimits, dbUsage] = await Promise.all([
      getPlanLimits(plan),
      dbGetDailyUsage(user.userId),
    ]);
  } catch {
    // DB unavailable — use in-memory tracker only
    planLimits = null;
    dbUsage = null;
  }

  res.json({
    ok: true,
    usage: {
      daily: {
        ...summary.daily,
        // Overlay DB usage when available
        ...(dbUsage ? { sessionsUsed: dbUsage.sessionCount, tokensUsed: dbUsage.totalTokens } : {}),
      },
      monthly: summary.monthly,
      limits: {
        dailyTokens: summary.daily.limit,
        dailySessions: planLimits?.dailySessions ?? 20,
        maxIterations: planLimits?.maxIterations ?? 50,
        maxTokensPerSession: planLimits?.maxTokensPerSession ?? 200_000,
        maxConcurrent: planLimits?.maxConcurrent ?? 2,
      },
      plan,
    },
  });
});

/* ---- GET /usage/models — Per-model breakdown ---- */

router.get("/usage/models", (req, res) => {
  const user = req.user!;
  const breakdown = usageTracker.getModelBreakdown(user.userId);

  res.json({
    ok: true,
    models: breakdown.map((m) => ({
      name: m.model,
      provider: m.provider,
      tokensUsed: m.tokensUsed,
      percentage: m.percentage,
    })),
  });
});

/* ---- GET /usage/sessions — Session-level usage history ---- */

router.get("/usage/sessions", (req, res) => {
  const user = req.user!;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const from = req.query.from ? new Date(req.query.from as string).getTime() : 0;
  const to = req.query.to ? new Date(req.query.to as string).getTime() : Date.now();

  // Aggregate records by session
  const daily = usageTracker.getDailyUsage(user.userId);
  const monthly = usageTracker.getMonthlyUsage(user.userId);

  // For a detailed session list we return the model breakdown as a proxy.
  // A full session-usage join requires DB storage (future iteration).
  const breakdown = usageTracker.getModelBreakdown(user.userId);

  res.json({
    ok: true,
    sessions: breakdown.slice(0, limit),
    summary: { daily, monthly },
    query: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), limit },
  });
});

/* ---------------------------------------------------------
 * Export
 * ------------------------------------------------------- */

export { router as usageRouter };
