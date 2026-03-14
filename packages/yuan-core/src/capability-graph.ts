/**
 * @module capability-graph
 * @description Capability Graph — represents tools, skills, playbooks, agents, and evidence
 * as interconnected graph nodes. Enables skill composition, smarter tool selection, and
 * reasoning about what the agent can/cannot do.
 *
 * Storage: ~/.yuan/capability-graph.json
 * Atomic writes (.tmp + renameSync).
 */

import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Types ───

export type CapabilityNodeType =
  | "tool"
  | "skill"
  | "playbook"
  | "agent"
  | "evidence";

export interface CapabilityNode {
  id: string;
  type: CapabilityNodeType;
  name: string;
  description: string;
  successRate: number; // 0..1
  usageCount: number;
  tags: string[];
  metadata: Record<string, unknown>;
  addedAt: string;
}

export type CapabilityEdgeType =
  | "uses"
  | "requires"
  | "produces"
  | "verified_by"
  | "learned_from"
  | "composed_of"
  | "conflicts_with";

export interface CapabilityEdge {
  fromId: string;
  toId: string;
  type: CapabilityEdgeType;
  weight: number; // 0..1 — how strong the relationship is
  addedAt: string;
}

export interface CapabilityPath {
  nodes: CapabilityNode[];
  edges: CapabilityEdge[];
  totalWeight: number;
}

// ─── Persistence Format ───

interface GraphData {
  nodes: CapabilityNode[];
  edges: CapabilityEdge[];
}

// ─── Default Nodes ───

function buildDefaultNodes(): CapabilityNode[] {
  const now = new Date().toISOString();
  const toolNodes: CapabilityNode[] = [
    {
      id: "tool:read_file",
      type: "tool",
      name: "read_file",
      description: "Read the contents of a file from the filesystem",
      successRate: 0.95,
      usageCount: 0,
      tags: ["io", "read", "file"],
      metadata: {},
      addedAt: now,
    },
    {
      id: "tool:write_file",
      type: "tool",
      name: "write_file",
      description: "Write or overwrite a file on the filesystem",
      successRate: 0.9,
      usageCount: 0,
      tags: ["io", "write", "file"],
      metadata: {},
      addedAt: now,
    },
    {
      id: "tool:shell_exec",
      type: "tool",
      name: "shell_exec",
      description: "Execute a shell command in a sandboxed environment",
      successRate: 0.85,
      usageCount: 0,
      tags: ["shell", "exec", "command"],
      metadata: {},
      addedAt: now,
    },
    {
      id: "tool:grep",
      type: "tool",
      name: "grep",
      description: "Search file contents using regular expressions",
      successRate: 0.95,
      usageCount: 0,
      tags: ["search", "grep", "regex", "file"],
      metadata: {},
      addedAt: now,
    },
    {
      id: "tool:glob",
      type: "tool",
      name: "glob",
      description: "Find files matching a glob pattern",
      successRate: 0.95,
      usageCount: 0,
      tags: ["search", "glob", "file"],
      metadata: {},
      addedAt: now,
    },
    {
      id: "tool:git_ops",
      type: "tool",
      name: "git_ops",
      description: "Perform git operations (status, diff, commit, log)",
      successRate: 0.88,
      usageCount: 0,
      tags: ["git", "vcs", "diff"],
      metadata: {},
      addedAt: now,
    },
  ];

  const skillNodes: CapabilityNode[] = [
    {
      id: "skill:ts_bugfix",
      type: "skill",
      name: "ts_bugfix",
      description:
        "Fix TypeScript compilation errors and type mismatches",
      successRate: 0.75,
      usageCount: 0,
      tags: ["typescript", "bugfix", "ts-bugfix"],
      metadata: {},
      addedAt: now,
    },
    {
      id: "skill:refactor",
      type: "skill",
      name: "refactor",
      description:
        "Restructure code without changing observable behaviour",
      successRate: 0.8,
      usageCount: 0,
      tags: ["refactor", "clean", "restructure"],
      metadata: {},
      addedAt: now,
    },
    {
      id: "skill:feature_add",
      type: "skill",
      name: "feature_add",
      description: "Implement a new feature end-to-end",
      successRate: 0.7,
      usageCount: 0,
      tags: ["feature-add", "implement", "add"],
      metadata: {},
      addedAt: now,
    },
  ];

  return [...toolNodes, ...skillNodes];
}

