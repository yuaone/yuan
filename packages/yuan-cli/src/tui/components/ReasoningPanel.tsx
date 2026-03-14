/**
 * ReasoningPanel — smart collapsible reasoning viewer.
 *
 * Displays ONLY real LLM extended thinking (source: "llm").
 * Auto-detects section boundaries in plain text (no markdown headers required).
 *
 * UX
 * - r            : open / close
 * - up / down    : move selection
 * - right / Enter: expand branch + open body
 * - left         : collapse branch or close body
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

/* ─── Helpers ──────────────────────────────────────────────────────── */

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 32);
}

/**
 * Original tree parser — used when content has markdown `#` headers.
 */
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

  // Discard preamble text (text before first ## header) — no synthetic "Overview" node
  return roots;
}

/**
 * Smart section parser for plain-text LLM reasoning (no markdown headers).
 *
 * Splits on natural boundaries:
 * - Double newlines (paragraph breaks)
 * - Numbered steps: "1.", "2.", "Step 1:", etc.
 * - Transition phrases: "First,", "Then,", "Next,", "Finally,", "Let me", "Now ", "Actually", "Wait,"
 *
 * Extracts a short title from the first line of each section.
 */
function parseReasoningIntoSections(content: string): ReasoningNode[] {
  // Split on double-newlines first
  const paragraphs = content.split(/\n{2,}/).filter((s) => s.trim());

  if (paragraphs.length === 0) {
    return [];
  }

  if (paragraphs.length === 1) {
    // Single block — show as one "Thinking" section
    return [
      {
        id: "thinking-0",
        title: "Thinking",
        level: 1,
        body: content.trim(),
        children: [],
      },
    ];
  }

  // Group paragraphs into logical sections
  return paragraphs.map((para, i) => {
    const firstLine = para.split("\n")[0]?.trim() ?? "";

    // Try to use first line as title if it's short enough and looks like a heading
    const isShortEnough = firstLine.length > 0 && firstLine.length <= 60;
    // Remove leading markers like "1.", "Step 1:", "First,", etc.
    const cleanedTitle = firstLine
      .replace(/^(?:step\s*\d+[:.]\s*|(\d+)[.)]\s*)/i, "")
      .replace(/^(?:First|Then|Next|Finally|Now|Actually|Wait|Let me|However|So|But),?\s*/i, "")
      .trim();

    let title: string;
    let body: string;

    if (isShortEnough && cleanedTitle.length > 0) {
      title = cleanedTitle.length <= 50 ? cleanedTitle : cleanedTitle.slice(0, 47) + "...";
      // Body is remaining lines after first
      const rest = para.split("\n").slice(1).join("\n").trim();
      body = rest || para.trim();
    } else {
      title = `Part ${i + 1}`;
      body = para.trim();
    }

    return {
      id: `section-${i}`,
      title,
      level: 1,
      body,
      children: [],
    };
  });
}

/**
 * Choose the right parser based on content shape.
 * If content has markdown `#` headers, use the tree parser; otherwise section parser.
 */
function parseContent(content: string): ReasoningNode[] {
  if (/\n#{1,4}\s+/.test(content)) {
    return parseReasoningTree(content);
  }
  return parseReasoningIntoSections(content);
}

/* ─── Tree traversal helpers ───────────────────────────────────────── */

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
): { content: string; truncated: boolean; totalLines: number } {
  const rawLines = markdown.split("\n");
  const totalLines = rawLines.length;
  if (rawLines.length <= maxLines) {
    return { content: markdown, truncated: false, totalLines };
  }

  const sliced = rawLines.slice(0, maxLines);
  const fenceCount = sliced.filter((line) => line.trim().startsWith("```")).length;

  if (fenceCount % 2 === 1) {
    sliced.push("```");
  }

  return {
    content: sliced.join("\n"),
    truncated: true,
    totalLines,
  };
}

/* ─── Color palette ────────────────────────────────────────────────── */

const COLORS = {
  border: "#334155",       // slate border
  sectionTitle: "#94a3b8", // muted section title
  selected: "#67e8f9",     // cyan highlight
  thinkingText: "#64748b", // dim slate for reasoning body
  hint: "#475569",         // very dim hint text
} as const;

/* ─── Component ────────────────────────────────────────────────────── */

