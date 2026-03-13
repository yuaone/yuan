import fs from "node:fs";
import path from "node:path";

export interface ProjectEnvironmentDetection {
  language?: string;
  framework?: string;
  testFramework?: string;
  packageManager?: string;
  isMonorepo: boolean;
  workspaceTool?: string;
}

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  // JS / TS
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",

  // Python
  ".py": "python",
  ".pyi": "python",
  ".pyx": "python",

  // Systems
  ".rs": "rust",
  ".go": "go",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".zig": "zig",
  ".nim": "nim",

  // JVM
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".sc": "scala",
  ".groovy": "groovy",

  // Mobile / Apple
  ".swift": "swift",
  ".m": "objective-c",
  ".mm": "objective-cpp",

  // Backend / scripting
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".fs": "fsharp",
  ".fsi": "fsharp",
  ".fsx": "fsharp",
  ".hs": "haskell",
  ".lhs": "haskell",
  ".elm": "elm",
  ".ex": "elixir",
  ".exs": "elixir",
  ".clj": "clojure",
  ".cljs": "clojure",
  ".cljc": "clojure",
  ".lua": "lua",
  ".pl": "perl",
  ".pm": "perl",
  ".r": "r",
  ".jl": "julia",
  ".sql": "sql",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".ps1": "powershell",
  ".psm1": "powershell",

  // Web
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".sass": "scss",
  ".less": "less",
  ".vue": "vue",
  ".svelte": "svelte",

  // Config / infra
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".json": "json",
  ".tf": "terraform",
  ".tfvars": "terraform",
  ".nix": "nix",

  // Game / misc
  ".gd": "gdscript",
  ".dart": "dart",

  // Hardware / RTL / HDL
  ".v": "verilog",
  ".vh": "verilog",
  ".sv": "systemverilog",
  ".svh": "systemverilog",
  ".vhd": "vhdl",
  ".vhdl": "vhdl",

  // Smart contracts
  ".sol": "solidity",

  // Wasm / low level
  ".wat": "wat",
  ".wast": "wat",
};

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "target",
  "out",
  ".turbo",
  ".yarn",
  ".pnpm-store",
  ".venv",
  "venv",
  "__pycache__",
]);

const MAX_SCAN_FILES = 4000;

function safeReadJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function safeReadText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function mergeCounts(counts: Record<string, number>, language?: string): void {
  if (!language) return;
  counts[language] = (counts[language] ?? 0) + 1;
}

function getSortedCounts(counts: Record<string, number>): Array<[string, number]> {
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

function pickMajorityLanguage(counts: Record<string, number>, threshold = 0.7): string | undefined {
  const sorted = getSortedCounts(counts);
  if (sorted.length === 0) return undefined;

  const total = sorted.reduce((sum, [, count]) => sum + count, 0);
  const [topLanguage, topCount] = sorted[0];

  if (total <= 0) return undefined;
  if (topCount / total >= threshold) return topLanguage;

  return topLanguage;
}

function walkProjectFiles(projectPath: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    if (results.length >= MAX_SCAN_FILES) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= MAX_SCAN_FILES) return;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(fullPath);
        continue;
      }

      results.push(fullPath);
    }
  }

  walk(projectPath);
  return results;
}

function detectLanguageFromPackageFiles(projectPath: string): string | undefined {
  if (fs.existsSync(path.join(projectPath, "Cargo.toml"))) return "rust";
  if (fs.existsSync(path.join(projectPath, "go.mod"))) return "go";
  if (fs.existsSync(path.join(projectPath, "build.gradle")) || fs.existsSync(path.join(projectPath, "build.gradle.kts"))) return "kotlin";
  if (fs.existsSync(path.join(projectPath, "pom.xml"))) return "java";
  if (fs.existsSync(path.join(projectPath, "composer.json"))) return "php";
  if (fs.existsSync(path.join(projectPath, "Gemfile"))) return "ruby";
  if (fs.existsSync(path.join(projectPath, "mix.exs"))) return "elixir";
  if (fs.existsSync(path.join(projectPath, "Package.swift"))) return "swift";
  if (fs.existsSync(path.join(projectPath, "pubspec.yaml"))) return "dart";
  if (fs.existsSync(path.join(projectPath, "stack.yaml")) || fs.existsSync(path.join(projectPath, "cabal.project"))) return "haskell";
  if (fs.existsSync(path.join(projectPath, "project.clj")) || fs.existsSync(path.join(projectPath, "deps.edn"))) return "clojure";

  const pyprojectPath = path.join(projectPath, "pyproject.toml");
  const requirementsPath = path.join(projectPath, "requirements.txt");
  if (fs.existsSync(pyprojectPath) || fs.existsSync(requirementsPath)) return "python";

  return undefined;
}

