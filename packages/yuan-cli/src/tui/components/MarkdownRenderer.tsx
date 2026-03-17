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
  type: "paragraph" | "code" | "header" | "list" | "blank" | "table" | "hr";
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

  for (const ch of [...text]) {
    const w = stringWidth(ch);
    if (width + w >= maxWidth) break;
    out += ch;
    width += w;
  }

  return width < stringWidth(text) ? out + "…" : out;
}

/**
 * CJK-aware soft wrap: breaks text at character boundaries respecting display width.
 * Unlike Ink's built-in wrap which only breaks on spaces, this handles Korean/Chinese/Japanese
 * where words have no spaces between them.
 */
function cjkWrap(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return text;
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const ch of [...text]) {
    if (ch === "\n") {
      lines.push(current);
      current = "";
      currentWidth = 0;
      continue;
    }
    const w = stringWidth(ch);
    if (currentWidth + w > maxWidth) {
      lines.push(current);
      current = ch;
      currentWidth = w;
    } else {
      current += ch;
      currentWidth += w;
    }
  }
  if (current) lines.push(current);
  return lines.join("\n");
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

// File-like string detection: contains a known extension or path separator
const FILE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json|css|scss|html|py|go|rs|sh|yaml|yml|md|sql|env)\b/i;

function isFileString(quoted: string): boolean {
  const inner = quoted.slice(1, -1);
  return FILE_EXT_RE.test(inner) || (inner.includes("/") && inner.length > 3);
}

function tokenizeCodeLine(line: string, language?: string): CodeToken[] {
  const keywords = getKeywords(language);
  const keywordSet = new Set(keywords);
  const kwPat = keywords.length
    ? `\\b(?:${keywords.map(escapeRegExp).join("|")})\\b`
    : "$^";

  // Groups (in order):
  //  1 → comment  (// or #)
  //  2 → string   ("…", '…', `…`)
  //  3 → fn call  (word immediately before `(`)
  //  4 → keyword
  //  5 → number
  const pat = new RegExp(
    "(//.*$|#.*$)" +
    "|(\"(?:\\\\.|[^\"])*\"|'(?:\\\\.|[^'])*'|`(?:\\\\.|[^`])*`)" +
    "|(\\b\\w+(?=\\s*\\())" +
    "|(" + kwPat + ")" +
    "|(\\b\\d+(?:\\.\\d+)?\\b)",
    "g",
  );

  const tokens: CodeToken[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pat.exec(line)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: line.slice(lastIndex, match.index) });
    }

    const full = match[0];

    if (match[1]) {
      // Comment → dim
      tokens.push({ text: full, dimColor: true });
    } else if (match[2]) {
      // String → orange if file path/name, else white
      tokens.push({ text: full, color: isFileString(full) ? "#f97316" : undefined });
    } else if (match[3]) {
      // Function call name → orange (unless it's a keyword like `if`, `for`)
      tokens.push({ text: full, color: keywordSet.has(full) ? undefined : "#f97316" });
    } else {
      // Keyword or number → plain white (no color override)
      tokens.push({ text: full });
    }

    lastIndex = match.index + full.length;
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

/**
 * splitKoreanSentenceBoundaries — splits sentence runs within a single line.
 *
 * "볼게.어, 있네!" → "볼게.\n어, 있네!"
 * "있어. 아" → "있어.\n아"
 *
 * Only applies outside code fences. Only splits before Korean characters
 * (가-힣) to avoid false positives on URLs, numbers, English abbreviations.
 */
function splitKoreanSentenceBoundaries(text: string): string {
  const isFence = (s: string) => /^\s*`{3,}/.test(s);
  const isBlock = (s: string) =>
    /^(\s*)(```|#{1,6}\s|>|- |\* |\||\d{1,2}[.)]\s+)/.test(s.trim()) ||
    /[↓→⇒├└│]/.test(s);

  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (isFence(trimmed)) {
      inFence = !inFence;
      out.push(raw);
      continue;
    }
    if (inFence || isBlock(trimmed) || !trimmed) {
      out.push(raw);
      continue;
    }
    // Split at [.?!。] followed by optional whitespace then Korean character
    const parts = raw.split(/(?<=[.?!。])\s*(?=[가-힣])/);
    for (const part of parts) {
      const p = part.trim();
      if (p) out.push(p);
    }
  }

  return out.join("\n");
}

/**
 * normalizeChatParagraphs — ported from yua-web/src/components/common/Markdown.tsx
 *
 * Inserts blank lines at natural paragraph boundaries so parseBlocks
 * gets clean paragraph separation:
 *   - sentence endings (., 다., ?, !, …) → new paragraph
 *   - numbered list leads → forced blank before
 *   - colon + list transition → blank inserted
 *   - label patterns (요약:, 결론:, etc.) → structured output
 * Code fences are protected throughout.
 *
 * Pre-processes with splitKoreanSentenceBoundaries to handle sentences
 * on the same line (e.g. "볼게.어, 있네!").
 */
