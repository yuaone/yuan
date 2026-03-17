/**
 * summary-builder.ts — Structured turn summary for YUAN CLI.
 *
 * Builds a structured summary from tool_result and QA events (NOT text
 * scraping).  Renders a compact, chalk-colored block for the terminal.
 *
 * Output example:
 *   ✓ Done                                          3.8s · 1.2k tokens
 *   ├─ Modified  src/stream-renderer.ts             +42 -18
 *   ├─ Modified  src/output-contract.ts             +15 -3
 *   ├─ Created   src/output-classifier.ts           +120
 *   └─ Tests     3 passed
 */

import chalk from "chalk";

// ─── Public Types ───────────────────────────────────────────────────────────

export interface FileChange {
  action: "modified" | "created" | "deleted";
  path: string;
  insertions?: number;
  deletions?: number;
}

export interface StructuredSummary {
  status: "success" | "partial" | "error";
  duration: number;
  tokens: { input: number; output: number };
  filesChanged: FileChange[];
  testResult?: { passed: number; failed: number };
}

// ─── Internal Tracking ──────────────────────────────────────────────────────

interface TrackedFile {
  action: "modified" | "created" | "deleted";
  path: string;
  insertions: number;
  deletions: number;
}

interface TrackedQa {
  stage: string;
  passed: boolean;
  issues: string[];
}

// ─── Tool Name → Action Mapping ─────────────────────────────────────────────

const WRITE_TOOLS = new Set(["file_write", "write_file", "create_file"]);
const EDIT_TOOLS = new Set(["file_edit", "edit_file", "apply_diff"]);
const DELETE_TOOLS = new Set(["file_delete", "delete_file", "remove_file"]);
const READ_TOOLS = new Set(["file_read", "read_file"]);

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractPath(args: unknown): string {
  if (args && typeof args === "object" && "path" in args) {
    return String((args as Record<string, unknown>).path);
  }
  if (args && typeof args === "object" && "file_path" in args) {
    return String((args as Record<string, unknown>).file_path);
  }
  return "unknown";
}

/**
 * Attempt to infer insertions/deletions from the tool output.
 * Looks for patterns like "+42 -18" or "42 insertions, 18 deletions".
 */
function inferDiffStats(output: string): { insertions: number; deletions: number } {
  // Pattern: "+N -N"
  const shortMatch = output.match(/\+(\d+)\s+-(\d+)/);
  if (shortMatch) {
    return {
      insertions: parseInt(shortMatch[1], 10),
      deletions: parseInt(shortMatch[2], 10),
    };
  }

  // Pattern: "N insertions, N deletions"
  const longMatch = output.match(/(\d+)\s+insertion|(\d+)\s+deletion/g);
  if (longMatch) {
    let ins = 0;
    let del = 0;
    for (const m of longMatch) {
      if (m.includes("insertion")) ins = parseInt(m, 10) || 0;
      if (m.includes("deletion")) del = parseInt(m, 10) || 0;
    }
    return { insertions: ins, deletions: del };
  }

  // Pattern: count newlines in output as rough insertion estimate
  const lines = output.split("\n").length;
  if (lines > 1) {
    return { insertions: lines, deletions: 0 };
  }

  return { insertions: 0, deletions: 0 };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  return sec < 10 ? `${sec.toFixed(1)}s` : `${Math.round(sec)}s`;
}

function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  return `${(count / 1000).toFixed(1)}k`;
}

// ─── SummaryBuilder ─────────────────────────────────────────────────────────

export class SummaryBuilder {
  private files: Map<string, TrackedFile> = new Map();
  private qaResults: TrackedQa[] = [];

  trackToolResult(
    tool: string,
    args: unknown,
    output: string,
    success: boolean,
  ): void {
    if (!success) return;

    // Skip read-only tools — they don't change files
    if (READ_TOOLS.has(tool)) return;

    const filePath = extractPath(args);
    if (filePath === "unknown") return;

    let action: "modified" | "created" | "deleted";
    if (DELETE_TOOLS.has(tool)) {
      action = "deleted";
    } else if (WRITE_TOOLS.has(tool)) {
      // If already tracked, it's a modification; otherwise creation
      action = this.files.has(filePath) ? "modified" : "created";
    } else if (EDIT_TOOLS.has(tool)) {
      action = "modified";
    } else {
      return; // Unknown tool — don't track
    }

    const stats = inferDiffStats(output);
    const existing = this.files.get(filePath);

    if (existing) {
      // Accumulate stats
      existing.action = action;
      existing.insertions += stats.insertions;
      existing.deletions += stats.deletions;
    } else {
      this.files.set(filePath, {
        action,
        path: filePath,
        insertions: stats.insertions,
        deletions: stats.deletions,
      });
    }
  }

