/**
 * @module ast-analyzer
 * @description AST-based TypeScript/JavaScript code analysis using ts-morph.
 *
 * Provides accurate symbol extraction, import analysis, and reference finding
 * that avoids regex false positives (symbols in comments/strings, type-only imports, etc.).
 *
 * Falls back gracefully when ts-morph cannot load the project (e.g., missing tsconfig).
 */

import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";

// ─── Types ───

/** An exported symbol extracted via AST. */
export interface AstSymbol {
  /** Symbol name */
  name: string;
  /** Symbol kind */
  kind: "function" | "class" | "interface" | "type" | "enum" | "variable";
  /** Start line number (1-based) */
  line: number;
  /** End line number (1-based) */
  endLine: number;
  /** Whether this is a default export */
  isDefault: boolean;
}

/** An import statement parsed via AST. */
export interface AstImport {
  /** Imported module specifier (e.g., "react", "./utils") */
  moduleSpecifier: string;
  /** Named imports (e.g., ["useState", "useEffect"]) */
  namedImports: string[];
  /** Default import name, if any */
  defaultImport: string | undefined;
  /** Namespace import name (import * as X), if any */
  namespaceImport: string | undefined;
  /** Whether the import clause is type-only (import type …) */
  isTypeOnly: boolean;
  /** Individual imported names that are type-only (import { type X, Y }) */
  typeOnlyNames: string[];
  /** Line number (1-based) */
  line: number;
}

/** A single reference to a symbol. */
export interface AstReference {
  /** Absolute file path */
  file: string;
  /** Line number (1-based) */
  line: number;
  /** The full text of the referencing line */
  context: string;
}

// ─── Lazy loader for ts-morph ───

type TsMorphProject = import("ts-morph").Project;
type TsMorphSourceFile = import("ts-morph").SourceFile;

let TsMorphCtor: (typeof import("ts-morph"))["Project"] | null = null;
let tsMorphLoadAttempted = false;

async function loadTsMorph(): Promise<typeof import("ts-morph") | null> {
  if (tsMorphLoadAttempted) return TsMorphCtor ? ({ Project: TsMorphCtor } as typeof import("ts-morph")) : null;
  tsMorphLoadAttempted = true;
  try {
    const mod = await import("ts-morph");
    TsMorphCtor = mod.Project;
    return mod;
  } catch {
    return null;
  }
}

// ─── AstAnalyzer ───

/**
 * AST-based code analysis for TypeScript/JavaScript files.
 *
 * Uses ts-morph for accurate parsing — avoids regex false positives for symbols
 * in comments/strings, correctly detects type-only imports, and finds precise
 * symbol references.
 *
 * @example
 * ```typescript
 * const analyzer = new AstAnalyzer("/path/to/project");
 * const symbols = await analyzer.extractSymbols("/path/to/file.ts");
 * const refs = await analyzer.findReferences("/path/to/file.ts", "MyClass");
 * const imports = await analyzer.getImports("/path/to/file.ts");
 * const isType = await analyzer.isTypeOnlyImport("/path/to/file.ts", "Foo");
 * ```
 */
export class AstAnalyzer {
  private projectPath: string;
  /** Cached ts-morph Project instances keyed by tsconfig path */
  private projects: Map<string, TsMorphProject> = new Map();

  constructor(projectPath: string) {
    this.projectPath = resolve(projectPath);
  }

  // ─── Public API ───

  /**
   * Extract all exported symbols from a TypeScript/JavaScript file using AST.
   *
   * Returns functions, classes, interfaces, types, enums, and variables that
   * are exported. Includes accurate line numbers from the AST (not regex estimates).
   *
   * @param filePath - Absolute or project-relative path to the file
   * @returns Array of exported symbols, or empty array on failure
   */
  async extractSymbols(filePath: string): Promise<AstSymbol[]> {
    const absPath = resolve(filePath);
    try {
      const sf = await this.getSourceFile(absPath);
      if (!sf) return [];
      return this.extractSymbolsFromSourceFile(sf, absPath);
    } catch {
      return [];
    }
  }

