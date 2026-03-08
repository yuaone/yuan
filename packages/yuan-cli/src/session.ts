/**
 * YUAN CLI — Session Manager
 *
 * Handles saving/loading agent sessions for `yuan resume`.
 * Sessions are stored in ~/.yuan/sessions/
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

const YUAN_DIR = path.join(os.homedir(), ".yuan");
const SESSIONS_DIR = path.join(YUAN_DIR, "sessions");
const LAST_SESSION_FILE = path.join(YUAN_DIR, "last-session");

/** A single message in the conversation */
export interface SessionMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

/** Stored session data */
export interface SessionData {
  id: string;
  createdAt: number;
  updatedAt: number;
  workDir: string;
  messages: SessionMessage[];
  provider: string;
  model: string;
}

/**
 * SessionManager — save/load/resume agent sessions
 */
export class SessionManager {
  constructor() {
    this.ensureDirs();
  }

  private ensureDirs(): void {
    if (!fs.existsSync(SESSIONS_DIR)) {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }
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
    };

    this.save(session);
    this.setLastSessionId(session.id);
    return session;
  }

  /** Save a session to disk */
  save(session: SessionData): void {
    session.updatedAt = Date.now();
    const filePath = path.join(SESSIONS_DIR, `${session.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), "utf-8");
    this.setLastSessionId(session.id);
  }

  /** Load a session by ID */
  load(sessionId: string): SessionData | null {
    const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf-8");
        return JSON.parse(raw) as SessionData;
      }
    } catch {
      // Corrupted session file
    }
    return null;
  }

  /** Get the last session ID */
  getLastSessionId(): string | null {
    try {
      if (fs.existsSync(LAST_SESSION_FILE)) {
        return fs.readFileSync(LAST_SESSION_FILE, "utf-8").trim();
      }
    } catch {
      // Ignore
    }
    return null;
  }

  /** Load the last session */
  loadLast(): SessionData | null {
    const lastId = this.getLastSessionId();
    if (!lastId) return null;
    return this.load(lastId);
  }

  /** Set the last session ID */
  private setLastSessionId(sessionId: string): void {
    fs.writeFileSync(LAST_SESSION_FILE, sessionId, "utf-8");
  }

  /** Add a message to a session */
  addMessage(
    session: SessionData,
    role: "user" | "assistant" | "system",
    content: string
  ): void {
    session.messages.push({
      role,
      content,
      timestamp: Date.now(),
    });
    this.save(session);
  }

  /** List recent sessions */
  listRecent(limit = 10): SessionData[] {
    const sessions: SessionData[] = [];

    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(SESSIONS_DIR, file), "utf-8");
          sessions.push(JSON.parse(raw) as SessionData);
        } catch {
          // Skip corrupted files
        }
      }
    } catch {
      // Sessions dir doesn't exist yet
    }

    // Sort by most recent first
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return sessions.slice(0, limit);
  }
}
