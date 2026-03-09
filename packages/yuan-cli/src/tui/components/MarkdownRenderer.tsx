/**
 * MarkdownRenderer — basic markdown to terminal rendering.
 * Handles: bold, italic, inline code, code blocks, headers, lists.
 */

import React from "react";
import { Box, Text } from "ink";

export interface MarkdownRendererProps {
  content: string;
  width: number;
}

interface RenderedBlock {
  type: "paragraph" | "code" | "header" | "list" | "blank";
  content: string;
  language?: string;
  level?: number;
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
      !/^\s*\d+\.\s/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: "paragraph", content: paraLines.join("\n") });
  }

  return blocks;
}

/** Render inline formatting: **bold**, *italic*, `code` */
function InlineText({ text }: { text: string }): React.JSX.Element {
  const parts: React.JSX.Element[] = [];
  // Match bold, italic, inline code
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    // Text before match
    if (match.index > lastIndex) {
      parts.push(<Text key={key++}>{text.slice(lastIndex, match.index)}</Text>);
    }

    if (match[2]) {
      // Bold
      parts.push(<Text key={key++} bold>{match[2]}</Text>);
    } else if (match[3]) {
      // Italic
      parts.push(<Text key={key++} dimColor>{match[3]}</Text>);
    } else if (match[4]) {
      // Inline code
      parts.push(<Text key={key++} color="white"> {match[4]} </Text>);
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < text.length) {
    parts.push(<Text key={key++}>{text.slice(lastIndex)}</Text>);
  }

  if (parts.length === 0) {
    return <Text>{text}</Text>;
  }

  return <Text>{parts}</Text>;
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
