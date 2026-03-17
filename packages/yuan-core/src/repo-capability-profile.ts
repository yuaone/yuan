/**
 * @module repo-capability-profile
 * @description One-time scan of repository capabilities.
 * Detects: package manager, build tool, test framework, monorepo, language, generated paths.
 * Cached in .yuan/cache/repo-capability-profile.json.
 * NO LLM, filesystem-based detection.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface RepoCapabilityProfile {
  repoType: "monorepo" | "single" | "library" | "cli" | "fullstack";
  packages: string[];
  packageManager: "pnpm" | "npm" | "yarn" | "bun" | "unknown";
  buildTool: "tsc" | "webpack" | "vite" | "esbuild" | "rollup" | "unknown";
  testFramework: "jest" | "vitest" | "mocha" | "node:test" | "pytest" | "unknown";
  primaryLanguage: string;
  hasStrictMode: boolean;
  generatedPaths: string[];
  protectedFiles: string[];
  buildSpeed: "fast" | "normal" | "slow";
  testSpeed: "fast" | "normal" | "slow";
  scannedAt: number;
}

export function scanRepoCapability(projectPath: string): RepoCapabilityProfile {
  const has = (f: string) => existsSync(join(projectPath, f));
  const read = (f: string): string => { try { return readFileSync(join(projectPath, f), "utf-8"); } catch { return ""; } };

  // Package manager
  const packageManager: RepoCapabilityProfile["packageManager"] = has("pnpm-lock.yaml") ? "pnpm"
    : has("yarn.lock") ? "yarn"
    : has("bun.lockb") ? "bun"
    : has("package-lock.json") ? "npm"
    : "unknown";

  // Monorepo detection
  const hasPnpmWorkspace = has("pnpm-workspace.yaml");
  const hasLernaJson = has("lerna.json");
  let packages: string[] = [];
  let repoType: RepoCapabilityProfile["repoType"] = "single";

  if (hasPnpmWorkspace || hasLernaJson) {
    repoType = "monorepo";
    try {
      const dirs = readdirSync(join(projectPath, "packages")).filter(d => {
        try { return statSync(join(projectPath, "packages", d)).isDirectory(); } catch { return false; }
      });
      packages = dirs;
    } catch { /* no packages dir */ }
  }

  // Build tool
  const buildTool: RepoCapabilityProfile["buildTool"] = has("webpack.config.js") || has("webpack.config.ts") ? "webpack"
    : has("vite.config.ts") || has("vite.config.js") ? "vite"
    : has("esbuild.config.js") ? "esbuild"
    : has("rollup.config.js") ? "rollup"
    : has("tsconfig.json") ? "tsc"
    : "unknown";

  // Test framework
  const testFramework: RepoCapabilityProfile["testFramework"] = has("vitest.config.ts") || has("vitest.config.js") ? "vitest"
    : has("jest.config.ts") || has("jest.config.js") || has("jest.config.json") ? "jest"
    : has(".mocharc.yml") || has(".mocharc.json") ? "mocha"
    : has("pytest.ini") || has("setup.py") ? "pytest"
    : "unknown";

  // Language
  const pkgJson = read("package.json");
  const hasTS = has("tsconfig.json");
  const primaryLanguage = hasTS ? "typescript" : pkgJson ? "javascript" : has("Cargo.toml") ? "rust" : has("go.mod") ? "go" : has("requirements.txt") ? "python" : "unknown";

  // Strict mode
  let hasStrictMode = false;
  if (hasTS) {
    const tsconfig = read("tsconfig.json");
    hasStrictMode = /"strict"\s*:\s*true/.test(tsconfig);
  }

  // Generated paths (don't modify these)
  const generatedPaths = ["dist/", "build/", ".next/", "node_modules/", "__pycache__/", "target/", ".output/"]
    .filter(p => has(p));

  // Protected files
  const protectedFiles = ["package.json", "tsconfig.json", "pnpm-lock.yaml", "package-lock.json", ".env", ".gitignore"]
    .filter(p => has(p));

  // Speed estimation (heuristic)
  const buildSpeed: RepoCapabilityProfile["buildSpeed"] = buildTool === "esbuild" || buildTool === "vite" ? "fast" : buildTool === "webpack" ? "slow" : "normal";
  const testSpeed: RepoCapabilityProfile["testSpeed"] = testFramework === "vitest" ? "fast" : testFramework === "jest" ? "normal" : "normal";

  // Detect library vs CLI vs fullstack
  if (repoType === "single") {
    try {
      const pkg = pkgJson ? JSON.parse(pkgJson) : {};
      if (pkg.bin) repoType = "cli";
      else if (pkg.main || pkg.module || pkg.types) repoType = "library";
      else if (has("src/app") || has("src/pages") || has("app/")) repoType = "fullstack";
    } catch { /* invalid package.json */ }
  }

  return {
    repoType, packages, packageManager, buildTool, testFramework,
    primaryLanguage, hasStrictMode, generatedPaths, protectedFiles,
    buildSpeed, testSpeed, scannedAt: Date.now(),
  };
}

export function loadOrScanProfile(projectPath: string): RepoCapabilityProfile {
  const cachePath = join(projectPath, ".yuan", "cache", "repo-capability-profile.json");
  try {
    const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as RepoCapabilityProfile;
    // Invalidate if older than 1 hour
    if (Date.now() - cached.scannedAt < 3600_000) return cached;
  } catch { /* no cache or invalid */ }

  const profile = scanRepoCapability(projectPath);

  // Save cache
  try {
    mkdirSync(join(projectPath, ".yuan", "cache"), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(profile, null, 2));
  } catch { /* non-fatal */ }

  return profile;
}
