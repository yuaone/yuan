/**
 * @module world-model/state-updater
 * @description Updates the StateStore after actual tool execution.
 * Translates real tool results into WorldState patches so the world model
 * stays in sync with disk/git/build truth.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolResult } from "../types.js";
import type { StateStore } from "./state-store.js";
import type { FileState, StatePatch } from "./state-store.js";

// ─── StateUpdater ───

export class StateUpdater {
  constructor(
    private stateStore: StateStore,
    private projectPath: string,
  ) {}

  /**
   * Main method: call after every tool execution.
   * Applies the appropriate patch to the StateStore based on the tool and result.
   */
  async applyToolResult(
    tool: string,
    args: Record<string, unknown>,
    result: ToolResult,
  ): Promise<StatePatch> {
    const toolLower = tool.toLowerCase();

    // ── File write / edit ──────────────────────────────────────────────────
    if (toolLower === "file_write" || toolLower === "file_edit") {
      const rawPath = args["path"] ?? args["file_path"];
      const filePath = typeof rawPath === "string" ? rawPath : null;

      if (result.success && filePath !== null) {
        const fileState = await this.refreshFileState(filePath);
        if (fileState) {
          const currentGit = this.stateStore.getState().git;
          const uncommittedFiles = Array.from(
            new Set([...currentGit.uncommittedFiles, filePath]),
          );

          const patch: StatePatch = {
            files: [{ type: "set", path: filePath, state: fileState }],
            build: { status: "unknown" },
            test: { status: "unknown" },
            git: { dirty: true, uncommittedFiles },
          };

          this.stateStore.update(patch, `${tool}:${filePath}`);
          return patch;
        }
      }

      return {};
    }

    // ── Shell exec ────────────────────────────────────────────────────────
    if (toolLower === "shell_exec") {
      const command = typeof args["command"] === "string" ? args["command"] : "";

      if (/tsc|build|compile/i.test(command)) {
        this.parseBuildOutput(result.output, result.success);
      } else if (/test|jest|vitest|mocha|pytest/i.test(command)) {
        this.parseTestOutput(result.output, result.success);
      }

      // Patch was already applied inside the parse methods
      return {};
    }

    // ── Git ops ───────────────────────────────────────────────────────────
    if (toolLower === "git_ops") {
      const operation = args["operation"] ?? args["command"];
      const opStr = typeof operation === "string" ? operation : "";

      if (opStr === "commit") {
        const patch: StatePatch = {
          git: { dirty: false, uncommittedFiles: [], stagedFiles: [] },
        };
        this.stateStore.update(patch, "git:commit");
        return patch;
      }

      return {};
    }

    // ── Unknown / read-only tools ─────────────────────────────────────────
    return {};
  }

  /**
   * Read a file from disk and return its FileState.
   * Returns null if the file cannot be read (e.g. does not exist).
   */
  async refreshFileState(filePath: string): Promise<FileState | null> {
    const absPath = resolve(this.projectPath, filePath);
    const content = await readFile(absPath, "utf-8").catch(() => null);
    if (content === null) return null;

    const stats = await stat(absPath);
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);

    return {
      path: filePath,
      exists: true,
      hash,
      lines: content.split("\n").length,
      lastModified: stats.mtimeMs,
    };
  }

  /**
   * Parse build command output (tsc / webpack / vite / etc.) and update the
   * build state in the StateStore.
   */
  parseBuildOutput(output: string, success: boolean): void {
    const errorLines = output
      .split("\n")
      .filter((line) => /error TS\d+|Error:/i.test(line))
      .slice(0, 10)
      .map((line) => line.trim());

    const patch: StatePatch = {
      build: {
        status: success ? "pass" : "fail",
        errors: errorLines,
        lastRun: Date.now(),
      },
    };

    this.stateStore.update(patch, "build:result");
  }

  /**
   * Parse test command output (jest / vitest / mocha / pytest / etc.) and
   * update the test state in the StateStore.
   */
  parseTestOutput(output: string, success: boolean): void {
    const failingTests = output
      .split("\n")
      .filter((line) => /✗|FAIL|×|failed/i.test(line))
      .slice(0, 10)
      .map((line) => line.trim());

    const patch: StatePatch = {
      test: {
        status: success ? "pass" : "fail",
        failingTests,
        lastRun: Date.now(),
      },
    };

    this.stateStore.update(patch, "test:result");
  }
}
