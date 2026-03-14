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
import { SKILL_TO_MODE } from "@yuaone/core";

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
  /** ConfigManager instance (optional — may be undefined in TUI mode) */
  configManager?: { show(): string; get(): Record<string, unknown> };
  /** Whether there's a pending approval waiting */
  hasPendingApproval: boolean;
  /** Approve the pending tool action */
  onApprove?: () => void;
  /** Reject the pending tool action */
  onReject?: () => void;
  /** Retry the last user message */
  onRetry?: () => void;
  /** Compact/compress context */
  onCompact?: () => string;
  /** Remove last changed file from tracking (for undo) */
  onRemoveLastChangedFile?: () => string | null;
  /** Set agent mode */
  onSetMode?: (mode: string) => void;
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
    "  /cost       — Show token usage and estimated cost breakdown",
    "  /compact    — Compress context to save tokens (use when context > 80%)",
    "  /approve    — Approve pending action",
    "  /reject     — Reject pending action",
    "",
    "  Advanced",
    "  /tools      — List available tools",
    "  /memory     — Show learned patterns from YUAN.md",
    "  /retry      — Retry last failed action",
    "  /tip        — Show a rotating usage tip",
    "  /mcp        — MCP server status and configuration",
    "  /qa         — QA governor config and status",
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
  if (ctx.configManager) {
    return { output: ctx.configManager.show() };
  }
  // Fallback: show what we know from ctx
  return {
    output: [
      "Current configuration:",
      `  provider: ${ctx.provider}`,
      `  model:    ${ctx.model}`,
      `  workDir:  ${ctx.workDir}`,
    ].join("\n"),
  };
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
    ctx.onRemoveLastChangedFile?.();
    return { output: `Reverted: ${lastFile}` };
  } catch {
    try {
      const backupPath = `${lastFile}.yuan-backup`;
      fs.renameSync(backupPath, lastFile);
      ctx.onRemoveLastChangedFile?.();
      return { output: `Restored from backup: ${lastFile}` };
    } catch {
      return { output: `Cannot undo: ${lastFile} — not in git and no backup found.` };
    }
  }
};

// ─── 2026 Model Catalog ───────────────────────────────────────────────
interface ModelEntry {
  id: string;
  label: string;
  ctx: string;  // context window
  note?: string;
}

