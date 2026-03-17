/**
 * markdown-renderer.ts — Streaming terminal markdown renderer for YUAN CLI.
 *
 * Line-based streaming architecture:
 *   text_delta tokens -> lineBuffer -> complete line -> pushLine() -> rendered string
 *
 * Handles: headings, bullet/numbered lists, blockquotes, horizontal rules, tables.
 * Does NOT handle code fences (handled by writeWithCodeHighlight in stream-renderer).
 * Inline markdown (bold, italic, code, strikethrough) applied inside all blocks.
 */

import chalk from "chalk";

// ─── Inline Markdown ─────────────────────────────────────────────────────────

function renderInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, (_, t) => chalk.bold(t))
    .replace(/__(.+?)__/g, (_, t) => chalk.bold(t))
    .replace(/`([^`]+)`/g, (_, t) => chalk.bgHex("#2a2a2a").hex("#e6e6e6")(` ${t} `))
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, t) => chalk.italic(t))
    .replace(/~~(.+?)~~/g, (_, t) => chalk.strikethrough(t));
}

// ─── Table Rendering ─────────────────────────────────────────────────────────

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((c) => /^[-:]+$/.test(c.trim()));
}

function parseTableRow(line: string): string[] {
  // Split on | and strip empty leading/trailing entries from outer pipes
  const raw = line.split("|");
  // Remove first and last if empty (from leading/trailing |)
  if (raw.length > 0 && raw[0].trim() === "") raw.shift();
  if (raw.length > 0 && raw[raw.length - 1].trim() === "") raw.pop();
  return raw.map((c) => c.trim());
}

function renderTableWide(
  dataRows: string[][],
  colWidths: number[],
): string {
  const indent = "  ";
  const lines: string[] = [];

  // Top border: ┌──┬──┐
  lines.push(
    indent +
      "\u250c" +
      colWidths.map((w) => "\u2500".repeat(w + 2)).join("\u252c") +
      "\u2510",
  );

  for (let r = 0; r < dataRows.length; r++) {
    const row = dataRows[r];
    // Data row: │ cell │ cell │
    const cells = colWidths.map((w, c) => {
      const cell = row[c] ?? "";
      return " " + renderInline(cell) + " ".repeat(Math.max(0, w - cell.length)) + " ";
    });
    lines.push(indent + "\u2502" + cells.join("\u2502") + "\u2502");

    // After header row (first row), add separator: ├──┼──┤
    if (r === 0 && dataRows.length > 1) {
      lines.push(
        indent +
          "\u251c" +
          colWidths.map((w) => "\u2500".repeat(w + 2)).join("\u253c") +
          "\u2524",
      );
    }
  }

  // Bottom border: └──┴──┘
  lines.push(
    indent +
      "\u2514" +
      colWidths.map((w) => "\u2500".repeat(w + 2)).join("\u2534") +
      "\u2518",
  );

  return lines.join("\n");
}

function renderTableNarrow(
  dataRows: string[][],
  colWidths: number[],
): string {
  const indent = "  ";
  const lines: string[] = [];

  for (const row of dataRows) {
    const cells = colWidths.map((w, c) => {
      const cell = row[c] ?? "";
      return renderInline(cell) + " ".repeat(Math.max(0, w - cell.length));
    });
    lines.push(indent + cells.join("   "));
  }

  return lines.join("\n");
}

// ─── MarkdownRenderer Class ──────────────────────────────────────────────────

export class MarkdownRenderer {
  private getWidth: () => number;
  private tableBuffer: string[][] = [];
  private inTable = false;

  constructor(getWidth: () => number) {
    this.getWidth = getWidth;
  }

  /**
   * Process a complete line. Returns rendered string, or null if buffering
   * (e.g. accumulating table rows).
   */
  pushLine(line: string): string | null {
    const isTableRow = /^\|.+\|$/.test(line.trim());

    // If we were in a table and this line is NOT a table row, flush the table
    // and then process this line normally.
    if (this.inTable && !isTableRow) {
      const tableOut = this.flushTable();
      const rendered = this.renderLine(line);
      return tableOut + (rendered ? "\n" + rendered : "");
    }

    // Table row: buffer it
    if (isTableRow) {
      this.inTable = true;
      const cells = parseTableRow(line.trim());
      if (!isSeparatorRow(cells)) {
        this.tableBuffer.push(cells);
      }
      return null;
    }

    return this.renderLine(line);
  }

  /** Flush any buffered content (tables). Returns rendered string or empty. */
  flush(): string {
    if (this.inTable) {
      return this.flushTable();
    }
    return "";
  }

  /** Reset state for a new turn. */
  reset(): void {
    this.tableBuffer = [];
    this.inTable = false;
  }

  // ─── Private ─────────────────────────────────────────────────────────

  private flushTable(): string {
    this.inTable = false;
    if (this.tableBuffer.length === 0) {
      return "";
    }

    const rows = this.tableBuffer;
    this.tableBuffer = [];

    // Calculate column widths
    const colCount = Math.max(...rows.map((r) => r.length));
    const colWidths: number[] = [];
    for (let c = 0; c < colCount; c++) {
      let maxW = 0;
      for (const row of rows) {
        const cell = row[c] ?? "";
        if (cell.length > maxW) maxW = cell.length;
      }
      colWidths.push(maxW);
    }

    const width = this.getWidth();
    if (width < 60) {
      return renderTableNarrow(rows, colWidths);
    }
    return renderTableWide(rows, colWidths);
  }

  private renderLine(line: string): string {
    const width = this.getWidth();
    const narrow = width < 60;

    // Heading: # H1, ## H2, ### H3
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      if (level === 1) {
        return chalk.bold.underline(renderInline(text)) + "\n";
      }
      if (level === 2) {
        if (narrow) {
          return "\n" + chalk.bold(renderInline(text)) + "\n";
        }
        const decoration = chalk.gray(
          "\u2500\u2500".repeat(Math.min(text.length, 30)),
        );
        return "\n" + chalk.bold(renderInline(text)) + "\n" + decoration + "\n";
      }
      // level === 3
      return chalk.bold(renderInline(text)) + "\n";
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line)) {
      return chalk.gray("\u2500".repeat(Math.min(width, 80)));
    }

    // Blockquote
    const bqMatch = line.match(/^>\s?(.*)$/);
    if (bqMatch) {
      const text = bqMatch[1];
      if (narrow) {
        return "  > " + chalk.dim(renderInline(text));
      }
      return chalk.dim("  \u2502  ") + chalk.dim(renderInline(text));
    }

    // Bullet list
    const bulletMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bulletMatch) {
      const indent = Math.floor(bulletMatch[1].length / 2);
      const text = bulletMatch[2];
      const prefix = "  ".repeat(indent) + "  " + chalk.dim("\u2022") + "  ";
      return prefix + renderInline(text);
    }

    // Numbered list
    const numMatch = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (numMatch) {
      const indent = Math.floor(numMatch[1].length / 2);
      const num = numMatch[2];
      const text = numMatch[3];
      const prefix = "  ".repeat(indent) + "  " + num + ".  ";
      return prefix + renderInline(text);
    }

    // Paragraph (anything else) — apply inline markdown
    return renderInline(line);
  }
}
