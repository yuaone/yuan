/**
 * YUAN CLI — Session Manager
 *
 * Handles saving/loading agent sessions for `yuan resume`.
 * Connects to @yuaone/core SessionPersistence for disk-level persistence
 * with checkpointing and crash recovery support.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import {
  SessionPersistence,
  type SessionSnapshot,
  type PersistentSessionData,
  type CheckpointData,
  type SessionStatus,
} from "@yuaone/core";

const YUAN_DIR = path.join(os.homedir(), ".yuan");
const SESSIONS_DIR = path.join(YUAN_DIR, "sessions");
const LAST_SESSION_FILE = path.join(YUAN_DIR, "last-session");

/** A single message in the conversation (CLI-level) */
export interface SessionMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

/** Stored session data (CLI-level, maps to core's PersistentSessionData) */
export interface SessionData {
  id: string;
  createdAt: number;
  updatedAt: number;
  workDir: string;
  messages: SessionMessage[];
  provider: string;
  model: string;
  status: SessionStatus;
  iteration: number;
  tokenUsage: { input: number; output: number };
}

/**
 * SessionManager — save/load/resume agent sessions.
 *
 * Wraps @yuaone/core SessionPersistence with CLI-friendly interface.
 * Sessions are stored in ~/.yuan/sessions/<sessionId>/ with:
 * - state.json: metadata
 * - messages.json: conversation history
 * - checkpoint.json: iteration/token state
 */
export class SessionManager {
  private readonly persistence: SessionPersistence;

  constructor(baseDir?: string) {
    this.persistence = new SessionPersistence(baseDir);
  }

  /** Create a new session */
  create(workDir: string, provider: string, model: string): SessionData {
    const session: SessionData = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workDir,
      messages: [],
      provider,
      model,
      status: "running",
      iteration: 0,
      tokenUsage: { input: 0, output: 0 },
    };