const MODEL_CATALOG: Record<string, ModelEntry[]> = {
  openai: [
    // GPT-5 series (2025~2026) — gpt-5 confirmed Aug 2025, gpt-5.4 confirmed Mar 2026
    { id: "gpt-5.4",           label: "GPT-5.4",          ctx: "256K", note: "latest flagship (Mar 2026)" },
    { id: "gpt-5-mini",        label: "GPT-5 Mini",       ctx: "128K", note: "cost-optimized GPT-5" },
    { id: "gpt-5",             label: "GPT-5",            ctx: "128K", note: "base flagship (Aug 2025)" },
    // GPT-4.1 series (confirmed Apr 2025, 1M ctx)
    { id: "gpt-4.1",           label: "GPT-4.1",          ctx: "1M",   note: "coding+instruction" },
    { id: "gpt-4.1-mini",      label: "GPT-4.1 Mini",     ctx: "1M",   note: "fast+cheap" },
    { id: "gpt-4.1-nano",      label: "GPT-4.1 Nano",     ctx: "1M",   note: "fastest" },
    // GPT-4o series
    { id: "gpt-4o",            label: "GPT-4o",           ctx: "128K" },
    { id: "gpt-4o-mini",       label: "GPT-4o Mini",      ctx: "128K", note: "default" },
    // o-series reasoning (temperature/top_p unsupported — uses reasoning_effort)
    { id: "o3-pro",            label: "o3-pro",           ctx: "200K", note: "⚠ Responses API only" },
    { id: "o3",                label: "o3",               ctx: "200K", note: "reasoning" },
    { id: "o4-mini",           label: "o4-mini",          ctx: "200K", note: "reasoning fast" },
    { id: "o3-mini",           label: "o3-mini",          ctx: "200K", note: "reasoning, cheapest" },
  ],
  anthropic: [
    // Claude 4.6 series (2026-02 — current flagship)
    { id: "claude-opus-4-6",              label: "Claude Opus 4.6",     ctx: "1M",   note: "flagship, adaptive thinking" },
    { id: "claude-sonnet-4-6",            label: "Claude Sonnet 4.6",   ctx: "1M",   note: "recommended" },
    // Claude 4.5 series (2025-10/11)
    { id: "claude-opus-4-5",              label: "Claude Opus 4.5",     ctx: "1M",   note: "stable" },
    { id: "claude-haiku-4-5-20251001",    label: "Claude Haiku 4.5",    ctx: "200K", note: "fast, cheapest" },
    { id: "claude-sonnet-4-5-20250929",   label: "Claude Sonnet 4.5",   ctx: "200K" },
    // Claude 4.0 series (2025-05)
    { id: "claude-sonnet-4-20250514",     label: "Claude Sonnet 4",     ctx: "200K" },
    { id: "claude-opus-4-20250514",       label: "Claude Opus 4",       ctx: "200K" },
    // ⚠ claude-3-7-sonnet-20250219 → EOL Feb 19 2026, removed
  ],
  google: [
    // Gemini 3.x series (2026 — Preview only, -preview suffix required)
    { id: "gemini-3.1-pro-preview",       label: "Gemini 3.1 Pro",        ctx: "1M",  note: "Preview, thinkingLevel" },
    { id: "gemini-3.1-flash-lite-preview",label: "Gemini 3.1 Flash-Lite", ctx: "1M",  note: "Preview, minimal thinking" },
    { id: "gemini-3-flash-preview",       label: "Gemini 3 Flash",         ctx: "1M",  note: "Preview (Dec 2025)" },
    // Gemini 2.5 series (GA, stable — use these for production)
    { id: "gemini-2.5-pro",               label: "Gemini 2.5 Pro",         ctx: "1M",  note: "GA, stable" },
    { id: "gemini-2.5-flash",             label: "Gemini 2.5 Flash",       ctx: "1M",  note: "GA default" },
    { id: "gemini-2.5-flash-lite",        label: "Gemini 2.5 Flash-Lite",  ctx: "1M",  note: "cheapest" },
  ],
  yua: [
    { id: "yua-research",  label: "YUA Research",  ctx: "200K", note: "deep reasoning" },
    { id: "yua-pro",       label: "YUA Pro",        ctx: "200K", note: "flagship" },
    { id: "yua-normal",    label: "YUA Normal",     ctx: "128K", note: "default" },
    { id: "yua-basic",     label: "YUA Basic",      ctx: "32K",  note: "fast+cheap" },
  ],
};

/** Resolve env var key for a provider */
function getEnvKey(provider: string): string {
  const envMap: Record<string, string> = {
    openai: process.env["OPENAI_API_KEY"] ?? "",
    anthropic: process.env["ANTHROPIC_API_KEY"] ?? "",
    google: process.env["GOOGLE_API_KEY"] ?? process.env["GEMINI_API_KEY"] ?? "",
    yua: process.env["YUA_API_KEY"] ?? "",
  };
  return envMap[provider] ?? "";
}

