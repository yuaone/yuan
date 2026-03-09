// src/db/postgres.ts
// YUAN Agent Backend — PostgreSQL Connection Pool

import { Pool, type PoolConfig } from "pg";
import { runMigrations } from "./migrations.js";

/* ---------------------------------------------------------
 * Config
 * ------------------------------------------------------- */

function env(key: string, fallback: string): string {
  return (process.env[key] ?? "").trim() || fallback;
}

const poolConfig: PoolConfig = {
  host: env("POSTGRES_HOST", "127.0.0.1"),
  port: Number(env("POSTGRES_PORT", "5432")),
  user: env("POSTGRES_USER", "postgres"),
  password: process.env.POSTGRES_PASSWORD?.trim() || undefined,
  database: env("POSTGRES_DB", "yuan"),

  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,

  ssl:
    env("POSTGRES_SSL", "false") === "true"
      ? { rejectUnauthorized: false }
      : false,
};

/* ---------------------------------------------------------
 * Pool
 * ------------------------------------------------------- */

export const pgPool = new Pool(poolConfig);

pgPool.on("error", (err) => {
  console.error("[YUAN][PostgreSQL] Pool error:", err.message);
});

/* ---------------------------------------------------------
 * Init / Test
 * ------------------------------------------------------- */

/**
 * Test connection and log status. Safe to call on startup.
 */
export async function initPostgres(): Promise<void> {
  console.log("[YUAN][PostgreSQL] Connecting...");

  try {
    const result = await pgPool.query<{ now: string }>("SELECT NOW() AS now");
    console.log(`[YUAN][PostgreSQL] Connected (time: ${result.rows[0]?.now})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[YUAN][PostgreSQL] Connection failed: ${message}`);
    // Don't throw — server can start and retry queries later
  }
}

/**
 * Test connection. Returns { ok, now? } or { ok: false, error }.
 */
export async function testPostgresConnection(): Promise<
  { ok: true; now: string } | { ok: false; error: string }
> {
  try {
    const r = await pgPool.query<{ now: string }>("SELECT NOW() AS now");
    return { ok: true, now: r.rows[0]!.now };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Initialize database: test connection and run migrations.
 * Safe to call on every server startup.
 */
export async function initDatabase(): Promise<void> {
  await initPostgres();

  try {
    await runMigrations(pgPool);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[YUAN][PostgreSQL] Migration failed: ${message}`);
    // Don't throw — server can start without migrations if DB is unavailable
  }
}

/**
 * Graceful shutdown.
 */
export async function closePostgres(): Promise<void> {
  await pgPool.end();
  console.log("[YUAN][PostgreSQL] Pool closed");
}
