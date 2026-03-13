/**
 * @module reasoning-tree
 * @description Agent reasoning을 트리 구조로 저장
 */

export interface ReasoningNode {
  id: string;
  parentId?: string;
  label: string;
  text?: string;
  createdAt: number;
  children: ReasoningNode[];
}

export class ReasoningTree {
  private nodes = new Map<string, ReasoningNode>();
  private root: ReasoningNode;

  constructor() {
    this.root = this.createNode("root", "Agent Run");
  }

  private createNode(label: string, text?: string, parentId?: string) {
    const id = `r_${Math.random().toString(36).slice(2, 10)}`;

    const node: ReasoningNode = {
      id,
      parentId,
      label,
      text,
      createdAt: Date.now(),
      children: [],
    };

    this.nodes.set(id, node);

    if (parentId) {
      const parent = this.nodes.get(parentId);
      if (parent) parent.children.push(node);
    }

    return node;
  }

  add(label: string, text?: string, parentId?: string) {
    const parent = parentId ?? this.root.id;
    return this.createNode(label, text, parent);
  }

  getRoot() {
    return this.root;
  }

  toJSON() {
    return this.root;
  }

  reset() {
    this.nodes.clear();
    this.root = this.createNode("root", "Agent Run");
  }
}