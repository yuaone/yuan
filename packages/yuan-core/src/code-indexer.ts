/**
 * @module code-indexer
 * @description VectorStore Auto-Indexing Pipeline.
 *
 * Walks a project directory, chunks source files by top-level symbol boundaries,
 * and feeds them into InMemoryVectorStore so RAG search has real content.
 *
 * Design goals:
 * - Zero external deps — only node:fs/promises + node:path
 * - Fast startup: skips large files, processes file batches in parallel
 * - Incremental-friendly: whole-file IDs — re-indexing replaces by id
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { InMemoryVectorStore } from "./vector-store.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface CodeIndexerOptions {
  /** File extensions to index. Default: ts/tsx/js/jsx/py/go/rs/md */
  extensions?: string[];
  /** Directory names to skip entirely. */
  excludeDirs?: string[];
  /** Max file size in bytes before skipping. Default: 50 KB */
  maxFileSize?: number;
  /** Lines per chunk when splitting large files. Default: 50 */
  chunkSize?: number;
}

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".md"];
const DEFAULT_EXCLUDE_DIRS = ["node_modules", ".git", "dist", "build", ".yuan", "coverage", ".next", "out"];
const DEFAULT_MAX_FILE_SIZE = 50 * 1024; // 50 KB
const DEFAULT_CHUNK_SIZE = 50;

// ─── Chunk extraction helpers ────────────────────────────────────────────────

interface Chunk {
  content: string;
  startLine: number;
  endLine: number;
}

/**
 * Top-level symbol patterns for TypeScript/JavaScript/Python/Go/Rust.
 * We look for function/class/const declarations at line start.
 */
const SYMBOL_PATTERNS = [
  // TS/JS: export default / export const / export function / export class
  /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\s+\w|class\s+\w|const\s+\w+\s*(?:=|:))/,
  // Python: def / class
  /^(?:async\s+)?def\s+\w|^class\s+\w/,
  // Go: func
  /^func\s+/,
  // Rust: fn / pub fn / impl / struct / enum
  /^(?:pub\s+)?(?:fn\s+|impl\s+|struct\s+|enum\s+)/,
  // Markdown: headings (h1/h2/h3)
  /^#{1,3}\s+/,
];

function isSymbolBoundary(line: string): boolean {
  const trimmed = line.trimStart();
  return SYMBOL_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Split file lines into overlapping chunks of ~chunkSize lines,
 * aligned to top-level symbol boundaries where possible.
 */
function extractChunks(lines: string[], chunkSize: number): Chunk[] {
  // Small files: treat as single chunk
  if (lines.length <= 100) {
    return [{ content: lines.join("\n"), startLine: 1, endLine: lines.length }];
  }

  const chunks: Chunk[] = [];
  let i = 0;

  while (i < lines.length) {
    // Try to start at a symbol boundary (look ahead up to 5 lines)
    let start = i;
    if (start > 0) {
      for (let k = i; k < Math.min(i + 5, lines.length); k++) {
        if (isSymbolBoundary(lines[k])) {
          start = k;
          break;
        }
      }
    }

    const end = Math.min(start + chunkSize - 1, lines.length - 1);

    // Try to end at a symbol boundary (look back up to 5 lines)
    let chunkEnd = end;
    if (end + 1 < lines.length) {
      for (let k = end; k > Math.max(end - 5, start); k--) {
        if (isSymbolBoundary(lines[k + 1] ?? "")) {
          chunkEnd = k;
          break;
        }
      }
    }

    const content = lines.slice(start, chunkEnd + 1).join("\n").trim();
    if (content.length > 0) {
      chunks.push({ content, startLine: start + 1, endLine: chunkEnd + 1 });
    }

    // Advance — ensure progress even if boundaries didn't help
    i = chunkEnd + 1;
    if (i <= start) i = start + chunkSize;
  }

  return chunks;
}

// ─── Directory walker ─────────────────────────────────────────────────────────

interface FileEntry {
  filePath: string;
  relativePath: string;
}

async function walkDir(
  dir: string,
  rootDir: string,
  extensions: Set<string>,
  excludeDirs: Set<string>,
  results: FileEntry[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // Permission denied or doesn't exist — skip silently
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (excludeDirs.has(entry.name) || entry.name.startsWith(".")) {
        // Skip hidden dirs (except project root itself) and excluded dirs
        if (!excludeDirs.has(entry.name)) continue;
        continue;
      }
      await walkDir(path.join(dir, entry.name), rootDir, extensions, excludeDirs, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions.has(ext)) {
        const filePath = path.join(dir, entry.name);
        const relativePath = path.relative(rootDir, filePath);
        results.push({ filePath, relativePath });
      }
    }
  }
}