function buildDefaultEdges(): CapabilityEdge[] {
  const now = new Date().toISOString();
  return [
    // ts_bugfix uses: read_file, grep, shell_exec (tsc)
    { fromId: "skill:ts_bugfix", toId: "tool:read_file",  type: "uses", weight: 0.9, addedAt: now },
    { fromId: "skill:ts_bugfix", toId: "tool:grep",       type: "uses", weight: 0.8, addedAt: now },
    { fromId: "skill:ts_bugfix", toId: "tool:shell_exec", type: "uses", weight: 0.7, addedAt: now },
    // refactor uses: read_file, grep, write_file
    { fromId: "skill:refactor", toId: "tool:read_file",  type: "uses", weight: 0.9, addedAt: now },
    { fromId: "skill:refactor", toId: "tool:grep",       type: "uses", weight: 0.8, addedAt: now },
    { fromId: "skill:refactor", toId: "tool:write_file", type: "uses", weight: 0.85, addedAt: now },
    // feature_add uses: read_file, write_file, grep, glob, shell_exec
    { fromId: "skill:feature_add", toId: "tool:read_file",  type: "uses", weight: 0.9, addedAt: now },
    { fromId: "skill:feature_add", toId: "tool:write_file", type: "uses", weight: 0.9, addedAt: now },
    { fromId: "skill:feature_add", toId: "tool:grep",       type: "uses", weight: 0.7, addedAt: now },
    { fromId: "skill:feature_add", toId: "tool:glob",       type: "uses", weight: 0.6, addedAt: now },
    { fromId: "skill:feature_add", toId: "tool:shell_exec", type: "uses", weight: 0.75, addedAt: now },
  ];
}

// ─── CapabilityGraph ───

export class CapabilityGraph extends EventEmitter {
  private readonly storageFile: string;
  private readonly storageDir: string;

  private nodes: Map<string, CapabilityNode> = new Map();
  // Adjacency list keyed by fromId
  private edges: Map<string, CapabilityEdge[]> = new Map();

  constructor(storageDir?: string) {
    super();
    this.storageDir =
      storageDir ?? join(homedir(), ".yuan");
    this.storageFile = join(this.storageDir, "capability-graph.json");
    this._load();
  }

  // ─── Public API ───

  /**
   * Add or update a node. Emits agent:capability_graph_updated.
   */
  upsertNode(
    node: Omit<CapabilityNode, "addedAt"> & { addedAt?: string },
  ): void {
    const existing = this.nodes.get(node.id);
    const action: "added" | "updated" = existing ? "updated" : "added";
    const resolved: CapabilityNode = {
      ...node,
      addedAt: node.addedAt ?? new Date().toISOString(),
    };
    this.nodes.set(node.id, resolved);
    this._save();
    this.emit("event", {
      kind: "agent:capability_graph_updated",
      nodeId: node.id,
      action,
      nodeType: node.type,
      timestamp: Date.now(),
    });
  }

  /**
   * Add a directed edge between two nodes.
   * If the edge (fromId, toId, type) already exists, it is replaced.
   */
  addEdge(
    fromId: string,
    toId: string,
    type: CapabilityEdgeType,
    weight: number = 0.5,
  ): void {
    const edge: CapabilityEdge = {
      fromId,
      toId,
      type,
      weight: Math.max(0, Math.min(1, weight)),
      addedAt: new Date().toISOString(),
    };

    const list = this.edges.get(fromId) ?? [];
    // Replace if same (fromId, toId, type) triple already exists
    const idx = list.findIndex(
      (e) => e.toId === toId && e.type === type,
    );
    if (idx >= 0) {
      list[idx] = edge;
    } else {
      list.push(edge);
    }
    this.edges.set(fromId, list);
    this._save();
  }

  /**
   * Find nodes matching the given filter criteria.
   */
  findNodes(filter: {
    type?: CapabilityNodeType;
    tags?: string[];
    minSuccessRate?: number;
  }): CapabilityNode[] {
    const results: CapabilityNode[] = [];
    for (const node of this.nodes.values()) {
      if (filter.type !== undefined && node.type !== filter.type) continue;
      if (
        filter.minSuccessRate !== undefined &&
        node.successRate < filter.minSuccessRate
      )
        continue;
      if (filter.tags && filter.tags.length > 0) {
        const hasAllTags = filter.tags.every((t) => node.tags.includes(t));
        if (!hasAllTags) continue;
      }
      results.push(node);
    }
    return results;
  }

  /**
   * Get all edges originating from a node, optionally filtered by edge type.
   */
  getEdges(nodeId: string, edgeType?: CapabilityEdgeType): CapabilityEdge[] {
    const list = this.edges.get(nodeId) ?? [];
    if (edgeType === undefined) return [...list];
    return list.filter((e) => e.type === edgeType);
  }

  /**
   * BFS path search between two nodes. Max depth 5. Returns shortest path by hop count.
   */
  findPath(fromId: string, toId: string): CapabilityPath | null {
    if (!this.nodes.has(fromId) || !this.nodes.has(toId)) return null;
    if (fromId === toId) {
      const node = this.nodes.get(fromId)!;
      return { nodes: [node], edges: [], totalWeight: 1 };
    }

    const MAX_DEPTH = 5;

    // BFS state: [currentNodeId, pathNodeIds, pathEdges]
    type BFSEntry = {
      nodeId: string;
      pathNodeIds: string[];
      pathEdges: CapabilityEdge[];
    };

    const queue: BFSEntry[] = [
      { nodeId: fromId, pathNodeIds: [fromId], pathEdges: [] },
    ];
    const visited = new Set<string>([fromId]);

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.pathNodeIds.length > MAX_DEPTH) continue;

