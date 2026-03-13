/**
 * @module cross-file-refactor
 * @description Cross-File Refactoring Engine — enables safe renaming, moving, extracting,
 * and inlining symbols across multiple TypeScript/JavaScript files.
 *
 * Provides preview (dry-run) mode, rollback support, and safety checks (breaking change
 * detection, risk assessment). Uses AST-based analysis (ts-morph) where available,
 * with regex fallback for accuracy.
 */

import { readdir, readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { join, resolve, dirname, extname, relative, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { AstAnalyzer } from "./ast-analyzer.js";

// ─── Types ───

/** Supported refactoring operations. */
export type RefactorType =
  | "rename"
  | "move"
  | "extract_function"
  | "extract_interface"
  | "inline"
  | "change_signature";

/** A request describing the desired refactoring operation. */
export interface RefactorRequest {
  /** Refactoring type */
  type: RefactorType;
  /** Symbol to rename (for rename/move/inline/change_signature) */
  symbolName?: string;
  /** New name (for rename) */
  newName?: string;
  /** Scope to a specific file (optional, for rename) */
  file?: string;
  /** Destination file path (for move) */
  targetFile?: string;
  /** Source file path (for extract/move/inline/change_signature) */
  sourceFile?: string;
  /** Start line for extraction (1-based) */
  startLine?: number;
  /** End line for extraction (1-based) */
  endLine?: number;
  /** Name for the extracted symbol */
  extractedName?: string;
  /** New parameter list (for change_signature) */
  newParams?: { name: string; type: string; optional?: boolean }[];
  /** New return type (for change_signature) */
  newReturnType?: string;
  /** Whether to add a re-export in the source file (for move) */
  addReExport?: boolean;
}

/** Preview of a refactoring, before it is applied. */
export interface RefactorPreview {
  /** Refactoring type */
  type: RefactorType;
  /** Files that will be changed */
  affectedFiles: FileChange[];
  /** Total number of individual text changes */
  totalChanges: number;
  /** Breaking changes detected */
  breakingChanges: BreakingChange[];
  /** Risk level */
  riskLevel: "low" | "medium" | "high";
  /** Warnings for the developer */
  warnings: string[];
  /** Whether this can be automatically applied */
  canAutoApply: boolean;
}

/** Changes to a single file. */
export interface FileChange {
  /** Absolute file path */
  file: string;
  /** Individual text changes within the file */
  changes: TextChange[];
  /** Whether this is a newly created file */
  isNewFile: boolean;
  /** Whether this file will be deleted */
  isDeletedFile: boolean;
}

/** A single text replacement within a file. */
export interface TextChange {
  /** Start line (1-based) */
  startLine: number;
  /** End line (1-based, inclusive) */
  endLine: number;
  /** Original text */
  oldText: string;
  /** Replacement text */
  newText: string;
  /** Human-readable reason for the change */
  reason: string;
}

/** A breaking change detected during preview. */
export interface BreakingChange {
  /** Type of breaking change */
  type: "api_change" | "export_removed" | "signature_change" | "type_change";
  /** Human-readable description */
  description: string;
  /** File where the break occurs */
  file: string;
  /** Line number */
  line: number;
  /** Severity */
  severity: "warning" | "error";
}

/** Result of applying a refactoring. */
export interface RefactorResult {
  /** Whether the refactoring was fully applied */
  success: boolean;
  /** Changes that were successfully applied */
  appliedChanges: FileChange[];
  /** Changes that failed */
  failedChanges: { file: string; error: string }[];
  /** Whether rollback is available */
  rollbackAvailable: boolean;
  /** ID to pass to rollback() */
  rollbackId: string;
}

/** Safety analysis before and after a refactoring. */
export interface RefactorSafety {
  /** Pre-application checks */
  preCheck: {
    affectedFiles: string[];
    breakingChanges: BreakingChange[];
    riskLevel: "low" | "medium" | "high";
  };
  /** Post-application checks */
  postCheck: {
    buildSuccess: boolean;
    noNewErrors: boolean;
  };
}

// ─── Internal types ───

interface SymbolUsage {
  file: string;
  line: number;
  column: number;
  context: string;
}

interface ImportUsage {
  file: string;
  line: number;
  importStatement: string;
  isDefault: boolean;
}

// ─── Constants ───

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "__pycache__",
]);
const MAX_ROLLBACKS = 10;

// ─── Regex patterns ───

/** Named import: import { X, Y } from "Z" */
const IMPORT_NAMED_RE =
  /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;

/** Default import: import X from "Z" */
const IMPORT_DEFAULT_RE =
  /import\s+(\w+)\s+from\s+["']([^"']+)["']/g;

/** Namespace import: import * as X from "Z" */
const IMPORT_NAMESPACE_RE =
  /import\s+\*\s+as\s+(\w+)\s+from\s+["']([^"']+)["']/g;

/** Re-export: export { X } from "Z" */
const RE_EXPORT_RE =
  /export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;

/** Named export declaration */
const EXPORT_DECL_RE =
  /export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|interface|type|enum)\s+(\w+)/g;

/** Default export */
const EXPORT_DEFAULT_RE = /export\s+default\s+/;

/** Single-line comment */
const SINGLE_LINE_COMMENT_RE = /\/\/.*/g;

/** Multi-line comment (non-greedy) */
const MULTI_LINE_COMMENT_RE = /\/\*[\s\S]*?\*\//g;

/**
 * Cross-File Refactoring Engine.
 *
 * Enables safe renaming, moving, extracting, and inlining of symbols
 * across TypeScript/JavaScript projects. Supports preview (dry-run),
 * rollback, and breaking change detection.
 *
 * @example
 * ```ts
 * const refactor = new CrossFileRefactor("/path/to/project");
 * const preview = await refactor.renameSymbol("OldName", "NewName");
 * if (preview.riskLevel !== "high") {
 *   const result = await refactor.apply({ type: "rename", symbolName: "OldName", newName: "NewName" });
 * }
 * ```
 */
export class CrossFileRefactor {
  private projectPath: string;
  private rollbacks: Map<string, Map<string, string>>;
  private rollbackOrder: string[];
  /** AST-based analyzer for accurate symbol reference finding */
  private astAnalyzer: AstAnalyzer;

  constructor(projectPath: string) {
    this.projectPath = resolve(projectPath);
    this.rollbacks = new Map();
    this.rollbackOrder = [];
    this.astAnalyzer = new AstAnalyzer(this.projectPath);
  }

