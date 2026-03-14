/**
 * @module tool-synthesizer
 * @description Proposes new tools based on repeated task patterns.
 *
 * Design:
 * - TEMPLATE-BASED generation only — no LLM code generation, no dynamic eval.
 * - All proposals go to a staging area only.
 * - Human approval gate is MANDATORY before any activation.
 * - Generated code is a TypeScript interface + async function signature stub
 *   (enough for tsc to type-check the shape, but NOT a full implementation).
 *
 * Safety constraints enforced here:
 * - NO runtime tool installation.
 * - NO dynamic require() or import() of generated code.
 * - NO direct execution of generated code.
 * - Sandbox compile: tsc --noEmit on generated file in /tmp.
 * - Proposals are staging-only; approve/reject via human gate.
 *
 * Storage: ~/.yuan/proposals/tool-proposals.json — atomic write.
 * Events: emitted on single "event" channel like all other modules.
 */

import { execSync } from "child_process";
import { EventEmitter } from "events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

// ─── Types ───

export interface ToolCapabilityDescriptor {
  /** uuid */
  id: string;
  /** e.g. "bulk-fix-imports" */
  name: string;
  description: string;
  /** Simple types only */
  inputSchema: Record<string, "string" | "number" | "boolean" | "string[]">;
  /** What it returns */
  outputSchema: { type: "string" | "object" | "string[]" };
  /** Maps to trust class */
  estimatedCostClass: "read" | "write" | "shell";
  sandboxRequired: boolean;
  /** ISO timestamp */
  proposedAt: string;
  /** The skill/pattern that triggered this proposal */
  proposedFromPattern?: string;
}

export interface ToolProposal {
  /** uuid */
  id: string;
  descriptor: ToolCapabilityDescriptor;
  /** TypeScript source from template */
  generatedCode: string;
  /** Which template was used */
  templateUsed: string;
  sandboxResult: "pending" | "pass" | "fail" | "skipped";
  sandboxError?: string;
  status: "pending" | "approved" | "rejected";
  /** ISO timestamp */
  proposedAt: string;
  approvedAt?: string;
}

export type ToolTemplate = "file-transformer" | "bulk-runner" | "config-updater";

export interface ToolSynthesizerConfig {
  storageDir?: string;
  /** If true, only emit event when sandboxResult is "pass" (default: false) */
  requireSandboxPass?: boolean;
}

// ─── Template Definitions ───

/**
 * Built-in code templates.
 * Each template generates a TypeScript interface + async function signature stub.
 * Placeholders: {name}, {description}, {inputSchema}
 *
 * IMPORTANT: These are type stubs only — they are NOT full implementations
 * and should NEVER be executed directly.
 */
