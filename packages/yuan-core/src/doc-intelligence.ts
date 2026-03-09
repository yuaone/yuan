/**
 * @module doc-intelligence
 * @description Documentation Intelligence — analyzes code to generate, validate,
 * and maintain documentation automatically.
 *
 * Features:
 * 1. **JSDoc/TSDoc Generation** — parse function signatures, generate doc templates
 * 2. **README Generation** — analyze project structure, generate sections
 * 3. **Changelog Generation** — parse conventional commits, group by type
 * 4. **API Documentation** — extract exports, generate API reference
 * 5. **Documentation Quality Analysis** — coverage, freshness, completeness, grading
 *
 * Uses regex-based parsing (no AST libraries). Designed for the YUAN coding agent
 * to automatically maintain documentation alongside code changes.
 *
 * @example
 * ```typescript
 * const di = new DocIntelligence({
 *   projectPath: "/path/to/project",
 *   srcDirs: ["src"],
 *   templateStyle: "jsdoc",
 * });
 *
 * // Analyze doc coverage
 * const files = new Map<string, string>();
 * files.set("src/index.ts", sourceCode);
 * const coverage = di.analyzeCoverage(files);
 * console.log(`Coverage: ${coverage.coveragePercent}% (Grade: ${coverage.grade})`);
 *
 * // Generate JSDoc for a function
 * const jsdoc = di.generateJSDoc("function add(a: number, b: number): number { return a + b; }");
 *
 * // Generate changelog from commits
 * const changelog = di.generateChangelog(commits);
 * ```
 */

