/**
 * MarkdownRenderer — terminal markdown renderer with lightweight syntax highlighting.
 * Supports:
 * - headers
 * - paragraphs
 * - unordered / ordered lists
 * - fenced code blocks
 * - inline bold / italic / code
 * - simple tables
 */

import React from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";

export interface MarkdownRendererProps {
  content: string;
  width: number;
}

interface RenderedBlock {
  type: "paragraph" | "code" | "header" | "list" | "blank" | "table";
  content: string;
  language?: string;
  level?: number;
  listOrdered?: boolean;
  listNumber?: string;
  listText?: string;
  listDepth?: number;
  tableRows?: string[][];
  tableAligns?: ("left" | "center" | "right")[];
}

interface CodeToken {
  text: string;
  color?: string;
  dimColor?: boolean;
  bold?: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clipDisplay(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text;

  let out = "";
  let width = 0;

  for (const ch of text) {
    const w = stringWidth(ch);
    if (width + w >= maxWidth) break;
    out += ch;
    width += w;
  }

  return out + "…";
}

function padDisplay(text: string, width: number, align: "left" | "center" | "right"): string {
  const textWidth = stringWidth(text);
  const pad = Math.max(0, width - textWidth);

  if (align === "right") return " ".repeat(pad) + text;
  if (align === "center") {
    const left = Math.floor(pad / 2);
    return " ".repeat(left) + text + " ".repeat(pad - left);
  }
  return text + " ".repeat(pad);
}

function getKeywords(language?: string): string[] {
  const lang = (language ?? "").toLowerCase();

  if (["ts", "tsx", "js", "jsx", "javascript", "typescript"].includes(lang)) {
    return [
      "const", "let", "var", "function", "return", "if", "else", "switch", "case",
      "for", "while", "break", "continue", "try", "catch", "finally", "throw",
      "import", "from", "export", "default", "async", "await", "class", "extends",
      "new", "typeof", "instanceof", "true", "false", "null", "undefined",
      "interface", "type", "implements",
    ];
  }

  if (["py", "python"].includes(lang)) {
    return [
      "def", "return", "if", "elif", "else", "for", "while", "break", "continue",
      "try", "except", "finally", "raise", "class", "import", "from", "as",
      "True", "False", "None", "async", "await", "with", "pass",
    ];
  }

  if (["sh", "bash", "zsh", "shell"].includes(lang)) {
    return [
      "if", "then", "else", "fi", "for", "in", "do", "done", "case", "esac",
      "function", "export", "local", "return",
    ];
  }

  if (["json"].includes(lang)) {
    return ["true", "false", "null"];
  }

  return [];
}

function tokenizeCodeLine(line: string, language?: string): CodeToken[] {
  const keywords = getKeywords(language);
  const keywordPattern = keywords.length
    ? `\\b(?:${keywords.map(escapeRegExp).join("|")})\\b`
    : "$^";

  const tokenPattern = new RegExp(
    "(//.*$|#.*$|\"(?:\\\\.|[^\"])*\"|'(?:\\\\.|[^'])*'|`(?:\\\\.|[^`])*`|" +
      keywordPattern +
      "|\\b\\d+(?:\\.\\d+)?\\b)",
    "g",
  );

  const tokens: CodeToken[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(line)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: line.slice(lastIndex, match.index) });
    }

    const value = match[0];

    if (value.startsWith("//") || value.startsWith("#")) {
      tokens.push({ text: value, dimColor: true });
    } else if (
      value.startsWith("\"") ||
      value.startsWith("'") ||
      value.startsWith("`")
    ) {
      tokens.push({ text: value, color: "green" });
    } else if (/^\d/.test(value)) {
      tokens.push({ text: value, color: "yellow" });
    } else {
      tokens.push({ text: value, color: "cyan", bold: true });
    }

    lastIndex = match.index + value.length;
  }

  if (lastIndex < line.length) {
    tokens.push({ text: line.slice(lastIndex) });
  }

  return tokens.length ? tokens : [{ text: line }];
}

function CodeLine({
  line,
  language,
  width,
}: {
  line: string;
  language?: string;
  width: number;
}): React.JSX.Element {
  const clipped = clipDisplay(line, width);
  const tokens = tokenizeCodeLine(clipped, language);

  return (
    <Text>
      {tokens.map((token, i) => (
        <Text
          key={`${i}-${token.text}`}
          color={token.color}
          bold={token.bold}
          dimColor={token.dimColor}
        >
          {token.text}
        </Text>
      ))}
    </Text>
  );
}

