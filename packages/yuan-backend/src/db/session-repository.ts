// src/db/session-repository.ts
// YUAN Agent Backend — Database Access Layer for Sessions, Users, Usage
//
// All queries use parameterized statements ($1, $2, ...) — no string interpolation.
// Graceful degradation: callers should catch errors and fall back to in-memory / defaults.

import { pgPool } from "./postgres.js";

/* ---------------------------------------------------------
 * Types
 * ------------------------------------------------------- */

export interface PlanLimits {
  dailySessions: number;
  maxIterations: number;
  maxTokensPerSession: number;
  maxConcurrent: number;
  features: Record<string, unknown>;
}

export interface CreateSessionInput {
  id: string;
  userId: number;
  workspaceId?: string;
  goal: string;
  workDir?: string;
  model?: string;
}

export interface SessionRecord {
  id: string;
  userId: number;
  goal: string;
  status: string;
  workDir: string | null;
  model: string | null;
  iterationCount: number;
  tokensUsed: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  result: string | null;
  error: string | null;
}

/* ---------------------------------------------------------
 * Default plan limits (fallback when DB has no row)
 * ------------------------------------------------------- */

const DEFAULT_PLAN_LIMITS: Record<string, PlanLimits> = {
  free: {
    dailySessions: 20,
    maxIterations: 50,
    maxTokensPerSession: 200_000,
    maxConcurrent: 2,
    features: {},
  },
  pro: {
    dailySessions: 100,
    maxIterations: 200,
    maxTokensPerSession: 1_000_000,
    maxConcurrent: 5,
    features: { priority: true },
  },
  team: {
    dailySessions: 500,
    maxIterations: 500,
    maxTokensPerSession: 2_000_000,
    maxConcurrent: 10,
    features: { priority: true, teamSharing: true },
  },
};

/* ---------------------------------------------------------
 * User Operations
 * ------------------------------------------------------- */

/**
 * Find or create a user by Firebase UID. Returns database user ID and plan.
 * Uses INSERT ... ON CONFLICT to upsert atomically.
 */
export async function findOrCreateUser(
  firebaseUid: string,
  email?: string | null,
  displayName?: string | null,
): Promise<{ id: number; plan: string }> {
  const result = await pgPool.query<{ id: number; plan: string }>(
    `INSERT INTO yuan_users (firebase_uid, email, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (firebase_uid) DO UPDATE
       SET email = COALESCE(EXCLUDED.email, yuan_users.email),
           display_name = COALESCE(EXCLUDED.display_name, yuan_users.display_name),
           updated_at = NOW()
     RETURNING id, plan`,
    [firebaseUid, email ?? null, displayName ?? null],
  );
  return result.rows[0]!;
}

/**
 * Get user's current plan. Returns 'free' if user not found.
 */
export async function getUserPlan(userId: number): Promise<string> {
  const result = await pgPool.query<{ plan: string }>(
    `SELECT plan FROM yuan_users WHERE id = $1`,
    [userId],
  );
  return result.rows[0]?.plan ?? "free";
}

/**
 * Get plan limits from DB, falling back to hardcoded defaults.
 */
export async function getPlanLimits(plan: string): Promise<PlanLimits> {
  try {
    const result = await pgPool.query<{
      daily_sessions: number;
      max_iterations: number;
      max_tokens_per_session: number;
      max_concurrent: number;
      features: Record<string, unknown>;
    }>(
      `SELECT daily_sessions, max_iterations, max_tokens_per_session,
              max_concurrent, features
       FROM yuan_plan_limits WHERE plan = $1`,
      [plan],
    );

    const row = result.rows[0];
    if (!row) {
      return DEFAULT_PLAN_LIMITS[plan] ?? DEFAULT_PLAN_LIMITS.free!;
    }

    return {
      dailySessions: row.daily_sessions,
      maxIterations: row.max_iterations,
      maxTokensPerSession: row.max_tokens_per_session,
      maxConcurrent: row.max_concurrent,
      features: row.features ?? {},
    };
  } catch {
    // DB unavailable — return hardcoded defaults
    return DEFAULT_PLAN_LIMITS[plan] ?? DEFAULT_PLAN_LIMITS.free!;
  }
}

/* ---------------------------------------------------------
 * Session CRUD
 * ------------------------------------------------------- */

/**
 * Persist a new session to the database.
 */
export async function createSession(data: CreateSessionInput): Promise<SessionRecord> {
  const result = await pgPool.query<{
    id: string;
    user_id: number;
    goal: string;
    status: string;
    work_dir: string | null;
    model: string | null;
    iteration_count: number;
    tokens_used: number;
    created_at: Date;
    updated_at: Date;
    completed_at: Date | null;
    result: string | null;
    error: string | null;
  }>(
    `INSERT INTO yuan_sessions (id, user_id, workspace_id, goal, work_dir, model, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'running')
     RETURNING id, user_id, goal, status, work_dir, model,
               iteration_count, tokens_used, created_at, updated_at,
               completed_at, result, error`,
    [data.id, data.userId, data.workspaceId ?? null, data.goal, data.workDir ?? null, data.model ?? null],
  );

  return mapSessionRow(result.rows[0]!);
}

/**
 * Get a single session by ID.
 */