  /**
   * Find all references to a named symbol across the project files.
   *
   * Uses ts-morph's language-service-level reference finder — accurate even for
   * overloaded names, avoids matches inside comments or string literals.
   *
   * @param filePath - File where the symbol is defined
   * @param symbolName - Name of the symbol to find references for
   * @returns Array of references with file path, line, and source context
   */
  async findReferences(filePath: string, symbolName: string): Promise<AstReference[]> {
    const absPath = resolve(filePath);
    try {
      const sf = await this.getSourceFile(absPath);
      if (!sf) return [];

      const results: AstReference[] = [];

      // Find the declaration node for the symbol in this file
      const declarations = sf.getExportedDeclarations().get(symbolName) ?? [];
      for (const decl of declarations) {
        // SourceFile is in the ExportedDeclarations union but lacks findReferencesAsNodes
        if (!("findReferencesAsNodes" in decl)) continue;
        const refs = (decl as { findReferencesAsNodes(): import("ts-morph").Node[] }).findReferencesAsNodes();
        for (const ref of refs) {
          const refSf = ref.getSourceFile();
          const refFilePath = refSf.getFilePath();
          const line = ref.getStartLineNumber();
          const lineText = refSf.getFullText().split("\n")[line - 1] ?? "";
          results.push({
            file: refFilePath,
            line,
            context: lineText,
          });
        }
      }

      return results;
    } catch {
      return [];
    }
  }

  /**
   * Parse all import statements in a file via AST.
   *
   * Correctly identifies type-only imports (both `import type { X }` and
   * `import { type X, Y }`).
   *
   * @param filePath - Absolute or project-relative path to the file
   * @returns Array of parsed import information, or empty array on failure
   */
  async getImports(filePath: string): Promise<AstImport[]> {
    const absPath = resolve(filePath);
    try {
      const sf = await this.getSourceFile(absPath);
      if (!sf) return [];
      return this.extractImportsFromSourceFile(sf);
    } catch {
      return [];
    }
  }