// ─── CodeIndexer ─────────────────────────────────────────────────────────────

/**
 * Indexes project source files into an InMemoryVectorStore.
 *
 * @example
 * ```ts
 * const indexer = new CodeIndexer({});
 * await indexer.indexProject("/path/to/project", vectorStore);
 * ```
 */
export class CodeIndexer {
  private readonly extensions: Set<string>;
  private readonly excludeDirs: Set<string>;
  private readonly maxFileSize: number;
  private readonly chunkSize: number;

  constructor(options: CodeIndexerOptions = {}) {
    this.extensions = new Set(options.extensions ?? DEFAULT_EXTENSIONS);
    this.excludeDirs = new Set(options.excludeDirs ?? DEFAULT_EXCLUDE_DIRS);
    this.maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  }

  /**
   * Walk `projectPath`, chunk all matching files, and add them to `vectorStore`.
   * After indexing completes, calls `vectorStore.save()` to persist.
   * Non-blocking errors (per-file) are swallowed to keep the pipeline robust.
   */
  async indexProject(projectPath: string, vectorStore: InMemoryVectorStore): Promise<void> {
    // Collect matching file paths
    const fileEntries: FileEntry[] = [];
    await walkDir(projectPath, projectPath, this.extensions, this.excludeDirs, fileEntries);

    if (fileEntries.length === 0) return;

    let totalFiles = 0;
    let totalChunks = 0;

    // Process files in parallel batches of 8 to avoid too many open handles
    const BATCH_SIZE = 8;
    for (let i = 0; i < fileEntries.length; i += BATCH_SIZE) {
      const batch = fileEntries.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((entry) => this._indexFile(entry, vectorStore)),
      );
      for (const result of results) {
        if (result.status === "fulfilled") {
          totalFiles++;
          totalChunks += result.value;
        }
        // Rejected = file read error — silently skip
      }
    }

    // Persist to .yuan/vector-store.json
    await vectorStore.save().catch(() => {});

    console.error(`[CodeIndexer] Indexed ${totalFiles} files, ${totalChunks} chunks`);
  }

  /**
   * Index a single file. Returns the number of chunks added.
   */
  private async _indexFile(
    entry: FileEntry,
    vectorStore: InMemoryVectorStore,
  ): Promise<number> {
    // Check file size before reading
    let stat;
    try {
      stat = await fs.stat(entry.filePath);
    } catch {
      return 0;
    }
    if (stat.size > this.maxFileSize) return 0;

    const raw = await fs.readFile(entry.filePath, "utf8");
    const lines = raw.split("\n");

    const chunks = extractChunks(lines, this.chunkSize);

    // Remove previously indexed chunks for this file (idempotent re-index)
    await vectorStore.removeByFile(entry.relativePath).catch(() => {});

    let added = 0;
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      // ID format: relative/path.ts:startLine-endLine
      const id = `${entry.relativePath}:${chunk.startLine}-${chunk.endLine}`;
      await vectorStore
        .addDocument(id, chunk.content, {
          filePath: entry.relativePath,
          type: "code",
          startLine: chunk.startLine,
          endLine: chunk.endLine,
        })
        .catch(() => {});
      added++;
    }

    return added;
  }
}
