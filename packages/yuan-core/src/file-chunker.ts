/**
 * @module file-chunker
 * @description Strategic file splitting for large files.
 * Splits by function/class boundaries instead of arbitrary line counts.
 * Reduces token usage by reading only relevant chunks.
 * NO LLM.
 */

export interface FileChunk {
  startLine: number;
  endLine: number;
  content: string;
  type: "function" | "class" | "block" | "header" | "unknown";
  name?: string;
}

export interface ChunkResult {
  chunks: FileChunk[];
  totalLines: number;
  language: string;
}

/**
 * Split file content into logical chunks at function/class boundaries.
 */
export function chunkFile(content: string, maxChunkLines: number = 100): ChunkResult {
  const lines = content.split("\n");
  const totalLines = lines.length;

  // Small files: return as single chunk
  if (totalLines <= maxChunkLines) {
    return {
      chunks: [{ startLine: 1, endLine: totalLines, content, type: "block", name: "full" }],
      totalLines,
      language: detectLanguage(content),
    };
  }

  const chunks: FileChunk[] = [];
  let currentChunk: string[] = [];
  let chunkStart = 1;
  let currentType: FileChunk["type"] = "header";
  let currentName: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Detect function/class start
    const funcMatch = line.match(/^\s*(?:export\s+)?(?:async\s+)?(?:function|const|let|var)\s+(\w+)/);
    const classMatch = line.match(/^\s*(?:export\s+)?class\s+(\w+)/);
    const methodMatch = line.match(/^\s+(?:async\s+)?(\w+)\s*\(/);

    const isNewBlock = funcMatch || classMatch || (methodMatch && currentChunk.length > 20);

    if (isNewBlock && currentChunk.length > 0) {
      // Flush current chunk
      chunks.push({
        startLine: chunkStart,
        endLine: lineNum - 1,
        content: currentChunk.join("\n"),
        type: currentType,
        name: currentName,
      });
      currentChunk = [];
      chunkStart = lineNum;
    }

    // Update type/name
    if (funcMatch) { currentType = "function"; currentName = funcMatch[1]; }
    else if (classMatch) { currentType = "class"; currentName = classMatch[1]; }
    else if (methodMatch && isNewBlock) { currentType = "function"; currentName = methodMatch[1]; }

    currentChunk.push(line);

    // Force split at maxChunkLines
    if (currentChunk.length >= maxChunkLines) {
      chunks.push({
        startLine: chunkStart,
        endLine: lineNum,
        content: currentChunk.join("\n"),
        type: currentType,
        name: currentName,
      });
      currentChunk = [];
      chunkStart = lineNum + 1;
      currentType = "block";
      currentName = undefined;
    }
  }

  // Flush remaining
  if (currentChunk.length > 0) {
    chunks.push({
      startLine: chunkStart,
      endLine: totalLines,
      content: currentChunk.join("\n"),
      type: currentType,
      name: currentName,
    });
  }

  return { chunks, totalLines, language: detectLanguage(content) };
}

function detectLanguage(content: string): string {
  if (/\bimport\b.*from\s+['"]|export\s+(default|const|function|class|type|interface)\b/.test(content)) return "typescript";
  if (/\bdef\s+\w+|import\s+\w+|from\s+\w+\s+import/.test(content)) return "python";
  if (/\bfunc\s+\w+|package\s+\w+/.test(content)) return "go";
  if (/\bfn\s+\w+|use\s+\w+::/.test(content)) return "rust";
  return "unknown";
}

/** Get a summary of chunks (for context window management) */
export function chunkSummary(result: ChunkResult): string {
  return result.chunks.map(c =>
    `[${c.startLine}-${c.endLine}] ${c.type}${c.name ? `: ${c.name}` : ""} (${c.endLine - c.startLine + 1} lines)`
  ).join("\n");
}
