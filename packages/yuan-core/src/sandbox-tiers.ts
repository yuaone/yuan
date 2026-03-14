/**
 * @module sandbox-tiers
 * @description YUAN Agent Sandbox Execution Tiers (T0–T4).
 *
 * 5 levels of isolation based on task risk level:
 * - T0: Read-Only — file read, grep, glob only
 * - T1: Write-Restricted — T0 + specific file writes, no network
 * - T2: Project-Scoped — full project read/write, limited shell
 * - T3: Build-Enabled — T2 + npm/pnpm, localhost network
 * - T4: Full-Network — T3 + external network (allowlist)
 *
 * The SandboxManager auto-selects a tier based on requested tools,
 * target files, and shell commands, then validates every action
 * against the tier's policy before allowing execution.
 */

import { EventEmitter } from "node:events";
import path from "node:path";

// ══════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════

/** Sandbox isolation tier (0 = most restrictive, 4 = least restrictive) */
export type SandboxTier = 0 | 1 | 2 | 3 | 4;

/** Policy definition for a given sandbox tier */
export interface TierPolicy {
  /** Tier level */
  tier: SandboxTier;
  /** Human-readable name */
  name: string;
  /** Tier description */
  description: string;

  // ── File permissions ──
  /** Whether file reads are allowed */
  fileRead: boolean;
  /** Whether file writes are allowed */
  fileWrite: boolean;
  /** Whether file deletes are allowed */
  fileDelete: boolean;
  /** Glob patterns for allowed write paths (empty = all in project) */
  allowedWritePaths: string[];
  /** Glob patterns that are always blocked for writes */
  blockedWritePaths: string[];

  // ── Shell permissions ──
  /** Whether shell execution is allowed */
  shellExec: boolean;
  /** Allowed commands (empty = none, ["*"] = all) */
  allowedCommands: string[];
  /** Commands that are always blocked */
  blockedCommands: string[];
  /** Maximum shell execution time (ms) */
  maxExecTime: number;

  // ── Network permissions ──
  /** Whether network access is allowed */
  networkAccess: boolean;
  /** Allowed network hosts (empty = none) */
  allowedHosts: string[];
  /** Blocked network hosts */
  blockedHosts: string[];

  // ── Resource limits ──
  /** Maximum file size in bytes */
  maxFileSize: number;
  /** Maximum file writes per session */
  maxTotalWrites: number;
  /** Maximum shell executions per session */
  maxShellCalls: number;
}

/** Result of automatic tier selection */
export interface SandboxDecision {
  /** Selected tier */
  tier: SandboxTier;
  /** Human-readable reason for the selection */
  reason: string;
  /** Factors that influenced the decision */
  factors: string[];
  /** Whether the user can override to a higher tier */
  overrideable: boolean;
}

/** Record of a sandbox policy violation */
export interface SandboxViolation {
  /** Tier at the time of violation */
  tier: SandboxTier;
  /** What action was attempted */
  action: string;
  /** The resource involved (file path, command, host) */
  resource: string;
  /** Which rule was violated */
  rule: string;
  /** When the violation occurred (epoch ms) */
  timestamp: number;
  /** Whether the action was blocked (true) or just warned (false) */
  blocked: boolean;
}

/** Configuration for the SandboxManager */
export interface SandboxConfig {
  /** Project root directory */
  projectPath: string;
  /** Default tier for new sessions (default: 2) */
  defaultTier?: SandboxTier;
  /** Maximum allowed tier (default: 3) */
  maxTier?: SandboxTier;
  /** Auto-escalate tier when needed (default: false) */
  enableAutoEscalation?: boolean;
  /** Log all sandbox checks (default: true) */
  auditLog?: boolean;
}

/** Runtime state of the sandbox */
export interface SandboxState {
  /** Current active tier */
  currentTier: SandboxTier;
  /** Session ID */
  sessionId: string;
  /** Number of file writes performed */
  writeCount: number;
  /** Number of shell executions performed */
  shellCount: number;
  /** History of policy violations */
  violations: SandboxViolation[];
  /** History of tier escalations */
  escalationHistory: {
    from: SandboxTier;
    to: SandboxTier;
    reason: string;
    timestamp: number;
  }[];
}

// ── Internal required config (all fields set) ──

interface RequiredSandboxConfig {
  projectPath: string;
  defaultTier: SandboxTier;
  maxTier: SandboxTier;
  enableAutoEscalation: boolean;
  auditLog: boolean;
}

// ══════════════════════════════════════════════════════════════════════
// Events
// ══════════════════════════════════════════════════════════════════════