    // Ensure session directory exists SYNCHRONOUSLY before any async writes.
    // This prevents ENOENT race conditions when fire-and-forget persistence.save()
    // hasn't created the directory yet and a subsequent save() call runs concurrently.
    const sessionDir = path.join(SESSIONS_DIR, session.id);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Save to disk immediately
    this.save(session);
    return session;
  }

  /** Save a session to disk (via core SessionPersistence) */
  save(session: SessionData): void {
    session.updatedAt = Date.now();

    const persistentData: PersistentSessionData = {
      snapshot: this.toSnapshot(session),
      messages: session.messages.map((m) => ({
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
      })),
      plan: null,
      changedFiles: [],
    };

    // Ensure session directory exists SYNCHRONOUSLY before any async writes.
    // This prevents ENOENT when multiple fire-and-forget saves race.
    const sessionDir = path.join(SESSIONS_DIR, session.id);
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
    } catch {
      // Best-effort — persistence.save() will also try ensureDir
    }

    // Write last-session pointer
    try {
      fs.writeFileSync(LAST_SESSION_FILE, session.id, "utf-8");
    } catch {
      // Best-effort
    }

    // Fire-and-forget async save with error logging
    this.persistence.save(session.id, persistentData).catch((err) => {
      process.stderr.write(`Session save failed: ${err}\n`);
    });
  }

  /** Load a session by ID */
  load(sessionId: string): SessionData | null {
    return this.loadSync(sessionId);
  }

  /** Load the last session */
  loadLast(): SessionData | null {
    const lastId = this.getLastSessionId();
    if (!lastId) return null;
    return this.loadSync(lastId);
  }

  /** Get the last session ID */
  getLastSessionId(): string | null {
    try {
      if (fs.existsSync(LAST_SESSION_FILE)) {
        return fs.readFileSync(LAST_SESSION_FILE, "utf-8").trim() || null;
      }
    } catch {
      // Ignore
    }
    return null;
  }

  /** Add a message to a session */
  addMessage(
    session: SessionData,
    role: "user" | "assistant" | "system",
    content: string,
  ): void {
    session.messages.push({
      role,
      content,
      timestamp: Date.now(),
    });
    this.save(session);
  }

  /** Save a checkpoint (called after each iteration) */
  async saveCheckpoint(
    session: SessionData,
    changedFiles: string[] = [],
    lastToolCall?: string,
  ): Promise<void> {
    const checkpoint: CheckpointData = {
      iteration: session.iteration,
      tokenUsage: session.tokenUsage,
      timestamp: new Date().toISOString(),
      changedFiles,
      lastToolCall,
    };
    await this.persistence.checkpoint(session.id, checkpoint);
  }

  /** Update session status */
  async updateStatus(
    session: SessionData,
    status: SessionStatus,
  ): Promise<void> {
    session.status = status;
    await this.persistence.updateStatus(session.id, status);
  }

  /** List recent sessions (async) */
  async listSessions(limit = 20): Promise<SessionSnapshot[]> {
    return this.persistence.listSessions(limit);
  }

  /** List recent sessions (sync for CLI display) */
  listRecent(limit = 10): SessionData[] {
    const sessions: SessionData[] = [];

    try {
      const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const stateFile = path.join(SESSIONS_DIR, entry.name, "state.json");
          const messagesFile = path.join(SESSIONS_DIR, entry.name, "messages.json");

          if (!fs.existsSync(stateFile)) continue;

          const snapshot = JSON.parse(
            fs.readFileSync(stateFile, "utf-8"),
          ) as SessionSnapshot;

          let messages: SessionMessage[] = [];
          if (fs.existsSync(messagesFile)) {
            const rawMessages = JSON.parse(
              fs.readFileSync(messagesFile, "utf-8"),
            ) as Array<{ role: string; content: string }>;
            messages = rawMessages.map((m, i) => ({
              role: m.role as "user" | "assistant" | "system",
              content: m.content,
              timestamp: new Date(snapshot.createdAt).getTime() + i * 1000,
            }));
          }

          sessions.push({
            id: snapshot.id,
            createdAt: new Date(snapshot.createdAt).getTime(),
            updatedAt: new Date(snapshot.updatedAt).getTime(),
            workDir: snapshot.workDir,
            messages,
            provider: snapshot.provider,
            model: snapshot.model,
            status: snapshot.status,
            iteration: snapshot.iteration,
            tokenUsage: snapshot.tokenUsage,
          });
        } catch {
          // Skip corrupted sessions
        }
      }
    } catch {
      // Sessions dir doesn't exist yet
    }

    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return sessions.slice(0, limit);
  }

  /** Detect crashed sessions */
  async detectCrashed(): Promise<SessionSnapshot[]> {
    return this.persistence.detectCrashedSessions();
  }

  /** Clean up old sessions */
  async cleanup(maxAgeDays = 30): Promise<number> {
    return this.persistence.cleanup(maxAgeDays);
  }

  // ─── Private ───

  private toSnapshot(session: SessionData): SessionSnapshot {
    return {
      id: session.id,
      createdAt: new Date(session.createdAt).toISOString(),
      updatedAt: new Date(session.updatedAt).toISOString(),
      workDir: session.workDir,
      provider: session.provider,
      model: session.model,
      status: session.status,
      iteration: session.iteration,
      tokenUsage: session.tokenUsage,
      messageCount: session.messages.length,
    };
  }

  /** Sync load from disk (for CLI compatibility) */
  private loadSync(sessionId: string): SessionData | null {
    const sessionDir = path.join(SESSIONS_DIR, sessionId);

    if (!fs.existsSync(sessionDir)) return null;

    try {
      const stateFile = path.join(sessionDir, "state.json");
      const messagesFile = path.join(sessionDir, "messages.json");

      if (!fs.existsSync(stateFile)) return null;

      const snapshot = JSON.parse(
        fs.readFileSync(stateFile, "utf-8"),
      ) as SessionSnapshot;

      let messages: SessionMessage[] = [];
      if (fs.existsSync(messagesFile)) {
        const rawMessages = JSON.parse(
          fs.readFileSync(messagesFile, "utf-8"),
        ) as Array<{ role: string; content: string }>;
        messages = rawMessages.map((m, i) => ({
          role: m.role as "user" | "assistant" | "system",
          content: m.content,
          timestamp: new Date(snapshot.createdAt).getTime() + i * 1000,
        }));
      }

      return {
        id: snapshot.id,
        createdAt: new Date(snapshot.createdAt).getTime(),
        updatedAt: new Date(snapshot.updatedAt).getTime(),
        workDir: snapshot.workDir,
        messages,
        provider: snapshot.provider,
        model: snapshot.model,
        status: snapshot.status,
        iteration: snapshot.iteration,
        tokenUsage: snapshot.tokenUsage,
      };
    } catch {
      return null;
    }
  }
}
