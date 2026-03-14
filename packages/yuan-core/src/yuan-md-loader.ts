/**
 * @module yuan-md-loader
 * @description Auto-detects and loads yuan.md behavior guidelines file.
 *
 * Search order (first found wins):
 *  1. <projectPath>/yuan.md (also tries Yuan.md, YUAN.md — skips YUAN.md if it's a project memory file)
 *  2. ~/.yuan/<username>/yuan.md (user global config)
 *  3. Returns null if not found.
 *
 * Files larger than 50KB are truncated with a note appended.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveUserMemoryBase } from "./resolve-memory-path.js";

export interface YuanMdResult {
  content: string;
  source: "project" | "user-global";
  path: string;
}

const MAX_SIZE_BYTES = 50 * 1024; // 50KB
const PROJECT_MEMORY_HEADER = "## YUAN Memory";

/**
 * Attempts to read a file, returning null if it doesn't exist or can't be read.
 */
async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    const buf = await readFile(filePath);
    if (buf.length > MAX_SIZE_BYTES) {
      const truncated = buf.slice(0, MAX_SIZE_BYTES).toString("utf-8");
      return truncated + "\n\n<!-- [yuan.md truncated: file exceeds 50KB limit] -->";
    }
    return buf.toString("utf-8");
  } catch {
    return null;
  }
}

/**
 * Returns true if the content looks like a YUAN.md project memory file
 * (contains the "## YUAN Memory" header), which should be skipped.
 */
function isProjectMemoryFile(content: string): boolean {
  return content.includes(PROJECT_MEMORY_HEADER);
}

/**
 * Auto-detects and loads yuan.md behavior guidelines.
 * Returns null if no yuan.md file is found.
 */
export async function loadYuanMd(projectPath: string): Promise<YuanMdResult | null> {
  // 1. Try project-level yuan.md (case variants)
  const projectCandidates = [
    join(projectPath, "yuan.md"),
    join(projectPath, "Yuan.md"),
    join(projectPath, "YUAN.md"),
  ];

  for (const candidatePath of projectCandidates) {
    const content = await tryReadFile(candidatePath);
    if (content === null) continue;

    // Skip YUAN.md if it looks like a project memory file
    if (candidatePath.endsWith("YUAN.md") && isProjectMemoryFile(content)) {
      continue;
    }

    return { content, source: "project", path: candidatePath };
  }

  // 2. Try user global yuan.md
  try {
    const { userBase } = resolveUserMemoryBase();
    const userYuanMdPath = join(userBase, "yuan.md");
    const content = await tryReadFile(userYuanMdPath);
    if (content !== null) {
      return { content, source: "user-global", path: userYuanMdPath };
    }
  } catch {
    // resolveUserMemoryBase failed (e.g., in restricted environments) — non-fatal
  }

  return null;
}
