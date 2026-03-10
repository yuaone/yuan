/**
 * @module repo-knowledge-graph
 * @description Repo Knowledge Graph — Code structure as a queryable graph.
 *
 * Nodes: File, Class, Function, Variable, Interface, Type, Module
 * Edges: imports, calls, extends, implements, depends_on, exports, contains
 *
 * Enables: impact analysis, refactor safety, dependency tracing, dead code detection.
 *
 * Uses lightweight regex-based parsing (not full AST) for speed.
 */

import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { join, relative, dirname, extname, basename } from "node:path";

// ─── Types ───

export type NodeType =
  | "file"
  | "class"
  | "function"
  | "variable"
  | "interface"
  | "type"
  | "module";

export type EdgeType =
  | "imports"
  | "calls"
  | "extends"
  | "implements"
  | "depends_on"
  | "exports"
  | "contains";

export interface GraphNode {
  /** Unique: "file:src/index.ts" or "fn:src/index.ts:myFunc" */
  id: string;
  type: NodeType;
  name: string;
  filePath: string;
  line?: number;
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  from: string; // node id
  to: string; // node id
  type: EdgeType;
  metadata?: Record<string, unknown>;
}

export interface ImpactReport {
  /** Directly affected nodes */
  direct: GraphNode[];
  /** Transitively affected (2+ hops) */
  transitive: GraphNode[];
  /** Total impact radius */
  radius: number;
  /** Risk level based on affected node count */
  risk: "low" | "medium" | "high" | "critical";
  /** Files that need to be checked/updated */
  affectedFiles: string[];
}

// ─── Regex Patterns for Parsing ───

const IMPORT_PATTERN =
  /^import\s+(?:(?:type\s+)?(?:\{[^}]*\}|[\w*]+(?:\s+as\s+\w+)?|\*\s+as\s+\w+)(?:\s*,\s*(?:\{[^}]*\}|[\w*]+))*\s+from\s+)?['"]([^'"]+)['"]/gm;

const EXPORT_NAMED_PATTERN =
  /^export\s+(?:type\s+)?(?:interface|type|class|function|const|let|var|enum|abstract\s+class)\s+(\w+)/gm;

const EXPORT_DEFAULT_PATTERN =
  /^export\s+default\s+(?:class|function|abstract\s+class)\s+(\w+)/gm;

const CLASS_PATTERN =
  /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/gm;

const FUNCTION_PATTERN =
  /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm;

const INTERFACE_PATTERN =
  /^(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+([\w,\s]+))?/gm;

const TYPE_ALIAS_PATTERN =
  /^(?:export\s+)?type\s+(\w+)\s*=/gm;

const CONST_EXPORT_PATTERN =
  /^(?:export\s+)?(?:const|let|var)\s+(\w+)/gm;

// ─── RepoKnowledgeGraph ───

/**
 * RepoKnowledgeGraph — queryable code structure graph.
 *
 * Builds a lightweight graph from TypeScript/JavaScript source files
 * using regex-based parsing. Supports impact analysis, dead code detection,
 * dependency tracing, and incremental updates.
 */
export class RepoKnowledgeGraph {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: GraphEdge[] = [];
  private storagePath: string;

  constructor(projectRoot: string) {
    this.storagePath = join(projectRoot, ".yuan", "knowledge-graph.json");
  }

  /**
   * Load persisted graph from disk.
   */
  async init(): Promise<void> {
    await this.load();
  }