/** Events emitted by SandboxManager */
export interface SandboxManagerEvents {
  "tier:changed": (prev: SandboxTier, next: SandboxTier, reason: string) => void;
  "violation:blocked": (violation: SandboxViolation) => void;
  "violation:warned": (violation: SandboxViolation) => void;
  escalation: (from: SandboxTier, to: SandboxTier, reason: string) => void;
}

// ══════════════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════════════

/** Maximum violation records kept in memory */
const MAX_VIOLATIONS = 500;

/** Maximum escalation history entries */
const MAX_ESCALATION_HISTORY = 100;

/** Tools that only read data */
const READ_ONLY_TOOLS = new Set([
  "file_read",
  "grep",
  "glob",
  "codebase_search",
  "list_directory",
]);

/** Tools that write files */
const WRITE_TOOLS = new Set(["file_write", "file_edit", "file_create"]);

/** Tools that delete files */
const DELETE_TOOLS = new Set(["file_delete"]);

/** Tools that execute shell commands */
const SHELL_TOOLS = new Set(["shell_exec", "shell_command", "bash"]);

/** Build-related command patterns */
const BUILD_COMMANDS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "tsc",
  "make",
  "cmake",
  "cargo",
  "go",
  "gradle",
  "mvn",
  "pip",
  "poetry",
]);

/** Network-related command patterns */
const NETWORK_COMMANDS = new Set([
  "curl",
  "wget",
  "fetch",
  "http",
  "ssh",
  "scp",
  "rsync",
  "ftp",
]);

/** Package install patterns (regex) */
const PACKAGE_INSTALL_PATTERNS = [
  /^npm\s+install/,
  /^npm\s+i\b/,
  /^pnpm\s+add/,
  /^pnpm\s+install/,
  /^yarn\s+add/,
  /^pip\s+install/,
  /^cargo\s+install/,
  /^go\s+get/,
];

/** Default file size limit: 10 MB */
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;

// ══════════════════════════════════════════════════════════════════════
// SandboxManager
// ══════════════════════════════════════════════════════════════════════

/**
 * SandboxManager — manages execution isolation tiers for the YUAN agent.
 *
 * Provides 5 tiers of isolation (T0–T4), auto-selects the appropriate tier
 * based on requested tools and commands, and validates every action against
 * the active tier's policy before allowing execution.
 *
 * @example
 * ```ts
 * const sandbox = new SandboxManager({ projectPath: "/my/project" });
 *
 * // Auto-select tier
 * const decision = sandbox.selectTier(["file_read", "file_write"], ["src/app.ts"]);
 * // => { tier: 1, reason: "file write required", ... }
 *
 * // Validate actions
 * const { allowed } = sandbox.canWriteFile("src/app.ts");
 * ```
 */
export class SandboxManager extends EventEmitter {
  private config: RequiredSandboxConfig;
  private tiers: Map<SandboxTier, TierPolicy>;
  private state: SandboxState;

