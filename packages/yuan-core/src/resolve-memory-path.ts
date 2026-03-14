/**
 * @module resolve-memory-path
 * @description Cross-platform, security-isolated memory path resolver.
 *
 * - Per-user isolation: uses os.userInfo().username for user-scoped subdirectories.
 * - Platform detection: Windows (%APPDATA%), macOS (~/Library/Application Support), Linux (~/.yuan).
 * - Cloud infrastructure detection: GCP, Azure, Oracle, Cloud Run.
 * - Project-scoped path: <projectPath>/.yuan/ for project-level files.
 * - Unix directory permissions: 0o700 (owner-only) for user-level dirs.
 */

import { homedir, userInfo, platform } from "node:os";
import { join } from "node:path";
import { mkdirSync, accessSync, constants } from "node:fs";

export interface MemoryPaths {
  userBase: string;
  isCloud: boolean;
  platform: "windows" | "macos" | "linux" | "cloud";
}

/** Detect cloud infrastructure via environment variables. */
function detectCloud(): boolean {
  return !!(
    process.env["CLOUD_SHELL"] ||
    process.env["GOOGLE_CLOUD_PROJECT"] ||
    process.env["AZURE_SUBSCRIPTION_ID"] ||
    process.env["OCI_RESOURCE_PRINCIPAL_VERSION"] ||
    process.env["K_SERVICE"]
  );
}

/** Check if a directory is writable. */
function isWritable(dirPath: string): boolean {
  try {
    accessSync(dirPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the user-level base memory directory and creates it with 0o700 permissions.
 * Path is user-scoped to prevent cross-user data leakage.
 */
export function resolveUserMemoryBase(): MemoryPaths {
  const username = userInfo().username;
  const isCloud = detectCloud();
  const osPlatform = platform();

  let userBase: string;
  let resolvedPlatform: MemoryPaths["platform"];

  if (osPlatform === "win32") {
    // Windows: %APPDATA%\yuan\<username>\ or fallback %USERPROFILE%\.yuan\<username>\
    const appData = process.env["APPDATA"];
    if (appData) {
      userBase = join(appData, "yuan", username);
    } else {
      userBase = join(homedir(), ".yuan", username);
    }
    resolvedPlatform = "windows";
  } else if (osPlatform === "darwin") {
    // macOS: ~/Library/Application Support/yuan/<username>/ if writable, else ~/.yuan/<username>/
    const libAppSupport = join(homedir(), "Library", "Application Support");
    if (isWritable(libAppSupport)) {
      userBase = join(libAppSupport, "yuan", username);
    } else {
      userBase = join(homedir(), ".yuan", username);
    }
    resolvedPlatform = isCloud ? "cloud" : "macos";
  } else {
    // Linux / Cloud / Other: ~/.yuan/<username>/
    userBase = join(homedir(), ".yuan", username);
    resolvedPlatform = isCloud ? "cloud" : "linux";
  }

  // Create directory with owner-only permissions on Unix
  if (osPlatform !== "win32") {
    mkdirSync(userBase, { recursive: true, mode: 0o700 });
  } else {
    mkdirSync(userBase, { recursive: true });
  }

  return { userBase, isCloud, platform: resolvedPlatform };
}

/**
 * Returns the project-scoped memory base directory path.
 * Does NOT create the directory — caller is responsible.
 */
export function resolveProjectMemoryBase(projectPath: string): string {
  return join(projectPath, ".yuan");
}

/**
 * Resolves a memory file path.
 * If projectPath is given, returns the project-scoped path.
 * Otherwise returns the user-level path (and ensures the user base dir exists).
 */
export function resolveMemoryFile(filename: string, projectPath?: string): string {
  if (projectPath) {
    return join(resolveProjectMemoryBase(projectPath), filename);
  }
  const { userBase } = resolveUserMemoryBase();
  return join(userBase, filename);
}