export function ReasoningPanel({
  content,
  isOpen,
  onOpen,
  onClose,
  maxHeight = 14,
}: ReasoningPanelProps): React.JSX.Element | null {
  const { columns } = useTerminalSize();

  const tree = useMemo(() => parseContent(content), [content]);
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

  // Hook 1: Always active — handles 'r' toggle only.
  // Must be separate so it never blocks InputBox keys when panel is closed.
  useInput((input) => {
    if (input === "r") {
      if (isOpen) onClose();
      else onOpen();
    }
  });

  // Hook 2: isActive:isOpen — handles navigation ONLY when panel is open.
  // When isOpen=false this hook is dormant, so InputBox receives Enter/arrows uninterrupted.
  useInput(
    (input, key) => {
      if (visibleRows.length === 0) return;

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
    },
    { isActive: isOpen },
  );

  if (!content.trim()) return null;

  // Panel is closed — render nothing (no collapsed bar)
  // FooterBar shows "r reasons" hint so user knows it exists
  if (!isOpen) return null;

  const B = TOKENS.box;
  const previewLineLimit = Math.max(6, Math.min(12, maxHeight));

  /* ─── Expanded state ──────────────────────────────────────────── */

  const titleLabel = ` thinking  ${totalSections} section${totalSections !== 1 ? "s" : ""} `;
  const titlePad = Math.max(0, columns - stringWidth(titleLabel) - 4);
  const footerHint = "up/dn move  enter/right open  left collapse  1-9 jump  esc close";
  const footer =
    footerHint.length > columns - 4
      ? footerHint.slice(0, columns - 7) + "..."
      : footerHint;

  return (
    <Box flexDirection="column" width={columns}>
      {/* Top border */}
      <Text color={COLORS.border}>
        {B.topLeft}
        <Text color={COLORS.selected}>{" ◈"}</Text>
        <Text color={COLORS.sectionTitle}>{titleLabel}</Text>
        {B.horizontal.repeat(titlePad)}
        {B.topRight}
      </Text>

      {/* Section rows */}
      {visibleRows.map((row, index) => {
        const isSelected = row.node.id === selectedId;
        const isBodyOpen = row.node.id === openBodyId && !!row.node.body.trim();
        const bodyPreview = isBodyOpen
          ? truncateMarkdownSafely(row.node.body, previewLineLimit)
          : null;

        // Markers: selected gets a filled marker, others get subtle ones
        const marker = isSelected
          ? row.hasChildren
            ? row.isExpanded
              ? "▼"
              : "▶"
            : "▶"
          : row.hasChildren
            ? row.isExpanded
              ? "▼"
              : "▶"
            : "·";

        const lineCount = row.node.body.trim()
          ? row.node.body.split("\n").filter((line) => line.trim()).length
          : 0;

        const depthPad = Math.min(12, row.depth * 2 + 2);
        const bodyWidth = Math.max(20, columns - depthPad - 6);

        return (
          <Box key={row.node.id} flexDirection="column">
            {/* Section header row */}
            <Box>
              <Text color={COLORS.border}>{B.vertical} </Text>
              <Box width={Math.max(10, columns - 4)}>
                <Text color={COLORS.border}>{"│ "}</Text>
                <Text
                  color={isSelected ? COLORS.selected : COLORS.sectionTitle}
                  bold={isSelected}
                >
                  {`${index < 9 ? `${index + 1} ` : "  "}${row.prefix}${marker} ${row.node.title}`}
                </Text>
                {lineCount > 0 ? (
                  <Text color={COLORS.hint}>{`  ${lineCount}L`}</Text>
                ) : null}
              </Box>
              <Text color={COLORS.border}>{B.vertical}</Text>
            </Box>

            {/* Body preview */}
            {isBodyOpen && bodyPreview && (
              <Box paddingLeft={depthPad}>
                <Text color={COLORS.border}>{"│ "}</Text>
                <Box flexDirection="column" width={bodyWidth}>
                  <MarkdownRenderer
                    content={bodyPreview.content}
                    width={bodyWidth}
                  />
                  {bodyPreview.truncated ? (
                    <Text color={COLORS.hint}>
                      {"... "}
                      {bodyPreview.totalLines - previewLineLimit}
                      {" more lines"}
                    </Text>
                  ) : null}
                </Box>
              </Box>
            )}
          </Box>
        );
      })}

      {/* Footer */}
      <Box>
        <Text color={COLORS.border}>{B.vertical} </Text>
        <Text color={COLORS.hint}>{footer.padEnd(Math.max(0, columns - 4))}</Text>
        <Text color={COLORS.border}> {B.vertical}</Text>
      </Box>

      {/* Bottom border */}
      <Text color={COLORS.border}>
        {B.bottomLeft}
        {B.horizontal.repeat(Math.max(0, columns - 2))}
        {B.bottomRight}
      </Text>
    </Box>
  );
}