export function detectLanguageFromFiles(files?: string[]): string | undefined {
  if (!files || files.length === 0) return undefined;

  const counts: Record<string, number> = {};

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    mergeCounts(counts, EXTENSION_LANGUAGE_MAP[ext]);
  }

  return pickMajorityLanguage(counts);
}

export function detectProjectLanguage(projectPath: string): string | undefined {
  const packageLanguage = detectLanguageFromPackageFiles(projectPath);

  const counts: Record<string, number> = {};
  if (packageLanguage) {
    counts[packageLanguage] = 3;
  }

  const files = walkProjectFiles(projectPath);
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    mergeCounts(counts, EXTENSION_LANGUAGE_MAP[ext]);
  }

  return pickMajorityLanguage(counts);
}

export function detectFramework(projectPath: string): string | undefined {
  try {
    const packageJsonPath = path.join(projectPath, "package.json");
    const packageJson = fs.existsSync(packageJsonPath) ? safeReadJson(packageJsonPath) : null;

    if (packageJson) {
      const deps = {
        ...(typeof packageJson.dependencies === "object" && packageJson.dependencies ? packageJson.dependencies as Record<string, unknown> : {}),
        ...(typeof packageJson.devDependencies === "object" && packageJson.devDependencies ? packageJson.devDependencies as Record<string, unknown> : {}),
      };

      if (deps.next) return "nextjs";
      if (deps.nuxt) return "nuxt";
      if (deps.remix) return "remix";
      if (deps["@angular/core"]) return "angular";
      if (deps.vue) return "vue";
      if (deps.svelte) return "svelte";
      if (deps.react) return "react";
      if (deps.express) return "express";
      if (deps.fastify) return "fastify";
      if (deps["@nestjs/core"]) return "nestjs";
      if (deps.koa) return "koa";
      if (deps.hono) return "hono";
      if (deps.electron) return "electron";
      if (deps["react-native"]) return "react-native";
      if (deps.vite) return "vite";
    }

    const pyprojectPath = path.join(projectPath, "pyproject.toml");
    const pyproject = safeReadText(pyprojectPath);
    if (pyproject) {
      if (pyproject.includes("django")) return "django";
      if (pyproject.includes("fastapi")) return "fastapi";
      if (pyproject.includes("flask")) return "flask";
      if (pyproject.includes("pytest")) return "python";
    }

    const cargoToml = safeReadText(path.join(projectPath, "Cargo.toml"));
    if (cargoToml) {
      if (cargoToml.includes("actix-web")) return "actix-web";
      if (cargoToml.includes("axum")) return "axum";
      if (cargoToml.includes("bevy")) return "bevy";
      return "rust";
    }

    const pubspec = safeReadText(path.join(projectPath, "pubspec.yaml"));
    if (pubspec) {
      if (pubspec.includes("flutter:")) return "flutter";
      return "dart";
    }

    const mixExs = safeReadText(path.join(projectPath, "mix.exs"));
    if (mixExs) {
      if (mixExs.includes(":phoenix")) return "phoenix";
      return "elixir";
    }

    const goMod = safeReadText(path.join(projectPath, "go.mod"));
    if (goMod) {
      if (goMod.includes("gin-gonic/gin")) return "gin";
      if (goMod.includes("labstack/echo")) return "echo";
      if (goMod.includes("gofiber/fiber")) return "fiber";
      return "go";
    }
  } catch {}

  return undefined;
}

export function detectTestFramework(projectPath: string): string | undefined {
  try {
    const packageJsonPath = path.join(projectPath, "package.json");
    const packageJson = fs.existsSync(packageJsonPath) ? safeReadJson(packageJsonPath) : null;

    if (packageJson) {
      const deps = {
        ...(typeof packageJson.dependencies === "object" && packageJson.dependencies ? packageJson.dependencies as Record<string, unknown> : {}),
        ...(typeof packageJson.devDependencies === "object" && packageJson.devDependencies ? packageJson.devDependencies as Record<string, unknown> : {}),
      };

      if (deps.vitest) return "vitest";
      if (deps.jest) return "jest";
      if (deps.mocha) return "mocha";
      if (deps.ava) return "ava";
      if (deps.playwright) return "playwright";
      if (deps.cypress) return "cypress";
    }

    const pyproject = safeReadText(path.join(projectPath, "pyproject.toml"));
    if (pyproject) {
      if (pyproject.includes("pytest")) return "pytest";
      if (pyproject.includes("unittest")) return "unittest";
    }

    if (fs.existsSync(path.join(projectPath, "pytest.ini"))) return "pytest";
    if (fs.existsSync(path.join(projectPath, "Cargo.toml"))) return "cargo test";
    if (fs.existsSync(path.join(projectPath, "go.mod"))) return "go test";
    if (fs.existsSync(path.join(projectPath, "mix.exs"))) return "exunit";
    if (fs.existsSync(path.join(projectPath, "pubspec.yaml"))) return "flutter test";
  } catch {}

  return undefined;
}

