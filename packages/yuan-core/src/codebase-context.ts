/**
 * @module codebase-context
 * @description Codebase Context Engine — indexes TypeScript/JavaScript projects,
 * extracts symbols, builds call graphs, and provides semantic search + blast radius analysis.
 *
 * Uses regex-based AST analysis (no ts-morph dependency). Designed for the YUAN coding agent
 * to understand project structure before making changes.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve, extname, relative } from "node:path";
import type { ImportRef } from "./dependency-analyzer.js";
import { LanguageSupport } from "./language-support.js";
import type { SupportedLanguage, LanguagePatterns } from "./language-support.js";

// ─── Types ───

/** Information about a function/method parameter. */
export interface ParamInfo {
  /** Parameter name */
  name: string;
  /** TypeScript type annotation */
  type: string;
  /** Whether the parameter is optional (has `?`) */
  optional: boolean;
  /** Default value expression, if any */
  defaultValue?: string;
}

/** A symbol extracted from source code. */
export interface SymbolInfo {
  /** Symbol name */
  name: string;
  /** Symbol kind */
  kind: "function" | "class" | "interface" | "type" | "enum" | "variable" | "method";
  /** Absolute file path where the symbol is defined */
  file: string;
  /** Start line number (1-based) */
  line: number;
  /** End line number (1-based, estimated) */
  endLine: number;
  /** Parameters (for functions/methods) */
  params?: ParamInfo[];
  /** Return type annotation (for functions/methods) */
  returnType?: string;
  /** Superclass name (for classes) */
  extends?: string;
  /** Implemented interfaces (for classes) */
  implements?: string[];
  /** Members (for classes/interfaces) */
  members?: SymbolInfo[];
  /** Whether the symbol is exported */
  exported: boolean;
  /** Whether this is a default export */
  isDefault: boolean;
  /** Whether the function/method is async */
  isAsync: boolean;
  /** JSDoc comment, if present */
  jsdoc?: string;
}

/** A directed edge in the call graph. */
export interface CallEdge {
  /** Caller identifier: "file:functionName" */
  caller: string;
  /** Callee identifier: "file:functionName" or "external:moduleName" */
  callee: string;
  /** Line number of the call site */
  line: number;
  /** Absolute file path containing the call */
  file: string;
}

/** Complete analysis of a single source file. */
export interface FileAnalysis {
  /** Absolute file path */
  file: string;
  /** Detected language */
  language: "typescript" | "javascript" | SupportedLanguage;
  /** Symbols defined in this file */
  symbols: SymbolInfo[];
  /** Import references */
  imports: ImportRef[];
  /** Exported symbol names */
  exports: string[];
  /** Call edges originating from this file */
  callEdges: CallEdge[];
  /** Complexity metrics */
  complexity: {
    /** Cyclomatic complexity estimate */
    cyclomatic: number;
    /** Cognitive complexity (nesting-aware) */
    cognitive: number;
    /** Lines of code (non-blank, non-comment) */
    loc: number;
    /** Blank line count */
    blankLines: number;
    /** Comment line count */
    commentLines: number;
    /** Number of import dependencies */
    dependencies: number;
  };
}

/** Full codebase index — the primary data structure. */
export interface CodebaseIndex {
  /** Per-file analysis results */
  files: Map<string, FileAnalysis>;
  /** Symbol name → all matching SymbolInfo across the codebase */
  symbolTable: Map<string, SymbolInfo[]>;
  /** All call edges across the codebase */
  callGraph: CallEdge[];
  /** Epoch ms when the index was last built */
  lastIndexedAt: number;
  /** Total number of indexed files */
  totalFiles: number;
  /** Total number of extracted symbols */
  totalSymbols: number;
}

/** A search result from semantic symbol search. */
export interface SemanticSearchResult {
  /** Matched symbol */
  symbol: SymbolInfo;
  /** File containing the symbol */
  file: string;
  /** Relevance score (0–1) */
  relevance: number;
  /** Code snippet around the symbol */
  snippet: string;
}

/** Blast radius analysis for a file change. */
export interface BlastRadiusResult {
  /** Files that directly import the changed file */
  directDependents: string[];
  /** Files transitively affected */
  transitiveDependents: string[];
  /** Test files that may be affected */
  affectedTests: string[];
  /** Exported symbols from the changed file */
  affectedExports: string[];
  /** Overall risk assessment */
  riskLevel: "low" | "medium" | "high";
}

/** A file related through the import graph. */
export interface RelatedFile {
  /** Absolute file path */
  path: string;
  /** How this file is related to the queried file */
  relation: "imports" | "imported_by" | "co_changed";
  /** Distance in the import graph from the queried file */
  depth: number;
}

/** An entry in a call chain search result. */
export interface CallChainEntry {
  /** Absolute file path containing the call */
  file: string;
  /** Line number of the call site (1-based) */
  line: number;
  /** Source line text around the call */
  context: string;
}

// ─── Constants ───

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SKIP_DIRS = new Set([
  "node_modules", "dist", ".git", "build", "coverage",
  ".next", ".turbo", "__pycache__", ".cache", ".output",
]);
const TEST_FILE_PATTERNS = [
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /__tests__\//,
  /\.stories\.[tj]sx?$/,
];

// ─── Regex patterns for symbol extraction ───

const FUNCTION_RE =
  /^(\/\*\*[\s\S]*?\*\/\s*)?(export\s+(?:default\s+)?)?(?:declare\s+)?(async\s+)?function\s*\*?\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?\s*\{/gm;

const ARROW_FUNCTION_RE =
  /^(\/\*\*[\s\S]*?\*\/\s*)?(export\s+(?:default\s+)?)?(const|let)\s+(\w+)\s*(?::\s*[^=]+?)?\s*=\s*(async\s+)?(?:\([^)]*\)|[^=>\s]+)\s*(?::\s*[^=]+?)?\s*=>/gm;