  /**
   * Check whether a specific imported name is type-only in a file.
   *
   * Returns true if:
   * - The entire import clause is `import type { X }`, or
   * - The specific named import is `import { type X, Y }` (TS 4.5+ inline type modifier)
   *
   * @param filePath - Absolute or project-relative path to the file
   * @param importedName - The name to check (e.g., "Foo")
   * @returns true if the import is type-only, false otherwise
   */
  async isTypeOnlyImport(filePath: string, importedName: string): Promise<boolean> {
    try {
      const imports = await this.getImports(filePath);
      for (const imp of imports) {
        // Full clause type-only: import type { X, Y } from "…"
        if (imp.isTypeOnly && imp.namedImports.includes(importedName)) return true;
        // Inline type modifier: import { type X, Y } from "…"
        if (imp.typeOnlyNames.includes(importedName)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // ─── Internal helpers ───

  /**
   * Get or create a ts-morph Project for the file's tsconfig.
   * Falls back to a ts-morph Project with no tsconfig if one cannot be found.
   */
  private async getProject(absFilePath: string): Promise<TsMorphProject | null> {
    const mod = await loadTsMorph();
    if (!mod) return null;

    const tsConfigPath = this.findTsConfig(absFilePath);
    const cacheKey = tsConfigPath ?? "__no_tsconfig__";

    if (this.projects.has(cacheKey)) {
      return this.projects.get(cacheKey)!;
    }

    try {
      let project: TsMorphProject;
      if (tsConfigPath) {
        project = new mod.Project({
          tsConfigFilePath: tsConfigPath,
          skipAddingFilesFromTsConfig: false,
          skipFileDependencyResolution: false,
        });
      } else {
        // No tsconfig found — use defaults so we can still parse individual files
        project = new mod.Project({
          useInMemoryFileSystem: false,
          skipAddingFilesFromTsConfig: true,
        });
      }
      this.projects.set(cacheKey, project);
      return project;
    } catch {
      // Construction failed (e.g., invalid tsconfig)
      return null;
    }
  }

  /**
   * Get a ts-morph SourceFile for the given absolute path.
   * Adds the file to the project if it's not already tracked.
   */
  private async getSourceFile(absFilePath: string): Promise<TsMorphSourceFile | null> {
    const project = await this.getProject(absFilePath);
    if (!project) return null;

    // Try to get from already-loaded files
    let sf = project.getSourceFile(absFilePath);
    if (!sf) {
      try {
        sf = project.addSourceFileAtPath(absFilePath);
      } catch {
        return null;
      }
    }
    return sf ?? null;
  }

  /**
   * Walk up from the file's directory to find the nearest tsconfig.json.
   * Stops at the project root.
   */
  private findTsConfig(absFilePath: string): string | undefined {
    let dir = dirname(absFilePath);
    const root = this.projectPath;

    // Walk up directory tree until we reach the project root (or filesystem root)
    while (dir.length >= root.length) {
      const candidate = `${dir}/tsconfig.json`;
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break; // filesystem root
      dir = parent;
    }

    // Also check project root tsconfig as last resort
    const projectTsConfig = `${root}/tsconfig.json`;
    if (existsSync(projectTsConfig)) return projectTsConfig;

    return undefined;
  }

  /**
   * Extract exported symbols from a ts-morph SourceFile.
   */
  private extractSymbolsFromSourceFile(sf: TsMorphSourceFile, filePath: string): AstSymbol[] {
    const symbols: AstSymbol[] = [];

    // ts-morph getExportedDeclarations() returns a ReadonlyMap<string, ExportedDeclarations[]>
    const exportedDecls = sf.getExportedDeclarations();
    const defaultName = "__default__";

    for (const [name, decls] of exportedDecls) {
      const isDefault = name === "default";
      const symbolName = isDefault ? defaultName : name;

      for (const decl of decls) {
        const kind = this.mapDeclarationKind(decl);
        if (!kind) continue;

        const startLine = decl.getStartLineNumber(true);
        const endLine = decl.getEndLineNumber();

        symbols.push({
          name: isDefault ? symbolName : name,
          kind,
          line: startLine,
          endLine,
          isDefault,
        });
      }
    }

    return symbols;
  }

  /**
   * Map a ts-morph Node to our AstSymbol kind string.
   * Returns undefined for node kinds we don't track.
   */
  private mapDeclarationKind(
    decl: import("ts-morph").ExportedDeclarations,
  ): AstSymbol["kind"] | undefined {
    // Use ts-morph's SyntaxKind checks via getKindName()
    const kindName = decl.getKindName();
    if (
      kindName === "FunctionDeclaration" ||
      kindName === "ArrowFunction" ||
      kindName === "FunctionExpression"
    ) {
      return "function";
    }
    if (kindName === "ClassDeclaration" || kindName === "ClassExpression") {
      return "class";
    }
    if (kindName === "InterfaceDeclaration") {
      return "interface";
    }
    if (
      kindName === "TypeAliasDeclaration"
    ) {
      return "type";
    }
    if (kindName === "EnumDeclaration") {
      return "enum";
    }
    if (
      kindName === "VariableDeclaration" ||
      kindName === "VariableStatement"
    ) {
      return "variable";
    }
    return undefined;
  }

  /**
   * Extract import information from a ts-morph SourceFile.
   */
  private extractImportsFromSourceFile(sf: TsMorphSourceFile): AstImport[] {
    const imports: AstImport[] = [];

    for (const importDecl of sf.getImportDeclarations()) {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();
      const isTypeOnly = importDecl.isTypeOnly();
      const line = importDecl.getStartLineNumber(true);

      const namedImports: string[] = [];
      const typeOnlyNames: string[] = [];

      for (const named of importDecl.getNamedImports()) {
        const nm = named.getName();
        namedImports.push(nm);
        // TS 4.5+: `import { type X, Y }` — individual type modifier
        if (named.isTypeOnly()) {
          typeOnlyNames.push(nm);
        }
      }

      const defaultImportNode = importDecl.getDefaultImport();
      const namespaceImportNode = importDecl.getNamespaceImport();

      imports.push({
        moduleSpecifier,
        namedImports,
        defaultImport: defaultImportNode?.getText(),
        namespaceImport: namespaceImportNode?.getText(),
        isTypeOnly,
        typeOnlyNames,
        line,
      });
    }

    return imports;
  }

  /**
   * Dispose all cached ts-morph Project instances to free memory.
   * Call this when analysis is complete.
   */
  dispose(): void {
    this.projects.clear();
  }
}
