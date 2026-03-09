/**
 * MarkdownRenderer — markdown to terminal rendering.
 * Handles: bold, italic, inline code, code blocks, headers, lists, tables.
 */

import React from "react";
import { Box, Text } from "ink";

export interface MarkdownRendererProps {
  content: string;
  width: number;
}

interface RenderedBlock {
  type: "paragraph" | "code" | "header" | "list" | "blank" | "table";
  content: string;
  language?: string;
  level?: number;
  /** Table data: rows of cells */
  tableRows?: string[][];
  /** Table column alignments */
  tableAligns?: ("left" | "center" | "right")[];
}

function parseBlocks(content: string): RenderedBlock[] {
  const lines = content.split("\n");
  const blocks: RenderedBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block (fenced)
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: "code", content: codeLines.join("\n"), language });
      i++; // skip closing ```
      continue;
    }

    // Table detection: current line has |, next line is separator (|---|)
    if (line.includes("|") && i + 1 < lines.length && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const tableLines: string[] = [];
      // Collect header
      tableLines.push(line);
      // Collect separator
      tableLines.push(lines[i + 1]);
      i += 2;
      // Collect body rows
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        tableLines.push(lines[i]);
        i++;
      }

      const parsedTable = parseTable(tableLines);
      if (parsedTable) {
        blocks.push({
          type: "table",
          content: tableLines.join("\n"),
          tableRows: parsedTable.rows,
          tableAligns: parsedTable.aligns,
        });
      } else {
        blocks.push({ type: "paragraph", content: tableLines.join("\n") });
      }
      continue;
    }

    // Header
    const headerMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headerMatch) {
      blocks.push({
        type: "header",
        content: headerMatch[2],
        level: headerMatch[1].length,
      });
      i++;
      continue;
    }

    // List item
    if (/^\s*[-*+]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
      blocks.push({ type: "list", content: line });
      i++;
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      blocks.push({ type: "blank", content: "" });
      i++;
      continue;
    }

    // Paragraph — collect consecutive non-special lines
    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("```") &&
      !lines[i].match(/^#{1,6}\s/) &&
      !/^\s*[-*+]\s/.test(lines[i]) &&
      !/^\s*\d+\.\s/.test(lines[i]) &&
      // Don't eat table rows into paragraph
      !(lines[i].includes("|") && i + 1 < lines.length && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1]))
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: "paragraph", content: paraLines.join("\n") });
  }

  return blocks;
}

/** Parse markdown table lines into rows and alignments */
function parseTable(lines: string[]): { rows: string[][]; aligns: ("left" | "center" | "right")[] } | null {
  if (lines.length < 2) return null;

  const parseRow = (line: string): string[] => {
    // Strip leading/trailing pipes and split
    const trimmed = line.replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map((cell) => cell.trim());
  };

  const header = parseRow(lines[0]);
  const separatorCells = parseRow(lines[1]);

  // Parse alignments from separator row
  const aligns: ("left" | "center" | "right")[] = separatorCells.map((cell) => {
    const s = cell.trim();
    if (s.startsWith(":") && s.endsWith(":")) return "center";
    if (s.endsWith(":")) return "right";
    return "left";
  });

  const rows: string[][] = [header];
  for (let i = 2; i < lines.length; i++) {
    rows.push(parseRow(lines[i]));
  }

  return { rows, aligns };
}

/** Render inline formatting: **bold**, *italic*, `code` */
function InlineText({ text }: { text: string }): React.JSX.Element {
  const parts: React.JSX.Element[] = [];
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<Text key={key++}>{text.slice(lastIndex, match.index)}</Text>);
    }

    if (match[2]) {
      parts.push(<Text key={key++} bold>{match[2]}</Text>);
    } else if (match[3]) {
      parts.push(<Text key={key++} dimColor>{match[3]}</Text>);
    } else if (match[4]) {
      parts.push(<Text key={key++} color="white"> {match[4]} </Text>);
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(<Text key={key++}>{text.slice(lastIndex)}</Text>);
  }

  if (parts.length === 0) {
    return <Text>{text}</Text>;
  }

  return <Text>{parts}</Text>;
}

