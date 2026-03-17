/**
 * debug-logger — append-only log to ~/.yuan/debug.log
 * Writes to FILE ONLY — never stdout/stderr (corrupts Ink TUI).
 * Format: [HH:MM:SS.mmm] [LAYER] message
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG_FILE = path.join(os.homedir(), ".yuan", "debug.log");

// Ensure directory exists
try {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
} catch { /* ignore */ }

let fd: number | null = null;
function getFd(): number {
  if (fd === null) {
    try {
      fd = fs.openSync(LOG_FILE, "a");
    } catch { return -1; }
  }
  return fd;
}

export function dlog(layer: string, msg: string, data?: unknown): void {
  const now = new Date();
  const ts = `${now.getHours().toString().padStart(2,"0")}:${now.getMinutes().toString().padStart(2,"0")}:${now.getSeconds().toString().padStart(2,"0")}.${now.getMilliseconds().toString().padStart(3,"0")}`;
  const extra = data !== undefined ? " " + JSON.stringify(data) : "";
  const line = `[${ts}] [${layer}] ${msg}${extra}\n`;
  try {
    // File only — no stderr. stderr output bleeds into sibling terminals (tmux panes,
    // tail -f windows) and causes TUI jump/jitter.
    const f = getFd();
    if (f >= 0) fs.writeSync(f, line);
  } catch { /* never crash main process */ }
}

export function dlogSep(label = ""): void {
  dlog("────", `──────────── ${label} ────────────`);
}