function parseBlocks(content: string): RenderedBlock[] {
  const lines = content.split("\n");
  const blocks: RenderedBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const codeLines: string[] = [];
      i += 1;

      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        codeLines.push(lines[i] ?? "");
        i += 1;
      }

      blocks.push({
        type: "code",
        content: codeLines.join("\n"),
        language,
      });

      i += 1;
      continue;
    }

    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1] ?? "")
    ) {
      const tableLines: string[] = [line, lines[i + 1] ?? ""];
      i += 2;

      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") {
        tableLines.push(lines[i] ?? "");
        i += 1;
      }

      const parsed = parseTable(tableLines);
      if (parsed) {
        blocks.push({
          type: "table",
          content: tableLines.join("\n"),
          tableRows: parsed.rows,
          tableAligns: parsed.aligns,
        });
      } else {
        blocks.push({ type: "paragraph", content: tableLines.join("\n") });
      }

      continue;
    }

    const headerMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headerMatch) {
      blocks.push({
        type: "header",
        content: headerMatch[2],
        level: headerMatch[1].length,
      });
      i += 1;
      continue;
    }

    const ulMatch = line.match(/^(\s*)[-*+]\s(.*)$/);
    if (ulMatch) {
      blocks.push({
        type: "list",
        content: line,
        listOrdered: false,
        listText: ulMatch[2],
        listDepth: Math.floor(ulMatch[1].length / 2),
      });
      i += 1;
      continue;
    }

    const olMatch = line.match(/^(\s*)(\d+)\.\s(.*)$/);
    if (olMatch) {
      blocks.push({
        type: "list",
        content: line,
        listOrdered: true,
        listNumber: olMatch[2],
        listText: olMatch[3],
        listDepth: Math.floor(olMatch[1].length / 2),
      });
      i += 1;
      continue;
    }

    if (line.trim() === "") {
      blocks.push({ type: "blank", content: "" });
      i += 1;
      continue;
    }

    const paraLines: string[] = [line];
    i += 1;

    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !(lines[i] ?? "").startsWith("```") &&
      !/^#{1,6}\s/.test(lines[i] ?? "") &&
      !/^\s*[-*+]\s/.test(lines[i] ?? "") &&
      !/^\s*\d+\.\s/.test(lines[i] ?? "") &&
      !(
        (lines[i] ?? "").includes("|") &&
        i + 1 < lines.length &&
        /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1] ?? "")
      )
    ) {
      paraLines.push(lines[i] ?? "");
      i += 1;
    }

    blocks.push({
      type: "paragraph",
      content: paraLines.join("\n"),
    });
  }

  const processed: RenderedBlock[] = [];
  for (let j = 0; j < blocks.length; j += 1) {
    const block = blocks[j]!;
    const prev = processed[processed.length - 1];

    if (
      block.type === "list" &&
      block.listOrdered &&
      (block.listDepth ?? 0) === 0 &&
      prev &&
      prev.type !== "blank"
    ) {
      processed.push({ type: "blank", content: "" });
    }

    processed.push(block);
  }

  return processed;
}

function parseTable(
  lines: string[],
): { rows: string[][]; aligns: ("left" | "center" | "right")[] } | null {
  if (lines.length < 2) return null;

  const parseRow = (line: string): string[] => {
    const trimmed = line.replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map((cell) => cell.trim());
  };

  const header = parseRow(lines[0] ?? "");
  const separator = parseRow(lines[1] ?? "");

  if (header.length === 0 || separator.length === 0) return null;

  const aligns: ("left" | "center" | "right")[] = separator.map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) return "center";
    if (cell.endsWith(":")) return "right";
    return "left";
  });

  const rows: string[][] = [header];
  for (let i = 2; i < lines.length; i += 1) {
    rows.push(parseRow(lines[i] ?? ""));
  }

  return { rows, aligns };
}

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
      parts.push(
        <Text key={key++} bold color="white">
          {match[2]}
        </Text>,
      );
    } else if (match[3]) {
      parts.push(
        <Text key={key++} dimColor>
          {match[3]}
        </Text>,
      );
    } else if (match[4]) {
      parts.push(
        <Text key={key++} color="white" backgroundColor="#1f2937">
          {" "}
          {match[4]}
          {" "}
        </Text>,
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(<Text key={key++}>{text.slice(lastIndex)}</Text>);
  }

  return <Text>{parts}</Text>;
}