  /** Add a node to the graph */
  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
  }

  /** Add an edge (deduplicates) */
  addEdge(edge: GraphEdge): void {
    const exists = this.edges.some(
      (e) =>
        e.from === edge.from && e.to === edge.to && e.type === edge.type,
    );
    if (!exists) {
      this.edges.push(edge);
    }
  }

  /** Find all callers of a function/method */
  findCallers(nodeId: string): GraphNode[] {
    const callerIds = this.edges
      .filter((e) => e.to === nodeId && e.type === "calls")
      .map((e) => e.from);

    return callerIds
      .map((id) => this.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined);
  }

  /** Find all dependents of a file/module */
  findDependents(nodeId: string): GraphNode[] {
    const depIds = new Set<string>();

    for (const edge of this.edges) {
      if (edge.to === nodeId && (edge.type === "imports" || edge.type === "depends_on")) {
        depIds.add(edge.from);
      }
    }

    return Array.from(depIds)
      .map((id) => this.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined);
  }

  /** Analyze impact of changing a node (BFS traversal) */
  analyzeImpact(nodeId: string, maxDepth: number = 3): ImpactReport {
    const direct: GraphNode[] = [];
    const transitive: GraphNode[] = [];
    const visited = new Set<string>();
    visited.add(nodeId);

    // BFS — find all nodes that depend on the changed node
    interface QueueItem {
      id: string;
      depth: number;
    }
    const queue: QueueItem[] = [];

    // Seed with direct dependents
    for (const edge of this.edges) {
      if (
        edge.to === nodeId &&
        (edge.type === "imports" ||
          edge.type === "depends_on" ||
          edge.type === "calls" ||
          edge.type === "extends" ||
          edge.type === "implements")
      ) {
        if (!visited.has(edge.from)) {
          visited.add(edge.from);
          queue.push({ id: edge.from, depth: 1 });
        }
      }
    }

    while (queue.length > 0) {
      const item = queue.shift()!;
      const node = this.nodes.get(item.id);
      if (!node) continue;

      if (item.depth === 1) {
        direct.push(node);
      } else {
        transitive.push(node);
      }

      // Continue BFS if within depth limit
      if (item.depth < maxDepth) {
        for (const edge of this.edges) {
          if (
            edge.to === item.id &&
            !visited.has(edge.from) &&
            (edge.type === "imports" ||
              edge.type === "depends_on" ||
              edge.type === "calls")
          ) {
            visited.add(edge.from);
            queue.push({ id: edge.from, depth: item.depth + 1 });
          }
        }
      }
    }

    // Collect unique affected files
    const affectedFiles = new Set<string>();
    for (const n of [...direct, ...transitive]) {
      affectedFiles.add(n.filePath);
    }

    const totalAffected = direct.length + transitive.length;
    let risk: ImpactReport["risk"];
    if (totalAffected === 0) risk = "low";
    else if (totalAffected <= 3) risk = "medium";
    else if (totalAffected <= 10) risk = "high";
    else risk = "critical";

    return {
      direct,
      transitive,
      radius: visited.size - 1,
      risk,
      affectedFiles: Array.from(affectedFiles),
    };
  }

  /**
   * Find dead code — nodes with no incoming edges (except file nodes).
   * File nodes are always "alive". Only exported symbols that are never
   * imported elsewhere are considered dead.
   */
  findDeadCode(): GraphNode[] {
    const nodesWithIncoming = new Set<string>();

    for (const edge of this.edges) {
      nodesWithIncoming.add(edge.to);
    }

    const dead: GraphNode[] = [];
    for (const [id, node] of this.nodes) {
      // Skip file/module nodes — they're always roots
      if (node.type === "file" || node.type === "module") continue;
      if (!nodesWithIncoming.has(id)) {
        dead.push(node);
      }
    }

    return dead;
  }

  /** Get subgraph for a specific file */
  getFileGraph(
    filePath: string,
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const fileNodes: GraphNode[] = [];
    const fileEdges: GraphEdge[] = [];
    const nodeIds = new Set<string>();

    for (const [id, node] of this.nodes) {
      if (node.filePath === filePath) {
        fileNodes.push(node);
        nodeIds.add(id);
      }
    }

    for (const edge of this.edges) {
      if (nodeIds.has(edge.from) || nodeIds.has(edge.to)) {
        fileEdges.push(edge);
      }
    }

    return { nodes: fileNodes, edges: fileEdges };
  }

  /**
   * Build graph from TypeScript source files (regex-based parsing).
   * Scans .ts/.tsx files under projectRoot, extracts imports, exports,
   * classes, functions, interfaces, and types.
   */
  async buildFromProject(
    projectRoot: string,
    filePatterns?: string[],
  ): Promise<void> {
    const extensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
    const ignorePatterns = [
      "node_modules",
      "dist",
      ".git",
      ".next",
      "coverage",
      "__pycache__",
    ];

    const files = await this.collectFiles(
      projectRoot,
      extensions,
      ignorePatterns,
    );

    // Apply file pattern filter if provided
    const filtered = filePatterns
      ? files.filter((f) =>
          filePatterns.some((p) => {
            try {
              return new RegExp(p).test(f);
            } catch {
              return f.includes(p);
            }
          }),
        )
      : files;

    for (const filePath of filtered) {
      await this.indexFile(projectRoot, filePath);
    }
  }

  /**
   * Incrementally update graph for changed files.
   * Removes old nodes/edges for the file, then re-indexes.
   */
  async updateFiles(changedFiles: string[]): Promise<void> {
    for (const filePath of changedFiles) {
      // Remove old nodes for this file
      const oldNodeIds: string[] = [];
      for (const [id, node] of this.nodes) {
        if (node.filePath === filePath) {
          oldNodeIds.push(id);
        }
      }
      for (const id of oldNodeIds) {
        this.nodes.delete(id);
      }

      // Remove old edges involving these nodes
      const oldIdSet = new Set(oldNodeIds);
      this.edges = this.edges.filter(
        (e) => !oldIdSet.has(e.from) && !oldIdSet.has(e.to),
      );

      // Determine project root from storage path
      const projectRoot = dirname(dirname(this.storagePath)); // .yuan/../..

      // Re-index if file still exists
      try {
        await stat(filePath);
        await this.indexFile(projectRoot, filePath);
      } catch {
        // File was deleted — removal above is sufficient
      }
    }
  }

  /** Persist graph to disk */
  async save(): Promise<void> {
    const dir = dirname(this.storagePath);
    await mkdir(dir, { recursive: true });

    const data = {
      nodes: Array.from(this.nodes.values()),
      edges: this.edges,
      version: 1,
      updatedAt: Date.now(),
    };

    await writeFile(this.storagePath, JSON.stringify(data), "utf-8");
  }

  /** Get graph statistics */
  getStats(): { nodes: number; edges: number; files: number } {
    const files = new Set<string>();
    for (const node of this.nodes.values()) {
      files.add(node.filePath);
    }
    return {
      nodes: this.nodes.size,
      edges: this.edges.length,
      files: files.size,
    };
  }

  /** Get a node by ID */
  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  /** Get all nodes */
  getAllNodes(): GraphNode[] {
    return Array.from(this.nodes.values());
  }

  /** Get all edges */
  getAllEdges(): GraphEdge[] {
    return [...this.edges];
  }

  // ─── Private: Persistence ───

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.storagePath, "utf-8");
      const data = JSON.parse(raw) as {
        nodes: GraphNode[];
        edges: GraphEdge[];
      };

      this.nodes.clear();
      this.edges = [];

      for (const node of data.nodes) {
        this.nodes.set(node.id, node);
      }
      this.edges = data.edges ?? [];
    } catch {
      // No persisted graph — start fresh
    }
  }

  // ─── Private: File Collection ───

  private async collectFiles(
    dir: string,
    extensions: Set<string>,
    ignore: string[],
  ): Promise<string[]> {
    const results: string[] = [];

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (ignore.includes(entry.name)) continue;

        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          const sub = await this.collectFiles(fullPath, extensions, ignore);
          results.push(...sub);
        } else if (entry.isFile() && extensions.has(extname(entry.name))) {
          results.push(fullPath);
        }
      }
    } catch {
      // Permission error or similar — skip
    }

    return results;
  }

  // ─── Private: Indexing ───

  private async indexFile(
    projectRoot: string,
    filePath: string,
  ): Promise<void> {
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      return;
    }

    const relPath = relative(projectRoot, filePath);
    const fileId = `file:${relPath}`;

    // Add file node
    this.addNode({
      id: fileId,
      type: "file",
      name: basename(filePath),
      filePath: relPath,
    });

    // Parse imports
    this.parseImports(content, relPath, fileId, projectRoot);

    // Parse exports and declarations
    this.parseDeclarations(content, relPath, fileId);
  }

  private parseImports(
    content: string,
    relPath: string,
    fileId: string,
    _projectRoot: string,
  ): void {
    // Reset lastIndex for global regex
    IMPORT_PATTERN.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = IMPORT_PATTERN.exec(content)) !== null) {
      const importPath = match[1];

      // Resolve relative imports to file nodes
      if (importPath.startsWith(".")) {
        const dir = dirname(relPath);
        let resolved = join(dir, importPath);

        // Normalize extension
        if (!extname(resolved)) {
          resolved += ".ts"; // Default assumption
        }

        // Remove leading ./ and normalize
        resolved = resolved.replace(/\\/g, "/");
        const targetId = `file:${resolved}`;

        this.addEdge({
          from: fileId,
          to: targetId,
          type: "imports",
          metadata: { importPath },
        });
      } else {
        // External module — create module node
        const moduleId = `module:${importPath}`;
        if (!this.nodes.has(moduleId)) {
          this.addNode({
            id: moduleId,
            type: "module",
            name: importPath,
            filePath: "",
          });
        }

        this.addEdge({
          from: fileId,
          to: moduleId,
          type: "imports",
          metadata: { importPath },
        });
      }
    }
  }

  private parseDeclarations(
    content: string,
    relPath: string,
    fileId: string,
  ): void {
    const lines = content.split("\n");

    // Track which patterns we're using with their node types
    const patterns: Array<{
      regex: RegExp;
      nodeType: NodeType;
      prefix: string;
    }> = [
      { regex: CLASS_PATTERN, nodeType: "class", prefix: "class" },
      { regex: FUNCTION_PATTERN, nodeType: "function", prefix: "fn" },
      { regex: INTERFACE_PATTERN, nodeType: "interface", prefix: "iface" },
      { regex: TYPE_ALIAS_PATTERN, nodeType: "type", prefix: "type" },
    ];

    for (const { regex, nodeType, prefix } of patterns) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = regex.exec(content)) !== null) {
        const name = match[1];
        const nodeId = `${prefix}:${relPath}:${name}`;
        const line = this.getLineNumber(content, match.index);

        this.addNode({
          id: nodeId,
          type: nodeType,
          name,
          filePath: relPath,
          line,
        });

        // File contains this declaration
        this.addEdge({
          from: fileId,
          to: nodeId,
          type: "contains",
        });

        // Handle class extends
        if (nodeType === "class" && match[2]) {
          const parentName = match[2].trim();
          // Create a tentative edge — target might be resolved later
          this.addEdge({
            from: nodeId,
            to: `class:*:${parentName}`,
            type: "extends",
            metadata: { parentName },
          });
        }

        // Handle class implements
        if (nodeType === "class" && match[3]) {
          const ifaces = match[3]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          for (const iface of ifaces) {
            this.addEdge({
              from: nodeId,
              to: `iface:*:${iface}`,
              type: "implements",
              metadata: { interfaceName: iface },
            });
          }
        }

        // Handle interface extends
        if (nodeType === "interface" && match[2]) {
          const parents = match[2]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          for (const parent of parents) {
            this.addEdge({
              from: nodeId,
              to: `iface:*:${parent}`,
              type: "extends",
              metadata: { parentName: parent },
            });
          }
        }
      }
    }

    // Parse exported constants/variables
    CONST_EXPORT_PATTERN.lastIndex = 0;
    let constMatch: RegExpExecArray | null;
    while ((constMatch = CONST_EXPORT_PATTERN.exec(content)) !== null) {
      const name = constMatch[1];
      // Only track exports (not internal variables)
      if (constMatch[0].startsWith("export")) {
        const nodeId = `var:${relPath}:${name}`;
        const line = this.getLineNumber(content, constMatch.index);

        this.addNode({
          id: nodeId,
          type: "variable",
          name,
          filePath: relPath,
          line,
        });

        this.addEdge({
          from: fileId,
          to: nodeId,
          type: "exports",
        });
      }
    }

    // Parse export default
    EXPORT_DEFAULT_PATTERN.lastIndex = 0;
    let defaultMatch: RegExpExecArray | null;
    while ((defaultMatch = EXPORT_DEFAULT_PATTERN.exec(content)) !== null) {
      const name = defaultMatch[1];
      const nodeId = `default:${relPath}:${name}`;
      const line = this.getLineNumber(content, defaultMatch.index);

      this.addNode({
        id: nodeId,
        type: "class",
        name,
        filePath: relPath,
        line,
        metadata: { isDefault: true },
      });

      this.addEdge({
        from: fileId,
        to: nodeId,
        type: "exports",
      });
    }

    // Parse named exports
    EXPORT_NAMED_PATTERN.lastIndex = 0;
    let namedMatch: RegExpExecArray | null;
    while ((namedMatch = EXPORT_NAMED_PATTERN.exec(content)) !== null) {
      const name = namedMatch[1];
      // Check if we already have this node (from class/function parsing above)
      const existingId = this.findNodeByName(relPath, name);
      const nodeId = existingId ?? `export:${relPath}:${name}`;

      if (!existingId) {
        const line = this.getLineNumber(content, namedMatch.index);
        this.addNode({
          id: nodeId,
          type: this.inferNodeType(namedMatch[0]),
          name,
          filePath: relPath,
          line,
        });
      }

      this.addEdge({
        from: fileId,
        to: nodeId,
        type: "exports",
      });
    }
  }

  // ─── Private: Utilities ───

  private getLineNumber(content: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index; i++) {
      if (content[i] === "\n") line++;
    }
    return line;
  }

  private findNodeByName(
    filePath: string,
    name: string,
  ): string | undefined {
    const prefixes = ["class", "fn", "iface", "type", "var", "default"];
    for (const prefix of prefixes) {
      const id = `${prefix}:${filePath}:${name}`;
      if (this.nodes.has(id)) return id;
    }
    return undefined;
  }

  private inferNodeType(declaration: string): NodeType {
    if (/\bclass\b/.test(declaration)) return "class";
    if (/\bfunction\b/.test(declaration)) return "function";
    if (/\binterface\b/.test(declaration)) return "interface";
    if (/\btype\b/.test(declaration)) return "type";
    if (/\b(?:const|let|var)\b/.test(declaration)) return "variable";
    return "variable";
  }
}
