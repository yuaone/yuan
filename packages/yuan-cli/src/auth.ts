/**
 * @module auth
 * @description YUAN CLI authentication — OAuth Device Flow.
 *
 * Flow: yuan login → POST /device-code → open browser → poll /device-token → save token
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { YSpinner } from "./y-spinner.js";

// ─── Constants ───

const YUAN_DIR = path.join(os.homedir(), ".yuan");
const AUTH_PATH = path.join(YUAN_DIR, "auth.json");
const CLIENT_ID = "yuan-cli";
const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 15 * 60 * 1_000; // 15 minutes

// ─── Types ───

/** User info stored in the auth file */
export interface AuthUser {
  id: number;
  email: string;
  name: string;
}

/** Plan info stored in the auth file */
export interface AuthPlan {
  name: string;
  maxIterations: number;
  maxParallel: number;
  dailyRuns: number;
}

/** Persisted auth data (~/.yuan/auth.json) */
export interface AuthData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: AuthUser;
  plan: AuthPlan;
  apiKey: string;
  platformUrl: string;
}

/** Device code response from the server */
interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

/** Token polling response */
interface DeviceTokenResponse {
  status: "pending" | "authorized" | "expired" | "denied";
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  user?: AuthUser;
  plan?: AuthPlan;
  apiKey?: string;
}

/** Refresh token response */
interface RefreshResponse {
  accessToken: string;
  expiresIn: number;
}

/** Verify token response */
interface VerifyResponse {
  valid: boolean;
  user?: AuthUser;
  plan?: AuthPlan;
}

// ─── File helpers ───

/** Ensure ~/.yuan directory exists with secure permissions. */
function ensureYuanDir(): void {
  if (!fs.existsSync(YUAN_DIR)) {
    fs.mkdirSync(YUAN_DIR, { recursive: true, mode: 0o700 });
  }
}