/** Render a markdown table with box-drawing borders */
function TableBlock({ rows, aligns, width }: { rows: string[][]; aligns: ("left" | "center" | "right")[]; width: number }): React.JSX.Element {
  if (rows.length === 0) return <Box />;

  const numCols = Math.max(...rows.map((r) => r.length));
  // Compute column widths: max content width per column, capped by available space
  const colWidths: number[] = [];
  for (let c = 0; c < numCols; c++) {
    let maxW = 0;
    for (const row of rows) {
      const cell = row[c] || "";
      maxW = Math.max(maxW, cell.length);
    }
    colWidths.push(Math.min(maxW, Math.max(6, Math.floor((width - numCols * 3 - 1) / numCols))));
  }

  // Pad/truncate cell content
  const padCell = (text: string, colIdx: number): string => {
    const w = colWidths[colIdx] || 6;
    if (text.length > w) return text.slice(0, w - 1) + "…";
    const align = aligns[colIdx] || "left";
    if (align === "right") return text.padStart(w);
    if (align === "center") {
      const pad = w - text.length;
      const left = Math.floor(pad / 2);
      return " ".repeat(left) + text + " ".repeat(pad - left);
    }
    return text.padEnd(w);
  };

  // Build border lines
  const hLine = colWidths.map((w) => "─".repeat(w + 2)).join("┼");
  const topBorder = "┌" + colWidths.map((w) => "─".repeat(w + 2)).join("┬") + "┐";
  const midBorder = "├" + hLine + "┤";
  const botBorder = "└" + colWidths.map((w) => "─".repeat(w + 2)).join("┴") + "┘";

  const renderRow = (row: string[], rowIdx: number): string => {
    const cells = [];
    for (let c = 0; c < numCols; c++) {
      cells.push(` ${padCell(row[c] || "", c)} `);
    }
    return "│" + cells.join("│") + "│";
  };

  const outputLines: string[] = [];
  outputLines.push(topBorder);
  // Header row
  outputLines.push(renderRow(rows[0], 0));
  outputLines.push(midBorder);
  // Body rows
  for (let r = 1; r < rows.length; r++) {
    outputLines.push(renderRow(rows[r], r));
  }
  outputLines.push(botBorder);

  return (
    <Box flexDirection="column" marginBottom={0}>
      {outputLines.map((line, i) => (
        <Text key={i} dimColor>{line}</Text>
      ))}
    </Box>
  );
}

function renderBlock(block: RenderedBlock, idx: number, width: number): React.JSX.Element {
  switch (block.type) {
    case "header":
      return (
        <Box key={idx} marginBottom={0}>
          <Text bold color="white">
            {block.content}
          </Text>
        </Box>
      );

    case "code": {
      const maxW = Math.max(10, width - 6);
      return (
        <Box key={idx} flexDirection="column" marginLeft={2} marginBottom={0}>
          {block.language && (
            <Text dimColor>{block.language}</Text>
          )}
          {block.content.split("\n").map((line, i) => (
            <Text key={i} dimColor>
              {"  "}{line.length > maxW ? line.slice(0, maxW - 1) + "…" : line}
            </Text>
          ))}
        </Box>
      );
    }

    case "table":
      return (
        <Box key={idx}>
          <TableBlock
            rows={block.tableRows || []}
            aligns={block.tableAligns || []}
            width={width}
          />
        </Box>
      );

    case "list":
      return (
        <Box key={idx}>
          <InlineText text={block.content} />
        </Box>
      );

    case "blank":
      return <Box key={idx} height={1} />;

    case "paragraph":
    default:
      return (
        <Box key={idx}>
          <InlineText text={block.content} />
        </Box>
      );
  }
}

export function MarkdownRenderer({
  content,
  width,
}: MarkdownRendererProps): React.JSX.Element {
  const blocks = parseBlocks(content);

  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => renderBlock(block, i, width))}
    </Box>
  );
}
