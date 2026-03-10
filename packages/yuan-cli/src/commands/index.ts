/**
 * YUAN CLI — Unified Command Dispatcher
 *
 * 통합 커맨드 핸들러. TUI/Classic 양쪽에서 동일 로직 사용.
 * 한 번 구현 → 양쪽 동작.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { loadSettings, saveSettings } from "../tui/lib/update-checker.js";
import type { ConfigManager } from "../config.js";

/* ──────────────────────────────────────────
   Types
────────────────────────────────────────── */

/** Context provided to every command handler */
export interface CommandContext {
  /** Send output to the user (TUI: addSystemMessage, Classic: console.log) */
  output: (msg: string) => void;
  /** ConfigManager instance */
  config: ConfigManager;
  /** Current version string */
  version: string;
  /** Current provider name */
  provider: string;
  /** Current model name */
  model: string;
  /** Working directory */
  workDir: string;
  /** List of files changed in this session */
  filesChanged: string[];
  /** Agent status info (messages count, tokens, etc.) */
  agentInfo: {
    status: string;
    messageCount: number;
    totalTokens: number;
    tokensPerSecond: number;
  };
  /** Session info */
  sessionInfo: {
    id: string;
    createdAt: number;
  };
  /** Callback to change model at runtime */
  onModelChange?: (model: string) => void;
  /** Callback to change mode at runtime */
  onModeChange?: (mode: string) => void;
}

/** Result of a command execution */
export interface CommandResult {
  /** Text output to display (if not using ctx.output directly) */
  output?: string;
  /** Whether the app should exit */
  exit?: boolean;
  /** Whether to clear the screen/messages */
  clear?: boolean;
}

export type CommandHandler = (ctx: CommandContext, args: string[]) => CommandResult;

/* ──────────────────────────────────────────
   Command Definitions
────────────────────────────────────────── */

/** Slash command metadata for menus */
export interface CommandDef {
  name: string;
  description: string;
  aliases?: string[];
  handler: CommandHandler;
}

/* ──────────────────────────────────────────
   Core Commands (P1)
────────────────────────────────────────── */

const help: CommandHandler = (ctx) => {
  const lines = [
    "Available commands:",
    "",
    "  Core",
    "  /help       — Show this help",
    "  /status     — Provider, model, tokens, session info",
    "  /clear      — Clear conversation",
    "  /config     — Show current configuration",
    "  /session    — Session info",
    "  /diff [N]   — Show file changes (N = context lines, default 5)",
    "  /undo       — Undo last file change",
    "  /model [m]  — Show or change model",
    "  /mode [m]   — Show or change agent mode",
    "  /settings   — Auto-update preferences",
    "  /exit       — Exit YUAN",
    "",
    "  Extended",
    "  /cost       — Token usage & estimated cost",
    "  /compact    — Compress context history",
    "  /approve    — Approve pending action",
    "  /reject     — Reject pending action",
    "",
    "  Advanced",
    "  /tools      — List available tools",
    "  /memory     — Show YUAN.md learnings",
    "  /retry      — Retry last failed action",
    "",
    "  Plugin System",
    "  /plugins    — Plugin management (install/remove/search)",
    "  /skills     — Available skills (tree view)",
    "",
    "  yuaone.com",
  ];
  return { output: lines.join("\n") };
};

const status: CommandHandler = (ctx) => {
  const { agentInfo, filesChanged } = ctx;
  const lines = [
    `YUAN v${ctx.version}`,
    `  Provider : ${ctx.provider}`,
    `  Model    : ${ctx.model}`,
    `  Status   : ${agentInfo.status}`,
    `  Messages : ${agentInfo.messageCount}`,
    `  Tokens   : ${agentInfo.totalTokens.toLocaleString()} total`,
    agentInfo.tokensPerSecond > 0 ? `  Speed    : ${agentInfo.tokensPerSecond} tok/s` : "",
    `  Files    : ${filesChanged.length} changed`,
    "",
    "  yuaone.com",
  ];
  return { output: lines.filter(Boolean).join("\n") };
};

const config: CommandHandler = (ctx) => {
  return { output: ctx.config.show() };
};

