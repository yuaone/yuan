/**
 * ReasoningPanel — tree-based collapsible reasoning viewer.
 *
 * UX
 * - r            : open / close
 * - ↑ / ↓        : move selection
 * - → / Enter    : expand branch + open body
 * - ←            : collapse branch or close body
 * - 1..9         : quick jump to visible node
 * - esc          : close panel
 */

import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import stringWidth from "string-width";
import { MarkdownRenderer } from "./MarkdownRenderer.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { TOKENS } from "../lib/tokens.js";

export interface ReasoningPanelProps {
  content: string;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** Preview line budget per opened section body */
  maxHeight?: number;
}

interface ReasoningNode {
  id: string;
  title: string;
  level: number;
  body: string;
  children: ReasoningNode[];
}

interface VisibleTreeRow {
  node: ReasoningNode;
  depth: number;
  prefix: string;
  hasChildren: boolean;
  isExpanded: boolean;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 32);
}

function parseReasoningTree(content: string): ReasoningNode[] {
  const lines = content.split("\n");
  const roots: ReasoningNode[] = [];
  const stack: ReasoningNode[] = [];
  const preamble: string[] = [];
  let currentNode: ReasoningNode | null = null;
  let seq = 0;

  for (const line of lines) {
    const m = line.match(/^(#{1,4})\s+(.+)$/);

    if (m) {
      const level = m[1].length;
      const title = m[2].trim();
      const node: ReasoningNode = {
        id: `${seq++}-${level}-${slugify(title) || "section"}`,
        title,
        level,
        body: "",
        children: [],
      };

      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
        stack.pop();
      }

      const parent = stack[stack.length - 1];
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }

      stack.push(node);
      currentNode = node;
      continue;
    }

    if (currentNode) {
      currentNode.body += currentNode.body ? `\n${line}` : line;
    } else {
      preamble.push(line);
    }
  }

  const preambleText = preamble.join("\n").trim();
  if (preambleText) {
    roots.unshift({
      id: "overview",
      title: "Overview",
      level: 1,
      body: preambleText,
      children: [],
    });
  }

  return roots;
}

function collectIds(nodes: ReasoningNode[]): string[] {
  const out: string[] = [];
  const walk = (items: ReasoningNode[]) => {
    for (const item of items) {
      out.push(item.id);
      walk(item.children);
    }
  };
  walk(nodes);
  return out;
}

function countNodes(nodes: ReasoningNode[]): number {
  let count = 0;
  const walk = (items: ReasoningNode[]) => {
    for (const item of items) {
      count += 1;
      walk(item.children);
    }
  };
  walk(nodes);
  return count;
}

function findLastNodeWithBody(nodes: ReasoningNode[]): ReasoningNode | null {
  let last: ReasoningNode | null = null;

  const walk = (items: ReasoningNode[]) => {
    for (const item of items) {
      if (item.body.trim()) last = item;
      walk(item.children);
    }
  };

  walk(nodes);
  return last;
}

function buildInitialExpandedBranches(nodes: ReasoningNode[]): Record<string, boolean> {
  const expanded: Record<string, boolean> = {};

  const walk = (items: ReasoningNode[]) => {
    for (const item of items) {
      expanded[item.id] = item.level <= 1;
      walk(item.children);
    }
  };

  walk(nodes);
  return expanded;
}

function flattenVisibleTree(
  nodes: ReasoningNode[],
  expandedBranches: Record<string, boolean>,
): VisibleTreeRow[] {
  const rows: VisibleTreeRow[] = [];

  const walk = (items: ReasoningNode[], depth: number, ancestorHasPipe: boolean[]) => {
    items.forEach((node, index) => {
      const isLast = index === items.length - 1;
      const prefix =
        depth === 0
          ? ""
          : ancestorHasPipe
              .map((hasPipe) => (hasPipe ? `${TOKENS.tree.pipe} ` : "  "))
              .join("") + (isLast ? `${TOKENS.tree.last} ` : `${TOKENS.tree.branch} `);

      const hasChildren = node.children.length > 0;
      const isExpanded = !!expandedBranches[node.id];

      rows.push({
        node,
        depth,
        prefix,
        hasChildren,
        isExpanded,
      });

      if (hasChildren && isExpanded) {
        walk(node.children, depth + 1, [...ancestorHasPipe, !isLast]);
      }
    });
  };

  walk(nodes, 0, []);
  return rows;
}