function TableBlock({
  rows,
  aligns,
  width,
}: {
  rows: string[][];
  aligns: ("left" | "center" | "right")[];
  width: number;
}): React.JSX.Element {
  if (rows.length === 0) return <Box />;

  const numCols = Math.max(...rows.map((row) => row.length));
  const usableWidth = Math.max(20, width - (numCols + 1));
  const colWidths: number[] = [];

  for (let c = 0; c < numCols; c += 1) {
    let maxW = 3;
    for (const row of rows) {
      maxW = Math.max(maxW, stringWidth(row[c] ?? ""));
    }
    colWidths.push(Math.min(maxW, Math.max(6, Math.floor(usableWidth / numCols) - 2)));
  }

  const top = `┌${colWidths.map((w) => "─".repeat(w + 2)).join("┬")}┐`;
  const mid = `├${colWidths.map((w) => "─".repeat(w + 2)).join("┼")}┤`;
  const bot = `└${colWidths.map((w) => "─".repeat(w + 2)).join("┴")}┘`;

  const renderRow = (row: string[]) => {
    const cells = colWidths.map((colWidth, idx) => {
      const clipped = clipDisplay(row[idx] ?? "", colWidth);
      const padded = padDisplay(clipped, colWidth, aligns[idx] ?? "left");
      return ` ${padded} `;
    });

    return `│${cells.join("│")}│`;
  };

  const out: string[] = [top, renderRow(rows[0] ?? []), mid];
  for (let i = 1; i < rows.length; i += 1) {
    out.push(renderRow(rows[i] ?? []));
  }
  out.push(bot);

  return (
    <Box flexDirection="column" marginBottom={1}>
      {out.map((line, i) => (
        <Text key={i} dimColor>
          {line}
        </Text>
      ))}
    </Box>
  );
}

function renderBlock(block: RenderedBlock, idx: number, width: number): React.JSX.Element {
  switch (block.type) {
    case "header": {
      const level = block.level ?? 1;
      const color = level <= 2 ? "white" : "gray";

      return (
        <Box
          key={idx}
          flexDirection="column"
          marginTop={level === 1 ? 1 : 0}
          marginBottom={1}
        >
          <Text bold color={color}>
            {block.content}
          </Text>
        </Box>
      );
    }

    case "code": {
      const maxW = Math.max(10, width - 4);
      const lines = block.content.split("\n");

      return (
        <Box key={idx} flexDirection="column" marginLeft={1} marginBottom={1}>
          {block.language ? (
            <Text dimColor>{block.language}</Text>
          ) : null}

          {lines.map((line, i) => (
            <Text key={i}>
              <Text dimColor>│ </Text>
              <CodeLine line={line} language={block.language} width={maxW} />
            </Text>
          ))}
        </Box>
      );
    }

    case "table":
      return (
        <TableBlock
          key={idx}
          rows={block.tableRows ?? []}
          aligns={block.tableAligns ?? []}
          width={width}
        />
      );

    case "list": {
      const depth = block.listDepth ?? 0;
      const indent = "  ".repeat(depth);

      return (
        <Box key={idx} marginBottom={0}>
          <Text>
            {indent}
            <Text dimColor>{block.listOrdered ? `${block.listNumber}.` : "─"}</Text>
            {" "}
          </Text>
          <InlineText text={block.listText ?? ""} />
        </Box>
      );
    }

    case "blank":
      return <Box key={idx} height={1} />;

    case "paragraph":
    default: {
      const lines = block.content.split("\n");

      return (
        <Box key={idx} flexDirection="column" marginBottom={1}>
          {lines.map((line, lineIdx) => (
            <InlineText key={lineIdx} text={line} />
          ))}
        </Box>
      );
    }
  }
}

export const MarkdownRenderer = React.memo(function MarkdownRenderer({
  content,
  width,
}: MarkdownRendererProps): React.JSX.Element {
  const blocks = parseBlocks(content);

  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => renderBlock(block, i, width))}
    </Box>
  );
});