      const outEdges = this.edges.get(current.nodeId) ?? [];
      for (const edge of outEdges) {
        if (visited.has(edge.toId)) continue;

        const newPathNodeIds = [...current.pathNodeIds, edge.toId];
        const newPathEdges = [...current.pathEdges, edge];

        if (edge.toId === toId) {
          // Found! Build result
          const nodes = newPathNodeIds.map((id) => this.nodes.get(id)!).filter(Boolean);
          const totalWeight =
            newPathEdges.length > 0
              ? newPathEdges.reduce((sum, e) => sum + e.weight, 0) /
                newPathEdges.length
              : 0;
          return { nodes, edges: newPathEdges, totalWeight };
        }

        visited.add(edge.toId);
        queue.push({
          nodeId: edge.toId,
          pathNodeIds: newPathNodeIds,
          pathEdges: newPathEdges,
        });
      }
    }

    return null;
  }

  /**
   * Get composed capabilities: all tool/skill nodes reachable from nodes
   * tagged with taskType via "uses" or "composed_of" edges (max depth 3).
   */
  getComposition(taskType: string): CapabilityNode[] {
    // Find seed nodes tagged with taskType
    const seeds = this.findNodes({ tags: [taskType] });
    const result = new Map<string, CapabilityNode>();
    const seen = new Set<string>();

    const traverse = (nodeId: string, depth: number): void => {
      if (depth > 3 || seen.has(nodeId)) return;
      seen.add(nodeId);

      const node = this.nodes.get(nodeId);
      if (node) result.set(nodeId, node);

      const outEdges = this.edges.get(nodeId) ?? [];
      for (const edge of outEdges) {
        if (edge.type === "uses" || edge.type === "composed_of") {
          traverse(edge.toId, depth + 1);
        }
      }
    };

    for (const seed of seeds) {
      traverse(seed.id, 0);
    }

    return Array.from(result.values());
  }

  /**
   * Update success rate for a node using exponential moving average.
   * newRate = (oldRate * (n-1) + (success ? 1 : 0)) / n
   */
  recordOutcome(nodeId: string, success: boolean): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    const n = node.usageCount + 1;
    node.successRate = (node.successRate * (n - 1) + (success ? 1 : 0)) / n;
    node.usageCount = n;
    this._save();
  }

  /**
   * Export the full graph as a plain JSON object.
   */
  export(): { nodes: CapabilityNode[]; edges: CapabilityEdge[] } {
    const nodes = Array.from(this.nodes.values());
    const edges: CapabilityEdge[] = [];
    for (const list of this.edges.values()) {
      edges.push(...list);
    }
    return { nodes, edges };
  }

  /**
   * Import skills from SkillRegistry as graph nodes.
   * Each skill is added as a "skill" type node; existing nodes are updated.
   */
  importFromSkillRegistry(
    skills: Array<{
      id: string;
      name: string;
      taskType: string;
      pattern: string;
      successRate: number;
      usageCount: number;
    }>,
  ): void {
    for (const skill of skills) {
      this.upsertNode({
        id: `skill:${skill.id}`,
        type: "skill",
        name: skill.name,
        description: skill.pattern,
        successRate: skill.successRate,
        usageCount: skill.usageCount,
        tags: [skill.taskType],
        metadata: { sourceId: skill.id },
      });
    }
  }

  // ─── Internal ───

  private _load(): void {
    try {
      if (!existsSync(this.storageDir)) {
        mkdirSync(this.storageDir, { recursive: true });
      }
      if (!existsSync(this.storageFile)) {
        // First init: pre-populate defaults
        this._populateDefaults();
        this._save();
        return;
      }
      const raw = readFileSync(this.storageFile, "utf-8");
      const data = JSON.parse(raw) as GraphData;

      for (const node of data.nodes ?? []) {
        this.nodes.set(node.id, node);
      }
      for (const edge of data.edges ?? []) {
        const list = this.edges.get(edge.fromId) ?? [];
        list.push(edge);
        this.edges.set(edge.fromId, list);
      }
    } catch {
      // Non-fatal: start with defaults on corrupt/missing file
      this._populateDefaults();
      this._save();
    }
  }

  private _populateDefaults(): void {
    for (const node of buildDefaultNodes()) {
      this.nodes.set(node.id, node);
    }
    for (const edge of buildDefaultEdges()) {
      const list = this.edges.get(edge.fromId) ?? [];
      list.push(edge);
      this.edges.set(edge.fromId, list);
    }
  }

  private _save(): void {
    const tmpFile = `${this.storageFile}.tmp`;
    try {
      if (!existsSync(this.storageDir)) {
        mkdirSync(this.storageDir, { recursive: true });
      }
      const data: GraphData = this.export();
      writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf-8");
      renameSync(tmpFile, this.storageFile);
    } catch {
      // Non-fatal: storage failures should not crash the agent loop
    }
  }
}