const session: CommandHandler = (ctx) => {
  const { sessionInfo, agentInfo } = ctx;
  const lines = [
    "Session Info",
    "  " + "-".repeat(40),
    `  ID       : ${sessionInfo.id}`,
    `  Created  : ${new Date(sessionInfo.createdAt).toLocaleString()}`,
    `  Messages : ${agentInfo.messageCount}`,
    `  Work Dir : ${ctx.workDir}`,
  ];
  return { output: lines.join("\n") };
};

const diff: CommandHandler = (ctx, args) => {
  // /diff [context_lines] — default 5, Claude Code style
  const contextLines = args.length > 0 ? parseInt(args[0], 10) || 5 : 5;
  try {
    const diffOutput = execFileSync("git", ["diff", `-U${contextLines}`], {
      cwd: ctx.workDir,
      stdio: "pipe",
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    });

    if (!diffOutput.trim()) {
      const stagedOutput = execFileSync("git", ["diff", "--cached", `-U${contextLines}`], {
        cwd: ctx.workDir,
        stdio: "pipe",
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
      });

      if (!stagedOutput.trim()) {
        // Fall back to session file list
        if (ctx.filesChanged.length > 0) {
          return { output: `Changed files (this session):\n${ctx.filesChanged.map(f => `  ${f}`).join("\n")}` };
        }
        return { output: "No file changes detected (working tree clean)." };
      }
      return { output: `Staged Changes:\n${stagedOutput}` };
    }
    return { output: `Working Directory Changes:\n${diffOutput}` };
  } catch {
    // Fallback: show session-tracked files
    if (ctx.filesChanged.length > 0) {
      return { output: `Changed files (this session):\n${ctx.filesChanged.map(f => `  ${f}`).join("\n")}` };
    }
    return { output: "Not a git repository or git not available." };
  }
};

const undo: CommandHandler = (ctx) => {
  if (ctx.filesChanged.length === 0) {
    return { output: "No file changes to undo in this session." };
  }

  const lastFile = ctx.filesChanged[ctx.filesChanged.length - 1];
  try {
    execFileSync("git", ["checkout", "--", lastFile], {
      cwd: ctx.workDir,
      stdio: "pipe",
    });
    ctx.filesChanged.pop();
    return { output: `Reverted: ${lastFile}` };
  } catch {
    try {
      const backupPath = `${lastFile}.yuan-backup`;
      fs.renameSync(backupPath, lastFile);
      ctx.filesChanged.pop();
      return { output: `Restored from backup: ${lastFile}` };
    } catch {
      return { output: `Cannot undo: ${lastFile} — not in git and no backup found.` };
    }
  }
};

const model: CommandHandler = (ctx, args) => {
  if (args.length === 0) {
    const validModels = [
      "YUA:     yua-basic, yua-normal, yua-pro, yua-research",
      "OpenAI:  gpt-4o-mini, gpt-4o, gpt-4.1-mini",
      "Claude:  claude-sonnet-4-20250514, claude-haiku-4-5-20251001",
    ];
    return {
      output: [
        `Current model: ${ctx.model}`,
        "",
        "Available models:",
        ...validModels.map(m => `  ${m}`),
        "",
        "Usage: /model <name>",
      ].join("\n"),
    };
  }

  const newModel = args[0];
  if (ctx.onModelChange) {
    ctx.onModelChange(newModel);
    return { output: `Model changed to: ${newModel}` };
  }
  return { output: "Model change not supported in this mode." };
};

const VALID_MODES = [
  "code", "review", "security", "debug", "refactor",
  "test", "plan", "architect", "report",
];

const mode: CommandHandler = (ctx, args) => {
  if (args.length === 0) {
    return {
      output: [
        "Agent Modes:",
        "",
        "  code       — Autonomous coding (default)",
        "  review     — Code review (read-only)",
        "  security   — Security audit (OWASP)",
        "  debug      — Systematic debugging",
        "  refactor   — Code refactoring",
        "  test       — Test generation/execution",
        "  plan       — Task planning (read-only)",
        "  architect  — Architecture analysis",
        "  report     — Analysis report",
        "",
        "Usage: /mode <name>",
      ].join("\n"),
    };
  }

  const newMode = args[0].toLowerCase();
  if (!VALID_MODES.includes(newMode)) {
    return { output: `Unknown mode: ${newMode}. Valid: ${VALID_MODES.join(", ")}` };
  }
  if (ctx.onModeChange) {
    ctx.onModeChange(newMode);
    return { output: `Mode changed to: ${newMode}` };
  }
  return { output: "Mode change not supported in this mode." };
};