export function detectPackageManager(projectPath: string): string | undefined {
  const packageJsonPath = path.join(projectPath, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    if (fs.existsSync(path.join(projectPath, "pnpm-lock.yaml"))) return "pnpm";
    if (fs.existsSync(path.join(projectPath, "yarn.lock"))) return "yarn";
    if (fs.existsSync(path.join(projectPath, "bun.lockb")) || fs.existsSync(path.join(projectPath, "bun.lock"))) return "bun";
    if (fs.existsSync(path.join(projectPath, "package-lock.json"))) return "npm";

    const packageJson = safeReadJson(packageJsonPath);
    const packageManager = typeof packageJson?.packageManager === "string" ? packageJson.packageManager : undefined;
    if (packageManager) {
      if (packageManager.startsWith("pnpm")) return "pnpm";
      if (packageManager.startsWith("yarn")) return "yarn";
      if (packageManager.startsWith("npm")) return "npm";
      if (packageManager.startsWith("bun")) return "bun";
    }
    return "npm";
  }

  if (fs.existsSync(path.join(projectPath, "Cargo.toml"))) return "cargo";
  if (fs.existsSync(path.join(projectPath, "go.mod"))) return "go";
  if (fs.existsSync(path.join(projectPath, "composer.json"))) return "composer";
  if (fs.existsSync(path.join(projectPath, "Gemfile"))) return "bundler";
  if (fs.existsSync(path.join(projectPath, "mix.exs"))) return "mix";
  if (fs.existsSync(path.join(projectPath, "pubspec.yaml"))) return "pub";

  const pyprojectPath = path.join(projectPath, "pyproject.toml");
  if (fs.existsSync(pyprojectPath)) {
    const pyproject = safeReadText(pyprojectPath) ?? "";
    if (pyproject.includes("[tool.poetry]")) return "poetry";
    if (pyproject.includes("[tool.pdm]")) return "pdm";
    if (pyproject.includes("[tool.uv]")) return "uv";
    return "pip";
  }

  if (fs.existsSync(path.join(projectPath, "requirements.txt"))) return "pip";
  return undefined;
}

export function detectMonorepo(projectPath: string): {
  isMonorepo: boolean;
  workspaceTool?: string;
} {
  try {
    const packageJsonPath = path.join(projectPath, "package.json");
    const pnpmWorkspacePath = path.join(projectPath, "pnpm-workspace.yaml");
    const turboPath = path.join(projectPath, "turbo.json");
    const nxPath = path.join(projectPath, "nx.json");
    const rushPath = path.join(projectPath, "rush.json");
    const lernaPath = path.join(projectPath, "lerna.json");

    if (fs.existsSync(pnpmWorkspacePath)) {
      return { isMonorepo: true, workspaceTool: "pnpm-workspace" };
    }
    if (fs.existsSync(turboPath)) {
      return { isMonorepo: true, workspaceTool: "turbo" };
    }
    if (fs.existsSync(nxPath)) {
      return { isMonorepo: true, workspaceTool: "nx" };
    }
    if (fs.existsSync(rushPath)) {
      return { isMonorepo: true, workspaceTool: "rush" };
    }
    if (fs.existsSync(lernaPath)) {
      return { isMonorepo: true, workspaceTool: "lerna" };
    }

    if (fs.existsSync(packageJsonPath)) {
      const packageJson = safeReadJson(packageJsonPath);
      const workspaces = packageJson?.workspaces;
      if (Array.isArray(workspaces) && workspaces.length > 0) {
        return { isMonorepo: true, workspaceTool: "workspaces" };
      }
      if (
        typeof workspaces === "object" &&
        workspaces !== null &&
        Array.isArray((workspaces as { packages?: unknown }).packages)
      ) {
        return { isMonorepo: true, workspaceTool: "workspaces" };
      }
    }

    const commonMonorepoDirs = ["packages", "apps", "libs", "services"];
    let hitCount = 0;
    for (const dir of commonMonorepoDirs) {
      if (fs.existsSync(path.join(projectPath, dir))) {
        hitCount++;
      }
    }

    if (hitCount >= 2) {
      return { isMonorepo: true, workspaceTool: "folder-heuristic" };
    }
  } catch {}

  return { isMonorepo: false };
}

export function detectProjectEnvironment(projectPath: string, targetFiles?: string[]): ProjectEnvironmentDetection {
  const fileLanguage = detectLanguageFromFiles(targetFiles);
  const projectLanguage = detectProjectLanguage(projectPath);
  const framework = detectFramework(projectPath);
  const testFramework = detectTestFramework(projectPath);
  const packageManager = detectPackageManager(projectPath);
  const monorepo = detectMonorepo(projectPath);

  return {
    language: fileLanguage ?? projectLanguage,
    framework,
    testFramework,
    packageManager,
    isMonorepo: monorepo.isMonorepo,
    workspaceTool: monorepo.workspaceTool,
  };
}