function truncateMarkdownSafely(
  markdown: string,
  maxLines: number,
): { content: string; truncated: boolean } {
  const rawLines = markdown.split("\n");
  if (rawLines.length <= maxLines) {
    return { content: markdown, truncated: false };
  }

  const sliced = rawLines.slice(0, maxLines);
  const fenceCount = sliced.filter((line) => line.trim().startsWith("```")).length;

  if (fenceCount % 2 === 1) {
    sliced.push("```");
  }

  return {
    content: sliced.join("\n"),
    truncated: true,
  };
}

export function ReasoningPanel({
  content,
  isOpen,
  onOpen,
  onClose,
  maxHeight = 14,
}: ReasoningPanelProps): React.JSX.Element | null {
  const { columns } = useTerminalSize();

  const tree = useMemo(() => parseReasoningTree(content), [content]);
  const allIds = useMemo(() => collectIds(tree), [tree]);
  const totalSections = useMemo(() => countNodes(tree), [tree]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openBodyId, setOpenBodyId] = useState<string | null>(null);
  const [expandedBranches, setExpandedBranches] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const nextExpanded = buildInitialExpandedBranches(tree);
    setExpandedBranches((prev) => {
      const merged: Record<string, boolean> = {};
      for (const id of allIds) {
        merged[id] = prev[id] ?? nextExpanded[id] ?? false;
      }
      return merged;
    });

    if (!selectedId || !allIds.includes(selectedId)) {
      setSelectedId(allIds[0] ?? null);
    }

    if (!openBodyId || !allIds.includes(openBodyId)) {
      const last = findLastNodeWithBody(tree);
      setOpenBodyId(last?.id ?? allIds[0] ?? null);
    }
  }, [tree, allIds, openBodyId, selectedId]);

  const visibleRows = useMemo(
    () => flattenVisibleTree(tree, expandedBranches),
    [tree, expandedBranches],
  );

  const selectedIndex = useMemo(() => {
    const idx = visibleRows.findIndex((row) => row.node.id === selectedId);
    return idx >= 0 ? idx : 0;
  }, [visibleRows, selectedId]);

  const selectedRow = visibleRows[selectedIndex];
  const openNodeTitle =
    visibleRows.find((row) => row.node.id === openBodyId)?.node.title ?? "reasoning";

  useInput((input, key) => {
    if (input === "r") {
      if (isOpen) onClose();
      else onOpen();
      return;
    }

    if (!isOpen || visibleRows.length === 0) return;

    if (key.upArrow) {
      const next = visibleRows[Math.max(0, selectedIndex - 1)];
      if (next) setSelectedId(next.node.id);
      return;
    }

    if (key.downArrow) {
      const next = visibleRows[Math.min(visibleRows.length - 1, selectedIndex + 1)];
      if (next) setSelectedId(next.node.id);
      return;
    }

    if (/^[1-9]$/.test(input)) {
      const idx = Number(input) - 1;
      const row = visibleRows[idx];
      if (row) {
        setSelectedId(row.node.id);
        setOpenBodyId(row.node.id);
        if (row.hasChildren) {
          setExpandedBranches((prev) => ({ ...prev, [row.node.id]: true }));
        }
      }
      return;
    }

    if (!selectedRow) return;

    const current = selectedRow.node;
    const hasChildren = selectedRow.hasChildren;
    const isExpanded = selectedRow.isExpanded;

    if (key.leftArrow) {
      if (hasChildren && isExpanded) {
        setExpandedBranches((prev) => ({ ...prev, [current.id]: false }));
      } else if (openBodyId === current.id) {
        setOpenBodyId(null);
      }
      return;
    }

    if (key.rightArrow || key.return || input === " ") {
      if (hasChildren) {
        setExpandedBranches((prev) => ({ ...prev, [current.id]: true }));
      }
      if (current.body.trim()) {
        setOpenBodyId(current.id);
      }
      return;
    }

    if (key.escape) {
      onClose();
    }
  });

  if (!content.trim()) return null;

  const B = TOKENS.box;
  const borderColor = "#334155";
  const label = " ◈ reasoning ";
  const previewLineLimit = Math.max(6, maxHeight);

  if (!isOpen) {
    const hint = `${label}${totalSections} sections  ▼  (r to expand)`;
    const pad = Math.max(0, columns - stringWidth(hint) - 1);

    return (
      <Box width={columns}>
        <Text dimColor>
          {B.horizontal}
          {hint}
          {B.horizontal.repeat(pad)}
        </Text>
      </Box>
    );
  }

  const title = `${label}${openNodeTitle}`;
  const titlePad = Math.max(0, columns - stringWidth(title) - 2);
  const footerHint = "↑↓ move  enter/→ open  ← collapse  1-9 jump  esc close";
  const footer = footerHint.length > columns - 4
    ? footerHint.slice(0, columns - 7) + "..."
    : footerHint;

  return (
    <Box flexDirection="column" width={columns}>
      <Text color={borderColor}>
        {B.topLeft}
        {title}
        {B.horizontal.repeat(titlePad)}
        {B.topRight}
      </Text>

      {visibleRows.map((row, index) => {
        const isSelected = row.node.id === selectedId;
        const isBodyOpen = row.node.id === openBodyId && !!row.node.body.trim();
        const bodyPreview = isBodyOpen
          ? truncateMarkdownSafely(row.node.body, previewLineLimit)
          : null;

        const marker = row.hasChildren
          ? row.isExpanded
            ? "▼"
            : "▶"
          : isBodyOpen
            ? "●"
            : "○";

        const lineCount = row.node.body.trim()
          ? row.node.body.split("\n").filter((line) => line.trim()).length
          : 0;

        const depthPad = Math.min(12, row.depth * 2 + 2);
        const bodyWidth = Math.max(20, columns - depthPad - 6);

        return (
          <Box key={row.node.id} flexDirection="column">
            <Box>
              <Text color={borderColor}>{B.vertical} </Text>
              <Box width={Math.max(10, columns - 4)}>
                <Text
                  color={isSelected ? "cyan" : "white"}
                  bold={isSelected}
                >
                  {`${index < 9 ? `${index + 1} ` : "  "}${row.prefix}${marker} ${row.node.title}`}
                </Text>
                {lineCount > 0 ? (
                  <Text dimColor>{`  ${lineCount}L`}</Text>
                ) : null}
              </Box>
              <Text color={borderColor}> {B.vertical}</Text>
            </Box>

            {isBodyOpen && bodyPreview && (
              <Box paddingLeft={depthPad}>
                <Text color={borderColor}>{TOKENS.tree.pipe} </Text>
                <Box flexDirection="column" width={bodyWidth}>
                  <MarkdownRenderer
                    content={bodyPreview.content}
                    width={bodyWidth}
                  />
                  {bodyPreview.truncated ? (
                    <Text dimColor>… more hidden</Text>
                  ) : null}
                </Box>
              </Box>
            )}
          </Box>
        );
      })}

      <Box>
        <Text color={borderColor}>{B.vertical} </Text>
        <Text dimColor>{footer.padEnd(Math.max(0, columns - 4))}</Text>
        <Text color={borderColor}> {B.vertical}</Text>
      </Box>

      <Text color={borderColor}>
        {B.bottomLeft}
        {B.horizontal.repeat(Math.max(0, columns - 2))}
        {B.bottomRight}
      </Text>
    </Box>
  );
}