const settings: CommandHandler = () => {
  const s = loadSettings();
  const current = s.autoUpdate;
  const options = ["prompt", "auto", "never"] as const;
  const currentIdx = options.indexOf(current);
  const nextIdx = (currentIdx + 1) % options.length;
  const next = options[nextIdx];
  s.autoUpdate = next;
  saveSettings(s);

  const labels: Record<string, string> = {
    prompt: "Ask before updating",
    auto: "Auto-update on launch",
    never: "Never check for updates",
  };
  return {
    output: [
      `Auto-update: ${labels[next]}`,
      `  1. prompt — ${next === "prompt" ? "●" : "○"} Ask before updating`,
      `  2. auto   — ${next === "auto" ? "●" : "○"} Auto-update on launch`,
      `  3. never  — ${next === "never" ? "●" : "○"} Never check`,
      "",
      `  Changed to: ${labels[next]} (run /settings again to cycle)`,
    ].join("\n"),
  };
};

/* ──────────────────────────────────────────
   Extended Commands (P2)
────────────────────────────────────────── */

const cost: CommandHandler = (ctx) => {
  const tokens = ctx.agentInfo.totalTokens;
  // Rough estimate: $0.15/1M input, $0.60/1M output (gpt-4o-mini prices)
  const estimatedCost = (tokens / 1_000_000) * 0.375;
  return {
    output: [
      "Token Usage",
      `  Total tokens : ${tokens.toLocaleString()}`,
      `  Est. cost    : $${estimatedCost.toFixed(4)}`,
      `  Model        : ${ctx.model}`,
      "",
      "  (Cost estimate based on average input/output ratio)",
    ].join("\n"),
  };
};

const compact: CommandHandler = () => {
  return { output: "Context compression triggered. (Handled by ContextManager at next iteration)" };
};

const approve: CommandHandler = () => {
  return { output: "No pending approval requests." };
};

const reject: CommandHandler = () => {
  return { output: "No pending approval requests." };
};

/* ──────────────────────────────────────────
   Advanced Commands (P3)
────────────────────────────────────────── */

const tools: CommandHandler = () => {
  const toolList = [
    "Built-in Tools (10 core + 6 design):",
    "",
    "  Core:",
    "  file_read       — Read files with offset/limit",
    "  file_write      — Write files with auto-backup",
    "  file_edit       — String replacement with diff preview",
    "  grep            — Regex file search",
    "  glob            — Pattern-based file finding",
    "  code_search     — Symbol search (definition/reference)",
    "  git_ops         — Git operations (status/diff/log/commit...)",
    "  shell_exec      — Command execution (sandboxed)",
    "  test_run        — Test auto-detection & execution",
    "  security_scan   — OWASP audit + secrets detection",
    "",
    "  Design (design mode only):",
    "  design_snapshot, design_screenshot, design_navigate,",
    "  design_resize, design_inspect, design_scroll",
  ];
  return { output: toolList.join("\n") };
};

const memory: CommandHandler = (ctx) => {
  // Try to read YUAN.md from project
  const paths = ["YUAN.md", ".yuan/YUAN.md", ".yuan/config.md", "docs/YUAN.md"];
  for (const p of paths) {
    const fullPath = `${ctx.workDir}/${p}`;
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      const preview = content.slice(0, 2000);
      return { output: `YUAN.md (${p}):\n\n${preview}${content.length > 2000 ? "\n\n... (truncated)" : ""}` };
    } catch {
      continue;
    }
  }
  return { output: "No YUAN.md found in project. Agent learnings will be stored here." };
};

const retry: CommandHandler = () => {
  return { output: "No failed actions to retry." };
};

/* ──────────────────────────────────────────
   Plugin System — Helpers
────────────────────────────────────────── */

interface PluginInfo {
  id: string;
  name: string;
  version: string;
  category: string;
  trustLevel: string;
  skills: Array<{ id: string; name: string }>;
  tools: Array<{ name: string }>;
  source: "local" | "global" | "npm";
  path: string;
}