const TEMPLATES: Record<ToolTemplate, string> = {
  "file-transformer": `/**
 * Tool: {name}
 * {description}
 *
 * Template: file-transformer
 * WARNING: This is a generated stub. Human review and approval required before use.
 */

interface {PascalName}Input {
  /** Path to the file to transform */
  filePath: string;
  /** Regex pattern to search for */
  pattern: string;
  /** Replacement string */
  replacement: string;
}

interface {PascalName}Output {
  /** Transformed file content */
  result: string;
  /** Number of replacements made */
  replacements: number;
}

/**
 * Reads a file at args.filePath, applies args.pattern regex replacement
 * with args.replacement, writes result back.
 *
 * Input schema: {inputSchema}
 */
async function {camelName}(args: {PascalName}Input): Promise<{PascalName}Output> {
  // STUB: implementation pending human approval and review
  throw new Error("Not implemented — pending approval");
}

export type { {PascalName}Input, {PascalName}Output };
export { {camelName} };
`,

  "bulk-runner": `/**
 * Tool: {name}
 * {description}
 *
 * Template: bulk-runner
 * WARNING: This is a generated stub. Human review and approval required before use.
 */

interface {PascalName}Input {
  /** Glob pattern matching files to process */
  glob: string;
  /** Command to run on each matched file */
  command: string;
  /** Working directory for command execution */
  cwd?: string;
}

interface {PascalName}Result {
  /** File path processed */
  file: string;
  /** Command output */
  output: string;
  /** Whether command succeeded */
  success: boolean;
}

interface {PascalName}Output {
  /** Per-file results */
  results: {PascalName}Result[];
  /** Total files processed */
  total: number;
  /** Number of failures */
  failures: number;
}

/**
 * Globs files matching args.glob, runs args.command on each
 * (with shell exec in cwd), collects results.
 *
 * Input schema: {inputSchema}
 */
async function {camelName}(args: {PascalName}Input): Promise<{PascalName}Output> {
  // STUB: implementation pending human approval and review
  throw new Error("Not implemented — pending approval");
}

export type { {PascalName}Input, {PascalName}Output, {PascalName}Result };
export { {camelName} };
`,

  "config-updater": `/**
 * Tool: {name}
 * {description}
 *
 * Template: config-updater
 * WARNING: This is a generated stub. Human review and approval required before use.
 */

interface {PascalName}Input {
  /** Path to JSON or YAML config file */
  configPath: string;
  /** Updates to merge into the config (JSON object) */
  updates: Record<string, unknown>;
}

interface {PascalName}Output {
  /** Whether the write succeeded */
  success: boolean;
  /** Path written to */
  configPath: string;
  /** Keys that were updated */
  updatedKeys: string[];
}

/**
 * Reads JSON/YAML at args.configPath, merges args.updates (as JSON), writes back.
 *
 * Input schema: {inputSchema}
 */
async function {camelName}(args: {PascalName}Input): Promise<{PascalName}Output> {
  // STUB: implementation pending human approval and review
  throw new Error("Not implemented — pending approval");
}

export type { {PascalName}Input, {PascalName}Output };
export { {camelName} };
`,
};

// ─── Helpers ───

/** Convert "bulk-fix-imports" → "BulkFixImports" */
function toPascalCase(name: string): string {
  return name
    .replace(/[-_\s]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(.)/, (_, c: string) => c.toUpperCase());
}

