// src/auth/firebase-auth.ts
// YUAN Agent Backend — Firebase Auth Middleware

import { initializeApp, cert, getApps, type ServiceAccount } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import type { Request, Response, NextFunction } from "express";

import { findOrCreateUser } from "../db/session-repository.js";

/* ---------------------------------------------------------
 * Firebase Admin Initialization
 * ------------------------------------------------------- */

function initFirebaseAdmin(): void {
  if (getApps().length > 0) return; // already initialized

  // Option 1: Base64-encoded service account key
  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (base64) {
    try {
      const json = Buffer.from(base64, "base64").toString("utf8");
      const serviceAccount = JSON.parse(json) as ServiceAccount;
      initializeApp({ credential: cert(serviceAccount) });
      console.log("[YUAN] Firebase Admin initialized (base64)");
      return;
    } catch (err) {
      console.error("[YUAN] Firebase Admin init failed (base64):", err);
    }
  }

  // Option 2: JSON string env var
  const jsonKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (jsonKey) {
    try {
      const serviceAccount = JSON.parse(jsonKey) as ServiceAccount;
      initializeApp({ credential: cert(serviceAccount) });
      console.log("[YUAN] Firebase Admin initialized (json key)");
      return;
    } catch (err) {
      console.error("[YUAN] Firebase Admin init failed (json key):", err);
    }
  }

  // Option 3: GOOGLE_APPLICATION_CREDENTIALS file path (auto-detected by SDK)
  initializeApp();
  console.log("[YUAN] Firebase Admin initialized (default credentials)");
}

// Initialize on module load
initFirebaseAdmin();

/* ---------------------------------------------------------
 * Deterministic userId derivation from Firebase UID
 * ------------------------------------------------------- */

/**
 * Generate a deterministic userId from firebaseUid until DB user table exists.
 * This ensures different Firebase users get different userIds.
 * Uses a simple hash (djb2 variant) — sufficient for in-memory session keying.
 * Replace with actual DB lookup when the users table is ready.
 */
function deriveUserId(firebaseUid: string): number {
  let hash = 0;
  for (let i = 0; i < firebaseUid.length; i++) {
    hash = ((hash << 5) - hash + firebaseUid.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/* ---------------------------------------------------------
 * YuanUser Type
 * ------------------------------------------------------- */

export interface YuanUser {
  /** Database user ID (from yuan_users table, or derived hash as fallback) */
  userId: number;
  /** Firebase UID */
  firebaseUid: string;
  /** User email (from Firebase token) */
  email: string | null;
  /** Display name (from Firebase token) */
  name: string | null;
  /** User role */
  role: "user" | "admin";
  /** Billing plan (from DB, defaults to 'free') */
  plan: string;
}

/* ---------------------------------------------------------
 * Express.Request Type Extension
 * ------------------------------------------------------- */

declare global {
  namespace Express {
    interface Request {
      user?: YuanUser;
    }
  }
}

/* ---------------------------------------------------------
 * requireAuth Middleware
 * ------------------------------------------------------- */

/**
 * Verifies Firebase ID token from Authorization header.
 * Sets `req.user` with decoded claims.
 *
 * Usage: `router.use(requireAuth)`
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  if (!token) {
    res.status(401).json({ ok: false, error: "auth_required" });
    return;
  }

  let decoded: DecodedIdToken;
  try {
    // checkRevoked = true for security
    decoded = await getAuth().verifyIdToken(token, true);
  } catch {
    res.status(401).json({ ok: false, error: "invalid_token" });
    return;
  }

  // Look up (or create) the user in the DB; fall back to hash-derived ID
  let userId: number;
  let plan = "free";

  try {
    const dbUser = await findOrCreateUser(
      decoded.uid,
      decoded.email,
      decoded.name,
    );
    userId = dbUser.id;
    plan = dbUser.plan;
  } catch {
    // DB unavailable — degrade gracefully to hash-derived ID
    userId = deriveUserId(decoded.uid);
  }

  const user: YuanUser = {
    userId,
    firebaseUid: decoded.uid,
    email: decoded.email ?? null,
    name: decoded.name ?? null,
    role: decoded.admin === true ? "admin" : "user",
    plan,
  };

  req.user = user;
  next();
}

/**
 * Optional auth — sets req.user if token present, but does not reject.
 */
export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  if (!token) {
    next();
    return;
  }

  try {
    const decoded = await getAuth().verifyIdToken(token, true);

    let userId: number;
    let plan = "free";
    try {
      const dbUser = await findOrCreateUser(decoded.uid, decoded.email, decoded.name);
      userId = dbUser.id;
      plan = dbUser.plan;
    } catch {
      userId = deriveUserId(decoded.uid);
    }

    req.user = {
      userId,
      firebaseUid: decoded.uid,
      email: decoded.email ?? null,
      name: decoded.name ?? null,
      role: decoded.admin === true ? "admin" : "user",
      plan,
    };
  } catch {
    // Token invalid — proceed without user
  }

  next();
}

/**
 * Admin-only gate. Must be used after requireAuth.
 */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user || req.user.role !== "admin") {
    res.status(403).json({ ok: false, error: "admin_required" });
    return;
  }
  next();
}
