/**
 * @module tool-tree
 * @description Claude Code-style tool call tree renderer for the YUAN CLI.
 *
 * Renders tool calls as a structured tree with:
 *   - `● Verb(target)` header with success/failure color
 *   - Result summary per tool type (line counts, diff stats, match counts)
 *   - Output preview (max 3 lines by default) with truncation
 *   - Diff preview with red/green background coloring
 *   - Sub-agent tree with nested connectors
 *   - Duration footer
 *
 * Design constraints:
 *   - chalk only, no Ink/React
 *   - Returns strings — caller decides when/how to write
 *   - Works in SSH, tmux, PowerShell, cmd, VSCode terminal
 */

import chalk from "chalk";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ToolTreeOptions {
  /** Terminal width getter */
  getWidth: () => number;
  /** Whether to use unicode or ASCII */
  unicode?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Truncate a string to `max` characters, appending ellipsis if needed. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

/** Shorten a file path to its basename, or last `max` characters. */
function shortenPath(filePath: string, max: number = 40): string {
  // Use basename if short enough
  const parts = filePath.replace(/\\/g, "/").split("/");
  const basename = parts[parts.length - 1] ?? filePath;
  if (basename.length <= max) return basename;
  // Fall back to last `max` chars with leading ellipsis
  return "\u2026" + filePath.slice(-max + 1);
}

/** Map internal tool names to human-readable verbs. */
function getToolVerb(name: string): string {
  const map: Record<string, string> = {
    file_read: "Read",
    read_file: "Read",
    file_write: "Write",
    write_file: "Write",
    file_edit: "Update",
    edit_file: "Update",
    shell_exec: "Bash",
    glob: "Glob",
    grep: "Grep",
    web_search: "Search",
    parallel_web_search: "Search",
  };
  return map[name] ?? name;
}

/** Extract the primary target (file path, command, pattern) from tool args. */
function getToolTarget(name: string, args: Record<string, unknown>): string {
  // File path
  const path = args.file_path ?? args.path ?? args.filePath;
  if (path) return shortenPath(String(path));

  // Shell command
  const cmd = args.command ?? args.cmd;
  if (cmd) return truncate(String(cmd), 40);

  // Pattern / query / glob
  const pattern = args.pattern ?? args.query ?? args.glob;
  if (pattern) return truncate(String(pattern), 40);

  return "";
}

/** Build a one-line result summary for a completed tool call. */
function summarizeResult(
  toolName: string,
  output: string,
  success: boolean,
): string {
  if (!success) return chalk.red("failed");

  const lines = output.split("\n").filter(Boolean);

  switch (toolName) {
    case "file_read":
    case "read_file":
      return `${lines.length} lines`;

    case "file_edit":
    case "edit_file": {
      const added = lines.filter((l) => l.startsWith("+")).length;
      const removed = lines.filter((l) => l.startsWith("-")).length;
      return `Added ${added}, removed ${removed}`;
    }

    case "file_write":
    case "write_file":
      return `${lines.length} lines written`;

    case "glob":
      return `${lines.length} files`;

    case "grep":
      return `${lines.length} matches`;

    case "shell_exec":
      return lines[0] ?? "done";

    default:
      return lines[0]?.slice(0, 60) ?? "done";
  }
}

/** Format milliseconds as a human-readable duration. */
function formatDuration(ms: number): string {
  if (ms > 60_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── ToolTree ───────────────────────────────────────────────────────────────

export class ToolTree {
  private readonly getWidth: () => number;
  private readonly unicode: boolean;

  constructor(options: ToolTreeOptions) {
    this.getWidth = options.getWidth;
    this.unicode = options.unicode ?? true;
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /**
   * Render a completed tool call header + result preview.
   * Returns the full rendered string ready to write to transcript.
   */
  renderToolResult(
    toolName: string,
    args: Record<string, unknown>,
    output: string,
    success: boolean,
    durationMs: number,
  ): string {
    const width = this.getWidth();
    let result = "";

    // Header: ● Verb(target)
    result += this.renderHeader(toolName, args, success) + "\n";

    // Summary line: └─ N lines / Added N, removed M / etc.
    const summary = summarizeResult(toolName, output, success);
    result += chalk.dim("  └─ ") + chalk.dim(summary) + "\n";

    // Diff preview for edit/write tools
    const isEditTool =
      toolName === "file_edit" ||
      toolName === "edit_file" ||
      toolName === "file_write" ||
      toolName === "write_file";
    if (isEditTool && success && output) {
      const diffPreview = this.renderDiffPreview(output, 6);
      if (diffPreview) {
        result += diffPreview;
      }
    }

    // Output preview for shell/other tools (not edit/read which already have summary)
    const isShellTool = toolName === "shell_exec";
    if (isShellTool && success && output) {
      result += this.renderOutputPreview(output, width, 3);
    }

    // Duration line
    result += chalk.dim(`  └─ (${formatDuration(durationMs)})`) + "\n";

    return result;
  }

  /** Render a diff preview (for file_edit/file_write results). */
  renderDiffPreview(diffText: string, maxLines: number = 6): string {
    const lines = diffText.split("\n");
    let result = "";
    let count = 0;

    for (const line of lines) {
      if (count >= maxLines) break;

      if (line.startsWith("+") && !line.startsWith("+++")) {
        result +=
          chalk.bgHex("#1a3a1a").green(`       ${line}`) + "\n";
        count++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        result +=
          chalk.bgHex("#3a1a1a").red(`       ${line}`) + "\n";
        count++;
      } else if (line.startsWith("@@") || line.startsWith("diff")) {
        // skip diff headers
      } else if (line.trim()) {
        result += chalk.dim(`       ${line}`) + "\n";
        count++;
      }
    }

    return result;
  }

  /** Render a sub-agent tree. */
  renderAgentTree(
    agents: Array<{ name: string; status: string }>,
  ): string {
    if (agents.length === 0) return "";

    const connector = this.unicode;
    let result =
      "  " + chalk.yellow("\u25cf") + ` ${agents.length} agents launched\n`;

    for (let i = 0; i < agents.length; i++) {
      const isLast = i === agents.length - 1;
      const branch = connector
        ? isLast
          ? "\u251c\u2500"
          : "\u251c\u2500"
        : "|-";
      const subBranch = connector
        ? isLast
          ? "   \u2514\u2500 "
          : "\u2502  \u2514\u2500 "
        : isLast
          ? "   +- "
          : "|  +- ";

      result += `    ${branch} ${agents[i].name}\n`;
      result += chalk.dim(`    ${subBranch}${agents[i].status}`) + "\n";
    }

    return result;
  }

  // ─── Private ────────────────────────────────────────────────────────

  /** Render the tool header line: `● Verb(target)` */
  private renderHeader(
    toolName: string,
    args: Record<string, unknown>,
    success: boolean,
  ): string {
    const icon = success
      ? chalk.yellow("\u25cf")
      : chalk.red("\u25cf");
    const verb = getToolVerb(toolName);
    const target = getToolTarget(toolName, args);

    if (target) {
      return `  ${icon} ${chalk.bold(verb)}(${target})`;
    }
    return `  ${icon} ${chalk.bold(verb)}`;
  }

  /** Render a truncated output preview (max N lines). */
  private renderOutputPreview(
    output: string,
    width: number,
    maxLines: number = 3,
  ): string {
    const lines = output.split("\n").filter(Boolean);
    const preview = lines.slice(0, maxLines);
    const remaining = lines.length - maxLines;

    let result = "";
    for (const line of preview) {
      result += chalk.dim(`     ${line.slice(0, width - 8)}`) + "\n";
    }
    if (remaining > 0) {
      result += chalk.dim(`     \u2026 +${remaining} lines`) + "\n";
    }
    return result;
  }
}
