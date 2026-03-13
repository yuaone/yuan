/**
 * @module dependency-analyzer
 * @description TypeScript/JavaScript file import graph analyzer.
 * Determines which files can be modified independently vs which must be modified together.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, dirname, extname, relative } from "node:path";

// ─── Types ───

/** Represents a single file node in the dependency graph. */
export interface FileNode {
  /** Absolute file path */
  path: string;
  /** Detected language (ts, tsx, js, jsx) */
  language: string;
  /** Exported symbol names */
  exports: string[];
  /** Import references */
  imports: ImportRef[];
  /** Estimated cyclomatic complexity */
  complexity: number;
}

/** A single import reference from a file. */
export interface ImportRef {
  /** The import specifier (path string) */
  source: string;
  /** Imported symbol names */
  symbols: string[];
  /** Whether this is a type-only import */
  isTypeOnly: boolean;
}

/** Full dependency graph for a project. */
export interface FileDependencyGraph {
  /** Map from absolute path to FileNode */
  nodes: Map<string, FileNode>;
  /** Map from absolute path to list of absolute paths it imports */
  edges: Map<string, string[]>;
}

/** A group of files that can (or cannot) be modified in parallel. */
export interface IndependentGroup {
  /** Absolute file paths in this group */
  files: string[];
  /** Whether files in this group can be modified in parallel */
  canParallelize: boolean;
  /** Human-readable reason */
  reason: string;
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

// ─── Regex patterns ───

// import { X, Y } from "Z"  |  import X from "Z"  |  import * as X from "Z"
const IMPORT_RE =
  /import\s+(?:type\s+)?(?:\{([^}]*)\}|(\w+)|\*\s+as\s+(\w+))\s+from\s+["']([^"']+)["']/g;

// import "Z" (side-effect)
const IMPORT_SIDE_EFFECT_RE = /import\s+["']([^"']+)["']/g;
const RE_EXPORT_RE = /export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
// export { X } from "Z" (re-exports)
const RE_EXPORT_ALL_RE = /export\s+\*\s+from\s+["']([^"']+)["']/g;

// require("Z")
const REQUIRE_RE = /require\s*\(\s*["']([^"']+)["']\s*\)/g;

// Named exports: export function/class/const/let/var/interface/type/enum/abstract
const EXPORT_NAMED_RE =
  /export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|interface|type|enum)\s+(\w+)/g;

// export default
const EXPORT_DEFAULT_RE = /export\s+default\s+/g;

// export { X, Y }  (without "from")
const EXPORT_LIST_RE = /export\s+\{([^}]*)\}(?!\s*from)/g;