/** Write auth data to disk with restricted permissions. */
function saveAuth(data: AuthData): void {
  ensureYuanDir();
  fs.writeFileSync(AUTH_PATH, JSON.stringify(data, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/** Read auth data from disk. Returns null if missing or corrupt. */
function readAuth(): AuthData | null {
  try {
    if (!fs.existsSync(AUTH_PATH)) return null;
    const raw = fs.readFileSync(AUTH_PATH, "utf-8");
    return JSON.parse(raw) as AuthData;
  } catch {
    return null;
  }
}

// ─── Sleep utility ───

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Public API ───

/**
 * Login to YUA Platform using the OAuth Device Flow.
 *
 * 1. Request a device code from the platform.
 * 2. Display the verification URL and user code.
 * 3. Attempt to open the browser automatically.
 * 4. Poll for authorization until the user completes the flow or timeout.
 * 5. Save tokens to ~/.yuan/auth.json.
 *
 * @param platformUrl - Base URL of the YUA Platform (e.g. "https://platform.yuaone.com")
 */
export async function login(platformUrl: string): Promise<void> {
  const spinner = new YSpinner();

  // Step 1: Request device code
  spinner.start("Requesting device code...");

  let deviceCode: DeviceCodeResponse;
  try {
    const res = await fetch(`${platformUrl}/api/yuan-auth/device-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: CLIENT_ID }),
    });

    if (!res.ok) {
      const text = await res.text();
      spinner.fail(`Failed to request device code: ${res.status} ${text}`);
      process.exit(1);
    }

    deviceCode = (await res.json()) as DeviceCodeResponse;
  } catch (err) {
    spinner.fail(
      `Cannot reach platform at ${platformUrl}: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
    return; // unreachable, helps TS narrowing
  }

  spinner.stop();

  // Step 2: Display verification info
  console.log();
  console.log(`  Visit ${deviceCode.verificationUri}`);
  console.log(`  and enter code: \x1b[1m${deviceCode.userCode}\x1b[0m`);
  console.log();

  // Step 3: Auto-open browser (best effort)
  try {
    const openModule = await import("open");
    const openFn = openModule.default ?? openModule;
    await openFn(deviceCode.verificationUri);
  } catch {
    // Browser auto-open is optional — user can copy the URL manually
  }

  // Step 4: Poll for token
  spinner.start("Waiting for authorization...");

  const interval = Math.max(deviceCode.interval ?? 5, 5) * 1_000;
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(interval > 0 ? interval : POLL_INTERVAL_MS);

    try {
      const res = await fetch(`${platformUrl}/api/yuan-auth/device-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: CLIENT_ID,
          deviceCode: deviceCode.deviceCode,
        }),
      });

      if (!res.ok) {
        // Non-200 might be temporary — keep polling unless explicitly denied
        continue;
      }

      const body = (await res.json()) as DeviceTokenResponse;

      if (body.status === "authorized") {
        // Save auth data
        const authData: AuthData = {
          accessToken: body.accessToken!,
          refreshToken: body.refreshToken!,
          expiresAt: Date.now() + (body.expiresIn ?? 3600) * 1_000,
          user: body.user!,
          plan: body.plan!,
          apiKey: body.apiKey ?? "",
          platformUrl,
        };
        saveAuth(authData);

        spinner.success(`Logged in as ${authData.user.email} (${authData.plan.name})`);
        return;
      }

      if (body.status === "denied") {
        spinner.fail("Authorization denied.");
        process.exit(1);
      }

      if (body.status === "expired") {
        spinner.fail("Device code expired. Please try again.");
        process.exit(1);
      }

      // status === "pending" — continue polling
      spinner.update("Waiting for authorization...");
    } catch {
      // Network error — keep polling
    }
  }

  spinner.fail("Authorization timed out (15 minutes). Please try again.");
  process.exit(1);
}

/**
 * Logout from YUA Platform by removing the saved auth file.
 */
export async function logout(): Promise<void> {
  try {
    if (fs.existsSync(AUTH_PATH)) {
      fs.unlinkSync(AUTH_PATH);
      console.log("Logged out.");
    } else {
      console.log("Not logged in.");
    }
  } catch (err) {
    console.error(
      `Failed to remove auth file: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
}

/**
 * Get the current authentication data with automatic token refresh.
 *
 * - Reads ~/.yuan/auth.json
 * - If the access token is expired but the refresh token is still valid,
 *   attempts to refresh the access token automatically.
 *
 * @returns The auth data or null if not logged in / cannot refresh.
 */
export async function getAuth(): Promise<AuthData | null> {
  const auth = readAuth();
  if (!auth) return null;

  // Token still valid — return as-is
  if (Date.now() < auth.expiresAt) {
    return auth;
  }

  // Token expired — attempt refresh
  if (!auth.refreshToken) return null;

  try {
    const res = await fetch(`${auth.platformUrl}/api/yuan-auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.refreshToken}`,
      },
      body: JSON.stringify({ refreshToken: auth.refreshToken }),
    });

    if (!res.ok) {
      // Refresh failed — user needs to re-login
      return null;
    }

    const body = (await res.json()) as RefreshResponse;
    auth.accessToken = body.accessToken;
    auth.expiresAt = Date.now() + (body.expiresIn ?? 3600) * 1_000;
    saveAuth(auth);
    return auth;
  } catch {
    // Network error during refresh — return null
    return null;
  }
}

/**
 * Verify the current access token against the platform.
 *
 * @param platformUrl - Base URL of the YUA Platform. If not provided, uses the
 *   URL from the saved auth data.
 * @returns The verify response or null if not authenticated.
 */
export async function verifyAuth(platformUrl?: string): Promise<VerifyResponse | null> {
  const auth = await getAuth();
  if (!auth) return null;

  const baseUrl = platformUrl ?? auth.platformUrl;

  try {
    const res = await fetch(`${baseUrl}/api/yuan-auth/verify`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
      },
    });

    if (!res.ok) return null;
    return (await res.json()) as VerifyResponse;
  } catch {
    return null;
  }
}
