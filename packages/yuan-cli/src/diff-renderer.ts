/**
 * YUAN CLI — Terminal Diff Viewer
 *
 * Renders unified diffs with color in the terminal.
 * Design ref: Section 10.3 of YUAN_CODING_AGENT_DESIGN.md
 */

import * as readline from "node:readline";
import { colors } from "./renderer.js";

const ESC = "\x1b[";

function c(color: string, text: string): string {
  return `${color}${text}${ESC}0m`;
}

/** A single line in a diff hunk */
export interface DiffLine {
  type: "add" | "delete" | "context";
  content: string;
  lineNumberOld?: number;
  lineNumberNew?: number;
}

/** A hunk in a unified diff */
export interface DiffHunk {
  index: number;
  startLineOld: number;
  startLineNew: number;
  lines: DiffLine[];
}

/** A complete unified diff for a file */
export interface UnifiedDiff {
  filePath: string;
  hunks: DiffHunk[];
  stats: { additions: number; deletions: number };
}

/** User's decision on a diff */
export type DiffDecision = "accept" | "reject" | "rollback";

/**
 * DiffRenderer — renders diffs in the terminal with colors
 */
export class DiffRenderer {
  /**
   * Render a unified diff to the terminal.
   * Additions are green (+), deletions are red (-), context is dim.
   */
  render(diff: UnifiedDiff): void {
    const { filePath, hunks, stats } = diff;

    // File header
    const statsStr = c(colors.green, `+${stats.additions}`) +
      " " +
      c(colors.red, `-${stats.deletions}`);
    console.log();
    console.log(
      c(colors.bold, `  ${filePath}`) + `  ${statsStr}`
    );
    console.log(c(colors.dim, "  " + "─".repeat(60)));

    // Render each hunk
    for (const hunk of hunks) {
      // Hunk header
      const hunkHeader = `@@ -${hunk.startLineOld} +${hunk.startLineNew} @@`;
      console.log(c(colors.cyan, `  ${hunkHeader}`));

      for (const line of hunk.lines) {
        const oldNum = line.lineNumberOld?.toString().padStart(4, " ") ?? "    ";
        const newNum = line.lineNumberNew?.toString().padStart(4, " ") ?? "    ";

        switch (line.type) {
          case "add":
            console.log(
              `  ${c(colors.dim, oldNum)} ${c(colors.green, newNum)} ` +
                c(colors.green, `+ ${line.content}`)
            );
            break;
          case "delete":
            console.log(
              `  ${c(colors.red, oldNum)} ${c(colors.dim, newNum)} ` +
                c(colors.red, `- ${line.content}`)
            );
            break;
          case "context":
            console.log(
              `  ${c(colors.dim, oldNum)} ${c(colors.dim, newNum)} ` +
                c(colors.dim, `  ${line.content}`)
            );
            break;
        }
      }
    }

    console.log(c(colors.dim, "  " + "─".repeat(60)));
  }

  /**
   * Render a raw unified diff string (e.g. from `git diff`).
   * Parses lines and colorizes +/- lines.
   */
  renderRawDiff(diffText: string): void {
    const lines = diffText.split("\n");

    for (const line of lines) {
      if (line.startsWith("+++") || line.startsWith("---")) {
        console.log(c(colors.bold, `  ${line}`));
      } else if (line.startsWith("@@")) {
        console.log(c(colors.cyan, `  ${line}`));
      } else if (line.startsWith("+")) {
        console.log(c(colors.green, `  ${line}`));
      } else if (line.startsWith("-")) {
        console.log(c(colors.red, `  ${line}`));
      } else {
        console.log(c(colors.dim, `  ${line}`));
      }
    }
  }

  /**
   * Prompt the user to accept, reject, or rollback a diff.
   * Returns the user's decision.
   */
  async promptDecision(filePath: string): Promise<DiffDecision> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      const question =
        c(colors.yellow, "\n  Apply this change? ") +
        c(colors.dim, "[Y/n/rollback] ");

      rl.question(question, (answer) => {
        rl.close();
        const a = answer.trim().toLowerCase();
        if (a === "n" || a === "no") {
          resolve("reject");
        } else if (a === "rollback" || a === "r") {
          resolve("rollback");
        } else {
          resolve("accept");
        }
      });
    });
  }

  /**
   * Render a summary of all changed files.
   */
  renderSummary(diffs: UnifiedDiff[]): void {
    console.log();
    console.log(c(colors.bold, `  Changed Files (${diffs.length})`));
    console.log(c(colors.dim, "  " + "─".repeat(50)));

    let totalAdd = 0;
    let totalDel = 0;

    for (const diff of diffs) {
      totalAdd += diff.stats.additions;
      totalDel += diff.stats.deletions;

      const statsStr =
        c(colors.green, `+${diff.stats.additions}`.padStart(5)) +
        " " +
        c(colors.red, `-${diff.stats.deletions}`.padStart(5));
      console.log(`  ${statsStr}  ${diff.filePath}`);
    }

    console.log(c(colors.dim, "  " + "─".repeat(50)));
    console.log(
      c(colors.dim, "  Total: ") +
        c(colors.green, `+${totalAdd}`) +
        " " +
        c(colors.red, `-${totalDel}`) +
        c(colors.dim, ` across ${diffs.length} files`)
    );
    console.log();
  }
}
