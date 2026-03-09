/**
 * diff-formatter — parse unified diff string into structured ParsedDiff.
 */

import type { ParsedDiff, ParsedDiffHunk, ParsedDiffLine } from "../types.js";

/**
 * Parse a unified diff string into a ParsedDiff structure.
 */
export function parseDiff(diffText: string, filePath = ""): ParsedDiff {
  const lines = diffText.split("\n");
  const hunks: ParsedDiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let currentHunk: ParsedDiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    // Detect file path from diff header
    if (line.startsWith("--- a/") || line.startsWith("+++ b/")) {
      if (!filePath && line.startsWith("+++ b/")) {
        filePath = line.slice(6);
      }
      continue;
    }

    // Hunk header
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentHunk = {
        startOld: parseInt(hunkMatch[1], 10),
        startNew: parseInt(hunkMatch[2], 10),
        lines: [],
      };
      oldLine = currentHunk.startOld;
      newLine = currentHunk.startNew;
      hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({
        type: "add",
        content: line.slice(1),
        newLineNo: newLine++,
      });
      additions++;
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({
        type: "delete",
        content: line.slice(1),
        oldLineNo: oldLine++,
      });
      deletions++;
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({
        type: "context",
        content: line.slice(1),
        oldLineNo: oldLine++,
        newLineNo: newLine++,
      });
    }
  }

  return { filePath, hunks, additions, deletions };
}