  constructor(config: SandboxConfig) {
    super();

    this.config = {
      projectPath: path.resolve(config.projectPath),
      defaultTier: config.defaultTier ?? 2,
      maxTier: config.maxTier ?? 3,
      enableAutoEscalation: config.enableAutoEscalation ?? false,
      auditLog: config.auditLog ?? true,
    };

    this.tiers = this.buildDefaultTiers();

    this.state = {
      currentTier: this.config.defaultTier,
      sessionId: "",
      writeCount: 0,
      shellCount: 0,
      violations: [],
      escalationHistory: [],
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Tier Selection
  // ──────────────────────────────────────────────────────────────────

  /**
   * Auto-select the appropriate sandbox tier based on requested tools,
   * target files, and shell commands.
   *
   * @param tools - List of tool names that will be used
   * @param targetFiles - List of file paths that may be modified
   * @param shellCommands - Optional list of shell commands to execute
   * @returns Decision with selected tier, reason, and influencing factors
   */
  selectTier(
    tools: string[],
    targetFiles: string[],
    shellCommands?: string[],
  ): SandboxDecision {
    let tier: SandboxTier = 0;
    const factors: string[] = [];
    const toolSet = new Set(tools);
    const commands = shellCommands ?? [];

    // File write needed?
    const hasWriteTools = tools.some((t) => WRITE_TOOLS.has(t));
    if (hasWriteTools) {
      tier = Math.max(tier, 1) as SandboxTier;
      factors.push("file write required");

      if (targetFiles.length > 5) {
        tier = Math.max(tier, 2) as SandboxTier;
        factors.push(`many files to modify (${targetFiles.length})`);
      }
    }

    // File delete needed?
    const hasDeleteTools = tools.some((t) => DELETE_TOOLS.has(t));
    if (hasDeleteTools) {
      tier = Math.max(tier, 2) as SandboxTier;
      factors.push("file deletion required");
    }

    // Shell needed?
    const hasShellTools = tools.some((t) => SHELL_TOOLS.has(t));
    if (hasShellTools) {
      tier = Math.max(tier, 2) as SandboxTier;
      factors.push("shell execution required");

      // Check for build commands
      for (const cmd of commands) {
        const executable = this.extractCommand(cmd);
        if (this.isBuildCommand(executable)) {
          tier = Math.max(tier, 3) as SandboxTier;
          factors.push(`build command detected: ${executable}`);
          break;
        }
      }

      // Check for network commands
      for (const cmd of commands) {
        const executable = this.extractCommand(cmd);
        if (this.isNetworkCommand(executable)) {
          tier = Math.max(tier, 4) as SandboxTier;
          factors.push(`network command detected: ${executable}`);
          break;
        }
      }
    }

    // Package install?
    if (hasShellTools) {
      for (const cmd of commands) {
        if (PACKAGE_INSTALL_PATTERNS.some((p) => p.test(cmd.trim()))) {
          tier = Math.max(tier, 4) as SandboxTier;
          factors.push("package installation requires network");
          break;
        }
      }
    }

    // Cap at maxTier
    const uncapped = tier;
    tier = Math.min(tier, this.config.maxTier) as SandboxTier;
    if (tier < uncapped) {
      factors.push(`capped from T${uncapped} to T${tier} by maxTier config`);
    }

    const policy = this.tiers.get(tier)!;
    const reason = factors.length > 0
      ? `T${tier} (${policy.name}): ${factors[0]}`
      : `T${tier} (${policy.name}): read-only access sufficient`;

    // Set the tier
    this.setTier(tier, reason);

    return {
      tier,
      reason,
      factors,
      overrideable: tier < 4,
    };
  }

  /**
   * Manually set the sandbox tier.
   *
   * @param tier - Target tier level
   * @param reason - Reason for the tier change
   * @throws If tier exceeds maxTier
   */
  setTier(tier: SandboxTier, reason: string): void {
    if (tier > this.config.maxTier) {
      this.recordViolation(
        "setTier",
        `T${tier}`,
        `tier ${tier} exceeds maxTier ${this.config.maxTier}`,
        true,
      );
      return;
    }

    const prev = this.state.currentTier;
    if (prev !== tier) {
      this.state.currentTier = tier;
      this.emit("tier:changed", prev, tier, reason);
    }
  }

  /**
   * Escalate to the next higher tier.
   *
   * @param reason - Why escalation is needed
   * @returns true if escalation succeeded, false if already at maxTier
   */
  escalate(reason: string): boolean {
    if (!this.config.enableAutoEscalation) {
      this.recordViolation(
        "escalate",
        `T${this.state.currentTier}→T${(this.state.currentTier + 1) as SandboxTier}`,
        "auto-escalation disabled",
        true,
      );
      return false;
    }

    const current = this.state.currentTier;
    if (current >= this.config.maxTier) {
      return false;
    }

    const next = (current + 1) as SandboxTier;
    // Cap escalation history
    if (this.state.escalationHistory.length >= MAX_ESCALATION_HISTORY) {
      this.state.escalationHistory = this.state.escalationHistory.slice(-Math.floor(MAX_ESCALATION_HISTORY / 2));
    }
    this.state.escalationHistory.push({
      from: current,
      to: next,
      reason,
      timestamp: Date.now(),
    });

    this.state.currentTier = next;
    this.emit("tier:changed", current, next, reason);
    this.emit("escalation", current, next, reason);
    return true;
  }

  /** Get the current active tier */
  getCurrentTier(): SandboxTier {
    return this.state.currentTier;
  }

  /**
   * Get the policy for a specific tier, or the current tier if omitted.
   *
   * @param tier - Tier to get policy for (defaults to current)
   */
  getTierPolicy(tier?: SandboxTier): TierPolicy {
    const t = tier ?? this.state.currentTier;
    const policy = this.tiers.get(t);
    if (!policy) {
      throw new Error(`Unknown sandbox tier: ${t}`);
    }
    return policy;
  }

  // ──────────────────────────────────────────────────────────────────
  // Validation
  // ──────────────────────────────────────────────────────────────────

  /**
   * Check if reading a file is allowed under the current tier.
   *
   * File reads are intentionally permissive: the agent needs to read files in
   * sibling directories (e.g. `../other-package`) to understand monorepo context.
   * Only system paths (/etc, /proc, /sys, /dev, /boot, /root) are blocked.
   * Write operations remain project-scoped.
   *
   * @param filePath - Absolute or relative file path
   * @returns true if the read is allowed
   */
  canReadFile(filePath: string): boolean {
    const policy = this.getTierPolicy();

    if (!policy.fileRead) {
      this.recordViolation("file_read", filePath, "file reads not allowed at this tier", true);
      return false;
    }

    // Resolve the path to check for system directory access
    const normalized = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(this.config.projectPath, filePath);

    // Block known dangerous system paths — but allow sibling directories
    const BLOCKED_SYSTEM_DIRS = ["/etc", "/proc", "/sys", "/dev", "/boot", "/root"];
    const isSystemPath = BLOCKED_SYSTEM_DIRS.some(
      (dir) => normalized === dir || normalized.startsWith(dir + "/"),
    );
    if (isSystemPath) {
      this.recordViolation(
        "file_read",
        filePath,
        `access to system path blocked: ${normalized}`,
        true,
      );
      return false;
    }

    return true;
  }

  /**
   * Check if writing a file is allowed under the current tier.
   *
   * @param filePath - Absolute or relative file path
   * @returns Object with allowed status and optional reason
   */
  canWriteFile(filePath: string): { allowed: boolean; reason?: string } {
    const policy = this.getTierPolicy();

    if (!policy.fileWrite) {
      const reason = "file writes not allowed at this tier";
      this.recordViolation("file_write", filePath, reason, true);
      return { allowed: false, reason };
    }

    // Check write count limit
    if (this.state.writeCount >= policy.maxTotalWrites) {
      const reason = `write limit reached (${policy.maxTotalWrites})`;
      this.recordViolation("file_write", filePath, reason, true);
      return { allowed: false, reason };
    }

    const normalized = this.normalizePath(filePath);
    const relative = this.toRelative(normalized);

    // Must be within project
    if (!normalized.startsWith(this.config.projectPath)) {
      const reason = "path is outside project directory";
      this.recordViolation("file_write", filePath, reason, true);
      return { allowed: false, reason };
    }

    // Check blocked paths
    if (this.matchesPattern(relative, policy.blockedWritePaths)) {
      const reason = `path matches blocked pattern`;
      this.recordViolation("file_write", filePath, reason, true);
      return { allowed: false, reason };
    }

    // Check allowed paths (if restricted)
    if (
      policy.allowedWritePaths.length > 0 &&
      !policy.allowedWritePaths.includes("**")
    ) {
      if (!this.matchesPattern(relative, policy.allowedWritePaths)) {
        const reason = "path not in allowed write paths";
        this.recordViolation("file_write", filePath, reason, true);
        return { allowed: false, reason };
      }
    }

    // Note: writeCount is incremented here. Callers should only call
    // canWriteFile() when they intend to actually perform the write.
    // For preview/validation, use validateToolCall() which does not
    // increment counters directly.
    this.state.writeCount++;
    return { allowed: true };
  }

  /**
   * Check if writing a file would be allowed WITHOUT incrementing counters.
   * Use this for preview/validation — unlike canWriteFile, it has no side effects.
   */
  checkWriteFile(filePath: string): { allowed: boolean; reason?: string } {
    const policy = this.getTierPolicy();
    if (!policy.fileWrite) return { allowed: false, reason: "file writes not allowed at this tier" };
    if (this.state.writeCount >= policy.maxTotalWrites) return { allowed: false, reason: `write limit reached (${policy.maxTotalWrites})` };
    const normalized = this.normalizePath(filePath);
    if (!normalized.startsWith(this.config.projectPath)) return { allowed: false, reason: "path is outside project directory" };
    const relative = this.toRelative(normalized);
    if (this.matchesPattern(relative, policy.blockedWritePaths)) return { allowed: false, reason: "path matches blocked pattern" };
    if (policy.allowedWritePaths.length > 0 && !policy.allowedWritePaths.includes("**")) {
      if (!this.matchesPattern(relative, policy.allowedWritePaths)) return { allowed: false, reason: "path not in allowed write paths" };
    }
    return { allowed: true };
  }

  /**
   * Check if deleting a file is allowed under the current tier.
   *
   * @param filePath - Absolute or relative file path
   * @returns Object with allowed status and optional reason
   */
  canDeleteFile(filePath: string): { allowed: boolean; reason?: string } {
    const policy = this.getTierPolicy();

    if (!policy.fileDelete) {
      const reason = "file deletion not allowed at this tier";
      this.recordViolation("file_delete", filePath, reason, true);
      return { allowed: false, reason };
    }

    const normalized = this.normalizePath(filePath);
    const relative = this.toRelative(normalized);

    // Must be within project
    if (!normalized.startsWith(this.config.projectPath)) {
      const reason = "path is outside project directory";
      this.recordViolation("file_delete", filePath, reason, true);
      return { allowed: false, reason };
    }

    // Check blocked paths
    if (this.matchesPattern(relative, policy.blockedWritePaths)) {
      const reason = "path matches blocked pattern";
      this.recordViolation("file_delete", filePath, reason, true);
      return { allowed: false, reason };
    }

    return { allowed: true };
  }

  /**
   * Check if a shell command is allowed under the current tier.
   *
   * @param command - The command string (e.g. "tsc --noEmit")
   * @param args - Optional additional arguments
   * @returns Object with allowed status and optional reason
   */
  canExecuteShell(
    command: string,
    args?: string[],
  ): { allowed: boolean; reason?: string } {
    const policy = this.getTierPolicy();

    if (!policy.shellExec) {
      const reason = "shell execution not allowed at this tier";
      this.recordViolation("shell_exec", command, reason, true);
      return { allowed: false, reason };
    }

    // Check shell count limit
    if (this.state.shellCount >= policy.maxShellCalls) {
      const reason = `shell call limit reached (${policy.maxShellCalls})`;
      this.recordViolation("shell_exec", command, reason, true);
      return { allowed: false, reason };
    }

    const fullCommand = args ? `${command} ${args.join(" ")}` : command;
    const executable = this.extractCommand(fullCommand);

    // Check blocked commands — defense-in-depth:
    // 1. Exact executable match (after path.basename stripping)
    // 2. Detect shell wrappers (bash -c, sh -c, eval, etc.)
    // 3. Check if blocked command appears as executable in piped/chained commands
    const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh", "dash", "csh", "ksh", "env"]);
    const isShellWrapped = SHELL_WRAPPERS.has(executable) &&
      (fullCommand.includes(" -c ") || fullCommand.includes(" -c\"") || fullCommand.includes(" -c'"));

    for (const blocked of policy.blockedCommands) {
      // Exact executable match
      if (executable === blocked) {
        const reason = `command "${blocked}" is blocked at this tier`;
        this.recordViolation("shell_exec", fullCommand, reason, true);
        return { allowed: false, reason };
      }

      // Shell wrapper detection — block "bash -c 'rm -rf /'" etc.
      if (isShellWrapped && fullCommand.includes(blocked)) {
        const reason = `command "${blocked}" detected inside shell wrapper`;
        this.recordViolation("shell_exec", fullCommand, reason, true);
        return { allowed: false, reason };
      }

      // Check piped/chained commands (|, &&, ;, ||)
      const segments = fullCommand.split(/\s*(?:\|{1,2}|&&|;)\s*/);
      for (const segment of segments) {
        const segCmd = segment.trim().split(/\s+/)[0];
        if (segCmd && path.basename(segCmd) === blocked) {
          const reason = `command "${blocked}" detected in chained command`;
          this.recordViolation("shell_exec", fullCommand, reason, true);
          return { allowed: false, reason };
        }
      }
    }

    // Check allowed commands (if restricted)
    if (
      policy.allowedCommands.length > 0 &&
      !policy.allowedCommands.includes("*")
    ) {
      if (!policy.allowedCommands.includes(executable)) {
        const reason = `command "${executable}" not in allowed list`;
        this.recordViolation("shell_exec", fullCommand, reason, true);
        return { allowed: false, reason };
      }
    }

    // Increment shell count
    this.state.shellCount++;
    return { allowed: true };
  }

  /**
   * Check if a network request to a specific host is allowed.
   *
   * @param host - The hostname to check
   * @returns Object with allowed status and optional reason
   */
  canAccessNetwork(host: string): { allowed: boolean; reason?: string } {
    const policy = this.getTierPolicy();

    if (!policy.networkAccess) {
      const reason = "network access not allowed at this tier";
      this.recordViolation("network", host, reason, true);
      return { allowed: false, reason };
    }

    // Strip port from host for comparison
    const hostOnly = host.replace(/:\d+$/, "").toLowerCase();

    // Check blocked hosts — includes subdomain matching
    for (const blocked of policy.blockedHosts) {
      const blockedLower = blocked.toLowerCase();
      if (
        hostOnly === blockedLower ||
        hostOnly.endsWith("." + blockedLower)
      ) {
        const reason = `host "${host}" is blocked (matches ${blocked})`;
        this.recordViolation("network", host, reason, true);
        return { allowed: false, reason };
      }
    }

    // Block cloud metadata endpoints (AWS, GCP, Azure)
    const METADATA_IPS = ["169.254.169.254", "metadata.google.internal", "100.100.100.200"];
    if (METADATA_IPS.some((ip) => hostOnly === ip || hostOnly.endsWith("." + ip))) {
      const reason = "cloud metadata endpoint blocked";
      this.recordViolation("network", host, reason, true);
      return { allowed: false, reason };
    }

    // Check allowed hosts (if restricted) — includes subdomain matching
    if (
      policy.allowedHosts.length > 0 &&
      !policy.allowedHosts.includes("*")
    ) {
      const isAllowed = policy.allowedHosts.some((allowed) => {
        const allowedLower = allowed.toLowerCase();
        return hostOnly === allowedLower || hostOnly.endsWith("." + allowedLower);
      });
      if (!isAllowed) {
        const reason = `host "${host}" not in allowed list`;
        this.recordViolation("network", host, reason, true);
        return { allowed: false, reason };
      }
    }

    return { allowed: true };
  }

  /**
   * Validate a tool call against the current tier's policy.
   *
   * @param toolName - Name of the tool being called
   * @param input - Tool input parameters
   * @returns Object with allowed status and list of violations
   */
  validateToolCall(
    toolName: string,
    input: Record<string, unknown>,
  ): { allowed: boolean; violations: string[] } {
    const violations: string[] = [];

    // Read tools
    if (READ_ONLY_TOOLS.has(toolName)) {
      const filePath = (input.path ?? input.file_path ?? input.pattern) as string | undefined;
      if (filePath && !this.canReadFile(filePath)) {
        violations.push(`file read not allowed: ${filePath}`);
      }
    }

    // Write tools
    if (WRITE_TOOLS.has(toolName)) {
      const filePath = (input.path ?? input.file_path) as string | undefined;
      if (filePath) {
        const result = this.canWriteFile(filePath);
        if (!result.allowed) {
          violations.push(`file write blocked: ${result.reason}`);
        }
      }

      // Check file size
      const content = input.content as string | undefined;
      if (content) {
        const policy = this.getTierPolicy();
        const size = Buffer.byteLength(content, "utf-8");
        if (size > policy.maxFileSize) {
          violations.push(
            `file size ${size} exceeds limit ${policy.maxFileSize}`,
          );
        }
      }
    }

    // Delete tools
    if (DELETE_TOOLS.has(toolName)) {
      const filePath = (input.path ?? input.file_path) as string | undefined;
      if (filePath) {
        const result = this.canDeleteFile(filePath);
        if (!result.allowed) {
          violations.push(`file delete blocked: ${result.reason}`);
        }
      }
    }

    // Shell tools
    if (SHELL_TOOLS.has(toolName)) {
      const command = (input.command ?? input.cmd) as string | undefined;
      if (command) {
        const result = this.canExecuteShell(command);
        if (!result.allowed) {
          violations.push(`shell exec blocked: ${result.reason}`);
        }
      }
    }

    return {
      allowed: violations.length === 0,
      violations,
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Monitoring
  // ──────────────────────────────────────────────────────────────────

  /** Get all recorded violations */
  getViolations(): SandboxViolation[] {
    return [...this.state.violations];
  }

  /** Get current sandbox state (readonly snapshot) */
  getState(): Readonly<SandboxState> {
    return { ...this.state, violations: [...this.state.violations] };
  }

  /**
   * Reset counters for a new session.
   *
   * @param sessionId - New session identifier
   */
  reset(sessionId: string): void {
    this.state = {
      currentTier: this.config.defaultTier,
      sessionId,
      writeCount: 0,
      shellCount: 0,
      violations: [],
      escalationHistory: [],
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────────────────────────

  /**
   * Build the default tier policies (T0–T4).
   *
   * @returns Map of tier level to policy definition
   */
  private buildDefaultTiers(): Map<SandboxTier, TierPolicy> {
    const tiers = new Map<SandboxTier, TierPolicy>();

    // ── T0: Read-Only ──
    tiers.set(0, {
      tier: 0,
      name: "Read-Only",
      description: "File read, grep, glob only. No writes, no shell, no network.",
      fileRead: true,
      fileWrite: false,
      fileDelete: false,
      allowedWritePaths: [],
      blockedWritePaths: [],
      shellExec: false,
      allowedCommands: [],
      blockedCommands: [],
      maxExecTime: 0,
      networkAccess: false,
      allowedHosts: [],
      blockedHosts: [],
      maxFileSize: DEFAULT_MAX_FILE_SIZE,
      maxTotalWrites: 0,
      maxShellCalls: 0,
    });

    // ── T1: Write-Restricted ──
    tiers.set(1, {
      tier: 1,
      name: "Write-Restricted",
      description: "Read + specific file writes (src/test). No shell, no network.",
      fileRead: true,
      fileWrite: true,
      fileDelete: false,
      allowedWritePaths: ["src/**", "test/**", "tests/**"],
      blockedWritePaths: [
        "**/node_modules/**",
        "**/.env*",
        "**/package-lock.json",
        "**/pnpm-lock.yaml",
      ],
      shellExec: false,
      allowedCommands: [],
      blockedCommands: [],
      maxExecTime: 0,
      networkAccess: false,
      allowedHosts: [],
      blockedHosts: [],
      maxFileSize: DEFAULT_MAX_FILE_SIZE,
      maxTotalWrites: 10,
      maxShellCalls: 0,
    });

    // ── T2: Project-Scoped ──
    tiers.set(2, {
      tier: 2,
      name: "Project-Scoped",
      description: "Full project read/write, limited shell (lint/format), no network.",
      fileRead: true,
      fileWrite: true,
      fileDelete: true,
      allowedWritePaths: ["**"],
      blockedWritePaths: [
        "**/node_modules/**",
        "**/.env*",
        "**/.git/**",
      ],
      shellExec: true,
      allowedCommands: [
        "tsc",
        "eslint",
        "prettier",
        "cat",
        "ls",
        "wc",
        "grep",
        "find",
      ],
      blockedCommands: [
        "rm -rf /",
        "sudo",
        "chmod",
        "chown",
        "kill",
        "pkill",
        "dd",
        "mkfs",
      ],
      maxExecTime: 30_000,
      networkAccess: false,
      allowedHosts: [],
      blockedHosts: [],
      maxFileSize: DEFAULT_MAX_FILE_SIZE,
      maxTotalWrites: 50,
      maxShellCalls: 20,
    });

    // ── T3: Build-Enabled ──
    tiers.set(3, {
      tier: 3,
      name: "Build-Enabled",
      description: "Full project access, all shell (except blocked), localhost + registry network.",
      fileRead: true,
      fileWrite: true,
      fileDelete: true,
      allowedWritePaths: ["**"],
      blockedWritePaths: [
        "**/node_modules/**",
        "**/.env*",
        "**/.git/**",
      ],
      shellExec: true,
      allowedCommands: ["*"],
      blockedCommands: [
        "sudo",
        "chmod 777",
        "rm -rf /",
        "dd",
        "mkfs",
        "curl",
        "wget",
      ],
      maxExecTime: 120_000,
      networkAccess: true,
      allowedHosts: [
        "localhost",
        "127.0.0.1",
        "registry.npmjs.org",
        "registry.yarnpkg.com",
      ],
      blockedHosts: [],
      maxFileSize: DEFAULT_MAX_FILE_SIZE,
      maxTotalWrites: 200,
      maxShellCalls: 50,
    });

    // ── T4: Full-Network ──
    tiers.set(4, {
      tier: 4,
      name: "Full-Network",
      description: "Full access with external network. Cloud metadata endpoints blocked.",
      fileRead: true,
      fileWrite: true,
      fileDelete: true,
      allowedWritePaths: ["**"],
      blockedWritePaths: [
        "**/node_modules/**",
        "**/.env*",
        "**/.git/**",
      ],
      shellExec: true,
      allowedCommands: ["*"],
      blockedCommands: ["sudo", "rm -rf /", "dd", "mkfs"],
      maxExecTime: 300_000,
      networkAccess: true,
      allowedHosts: ["*"],
      blockedHosts: [
        "169.254.169.254",
        "metadata.google.internal",
      ],
      maxFileSize: DEFAULT_MAX_FILE_SIZE,
      maxTotalWrites: 500,
      maxShellCalls: 100,
    });

    return tiers;
  }

  /**
   * Check if a relative path matches any of the given glob patterns.
   * Uses a simplified glob matcher (supports `**`, `*`, and `?`).
   *
   * @param relativePath - Path relative to the project root
   * @param patterns - Glob patterns to match against
   * @returns true if the path matches any pattern
   */
  private matchesPattern(relativePath: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      if (this.globMatch(relativePath, pattern)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Simple glob matcher supporting `**` (any path segments), `*` (any chars
   * within a segment), and `?` (single char).
   *
   * @param str - String to test
   * @param pattern - Glob pattern
   * @returns true if the string matches the pattern
   */
  private globMatch(str: string, pattern: string): boolean {
    // Convert glob to regex
    let regexStr = "^";
    let i = 0;

    while (i < pattern.length) {
      const char = pattern[i];

      if (char === "*" && pattern[i + 1] === "*") {
        // `**` — match any path segments (including none)
        regexStr += ".*";
        i += 2;
        // Skip trailing slash after **
        if (pattern[i] === "/") {
          i++;
        }
      } else if (char === "*") {
        // `*` — match any chars except `/`
        regexStr += "[^/]*";
        i++;
      } else if (char === "?") {
        regexStr += "[^/]";
        i++;
      } else if (".+()[]{}^$|\\".includes(char)) {
        regexStr += "\\" + char;
        i++;
      } else {
        regexStr += char;
        i++;
      }
    }

    regexStr += "$";

    try {
      return new RegExp(regexStr).test(str);
    } catch {
      return false;
    }
  }

  /**
   * Normalize and resolve a file path to an absolute path.
   *
   * @param filePath - The file path to normalize
   * @returns Absolute resolved path
   */
  private normalizePath(filePath: string): string {
    const resolved = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(this.config.projectPath, filePath);

    // Defense against symlink traversal: use realpath-equivalent check.
    // path.resolve normalizes ".." but cannot detect symlinks at this layer.
    // The actual symlink resolution must happen at the filesystem layer (tools).
    // Here we ensure the resolved path does not escape via ".." normalization.
    const normalizedProject = path.resolve(this.config.projectPath);
    if (!resolved.startsWith(normalizedProject + path.sep) && resolved !== normalizedProject) {
      // Return a path that will definitely fail startsWith checks
      return resolved;
    }
    return resolved;
  }

  /**
   * Convert an absolute path to a project-relative path.
   *
   * @param absolutePath - Absolute file path
   * @returns Path relative to the project root
   */
  private toRelative(absolutePath: string): string {
    return path.relative(this.config.projectPath, absolutePath);
  }

  /**
   * Record a sandbox violation and emit the appropriate event.
   *
   * @param action - What action was attempted
   * @param resource - The resource involved
   * @param rule - Which rule was violated
   * @param blocked - Whether the action was blocked
   */
  private recordViolation(
    action: string,
    resource: string,
    rule: string,
    blocked: boolean,
  ): void {
    const violation: SandboxViolation = {
      tier: this.state.currentTier,
      action,
      resource,
      rule,
      timestamp: Date.now(),
      blocked,
    };

    // Cap violations array to prevent unbounded memory growth
    if (this.state.violations.length >= MAX_VIOLATIONS) {
      // Keep the last half + new entry (preserve recent violations)
      this.state.violations = this.state.violations.slice(-Math.floor(MAX_VIOLATIONS / 2));
    }
    this.state.violations.push(violation);

    if (blocked) {
      this.emit("violation:blocked", violation);
    } else {
      this.emit("violation:warned", violation);
    }
  }

  /**
   * Extract the base command name from a full command string.
   *
   * @param command - Full command string (e.g. "pnpm install lodash")
   * @returns The first token / executable name (e.g. "pnpm")
   */
  private extractCommand(command: string): string {
    const trimmed = command.trim();
    // Handle env vars prefix (e.g. "NODE_ENV=prod tsc")
    const parts = trimmed.split(/\s+/);
    for (const part of parts) {
      if (!part.includes("=")) {
        // Strip path prefix (e.g. "/usr/bin/node" → "node")
        return path.basename(part);
      }
    }
    return parts[0] ?? "";
  }

  /**
   * Check if a command is a build-related command.
   *
   * @param command - The extracted command name
   * @returns true if it's a build command
   */
  private isBuildCommand(command: string): boolean {
    return BUILD_COMMANDS.has(command);
  }

  /**
   * Check if a command is a network-related command.
   *
   * @param command - The extracted command name
   * @returns true if it requires network access
   */
  private isNetworkCommand(command: string): boolean {
    return NETWORK_COMMANDS.has(command);
  }
}