import { basename, extname, join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────

/** Documentation coverage analysis result. */
export interface DocCoverage {
  /** Total number of exported symbols */
  totalExports: number;
  /** Number of exports with JSDoc/TSDoc */
  documentedExports: number;
  /** Coverage percentage (0–100) */
  coveragePercent: number;
  /** Symbols missing documentation */
  missing: DocMissing[];
  /** Symbols with stale documentation */
  stale: DocStale[];
  /** Overall documentation grade */
  grade: "A" | "B" | "C" | "D" | "F";
}

/** A symbol missing documentation. */
export interface DocMissing {
  /** Symbol name */
  symbolName: string;
  /** Symbol type (function, class, interface, etc.) */
  symbolType: string;
  /** File path where the symbol is defined */
  filePath: string;
  /** Line number (1-based) */
  line: number;
}

/** A symbol with stale (outdated) documentation. */
export interface DocStale {
  /** Symbol name */
  symbolName: string;
  /** File path */
  filePath: string;
  /** Line number of the JSDoc comment */
  docLine: number;
  /** Description of what changed in the code */
  lastCodeChange: string;
}

/** A generated documentation artifact. */
export interface GeneratedDoc {
  /** Type of documentation */
  type: "jsdoc" | "readme" | "changelog" | "api-reference";
  /** Generated content */
  content: string;
  /** Target file path */
  targetFile: string;
  /** Whether this is a new file (true) or update to existing (false) */
  isNew: boolean;
}

/** A structured changelog entry. */
export interface ChangelogEntry {
  /** Version string (e.g., "1.2.0") */
  version: string;
  /** Date string (ISO format, e.g., "2026-03-09") */
  date: string;
  /** Grouped changes by type */
  sections: {
    breaking: string[];
    features: string[];
    fixes: string[];
    refactors: string[];
    docs: string[];
    other: string[];
  };
  /** Recommended semver bump */
  semverBump: "major" | "minor" | "patch";
}

/** Configuration for DocIntelligence. */
export interface DocIntelligenceConfig {
  /** Project root path */
  projectPath: string;
  /** Source directories to scan (default: ["src"]) */
  srcDirs?: string[];
  /** Include private/non-exported symbols (default: false) */
  includePrivate?: boolean;
  /** Documentation template style (default: "jsdoc") */
  templateStyle?: "jsdoc" | "tsdoc";
  /** Changelog format (default: "keepachangelog") */
  changelogFormat?: "keepachangelog" | "conventional";
}

/** Project information for README generation. */
export interface ProjectInfo {
  /** Package name */
  name: string;
  /** Package description */
  description: string;
  /** Parsed package.json contents */
  packageJson: Record<string, unknown>;
  /** List of source file paths */
  srcFiles: string[];
  /** Whether the project has test files */
  hasTests: boolean;
  /** Whether the project has a CLI entry point */
  hasCLI: boolean;
}

/** Information about an exported symbol. */
export interface ExportInfo {
  /** Symbol name */
  name: string;
  /** Symbol type */
  type: "function" | "class" | "interface" | "type" | "enum" | "const";
  /** File path */
  filePath: string;
  /** Line number (1-based) */
  line: number;
  /** Full signature */
  signature: string;
  /** Whether the symbol has JSDoc */
  hasDoc: boolean;
  /** Existing JSDoc content, if any */
  docContent?: string;
}

/** Parsed git commit information. */
export interface CommitInfo {
  /** Commit hash */
  hash: string;
  /** Commit message */
  message: string;
  /** Author name */
  author: string;
  /** Date string */
  date: string;
  /** Changed file paths */
  files: string[];
}

/** Parsed conventional commit message. */
export interface ParsedCommit {
  /** Commit type (feat, fix, etc.) */
  type: string;
  /** Scope (optional) */
  scope?: string;
  /** Commit description */
  description: string;
  /** Whether this is a breaking change */
  breaking: boolean;
  /** Commit body (optional) */
  body?: string;
}

// ─── Internal Types ──────────────────────────────────────────────

/** Parsed function signature (internal). */
interface ParsedFunction {
  name: string;
  params: ParsedParam[];
  returnType: string;
  isAsync: boolean;
  isGenerator: boolean;
  genericParams?: string;
}

/** Parsed parameter (internal). */
interface ParsedParam {
  name: string;
  type: string;
  optional: boolean;
  defaultValue?: string;
  rest: boolean;
}

/** JSDoc analysis result (internal). */
interface JSDocAnalysis {
  exists: boolean;
  startLine: number;
  endLine: number;
  content: string;
  params: Map<string, string>;
  returns?: string;
  throws: string[];
  examples: string[];
  description: string;
}

// ─── Regex Patterns ──────────────────────────────────────────────

/** Matches export function declarations */
const RE_EXPORT_FUNCTION =
  /^(?:export\s+)?(?:async\s+)?function\s*(\*?)\s*(\w+)\s*(?:<([^>]+)>)?\s*\(([^)]*)\)(?:\s*:\s*([^\n{]+))?\s*\{/gm;

/** Matches export class declarations */
const RE_EXPORT_CLASS =
  /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s*<([^>]+)>)?(?:\s+extends\s+(\w+(?:<[^>]+>)?))?(?:\s+implements\s+([^\n{]+))?\s*\{/gm;

/** Matches export interface declarations */
const RE_EXPORT_INTERFACE =
  /^(?:export\s+)?interface\s+(\w+)(?:\s*<([^>]+)>)?(?:\s+extends\s+([^\n{]+))?\s*\{/gm;

/** Matches export type alias declarations */
const RE_EXPORT_TYPE =
  /^(?:export\s+)?type\s+(\w+)(?:\s*<([^>]+)>)?\s*=\s*([^\n;]+)/gm;

/** Matches export enum declarations */
const RE_EXPORT_ENUM =
  /^(?:export\s+)?(?:const\s+)?enum\s+(\w+)\s*\{/gm;

/** Matches export const/let/var declarations */
const RE_EXPORT_CONST =
  /^(?:export\s+)(?:const|let|var)\s+(\w+)(?:\s*:\s*([^\n=]+))?\s*=/gm;

/** Matches JSDoc comment blocks */
const RE_JSDOC = /\/\*\*\s*([\s\S]*?)\s*\*\//g;

/** Matches conventional commit messages */
const RE_CONVENTIONAL_COMMIT =
  /^(\w+)(?:\(([^)]+)\))?(!?):\s*(.+)$/;

/** Matches arrow function exports */
const RE_EXPORT_ARROW =
  /^(?:export\s+)(?:const|let)\s+(\w+)(?:\s*:\s*([^\n=]+))?\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>/gm;

/** Matches method declarations inside classes */
const RE_METHOD =
  /^\s+(?:(?:public|private|protected|static|async|readonly)\s+)*(\w+)\s*(?:<([^>]+)>)?\s*\(([^)]*)\)(?:\s*:\s*([^\n{]+))?\s*\{/gm;

// ─── Constants ───────────────────────────────────────────────────

/** Grade thresholds (percentage) */
const GRADE_THRESHOLDS: Record<DocCoverage["grade"], number> = {
  A: 90,
  B: 75,
  C: 60,
  D: 40,
  F: 0,
};

/** Common JSDoc tags */
const JSDOC_TAGS = {
  param: "@param",
  returns: "@returns",
  throws: "@throws",
  example: "@example",
  deprecated: "@deprecated",
  see: "@see",
  since: "@since",
} as const;

/** TSDoc equivalents */
const TSDOC_TAGS = {
  param: "@param",
  returns: "@returns",
  throws: "@throws",
  example: "@example",
  deprecated: "@deprecated",
  see: "@see",
  since: "@since",
} as const;

// ─── DocIntelligence ─────────────────────────────────────────────

/**
 * DocIntelligence — analyzes code to generate, validate, and maintain
 * documentation automatically.
 *
 * Provides:
 * - Coverage analysis (% of exports with docs, grading A–F)
 * - JSDoc/TSDoc generation from function signatures
 * - README generation from project structure
 * - Changelog generation from conventional commits
 * - API reference generation from exported symbols
 * - Staleness detection (code changed but docs did not)
 */
export class DocIntelligence {
  private readonly config: Required<DocIntelligenceConfig>;

  /**
   * Create a new DocIntelligence instance.
   *
   * @param config - Configuration options
   */
  constructor(config: DocIntelligenceConfig) {
    this.config = {
      projectPath: config.projectPath,
      srcDirs: config.srcDirs ?? ["src"],
      includePrivate: config.includePrivate ?? false,
      templateStyle: config.templateStyle ?? "jsdoc",
      changelogFormat: config.changelogFormat ?? "keepachangelog",
    };
  }

  // ─── Analysis ────────────────────────────────────────────────

  /**
   * Analyze documentation coverage across all provided files.
   *
   * Scans each file for exported symbols and checks whether they have
   * JSDoc comments. Returns coverage stats and a grade (A–F).
   *
   * @param files - Map of file path to file content
   * @returns Documentation coverage analysis
   */
  analyzeCoverage(files: Map<string, string>): DocCoverage {
    const allMissing: DocMissing[] = [];
    const allStale: DocStale[] = [];
    let totalExports = 0;
    let documentedExports = 0;

    for (const [filePath, content] of files) {
      const exports = this.parseExports(content, filePath);
      totalExports += exports.length;

      for (const exp of exports) {
        if (exp.hasDoc) {
          documentedExports++;
        } else {
          allMissing.push({
            symbolName: exp.name,
            symbolType: exp.type,
            filePath: exp.filePath,
            line: exp.line,
          });
        }
      }

      // Detect stale docs
      const stale = this.detectStaleDoc(content, filePath);
      allStale.push(...stale);
    }

    const coveragePercent =
      totalExports > 0
        ? Math.round((documentedExports / totalExports) * 100)
        : 100;

    const coverage: DocCoverage = {
      totalExports,
      documentedExports,
      coveragePercent,
      missing: allMissing,
      stale: allStale,
      grade: "F", // calculated below
    };

    coverage.grade = this.gradeDocumentation(coverage);
    return coverage;
  }

  /**
   * Find undocumented exported symbols in a single file.
   *
   * @param content - File content
   * @param filePath - File path (for reporting)
   * @returns List of missing documentation entries
   */
  findUndocumented(content: string, filePath: string): DocMissing[] {
    const exports = this.parseExports(content, filePath);
    return exports
      .filter((e) => !e.hasDoc)
      .map((e) => ({
        symbolName: e.name,
        symbolType: e.type,
        filePath: e.filePath,
        line: e.line,
      }));
  }

  /**
   * Detect stale documentation in a file.
   *
   * Checks for common staleness indicators:
   * - @param tags that don't match actual parameters
   * - @returns tag present but function returns void
   * - @deprecated tag on active code
   * - JSDoc description mentions types/names that no longer exist
   *
   * @param content - File content
   * @param filePath - File path (for reporting)
   * @param gitLog - Optional git log output for change detection
   * @returns List of stale documentation entries
   */
  detectStaleDoc(
    content: string,
    filePath: string,
    gitLog?: string,
  ): DocStale[] {
    const stale: DocStale[] = [];
    const lines = content.split("\n");

    // Find all JSDoc blocks and the symbol they precede
    const jsdocBlocks = this.findAllJSDocBlocks(content);

    for (const block of jsdocBlocks) {
      const symbolLine =
        block.endLine < lines.length ? lines[block.endLine] : "";

      // Check for param mismatch
      const funcMatch = symbolLine.match(
        /(?:function\s+(\w+)|(\w+)\s*(?:=\s*(?:async\s+)?\(|:\s*\([^)]*\)\s*=>))\s*(?:<[^>]+>)?\s*\(([^)]*)\)/,
      );

      if (funcMatch) {
        const funcName = funcMatch[1] ?? funcMatch[2] ?? "unknown";
        const paramsStr = funcMatch[3] ?? "";
        const actualParams = this.parseParamNames(paramsStr);
        const docParams = [...block.params.keys()];

        // Params in doc but not in code
        for (const docParam of docParams) {
          if (!actualParams.includes(docParam)) {
            stale.push({
              symbolName: funcName,
              filePath,
              docLine: block.startLine + 1,
              lastCodeChange: `@param ${docParam} documented but not in function signature`,
            });
          }
        }

        // Params in code but not in doc (only flag if doc has ANY @param)
        if (docParams.length > 0) {
          for (const actual of actualParams) {
            if (!block.params.has(actual)) {
              stale.push({
                symbolName: funcName,
                filePath,
                docLine: block.startLine + 1,
                lastCodeChange: `Parameter '${actual}' exists in code but missing from JSDoc`,
              });
            }
          }
        }
      }

      // Check @returns on void function
      if (block.returns) {
        const returnTypeMatch = symbolLine.match(/\):\s*void\s/);
        if (returnTypeMatch) {
          const name = this.extractSymbolName(symbolLine) ?? "unknown";
          stale.push({
            symbolName: name,
            filePath,
            docLine: block.startLine + 1,
            lastCodeChange:
              "@returns documented but function returns void",
          });
        }
      }
    }

    // Git log based staleness
    if (gitLog) {
      const gitStale = this.detectGitBasedStaleness(
        content,
        filePath,
        gitLog,
      );
      stale.push(...gitStale);
    }

    return stale;
  }

  // ─── Generation ──────────────────────────────────────────────

  /**
   * Generate a JSDoc comment for a function/method code snippet.
   *
   * Parses the function signature and produces a template with
   * @param, @returns, @throws, and @example tags.
   *
   * @param functionCode - The function source code
   * @param context - Optional surrounding context for better descriptions
   * @returns Generated JSDoc string
   */
  generateJSDoc(functionCode: string, context?: string): string {
    const parsed = this.parseFunctionSignature(functionCode);
    if (!parsed) {
      // Try class/interface/type
      return this.generateGenericDoc(functionCode);
    }

    const tags = this.config.templateStyle === "tsdoc" ? TSDOC_TAGS : JSDOC_TAGS;
    const lines: string[] = ["/**"];

    // Description placeholder
    const description = this.inferDescription(parsed, context);
    lines.push(` * ${description}`);

    // Generic params
    if (parsed.genericParams) {
      lines.push(` *`);
      const generics = this.parseGenericParams(parsed.genericParams);
      for (const g of generics) {
        lines.push(` * @typeParam ${g} - TODO: describe type parameter`);
      }
    }

    // Params
    if (parsed.params.length > 0) {
      lines.push(` *`);
      for (const param of parsed.params) {
        const typeStr = param.type ? ` {${param.type}}` : "";
        const optStr = param.optional ? " (optional)" : "";
        const defaultStr = param.defaultValue
          ? ` (default: ${param.defaultValue})`
          : "";
        const restStr = param.rest ? "..." : "";
        lines.push(
          ` * ${tags.param}${typeStr} ${restStr}${param.name} - TODO: describe${optStr}${defaultStr}`,
        );
      }
    }

    // Returns
    if (parsed.returnType && parsed.returnType.trim() !== "void") {
      lines.push(` * ${tags.returns} {${parsed.returnType.trim()}} TODO: describe return value`);
    }

    // Throws placeholder
    if (this.mightThrow(functionCode)) {
      lines.push(` * ${tags.throws} {Error} TODO: describe when this throws`);
    }

    // Example
    lines.push(` *`);
    lines.push(` * ${tags.example}`);
    lines.push(` * \`\`\`typescript`);
    lines.push(` * ${this.generateExampleCall(parsed)}`);
    lines.push(` * \`\`\``);

    lines.push(` */`);
    return lines.join("\n");
  }

  /**
   * Generate a README document from project information.
   *
   * Creates sections: Overview, Installation, Usage, API Reference,
   * Configuration, and License.
   *
   * @param projectInfo - Project metadata and structure
   * @returns Generated README document
   */
  generateReadme(projectInfo: ProjectInfo): GeneratedDoc {
    const sections: string[] = [];
    const pkg = projectInfo.packageJson;

    // Title
    sections.push(`# ${projectInfo.name}`);
    sections.push("");
    if (projectInfo.description) {
      sections.push(projectInfo.description);
      sections.push("");
    }

    // Badges
    const version = pkg.version as string | undefined;
    if (version) {
      sections.push(
        `![Version](https://img.shields.io/badge/version-${version}-blue)`,
      );
      sections.push("");
    }

    // Overview
    sections.push("## Overview");
    sections.push("");
    sections.push(
      projectInfo.description || "TODO: Add project overview.",
    );
    sections.push("");

    // Installation
    sections.push("## Installation");
    sections.push("");
    const pkgManager = pkg.packageManager
      ? String(pkg.packageManager).split("@")[0]
      : "npm";
    sections.push("```bash");
    if (pkgManager === "pnpm") {
      sections.push(`pnpm add ${projectInfo.name}`);
    } else if (pkgManager === "yarn") {
      sections.push(`yarn add ${projectInfo.name}`);
    } else {
      sections.push(`npm install ${projectInfo.name}`);
    }
    sections.push("```");
    sections.push("");

    // Usage
    sections.push("## Usage");
    sections.push("");
    sections.push("```typescript");
    sections.push(`import { /* ... */ } from "${projectInfo.name}";`);
    sections.push("");
    sections.push("// TODO: Add usage examples");
    sections.push("```");
    sections.push("");

    // API Reference
    sections.push("## API Reference");
    sections.push("");
    const srcExts = [".ts", ".tsx", ".js", ".jsx"];
    const mainFiles = projectInfo.srcFiles.filter(
      (f) =>
        srcExts.includes(extname(f)) &&
        !f.includes(".test.") &&
        !f.includes(".spec.") &&
        !f.includes("__tests__"),
    );
    if (mainFiles.length > 0) {
      sections.push("### Modules");
      sections.push("");
      for (const f of mainFiles.slice(0, 20)) {
        const name = basename(f, extname(f));
        sections.push(`- \`${name}\` — TODO: describe`);
      }
      sections.push("");
    } else {
      sections.push("TODO: Add API reference.");
      sections.push("");
    }

    // CLI section
    if (projectInfo.hasCLI) {
      sections.push("## CLI");
      sections.push("");
      const binEntry = pkg.bin;
      if (binEntry && typeof binEntry === "object") {
        for (const [cmd] of Object.entries(
          binEntry as Record<string, string>,
        )) {
          sections.push(`### \`${cmd}\``);
          sections.push("");
          sections.push("```bash");
          sections.push(`${cmd} --help`);
          sections.push("```");
          sections.push("");
        }
      } else {
        sections.push("```bash");
        sections.push(`npx ${projectInfo.name} --help`);
        sections.push("```");
        sections.push("");
      }
    }

    // Configuration
    sections.push("## Configuration");
    sections.push("");
    sections.push("TODO: Add configuration documentation.");
    sections.push("");

    // Scripts
    const scripts = pkg.scripts as Record<string, string> | undefined;
    if (scripts && Object.keys(scripts).length > 0) {
      sections.push("## Development");
      sections.push("");
      sections.push("```bash");
      for (const [name, cmd] of Object.entries(scripts).slice(0, 10)) {
        sections.push(`# ${name}`);
        sections.push(`${pkgManager} run ${name}`);
        sections.push("");
      }
      sections.push("```");
      sections.push("");
    }

    // License
    const license = pkg.license as string | undefined;
    if (license) {
      sections.push("## License");
      sections.push("");
      sections.push(`${license}`);
      sections.push("");
    }

    const readmePath = join(this.config.projectPath, "README.md");
    return {
      type: "readme",
      content: sections.join("\n"),
      targetFile: readmePath,
      isNew: true, // Caller should check if file exists
    };
  }

  /**
   * Generate a changelog entry from a list of commits.
   *
   * Parses conventional commit messages and groups them by type.
   * Determines the recommended semver bump based on commit types.
   *
   * @param commits - List of commit information
   * @returns Structured changelog entry
   */
  generateChangelog(commits: CommitInfo[]): ChangelogEntry {
    const sections: ChangelogEntry["sections"] = {
      breaking: [],
      features: [],
      fixes: [],
      refactors: [],
      docs: [],
      other: [],
    };

    let hasBreaking = false;
    let hasFeature = false;

    for (const commit of commits) {
      const parsed = this.parseConventionalCommit(commit.message);

      if (!parsed) {
        // Non-conventional commit
        sections.other.push(commit.message.split("\n")[0]);
        continue;
      }

      const scope = parsed.scope ? `**${parsed.scope}**: ` : "";
      const entry = `${scope}${parsed.description} (${commit.hash.slice(0, 7)})`;

      if (parsed.breaking) {
        hasBreaking = true;
        sections.breaking.push(entry);
      }

      switch (parsed.type) {
        case "feat":
          hasFeature = true;
          sections.features.push(entry);
          break;
        case "fix":
          sections.fixes.push(entry);
          break;
        case "refactor":
        case "perf":
          sections.refactors.push(entry);
          break;
        case "docs":
          sections.docs.push(entry);
          break;
        default:
          sections.other.push(entry);
          break;
      }
    }

    const semverBump: ChangelogEntry["semverBump"] = hasBreaking
      ? "major"
      : hasFeature
        ? "minor"
        : "patch";

    const today = new Date().toISOString().slice(0, 10);

    return {
      version: "Unreleased",
      date: today,
      sections,
      semverBump,
    };
  }

  /**
   * Generate an API reference document from exported symbols.
   *
   * Creates a markdown document with sections for each export type
   * (functions, classes, interfaces, types, enums, constants).
   *
   * @param exports - List of exported symbol information
   * @returns Generated API reference document
   */
  generateAPIReference(exports: ExportInfo[]): GeneratedDoc {
    const sections: string[] = [];
    sections.push("# API Reference");
    sections.push("");

    // Group by type
    const grouped = new Map<ExportInfo["type"], ExportInfo[]>();
    for (const exp of exports) {
      const list = grouped.get(exp.type) ?? [];
      list.push(exp);
      grouped.set(exp.type, list);
    }

    // Render order
    const order: ExportInfo["type"][] = [
      "class",
      "function",
      "interface",
      "type",
      "enum",
      "const",
    ];
    const typeLabels: Record<ExportInfo["type"], string> = {
      class: "Classes",
      function: "Functions",
      interface: "Interfaces",
      type: "Type Aliases",
      enum: "Enums",
      const: "Constants",
    };

    for (const type of order) {
      const items = grouped.get(type);
      if (!items || items.length === 0) continue;

      sections.push(`## ${typeLabels[type]}`);
      sections.push("");

      for (const item of items) {
        sections.push(`### \`${item.name}\``);
        sections.push("");

        // File location
        sections.push(
          `> Defined in \`${item.filePath}\` (line ${item.line})`,
        );
        sections.push("");

        // Signature
        sections.push("```typescript");
        sections.push(item.signature);
        sections.push("```");
        sections.push("");

        // Existing doc
        if (item.docContent) {
          // Extract description from JSDoc
          const desc = item.docContent
            .replace(/\/\*\*|\*\//g, "")
            .replace(/^\s*\*\s?/gm, "")
            .replace(/@\w+.*$/gm, "")
            .trim();
          if (desc) {
            sections.push(desc);
            sections.push("");
          }
        }

        sections.push("---");
        sections.push("");
      }
    }

    const refPath = join(this.config.projectPath, "docs", "API.md");
    return {
      type: "api-reference",
      content: sections.join("\n"),
      targetFile: refPath,
      isNew: true,
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────

  /**
   * Parse all exported symbols from a file's content.
   *
   * Uses regex patterns to detect functions, classes, interfaces,
   * type aliases, enums, and const exports. Checks whether each
   * symbol has a preceding JSDoc comment.
   *
   * @param content - File content
   * @param filePath - File path (for reporting)
   * @returns List of exported symbols
   */
  parseExports(content: string, filePath: string): ExportInfo[] {
    const exports: ExportInfo[] = [];
    const lines = content.split("\n");

    // Helper: check if line has preceding JSDoc
    const hasJSDoc = (lineIdx: number): { has: boolean; doc?: string } => {
      if (lineIdx <= 0) return { has: false };

      // Walk backwards to find JSDoc end (*/)
      let idx = lineIdx - 1;
      while (idx >= 0 && lines[idx].trim() === "") {
        idx--;
      }
      if (idx < 0) return { has: false };

      const endLine = lines[idx].trim();
      if (!endLine.endsWith("*/")) return { has: false };

      // Find JSDoc start (/**)
      let startIdx = idx;
      while (startIdx >= 0 && !lines[startIdx].includes("/**")) {
        startIdx--;
      }
      if (startIdx < 0) return { has: false };

      const docLines = lines.slice(startIdx, idx + 1);
      return { has: true, doc: docLines.join("\n") };
    };

    // Extract exports of each type
    this.extractWithRegex(
      content,
      RE_EXPORT_FUNCTION,
      lines,
      "function",
      (match, lineNum) => {
        const name = match[2];
        const generics = match[3] ? `<${match[3]}>` : "";
        const params = match[4];
        const returnType = match[5] ?? "";
        const isAsync = match[0].includes("async ");
        const generator = match[1] === "*" ? "*" : "";
        const asyncStr = isAsync ? "async " : "";
        const retStr = returnType ? `: ${returnType.trim()}` : "";
        const sig = `${asyncStr}function ${generator}${name}${generics}(${params})${retStr}`;

        const doc = hasJSDoc(lineNum);
        exports.push({
          name,
          type: "function",
          filePath,
          line: lineNum + 1,
          signature: sig,
          hasDoc: doc.has,
          docContent: doc.doc,
        });
      },
      this.config.includePrivate,
    );

    this.extractWithRegex(
      content,
      RE_EXPORT_CLASS,
      lines,
      "class",
      (match, lineNum) => {
        const name = match[1];
        const generics = match[2] ? `<${match[2]}>` : "";
        const ext = match[3] ? ` extends ${match[3]}` : "";
        const impl = match[4] ? ` implements ${match[4].trim()}` : "";
        const abstract = match[0].includes("abstract ") ? "abstract " : "";
        const sig = `${abstract}class ${name}${generics}${ext}${impl}`;

        const doc = hasJSDoc(lineNum);
        exports.push({
          name,
          type: "class",
          filePath,
          line: lineNum + 1,
          signature: sig,
          hasDoc: doc.has,
          docContent: doc.doc,
        });
      },
      this.config.includePrivate,
    );

    this.extractWithRegex(
      content,
      RE_EXPORT_INTERFACE,
      lines,
      "interface",
      (match, lineNum) => {
        const name = match[1];
        const generics = match[2] ? `<${match[2]}>` : "";
        const ext = match[3] ? ` extends ${match[3].trim()}` : "";
        const sig = `interface ${name}${generics}${ext}`;

        const doc = hasJSDoc(lineNum);
        exports.push({
          name,
          type: "interface",
          filePath,
          line: lineNum + 1,
          signature: sig,
          hasDoc: doc.has,
          docContent: doc.doc,
        });
      },
      this.config.includePrivate,
    );

    this.extractWithRegex(
      content,
      RE_EXPORT_TYPE,
      lines,
      "type",
      (match, lineNum) => {
        const name = match[1];
        const generics = match[2] ? `<${match[2]}>` : "";
        const value = match[3].trim();
        const sig = `type ${name}${generics} = ${value}`;

        const doc = hasJSDoc(lineNum);
        exports.push({
          name,
          type: "type",
          filePath,
          line: lineNum + 1,
          signature: sig,
          hasDoc: doc.has,
          docContent: doc.doc,
        });
      },
      this.config.includePrivate,
    );

    this.extractWithRegex(
      content,
      RE_EXPORT_ENUM,
      lines,
      "enum",
      (match, lineNum) => {
        const name = match[1];
        const isConst = match[0].includes("const ");
        const sig = `${isConst ? "const " : ""}enum ${name}`;

        const doc = hasJSDoc(lineNum);
        exports.push({
          name,
          type: "enum",
          filePath,
          line: lineNum + 1,
          signature: sig,
          hasDoc: doc.has,
          docContent: doc.doc,
        });
      },
      this.config.includePrivate,
    );

    this.extractWithRegex(
      content,
      RE_EXPORT_CONST,
      lines,
      "const",
      (match, lineNum) => {
        const name = match[1];
        const typeAnnotation = match[2] ? `: ${match[2].trim()}` : "";
        const sig = `const ${name}${typeAnnotation}`;

        const doc = hasJSDoc(lineNum);
        exports.push({
          name,
          type: "const",
          filePath,
          line: lineNum + 1,
          signature: sig,
          hasDoc: doc.has,
          docContent: doc.doc,
        });
      },
      this.config.includePrivate,
    );

    return exports;
  }

  /**
   * Parse a conventional commit message.
   *
   * Supports the format: `type(scope)!: description`
   * where scope and `!` (breaking) are optional.
   *
   * @param message - Commit message (first line)
   * @returns Parsed commit or null if not conventional format
   */
  parseConventionalCommit(message: string): ParsedCommit | null {
    const firstLine = message.split("\n")[0].trim();
    const match = firstLine.match(RE_CONVENTIONAL_COMMIT);
    if (!match) return null;

    const type = match[1];
    const scope = match[2] || undefined;
    const bangBreaking = match[3] === "!";
    const description = match[4];

    // Check body for BREAKING CHANGE footer
    const bodyLines = message.split("\n").slice(1).join("\n").trim();
    const footerBreaking = bodyLines.includes("BREAKING CHANGE:");

    return {
      type,
      scope,
      description,
      breaking: bangBreaking || footerBreaking,
      body: bodyLines || undefined,
    };
  }

  /**
   * Grade documentation quality based on coverage metrics.
   *
   * Grading scale:
   * - A: >= 90% coverage
   * - B: >= 75% coverage
   * - C: >= 60% coverage
   * - D: >= 40% coverage
   * - F: < 40% coverage
   *
   * Stale docs reduce the grade by one level per 10 stale entries.
   *
   * @param coverage - Documentation coverage data
   * @returns Documentation grade
   */
  gradeDocumentation(coverage: DocCoverage): DocCoverage["grade"] {
    let effectivePercent = coverage.coveragePercent;

    // Penalize for stale docs (each stale entry reduces effective coverage by 2%)
    const stalePenalty = Math.min(coverage.stale.length * 2, 20);
    effectivePercent = Math.max(0, effectivePercent - stalePenalty);

    if (effectivePercent >= GRADE_THRESHOLDS.A) return "A";
    if (effectivePercent >= GRADE_THRESHOLDS.B) return "B";
    if (effectivePercent >= GRADE_THRESHOLDS.C) return "C";
    if (effectivePercent >= GRADE_THRESHOLDS.D) return "D";
    return "F";
  }

  // ─── Private: Regex Extraction ─────────────────────────────

  /**
   * Execute a regex against content and invoke callback for each match.
   * If includePrivate is false, only matches that start with `export` are included.
   */
  private extractWithRegex(
    content: string,
    regex: RegExp,
    lines: string[],
    _type: string,
    callback: (match: RegExpExecArray, lineNum: number) => void,
    includePrivate: boolean,
  ): void {
    // Reset regex state
    const re = new RegExp(regex.source, regex.flags);
    let match: RegExpExecArray | null;

    while ((match = re.exec(content)) !== null) {
      // Check export keyword
      if (!includePrivate && !match[0].startsWith("export")) {
        continue;
      }

      // Calculate line number
      const lineNum = content.slice(0, match.index).split("\n").length - 1;
      callback(match, lineNum);
    }
  }

  // ─── Private: Function Parsing ─────────────────────────────

  /**
   * Parse a function/method signature from code.
   */
  private parseFunctionSignature(code: string): ParsedFunction | null {
    // Named function
    const funcMatch = code.match(
      /(?:export\s+)?(?:async\s+)?function\s*(\*?)\s*(\w+)\s*(?:<([^>]+)>)?\s*\(([^)]*)\)(?:\s*:\s*([^\n{]+))?/,
    );
    if (funcMatch) {
      return {
        name: funcMatch[2],
        params: this.parseParams(funcMatch[4]),
        returnType: funcMatch[5]?.trim() ?? "void",
        isAsync: code.trimStart().startsWith("async") || /\basync\s+function\b/.test(code),
        isGenerator: funcMatch[1] === "*",
        genericParams: funcMatch[3],
      };
    }

    // Arrow function
    const arrowMatch = code.match(
      /(?:export\s+)?(?:const|let)\s+(\w+)(?:\s*:\s*([^\n=]+))?\s*=\s*(async\s+)?\(([^)]*)\)(?:\s*:\s*([^\n=>{]+))?\s*=>/,
    );
    if (arrowMatch) {
      return {
        name: arrowMatch[1],
        params: this.parseParams(arrowMatch[4]),
        returnType: arrowMatch[5]?.trim() ?? "void",
        isAsync: !!arrowMatch[3],
        isGenerator: false,
      };
    }

    // Method
    const methodMatch = code.match(
      /^\s*(?:(?:public|private|protected|static|async|readonly)\s+)*(\w+)\s*(?:<([^>]+)>)?\s*\(([^)]*)\)(?:\s*:\s*([^\n{]+))?/m,
    );
    if (methodMatch) {
      return {
        name: methodMatch[1],
        params: this.parseParams(methodMatch[3]),
        returnType: methodMatch[4]?.trim() ?? "void",
        isAsync: /\basync\b/.test(code.slice(0, code.indexOf(methodMatch[1]))),
        isGenerator: false,
        genericParams: methodMatch[2],
      };
    }

    return null;
  }

  /**
   * Parse function parameters from a parameter string.
   */
  private parseParams(paramsStr: string): ParsedParam[] {
    if (!paramsStr.trim()) return [];

    const params: ParsedParam[] = [];
    // Split respecting nested generics and destructuring
    const parts = this.splitParams(paramsStr);

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      const rest = trimmed.startsWith("...");
      const cleaned = rest ? trimmed.slice(3) : trimmed;

      // Check for default value
      const eqIdx = this.findTopLevelChar(cleaned, "=");
      let nameAndType = cleaned;
      let defaultValue: string | undefined;
      if (eqIdx !== -1) {
        nameAndType = cleaned.slice(0, eqIdx).trim();
        defaultValue = cleaned.slice(eqIdx + 1).trim();
      }

      // Check for optional marker and type annotation
      const colonIdx = this.findTopLevelChar(nameAndType, ":");
      let name: string;
      let type = "";
      let optional = false;

      if (colonIdx !== -1) {
        name = nameAndType.slice(0, colonIdx).trim();
        type = nameAndType.slice(colonIdx + 1).trim();
      } else {
        name = nameAndType.trim();
      }

      if (name.endsWith("?")) {
        optional = true;
        name = name.slice(0, -1);
      }

      if (defaultValue !== undefined) {
        optional = true;
      }

      params.push({ name, type, optional, defaultValue, rest });
    }

    return params;
  }

  /**
   * Split parameter string respecting nested brackets/generics.
   */
  private splitParams(str: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = "";

    for (const ch of str) {
      if (ch === "(" || ch === "<" || ch === "{" || ch === "[") {
        depth++;
        current += ch;
      } else if (ch === ")" || ch === ">" || ch === "}" || ch === "]") {
        depth--;
        current += ch;
      } else if (ch === "," && depth === 0) {
        parts.push(current);
        current = "";
      } else {
        current += ch;
      }
    }

    if (current.trim()) {
      parts.push(current);
    }

    return parts;
  }

  /**
   * Find a top-level character (not nested in brackets).
   */
  private findTopLevelChar(str: string, char: string): number {
    let depth = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === "(" || ch === "<" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === ">" || ch === "}" || ch === "]") depth--;
      else if (ch === char && depth === 0) return i;
    }
    return -1;
  }

  // ─── Private: JSDoc Parsing ────────────────────────────────

  /**
   * Find all JSDoc blocks in content, returning their position and parsed tags.
   */
  private findAllJSDocBlocks(content: string): JSDocAnalysis[] {
    const blocks: JSDocAnalysis[] = [];
    const lines = content.split("\n");

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim().startsWith("/**")) {
        const startLine = i;
        let endLine = i;

        // Find end of JSDoc
        while (endLine < lines.length && !lines[endLine].includes("*/")) {
          endLine++;
        }

        const docLines = lines.slice(startLine, endLine + 1);
        const docContent = docLines.join("\n");

        const analysis = this.analyzeJSDoc(docContent, startLine);
        // endLine for the symbol = the line after the closing */
        analysis.endLine = endLine + 1;
        blocks.push(analysis);

        i = endLine + 1;
      } else {
        i++;
      }
    }

    return blocks;
  }

  /**
   * Analyze a JSDoc comment block.
   */
  private analyzeJSDoc(docContent: string, startLine: number): JSDocAnalysis {
    const params = new Map<string, string>();
    const throws: string[] = [];
    const examples: string[] = [];
    let returns: string | undefined;
    let description = "";

    // Strip comment markers
    const cleaned = docContent
      .replace(/\/\*\*|\*\//g, "")
      .replace(/^\s*\*\s?/gm, "");

    // Extract description (text before first tag)
    const firstTagIdx = cleaned.search(/^@/m);
    if (firstTagIdx === -1) {
      description = cleaned.trim();
    } else {
      description = cleaned.slice(0, firstTagIdx).trim();
    }

    // Extract @param tags
    const paramMatches = cleaned.matchAll(
      /@param\s+(?:\{[^}]*\}\s+)?(\w+)\s*-?\s*(.*)/g,
    );
    for (const m of paramMatches) {
      params.set(m[1], m[2].trim());
    }

    // Extract @returns
    const returnsMatch = cleaned.match(/@returns?\s+(?:\{[^}]*\}\s+)?(.*)/);
    if (returnsMatch) {
      returns = returnsMatch[1].trim();
    }

    // Extract @throws
    const throwsMatches = cleaned.matchAll(
      /@throws?\s+(?:\{[^}]*\}\s+)?(.*)/g,
    );
    for (const m of throwsMatches) {
      throws.push(m[1].trim());
    }

    // Extract @example
    const exampleMatches = cleaned.matchAll(/@example\s*([\s\S]*?)(?=@\w|$)/g);
    for (const m of exampleMatches) {
      examples.push(m[1].trim());
    }

    return {
      exists: true,
      startLine,
      endLine: startLine, // Will be overridden by caller
      content: docContent,
      params,
      returns,
      throws,
      examples,
      description,
    };
  }

  // ─── Private: Generation Helpers ───────────────────────────

  /**
   * Infer a description from function name and context.
   */
  private inferDescription(
    parsed: ParsedFunction,
    context?: string,
  ): string {
    const name = parsed.name;

    // Common verb prefixes
    const verbMap: Record<string, string> = {
      get: "Get",
      set: "Set",
      is: "Check whether",
      has: "Check if there is",
      can: "Determine if",
      should: "Determine whether to",
      create: "Create",
      build: "Build",
      make: "Create",
      parse: "Parse",
      format: "Format",
      validate: "Validate",
      check: "Check",
      find: "Find",
      search: "Search for",
      filter: "Filter",
      map: "Transform",
      reduce: "Reduce",
      handle: "Handle",
      process: "Process",
      init: "Initialize",
      setup: "Set up",
      load: "Load",
      save: "Save",
      update: "Update",
      delete: "Delete",
      remove: "Remove",
      add: "Add",
      insert: "Insert",
      emit: "Emit",
      on: "Handle",
      render: "Render",
      fetch: "Fetch",
      send: "Send",
      receive: "Receive",
      convert: "Convert",
      transform: "Transform",
      extract: "Extract",
      merge: "Merge",
      split: "Split",
      sort: "Sort",
      compare: "Compare",
      calculate: "Calculate",
      compute: "Compute",
    };

    // Try to match a verb prefix
    for (const [prefix, verb] of Object.entries(verbMap)) {
      if (
        name.startsWith(prefix) &&
        name.length > prefix.length &&
        name[prefix.length] === name[prefix.length].toUpperCase()
      ) {
        const rest = name.slice(prefix.length);
        const words = this.camelToWords(rest);
        return `${verb} ${words.toLowerCase()}.`;
      }
    }

    // Fallback: split camelCase
    const words = this.camelToWords(name);
    return `TODO: describe ${words.toLowerCase()}.`;
  }

  /**
   * Convert camelCase/PascalCase to space-separated words.
   */
  private camelToWords(name: string): string {
    return name
      .replace(/([A-Z])/g, " $1")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .trim();
  }

  /**
   * Parse generic type parameters.
   */
  private parseGenericParams(str: string): string[] {
    return str.split(",").map((s) => {
      const trimmed = s.trim();
      // Extract just the name (before extends/=)
      const spaceIdx = trimmed.indexOf(" ");
      return spaceIdx !== -1 ? trimmed.slice(0, spaceIdx) : trimmed;
    });
  }

  /**
   * Check if function code might throw errors.
   */
  private mightThrow(code: string): boolean {
    return (
      /\bthrow\b/.test(code) ||
      /\bawait\b/.test(code) ||
      /\.catch\b/.test(code) ||
      /try\s*\{/.test(code)
    );
  }

  /**
   * Generate an example function call.
   */
  private generateExampleCall(parsed: ParsedFunction): string {
    const args = parsed.params
      .filter((p) => !p.optional)
      .map((p) => this.generateExampleValue(p))
      .join(", ");

    const asyncPrefix = parsed.isAsync ? "await " : "";
    return `const result = ${asyncPrefix}${parsed.name}(${args});`;
  }

  /**
   * Generate an example value for a parameter.
   */
  private generateExampleValue(param: ParsedParam): string {
    if (param.defaultValue) return param.defaultValue;

    const type = param.type.toLowerCase().trim();

    if (type === "string") return `"example"`;
    if (type === "number") return "42";
    if (type === "boolean") return "true";
    if (type.startsWith("map")) return "new Map()";
    if (type.startsWith("set")) return "new Set()";
    if (type.endsWith("[]") || type.startsWith("array")) return "[]";
    if (type.startsWith("record") || type === "object") return "{}";
    if (type === "function" || type.includes("=>")) return "() => {}";
    if (type === "null") return "null";
    if (type === "undefined") return "undefined";

    // Complex types: use placeholder
    return `/* ${param.name} */`;
  }

  /**
   * Generate a generic JSDoc for non-function symbols.
   */
  private generateGenericDoc(code: string): string {
    const lines: string[] = ["/**"];

    // Try to detect what kind of symbol this is
    if (/\bclass\s+(\w+)/.test(code)) {
      const name = code.match(/\bclass\s+(\w+)/)?.[1] ?? "Unknown";
      lines.push(` * ${name} — TODO: describe class.`);
    } else if (/\binterface\s+(\w+)/.test(code)) {
      const name = code.match(/\binterface\s+(\w+)/)?.[1] ?? "Unknown";
      lines.push(` * ${name} — TODO: describe interface.`);
    } else if (/\btype\s+(\w+)/.test(code)) {
      const name = code.match(/\btype\s+(\w+)/)?.[1] ?? "Unknown";
      lines.push(` * ${name} — TODO: describe type.`);
    } else if (/\benum\s+(\w+)/.test(code)) {
      const name = code.match(/\benum\s+(\w+)/)?.[1] ?? "Unknown";
      lines.push(` * ${name} — TODO: describe enum.`);
    } else {
      lines.push(` * TODO: add description.`);
    }

    lines.push(` */`);
    return lines.join("\n");
  }

  /**
   * Parse parameter names from a parameter string (simple extraction).
   */
  private parseParamNames(paramsStr: string): string[] {
    if (!paramsStr.trim()) return [];

    const parts = this.splitParams(paramsStr);
    return parts
      .map((p) => {
        const trimmed = p.trim().replace(/^\.\.\./, "");
        // Extract just the name (before : or =)
        const colonIdx = this.findTopLevelChar(trimmed, ":");
        const eqIdx = this.findTopLevelChar(trimmed, "=");
        let end = trimmed.length;
        if (colonIdx !== -1 && colonIdx < end) end = colonIdx;
        if (eqIdx !== -1 && eqIdx < end) end = eqIdx;
        return trimmed.slice(0, end).trim().replace(/\?$/, "");
      })
      .filter((n) => n.length > 0);
  }

  /**
   * Extract symbol name from a line of code.
   */
  private extractSymbolName(line: string): string | null {
    const match = line.match(
      /(?:function\s+\*?\s*|class\s+|interface\s+|type\s+|enum\s+|const\s+|let\s+|var\s+)(\w+)/,
    );
    return match?.[1] ?? null;
  }

  /**
   * Detect staleness using git log information.
   */
  private detectGitBasedStaleness(
    content: string,
    filePath: string,
    gitLog: string,
  ): DocStale[] {
    const stale: DocStale[] = [];

    // Parse git log for function names that changed
    // Expected format: lines like "M  src/file.ts:functionName"
    // or standard git log --name-status output
    const changedFunctions = new Set<string>();
    const logLines = gitLog.split("\n");

    for (const logLine of logLines) {
      // Look for function names mentioned in commit messages
      const funcRefs = logLine.match(/\b([a-z][a-zA-Z]+)\s*\(/g);
      if (funcRefs) {
        for (const ref of funcRefs) {
          const name = ref.replace(/\s*\($/, "");
          changedFunctions.add(name);
        }
      }
    }

    // Check if any documented functions were mentioned in git log
    if (changedFunctions.size > 0) {
      const jsdocBlocks = this.findAllJSDocBlocks(content);
      const lines = content.split("\n");

      for (const block of jsdocBlocks) {
        if (block.endLine < lines.length) {
          const symbolName = this.extractSymbolName(lines[block.endLine]);
          if (symbolName && changedFunctions.has(symbolName)) {
            stale.push({
              symbolName,
              filePath,
              docLine: block.startLine + 1,
              lastCodeChange: `Function '${symbolName}' appears in recent git changes — doc may need update`,
            });
          }
        }
      }
    }

    return stale;
  }

  /**
   * Format a changelog entry as markdown text.
   *
   * @param entry - Changelog entry to format
   * @returns Formatted markdown string
   */
  formatChangelog(entry: ChangelogEntry): string {
    const lines: string[] = [];

    if (this.config.changelogFormat === "keepachangelog") {
      lines.push(`## [${entry.version}] - ${entry.date}`);
    } else {
      lines.push(`# ${entry.version} (${entry.date})`);
    }
    lines.push("");

    const sectionMap: Array<[keyof ChangelogEntry["sections"], string]> = [
      ["breaking", "BREAKING CHANGES"],
      ["features", "Features"],
      ["fixes", "Bug Fixes"],
      ["refactors", "Refactoring"],
      ["docs", "Documentation"],
      ["other", "Other"],
    ];

    for (const [key, title] of sectionMap) {
      const items = entry.sections[key];
      if (items.length === 0) continue;

      lines.push(`### ${title}`);
      lines.push("");
      for (const item of items) {
        lines.push(`- ${item}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}
