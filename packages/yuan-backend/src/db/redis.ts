// src/db/redis.ts
// YUAN Agent Backend — Redis Connections (Pub + Sub)

import { Redis } from "ioredis";

/* ---------------------------------------------------------
 * Config
 * ------------------------------------------------------- */

const REDIS_HOST = process.env.REDIS_HOST?.trim() || "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT?.trim() || "6379");
const REDIS_PASSWORD = process.env.REDIS_PASSWORD?.trim() || undefined;

/* ---------------------------------------------------------
 * Publisher
 * ------------------------------------------------------- */

export const redisPub = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
  lazyConnect: true,
  maxRetriesPerRequest: 3,
});

redisPub.on("connect", () => {
  console.log("[YUAN][Redis] Publisher connected");
});

redisPub.on("error", (err: unknown) => {
  console.error("[YUAN][Redis][PUB] error:", err);
});

/* ---------------------------------------------------------
 * Subscriber
 * ------------------------------------------------------- */

export const redisSub = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
  lazyConnect: true,
  maxRetriesPerRequest: 3,
});

let subscriberConnected = false;

redisSub.on("connect", () => {
  subscriberConnected = true;
  console.log("[YUAN][Redis] Subscriber connected");
});

redisSub.on("error", (err: unknown) => {
  console.error("[YUAN][Redis][SUB] error:", err);
});

/* ---------------------------------------------------------
 * Helpers
 * ------------------------------------------------------- */

/**
 * Ensure the subscriber connection is established.
 * Safe to call concurrently — deduplicates in-flight connect attempts.
 */
let connectingPromise: Promise<void> | null = null;

export async function ensureRedisSubscriber(): Promise<void> {
  if (subscriberConnected) return;
  if (connectingPromise) return connectingPromise;
  connectingPromise = (async () => {
    await redisSub.connect();
    subscriberConnected = true;
    connectingPromise = null;
  })();
  return connectingPromise;
}

/**
 * Redis channel for a YUAN agent session.
 */
export function yuanChannel(sessionId: string): string {
  return `yuan:session:${sessionId}`;
}

/**
 * Redis channel for agent streaming events.
 */
export function yuanStreamChannel(sessionId: string): string {
  return `yuan:stream:${sessionId}`;
}

/* ---------------------------------------------------------
 * Init / Shutdown
 * ------------------------------------------------------- */

/**
 * Connect both pub and sub clients. Safe to call on startup.
 */
export async function initRedis(): Promise<void> {
  console.log("[YUAN][Redis] Connecting...");

  try {
    await redisPub.connect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[YUAN][Redis] Publisher connect failed: ${message}`);
  }

  try {
    await redisSub.connect();
    subscriberConnected = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[YUAN][Redis] Subscriber connect failed: ${message}`);
  }
}

/**
 * Graceful shutdown. Disconnect both clients.
 */
export async function closeRedis(): Promise<void> {
  await redisPub.quit();
  await redisSub.quit();
  subscriberConnected = false;
  console.log("[YUAN][Redis] Connections closed");
}