export async function getSession(sessionId: string): Promise<SessionRecord | null> {
  const result = await pgPool.query<{
    id: string;
    user_id: number;
    goal: string;
    status: string;
    work_dir: string | null;
    model: string | null;
    iteration_count: number;
    tokens_used: number;
    created_at: Date;
    updated_at: Date;
    completed_at: Date | null;
    result: string | null;
    error: string | null;
  }>(
    `SELECT id, user_id, goal, status, work_dir, model,
            iteration_count, tokens_used, created_at, updated_at,
            completed_at, result, error
     FROM yuan_sessions WHERE id = $1`,
    [sessionId],
  );

  const row = result.rows[0];
  return row ? mapSessionRow(row) : null;
}

/**
 * Update session status and optional extra fields.
 */
export async function updateSessionStatus(
  sessionId: string,
  status: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  const setClauses = ["status = $2", "updated_at = NOW()"];
  const params: unknown[] = [sessionId, status];
  let paramIndex = 3;

  if (extra) {
    if (extra.result !== undefined) {
      setClauses.push(`result = $${paramIndex}`);
      params.push(extra.result);
      paramIndex++;
    }
    if (extra.error !== undefined) {
      setClauses.push(`error = $${paramIndex}`);
      params.push(extra.error);
      paramIndex++;
    }
    if (extra.iterationCount !== undefined) {
      setClauses.push(`iteration_count = $${paramIndex}`);
      params.push(extra.iterationCount);
      paramIndex++;
    }
    if (extra.tokensUsed !== undefined) {
      setClauses.push(`tokens_used = $${paramIndex}`);
      params.push(extra.tokensUsed);
      paramIndex++;
    }
    if (status === "completed" || status === "failed" || status === "stopped") {
      setClauses.push("completed_at = NOW()");
    }
  }

  await pgPool.query(
    `UPDATE yuan_sessions SET ${setClauses.join(", ")} WHERE id = $1`,
    params,
  );
}

/**
 * List a user's sessions, newest first.
 */
export async function getUserSessions(
  userId: number,
  limit = 20,
  offset = 0,
  status?: string,
): Promise<{ sessions: SessionRecord[]; total: number }> {
  const conditions = ["user_id = $1"];
  const params: unknown[] = [userId];
  let paramIndex = 2;

  if (status) {
    conditions.push(`status = $${paramIndex}`);
    params.push(status);
    paramIndex++;
  }

  const whereClause = conditions.join(" AND ");

  const countResult = await pgPool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM yuan_sessions WHERE ${whereClause}`,
    params,
  );
  const total = parseInt(countResult.rows[0]!.count, 10);

  const dataParams = [...params, limit, offset];
  const dataResult = await pgPool.query<{
    id: string;
    user_id: number;
    goal: string;
    status: string;
    work_dir: string | null;
    model: string | null;
    iteration_count: number;
    tokens_used: number;
    created_at: Date;
    updated_at: Date;
    completed_at: Date | null;
    result: string | null;
    error: string | null;
  }>(
    `SELECT id, user_id, goal, status, work_dir, model,
            iteration_count, tokens_used, created_at, updated_at,
            completed_at, result, error
     FROM yuan_sessions WHERE ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    dataParams,
  );

  return {
    sessions: dataResult.rows.map(mapSessionRow),
    total,
  };
}

/* ---------------------------------------------------------
 * Usage Operations
 * ------------------------------------------------------- */

/**
 * Get today's usage for a user.
 */
export async function getDailyUsage(
  userId: number,
): Promise<{ sessionCount: number; totalTokens: number; totalIterations: number }> {
  const result = await pgPool.query<{
    session_count: number;
    total_tokens: number;
    total_iterations: number;
  }>(
    `SELECT session_count, total_tokens, total_iterations
     FROM yuan_usage WHERE user_id = $1 AND date = CURRENT_DATE`,
    [userId],
  );

  const row = result.rows[0];
  return {
    sessionCount: row?.session_count ?? 0,
    totalTokens: row?.total_tokens ?? 0,
    totalIterations: row?.total_iterations ?? 0,
  };
}

/**
 * Increment daily usage counters atomically.
 * Uses INSERT ... ON CONFLICT for upsert.
 */
export async function incrementUsage(
  userId: number,
  tokens: number,
  iterations = 0,
  modelUsageUpdate?: Record<string, unknown>,
): Promise<void> {
  await pgPool.query(
    `INSERT INTO yuan_usage (user_id, date, session_count, total_tokens, total_iterations, model_usage)
     VALUES ($1, CURRENT_DATE, 1, $2, $3, COALESCE($4::jsonb, '{}'::jsonb))
     ON CONFLICT (user_id, date) DO UPDATE SET
       session_count = yuan_usage.session_count + 1,
       total_tokens = yuan_usage.total_tokens + $2,
       total_iterations = yuan_usage.total_iterations + $3,
       model_usage = CASE
         WHEN $4::jsonb IS NOT NULL
         THEN yuan_usage.model_usage || $4::jsonb
         ELSE yuan_usage.model_usage
       END`,
    [userId, tokens, iterations, modelUsageUpdate ? JSON.stringify(modelUsageUpdate) : null],
  );
}

/* ---------------------------------------------------------
 * Row mapper
 * ------------------------------------------------------- */

function mapSessionRow(row: {
  id: string;
  user_id: number;
  goal: string;
  status: string;
  work_dir: string | null;
  model: string | null;
  iteration_count: number;
  tokens_used: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  result: string | null;
  error: string | null;
}): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    goal: row.goal,
    status: row.status,
    workDir: row.work_dir,
    model: row.model,
    iterationCount: row.iteration_count,
    tokensUsed: row.tokens_used,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    result: row.result,
    error: row.error,
  };
}