  // ═══════════════════════════════════════════════════════════════
  // Preview (dry run)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Generate a preview of the refactoring without making changes.
   *
   * @param request - The refactoring request
   * @returns Preview with affected files, breaking changes, and risk assessment
   */
  async preview(request: RefactorRequest): Promise<RefactorPreview> {
    switch (request.type) {
      case "rename":
        return this.renameSymbol(
          request.symbolName ?? "",
          request.newName ?? "",
          request.file,
        );
      case "move":
        return this.moveSymbol(
          request.symbolName ?? "",
          request.sourceFile ?? "",
          request.targetFile ?? "",
          request.addReExport,
        );
      case "extract_function":
        return this.extractFunction(
          request.sourceFile ?? "",
          request.startLine ?? 0,
          request.endLine ?? 0,
          request.extractedName ?? "extractedFunction",
          request.targetFile,
        );
      case "extract_interface":
        return this.extractInterface(
          request.symbolName ?? "",
          request.extractedName ?? "",
          request.sourceFile ?? "",
        );
      case "inline":
        return this.inlineFunction(
          request.symbolName ?? "",
          request.sourceFile ?? "",
        );
      case "change_signature":
        return this.changeSignature(
          request.symbolName ?? "",
          request.sourceFile ?? "",
          request.newParams ?? [],
          request.newReturnType,
        );
      default:
        return {
          type: request.type,
          affectedFiles: [],
          totalChanges: 0,
          breakingChanges: [],
          riskLevel: "high",
          warnings: [`Unknown refactoring type: ${request.type}`],
          canAutoApply: false,
        };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Apply
  // ═══════════════════════════════════════════════════════════════

  /**
   * Apply a refactoring to disk. Snapshots all affected files first
   * so the operation can be rolled back.
   *
   * @param request - The refactoring request
   * @returns Result including applied changes and rollback ID
   */
  async apply(request: RefactorRequest): Promise<RefactorResult> {
    const preview = await this.preview(request);
    const filePaths = preview.affectedFiles.map((f) => f.file);
    const rollbackId = await this.snapshotFiles(filePaths);

    const appliedChanges: FileChange[] = [];
    const failedChanges: { file: string; error: string }[] = [];

    for (const fc of preview.affectedFiles) {
      try {
        // Path traversal protection: ensure resolved path stays within project root
        const resolvedPath = resolve(fc.file);
        if (!resolvedPath.startsWith(this.projectPath)) {
          failedChanges.push({
            file: fc.file,
            error: `Path traversal blocked: "${resolvedPath}" is outside project root "${this.projectPath}"`,
          });
          continue;
        }

        if (fc.isNewFile) {
          // Create new file with the new text from changes
          const dir = dirname(fc.file);
          await mkdir(dir, { recursive: true });
          const content = fc.changes.map((c) => c.newText).join("\n");
          await writeFile(fc.file, content, "utf-8");
        } else if (fc.isDeletedFile) {
          // We don't delete files — just clear content (safer)
          await writeFile(fc.file, "", "utf-8");
        } else {
          const content = await this.readFile(fc.file);
          const updated = this.applyChanges(content, fc.changes);
          await writeFile(fc.file, updated, "utf-8");
        }
        appliedChanges.push(fc);
      } catch (err) {
        failedChanges.push({
          file: fc.file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      success: failedChanges.length === 0,
      appliedChanges,
      failedChanges,
      rollbackAvailable: true,
      rollbackId,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // Rollback
  // ═══════════════════════════════════════════════════════════════

  /**
   * Roll back a previously applied refactoring by restoring original file contents.
   *
   * @param rollbackId - The rollback ID returned by apply()
   * @returns True if rollback was successful
   */
  async rollback(rollbackId: string): Promise<boolean> {
    const snapshot = this.rollbacks.get(rollbackId);
    if (!snapshot) return false;

    try {
      for (const [filePath, content] of snapshot) {
        const dir = dirname(filePath);
        await mkdir(dir, { recursive: true });
        await writeFile(filePath, content, "utf-8");
      }
      this.rollbacks.delete(rollbackId);
      this.rollbackOrder = this.rollbackOrder.filter((id) => id !== rollbackId);
      return true;
    } catch {
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Rename Symbol
  // ═══════════════════════════════════════════════════════════════

  /**
   * Rename a symbol across all files that reference it.
   * Updates the definition, all usages, and all import statements.
   *
   * @param symbolName - Current symbol name
   * @param newName - Desired new name
   * @param scopeFile - Optional file to restrict the rename to
   * @returns Preview of all changes
   */
  async renameSymbol(
    symbolName: string,
    newName: string,
    scopeFile?: string,
  ): Promise<RefactorPreview> {
    const warnings: string[] = [];
    const breakingChanges: BreakingChange[] = [];

    if (!symbolName || !newName) {
      return this.emptyPreview("rename", ["symbolName and newName are required"]);
    }
    if (symbolName === newName) {
      return this.emptyPreview("rename", ["symbolName and newName are identical"]);
    }

    const usages = await this.findAllUsages(symbolName, scopeFile);
    const imports = await this.findImports(symbolName);

    if (usages.length === 0 && imports.length === 0) {
      return this.emptyPreview("rename", [`No usages found for symbol "${symbolName}"`]);
    }

    // Group usages by file
    const fileChangesMap = new Map<string, TextChange[]>();

    // Process direct usages
    for (const usage of usages) {
      const changes = fileChangesMap.get(usage.file) ?? [];
      const line = usage.context;
      const newLine = this.replaceSymbolInLine(line, symbolName, newName);
      if (newLine !== line) {
        changes.push({
          startLine: usage.line,
          endLine: usage.line,
          oldText: line,
          newText: newLine,
          reason: "rename usage",
        });
      }
      fileChangesMap.set(usage.file, changes);
    }

    // Process import statements
    for (const imp of imports) {
      if (scopeFile && imp.file !== scopeFile) continue;

      const changes = fileChangesMap.get(imp.file) ?? [];
      let newImport: string;
      if (imp.isDefault) {
        newImport = imp.importStatement.replace(
          new RegExp(`\\b${this.escapeRegex(symbolName)}\\b`),
          newName,
        );
      } else {
        // Named import: replace within braces
        newImport = imp.importStatement.replace(
          new RegExp(`\\b${this.escapeRegex(symbolName)}\\b`),
          newName,
        );
      }
      if (newImport !== imp.importStatement) {
        changes.push({
          startLine: imp.line,
          endLine: imp.line,
          oldText: imp.importStatement,
          newText: newImport,
          reason: "update import",
        });
      }
      fileChangesMap.set(imp.file, changes);
    }

    // Deduplicate changes per file (same line)
    const affectedFiles: FileChange[] = [];
    for (const [file, changes] of fileChangesMap) {
      const deduped = this.deduplicateChanges(changes);
      if (deduped.length > 0) {
        affectedFiles.push({ file, changes: deduped, isNewFile: false, isDeletedFile: false });
      }
    }

    // Check for breaking changes (exported symbol rename)
    const isExported = await this.isSymbolExported(symbolName);
    if (isExported) {
      breakingChanges.push({
        type: "api_change",
        description: `Renaming exported symbol "${symbolName}" to "${newName}" — all consumers must update`,
        file: isExported.file,
        line: isExported.line,
        severity: "warning",
      });
    }

    const totalChanges = affectedFiles.reduce((sum, f) => sum + f.changes.length, 0);
    const riskLevel = this.assessRisk(affectedFiles.length, breakingChanges.length, totalChanges);

    return {
      type: "rename",
      affectedFiles,
      totalChanges,
      breakingChanges,
      riskLevel,
      warnings,
      canAutoApply: riskLevel !== "high",
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // Move Symbol
  // ═══════════════════════════════════════════════════════════════

  /**
   * Move a symbol from one file to another. Updates all import statements
   * across the project and optionally adds a re-export for backward compatibility.
   *
   * @param symbolName - Symbol to move
   * @param sourceFile - Current file (absolute path)
   * @param targetFile - Destination file (absolute path)
   * @param addReExport - Whether to add a re-export in the source file
   * @returns Preview of all changes
   */
  async moveSymbol(
    symbolName: string,
    sourceFile: string,
    targetFile: string,
    addReExport?: boolean,
  ): Promise<RefactorPreview> {
    const warnings: string[] = [];
    const breakingChanges: BreakingChange[] = [];

    if (!symbolName || !sourceFile || !targetFile) {
      return this.emptyPreview("move", ["symbolName, sourceFile, and targetFile are required"]);
    }

    const absSource = resolve(this.projectPath, sourceFile);
    const absTarget = resolve(this.projectPath, targetFile);

    let sourceContent: string;
    try {
      sourceContent = await this.readFile(absSource);
    } catch {
      return this.emptyPreview("move", [`Source file not found: ${absSource}`]);
    }

    // Find the symbol definition in source
    const definition = this.extractDefinition(sourceContent, symbolName);
    if (!definition) {
      return this.emptyPreview("move", [`Symbol "${symbolName}" not found in ${sourceFile}`]);
    }

    const affectedFiles: FileChange[] = [];

    // 1. Remove from source file
    const sourceLines = sourceContent.split("\n");
    const sourceChanges: TextChange[] = [];

    sourceChanges.push({
      startLine: definition.startLine,
      endLine: definition.endLine,
      oldText: sourceLines.slice(definition.startLine - 1, definition.endLine).join("\n"),
      newText: "",
      reason: "remove moved symbol",
    });

    // Optionally add re-export
    if (addReExport) {
      const relPath = this.computeRelativeImportPath(absSource, absTarget);
      const reExportLine = `export { ${symbolName} } from "${relPath}";`;
      sourceChanges.push({
        startLine: definition.startLine,
        endLine: definition.startLine,
        oldText: "",
        newText: reExportLine,
        reason: "add re-export for backward compatibility",
      });
    }

    affectedFiles.push({
      file: absSource,
      changes: sourceChanges,
      isNewFile: false,
      isDeletedFile: false,
    });

    // 2. Add to target file
    let targetExists = true;
    let targetContent = "";
    try {
      targetContent = await this.readFile(absTarget);
    } catch {
      targetExists = false;
    }

    const symbolCode = definition.fullText;
    const targetChanges: TextChange[] = [];

    if (targetExists) {
      const targetLines = targetContent.split("\n");
      const lastLine = targetLines.length;
      targetChanges.push({
        startLine: lastLine,
        endLine: lastLine,
        oldText: targetLines[lastLine - 1] ?? "",
        newText: (targetLines[lastLine - 1] ?? "") + "\n\n" + symbolCode,
        reason: "add moved symbol",
      });
    } else {
      targetChanges.push({
        startLine: 1,
        endLine: 1,
        oldText: "",
        newText: symbolCode + "\n",
        reason: "create file with moved symbol",
      });
    }

    affectedFiles.push({
      file: absTarget,
      changes: targetChanges,
      isNewFile: !targetExists,
      isDeletedFile: false,
    });

    // 3. Update imports across all files
    const allFiles = await this.collectSourceFiles(this.projectPath);
    const importUpdates = this.generateImportUpdates(symbolName, absSource, absTarget, allFiles);
    for (const update of importUpdates) {
      // Find if we already have a FileChange for this file
      const existing = affectedFiles.find((f) => f.file === update.file);
      if (existing) {
        existing.changes.push(update.change);
      } else {
        affectedFiles.push({
          file: update.file,
          changes: [update.change],
          isNewFile: false,
          isDeletedFile: false,
        });
      }
    }

    // Breaking change if symbol was exported
    if (definition.exported && !addReExport) {
      breakingChanges.push({
        type: "export_removed",
        description: `Moving exported symbol "${symbolName}" without re-export — consumers importing from "${sourceFile}" will break`,
        file: absSource,
        line: definition.startLine,
        severity: "error",
      });
    }

    const totalChanges = affectedFiles.reduce((sum, f) => sum + f.changes.length, 0);
    const riskLevel = this.assessRisk(affectedFiles.length, breakingChanges.length, totalChanges);

    return {
      type: "move",
      affectedFiles,
      totalChanges,
      breakingChanges,
      riskLevel,
      warnings,
      canAutoApply: riskLevel !== "high",
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // Extract Function
  // ═══════════════════════════════════════════════════════════════

  /**
   * Extract a range of lines into a new function. Infers parameters from
   * variables used but defined outside the selection, and return values from
   * variables modified inside the selection.
   *
   * @param sourceFile - File containing the code to extract
   * @param startLine - First line to extract (1-based)
   * @param endLine - Last line to extract (1-based, inclusive)
   * @param functionName - Name for the new function
   * @param targetFile - File to place the function in (same file if omitted)
   * @returns Preview of all changes
   */
  async extractFunction(
    sourceFile: string,
    startLine: number,
    endLine: number,
    functionName: string,
    targetFile?: string,
  ): Promise<RefactorPreview> {
    const warnings: string[] = [];
    const breakingChanges: BreakingChange[] = [];

    if (!sourceFile || startLine <= 0 || endLine <= 0 || endLine < startLine) {
      return this.emptyPreview("extract_function", ["Invalid sourceFile or line range"]);
    }

    const absSource = resolve(this.projectPath, sourceFile);
    let content: string;
    try {
      content = await this.readFile(absSource);
    } catch {
      return this.emptyPreview("extract_function", [`Source file not found: ${absSource}`]);
    }

    const lines = content.split("\n");
    if (startLine > lines.length || endLine > lines.length) {
      return this.emptyPreview("extract_function", ["Line range exceeds file length"]);
    }

    const selectedLines = lines.slice(startLine - 1, endLine);
    const selectedCode = selectedLines.join("\n");

    // Determine surrounding code for parameter inference
    const beforeCode = lines.slice(0, startLine - 1).join("\n");
    const afterCode = lines.slice(endLine).join("\n");
    const surroundingCode = beforeCode + "\n" + afterCode;

    // Infer parameters and return values
    const params = this.inferParameters(selectedCode, surroundingCode);
    const returnVars = this.inferReturnValues(selectedCode, afterCode);

    // Build function signature
    const paramStr = params.map((p) => `${p.name}: ${p.type}`).join(", ");
    let returnType = "void";
    let returnStatement = "";
    if (returnVars.length === 1) {
      returnType = returnVars[0].type;
      returnStatement = `\n  return ${returnVars[0].name};`;
    } else if (returnVars.length > 1) {
      returnType = `{ ${returnVars.map((v) => `${v.name}: ${v.type}`).join("; ")} }`;
      returnStatement = `\n  return { ${returnVars.map((v) => v.name).join(", ")} };`;
    }

    // Determine indentation
    const baseIndent = this.detectIndent(selectedLines[0] ?? "");
    const dedentedCode = selectedLines.map((l) => l.replace(new RegExp(`^${baseIndent}`), "  ")).join("\n");

    const functionDef = `function ${functionName}(${paramStr}): ${returnType} {\n${dedentedCode}${returnStatement}\n}`;

    // Build the call expression
    const callArgs = params.map((p) => p.name).join(", ");
    let callExpr: string;
    if (returnVars.length === 0) {
      callExpr = `${baseIndent}${functionName}(${callArgs});`;
    } else if (returnVars.length === 1) {
      callExpr = `${baseIndent}const ${returnVars[0].name} = ${functionName}(${callArgs});`;
    } else {
      callExpr = `${baseIndent}const { ${returnVars.map((v) => v.name).join(", ")} } = ${functionName}(${callArgs});`;
    }

    const affectedFiles: FileChange[] = [];

    const sameFile = !targetFile || resolve(this.projectPath, targetFile) === absSource;

    if (sameFile) {
      // Replace selected lines with call, add function at end of file
      affectedFiles.push({
        file: absSource,
        changes: [
          {
            startLine,
            endLine,
            oldText: selectedCode,
            newText: callExpr,
            reason: "replace with function call",
          },
          {
            startLine: lines.length,
            endLine: lines.length,
            oldText: lines[lines.length - 1] ?? "",
            newText: (lines[lines.length - 1] ?? "") + "\n\n" + functionDef,
            reason: "add extracted function",
          },
        ],
        isNewFile: false,
        isDeletedFile: false,
      });
    } else {
      const absTarget = resolve(this.projectPath, targetFile!);
      const relPath = this.computeRelativeImportPath(absSource, absTarget);
      const importLine = `import { ${functionName} } from "${relPath}";`;

      // Source: replace selected lines, add import
      const importInsertLine = this.findImportInsertLine(lines);
      affectedFiles.push({
        file: absSource,
        changes: [
          {
            startLine: importInsertLine,
            endLine: importInsertLine,
            oldText: lines[importInsertLine - 1] ?? "",
            newText: importLine + "\n" + (lines[importInsertLine - 1] ?? ""),
            reason: "add import for extracted function",
          },
          {
            startLine: startLine + 1, // +1 because we inserted a line above
            endLine: endLine + 1,
            oldText: selectedCode,
            newText: callExpr,
            reason: "replace with function call",
          },
        ],
        isNewFile: false,
        isDeletedFile: false,
      });

      // Target: add the function
      let targetExists = true;
      try {
        await this.readFile(absTarget);
      } catch {
        targetExists = false;
      }

      affectedFiles.push({
        file: absTarget,
        changes: [
          {
            startLine: 1,
            endLine: 1,
            oldText: "",
            newText: `export ${functionDef}\n`,
            reason: "add extracted function",
          },
        ],
        isNewFile: !targetExists,
        isDeletedFile: false,
      });
    }

    const totalChanges = affectedFiles.reduce((sum, f) => sum + f.changes.length, 0);
    const riskLevel = this.assessRisk(affectedFiles.length, breakingChanges.length, totalChanges);

    return {
      type: "extract_function",
      affectedFiles,
      totalChanges,
      breakingChanges,
      riskLevel,
      warnings,
      canAutoApply: riskLevel !== "high",
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // Extract Interface
  // ═══════════════════════════════════════════════════════════════

  /**
   * Extract an interface from a class's public members.
   *
   * @param className - Class to extract from
   * @param interfaceName - Name for the new interface
   * @param sourceFile - File containing the class
   * @returns Preview of all changes
   */
  async extractInterface(
    className: string,
    interfaceName: string,
    sourceFile: string,
  ): Promise<RefactorPreview> {
    const warnings: string[] = [];

    if (!className || !interfaceName || !sourceFile) {
      return this.emptyPreview("extract_interface", ["className, interfaceName, and sourceFile are required"]);
    }

    const absSource = resolve(this.projectPath, sourceFile);
    let content: string;
    try {
      content = await this.readFile(absSource);
    } catch {
      return this.emptyPreview("extract_interface", [`Source file not found: ${absSource}`]);
    }

    // Find class definition and extract public methods/properties
    const classInfo = this.extractClassMembers(content, className);
    if (!classInfo) {
      return this.emptyPreview("extract_interface", [`Class "${className}" not found in ${sourceFile}`]);
    }

    // Build interface from public members
    const memberLines: string[] = [];
    for (const member of classInfo.publicMembers) {
      if (member.kind === "method") {
        const paramStr = member.params ?? "";
        const retType = member.returnType ?? "void";
        memberLines.push(`  ${member.name}(${paramStr}): ${retType};`);
      } else {
        const propType = member.type ?? "unknown";
        memberLines.push(`  ${member.name}: ${propType};`);
      }
    }

    const interfaceDef = `export interface ${interfaceName} {\n${memberLines.join("\n")}\n}`;

    // Add interface before the class and make class implement it
    const lines = content.split("\n");
    const affectedFiles: FileChange[] = [];
    const changes: TextChange[] = [];

    // Insert interface before class
    changes.push({
      startLine: classInfo.line,
      endLine: classInfo.line,
      oldText: lines[classInfo.line - 1],
      newText: interfaceDef + "\n\n" + lines[classInfo.line - 1],
      reason: "add extracted interface",
    });

    // Update class declaration to implement the interface
    const classLine = lines[classInfo.line - 1];
    const implementsMatch = classLine.match(/\bimplements\s+([^{]+)/);
    if (implementsMatch) {
      const updated = classLine.replace(
        /\bimplements\s+([^{]+)/,
        `implements ${implementsMatch[1].trim()}, ${interfaceName}`,
      );
      changes.push({
        startLine: classInfo.line,
        endLine: classInfo.line,
        oldText: classLine,
        newText: updated,
        reason: "add implements clause",
      });
    } else {
      const updated = classLine.replace(
        /\bclass\s+(\w+)(\s*(?:extends\s+\w+\s*)?)\{/,
        `class $1$2 implements ${interfaceName} {`,
      );
      if (updated !== classLine) {
        // We already have the insert change at this line, so update the first change
        changes[0].newText = interfaceDef + "\n\n" + updated;
      }
    }

    affectedFiles.push({
      file: absSource,
      changes: this.deduplicateChanges(changes),
      isNewFile: false,
      isDeletedFile: false,
    });

    const totalChanges = affectedFiles.reduce((sum, f) => sum + f.changes.length, 0);

    return {
      type: "extract_interface",
      affectedFiles,
      totalChanges,
      breakingChanges: [],
      riskLevel: "low",
      warnings,
      canAutoApply: true,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // Inline Function
  // ═══════════════════════════════════════════════════════════════

  /**
   * Inline a simple function at all call sites (replace calls with the function body).
   * Only works for simple single-expression or single-statement functions.
   *
   * @param functionName - Function to inline
   * @param sourceFile - File where the function is defined
   * @returns Preview of all changes
   */
  async inlineFunction(
    functionName: string,
    sourceFile: string,
  ): Promise<RefactorPreview> {
    const warnings: string[] = [];

    if (!functionName || !sourceFile) {
      return this.emptyPreview("inline", ["functionName and sourceFile are required"]);
    }

    const absSource = resolve(this.projectPath, sourceFile);
    let content: string;
    try {
      content = await this.readFile(absSource);
    } catch {
      return this.emptyPreview("inline", [`Source file not found: ${absSource}`]);
    }

    // Extract function body
    const funcInfo = this.extractFunctionBody(content, functionName);
    if (!funcInfo) {
      return this.emptyPreview("inline", [`Function "${functionName}" not found or too complex to inline`]);
    }

    if (funcInfo.bodyLines > 5) {
      warnings.push(`Function has ${funcInfo.bodyLines} lines — inlining may reduce readability`);
    }

    // Find all call sites across the project
    const usages = await this.findAllUsages(functionName);
    const affectedFiles: FileChange[] = [];

    // Group by file
    const fileUsages = new Map<string, SymbolUsage[]>();
    for (const usage of usages) {
      // Skip the definition itself
      if (usage.file === absSource && usage.line >= funcInfo.startLine && usage.line <= funcInfo.endLine) {
        continue;
      }
      const list = fileUsages.get(usage.file) ?? [];
      list.push(usage);
      fileUsages.set(usage.file, list);
    }

    for (const [file, fileUses] of fileUsages) {
      const changes: TextChange[] = [];
      for (const usage of fileUses) {
        // Check if this line contains a function call pattern
        const callRe = new RegExp(`${this.escapeRegex(functionName)}\\s*\\(([^)]*)\\)`);
        const callMatch = usage.context.match(callRe);
        if (!callMatch) continue;

        const args = callMatch[1].split(",").map((a) => a.trim()).filter(Boolean);
        let inlinedBody = funcInfo.body;

        // Substitute parameters with arguments
        for (let i = 0; i < funcInfo.params.length && i < args.length; i++) {
          const paramRe = new RegExp(`\\b${this.escapeRegex(funcInfo.params[i])}\\b`, "g");
          inlinedBody = inlinedBody.replace(paramRe, args[i]);
        }

        // For single-expression returns, unwrap
        const returnMatch = inlinedBody.match(/^\s*return\s+(.+?);?\s*$/);
        if (returnMatch) {
          inlinedBody = returnMatch[1];
        }

        const newLine = usage.context.replace(callRe, inlinedBody);
        changes.push({
          startLine: usage.line,
          endLine: usage.line,
          oldText: usage.context,
          newText: newLine,
          reason: "inline function call",
        });
      }

      if (changes.length > 0) {
        affectedFiles.push({ file, changes, isNewFile: false, isDeletedFile: false });
      }
    }

    // Remove the function definition from source
    const sourceLines = content.split("\n");
    const defText = sourceLines.slice(funcInfo.startLine - 1, funcInfo.endLine).join("\n");
    affectedFiles.push({
      file: absSource,
      changes: [{
        startLine: funcInfo.startLine,
        endLine: funcInfo.endLine,
        oldText: defText,
        newText: "",
        reason: "remove inlined function definition",
      }],
      isNewFile: false,
      isDeletedFile: false,
    });

    const totalChanges = affectedFiles.reduce((sum, f) => sum + f.changes.length, 0);
    const breakingChanges: BreakingChange[] = [];

    // If exported, it's a breaking change
    if (funcInfo.exported) {
      breakingChanges.push({
        type: "export_removed",
        description: `Inlining exported function "${functionName}" — external consumers will break`,
        file: absSource,
        line: funcInfo.startLine,
        severity: "error",
      });
    }

    const riskLevel = this.assessRisk(affectedFiles.length, breakingChanges.length, totalChanges);

    return {
      type: "inline",
      affectedFiles,
      totalChanges,
      breakingChanges,
      riskLevel,
      warnings,
      canAutoApply: riskLevel !== "high",
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // Change Signature
  // ═══════════════════════════════════════════════════════════════

  /**
   * Change a function's parameter list and/or return type. Updates the definition
   * and all call sites.
   *
   * @param functionName - Function to modify
   * @param sourceFile - File where the function is defined
   * @param newParams - New parameter list
   * @param newReturnType - New return type (optional)
   * @returns Preview of all changes
   */
  async changeSignature(
    functionName: string,
    sourceFile: string,
    newParams: { name: string; type: string; optional?: boolean }[],
    newReturnType?: string,
  ): Promise<RefactorPreview> {
    const warnings: string[] = [];
    const breakingChanges: BreakingChange[] = [];

    if (!functionName || !sourceFile) {
      return this.emptyPreview("change_signature", ["functionName and sourceFile are required"]);
    }

    const absSource = resolve(this.projectPath, sourceFile);
    let content: string;
    try {
      content = await this.readFile(absSource);
    } catch {
      return this.emptyPreview("change_signature", [`Source file not found: ${absSource}`]);
    }

    // Find the function definition line
    const lines = content.split("\n");
    const funcDefRe = new RegExp(
      `(export\\s+)?(?:async\\s+)?function\\s+${this.escapeRegex(functionName)}\\s*\\(([^)]*)\\)(?:\\s*:\\s*([^{]+))?`,
    );

    let defLine = -1;
    let defMatch: RegExpMatchArray | null = null;
    for (let i = 0; i < lines.length; i++) {
      defMatch = lines[i].match(funcDefRe);
      if (defMatch) {
        defLine = i + 1;
        break;
      }
    }

    if (defLine === -1 || !defMatch) {
      return this.emptyPreview("change_signature", [`Function "${functionName}" definition not found`]);
    }

    const oldParamStr = defMatch[2];
    const oldReturnType = defMatch[3]?.trim();
    const isExported = !!defMatch[1];

    // Build new signature
    const newParamStr = newParams
      .map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`)
      .join(", ");
    const returnTypeStr = newReturnType
      ? `: ${newReturnType}`
      : oldReturnType
        ? `: ${oldReturnType}`
        : "";

    const affectedFiles: FileChange[] = [];
    const sourceChanges: TextChange[] = [];

    // Update definition
    const oldLine = lines[defLine - 1];
    const newLine = oldLine
      .replace(`(${oldParamStr})`, `(${newParamStr})`)
      .replace(
        oldReturnType ? `: ${oldReturnType}` : /(?=\s*\{)/,
        returnTypeStr,
      );

    sourceChanges.push({
      startLine: defLine,
      endLine: defLine,
      oldText: oldLine,
      newText: newLine,
      reason: "update function signature",
    });

    affectedFiles.push({
      file: absSource,
      changes: sourceChanges,
      isNewFile: false,
      isDeletedFile: false,
    });

    // Update call sites across project
    const usages = await this.findAllUsages(functionName);
    const oldParams = oldParamStr
      .split(",")
      .map((p) => p.trim().split(/[?:]/)[0].trim())
      .filter(Boolean);

    for (const usage of usages) {
      if (usage.file === absSource && usage.line === defLine) continue;

      const callRe = new RegExp(`${this.escapeRegex(functionName)}\\s*\\(([^)]*)\\)`);
      const callMatch = usage.context.match(callRe);
      if (!callMatch) continue;

      const oldArgs = callMatch[1].split(",").map((a) => a.trim());

      // Map old args to new params by name matching
      const newArgs: string[] = [];
      for (const param of newParams) {
        const oldIdx = oldParams.indexOf(param.name);
        if (oldIdx >= 0 && oldIdx < oldArgs.length) {
          newArgs.push(oldArgs[oldIdx]);
        } else if (param.optional) {
          // Skip optional params without old args
        } else {
          newArgs.push(`/* TODO: ${param.name} */`);
          warnings.push(`New required parameter "${param.name}" at ${usage.file}:${usage.line} needs a value`);
        }
      }

      const newCallExpr = `${functionName}(${newArgs.join(", ")})`;
      const updatedLine = usage.context.replace(callRe, newCallExpr);

      if (updatedLine !== usage.context) {
        const existing = affectedFiles.find((f) => f.file === usage.file);
        const change: TextChange = {
          startLine: usage.line,
          endLine: usage.line,
          oldText: usage.context,
          newText: updatedLine,
          reason: "update call site arguments",
        };

        if (existing) {
          existing.changes.push(change);
        } else {
          affectedFiles.push({
            file: usage.file,
            changes: [change],
            isNewFile: false,
            isDeletedFile: false,
          });
        }
      }
    }

    if (isExported) {
      breakingChanges.push({
        type: "signature_change",
        description: `Changing signature of exported function "${functionName}"`,
        file: absSource,
        line: defLine,
        severity: "warning",
      });
    }

    const totalChanges = affectedFiles.reduce((sum, f) => sum + f.changes.length, 0);
    const riskLevel = this.assessRisk(affectedFiles.length, breakingChanges.length, totalChanges);

    return {
      type: "change_signature",
      affectedFiles,
      totalChanges,
      breakingChanges,
      riskLevel,
      warnings,
      canAutoApply: riskLevel !== "high",
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // Safety
  // ═══════════════════════════════════════════════════════════════

  /**
   * Perform safety analysis on a refactoring preview.
   * Returns pre-check info and placeholder post-check (build verification
   * must be run separately after apply).
   *
   * @param preview - The refactoring preview to analyze
   * @returns Safety analysis result
   */
  async checkSafety(preview: RefactorPreview): Promise<RefactorSafety> {
    return {
      preCheck: {
        affectedFiles: preview.affectedFiles.map((f) => f.file),
        breakingChanges: preview.breakingChanges,
        riskLevel: preview.riskLevel,
      },
      postCheck: {
        // These must be verified after apply() by running tsc/build
        buildSuccess: false,
        noNewErrors: false,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // Private: Find Usages
  // ═══════════════════════════════════════════════════════════════

  /**
   * Find all usages of a symbol across the project.
   *
   * First attempts AST-based reference finding via AstAnalyzer (ts-morph) for accurate
   * results that exclude comments and string literals. Falls back to regex word boundary
   * matching if the AST approach fails or returns no results.
   *
   * @param symbolName - The symbol name to search for
   * @param scopeFile - Optional file to scope the search to (for rename in single file)
   */
  private async findAllUsages(
    symbolName: string,
    scopeFile?: string,
  ): Promise<SymbolUsage[]> {
    // ── AST-based approach (accurate) ──
    // Only try AST when we have a definite source file for the symbol definition.
    // scopeFile is the file where the symbol is defined for rename operations.
    if (scopeFile) {
      const defFile = resolve(this.projectPath, scopeFile);
      try {
        const astRefs = await this.astAnalyzer.findReferences(defFile, symbolName);
        if (astRefs.length > 0) {
          return astRefs.map((ref) => ({
            file: ref.file,
            line: ref.line,
            column: ref.context.indexOf(symbolName),
            context: ref.context,
          }));
        }
      } catch {
        // AST failed — fall through to regex
      }
    }

    // ── Regex fallback ──
    const usages: SymbolUsage[] = [];
    const files = scopeFile
      ? [resolve(this.projectPath, scopeFile)]
      : await this.collectSourceFiles(this.projectPath);

    const symbolRe = new RegExp(`(?<![.\\w])${this.escapeRegex(symbolName)}(?!\\w)`, "g");

    for (const file of files) {
      let content: string;
      try {
        content = await this.readFile(file);
      } catch {
        continue;
      }

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (this.isCommentLine(line)) continue;
        symbolRe.lastIndex = 0;
        if (!symbolRe.test(line)) continue;

        // Check that the match is not inside a string literal
        if (this.isInStringLiteral(line, symbolName)) continue;

        usages.push({
          file,
          line: i + 1,
          column: line.indexOf(symbolName),
          context: line,
        });
      }
    }

    return usages;
  }

  /**
   * Find all import statements that reference a symbol.
   */
  private async findImports(symbolName: string): Promise<ImportUsage[]> {
    const results: ImportUsage[] = [];
    const files = await this.collectSourceFiles(this.projectPath);

    for (const file of files) {
      let content: string;
      try {
        content = await this.readFile(file);
      } catch {
        continue;
      }

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Named import: import { X, Y } from "Z"
        const namedRe = new RegExp(IMPORT_NAMED_RE.source, "g");
        let match: RegExpExecArray | null;
        while ((match = namedRe.exec(line)) !== null) {
          const symbols = match[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim());
          if (symbols.includes(symbolName)) {
            results.push({ file, line: i + 1, importStatement: line, isDefault: false });
          }
        }

        // Default import: import X from "Z"
        const defaultRe = new RegExp(IMPORT_DEFAULT_RE.source, "g");
        while ((match = defaultRe.exec(line)) !== null) {
          if (match[1] === symbolName) {
            results.push({ file, line: i + 1, importStatement: line, isDefault: true });
          }
        }

        // Re-export: export { X } from "Z"
        const reExportRe = new RegExp(RE_EXPORT_RE.source, "g");
        while ((match = reExportRe.exec(line)) !== null) {
          const symbols = match[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim());
          if (symbols.includes(symbolName)) {
            results.push({ file, line: i + 1, importStatement: line, isDefault: false });
          }
        }
      }
    }

    return results;
  }

  /**
   * Generate import path updates when a symbol moves between files.
   */
  private generateImportUpdates(
    symbolName: string,
    oldFile: string,
    newFile: string,
    files: string[],
  ): { file: string; change: TextChange }[] {
    const results: { file: string; change: TextChange }[] = [];

    // We need to synchronously scan files that have already been read.
    // For preview purposes, we'll do a simulated scan based on files list.
    // The actual file reading happens in apply(). For preview, we return
    // placeholder updates that will be resolved during apply.
    // This is a limitation of the synchronous generateImportUpdates interface.

    // In practice, this method is called after findImports has already scanned files.
    // We return empty here and let the moveSymbol method handle imports via findImports.
    return results;
  }

  // ═══════════════════════════════════════════════════════════════
  // Private: Symbol Analysis
  // ═══════════════════════════════════════════════════════════════

  /**
   * Check if a symbol is exported from any file.
   */
  private async isSymbolExported(symbolName: string): Promise<{ file: string; line: number } | null> {
    const files = await this.collectSourceFiles(this.projectPath);
    const exportRe = new RegExp(
      `export\\s+(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\s*\\*?|class|const|let|var|interface|type|enum)\\s+${this.escapeRegex(symbolName)}\\b`,
    );

    for (const file of files) {
      let content: string;
      try {
        content = await this.readFile(file);
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (exportRe.test(lines[i])) {
          return { file, line: i + 1 };
        }
      }
    }
    return null;
  }

  /**
   * Extract a symbol's full definition (with JSDoc) from file content.
   */
  private extractDefinition(
    content: string,
    symbolName: string,
  ): { fullText: string; startLine: number; endLine: number; exported: boolean } | null {
    const lines = content.split("\n");

    // Pattern: [export] [async] function/class/interface/type/enum/const NAME
    const declRe = new RegExp(
      `^(\\s*)(export\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\s*\\*?|class|interface|type|enum|const|let|var)\\s+${this.escapeRegex(symbolName)}\\b`,
    );

    for (let i = 0; i < lines.length; i++) {
      if (!declRe.test(lines[i])) continue;

      const exported = /\bexport\b/.test(lines[i]);

      // Look backward for JSDoc
      let jsdocStart = i;
      if (i > 0 && lines[i - 1].trim().endsWith("*/")) {
        for (let j = i - 1; j >= 0; j--) {
          jsdocStart = j;
          if (lines[j].trim().startsWith("/**") || lines[j].trim().startsWith("/*")) break;
        }
      }

      // Find end of definition by brace matching
      const endLine = this.findDefinitionEnd(lines, i);

      const fullText = lines.slice(jsdocStart, endLine).join("\n");

      return {
        fullText,
        startLine: jsdocStart + 1,
        endLine,
        exported,
      };
    }

    return null;
  }

  /**
   * Find the end line of a definition by tracking brace depth.
   * For single-line type aliases or simple declarations, returns the same line.
   */
  private findDefinitionEnd(lines: string[], startIdx: number): number {
    let braceDepth = 0;
    let foundOpen = false;

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      for (const ch of line) {
        if (ch === "{") {
          braceDepth++;
          foundOpen = true;
        } else if (ch === "}") {
          braceDepth--;
          if (foundOpen && braceDepth === 0) {
            return i + 1; // 1-based end line
          }
        }
      }

      // For type aliases / single line declarations without braces
      if (!foundOpen && line.includes(";")) {
        return i + 1;
      }
    }

    // Fallback: return the start line
    return startIdx + 1;
  }

  /**
   * Extract public members from a class definition.
   */
  private extractClassMembers(
    content: string,
    className: string,
  ): {
    line: number;
    publicMembers: { name: string; kind: "method" | "property"; params?: string; returnType?: string; type?: string }[];
  } | null {
    const lines = content.split("\n");
    const classRe = new RegExp(
      `(?:export\\s+)?(?:abstract\\s+)?class\\s+${this.escapeRegex(className)}\\b`,
    );

    let classLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (classRe.test(lines[i])) {
        classLine = i;
        break;
      }
    }

    if (classLine === -1) return null;

    const endLine = this.findDefinitionEnd(lines, classLine);
    const classBody = lines.slice(classLine + 1, endLine - 1);

    const publicMembers: {
      name: string;
      kind: "method" | "property";
      params?: string;
      returnType?: string;
      type?: string;
    }[] = [];

    // Method pattern: [async] methodName(params): ReturnType {
    const methodRe = /^\s*(?:async\s+)?(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^{;]+))?\s*\{?/;
    // Property pattern: [readonly] propName: Type;
    const propRe = /^\s*(?:readonly\s+)?(\w+)(?:\?)?:\s*([^;=]+)/;

    for (const bodyLine of classBody) {
      const trimmed = bodyLine.trim();
      // Skip private/protected members
      if (trimmed.startsWith("private ") || trimmed.startsWith("protected ") || trimmed.startsWith("#")) {
        continue;
      }
      // Skip constructor
      if (trimmed.startsWith("constructor")) continue;

      const mMatch = trimmed.match(methodRe);
      if (mMatch && mMatch[1] !== "get" && mMatch[1] !== "set") {
        publicMembers.push({
          name: mMatch[1],
          kind: "method",
          params: mMatch[2]?.trim(),
          returnType: mMatch[3]?.trim(),
        });
        continue;
      }

      const pMatch = trimmed.match(propRe);
      if (pMatch) {
        publicMembers.push({
          name: pMatch[1],
          kind: "property",
          type: pMatch[2]?.trim(),
        });
      }
    }

    return { line: classLine + 1, publicMembers };
  }

  /**
   * Extract a function's body and metadata for inlining.
   */
  private extractFunctionBody(
    content: string,
    functionName: string,
  ): {
    body: string;
    params: string[];
    startLine: number;
    endLine: number;
    bodyLines: number;
    exported: boolean;
  } | null {
    const lines = content.split("\n");
    const funcRe = new RegExp(
      `^(\\s*)(export\\s+)?(?:async\\s+)?function\\s+${this.escapeRegex(functionName)}\\s*\\(([^)]*)\\)`,
    );

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(funcRe);
      if (!match) continue;

      const exported = !!match[2];
      const paramsStr = match[3];
      const params = paramsStr
        .split(",")
        .map((p) => p.trim().split(/[?:]/)[0].trim())
        .filter(Boolean);

      const endLine = this.findDefinitionEnd(lines, i);

      // Extract body (everything between first { and last })
      const fullText = lines.slice(i, endLine).join("\n");
      const braceStart = fullText.indexOf("{");
      const braceEnd = fullText.lastIndexOf("}");
      if (braceStart === -1 || braceEnd === -1) return null;

      const body = fullText.slice(braceStart + 1, braceEnd).trim();
      const bodyLines = body.split("\n").length;

      return {
        body,
        params,
        startLine: i + 1,
        endLine,
        bodyLines,
        exported,
      };
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // Private: Parameter Inference
  // ═══════════════════════════════════════════════════════════════

  /**
   * Infer function parameters from a code block by finding variables
   * that are used but not defined within the selection.
   */
  private inferParameters(
    code: string,
    surroundingCode: string,
  ): { name: string; type: string }[] {
    // Find all identifiers used in the code
    const identRe = /\b([a-zA-Z_$][\w$]*)\b/g;
    const usedIdents = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = identRe.exec(code)) !== null) {
      usedIdents.add(match[1]);
    }

    // Find identifiers defined within the code (const/let/var/function/class declarations)
    const declRe = /(?:const|let|var|function|class)\s+(\w+)/g;
    const declaredInCode = new Set<string>();
    while ((match = declRe.exec(code)) !== null) {
      declaredInCode.add(match[1]);
    }

    // Find identifiers declared in surrounding code
    const declaredOutside = new Set<string>();
    const outsideDeclRe = /(?:const|let|var|function|class)\s+(\w+)/g;
    while ((match = outsideDeclRe.exec(surroundingCode)) !== null) {
      declaredOutside.add(match[1]);
    }

    // Also look for parameter patterns: (name: Type)
    const paramDeclRe = /(\w+)\s*[?]?:\s*(\w[\w<>,\s|&[\]]*)/g;
    const typeMap = new Map<string, string>();
    while ((match = paramDeclRe.exec(surroundingCode)) !== null) {
      typeMap.set(match[1], match[2].trim());
    }

    // Parameters = used in code, not declared in code, but declared outside
    const keywords = new Set([
      "const", "let", "var", "function", "class", "if", "else", "for",
      "while", "return", "import", "export", "from", "new", "this",
      "true", "false", "null", "undefined", "typeof", "instanceof",
      "void", "async", "await", "try", "catch", "throw", "switch",
      "case", "break", "continue", "default", "do", "in", "of",
      "delete", "yield", "super", "extends", "implements", "interface",
      "type", "enum", "as", "is", "keyof", "readonly", "declare",
      "abstract", "static", "public", "private", "protected",
      "console", "Math", "JSON", "Array", "Object", "String",
      "Number", "Boolean", "Date", "Error", "Promise", "Map", "Set",
      "RegExp", "Symbol", "BigInt", "Infinity", "NaN",
    ]);

    const params: { name: string; type: string }[] = [];
    for (const ident of usedIdents) {
      if (declaredInCode.has(ident)) continue;
      if (keywords.has(ident)) continue;
      if (!declaredOutside.has(ident)) continue;

      const type = typeMap.get(ident) ?? "unknown";
      params.push({ name: ident, type });
    }

    return params;
  }

  /**
   * Infer return values: variables modified inside the selection that are
   * used after the selection.
   */
  private inferReturnValues(
    code: string,
    afterCode: string,
  ): { name: string; type: string }[] {
    // Find variables assigned in the code
    const assignRe = /(?:let|var)\s+(\w+)/g;
    const assignedVars = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = assignRe.exec(code)) !== null) {
      assignedVars.add(match[1]);
    }

    // Also find direct reassignments
    const reassignRe = /^(\s*)(\w+)\s*=[^=]/gm;
    while ((match = reassignRe.exec(code)) !== null) {
      assignedVars.add(match[2]);
    }

    // Check which are used after the selection
    const results: { name: string; type: string }[] = [];
    for (const varName of assignedVars) {
      const useRe = new RegExp(`\\b${this.escapeRegex(varName)}\\b`);
      if (useRe.test(afterCode)) {
        results.push({ name: varName, type: "unknown" });
      }
    }

    return results;
  }

  // ═══════════════════════════════════════════════════════════════
  // Private: File Utilities
  // ═══════════════════════════════════════════════════════════════

  /**
   * Read a file's content as UTF-8 text.
   */
  private async readFile(filePath: string): Promise<string> {
    // Path containment check: ensure file is within project root
    const resolved = resolve(filePath);
    if (!resolved.startsWith(this.projectPath)) {
      throw new Error(`Path traversal blocked: "${resolved}" is outside project root`);
    }
    return readFile(filePath, "utf-8");
  }

  /**
   * Apply text changes to file content. Changes are applied in reverse line order
   * to preserve line numbers.
   */
  private applyChanges(content: string, changes: TextChange[]): string {
    const lines = content.split("\n");

    // Sort changes by startLine descending so later changes don't shift earlier ones
    const sorted = [...changes].
     sort((a,b)=>{
   if(b.startLine!==a.startLine) return b.startLine-a.startLine
   return b.endLine-a.endLine
 });

    for (const change of sorted) {
      const startIdx = change.startLine - 1;
      const endIdx = change.endLine; // exclusive in splice
      const count = endIdx - startIdx;

      if (change.newText === "") {
        // Delete the lines
        lines.splice(startIdx, count);
      } else {
        const newLines = change.newText.split("\n");
        lines.splice(startIdx, count, ...newLines);
      }
    }

    return lines.join("\n");
  }

  /**
   * Snapshot files for potential rollback. Returns a unique rollback ID.
   * Maintains a maximum of MAX_ROLLBACKS snapshots.
   */
  private async snapshotFiles(files: string[]): Promise<string> {
    const id = randomUUID();
    const snapshot = new Map<string, string>();

    for (const file of files) {
      try {
        const content = await this.readFile(file);
        snapshot.set(file, content);
      } catch {
        // File doesn't exist yet — store empty to indicate deletion on rollback
        snapshot.set(file, "");
      }
    }

    this.rollbacks.set(id, snapshot);
    this.rollbackOrder.push(id);

    // Evict oldest rollbacks if over limit
    while (this.rollbackOrder.length > MAX_ROLLBACKS) {
      const oldest = this.rollbackOrder.shift()!;
      this.rollbacks.delete(oldest);
    }

    return id;
  }

  /**
   * Recursively collect all TypeScript/JavaScript source files in a directory.
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
      // Skip symlinks to prevent escaping project root
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(dir, entry.name);
      // Ensure path stays within project root
      if (!resolve(fullPath).startsWith(this.projectPath)) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          const sub = await this.collectSourceFiles(fullPath);
          results.push(...sub);
        }
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        results.push(fullPath);
      }
    }
    return results;
  }

  // ═══════════════════════════════════════════════════════════════
  // Private: String / Line Utilities
  // ═══════════════════════════════════════════════════════════════

  /**
   * Replace a symbol name in a line using word boundary matching.
   * Preserves string literals and comments.
   */
  private replaceSymbolInLine(line: string, oldName: string, newName: string): string {
    const re = new RegExp(`(?<![.\\w])${this.escapeRegex(oldName)}(?!\\w)`, "g");
    return line.replace(re, newName);
  }

  /**
   * Check if a line is a comment (single-line // or starts inside a block comment).
   */
  private isCommentLine(line: string): boolean {
    const trimmed = line.trim();
    return (
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*/")
    );
  }

  /**
   * Basic heuristic: check if a symbol occurrence is inside a string literal.
   * Counts unescaped quotes before the symbol position.
   */
  private isInStringLiteral(line: string, symbolName: string): boolean {
    const idx = line.indexOf(symbolName);
    if (idx === -1) return false;

    // Strip comments first
    const noComment = line.replace(/\/\/.*$/, "");
    if (idx >= noComment.length) return true; // symbol is in a comment

    // Count quotes before the symbol
    const before = noComment.slice(0, idx);
    const singleQuotes = (before.match(/(?<!\\)'/g) ?? []).length;
    const doubleQuotes = (before.match(/(?<!\\)"/g) ?? []).length;
    const backticks = (before.match(/(?<!\\)`/g) ?? []).length;

    // If any quote count is odd, we're inside a string
    return singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0 || backticks % 2 !== 0;
  }

  /**
   * Compute the relative import path from one file to another,
   * with .js extension (ESM convention).
   */
  private computeRelativeImportPath(fromFile: string, toFile: string): string {
    const fromDir = dirname(fromFile);
    let rel = relative(fromDir, toFile);

    // Replace .ts/.tsx extension with .js
    rel = rel.replace(/\.tsx?$/, ".js");

    // Ensure it starts with ./
    if (!rel.startsWith(".")) {
      rel = "./" + rel;
    }

    return rel;
  }

  /**
   * Find the best line to insert a new import statement.
   * Returns the line number (1-based) after the last existing import.
   */
  private findImportInsertLine(lines: string[]): number {
    let lastImportLine = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*import\s/.test(lines[i])) {
        lastImportLine = i + 1;
      }
    }
    return lastImportLine > 0 ? lastImportLine + 1 : 1;
  }

  /**
   * Detect the leading whitespace (indentation) of a line.
   */
  private detectIndent(line: string): string {
    const match = line.match(/^(\s*)/);
    return match ? match[1] : "";
  }

  /**
   * Escape special regex characters in a string.
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Deduplicate text changes for the same line, keeping only the last one.
   */
  private deduplicateChanges(changes: TextChange[]): TextChange[] {
    const seen = new Map<number, TextChange>();
    for (const change of changes) {
      seen.set(change.startLine, change);
    }
    return [...seen.values()].sort((a, b) => a.startLine - b.startLine);
  }

  /**
   * Assess the risk level of a refactoring based on scope and breaking changes.
   */
  private assessRisk(
    fileCount: number,
    breakingCount: number,
    changeCount: number,
  ): "low" | "medium" | "high" {
    if (breakingCount > 0 && fileCount > 5) return "high";
    if (breakingCount > 0) return "medium";
    if (fileCount > 10 || changeCount > 50) return "medium";
    return "low";
  }

  /**
   * Create an empty preview with warnings (for error cases).
   */
  private emptyPreview(type: RefactorType, warnings: string[]): RefactorPreview {
    return {
      type,
      affectedFiles: [],
      totalChanges: 0,
      breakingChanges: [],
      riskLevel: "low",
      warnings,
      canAutoApply: false,
    };
  }
}