function normalizeChatParagraphs(input: string): string {
  const lines = splitKoreanSentenceBoundaries(
    (input ?? "").replace(/\r\n/g, "\n"),
  ).split("\n");
  const out: string[] = [];
  let inFence = false;

  const isFence = (s: string) => /^\s*`{3,}[a-zA-Z0-9_-]*\s*$/.test(s);
  const isBlockLine = (s: string) =>
    /^(\s*)(```|#{1,6}\s|>|- |\* |\||\d{1,2}[.)]\s+)/.test(s.trim()) ||
    /^\d+\s*단계[:.\-]?\s*/.test(s.trim()) ||
    /^\//.test(s) ||
    /[↓→⇒├└│]/.test(s);
  const isPlain = (s: string) => s.trim() !== "" && !isBlockLine(s);

  const lastOutLine = () => {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i] !== "") return out[i];
    }
    return "";
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.replace(/\s+$/g, "");
    const trimmed = line.trim();

    // fence toggle — don't process inside code blocks
    if (isFence(trimmed)) {
      out.push(line);
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(raw);
      continue;
    }

    if (trimmed === "") {
      out.push("");
      continue;
    }

    // Label patterns: "요약: 내용" → structured bold label
    const label = trimmed.match(/^(요약|결론|핵심|정리|주의|중요)\s*[:：]\s*(.+)$/);
    if (label) {
      const prev = lastOutLine();
      if (prev && isPlain(prev)) out.push("");
      out.push(`**${label[1]}:**`);
      out.push("");
      out.push(label[2] ?? "");
      continue;
    }

    const prev = lastOutLine();

    // Sentence-ending based paragraph break
    const endsLikeSentence =
      prev && /(\.|다\.|\?|!|…|。)$/.test(prev.trim());
    if (
      prev &&
      isPlain(prev) &&
      isPlain(line) &&
      endsLikeSentence &&
      !/^#{1,6}\s/.test(prev.trim())
    ) {
      out.push("");
    }

    // Numbered lead → forced blank before
    if (prev && /^\d{1,2}[.)]\s+/.test(trimmed)) {
      out.push("");
    }

    // Colon ending + list start → blank
    const endsWithColon = prev && /[:：]\s*$/.test(prev.trim());
    const startsLikeList = /^([-*]\s|✅)/.test(trimmed);
    if (prev && isPlain(prev) && isPlain(line) && endsWithColon && startsLikeList) {
      out.push("");
    }

    out.push(line);
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n");
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

    // Horizontal rule: ---, ***, ___  (3 or more)
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: "hr", content: "" });
      i += 1;
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
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i] ?? "") &&
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
    const next = blocks[j + 1];
    const prev = processed[processed.length - 1];

    // Blank before headers (section breathing room), skip if already blank or first block
    if (block.type === "header" && prev && prev.type !== "blank") {
      processed.push({ type: "blank", content: "" });
    }

    // Blank before the FIRST item in a top-level list group (not between items)
    if (
      block.type === "list" &&
      (block.listDepth ?? 0) === 0 &&
      prev &&
      prev.type !== "list" &&
      prev.type !== "blank"
    ) {
      processed.push({ type: "blank", content: "" });
    }

    processed.push(block);

    // Blank after the LAST item in a top-level list group (before next non-list content)
    if (
      block.type === "list" &&
      (block.listDepth ?? 0) === 0 &&
      next &&
      next.type !== "list" &&
      next.type !== "blank"
    ) {
      processed.push({ type: "blank", content: "" });
    }
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
      parts.push(<Text key={key++} color="white">{text.slice(lastIndex, match.index)}</Text>);
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
      // Long inline code: render on its own line to prevent mid-backtick wrapping
      const codeWidth = stringWidth(match[4]) + 2; // +2 for padding spaces
      if (codeWidth > 60) {
        parts.push(
          <Text key={key++}>{"\n"}</Text>,
        );
        parts.push(
          <Text key={key++} color="white" backgroundColor="#1f2937">
            {" "}
            {match[4]}
            {" "}
          </Text>,
        );
        parts.push(
          <Text key={key++}>{"\n"}</Text>,
        );
      } else {
        parts.push(
          <Text key={key++} color="white" backgroundColor="#1f2937">
            {" "}
            {match[4]}
            {" "}
          </Text>,
        );
      }
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(<Text key={key++} color="white">{text.slice(lastIndex)}</Text>);
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
  const rawUsableWidth = Math.max(20, width - (numCols * 3 + 1));
  // Ensure at least 8 chars per column so widths never underflow
  const usableWidth = Math.max(numCols * 8, rawUsableWidth);
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
          marginTop={1}
          marginBottom={level <= 2 ? 1 : 0}
        >
          <Text bold color={color}>
            {block.content}
          </Text>
        </Box>
      );
    }

    case "code": {
      const maxW = Math.max(10, width - 6);
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
      // Skip empty list items — streaming artifact when LLM outputs "- " with no text yet
      if (!block.listText?.trim()) return <Box key={idx} flexShrink={0} />;

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

    case "hr":
      return (
        <Box key={idx} marginTop={1} marginBottom={1}>
          <Text dimColor>{"─".repeat(Math.max(8, width - 4))}</Text>
        </Box>
      );

    case "blank":
      return <Box key={idx} height={1} flexShrink={0} />;

    case "paragraph":
    default: {
      // Join soft line breaks, then CJK-aware wrap to terminal width
      const joined = block.content
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s{2,}/g, " ")
        .trim();
      const wrapped = cjkWrap(joined, width);

      return (
        <Box key={idx} marginBottom={1} flexDirection="column">
          {wrapped.split("\n").map((line, li) => (
            <InlineText key={li} text={line} />
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
  const safeWidth = Math.max(24, width - 1);
  // Normalize paragraph breaks using yua-web's battle-tested logic before parsing
  const blocks = parseBlocks(normalizeChatParagraphs(content));

  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => renderBlock(block, i, safeWidth))}
    </Box>
  );
});