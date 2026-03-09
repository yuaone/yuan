// src/server.ts
// YUAN Agent Backend — Express Server Entry Point

import "express-async-errors";

import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";

dotenv.config();

import { initPostgres } from "./db/postgres.js";
import { initRedis } from "./db/redis.js";

/* ---------------------------------------------------------
 * APP
 * ------------------------------------------------------- */
const app = express();
const PORT = Number(process.env.YUAN_PORT || "4100");

const CORS_ORIGINS = (process.env.YUAN_CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DEFAULT_ORIGINS = [
  "https://yuaone.com",
  "https://www.yuaone.com",
  "http://localhost:3000",
  "http://localhost:3100",
  "http://localhost:5173",
];

/* ---------------------------------------------------------
 * Trust proxy (reverse proxy / Next.js rewrite)
 * Trust only the first proxy hop (e.g. nginx / ALB).
 * ------------------------------------------------------- */
app.set("trust proxy", 1);

/* ---------------------------------------------------------
 * Disable ETag (SSE buffering prevention)
 * ------------------------------------------------------- */
app.disable("etag");

/* ---------------------------------------------------------
 * Security
 * ------------------------------------------------------- */
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
  }),
);

app.use(
  cors({
    origin: CORS_ORIGINS.length > 0 ? CORS_ORIGINS : DEFAULT_ORIGINS,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

/* ---------------------------------------------------------
 * SSE buffering prevention (nginx / proxy)
 * ------------------------------------------------------- */
app.use((_req, res, next) => {
  res.setHeader("X-Accel-Buffering", "no");
  next();
});

/* ---------------------------------------------------------
 * Body parser
 * ------------------------------------------------------- */
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

/* ---------------------------------------------------------
 * DB Init — non-fatal; server starts in degraded mode if
 * either Postgres or Redis is unavailable.
 * ------------------------------------------------------- */
let dbHealthy = false;

(async () => {
  try {
    await initPostgres();
    console.log("[YUAN] PostgreSQL initialized");
    await initRedis();
    console.log("[YUAN] Redis initialized");
    dbHealthy = true;
  } catch (err) {
    console.error("[YUAN] DB init failed, server starting in degraded mode:", err);
  }
})();

/* ---------------------------------------------------------
 * Health Check
 * ------------------------------------------------------- */
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "yuan-backend", port: PORT, db: dbHealthy });
});

/* ---------------------------------------------------------
 * Routes (mount points)
 * ------------------------------------------------------- */
import { sessionRouter } from "./routes/session-router.js";
import { streamRouter } from "./routes/stream-router.js";
import { usageRouter } from "./routes/usage-router.js";
app.use("/api/yuan", sessionRouter);
app.use("/api/yuan", streamRouter);
app.use("/api/yuan", usageRouter);

/* ---------------------------------------------------------
 * 404
 * ------------------------------------------------------- */
app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    message: "Endpoint Not Found",
  });
});

/* ---------------------------------------------------------
 * Global Error Handler
 * ------------------------------------------------------- */
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message =
    err instanceof Error ? err.message : "Internal Server Error";
  console.error("[YUAN] Global Error:", err);
  res.status(500).json({
    ok: false,
    error: message,
  });
});

/* ---------------------------------------------------------
 * Start
 * ------------------------------------------------------- */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[YUAN] Server live on http://0.0.0.0:${PORT}`);
});

export default app;