  trackQaResult(stage: string, passed: boolean, issues: string[]): void {
    this.qaResults.push({ stage, passed, issues });
  }

  build(completedEvent: {
    summary: string;
    filesChanged: string[];
    tokenUsage: { input: number; output: number };
    duration: number;
  }): StructuredSummary {
    // Merge any files from completedEvent that we didn't track via tools
    for (const fp of completedEvent.filesChanged) {
      if (!this.files.has(fp)) {
        this.files.set(fp, {
          action: "modified",
          path: fp,
          insertions: 0,
          deletions: 0,
        });
      }
    }

    const filesChanged: FileChange[] = [];
    for (const tracked of this.files.values()) {
      const entry: FileChange = {
        action: tracked.action,
        path: tracked.path,
      };
      if (tracked.insertions > 0) entry.insertions = tracked.insertions;
      if (tracked.deletions > 0) entry.deletions = tracked.deletions;
      filesChanged.push(entry);
    }

    // Determine test results from QA data
    let testResult: { passed: number; failed: number } | undefined;
    const testQa = this.qaResults.filter((q) => q.stage === "test");
    if (testQa.length > 0) {
      testResult = {
        passed: testQa.filter((q) => q.passed).length,
        failed: testQa.filter((q) => !q.passed).length,
      };
    }

    // Determine overall status
    const hasFailedQa = this.qaResults.some((q) => !q.passed);
    const status: StructuredSummary["status"] = hasFailedQa
      ? "partial"
      : "success";

    return {
      status,
      duration: completedEvent.duration,
      tokens: { ...completedEvent.tokenUsage },
      filesChanged,
      testResult,
    };
  }

  render(summary: StructuredSummary): string {
    const lines: string[] = [];

    // ── Header line ───────────────────────────────────────────────────────
    const statusIcon =
      summary.status === "success"
        ? chalk.green("✓")
        : summary.status === "partial"
          ? chalk.yellow("⚠")
          : chalk.red("✗");
    const statusWord =
      summary.status === "success"
        ? "Done"
        : summary.status === "partial"
          ? "Partial"
          : "Error";

    const totalTokens = summary.tokens.input + summary.tokens.output;
    const meta = chalk.dim(
      `${formatDuration(summary.duration)} · ${formatTokens(totalTokens)} tokens`,
    );

    lines.push(`  ${statusIcon} ${statusWord}${" ".repeat(Math.max(1, 40 - statusWord.length))}${meta}`);

    // ── File changes ──────────────────────────────────────────────────────
    const fileCount = summary.filesChanged.length;
    for (let i = 0; i < fileCount; i++) {
      const fc = summary.filesChanged[i];
      const isLast = i === fileCount - 1 && !summary.testResult;
      const prefix = isLast ? "  └─" : "  ├─";

      const actionLabel =
        fc.action === "created"
          ? chalk.green("Created ")
          : fc.action === "deleted"
            ? chalk.red("Deleted ")
            : chalk.blue("Modified");

      let stats = "";
      if (fc.insertions && fc.insertions > 0) {
        stats += chalk.green(` +${fc.insertions}`);
      }
      if (fc.deletions && fc.deletions > 0) {
        stats += chalk.red(` -${fc.deletions}`);
      }

      const filePath = chalk.dim(fc.path);
      lines.push(`${prefix} ${actionLabel}  ${filePath}${" ".repeat(Math.max(1, 1))}${stats}`);
    }

    // ── Test results ──────────────────────────────────────────────────────
    if (summary.testResult) {
      const { passed, failed } = summary.testResult;
      const testLine =
        failed > 0
          ? chalk.red(`${passed} passed, ${failed} failed`)
          : chalk.green(`${passed} passed`);
      lines.push(`  └─ Tests     ${testLine}`);
    }

    return lines.join("\n") + "\n";
  }

  reset(): void {
    this.files.clear();
    this.qaResults = [];
  }
}