/** Convert "bulk-fix-imports" → "bulkFixImports" */
function toCamelCase(name: string): string {
  const pascal = toPascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** Infer estimatedCostClass from template type */
function inferCostClass(template: ToolTemplate): "read" | "write" | "shell" {
  switch (template) {
    case "file-transformer":
      return "write";
    case "bulk-runner":
      return "shell";
    case "config-updater":
      return "write";
  }
}

/** Infer whether sandbox is required based on cost class */
function inferSandboxRequired(template: ToolTemplate): boolean {
  return template === "bulk-runner";
}

// ─── ToolSynthesizer ───

/**
 * ToolSynthesizer — proposes new tool stubs from repeated task patterns.
 *
 * Usage:
 * ```ts
 * const synth = new ToolSynthesizer();
 * synth.on("event", (e) => console.log(e));
 * const proposal = await synth.propose(
 *   "bulk-fix-imports",
 *   "Fix all import paths across TS files",
 *   "file-transformer",
 *   { filePath: "path to TS file", pattern: "old import", replacement: "new import" },
 *   "repeated-import-fix-pattern"
 * );
 * // ... human reviews proposal.generatedCode ...
 * synth.approve(proposal.id);
 * ```
 *
 * SAFETY: Generated code is NEVER executed, installed, or dynamically loaded.
 * All generated code is stored as plain text in the proposals staging area only.
 */
export class ToolSynthesizer extends EventEmitter {
  private readonly storageDir: string;
  private readonly storageFile: string;
  private readonly requireSandboxPass: boolean;
  private proposals: ToolProposal[];

  constructor(config?: ToolSynthesizerConfig) {
    super();
    this.storageDir =
      config?.storageDir ?? join(homedir(), ".yuan", "proposals");
    this.storageFile = join(this.storageDir, "tool-proposals.json");
    this.requireSandboxPass = config?.requireSandboxPass ?? false;
    this.proposals = this._loadProposals();
    mkdirSync(this.storageDir, { recursive: true });
  }

  // ─── Public API ───

  /**
   * Propose a new tool from a SkillRegistry skill or trace pattern.
   *
   * Steps:
   * 1. Build ToolCapabilityDescriptor from inputs + template metadata.
   * 2. Generate TypeScript stub from template (fill placeholders).
   * 3. Run sandbox compile check (tsc --noEmit in /tmp).
   * 4. Persist proposal to staging storage.
   * 5. Emit "agent:tool_proposed" event (gated by requireSandboxPass if set).
   *
   * @param name - Tool name, e.g. "bulk-fix-imports"
   * @param description - Human-readable description
   * @param template - Which built-in template to use
   * @param inputHints - Free-form hints mapping field names to descriptions
   * @param fromPattern - The skill/pattern ID that triggered this proposal
   */
  async propose(
    name: string,
    description: string,
    template: ToolTemplate,
    inputHints: Record<string, string>,
    fromPattern?: string,
  ): Promise<ToolProposal> {
    const now = new Date().toISOString();
    const proposalId = randomUUID();
    const descriptorId = randomUUID();

    // Build simplified inputSchema from hints (all values become "string" type by default)
    const inputSchema: ToolCapabilityDescriptor["inputSchema"] = {};
    for (const key of Object.keys(inputHints)) {
      // Infer type from hint text heuristics
      const hint = inputHints[key]?.toLowerCase() ?? "";
      if (hint.includes("number") || hint.includes("count") || hint.includes("limit")) {
        inputSchema[key] = "number";
      } else if (hint.includes("flag") || hint.includes("boolean") || hint.includes("enable")) {
        inputSchema[key] = "boolean";
      } else if (hint.includes("list") || hint.includes("array") || hint.includes("files")) {
        inputSchema[key] = "string[]";
      } else {
        inputSchema[key] = "string";
      }
    }

    const descriptor: ToolCapabilityDescriptor = {
      id: descriptorId,
      name,
      description,
      inputSchema,
      outputSchema: { type: template === "bulk-runner" ? "object" : "string" },
      estimatedCostClass: inferCostClass(template),
      sandboxRequired: inferSandboxRequired(template),
      proposedAt: now,
      proposedFromPattern: fromPattern,
    };

    // Generate code from template
    const generatedCode = this._generateCode(name, description, template, inputSchema, inputHints);

    // Sandbox compile check
    const { sandboxResult, sandboxError } = this._sandboxCheck(generatedCode, proposalId);

    const proposal: ToolProposal = {
      id: proposalId,
      descriptor,
      generatedCode,
      templateUsed: template,
      sandboxResult,
      sandboxError,
      status: "pending",
      proposedAt: now,
    };

    // Persist to staging
    this.proposals.push(proposal);
    this._saveProposals();

    // Emit event — gated by requireSandboxPass setting
    const shouldEmit = !this.requireSandboxPass || sandboxResult === "pass";
    if (shouldEmit) {
      this.emit("event", {
        kind: "agent:tool_proposed",
        proposalId: proposal.id,
        toolName: name,
        templateUsed: template,
        sandboxResult,
        timestamp: Date.now(),
      });
    }

    return proposal;
  }

  /**
   * Get all proposals (includes pending, approved, rejected).
   */
  getProposals(): ToolProposal[] {
    return [...this.proposals];
  }

  /**
   * Approve a proposal — marks it as approved.
   * NOTE: Approval does NOT install or activate the tool at runtime.
   * The generated code stub remains in the staging area.
   * Integration into the tool registry must be done separately by a human.
   */
  approve(proposalId: string): void {
    const proposal = this.proposals.find((p) => p.id === proposalId);
    if (!proposal) return;
    if (proposal.status !== "pending") return;

    proposal.status = "approved";
    proposal.approvedAt = new Date().toISOString();
    this._saveProposals();
  }

  /**
   * Reject a proposal.
   */
  reject(proposalId: string): void {
    const proposal = this.proposals.find((p) => p.id === proposalId);
    if (!proposal) return;
    if (proposal.status !== "pending") return;

    proposal.status = "rejected";
    this._saveProposals();
  }

  // ─── Private: Code Generation ───

  /**
   * Fill template placeholders with actual values.
   * Placeholders: {name}, {PascalName}, {camelName}, {description}, {inputSchema}
   *
   * Generated code is a TypeScript stub only — NOT a full implementation.
   * NEVER executed directly.
   */
  private _generateCode(
    name: string,
    description: string,
    template: ToolTemplate,
    inputSchema: ToolCapabilityDescriptor["inputSchema"],
    _inputHints: Record<string, string>,
  ): string {
    const pascalName = toPascalCase(name);
    const camelName = toCamelCase(name);
    const schemaStr = JSON.stringify(inputSchema);

    let code = TEMPLATES[template];
    code = code.replaceAll("{name}", name);
    code = code.replaceAll("{PascalName}", pascalName);
    code = code.replaceAll("{camelName}", camelName);
    code = code.replaceAll("{description}", description);
    code = code.replaceAll("{inputSchema}", schemaStr);

    return code;
  }

  // ─── Private: Sandbox Compile Check ───

  /**
   * Write generated code to a temp file and run tsc --noEmit --strict.
   * Always cleans up the temp file.
   *
   * Returns sandboxResult "pass" | "fail" | "skipped".
   * "skipped" is returned when tsc is not available (ENOENT) — never throws.
   */
  private _sandboxCheck(
    code: string,
    proposalId: string,
  ): { sandboxResult: ToolProposal["sandboxResult"]; sandboxError?: string } {
    const tmpFile = `/tmp/yuan-tool-synthesizer-${proposalId}.ts`;

    try {
      writeFileSync(tmpFile, code, "utf-8");

      try {
        execSync(`tsc --noEmit --strict "${tmpFile}"`, {
          stdio: "pipe",
          timeout: 15_000,
        });
        return { sandboxResult: "pass" };
      } catch (err: unknown) {
        // tsc not found → skip gracefully
        if (
          err &&
          typeof err === "object" &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          return { sandboxResult: "skipped" };
        }

        // tsc found but compilation failed
        let sandboxError: string | undefined;
        if (
          err &&
          typeof err === "object" &&
          "stderr" in err &&
          err.stderr instanceof Buffer
        ) {
          sandboxError = err.stderr.toString("utf-8").slice(0, 1000);
        } else if (
          err &&
          typeof err === "object" &&
          "stdout" in err &&
          err.stdout instanceof Buffer
        ) {
          sandboxError = err.stdout.toString("utf-8").slice(0, 1000);
        } else if (err instanceof Error) {
          sandboxError = err.message.slice(0, 1000);
        }
        return { sandboxResult: "fail", sandboxError };
      }
    } catch {
      // File write or unexpected error — treat as skipped
      return { sandboxResult: "skipped" };
    } finally {
      // Always clean up temp file
      try {
        if (existsSync(tmpFile)) {
          unlinkSync(tmpFile);
        }
      } catch {
        // Non-fatal cleanup failure
      }
    }
  }

  // ─── Private: Persistence ───

  /**
   * Load persisted proposals from disk.
   */
  private _loadProposals(): ToolProposal[] {
    try {
      if (!existsSync(this.storageFile)) return [];
      const raw = readFileSync(this.storageFile, "utf-8");
      return JSON.parse(raw) as ToolProposal[];
    } catch {
      return [];
    }
  }

  /**
   * Atomic write of proposals array to disk.
   * Uses .tmp → rename pattern to prevent corruption.
   */
  private _saveProposals(): void {
    const tmpFile = `${this.storageFile}.tmp`;
    try {
      mkdirSync(this.storageDir, { recursive: true });
      writeFileSync(tmpFile, JSON.stringify(this.proposals, null, 2), "utf-8");
      renameSync(tmpFile, this.storageFile);
    } catch {
      // Non-fatal: storage failures should not crash the agent loop
    }
  }
}