const CLASS_RE =
  /^(\/\*\*[\s\S]*?\*\/\s*)?(export\s+(?:default\s+)?)?(?:declare\s+)?(abstract\s+)?class\s+(\w+)(?:\s*<[^>]*>)?(?:\s+extends\s+(\w+(?:<[^>]*>)?))?(?:\s+implements\s+([^{]+))?\s*\{/gm;

const INTERFACE_RE =
  /^(\/\*\*[\s\S]*?\*\/\s*)?(export\s+(?:default\s+)?)?interface\s+(\w+)(?:\s*<[^>]*>)?(?:\s+extends\s+([^{]+))?\s*\{/gm;

const TYPE_ALIAS_RE =
  /^(\/\*\*[\s\S]*?\*\/\s*)?(export\s+(?:default\s+)?)?type\s+(\w+)(?:\s*<[^>]*>)?\s*=/gm;

const ENUM_RE =
  /^(\/\*\*[\s\S]*?\*\/\s*)?(export\s+(?:default\s+)?)?(const\s+)?enum\s+(\w+)\s*\{/gm;

const METHOD_RE =
  /^\s*(?:\/\*\*[\s\S]*?\*\/\s*)?(public|private|protected)?\s*(static\s+)?(async\s+)?(get|set)?\s*(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^{;]+))?\s*[{;]/gm;

// Import patterns (reused from dependency-analyzer style)
const IMPORT_RE =
  /import\s+(?:type\s+)?(?:\{([^}]*)\}|(\w+)|\*\s+as\s+(\w+))\s+from\s+["']([^"']+)["']/g;
const IMPORT_SIDE_EFFECT_RE = /import\s+["']([^"']+)["']/g;
const RE_EXPORT_RE = /export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;

const EXPORT_NAMED_RE =
  /export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|interface|type|enum)\s+(\w+)/g;
const EXPORT_DEFAULT_RE = /export\s+default\s+/g;
const EXPORT_LIST_RE = /export\s+\{([^}]*)\}(?!\s*from)/g;

// Call site detection (function calls within bodies)
const CALL_SITE_RE = /\b(\w+)\s*(?:<[^>]*>)?\s*\(/g;

// Built-in identifiers to skip in call graph
const BUILTIN_CALLS = new Set([
  "if", "for", "while", "switch", "catch", "return", "throw", "new", "typeof",
  "instanceof", "delete", "void", "await", "yield", "import", "require",
  "console", "Math", "JSON", "Object", "Array", "String", "Number", "Boolean",
  "Date", "RegExp", "Error", "Map", "Set", "Promise", "Symbol", "parseInt",
  "parseFloat", "isNaN", "isFinite", "setTimeout", "setInterval", "clearTimeout",
  "clearInterval", "fetch", "URL", "Buffer", "process",
]);

/**
 * Codebase Context Engine — indexes TypeScript/JavaScript projects and provides
 * symbol lookup, call graph analysis, blast radius estimation, and semantic search.
 *
 * @example
 * ```typescript
 * const ctx = new CodebaseContext("/path/to/project");
 * await ctx.buildIndex();
 *
 * const symbols = ctx.findSymbol("handleRequest");
 * const blast = ctx.getBlastRadius("/path/to/project/src/router.ts");
 * const results = ctx.searchSymbols("auth middleware", 5);
 * ```
 */
export class CodebaseContext {
  private index: CodebaseIndex;
  private projectPath: string;
  /** Cached file contents for snippet extraction */
  private fileContents: Map<string, string> = new Map();
  /** Reverse dependency map (file → files that import it) */
  private reverseDepMap: Map<string, Set<string>> = new Map();
  /** Optional multi-language support for non-TS/JS files */
  private languageSupport: LanguageSupport | null;

  constructor(projectPath: string, languageSupport?: LanguageSupport) {
    this.projectPath = resolve(projectPath);
    this.languageSupport = languageSupport ?? null;
    this.index = {
      files: new Map(),
      symbolTable: new Map(),
      callGraph: [],
      lastIndexedAt: 0,
      totalFiles: 0,
      totalSymbols: 0,
    };
  }

  // ─── Indexing ───

  /**
   * Build a full index of the project. Scans all source files,
   * extracts symbols, builds call graph, and creates the symbol table.
   *
   * @returns The complete codebase index
   */
  async buildIndex(): Promise<CodebaseIndex> {
    const files = await this.collectSourceFiles(this.projectPath);

    this.index.files.clear();
    this.index.symbolTable.clear();
    this.index.callGraph = [];
    this.fileContents.clear();
    this.reverseDepMap.clear();

    // Analyze all files
    for (const filePath of files) {
      try {
        const content = await readFile(filePath, "utf-8");
        this.fileContents.set(filePath, content);
        const analysis = this.analyzeFile(filePath, content);
        this.index.files.set(filePath, analysis);
      } catch {
        // Skip unreadable files
      }
    }

    // Build symbol table and call graph
    this.buildSymbolTable();
    this.buildCallGraph();
    this.buildReverseDependencyMap();

    this.index.lastIndexedAt = Date.now();
    this.index.totalFiles = this.index.files.size;
    this.index.totalSymbols = Array.from(this.index.symbolTable.values())
      .reduce((sum, arr) => sum + arr.length, 0);

    return this.index;
  }

  /**
   * Incrementally update the index for a single changed file.
   * Re-analyzes only that file and updates the symbol table.
   *
   * @param filePath - Absolute path of the changed file
   */
  async updateFile(filePath: string): Promise<void> {
    const absPath = resolve(filePath);
    try {
      const content = await readFile(absPath, "utf-8");
      this.fileContents.set(absPath, content);
      const analysis = this.analyzeFile(absPath, content);
      this.index.files.set(absPath, analysis);
    } catch {
      // File was deleted or unreadable — remove it
      this.removeFile(absPath);
      return;
    }

    // Rebuild symbol table and call graph
    this.buildSymbolTable();
    this.buildCallGraph();
    this.buildReverseDependencyMap();

    this.index.lastIndexedAt = Date.now();
    this.index.totalFiles = this.index.files.size;
    this.index.totalSymbols = Array.from(this.index.symbolTable.values())
      .reduce((sum, arr) => sum + arr.length, 0);
  }

  /**
   * Remove a file from the index (e.g., after deletion).
   *
   * @param filePath - Absolute path of the removed file
   */
  removeFile(filePath: string): void {
    const absPath = resolve(filePath);
    this.index.files.delete(absPath);
    this.fileContents.delete(absPath);

    // Rebuild derived structures
    this.buildSymbolTable();
    this.buildCallGraph();
    this.buildReverseDependencyMap();

    this.index.totalFiles = this.index.files.size;
    this.index.totalSymbols = Array.from(this.index.symbolTable.values())
      .reduce((sum, arr) => sum + arr.length, 0);
  }

  // ─── Symbol queries ───

  /**
   * Find all symbols matching the given name across the codebase.
   *
   * @param name - Symbol name to search for (exact match)
   * @returns Array of matching SymbolInfo
   */
  findSymbol(name: string): SymbolInfo[] {
    return this.index.symbolTable.get(name) ?? [];
  }

  /**
   * Find the symbol defined at a specific file and line.
   *
   * @param file - Absolute file path
   * @param line - Line number (1-based)
   * @returns The symbol at that location, or undefined
   */
  findSymbolAt(file: string, line: number): SymbolInfo | undefined {
    const absFile = resolve(file);
    const analysis = this.index.files.get(absFile);
    if (!analysis) return undefined;

    // Find the most specific (innermost) symbol containing this line
    let best: SymbolInfo | undefined;
    for (const sym of analysis.symbols) {
      if (line >= sym.line && line <= sym.endLine) {
        if (!best || (sym.endLine - sym.line) < (best.endLine - best.line)) {
          best = sym;
        }
      }
      // Also check members
      if (sym.members) {
        for (const member of sym.members) {
          if (line >= member.line && line <= member.endLine) {
            if (!best || (member.endLine - member.line) < (best.endLine - best.line)) {
              best = member;
            }
          }
        }
      }
    }
    return best;
  }

  /**
   * Find all symbols of a given kind across the codebase.
   *
   * @param kind - Symbol kind to filter by
   * @returns Array of matching SymbolInfo
   */
  findSymbolsByKind(kind: SymbolInfo["kind"]): SymbolInfo[] {
    const results: SymbolInfo[] = [];
    for (const symbols of this.index.symbolTable.values()) {
      for (const sym of symbols) {
        if (sym.kind === kind) results.push(sym);
      }
    }
    return results;
  }

  /**
   * Find all exported symbols in a specific file.
   *
   * @param file - Absolute file path
   * @returns Array of exported SymbolInfo
   */
  findExportedSymbols(file: string): SymbolInfo[] {
    const absFile = resolve(file);
    const analysis = this.index.files.get(absFile);
    if (!analysis) return [];
    return analysis.symbols.filter((s) => s.exported);
  }

  // ─── Relationship queries ───

  /**
   * Get all call edges where the given symbol is the callee.
   *
   * @param symbolName - Name of the called function/method
   * @param file - Optional file path to narrow the search
   * @returns Call edges targeting this symbol
   */
  getCallersOf(symbolName: string, file?: string): CallEdge[] {
    const suffix = file ? `${resolve(file)}:${symbolName}` : `:${symbolName}`;
    return this.index.callGraph.filter((edge) =>
      file ? edge.callee === suffix : edge.callee.endsWith(suffix),
    );
  }

  /**
   * Get all call edges originating from the given symbol.
   *
   * @param symbolName - Name of the calling function/method
   * @param file - Optional file path to narrow the search
   * @returns Call edges originating from this symbol
   */
  getCalleesOf(symbolName: string, file?: string): CallEdge[] {
    const suffix = file ? `${resolve(file)}:${symbolName}` : `:${symbolName}`;
    return this.index.callGraph.filter((edge) =>
      file ? edge.caller === suffix : edge.caller.endsWith(suffix),
    );
  }

  /**
   * Calculate the blast radius of changing a file — which files are affected,
   * which tests may break, and what's the risk level.
   *
   * @param file - Absolute file path being changed
   * @returns Blast radius analysis
   */
  getBlastRadius(file: string): BlastRadiusResult {
    const absFile = resolve(file);
    const analysis = this.index.files.get(absFile);

    // Direct dependents
    const directDeps = this.reverseDepMap.get(absFile);
    const directDependents = directDeps ? [...directDeps] : [];

    // Transitive dependents (BFS)
    const transitiveDependents = new Set<string>();
    const visited = new Set<string>([absFile]);
    const queue = [...directDependents];
    for (const d of directDependents) {
      visited.add(d);
      transitiveDependents.add(d);
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      const deps = this.reverseDepMap.get(current);
      if (!deps) continue;
      for (const dep of deps) {
        if (!visited.has(dep)) {
          visited.add(dep);
          transitiveDependents.add(dep);
          queue.push(dep);
        }
      }
    }

    // Filter test files
    const allAffected = [...transitiveDependents];
    const affectedTests = allAffected.filter((f) =>
      TEST_FILE_PATTERNS.some((p) => p.test(f)),
    );

    // Affected exports
    const affectedExports = analysis
      ? analysis.symbols.filter((s) => s.exported).map((s) => s.name)
      : [];

    // Risk level
    const totalAffected = transitiveDependents.size;
    let riskLevel: "low" | "medium" | "high";
    if (totalAffected <= 3 && affectedExports.length <= 2) {
      riskLevel = "low";
    } else if (totalAffected <= 10 || affectedExports.length <= 5) {
      riskLevel = "medium";
    } else {
      riskLevel = "high";
    }

    return {
      directDependents,
      transitiveDependents: allAffected,
      affectedTests,
      affectedExports,
      riskLevel,
    };
  }

  // ─── Relation API ───

  /**
   * Find files related to the given file through imports/exports.
   * Walks the import graph up to `maxDepth` hops.
   *
   * @param filePath - Absolute or project-relative path of the file
   * @param maxDepth - Maximum depth to walk (default 2)
   * @returns Array of related files with relation type and depth
   */
  async getRelatedFiles(filePath: string, maxDepth = 2): Promise<RelatedFile[]> {
    const absFile = resolve(filePath);
    const results: RelatedFile[] = [];
    const seen = new Set<string>([absFile]);
    const knownFiles = [...this.index.files.keys()];

    // BFS forward (files this file imports)
    const importQueue: { path: string; depth: number }[] = [];
    const analysis = this.index.files.get(absFile);
    if (analysis) {
      for (const imp of analysis.imports) {
        if (!imp.source.startsWith(".")) continue;
        const resolved = this.resolveImportPath(absFile, imp.source, knownFiles);
        if (resolved && !seen.has(resolved)) {
          seen.add(resolved);
          results.push({ path: resolved, relation: "imports", depth: 1 });
          importQueue.push({ path: resolved, depth: 1 });
        }
      }
    }

    // Continue BFS for deeper imports
    while (importQueue.length > 0) {
      const current = importQueue.shift()!;
      if (current.depth >= maxDepth) continue;
      const currentAnalysis = this.index.files.get(current.path);
      if (!currentAnalysis) continue;
      for (const imp of currentAnalysis.imports) {
        if (!imp.source.startsWith(".")) continue;
        const resolved = this.resolveImportPath(current.path, imp.source, knownFiles);
        if (resolved && !seen.has(resolved)) {
          seen.add(resolved);
          results.push({ path: resolved, relation: "imports", depth: current.depth + 1 });
          importQueue.push({ path: resolved, depth: current.depth + 1 });
        }
      }
    }

    // BFS reverse (files that import this file)
    const reverseQueue: { path: string; depth: number }[] = [];
    const directDeps = this.reverseDepMap.get(absFile);
    if (directDeps) {
      for (const dep of directDeps) {
        if (!seen.has(dep)) {
          seen.add(dep);
          results.push({ path: dep, relation: "imported_by", depth: 1 });
          reverseQueue.push({ path: dep, depth: 1 });
        }
      }
    }

    while (reverseQueue.length > 0) {
      const current = reverseQueue.shift()!;
      if (current.depth >= maxDepth) continue;
      const deps = this.reverseDepMap.get(current.path);
      if (!deps) continue;
      for (const dep of deps) {
        if (!seen.has(dep)) {
          seen.add(dep);
          results.push({ path: dep, relation: "imported_by", depth: current.depth + 1 });
          reverseQueue.push({ path: dep, depth: current.depth + 1 });
        }
      }
    }

    return results;
  }

  /**
   * Find where a function is called across the project.
   * Searches all indexed file contents for occurrences of the function name
   * that look like call sites.
   *
   * @param functionName - Name of the function to search for
   * @param filePath - File where the function is defined (excluded from results)
   * @returns Array of call chain entries with file, line, and context
   */
  async getCallChain(functionName: string, filePath: string): Promise<CallChainEntry[]> {
    const absFile = resolve(filePath);
    const results: CallChainEntry[] = [];
    const callPattern = new RegExp(`\\b${functionName}\\s*(?:<[^>]*>)?\\s*\\(`, "g");

    for (const [file, content] of this.fileContents) {
      if (file === absFile) continue;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (callPattern.test(lines[i])) {
          results.push({
            file,
            line: i + 1,
            context: lines[i].trim(),
          });
        }
        callPattern.lastIndex = 0;
      }
    }

    return results;
  }

  /**
   * Calculate the impact radius of a file — how many files depend on it
   * directly and transitively, with a risk score.
   *
   * @param filePath - Absolute or project-relative path of the file
   * @returns Direct/transitive dependent counts and a risk score
   */
  async getImpactRadius(filePath: string): Promise<{
    directDependents: number;
    transitiveDependents: number;
    riskScore: number;
  }> {
    const absFile = resolve(filePath);

    // Direct dependents
    const directDeps = this.reverseDepMap.get(absFile);
    const directCount = directDeps ? directDeps.size : 0;

    // Transitive dependents (BFS)
    const visited = new Set<string>([absFile]);
    const queue = directDeps ? [...directDeps] : [];
    for (const d of queue) visited.add(d);
    let transitiveCount = 0;

    while (queue.length > 0) {
      const current = queue.shift()!;
      transitiveCount++;
      const deps = this.reverseDepMap.get(current);
      if (!deps) continue;
      for (const dep of deps) {
        if (!visited.has(dep)) {
          visited.add(dep);
          queue.push(dep);
        }
      }
    }

    // Transitive count includes direct dependents; subtract to get only indirect
    const indirectCount = transitiveCount - directCount;

    return {
      directDependents: directCount,
      transitiveDependents: indirectCount,
      riskScore: directCount * 2 + indirectCount,
    };
  }

  // ─── Search ───

  /**
   * Search symbols by a query string using token-based fuzzy matching.
   * Splits the query into tokens and scores symbols by match count against
   * name, kind, file path, and JSDoc.
   *
   * @param query - Search query (space-separated tokens)
   * @param limit - Maximum results to return (default 10)
   * @returns Ranked search results with relevance scores
   */
  searchSymbols(query: string, limit = 10): SemanticSearchResult[] {
    const tokens = query
      .toLowerCase()
      .split(/[\s_\-./]+/)
      .filter((t) => t.length > 0);

    if (tokens.length === 0) return [];

    const scored: SemanticSearchResult[] = [];

    for (const [name, symbols] of this.index.symbolTable) {
      for (const sym of symbols) {
        const score = this.scoreSymbol(sym, name, tokens);
        if (score > 0) {
          scored.push({
            symbol: sym,
            file: sym.file,
            relevance: score,
            snippet: this.getSnippet(sym),
          });
        }
      }
    }

    // Sort by relevance descending, then by name
    scored.sort((a, b) => b.relevance - a.relevance || a.symbol.name.localeCompare(b.symbol.name));
    return scored.slice(0, limit);
  }

  /**
   * Search for symbols whose return type or type annotation matches a pattern.
   *
   * @param typePattern - Regex pattern to match against types
   * @returns Matching symbols
   */
  searchByType(typePattern: string): SymbolInfo[] {
    const re = new RegExp(typePattern, "i");
    const results: SymbolInfo[] = [];

    for (const symbols of this.index.symbolTable.values()) {
      for (const sym of symbols) {
        if (sym.returnType && re.test(sym.returnType)) {
          results.push(sym);
        }
        if (sym.params) {
          for (const param of sym.params) {
            if (re.test(param.type)) {
              results.push(sym);
              break;
            }
          }
        }
      }
    }

    return results;
  }

  // ─── File analysis ───

  /**
   * Get the analysis for a specific file.
   *
   * @param file - Absolute file path
   * @returns FileAnalysis or undefined if not indexed
   */
  getFileAnalysis(file: string): FileAnalysis | undefined {
    return this.index.files.get(resolve(file));
  }

  /**
   * Get files exceeding a cyclomatic complexity threshold.
   *
   * @param threshold - Minimum cyclomatic complexity (default 20)
   * @returns Files exceeding the threshold, sorted by complexity descending
   */
  getComplexFiles(threshold = 20): FileAnalysis[] {
    const results: FileAnalysis[] = [];
    for (const analysis of this.index.files.values()) {
      if (analysis.complexity.cyclomatic >= threshold) {
        results.push(analysis);
      }
    }
    results.sort((a, b) => b.complexity.cyclomatic - a.complexity.cyclomatic);
    return results;
  }

  /**
   * Identify hotspots — files with high complexity AND many dependents.
   *
   * @returns Hotspot entries sorted by combined score descending
   */
  getHotspots(): { file: string; complexity: number; dependencies: number }[] {
    const hotspots: { file: string; complexity: number; dependencies: number }[] = [];

    for (const [file, analysis] of this.index.files) {
      const deps = this.reverseDepMap.get(file);
      const depCount = deps ? deps.size : 0;
      hotspots.push({
        file,
        complexity: analysis.complexity.cyclomatic,
        dependencies: depCount,
      });
    }

    // Sort by combined score (complexity * log(deps+1))
    hotspots.sort((a, b) => {
      const scoreA = a.complexity * Math.log2(a.dependencies + 1);
      const scoreB = b.complexity * Math.log2(b.dependencies + 1);
      return scoreB - scoreA;
    });

    return hotspots;
  }

  // ─── Stats ───

  /**
   * Get summary statistics for the indexed codebase.
   *
   * @returns Aggregate stats
   */
  getStats(): { totalFiles: number; totalSymbols: number; avgComplexity: number } {
    let totalComplexity = 0;
    for (const analysis of this.index.files.values()) {
      totalComplexity += analysis.complexity.cyclomatic;
    }
    const avgComplexity = this.index.totalFiles > 0
      ? totalComplexity / this.index.totalFiles
      : 0;

    return {
      totalFiles: this.index.totalFiles,
      totalSymbols: this.index.totalSymbols,
      avgComplexity: Math.round(avgComplexity * 100) / 100,
    };
  }

  // ─── Private: File collection ───

  /**
   * Recursively collect all source files under a directory,
   * skipping excluded directories.
   */
  private async collectSourceFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          const sub = await this.collectSourceFiles(fullPath);
          results.push(...sub);
        }
      } else if (entry.isFile() && this.isSupportedSourceFile(entry.name)) {
        results.push(fullPath);
      }
    }
    return results;
  }

  // ─── Private: File support check ───

  /**
   * Check if a file is a supported source file.
   * Uses LanguageSupport for multi-language detection when available,
   * otherwise falls back to built-in TS/JS extensions.
   */
  private isSupportedSourceFile(fileName: string): boolean {
    const ext = extname(fileName);
    if (SOURCE_EXTENSIONS.has(ext)) return true;
    if (this.languageSupport) {
      const lang = this.languageSupport.detectLanguage(fileName);
      return lang !== "unknown";
    }
    return false;
  }

  // ─── Private: File analysis ───

  /**
   * Analyze a single source file — extract symbols, imports, exports,
   * and compute complexity metrics.
   *
   * When LanguageSupport is available and the file is not TS/JS,
   * uses language-specific patterns for symbol extraction.
   */
  private analyzeFile(filePath: string, content: string): FileAnalysis {
    const ext = extname(filePath);
    const isTsJs = ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx";

    // Detect language — use LanguageSupport when available, fallback to TS/JS
    let language: FileAnalysis["language"];
    if (isTsJs) {
      language = ext === ".ts" || ext === ".tsx" ? "typescript" : "javascript";
    } else if (this.languageSupport) {
      language = this.languageSupport.detectLanguage(filePath, content);
    } else {
      language = "javascript"; // shouldn't happen, but safe fallback
    }

    const lines = content.split("\n");

    // For TS/JS files or when LanguageSupport is unavailable, use built-in extraction
    // For other languages, use LanguageSupport patterns for basic symbol extraction
    let symbols: SymbolInfo[];
    if (isTsJs || !this.languageSupport) {
      symbols = this.extractSymbols(filePath, content, lines);
    } else {
      symbols = this.extractSymbolsWithLanguageSupport(filePath, content, lines, language as SupportedLanguage);
    }

    const imports = this.extractImports(content);
    const exports = this.extractExports(content);
    const callEdges = this.extractCallEdges(filePath, content, lines, symbols);
    const complexity = this.computeComplexity(content, lines, imports.length);

    return { file: filePath, language, symbols, imports, exports, callEdges, complexity };
  }

  /**
   * Extract all symbol definitions from file content using regex patterns.
   */
  private extractSymbols(filePath: string, content: string, lines: string[]): SymbolInfo[] {
    const symbols: SymbolInfo[] = [];
    const totalLines = lines.length;

    // ── Functions ──
    const funcRe = new RegExp(FUNCTION_RE.source, "gm");
    let match: RegExpExecArray | null;
    while ((match = funcRe.exec(content)) !== null) {
      const jsdoc = match[1]?.trim();
      const exportKeyword = match[2]?.trim() ?? "";
      const asyncKeyword = match[3]?.trim() ?? "";
      const name = match[4];
      const rawParams = match[5] ?? "";
      const returnType = match[6]?.trim();

      const line = this.getLineNumber(content, match.index);
      symbols.push({
        name,
        kind: "function",
        file: filePath,
        line,
        endLine: this.estimateEndLine(lines, line, totalLines),
        params: this.parseParams(rawParams),
        returnType: returnType || undefined,
        exported: exportKeyword.length > 0,
        isDefault: exportKeyword.includes("default"),
        isAsync: asyncKeyword === "async",
        jsdoc: jsdoc && jsdoc.startsWith("/**") ? this.cleanJsdoc(jsdoc) : undefined,
      });
    }

    // ── Arrow functions ──
    const arrowRe = new RegExp(ARROW_FUNCTION_RE.source, "gm");
    while ((match = arrowRe.exec(content)) !== null) {
      const jsdoc = match[1]?.trim();
      const exportKeyword = match[2]?.trim() ?? "";
      const name = match[4];
      const asyncKeyword = match[5]?.trim() ?? "";

      const line = this.getLineNumber(content, match.index);
      symbols.push({
        name,
        kind: "function",
        file: filePath,
        line,
        endLine: this.estimateEndLine(lines, line, totalLines),
        exported: exportKeyword.length > 0,
        isDefault: exportKeyword.includes("default"),
        isAsync: asyncKeyword === "async",
        jsdoc: jsdoc && jsdoc.startsWith("/**") ? this.cleanJsdoc(jsdoc) : undefined,
      });
    }

    // ── Classes ──
    const classRe = new RegExp(CLASS_RE.source, "gm");
    while ((match = classRe.exec(content)) !== null) {
      const jsdoc = match[1]?.trim();
      const exportKeyword = match[2]?.trim() ?? "";
      const name = match[4];
      const extendsName = match[5]?.replace(/<[^>]*>/, "").trim();
      const implementsRaw = match[6]?.trim();

      const line = this.getLineNumber(content, match.index);
      const endLine = this.estimateBlockEnd(lines, line, totalLines);

      // Extract class members
      const classBody = lines.slice(line - 1, endLine).join("\n");
      const members = this.extractClassMembers(filePath, classBody, line);

      symbols.push({
        name,
        kind: "class",
        file: filePath,
        line,
        endLine,
        extends: extendsName || undefined,
        implements: implementsRaw
          ? implementsRaw.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
        members: members.length > 0 ? members : undefined,
        exported: exportKeyword.length > 0,
        isDefault: exportKeyword.includes("default"),
        isAsync: false,
        jsdoc: jsdoc && jsdoc.startsWith("/**") ? this.cleanJsdoc(jsdoc) : undefined,
      });
    }

    // ── Interfaces ──
    const ifaceRe = new RegExp(INTERFACE_RE.source, "gm");
    while ((match = ifaceRe.exec(content)) !== null) {
      const jsdoc = match[1]?.trim();
      const exportKeyword = match[2]?.trim() ?? "";
      const name = match[3];

      const line = this.getLineNumber(content, match.index);
      symbols.push({
        name,
        kind: "interface",
        file: filePath,
        line,
        endLine: this.estimateBlockEnd(lines, line, totalLines),
        exported: exportKeyword.length > 0,
        isDefault: exportKeyword.includes("default"),
        isAsync: false,
        jsdoc: jsdoc && jsdoc.startsWith("/**") ? this.cleanJsdoc(jsdoc) : undefined,
      });
    }

    // ── Type aliases ──
    const typeRe = new RegExp(TYPE_ALIAS_RE.source, "gm");
    while ((match = typeRe.exec(content)) !== null) {
      const jsdoc = match[1]?.trim();
      const exportKeyword = match[2]?.trim() ?? "";
      const name = match[3];

      const line = this.getLineNumber(content, match.index);
      symbols.push({
        name,
        kind: "type",
        file: filePath,
        line,
        endLine: this.estimateTypeEnd(lines, line, totalLines),
        exported: exportKeyword.length > 0,
        isDefault: exportKeyword.includes("default"),
        isAsync: false,
        jsdoc: jsdoc && jsdoc.startsWith("/**") ? this.cleanJsdoc(jsdoc) : undefined,
      });
    }

    // ── Enums ──
    const enumRe = new RegExp(ENUM_RE.source, "gm");
    while ((match = enumRe.exec(content)) !== null) {
      const jsdoc = match[1]?.trim();
      const exportKeyword = match[2]?.trim() ?? "";
      const name = match[4];

      const line = this.getLineNumber(content, match.index);
      symbols.push({
        name,
        kind: "enum",
        file: filePath,
        line,
        endLine: this.estimateBlockEnd(lines, line, totalLines),
        exported: exportKeyword.length > 0,
        isDefault: exportKeyword.includes("default"),
        isAsync: false,
        jsdoc: jsdoc && jsdoc.startsWith("/**") ? this.cleanJsdoc(jsdoc) : undefined,
      });
    }

    return symbols;
  }

  /**
   * Extract symbols from non-TS/JS files using LanguageSupport patterns.
   * Provides basic function and class extraction for any language
   * that LanguageSupport has patterns for.
   *
   * Falls back to an empty array if patterns produce no matches — this is
   * safe because the caller only reaches here for non-TS/JS files.
   */
  private extractSymbolsWithLanguageSupport(
    filePath: string,
    content: string,
    lines: string[],
    language: SupportedLanguage,
  ): SymbolInfo[] {
    if (!this.languageSupport) return [];

    const symbols: SymbolInfo[] = [];
    const totalLines = lines.length;

    // Extract functions via LanguageSupport patterns
    const functions = this.languageSupport.extractFunctions(content, language);
    for (const fn of functions) {
      symbols.push({
        name: fn.name,
        kind: "function",
        file: filePath,
        line: fn.line,
        endLine: this.estimateEndLine(lines, fn.line, totalLines),
        params: fn.params ? this.parseParams(fn.params) : undefined,
        returnType: fn.returnType || undefined,
        exported: fn.visibility === "public" || fn.visibility === undefined,
        isDefault: false,
        isAsync: false,
      });
    }

    // Extract classes via LanguageSupport patterns
    const classes = this.languageSupport.extractClasses(content, language);
    for (const cls of classes) {
      symbols.push({
        name: cls.name,
        kind: "class",
        file: filePath,
        line: cls.line,
        endLine: this.estimateBlockEnd(lines, cls.line, totalLines),
        exported: cls.visibility === "public" || cls.visibility === undefined,
        isDefault: false,
        isAsync: false,
      });
    }

    // Extract interfaces if the language supports them
    const patterns = this.languageSupport.getPatterns(language);
    if (patterns.interface) {
      const ifaceRe = new RegExp(patterns.interface.source, patterns.interface.flags);
      let match: RegExpExecArray | null;
      while ((match = ifaceRe.exec(content)) !== null) {
        const name = match[1];
        if (!name) continue;
        const line = this.getLineNumber(content, match.index);
        symbols.push({
          name,
          kind: "interface",
          file: filePath,
          line,
          endLine: this.estimateBlockEnd(lines, line, totalLines),
          exported: true,
          isDefault: false,
          isAsync: false,
        });
      }
    }

    return symbols;
  }

  /**
   * Extract class method members from a class body.
   */
  private extractClassMembers(
    filePath: string,
    classBody: string,
    classStartLine: number,
  ): SymbolInfo[] {
    const members: SymbolInfo[] = [];
    const methodRe = new RegExp(METHOD_RE.source, "gm");
    let match: RegExpExecArray | null;

    while ((match = methodRe.exec(classBody)) !== null) {
      const name = match[5];
      // Skip constructor-like patterns and braces
      if (!name || name === "constructor" && false) {
        // include constructor
      }
      if (!name || /^[{}]$/.test(name)) continue;

      const asyncKeyword = match[3]?.trim() ?? "";
      const rawParams = match[6] ?? "";
      const returnType = match[7]?.trim();

      const localLine = this.getLineNumber(classBody, match.index);
      const absoluteLine = classStartLine + localLine - 1;

      members.push({
        name,
        kind: "method",
        file: filePath,
        line: absoluteLine,
        endLine: absoluteLine + 5, // rough estimate for methods
        params: this.parseParams(rawParams),
        returnType: returnType || undefined,
        exported: false,
        isDefault: false,
        isAsync: asyncKeyword === "async",
      });
    }
    return members;
  }

  /**
   * Extract import references from file content.
   */
  private extractImports(content: string): ImportRef[] {
    const refs: ImportRef[] = [];
    let match: RegExpExecArray | null;

    // Standard imports
    const importRe = new RegExp(IMPORT_RE.source, "g");
    while ((match = importRe.exec(content)) !== null) {
      const namedGroup = match[1];
      const defaultImport = match[2];
      const namespaceImport = match[3];
      const source = match[4];

      const symbols: string[] = [];
      if (namedGroup) {
        symbols.push(
          ...namedGroup.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean),
        );
      }
      if (defaultImport) symbols.push(defaultImport);
      if (namespaceImport) symbols.push(namespaceImport);

      const isTypeOnly = /import\s+type\s+/.test(match[0]);
      refs.push({ source, symbols, isTypeOnly });
    }

    // Re-exports
    const reExportRe = new RegExp(RE_EXPORT_RE.source, "g");
    while ((match = reExportRe.exec(content)) !== null) {
      const namedGroup = match[1];
      const source = match[2];
      const symbols = namedGroup
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0])
        .filter(Boolean);
      const isTypeOnly = /export\s+type\s+\{/.test(match[0]);
      refs.push({ source, symbols, isTypeOnly });
    }

    return refs;
  }

  /**
   * Extract exported symbol names from file content.
   */
  private extractExports(content: string): string[] {
    const exports: string[] = [];
    let match: RegExpExecArray | null;

    const namedRe = new RegExp(EXPORT_NAMED_RE.source, "g");
    while ((match = namedRe.exec(content)) !== null) {
      exports.push(match[1]);
    }

    const defaultRe = new RegExp(EXPORT_DEFAULT_RE.source, "g");
    if (defaultRe.exec(content) !== null) {
      exports.push("default");
    }

    const listRe = new RegExp(EXPORT_LIST_RE.source, "g");
    while ((match = listRe.exec(content)) !== null) {
      const symbols = match[1]
        .split(",")
        .map((s) => {
          const parts = s.trim().split(/\s+as\s+/);
          return parts.length > 1 ? parts[1].trim() : parts[0].trim();
        })
        .filter(Boolean);
      exports.push(...symbols);
    }

    return [...new Set(exports)];
  }

  /**
   * Extract call edges from function bodies.
   * Maps each function's body to the functions it calls.
   */
  private extractCallEdges(
    filePath: string,
    content: string,
    lines: string[],
    symbols: SymbolInfo[],
  ): CallEdge[] {
    const edges: CallEdge[] = [];

    // For each function/method symbol, scan its body for call sites
    for (const sym of symbols) {
      if (sym.kind !== "function" && sym.kind !== "method") continue;

      const bodyStart = Math.max(0, sym.line - 1);
      const bodyEnd = Math.min(lines.length, sym.endLine);
      const body = lines.slice(bodyStart, bodyEnd).join("\n");

      const callRe = new RegExp(CALL_SITE_RE.source, "g");
      let callMatch: RegExpExecArray | null;

      while ((callMatch = callRe.exec(body)) !== null) {
        const calleeName = callMatch[1];
        if (BUILTIN_CALLS.has(calleeName)) continue;
        if (calleeName === sym.name) continue; // skip self-recursion noise

        const callLine = bodyStart + this.getLineNumber(body, callMatch.index);
        edges.push({
          caller: `${filePath}:${sym.name}`,
          callee: `${filePath}:${calleeName}`,
          line: callLine,
          file: filePath,
        });
      }
    }

    return edges;
  }

  // ─── Private: Complexity computation ───

  /**
   * Compute complexity metrics for file content.
   */
  private computeComplexity(
    content: string,
    lines: string[],
    importCount: number,
  ): FileAnalysis["complexity"] {
    let blankLines = 0;
    let commentLines = 0;
    let inBlockComment = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") {
        blankLines++;
        continue;
      }
      if (inBlockComment) {
        commentLines++;
        if (trimmed.includes("*/")) inBlockComment = false;
        continue;
      }
      if (trimmed.startsWith("//")) {
        commentLines++;
        continue;
      }
      if (trimmed.startsWith("/*")) {
        commentLines++;
        inBlockComment = !trimmed.includes("*/");
        continue;
      }
    }

    const loc = lines.length - blankLines - commentLines;

    // Cyclomatic complexity: count branching constructs
    const cyclomaticPatterns =
      /\b(?:if|else\s+if|for|while|do|switch|case|catch)\b|\?\?|&&|\|\||\?(?=[^?:])/g;
    const cyclomaticMatches = content.match(cyclomaticPatterns);
    const cyclomatic = (cyclomaticMatches?.length ?? 0) + 1; // base complexity = 1

    // Cognitive complexity: nesting-aware scoring
    const cognitive = this.computeCognitiveComplexity(lines);

    return {
      cyclomatic,
      cognitive,
      loc,
      blankLines,
      commentLines,
      dependencies: importCount,
    };
  }

  /**
   * Compute cognitive complexity — increments with nesting depth.
   */
  private computeCognitiveComplexity(lines: string[]): number {
    let complexity = 0;
    let nesting = 0;

    const branchRe = /\b(if|else\s+if|for|while|do|switch|catch)\b/;
    const nestingIncrease = /\{/g;
    const nestingDecrease = /\}/g;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
        continue;
      }

      if (branchRe.test(trimmed)) {
        // +1 for the construct, + nesting level for being nested
        complexity += 1 + nesting;
      }

      // Track nesting
      const opens = trimmed.match(nestingIncrease);
      const closes = trimmed.match(nestingDecrease);
      nesting += (opens?.length ?? 0) - (closes?.length ?? 0);
      if (nesting < 0) nesting = 0;
    }

    return complexity;
  }

  // ─── Private: Index builders ───

  /**
   * Build the symbol table from all file analyses.
   * Maps symbol name → all SymbolInfo across the codebase.
   */
  private buildSymbolTable(): void {
    this.index.symbolTable.clear();

    for (const analysis of this.index.files.values()) {
      for (const sym of analysis.symbols) {
        let list = this.index.symbolTable.get(sym.name);
        if (!list) {
          list = [];
          this.index.symbolTable.set(sym.name, list);
        }
        list.push(sym);

        // Also index class/interface members
        if (sym.members) {
          for (const member of sym.members) {
            let memberList = this.index.symbolTable.get(member.name);
            if (!memberList) {
              memberList = [];
              this.index.symbolTable.set(member.name, memberList);
            }
            memberList.push(member);
          }
        }
      }
    }
  }

  /**
   * Build the global call graph from per-file call edges.
   */
  private buildCallGraph(): void {
    this.index.callGraph = [];
    for (const analysis of this.index.files.values()) {
      this.index.callGraph.push(...analysis.callEdges);
    }
  }

  /**
   * Build the reverse dependency map (file → files that import it).
   * Resolves relative import paths to absolute file paths.
   */
  private buildReverseDependencyMap(): void {
    this.reverseDepMap.clear();
    const knownFiles = [...this.index.files.keys()];

    for (const [filePath, analysis] of this.index.files) {
      for (const imp of analysis.imports) {
        if (!imp.source.startsWith(".")) continue;
        const resolved = this.resolveImportPath(filePath, imp.source, knownFiles);
        if (resolved) {
          let deps = this.reverseDepMap.get(resolved);
          if (!deps) {
            deps = new Set();
            this.reverseDepMap.set(resolved, deps);
          }
          deps.add(filePath);
        }
      }
    }
  }

  // ─── Private: Utility helpers ───

  /**
   * Resolve a relative import specifier to an absolute file path.
   */
  private resolveImportPath(
    fromFile: string,
    importPath: string,
    knownFiles: string[],
  ): string | undefined {
    const dir = resolve(fromFile, "..");
    let resolved = resolve(dir, importPath);

    if (knownFiles.includes(resolved)) return resolved;

    // .js → .ts mapping (common in ESM TypeScript)
    if (resolved.endsWith(".js")) {
      const tsPath = resolved.slice(0, -3) + ".ts";
      if (knownFiles.includes(tsPath)) return tsPath;
      const tsxPath = resolved.slice(0, -3) + ".tsx";
      if (knownFiles.includes(tsxPath)) return tsxPath;
    }

    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
      const withExt = resolved + ext;
      if (knownFiles.includes(withExt)) return withExt;
    }

    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
      const indexPath = join(resolved, `index${ext}`);
      if (knownFiles.includes(indexPath)) return indexPath;
    }

    return undefined;
  }

  /**
   * Get 1-based line number for a character offset within content.
   */
  private getLineNumber(content: string, offset: number): number {
    let line = 1;
    for (let i = 0; i < offset && i < content.length; i++) {
      if (content[i] === "\n") line++;
    }
    return line;
  }

  /**
   * Estimate the end line of a function/arrow function by scanning for matching braces.
   */
  private estimateEndLine(lines: string[], startLine: number, totalLines: number): number {
    return this.estimateBlockEnd(lines, startLine, totalLines);
  }

  /**
   * Estimate the end line of a brace-delimited block (class, function, enum, interface).
   * Tracks `{` and `}` to find the matching close brace.
   */
  private estimateBlockEnd(lines: string[], startLine: number, totalLines: number): number {
    let depth = 0;
    let foundOpen = false;

    for (let i = startLine - 1; i < totalLines; i++) {
      const line = lines[i];
      for (const ch of line) {
        if (ch === "{") {
          depth++;
          foundOpen = true;
        } else if (ch === "}") {
          depth--;
          if (foundOpen && depth === 0) {
            return i + 1; // 1-based
          }
        }
      }
    }

    // Fallback: return startLine + reasonable range
    return Math.min(startLine + 20, totalLines);
  }

  /**
   * Estimate the end line of a type alias (ends with `;` at depth 0).
   */
  private estimateTypeEnd(lines: string[], startLine: number, totalLines: number): number {
    let depth = 0;

    for (let i = startLine - 1; i < totalLines; i++) {
      const line = lines[i];
      for (const ch of line) {
        if (ch === "{" || ch === "(") depth++;
        else if (ch === "}" || ch === ")") depth--;
        else if (ch === ";" && depth <= 0) return i + 1;
      }
    }

    return Math.min(startLine + 10, totalLines);
  }

  /**
   * Parse a raw parameter string into ParamInfo array.
   * Handles `name: Type`, `name?: Type`, `name = defaultVal`.
   */
  private parseParams(raw: string): ParamInfo[] {
    if (!raw.trim()) return [];

    const params: ParamInfo[] = [];
    // Split on commas that are not inside angle brackets or parens
    const parts = this.splitParams(raw);

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      // Handle destructured params like { a, b }: Type
      const destructuredMatch = trimmed.match(/^(\{[^}]*\}|\[[^\]]*\])\s*(?::\s*(.+))?$/);
      if (destructuredMatch) {
        params.push({
          name: destructuredMatch[1],
          type: destructuredMatch[2]?.trim() ?? "unknown",
          optional: false,
        });
        continue;
      }

      // Handle rest params: ...args: Type
      const restMatch = trimmed.match(/^\.\.\.(\w+)\s*(?::\s*(.+))?$/);
      if (restMatch) {
        params.push({
          name: `...${restMatch[1]}`,
          type: restMatch[2]?.trim() ?? "unknown[]",
          optional: false,
        });
        continue;
      }

      // Standard: name?: Type = default
      const paramMatch = trimmed.match(/^(\w+)(\?)?\s*(?::\s*([^=]+))?\s*(?:=\s*(.+))?$/);
      if (paramMatch) {
        params.push({
          name: paramMatch[1],
          type: paramMatch[3]?.trim() ?? "unknown",
          optional: !!paramMatch[2] || !!paramMatch[4],
          defaultValue: paramMatch[4]?.trim(),
        });
      }
    }

    return params;
  }

  /**
   * Split parameter string by commas, respecting nested angle brackets and parentheses.
   */
  private splitParams(raw: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = "";

    for (const ch of raw) {
      if (ch === "<" || ch === "(" || ch === "[" || ch === "{") {
        depth++;
        current += ch;
      } else if (ch === ">" || ch === ")" || ch === "]" || ch === "}") {
        depth--;
        current += ch;
      } else if (ch === "," && depth === 0) {
        parts.push(current);
        current = "";
      } else {
        current += ch;
      }
    }

    if (current.trim()) parts.push(current);
    return parts;
  }

  /**
   * Clean a JSDoc comment — strip leading `*` and `/** ... * /`.
   */
  private cleanJsdoc(raw: string): string {
    return raw
      .replace(/^\/\*\*\s*/, "")
      .replace(/\s*\*\/$/, "")
      .replace(/^\s*\*\s?/gm, "")
      .trim();
  }

  /**
   * Score a symbol against search tokens for relevance ranking.
   */
  private scoreSymbol(sym: SymbolInfo, name: string, tokens: string[]): number {
    const nameLower = name.toLowerCase();
    // Split camelCase/PascalCase name into tokens
    const nameTokens = nameLower
      .replace(/([A-Z])/g, " $1")
      .toLowerCase()
      .split(/[\s_\-]+/)
      .filter(Boolean);
    const fileLower = relative(this.projectPath, sym.file).toLowerCase();
    const jsdocLower = sym.jsdoc?.toLowerCase() ?? "";
    const kindLower = sym.kind;

    let score = 0;
    let matchCount = 0;

    for (const token of tokens) {
      let matched = false;

      // Exact name match (highest score)
      if (nameLower === token) {
        score += 1.0;
        matched = true;
      }
      // Name contains token
      else if (nameLower.includes(token)) {
        score += 0.6;
        matched = true;
      }
      // Name token starts with query token
      else if (nameTokens.some((nt) => nt.startsWith(token))) {
        score += 0.4;
        matched = true;
      }

      // File path contains token
      if (fileLower.includes(token)) {
        score += 0.15;
        matched = true;
      }

      // JSDoc contains token
      if (jsdocLower.includes(token)) {
        score += 0.2;
        matched = true;
      }

      // Kind matches token
      if (kindLower === token) {
        score += 0.1;
        matched = true;
      }

      if (matched) matchCount++;
    }

    // Require at least one token to match
    if (matchCount === 0) return 0;

    // Bonus for matching all tokens
    if (matchCount === tokens.length && tokens.length > 1) {
      score *= 1.3;
    }

    // Bonus for exported symbols (more relevant)
    if (sym.exported) score *= 1.1;

    // Normalize to 0–1 range
    const maxPossible = tokens.length * 1.5 * 1.3 * 1.1;
    return Math.min(1, score / maxPossible);
  }

  /**
   * Get a code snippet around a symbol for search result display.
   */
  private getSnippet(sym: SymbolInfo): string {
    const content = this.fileContents.get(sym.file);
    if (!content) return "";

    const lines = content.split("\n");
    const start = Math.max(0, sym.line - 1);
    const end = Math.min(lines.length, sym.line + 4); // 5 lines max
    return lines.slice(start, end).join("\n");
  }
}
