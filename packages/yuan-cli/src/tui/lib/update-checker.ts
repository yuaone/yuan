/**
 * update-checker — Check npm registry for newer @yuaone/cli versions.
 * Non-blocking, cached for 24h, respects user auto-update preference.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";
import * as os from "node:os";

const YUAN_DIR = path.join(os.homedir(), ".yuan");
const UPDATE_CACHE = path.join(YUAN_DIR, "update-check.json");
const SETTINGS_PATH = path.join(YUAN_DIR, "settings.json");
const PACKAGE_NAME = "@yuaone/cli";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
}

export interface YuanSettings {
  autoUpdate: "prompt" | "auto" | "never";
}

const DEFAULT_SETTINGS: YuanSettings = {
  autoUpdate: "prompt",
};

/** Load user settings */
export function loadSettings(): YuanSettings {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    }
  } catch {
    // Corrupted settings — use defaults
  }
  return { ...DEFAULT_SETTINGS };
}

/** Save user settings */
export function saveSettings(settings: YuanSettings): void {
  if (!fs.existsSync(YUAN_DIR)) {
    fs.mkdirSync(YUAN_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/** Fetch latest version from npm registry (non-blocking) */
function fetchLatestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const url = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`;
    const req = https.get(url, { timeout: 5000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.version ?? null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** Compare semver versions. Returns true if b > a */
function isNewer(a: string, b: string): boolean {
 const pa = a.split(".").map(n => parseInt(n,10));
 const pb = b.split(".").map(n => parseInt(n,10));

 for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
   const ai = pa[i] ?? 0;
   const bi = pb[i] ?? 0;
   if (bi > ai) return true;
   if (bi < ai) return false;
 }

 return false;
}

/** Check for updates (cached, non-blocking) */
export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo | null> {
  const settings = loadSettings();
  if (settings.autoUpdate === "never") return null;

  // Check cache
  try {
    if (fs.existsSync(UPDATE_CACHE)) {
      const cache = JSON.parse(fs.readFileSync(UPDATE_CACHE, "utf-8"));
      const age = Date.now() - (cache.checkedAt ?? 0);
      if (age < CHECK_INTERVAL_MS && cache.latestVersion) {
        const hasUpdate = isNewer(currentVersion, cache.latestVersion);
        if (!hasUpdate) return null;
        return { currentVersion, latestVersion: cache.latestVersion, hasUpdate };
      }
    }
  } catch {
    // Cache corrupted, re-check
  }

  // Fetch from npm
  const latest = await fetchLatestVersion();
  if (!latest) return null;

  // Save cache
  try {
    if (!fs.existsSync(YUAN_DIR)) {
      fs.mkdirSync(YUAN_DIR, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(UPDATE_CACHE, JSON.stringify({
      latestVersion: latest,
      checkedAt: Date.now(),
    }), { encoding: "utf-8", mode: 0o600 });
  } catch {
    // Non-critical
  }

  const hasUpdate = isNewer(currentVersion, latest);
  if (!hasUpdate) return null;

  return { currentVersion, latestVersion: latest, hasUpdate };
}

/** Run auto-update — tries pnpm first, then npm */
export async function performUpdate(): Promise<boolean> {
  const { execSync } = await import("node:child_process");

  // Try pnpm global add first (handles workspace:* correctly)
  try {
    execSync(`pnpm install -g ${PACKAGE_NAME}@latest`, {
      stdio: "pipe",
      timeout: 60000,
    });
    return true;
  } catch {
    // pnpm not available or failed — fall back to npm
  }

  try {
    execSync(`npm install -g ${PACKAGE_NAME}@latest`, {
      stdio: "pipe",
      timeout: 60000,
    });
    return true;
  } catch {
    return false;
  }
}