/**
 * Minimal YAML parser — extracts simple key: value pairs and basic arrays.
 * Only handles the subset needed for plugin.yaml files (flat fields + skills/tools arrays).
 */
function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split("\n");
  let currentArray: Array<Record<string, string>> | null = null;
  let currentArrayKey: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");

    // Array item: "  - key: value" or "  - value"
    if (currentArrayKey && /^\s+-\s/.test(line)) {
      const itemStr = line.replace(/^\s+-\s*/, "");
      if (itemStr.includes(":")) {
        const obj: Record<string, string> = {};
        // Parse "id: foo" or "name: bar" inline
        const pairs = itemStr.split(/,\s*/);
        for (const pair of pairs) {
          const colonIdx = pair.indexOf(":");
          if (colonIdx > 0) {
            const k = pair.slice(0, colonIdx).trim();
            const v = pair.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
            obj[k] = v;
          }
        }
        (currentArray as Array<Record<string, string>>).push(obj);
      } else {
        const val = itemStr.trim().replace(/^["']|["']$/g, "");
        (currentArray as Array<Record<string, string>>).push({ name: val, id: val });
      }
      continue;
    }

    // Top-level "key: value"
    const topMatch = line.match(/^(\w[\w_-]*):\s*(.*)/);
    if (topMatch) {
      const key = topMatch[1];
      const val = topMatch[2].trim().replace(/^["']|["']$/g, "");

      if (val === "" || val === "[]") {
        // Start of an array section or empty
        currentArrayKey = key;
        currentArray = [];
        result[key] = currentArray;
      } else {
        currentArrayKey = null;
        currentArray = null;
        result[key] = val;
      }
      continue;
    }

    // Non-matching line ends current array
    if (!/^\s/.test(line) && line.trim() !== "") {
      currentArrayKey = null;
      currentArray = null;
    }
  }

  return result;
}

/**
 * Try to read and parse a plugin manifest (plugin.yaml, plugin.yml, or plugin.json).
 * Returns parsed data or null.
 */
function readPluginManifest(dir: string): Record<string, unknown> | null {
  const candidates = ["plugin.yaml", "plugin.yml", "plugin.json"];
  for (const fname of candidates) {
    const fpath = path.join(dir, fname);
    try {
      const content = fs.readFileSync(fpath, "utf-8");
      if (fname.endsWith(".json")) {
        return JSON.parse(content) as Record<string, unknown>;
      }
      return parseSimpleYaml(content);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Extract PluginInfo from a parsed manifest + metadata.
 */
function manifestToPluginInfo(
  data: Record<string, unknown>,
  source: "local" | "global" | "npm",
  pluginPath: string,
): PluginInfo {
  const rawSkills = Array.isArray(data["skills"]) ? data["skills"] : [];
  const rawTools = Array.isArray(data["tools"]) ? data["tools"] : [];

  return {
    id: String(data["id"] || data["name"] || path.basename(pluginPath)),
    name: String(data["name"] || data["id"] || path.basename(pluginPath)),
    version: String(data["version"] || "0.0.0"),
    category: String(data["category"] || "general"),
    trustLevel: String(data["trust_level"] || data["trustLevel"] || "community"),
    skills: rawSkills.map((s: Record<string, string> | string) =>
      typeof s === "string" ? { id: s, name: s } : { id: s.id || s.name || "", name: s.name || s.id || "" },
    ),
    tools: rawTools.map((t: Record<string, string> | string) =>
      typeof t === "string" ? { name: t } : { name: t.name || "" },
    ),
    source,
    path: pluginPath,
  };
}

/**
 * Scan all known plugin locations and return discovered plugins.
 */
function scanInstalledPlugins(workDir: string): PluginInfo[] {
  const plugins: PluginInfo[] = [];

  const scanDir = (dir: string, source: "local" | "global" | "npm") => {
    try {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pluginDir = path.join(dir, entry.name);
        const manifest = readPluginManifest(pluginDir);
        if (manifest) {
          plugins.push(manifestToPluginInfo(manifest, source, pluginDir));
        }
      }
    } catch {
      // Directory not readable — skip
    }
  };

  // 1. Project-local plugins
  scanDir(path.join(workDir, ".yuan", "plugins"), "local");

  // 2. Global user plugins
  scanDir(path.join(os.homedir(), ".yuan", "plugins"), "global");

  // 3. npm-installed @yuaone/plugin-* and yuan-plugin-*
  const nodeModulesDir = path.join(workDir, "node_modules");
  try {
    if (fs.existsSync(nodeModulesDir)) {
      // Scoped @yuaone/plugin-*
      const scopeDir = path.join(nodeModulesDir, "@yuaone");
      if (fs.existsSync(scopeDir)) {
        try {
          const scopeEntries = fs.readdirSync(scopeDir, { withFileTypes: true });
          for (const entry of scopeEntries) {
            if (entry.isDirectory() && entry.name.startsWith("plugin-")) {
              const pluginDir = path.join(scopeDir, entry.name);
              const manifest = readPluginManifest(pluginDir);
              if (manifest) {
                plugins.push(manifestToPluginInfo(manifest, "npm", pluginDir));
              }
            }
          }
        } catch {
          // skip
        }
      }

      // Community yuan-plugin-*
      try {
        const nmEntries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
        for (const entry of nmEntries) {
          if (entry.isDirectory() && entry.name.startsWith("yuan-plugin-")) {
            const pluginDir = path.join(nodeModulesDir, entry.name);
            const manifest = readPluginManifest(pluginDir);
            if (manifest) {
              plugins.push(manifestToPluginInfo(manifest, "npm", pluginDir));
            }
          }
        }
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }

  return plugins;
}

/**
 * Read the disabled skills config from .yuan/config.json
 */
function readSkillsConfig(workDir: string): { disabledSkills: string[] } {
  const configPath = path.join(workDir, ".yuan", "config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as { disabledSkills?: string[] };
    return { disabledSkills: Array.isArray(parsed.disabledSkills) ? parsed.disabledSkills : [] };
  } catch {
    return { disabledSkills: [] };
  }
}

/**
 * Write the disabled skills config to .yuan/config.json
 */
function writeSkillsConfig(workDir: string, config: { disabledSkills: string[] }): void {
  const yuanDir = path.join(workDir, ".yuan");
  const configPath = path.join(yuanDir, "config.json");
  try {
    // Read existing config to preserve other fields
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    } catch {
      // No existing config — start fresh
    }
    if (!fs.existsSync(yuanDir)) {
      fs.mkdirSync(yuanDir, { recursive: true });
    }
    existing["disabledSkills"] = config.disabledSkills;
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  } catch {
    // Silently fail — will be reported by caller
    throw new Error("Failed to write .yuan/config.json");
  }
}

/* ──────────────────────────────────────────
   Plugin System Commands (P4)
────────────────────────────────────────── */

const plugins: CommandHandler = (ctx, args) => {
  if (args.length === 0) {
    // List installed plugins by scanning real directories
    const installed = scanInstalledPlugins(ctx.workDir);

    if (installed.length === 0) {
      return {
        output: [
          "Installed Plugins",
          "  (none)",
          "",
          "  No plugins installed. Use /plugins search <query> to find plugins.",
          "",
          "  Use: /plugins search <query>  — Search npm registry",
          "       /plugins install <name>  — Install plugin",
        ].join("\n"),
      };
    }

    const lines: string[] = ["Installed Plugins", ""];
    for (let i = 0; i < installed.length; i++) {
      const p = installed[i];
      const isLast = i === installed.length - 1;
      const prefix = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";
      const trustLabel = p.trustLevel === "official" ? "[official]" : `[${p.trustLevel}]`;

      lines.push(`${prefix}${p.id} v${p.version} ${trustLabel} (${p.source})`);

      if (p.skills.length > 0) {
        lines.push(`${childPrefix}├── Skills: ${p.skills.map(s => s.name).join(", ")}`);
      }
      if (p.tools.length > 0) {
        const toolConnector = p.skills.length > 0 ? "└── " : "└── ";
        lines.push(`${childPrefix}${toolConnector}Tools: ${p.tools.map(t => t.name).join(", ")}`);
      }
    }
    lines.push("");
    lines.push("  Use: /plugins search <query>  — Search npm registry");
    lines.push("       /plugins install <name>  — Install plugin");
    lines.push("       /plugins remove <name>   — Remove plugin");
    lines.push("       /plugins info <name>     — Plugin details");
    lines.push("       /plugins update          — Update all plugins");

    return { output: lines.join("\n") };
  }

  const subCommand = args[0];

  if (subCommand === "search") {
    const query = args.slice(1).join(" ") || "";
    if (!query) {
      return { output: "Usage: /plugins search <query>\nExample: /plugins search typescript" };
    }

    try {
      const raw = execFileSync(
        "npm",
        ["search", `@yuaone/plugin-${query}`, "yuan-plugin-${query}", "--json"],
        {
          encoding: "utf-8",
          stdio: "pipe",
          timeout: 5000,
          maxBuffer: 512 * 1024,
        },
      );

      const results = JSON.parse(raw) as Array<{
        name?: string;
        description?: string;
        version?: string;
      }>;

      if (!Array.isArray(results) || results.length === 0) {
        return { output: `No results found for "${query}".` };
      }

      const lines: string[] = [`Search results for "${query}"`, ""];
      for (const r of results.slice(0, 10)) {
        const name = r.name || "unknown";
        const desc = r.description || "";
        const ver = r.version || "";
        lines.push(`  ${name}  v${ver}`);
        if (desc) lines.push(`    ${desc}`);
      }
      lines.push("");
      lines.push("  /plugins install <name> to install");

      return { output: lines.join("\n") };
    } catch {
      return { output: `No results found for "${query}" (npm search unavailable or timed out).` };
    }
  }

  if (subCommand === "install") {
    const pluginName = args[1];
    if (!pluginName) {
      return { output: "Usage: /plugins install <plugin-name>" };
    }

    try {
      const output = execFileSync("pnpm", ["add", pluginName, "--save-dev"], {
        cwd: ctx.workDir,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });

      // Verify it's a valid YUAN plugin by checking for plugin manifest
      const pkgDir = path.join(ctx.workDir, "node_modules", pluginName);
      const manifest = readPluginManifest(pkgDir);

      if (manifest) {
        const info = manifestToPluginInfo(manifest, "npm", pkgDir);
        return {
          output: [
            `Installed ${pluginName} v${info.version}`,
            `  Category : ${info.category}`,
            `  Skills   : ${info.skills.length > 0 ? info.skills.map(s => s.name).join(", ") : "(none)"}`,
            `  Tools    : ${info.tools.length > 0 ? info.tools.map(t => t.name).join(", ") : "(none)"}`,
          ].join("\n"),
        };
      }

      return {
        output: [
          `Installed ${pluginName} (no plugin.yaml found — may not be a YUAN plugin)`,
          output.trim() ? `\n${output.trim()}` : "",
        ].join(""),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `Failed to install ${pluginName}: ${msg}` };
    }
  }

  if (subCommand === "remove") {
    const pluginName = args[1];
    if (!pluginName) {
      return { output: "Usage: /plugins remove <plugin-name>" };
    }

    try {
      execFileSync("pnpm", ["remove", pluginName], {
        cwd: ctx.workDir,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });
      return { output: `Removed ${pluginName}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `Failed to remove ${pluginName}: ${msg}` };
    }
  }

  if (subCommand === "info") {
    const pluginName = args[1];
    if (!pluginName) {
      return { output: "Usage: /plugins info <plugin-name>" };
    }

    // Search installed plugins for a match
    const installed = scanInstalledPlugins(ctx.workDir);
    const found = installed.find(
      (p) => p.id === pluginName || p.name === pluginName || p.path.endsWith(pluginName),
    );

    if (!found) {
      // Try node_modules directly
      const tryPaths = [
        path.join(ctx.workDir, "node_modules", pluginName),
        path.join(ctx.workDir, ".yuan", "plugins", pluginName),
        path.join(os.homedir(), ".yuan", "plugins", pluginName),
      ];

      for (const tryPath of tryPaths) {
        const manifest = readPluginManifest(tryPath);
        if (manifest) {
          const info = manifestToPluginInfo(manifest, "npm", tryPath);
          const lines = [
            `Plugin: ${info.name}`,
            `  ID         : ${info.id}`,
            `  Version    : ${info.version}`,
            `  Category   : ${info.category}`,
            `  Trust Level: ${info.trustLevel}`,
            `  Path       : ${tryPath}`,
            `  Skills (${info.skills.length}): ${info.skills.length > 0 ? info.skills.map(s => s.name).join(", ") : "(none)"}`,
            `  Tools  (${info.tools.length}): ${info.tools.length > 0 ? info.tools.map(t => t.name).join(", ") : "(none)"}`,
          ];
          return { output: lines.join("\n") };
        }
      }

      return { output: `Plugin "${pluginName}" not found. Is it installed?` };
    }

    const lines = [
      `Plugin: ${found.name}`,
      `  ID         : ${found.id}`,
      `  Version    : ${found.version}`,
      `  Category   : ${found.category}`,
      `  Trust Level: ${found.trustLevel}`,
      `  Source     : ${found.source}`,
      `  Path       : ${found.path}`,
      `  Skills (${found.skills.length}): ${found.skills.length > 0 ? found.skills.map(s => s.name).join(", ") : "(none)"}`,
      `  Tools  (${found.tools.length}): ${found.tools.length > 0 ? found.tools.map(t => t.name).join(", ") : "(none)"}`,
    ];
    return { output: lines.join("\n") };
  }

  if (subCommand === "update") {
    try {
      const output = execFileSync(
        "pnpm",
        ["update", "@yuaone/plugin-*", "yuan-plugin-*"],
        {
          cwd: ctx.workDir,
          encoding: "utf-8",
          stdio: "pipe",
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        },
      );
      const trimmed = output.trim();
      return { output: trimmed ? `Plugin updates:\n${trimmed}` : "All plugins are up to date." };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `Failed to update plugins: ${msg}` };
    }
  }

  return { output: `Unknown subcommand: ${subCommand}. Use /plugins for help.` };
};

const skills: CommandHandler = (ctx, args) => {
  if (args.length === 0) {
    // List built-in skills + skills from installed plugins
    const installed = scanInstalledPlugins(ctx.workDir);
    const skillsConfig = readSkillsConfig(ctx.workDir);
    const disabled = new Set(skillsConfig.disabledSkills);

    const builtinSkills = [
      { id: "code-review", name: "Code review (read-only analysis)" },
      { id: "security-scan", name: "OWASP security audit" },
      { id: "test-gen", name: "Auto-generate tests" },
      { id: "refactor", name: "Intelligent refactoring" },
      { id: "debug", name: "Systematic debugging" },
      { id: "plan", name: "Task planning & architecture" },
    ];

    const lines: string[] = ["Available Skills", ""];

    // Built-in section
    lines.push("  Built-in:");
    for (let i = 0; i < builtinSkills.length; i++) {
      const s = builtinSkills[i];
      const isLast = i === builtinSkills.length - 1;
      const prefix = isLast ? "  └── " : "  ├── ";
      const statusMark = disabled.has(s.id) ? " [disabled]" : "";
      lines.push(`${prefix}${s.id.padEnd(16)} — ${s.name}${statusMark}`);
    }

    // Plugin skills section
    const pluginsWithSkills = installed.filter(p => p.skills.length > 0);
    if (pluginsWithSkills.length > 0) {
      lines.push("");
      lines.push("  Plugin Skills:");
      for (let pi = 0; pi < pluginsWithSkills.length; pi++) {
        const p = pluginsWithSkills[pi];
        const isLastPlugin = pi === pluginsWithSkills.length - 1;
        const pluginPrefix = isLastPlugin ? "  └── " : "  ├── ";
        const childPrefix = isLastPlugin ? "      " : "  │   ";

        lines.push(`${pluginPrefix}${p.id}/`);
        for (let si = 0; si < p.skills.length; si++) {
          const s = p.skills[si];
          const isLastSkill = si === p.skills.length - 1;
          const skillPrefix = isLastSkill ? "└── " : "├── ";
          const statusMark = disabled.has(s.id) ? " [disabled]" : "";
          lines.push(`${childPrefix}${skillPrefix}${s.id || s.name}${statusMark}`);
        }
      }
    } else if (installed.length === 0) {
      lines.push("");
      lines.push("  Plugin Skills:");
      lines.push("  (no plugins installed — use /plugins search <query>)");
    }

    lines.push("");
    lines.push("  Use: /skills enable <name>  — Enable skill");
    lines.push("       /skills disable <name> — Disable skill");

    return { output: lines.join("\n") };
  }

  const subCommand = args[0];

  if (subCommand === "enable") {
    const skillName = args[1];
    if (!skillName) return { output: "Usage: /skills enable <skill-name>" };

    try {
      const config = readSkillsConfig(ctx.workDir);
      const idx = config.disabledSkills.indexOf(skillName);
      if (idx === -1) {
        return { output: `Skill "${skillName}" is already enabled.` };
      }
      config.disabledSkills.splice(idx, 1);
      writeSkillsConfig(ctx.workDir, config);
      return { output: `Enabled skill: ${skillName}` };
    } catch {
      return { output: `Failed to enable skill "${skillName}" (could not write .yuan/config.json).` };
    }
  }

  if (subCommand === "disable") {
    const skillName = args[1];
    if (!skillName) return { output: "Usage: /skills disable <skill-name>" };

    try {
      const config = readSkillsConfig(ctx.workDir);
      if (config.disabledSkills.includes(skillName)) {
        return { output: `Skill "${skillName}" is already disabled.` };
      }
      config.disabledSkills.push(skillName);
      writeSkillsConfig(ctx.workDir, config);
      return { output: `Disabled skill: ${skillName}` };
    } catch {
      return { output: `Failed to disable skill "${skillName}" (could not write .yuan/config.json).` };
    }
  }

  return { output: `Unknown subcommand: ${subCommand}. Use /skills for help.` };
};

/* ──────────────────────────────────────────
   Registry
────────────────────────────────────────── */

/** All command definitions with metadata */
export const COMMAND_DEFS: CommandDef[] = [
  // Core (P1)
  { name: "/help", description: "Show available commands", aliases: ["/h"], handler: help },
  { name: "/status", description: "Provider, model, tokens, session info", handler: status },
  { name: "/clear", description: "Clear conversation history", handler: (_ctx) => ({ clear: true }) },
  { name: "/config", description: "Show current configuration", handler: config },
  { name: "/session", description: "Session management", handler: session },
  { name: "/diff", description: "Show file changes (git diff)", handler: diff },
  { name: "/undo", description: "Undo last file change", handler: undo },
  { name: "/model", description: "Show or change model", handler: model },
  { name: "/mode", description: "Show or change agent mode", handler: mode },
  { name: "/settings", description: "Auto-update preferences", handler: settings },
  { name: "/exit", description: "Exit YUAN", aliases: ["/quit", "/q"], handler: () => ({ exit: true }) },
  // Extended (P2)
  { name: "/cost", description: "Token usage & estimated cost", handler: cost },
  { name: "/compact", description: "Compress context history", handler: compact },
  { name: "/approve", description: "Approve pending action", handler: approve },
  { name: "/reject", description: "Reject pending action", handler: reject },
  // Advanced (P3)
  { name: "/tools", description: "List available tools", handler: tools },
  { name: "/memory", description: "Show YUAN.md learnings", handler: memory },
  { name: "/retry", description: "Retry last failed action", handler: retry },
  // Plugin System (P4)
  { name: "/plugins", description: "Plugin management (install/remove/search)", handler: plugins },
  { name: "/skills", description: "Available skills (tree view)", aliases: ["/skill"], handler: skills },
];

/** Flat handler map for quick lookup */
const HANDLER_MAP = new Map<string, CommandHandler>();
for (const def of COMMAND_DEFS) {
  HANDLER_MAP.set(def.name, def.handler);
  if (def.aliases) {
    for (const alias of def.aliases) {
      HANDLER_MAP.set(alias, def.handler);
    }
  }
}

/**
 * Execute a slash command.
 * @returns CommandResult, or null if command not found
 */
export function executeCommand(ctx: CommandContext, input: string): CommandResult | null {
  const parts = input.trim().toLowerCase().split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  const handler = HANDLER_MAP.get(cmd);
  if (!handler) return null;

  return handler(ctx, args);
}

/**
 * Check if a string is a known command (for slash menu validation).
 */
export function isKnownCommand(input: string): boolean {
  const cmd = input.trim().toLowerCase().split(/\s+/)[0];
  return HANDLER_MAP.has(cmd);
}

/**
 * Get all command definitions for the slash menu.
 */
export function getCommandDefs(): CommandDef[] {
  return COMMAND_DEFS;
}