const model: CommandHandler = (ctx, args) => {
  const configManager = ctx.configManager as unknown as {
    getKey?: (p: string) => string;
    getAvailableProviders?: () => string[];
    get?: () => { provider: string };
  } | undefined;

  // Build available provider info
  const activeProvider = configManager?.get?.()?.provider ?? ctx.provider;
  const getKey = (p: string): string => {
    const fromManager = configManager?.getKey?.(p as never);
    if (fromManager) return fromManager;
    return getEnvKey(p);
  };

  if (args.length === 0) {
    // Show full model table
    const lines: string[] = [
      `Current: ${ctx.model} (provider: ${activeProvider})`,
      "",
      "Available models by provider:",
      "",
    ];

    const PROVIDERS = ["openai", "anthropic", "google", "yua"] as const;
    for (const p of PROVIDERS) {
      const key = getKey(p);
      const hasKey = key.length > 0;
      const isActive = p === activeProvider;
      const keySource = configManager?.getKey?.(p) ? "config" : (getEnvKey(p) ? "env" : "");
      const badge = hasKey
        ? `✓ key:${keySource || "?"}`
        : "✗ no key";
      const activeMark = isActive ? " ◀ active" : "";

      lines.push(`  ┌─ ${p.toUpperCase()} [${badge}]${activeMark}`);

      const entries = MODEL_CATALOG[p] ?? [];
      entries.forEach((m, i) => {
        const isLast = i === entries.length - 1;
        const prefix = isLast ? "  └──" : "  ├──";
        const isCurrent = m.id === ctx.model;
        const noteStr = m.note ? ` (${m.note})` : "";
        const currentMark = isCurrent ? " ●" : "";
        const dimMark = !hasKey ? " [need key]" : "";
        lines.push(`${prefix} ${m.id.padEnd(40)} ${m.ctx}${noteStr}${currentMark}${dimMark}`);
      });
      lines.push("");
    }

    lines.push("Usage:");
    lines.push("  /model <model-id>                   — switch model (same provider)");
    lines.push("  /model <provider>/<model-id>        — switch provider + model");
    lines.push("  /model setkey <provider> <key>      — store API key for provider");
    lines.push("");
    lines.push("Env vars: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, YUA_API_KEY");

    return { output: lines.join("\n") };
  }

  // /model setkey <provider> <key>
  if (args[0] === "setkey" && args.length >= 3) {
    const p = args[1] as string;
    const k = args[2] as string;
    const validProviders = ["openai", "anthropic", "google", "yua"];
    if (!validProviders.includes(p)) {
      return { output: `Unknown provider: ${p}. Valid: ${validProviders.join(", ")}` };
    }
    if ((configManager as unknown as { setProviderKey?: (p: string, k: string) => void })?.setProviderKey) {
      (configManager as unknown as { setProviderKey: (p: string, k: string) => void }).setProviderKey(p, k);
      const masked = k.slice(0, 6) + "..." + k.slice(-4);
      return { output: `Saved ${p} key: ${masked}` };
    }
    return { output: "Key storage not available in this mode. Set env var instead." };
  }

  // /model <provider>/<model-id> or /model <model-id>
  const modelArg = args[0] ?? "";
  let newProvider: string | undefined;
  let newModel: string;

  if (modelArg.includes("/")) {
    const [pPart, ...mParts] = modelArg.split("/");
    newProvider = pPart;
    newModel = mParts.join("/");
  } else {
    newModel = modelArg;
  }

  // Validate model exists in catalog
  const targetProvider = newProvider ?? activeProvider;
  const catalogEntries = MODEL_CATALOG[targetProvider] ?? [];
  const found = catalogEntries.find((m) => m.id === newModel);

  if (!found && catalogEntries.length > 0) {
    // Warn but allow (user may use a new model we don't know about yet)
    if (ctx.onModelChange) {
      if (newProvider && newProvider !== activeProvider) {
        ctx.onModeChange?.(newProvider); // reuse onModeChange to signal provider change
      }
      ctx.onModelChange(newModel);
      return { output: `⚠ Model "${newModel}" not in 2026 catalog — using anyway.\nModel set to: ${newModel}` };
    }
  }

  if (ctx.onModelChange) {
    ctx.onModelChange(newModel);
    const noteStr = found?.note ? ` (${found.note})` : "";
    return { output: `Model → ${newModel}${noteStr}` };
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
    ctx.onSetMode?.(newMode);
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

const compact: CommandHandler = (ctx) => {
  if (ctx.onCompact) {
    const result = ctx.onCompact();
    return { output: result };
  }
  return { output: "Context compression will trigger automatically when context usage reaches 60%." };
};

const approve: CommandHandler = (ctx) => {
  if (!ctx.hasPendingApproval) {
    return { output: "No pending approval requests." };
  }
  ctx.onApprove?.();
  return { output: "Approved." };
};

const reject: CommandHandler = (ctx) => {
  if (!ctx.hasPendingApproval) {
    return { output: "No pending approval requests." };
  }
  ctx.onReject?.();
  return { output: "Rejected." };
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

const retry: CommandHandler = (ctx) => {
  if (ctx.onRetry) {
    ctx.onRetry();
    return { output: "Retrying last message..." };
  }
  return { output: "No message to retry." };
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
      const mappedMode = SKILL_TO_MODE[skillName];
      if (mappedMode) ctx.onModeChange?.(mappedMode);
      const modeHint = mappedMode ? ` (agent mode set: ${mappedMode})` : "";
      return { output: `Enabled skill: ${skillName}${modeHint}` };
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
   /tip — Rotating usage tips
────────────────────────────────────────── */

const TIP_LIST: string[] = [
  [
    "Tip: What is YUAN?",
    "  YUAN is an autonomous coding agent that runs in your terminal.",
    "  It uses LLM tool-use to read/write/edit files, run shell commands,",
    "  search code, manage git, and browse the web — all without leaving",
    "  your terminal.",
    "",
    "  Key concepts:",
    "  • BYOK  — bring your own API key (OpenAI, Claude, Gemini, YUA)",
    "  • Tools — file_read, file_write, shell_exec, grep, glob, git_ops, …",
    "  • Skills — 35 built-in skills auto-activate based on file types",
    "  • MCP   — extend with external tools via ~/.yuan/mcp.json",
    "  • Phases — explore → implement → verify → finalize (auto-tracked)",
  ].join("\n"),

  [
    "Tip: YUAN agent phases",
    "  YUAN automatically transitions between task phases:",
    "    explore   ◎  reading files, understanding codebase",
    "    implement ●  writing code, editing files",
    "    verify    ◷  running checks, QA pipeline",
    "    finalize  ✦  completing, summarising",
    "",
    "  Phase is shown in the footer bar during execution.",
    "  QA runs automatically in SHADOW mode after each write.",
    "  AutoTSC checks TypeScript after 2+ files modified.",
  ].join("\n"),

  [
    "Tip: MCP server setup",
    "  Extend YUAN with any MCP server via ~/.yuan/mcp.json:",
    '  { "servers": [',
    '    { "name": "fetch", "command": "uvx", "args": ["mcp-server-fetch"] },',
    '    { "name": "github", "command": "npx",',
    '      "args": ["-y", "@modelcontextprotocol/server-github"],',
    '      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx" } }',
    "  ] }",
    "",
    "  Run /mcp to see all available servers and install commands.",
  ].join("\n"),

  [
    "Tip: Slash commands overview",
    "  /help      — full command list",
    "  /status    — provider, model, tokens",
    "  /model     — view or switch model",
    "  /cost      — token usage & cost",
    "  /compact   — compress context to save tokens",
    "  /diff      — changes made this session",
    "  /memory    — learned patterns (YUAN.md)",
    "  /skills    — available skills tree",
    "  /mcp       — MCP server status",
    "  /tip       — show next tip",
  ].join("\n"),

  [
    "Tip: Model switching",
    "  Switch at any time without restarting:",
    "  /model anthropic/claude-sonnet-4-6   — Anthropic (recommended)",
    "  /model openai/gpt-4.1-mini           — Fast + cheap",
    "  /model google/gemini-2.5-flash       — Google GA",
    "  /model                               — Show full catalog",
    "",
    "  For cost savings: use cheaper models (gpt-4.1-mini, haiku-4.5)",
    "  for simple tasks; reserve flagship models for complex work.",
  ].join("\n"),

  [
    "Tip: Phase-aware workflow",
    "  YUAN follows a structured 4-phase loop:",
    "  1. Explore  — read & understand the codebase",
    "  2. Implement — make changes (tools: write, edit, shell)",
    "  3. Verify  — lint, build, test",
    "  4. Finalize — summarize changes, update docs",
    "",
    "  Steer with: /mode plan | code | review | test | debug",
  ].join("\n"),

  [
    "Tip: Skills system",
    "  Skills are reusable agent behaviours (slash-invokable):",
    "  /skills              — list all skills",
    "  /skills enable <id>  — enable a skill",
    "  /skills disable <id> — disable a skill",
    "",
    "  Built-in skills: code-review, security-scan, test-gen,",
    "  refactor, debug, plan",
    "  Plugin skills: install via /plugins install <name>",
  ].join("\n"),

  [
    "Tip: Session resume",
    "  Conversations are saved automatically.",
    "  Resume the last session:",
    "    yuan resume",
    "  Resume a specific session by ID:",
    "    yuan resume <session-id>",
    "  List saved sessions:",
    "    yuan sessions",
  ].join("\n"),

  [
    "Tip: Cost saving",
    "  Tokens cost money — save them with these habits:",
    "  • /compact when context > 80% (compresses history)",
    "  • Use cheaper models for simple questions",
    "    (/model openai/gpt-4.1-mini or anthropic/claude-haiku-4-5-20251001)",
    "  • Keep prompts focused and specific",
    "  • /cost to monitor usage during a session",
  ].join("\n"),

  [
    "Tip: Approval system",
    "  Destructive actions (write, shell, git) require approval.",
    "  During a prompt, you can respond:",
    "    y       — approve this action once",
    "    n       — reject this action",
    "    always  — approve all actions of this type (session)",
    "",
    "  Slash commands: /approve  /reject",
  ].join("\n"),

  [
    "Tip: Design mode",
    "  YUAN can interact with a live browser for UI feedback:",
    "    yuan design",
    "  Design tools: snapshot, screenshot, navigate, resize,",
    "  inspect, scroll — all driven by the AI.",
    "  Requires Playwright (auto-installed on first use).",
  ].join("\n"),

  [
    "Tip: Context management",
    "  Monitor context usage with /status (totalTokens).",
    "  When context gets large:",
    "  • /compact  — summarise history (keeps recent messages)",
    "  • /clear    — start fresh (loses history)",
    "",
    "  Auto-compaction triggers at ~60% by default.",
    "  Use /compact manually when you notice slowdowns.",
  ].join("\n"),
];

const tip: CommandHandler = (_ctx, _args) => {
  const idx = Math.floor(Date.now() / 1000) % TIP_LIST.length;
  const tipText = TIP_LIST[idx];
  return {
    output: [
      tipText,
      "",
      `  (tip ${(idx + 1)}/${TIP_LIST.length} — run /tip again for the next one)`,
    ].join("\n"),
  };
};

/* ──────────────────────────────────────────
   /mcp — MCP server status
────────────────────────────────────────── */

const MCP_AVAILABLE = [
  // Free / no API key
  { name: "fetch",            free: true,  install: "uvx mcp-server-fetch",                                   desc: "Fetch any URL → clean markdown" },
  { name: "memory",           free: true,  install: "npx -y @modelcontextprotocol/server-memory",             desc: "Persistent knowledge graph across sessions" },
  { name: "git",              free: true,  install: "uvx mcp-server-git",                                     desc: "Full git operations via MCP" },
  { name: "sequentialthinking",free:true,  install: "npx -y @modelcontextprotocol/server-sequential-thinking",desc: "Structured multi-step reasoning" },
  { name: "playwright",       free: true,  install: "npx -y @playwright/mcp",                                 desc: "Browser automation (Microsoft)" },
  { name: "filesystem",       free: true,  install: "npx -y @modelcontextprotocol/server-filesystem",         desc: "Extended file ops with configurable paths" },
  { name: "docker",           free: true,  install: "npx -y mcp-server-docker",                               desc: "Container + image management" },
  { name: "kubernetes",       free: true,  install: "npx -y mcp-server-kubernetes",                           desc: "K8s cluster control" },
  // Needs API key
  { name: "github",           free: false, install: "npx -y @modelcontextprotocol/server-github",             desc: "PR/issue management, code search  (GITHUB_PERSONAL_ACCESS_TOKEN)" },
  { name: "brave-search",     free: false, install: "npx -y @modelcontextprotocol/server-brave-search",       desc: "Web search  (BRAVE_API_KEY)" },
  { name: "spider",           free: false, install: "npx -y @willbohn/spider-mcp",                            desc: "Web scraping + search  (SPIDER_API_KEY)" },
  { name: "semgrep",          free: false, install: "npx -y semgrep-mcp",                                     desc: "SAST security scanning  (SEMGREP_APP_TOKEN)" },
  { name: "e2b",              free: false, install: "npx -y @e2b/mcp-server",                                 desc: "Isolated cloud code execution  (E2B_API_KEY)" },
  // Self-hosted
  { name: "searxng",          free: true,  install: "docker run -p 8080:8080 searxng/searxng",                desc: "Self-hosted multi-engine search (no API key)" },
];

const mcp: CommandHandler = () => {
  const mcpConfigPath = path.join(os.homedir(), ".yuan", "mcp.json");

  // ── Loaded servers ──
  const lines: string[] = ["MCP Servers", `  Config: ${mcpConfigPath.replace(os.homedir(), "~")}`, ""];

  let loadedNames: string[] = [];
  try {
    const raw = fs.readFileSync(mcpConfigPath, "utf-8");
    const parsed = JSON.parse(raw) as { servers?: Array<{ name: string; command?: string; args?: string[] }> };
    const servers = parsed.servers ?? [];
    loadedNames = servers.map((s) => s.name);
    if (servers.length === 0) {
      lines.push("  Loaded: (none — add servers to ~/.yuan/mcp.json)");
    } else {
      lines.push("  Loaded:");
      servers.forEach((s, i) => {
        const prefix = i === servers.length - 1 ? "  └──" : "  ├──";
        const cmd = s.command ? `${s.command} ${(s.args ?? []).join(" ")}`.trim() : "";
        lines.push(`${prefix} ${s.name}${cmd ? `  — ${cmd}` : ""}`);
      });
    }
  } catch {
    lines.push("  Loaded: (not configured)");
  }

  // ── Available to install ──
  lines.push("", "  Available MCP servers:");
  lines.push("  (★ = free/no API key)");
  lines.push("");

  const freeServers = MCP_AVAILABLE.filter((s) => s.free && !loadedNames.includes(s.name));
  const paidServers = MCP_AVAILABLE.filter((s) => !s.free && !loadedNames.includes(s.name));

  if (freeServers.length > 0) {
    lines.push("  Free:");
    freeServers.forEach((s) => {
      lines.push(`    ★  ${s.name.padEnd(18)} ${s.desc}`);
      lines.push(`       install: ${s.install}`);
    });
  }

  if (paidServers.length > 0) {
    lines.push("", "  Requires API key:");
    paidServers.forEach((s) => {
      lines.push(`       ${s.name.padEnd(18)} ${s.desc}`);
      lines.push(`       install: ${s.install}`);
    });
  }

  // ── Quick setup example ──
  lines.push(
    "",
    "  Quick setup — add to ~/.yuan/mcp.json:",
    '  { "servers": [',
    '    { "name": "fetch",  "command": "uvx", "args": ["mcp-server-fetch"] },',
    '    { "name": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],',
    '      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx" } }',
    "  ] }",
    "",
    "  Restart YUAN after editing to load changes.",
  );

  return { output: lines.join("\n") };
};

/* ──────────────────────────────────────────
   /qa — QA governor status
────────────────────────────────────────── */

const qa: CommandHandler = (_ctx) => {
  const lines = [
    "QA Governor Status",
    "",
    "  Subsystems (defaults):",
    "  ├── lint          SHADOW    (runs, warns only)",
    "  ├── type-check    SHADOW    (runs, warns only)",
    "  ├── tests         SHADOW    (runs, warns only)",
    "  ├── security-scan OFF       (disabled by default)",
    "  └── build         BLOCKING  (hard-fails on error)",
    "",
    "  Mode definitions:",
    "    BLOCKING  — failure blocks the agent from proceeding",
    "    SHADOW    — failure logged but agent continues",
    "    OFF       — subsystem not executed",
    "",
    "  To enable BLOCKING mode for a subsystem, add to .yuan/config.json:",
    "  {",
    '    "qa": {',
    '      "lint": "BLOCKING",',
    '      "type-check": "BLOCKING",',
    '      "tests": "BLOCKING",',
    '      "security-scan": "SHADOW"',
    "    }",
    "  }",
    "",
    "  For QA results from the last run, check .yuan/qa-report.json",
    "  or run: yuan benchmark report",
  ];
  return { output: lines.join("\n") };
};

/* ──────────────────────────────────────────
   Benchmark
────────────────────────────────────────── */

const benchmark: CommandHandler = (ctx, args) => {
  const subCommand = args[0]?.toLowerCase();

  if (!subCommand || subCommand === "sample") {
    return {
      output: [
        "Benchmark Mode",
        "",
        "  /benchmark sample      — Run built-in sample tasks (no agent execution)",
        "  /benchmark report      — Show last saved benchmark report",
        "",
        "For a full benchmark run with agent execution, use the CLI:",
        "  yuan benchmark [config.json]   — Run tasks from a config file",
        "  yuan benchmark sample          — Run built-in sample tasks",
        "  yuan benchmark --report        — Print Markdown report",
        "",
        "Results are saved to .yuan/benchmarks/",
      ].join("\n"),
    };
  }

  if (subCommand === "report") {
    // Load and display last benchmark report
    const benchmarkDir = path.join(ctx.workDir, ".yuan", "benchmarks");
    try {
      const files = fs
        .readdirSync(benchmarkDir)
        .filter((f) => f.startsWith("benchmark-") && f.endsWith(".json"))
        .sort()
        .reverse();

      if (files.length === 0) {
        return { output: "No benchmark results found. Run: yuan benchmark sample" };
      }

      const latestPath = path.join(benchmarkDir, files[0]);
      const raw = fs.readFileSync(latestPath, "utf-8");
      const summary = JSON.parse(raw) as {
        totalTasks: number;
        passed: number;
        failed: number;
        successRate: number;
        avgTokensPerTask: number;
        avgDurationMs: number;
        totalCostEstimateUSD: number;
        regressions: string[];
        improvements: string[];
        timestamp: string;
      };

      const lines = [
        `Last Benchmark: ${summary.timestamp}`,
        `  Total:    ${summary.totalTasks}`,
        `  Passed:   ${summary.passed}`,
        `  Failed:   ${summary.failed}`,
        `  Rate:     ${(summary.successRate * 100).toFixed(1)}%`,
        `  Avg Tokens/Task: ${Math.round(summary.avgTokensPerTask).toLocaleString()}`,
        `  Avg Duration:    ${(summary.avgDurationMs / 1000).toFixed(1)}s`,
        `  Est. Cost:       $${summary.totalCostEstimateUSD.toFixed(4)}`,
      ];
      if (summary.regressions.length > 0) {
        lines.push(`  Regressions: ${summary.regressions.join(", ")}`);
      }
      if (summary.improvements.length > 0) {
        lines.push(`  Improvements: ${summary.improvements.join(", ")}`);
      }
      lines.push(`\nFull report: ${latestPath}`);

      return { output: lines.join("\n") };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `Could not read benchmark results: ${msg}` };
    }
  }

  return {
    output: [
      `Unknown subcommand: ${subCommand}`,
      "Usage: /benchmark [sample|report]",
    ].join("\n"),
  };
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
  { name: "/diff", description: "Show file changes made this session", handler: diff },
  { name: "/undo", description: "Undo last file change", handler: undo },
  { name: "/model", description: "Show or change model", handler: model },
  { name: "/mode", description: "Show or change agent mode", handler: mode },
  { name: "/settings", description: "Auto-update preferences", handler: settings },
  { name: "/exit", description: "Exit YUAN", aliases: ["/quit", "/q"], handler: () => ({ exit: true }) },
  // Extended (P2)
  { name: "/cost", description: "Show token usage and estimated cost breakdown", handler: cost },
  { name: "/compact", description: "Compress context to save tokens (use when context > 80%)", handler: compact },
  { name: "/approve", description: "Approve pending action", handler: approve },
  { name: "/reject", description: "Reject pending action", handler: reject },
  // Advanced (P3)
  { name: "/tools", description: "List available tools", handler: tools },
  { name: "/memory", description: "Show learned patterns from YUAN.md", handler: memory },
  { name: "/retry", description: "Retry last failed action", handler: retry },
  { name: "/tip", description: "Show a rotating usage tip", handler: tip },
  { name: "/mcp", description: "MCP server status and configuration", handler: mcp },
  { name: "/qa", description: "QA governor config and how to enable BLOCKING mode", handler: qa },
  // Plugin System (P4)
  { name: "/plugins", description: "Plugin management (install/remove/search)", handler: plugins },
  { name: "/skills", description: "Available skills (tree view)", aliases: ["/skill"], handler: skills },
  // Benchmark (P5)
  { name: "/benchmark", description: "Show benchmark info or last report", handler: benchmark },
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
