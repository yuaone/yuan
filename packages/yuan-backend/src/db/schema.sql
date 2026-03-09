-- YUAN Agent Backend — Database Schema (SSOT)
-- All statements are idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING).

-- Users table (synced from Firebase)
CREATE TABLE IF NOT EXISTS yuan_users (
  id SERIAL PRIMARY KEY,
  firebase_uid VARCHAR(128) UNIQUE NOT NULL,
  email VARCHAR(255),
  display_name VARCHAR(255),
  plan VARCHAR(50) NOT NULL DEFAULT 'free',  -- free, pro, team, enterprise
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Agent sessions
CREATE TABLE IF NOT EXISTS yuan_sessions (
  id VARCHAR(64) PRIMARY KEY,  -- UUID
  user_id INTEGER NOT NULL REFERENCES yuan_users(id),
  workspace_id VARCHAR(128),
  goal TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, running, paused, completed, failed, aborted
  work_dir VARCHAR(1024),
  model VARCHAR(64),
  result JSONB,
  error TEXT,
  iteration_count INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Agent iterations (each LLM call + tool execution)
CREATE TABLE IF NOT EXISTS yuan_iterations (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(64) NOT NULL REFERENCES yuan_sessions(id) ON DELETE CASCADE,
  iteration_number INTEGER NOT NULL,
  phase VARCHAR(30),  -- analyze, design, plan, implement, verify, fix, replan
  step_index INTEGER,
  tool_name VARCHAR(64),
  tool_input JSONB,
  tool_output TEXT,
  tokens_input INTEGER NOT NULL DEFAULT 0,
  tokens_output INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Usage tracking (daily aggregates)
CREATE TABLE IF NOT EXISTS yuan_usage (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES yuan_users(id),
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  session_count INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_iterations INTEGER NOT NULL DEFAULT 0,
  model_usage JSONB NOT NULL DEFAULT '{}',  -- { "claude-sonnet-4-20250514": { input: N, output: N } }
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, date)
);

-- Plan limits
CREATE TABLE IF NOT EXISTS yuan_plan_limits (
  plan VARCHAR(50) PRIMARY KEY,
  daily_sessions INTEGER NOT NULL DEFAULT 5,
  max_iterations INTEGER NOT NULL DEFAULT 100,
  max_tokens_per_session INTEGER NOT NULL DEFAULT 500000,
  max_concurrent INTEGER NOT NULL DEFAULT 1,
  features JSONB NOT NULL DEFAULT '{}'
);

-- Insert default plan limits
INSERT INTO yuan_plan_limits (plan, daily_sessions, max_iterations, max_tokens_per_session, max_concurrent) VALUES
  ('free', 5, 50, 200000, 1),
  ('pro', 50, 200, 1000000, 3),
  ('team', 200, 500, 2000000, 5),
  ('enterprise', -1, -1, -1, 10)
ON CONFLICT (plan) DO NOTHING;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_yuan_sessions_user_id ON yuan_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_yuan_sessions_status ON yuan_sessions(status);
CREATE INDEX IF NOT EXISTS idx_yuan_iterations_session_id ON yuan_iterations(session_id);
CREATE INDEX IF NOT EXISTS idx_yuan_usage_user_date ON yuan_usage(user_id, date);
