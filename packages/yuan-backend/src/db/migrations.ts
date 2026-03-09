// src/db/migrations.ts
// YUAN Agent Backend — Database Migration Runner
//
// Reads schema.sql (the SSOT for all table definitions) and executes it
// against the provided PostgreSQL pool. A `yuan_migrations` table tracks
// which schema versions have been applied so that migrations are idempotent.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { Pool } from "pg";

/* ---------------------------------------------------------
 * Helpers
 * ------------------------------------------------------- */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve the path to schema.sql.
 *
 * In development (`src/`) and production (`dist/`) the SQL file lives next to
 * the JS/TS source. We check both locations for robustness.
 */
function resolveSchemaPath(): string {
  // When running from dist/, schema.sql should be copied alongside or we
  // fall back to the src/ path.
  const candidates = [
    join(__dirname, "schema.sql"),
    join(__dirname, "..", "..", "src", "db", "schema.sql"),
  ];

  for (const candidate of candidates) {
    try {
      readFileSync(candidate, "utf-8");
      return candidate;
    } catch {
      // Try next candidate
    }
  }

  throw new Error(
    `[YUAN][Migrations] schema.sql not found. Searched:\n  ${candidates.join("\n  ")}`,
  );
}

/* ---------------------------------------------------------
 * Migration tracking table
 * ------------------------------------------------------- */

const MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS yuan_migrations (
  id SERIAL PRIMARY KEY,
  version VARCHAR(64) NOT NULL UNIQUE,
  checksum VARCHAR(64) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

/* ---------------------------------------------------------
 * runMigrations
 * ------------------------------------------------------- */

/**
 * Execute the schema against the database pool.
 *
 * 1. Ensures the `yuan_migrations` tracking table exists.
 * 2. Reads `schema.sql` and computes a SHA-256 checksum.
 * 3. If this checksum has already been applied, skips execution.
 * 4. Otherwise, runs the SQL inside a transaction and records the migration.
 *
 * The function is safe to call on every server startup.
 */
export async function runMigrations(pool: Pool): Promise<void> {
  const TAG = "[YUAN][Migrations]";

  // 1. Ensure migrations tracking table
  await pool.query(MIGRATIONS_TABLE_SQL);

  // 2. Read schema.sql
  const schemaPath = resolveSchemaPath();
  const schemaSql = readFileSync(schemaPath, "utf-8");
  const checksum = createHash("sha256").update(schemaSql).digest("hex");
  const version = `schema_${checksum.slice(0, 16)}`;

  console.log(`${TAG} Schema checksum: ${checksum.slice(0, 16)}`);

  // 3. Check if already applied
  const existing = await pool.query<{ version: string }>(
    "SELECT version FROM yuan_migrations WHERE version = $1",
    [version],
  );

  if (existing.rows.length > 0) {
    console.log(`${TAG} Schema already up to date (${version})`);
    return;
  }

  // 4. Apply schema inside a transaction
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    console.log(`${TAG} Applying schema (${version})...`);
    await client.query(schemaSql);

    await client.query(
      "INSERT INTO yuan_migrations (version, checksum) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING",
      [version, checksum],
    );

    await client.query("COMMIT");
    console.log(`${TAG} Schema applied successfully`);
  } catch (err) {
    await client.query("ROLLBACK");
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} Migration failed: ${message}`);
    throw err;
  } finally {
    client.release();
  }
}
