/**
 * @module dependency-guard
 * @description Detects and gates dependency changes (package.json, lockfile, install commands).
 * Dependency changes are higher risk than normal code changes.
 * NO LLM, deterministic pattern matching.
 */

export type DependencyChangeKind =
  | "manifest_add"
  | "manifest_remove"
  | "manifest_upgrade"
  | "lockfile_only"
  | "install_command"
  | null;

export interface DepGuardResult {
  isDependencyChange: boolean;
  kind: DependencyChangeKind;
  requiresApproval: boolean;
  budgetMultiplier: number;
  verifyAfter: boolean;
  reason?: string;
}

// ─── Constants ───

/** Manifest files (dependency declaration) */
const MANIFEST_FILES = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
];

/** Lock files (resolved dependency tree) */
const LOCK_FILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "Pipfile.lock",
  "poetry.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
];

/** Patterns that match install/add commands across ecosystems */
const INSTALL_PATTERNS: RegExp[] = [
  /\bnpm\s+install\b/i,
  /\bnpm\s+i\b/i,
  /\bpnpm\s+(add|install)\b/i,
  /\byarn\s+add\b/i,
  /\bbun\s+(add|install)\b/i,
  /\bpip\s+install\b/i,
  /\bpip3\s+install\b/i,
  /\bcargo\s+add\b/i,
  /\bgo\s+get\b/i,
  /\bgem\s+install\b/i,
  /\bcomposer\s+require\b/i,
];

// ─── Helpers ───

function isManifestFile(path: string): boolean {
  const basename = path.split("/").pop() ?? "";
  return MANIFEST_FILES.includes(basename);
}

function isLockFile(path: string): boolean {
  const basename = path.split("/").pop() ?? "";
  return LOCK_FILES.includes(basename);
}

function isInstallCommand(command: string): boolean {
  return INSTALL_PATTERNS.some((p) => p.test(command));
}

// ─── Not-a-dependency-change sentinel ───

const NOT_DEP: DepGuardResult = {
  isDependencyChange: false,
  kind: null,
  requiresApproval: false,
  budgetMultiplier: 1,
  verifyAfter: false,
};

// ─── Public API ───

/** Check if a tool call involves dependency changes */
export function checkDependencyChange(
  toolName: string,
  args: Record<string, unknown>,
): DepGuardResult {
  // Shell commands: detect install commands
  if (toolName === "shell_exec" || toolName === "bash") {
    const cmd = String(args.command ?? args.script ?? "");
    if (isInstallCommand(cmd)) {
      return {
        isDependencyChange: true,
        kind: "install_command",
        requiresApproval: true,
        budgetMultiplier: 3,
        verifyAfter: true,
        reason: `Install command detected: ${cmd.slice(0, 80)}`,
      };
    }
    return NOT_DEP;
  }

  // File operations: detect manifest/lock file changes
  if (toolName === "file_write" || toolName === "file_edit") {
    const filePath = String(args.path ?? args.file_path ?? "");

    if (isManifestFile(filePath)) {
      const content = String(args.content ?? args.new_string ?? "");
      // Heuristic: if content mentions dependency sections, classify as add
      const hasNew =
        /\+.*"[^"]+"\s*:\s*"[^"]*"/.test(content) ||
        /dependencies|devDependencies/.test(content);
      return {
        isDependencyChange: true,
        kind: hasNew ? "manifest_add" : "manifest_upgrade",
        requiresApproval: true,
        budgetMultiplier: 2,
        verifyAfter: true,
        reason: `Manifest file modified: ${filePath}`,
      };
    }

    if (isLockFile(filePath)) {
      return {
        isDependencyChange: true,
        kind: "lockfile_only",
        requiresApproval: false, // lockfile-only is usually safe
        budgetMultiplier: 1,
        verifyAfter: true,
        reason: `Lock file modified: ${filePath}`,
      };
    }
  }

  return NOT_DEP;
}