// Complexity indicators
const COMPLEXITY_RE =
  /\b(?:function\s+\w+|(?:async\s+)?(?:\w+\s*\([^)]*\)\s*\{)|if\s*\(|for\s*\(|while\s*\(|switch\s*\(|catch\s*\(|\?\?|&&|\|\||=>)/g;

/**
 * Analyzes TypeScript/JavaScript import dependency graphs.
 *
 * Scans project directories, parses import/export statements via regex,
 * and provides utilities for grouping files by independence and detecting
 * circular dependencies.
 */
export class DependencyAnalyzer {
  /**
   * Analyze a project directory and build an import dependency graph.
   * Scans all .ts/.js/.tsx/.jsx files, parses import/export statements via regex.
   *
   * @param projectPath - Absolute path to the project root
   * @returns The complete file dependency graph
   */
  async analyze(projectPath: string): Promise<FileDependencyGraph> {
    const absRoot = resolve(projectPath);
    const files = await this.collectSourceFiles(absRoot);
    const nodes = new Map<string, FileNode>();
    const edges = new Map<string, string[]>();

    // First pass: parse all files
    for (const filePath of files) {
      const content = await readFile(filePath, "utf-8");
      const node = this.parseFile(filePath, content);
      nodes.set(filePath, node);
    }

    // Second pass: resolve import paths and build edges
    for (const [filePath, node] of nodes) {
      const resolvedImports: string[] = [];
      for (const imp of node.imports) {
        const resolved = this.resolveImport(filePath, imp.source, files);
        if (resolved) {
          resolvedImports.push(resolved);
        }
      }
      edges.set(filePath, [...new Set(resolvedImports)]);
    }

    return { nodes, edges };
  }

  /**
   * Given target files to modify, group them into independent sets
   * that can be modified in parallel without conflicts.
   *
   * Two files are independent if neither imports the other (directly or transitively).
   *
   * @param graph - The dependency graph
   * @param targetFiles - Files intended for modification
   * @returns Groups of files with parallelization info
   */
  groupIndependentFiles(
    graph: FileDependencyGraph,
    targetFiles: string[],
  ): IndependentGroup[] {
    // Build transitive dependency sets (both directions) for each target file
    const transitiveDeps = new Map<string, Set<string>>();

    for (const file of targetFiles) {
      const forward = this.getTransitiveDeps(graph, file, "forward");
      const reverse = this.getTransitiveDeps(graph, file, "reverse");
      const all = new Set([...forward, ...reverse]);
      all.delete(file);
      transitiveDeps.set(file, all);
    }

    // Build conflict graph among target files
    // Two target files conflict if one is in the other's transitive deps
    const conflictAdj = new Map<string, Set<string>>();
    for (const f of targetFiles) {
      conflictAdj.set(f, new Set());
    }
    for (let i = 0; i < targetFiles.length; i++) {
      for (let j = i + 1; j < targetFiles.length; j++) {
        const a = targetFiles[i];
        const b = targetFiles[j];
        const depsA = transitiveDeps.get(a)!;
        const depsB = transitiveDeps.get(b)!;
        if (depsA.has(b) || depsB.has(a)) {
          conflictAdj.get(a)!.add(b);
          conflictAdj.get(b)!.add(a);
        }
      }
    }

    // Greedy graph coloring to find independent groups
    const groups: IndependentGroup[] = [];
    const assigned = new Set<string>();

    for (const file of targetFiles) {
      if (assigned.has(file)) continue;

      const group: string[] = [file];
      assigned.add(file);

      // Try to add other unassigned files that don't conflict with any in group
      for (const candidate of targetFiles) {
        if (assigned.has(candidate)) continue;
        const conflicts = conflictAdj.get(candidate)!;
        const canAdd = group.every((g) => !conflicts.has(g));
        if (canAdd) {
          group.push(candidate);
          assigned.add(candidate);
        }
      }

      if (group.length === 1) {
        groups.push({
          files: group,
          canParallelize: true,
          reason: "Single file, no dependency conflicts",
        });
      } else {
        groups.push({
          files: group,
          canParallelize: true,
          reason: `${group.length} files with no mutual import dependencies`,
        });
      }
    }

    return groups;
  }

  /**
   * Find all files that would be affected by changes to the given files
   * (reverse dependency lookup).
   *
   * @param graph - The dependency graph
   * @param changedFiles - Files that have been or will be changed
   * @returns Absolute paths of all affected files (excluding the changed files themselves)
   */
  findAffectedFiles(
    graph: FileDependencyGraph,
    changedFiles: string[],
  ): string[] {
    const affected = new Set<string>();
    const visited = new Set<string>();

    // Build reverse edge map
    const reverseEdges = new Map<string, string[]>();
    for (const [from, tos] of graph.edges) {
      for (const to of tos) {
        let rev = reverseEdges.get(to);
        if (!rev) {
          rev = [];
          reverseEdges.set(to, rev);
        }
        rev.push(from);
      }
    }

    // BFS from each changed file along reverse edges
    const queue = [...changedFiles];
    for (const f of changedFiles) {
      visited.add(f);
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      const dependents = reverseEdges.get(current) ?? [];
      for (const dep of dependents) {
        if (!visited.has(dep)) {
          visited.add(dep);
          affected.add(dep);
          queue.push(dep);
        }
      }
    }

    // Remove the changed files themselves from affected set
    for (const f of changedFiles) {
      affected.delete(f);
    }

    return [...affected];
  }

  /**
   * Detect strongly connected components (circular dependencies)
   * using Tarjan's algorithm. Files in an SCC must be modified together.
   *
   * @param graph - The dependency graph
   * @returns Array of SCCs (each SCC is an array of file paths). Only SCCs with 2+ files are returned.
   */
  findCircularDependencies(graph: FileDependencyGraph): string[][] {
    let index = 0;
    const stack: string[] = [];
    const onStack = new Set<string>();
    const indices = new Map<string, number>();
    const lowlinks = new Map<string, number>();
    const result: string[][] = [];

    const strongConnect = (v: string): void => {
      indices.set(v, index);
      lowlinks.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);

      const successors = graph.edges.get(v) ?? [];
      for (const w of successors) {
        if (!indices.has(w)) {
          strongConnect(w);
          lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
        } else if (onStack.has(w)) {
          lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
        }
      }

      // If v is a root node, pop the SCC
      if (lowlinks.get(v) === indices.get(v)) {
        const scc: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== v);

        // Only include SCCs with actual cycles (2+ nodes)
        if (scc.length > 1) {
          result.push(scc);
        }
      }
    };

    for (const node of graph.nodes.keys()) {
      if (!indices.has(node)) {
        strongConnect(node);
      }
    }

    return result;
  }

  // ─── Private helpers ───

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

  /** Parse a single file's imports, exports, and complexity. */
  private parseFile(filePath: string, content: string): FileNode {
    const ext = extname(filePath).slice(1); // remove leading dot
    const imports = this.parseImports(content);
    const exports = this.parseExports(content);
    const complexity = this.estimateComplexity(content);

    return {
      path: filePath,
      language: ext,
      exports,
      imports,
      complexity,
    };
  }

  /** Parse all import statements from file content. */
  private parseImports(content: string): ImportRef[] {
    const refs: ImportRef[] = [];

    // Standard imports: import { X } from "Y", import X from "Y", import * as X from "Y"
    let match: RegExpExecArray | null;
    const importRe = new RegExp(IMPORT_RE.source, "g");
    while ((match = importRe.exec(content)) !== null) {
      const namedGroup = match[1]; // { X, Y }
      const defaultImport = match[2]; // X
      const namespaceImport = match[3]; // * as X
      const source = match[4];

      const symbols: string[] = [];
      if (namedGroup) {
        symbols.push(
          ...namedGroup.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean),
        );
      }
      if (defaultImport) symbols.push(defaultImport);
      if (namespaceImport) symbols.push(namespaceImport);

      // Detect type-only: check if "type" keyword precedes the symbols
      const fullMatch = match[0];
      const isTypeOnly = /import\s+type\s+/.test(fullMatch);

      refs.push({ source, symbols, isTypeOnly });
    }
 
    // Side-effect imports: import "Z"
    const sideEffectRe = new RegExp(IMPORT_SIDE_EFFECT_RE.source, "g");
    while ((match = sideEffectRe.exec(content)) !== null) {
      refs.push({
        source: match[1],
        symbols: [],
        isTypeOnly: false,
      });
    }
    // Re-exports: export { X } from "Y"
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
    const reExportAllRe = new RegExp(RE_EXPORT_ALL_RE.source, "g");
    while ((match = reExportAllRe.exec(content)) !== null) {
      refs.push({
        source: match[1],
        symbols: ["*"],
        isTypeOnly: false,
      });
    }
    // CJS require
    const requireRe = new RegExp(REQUIRE_RE.source, "g");
    while ((match = requireRe.exec(content)) !== null) {
      refs.push({ source: match[1], symbols: [], isTypeOnly: false });
    }

    return refs;
  }

  /** Parse all export declarations from file content. */
  private parseExports(content: string): string[] {
    const exports: string[] = [];

    let match: RegExpExecArray | null;

    // Named exports
    const namedRe = new RegExp(EXPORT_NAMED_RE.source, "g");
    while ((match = namedRe.exec(content)) !== null) {
      exports.push(match[1]);
    }

    // export default
    const defaultRe = new RegExp(EXPORT_DEFAULT_RE.source, "g");
    if (defaultRe.exec(content) !== null) {
      exports.push("default");
    }

    // export { X, Y }
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

  /** Estimate cyclomatic complexity of file content. */
  private estimateComplexity(content: string): number {
    const matches = content.match(COMPLEXITY_RE);
    return matches ? matches.length : 1;
  }

  /**
   * Resolve a relative import path to an absolute file path.
   * Returns undefined for external/package imports.
   */
  private resolveImport(
    fromFile: string,
    importPath: string,
    knownFiles: string[],
  ): string | undefined {
    // Only resolve relative imports
    if (!importPath.startsWith(".")) {
      return undefined;
    }

    const dir = dirname(fromFile);
    let resolved = resolve(dir, importPath);

    // Try exact match first
    if (knownFiles.includes(resolved)) return resolved;

    // Strip .js extension and try .ts (common in ESM TS projects)
    if (resolved.endsWith(".js")) {
      const tsPath = resolved.slice(0, -3) + ".ts";
      if (knownFiles.includes(tsPath)) return tsPath;
      const tsxPath = resolved.slice(0, -3) + ".tsx";
      if (knownFiles.includes(tsxPath)) return tsxPath;
    }

    // Try adding extensions
    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
      const withExt = resolved + ext;
      if (knownFiles.includes(withExt)) return withExt;
    }

    // Try as directory with index file
    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
      const indexPath = join(resolved, `index${ext}`);
      if (knownFiles.includes(indexPath)) return indexPath;
    }

    return undefined;
  }

  /**
   * Get transitive dependencies in a given direction.
   * "forward" = files this file depends on.
   * "reverse" = files that depend on this file.
   */
  private getTransitiveDeps(
    graph: FileDependencyGraph,
    startFile: string,
    direction: "forward" | "reverse",
  ): Set<string> {
    const result = new Set<string>();
    const visited = new Set<string>();
    const queue = [startFile];
    visited.add(startFile);

    // Build reverse edge map if needed
    let edgeMap: Map<string, string[]>;
    if (direction === "forward") {
      edgeMap = graph.edges;
    } else {
      edgeMap = new Map();
      for (const [from, tos] of graph.edges) {
        for (const to of tos) {
          let rev = edgeMap.get(to);
          if (!rev) {
            rev = [];
            edgeMap.set(to, rev);
          }
          rev.push(from);
        }
      }
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = edgeMap.get(current) ?? [];
      for (const n of neighbors) {
        if (!visited.has(n)) {
          visited.add(n);
          result.add(n);
          queue.push(n);
        }
      }
    }

    return result;
  }
}
