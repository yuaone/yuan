/**
 * @module vector-store
 * @description In-memory vector store + Ollama embedding provider.
 *
 * Offline-friendly alternative to pgvector:
 * - InMemoryVectorStore: cosine similarity over Map, persisted to .yuan/vector-store.json
 * - OllamaEmbeddingProvider: calls Ollama local API (nomic-embed-text),
 *   falls back to TF-IDF bag-of-words on failure (no network required)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single stored document with its embedding vector. */
export interface StoredDocument {
  vector: number[];
  text: string;
  metadata: Record<string, unknown>;
}

/** A search result from InMemoryVectorStore. */
export interface MemorySearchResult {
  id: string;
  text: string;
  similarity: number;
  metadata: Record<string, unknown>;
}

/** Embedding provider interface (mirrors EmbeddingProvider from vector-index.ts) */
export interface VectorEmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimension: number;
}

// ─── Cosine Similarity ──────────────────────────────────────────────────────

/**
 * Cosine similarity between two equal-length vectors.
 * Returns value in [0, 1] (0 = orthogonal, 1 = identical).
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  const dot = a.reduce((sum, ai, i) => sum + ai * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0));
  const magB = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0));
  return magA && magB ? dot / (magA * magB) : 0;
}

// ─── TF-IDF Fallback Embedder ───────────────────────────────────────────────

const TFIDF_DIM = 256;

/**
 * Simple deterministic hash code for a string.
 * Used to map words to a fixed-size vector dimension.
 */
function hashCode(word: string): number {
  let h = 0;
  for (let i = 0; i < word.length; i++) {
    h = (h << 5) - h + word.charCodeAt(i);
    h |= 0; // convert to 32-bit int
  }
  return Math.abs(h);
}

/**
 * Builds a 256-dim TF-IDF bag-of-words vector for a text string.
 * Deterministic — no external calls required.
 */
function buildTfIdfVector(text: string): number[] {
  const vector = new Array<number>(TFIDF_DIM).fill(0);
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);

  for (const word of words) {
    const idx = hashCode(word) % TFIDF_DIM;
    vector[idx] += 1;
  }

  // Normalize to unit vector
  const mag = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
  if (mag > 0) {
    for (let i = 0; i < vector.length; i++) {
      vector[i] /= mag;
    }
  }

  return vector;
}

// ─── OllamaEmbeddingProvider ─────────────────────────────────────────────────

/**
 * Generates embeddings using a local Ollama server.
 *
 * Uses `nomic-embed-text` model by default (768-dim).
 * Falls back to TF-IDF bag-of-words (256-dim) if Ollama is unavailable.
 *
 * @example
 * ```ts
 * const provider = new OllamaEmbeddingProvider();
 * const [[v]] = await provider.embed(["hello world"]);
 * ```
 */
export class OllamaEmbeddingProvider implements VectorEmbeddingProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private _dimension: number;
  private _ollamaAvailable: boolean | null = null;

  constructor(options?: {
    baseUrl?: string;
    model?: string;
    timeoutMs?: number;
  }) {
    this.baseUrl = options?.baseUrl ?? "http://localhost:11434";
    this.model = options?.model ?? "nomic-embed-text";
    this.timeoutMs = options?.timeoutMs ?? 10_000;
    // Will be resolved to 768 if Ollama responds, 256 otherwise
    this._dimension = 768;
  }

  get dimension(): number {
    return this._dimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      const vec = await this._embedOne(text);
      results.push(vec);
    }
    return results;
  }

  private async _embedOne(text: string): Promise<number[]> {
    // Fast-path: if we already know Ollama is down, skip the HTTP call
    if (this._ollamaAvailable === false) {
      this._dimension = TFIDF_DIM;
      return buildTfIdfVector(text);
    }

    try {
      const vec = await this._callOllama(text);
      this._ollamaAvailable = true;
      this._dimension = vec.length;
      return vec;
    } catch {
      // Mark Ollama as unavailable for this session
      this._ollamaAvailable = false;
      this._dimension = TFIDF_DIM;
      return buildTfIdfVector(text);
    }
  }

  private _callOllama(text: string): Promise<number[]> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ model: this.model, prompt: text });
      const url = new URL("/api/embeddings", this.baseUrl);

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port ? Number(url.port) : 11434,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      };

      const req = http.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const raw = Buffer.concat(chunks).toString("utf8");
            const parsed = JSON.parse(raw) as { embedding?: number[] };
            if (!Array.isArray(parsed.embedding) || parsed.embedding.length === 0) {
              reject(new Error("Ollama returned empty embedding"));
              return;
            }
            resolve(parsed.embedding);
          } catch (e) {
            reject(e);
          }
        });
        res.on("error", reject);
      });

      req.setTimeout(this.timeoutMs, () => {
        req.destroy();
        reject(new Error(`Ollama request timed out after ${this.timeoutMs}ms`));
      });

      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  /**
   * Returns whether the last embed call reached Ollama successfully.
   * `null` means no call has been made yet.
   */
  get ollamaAvailable(): boolean | null {
    return this._ollamaAvailable;
  }
}

// ─── Persistent store file ───────────────────────────────────────────────────

interface SerializedStore {
  version: 1;
  projectId: string;
  documents: Record<string, StoredDocument>;
}

// ─── InMemoryVectorStore ─────────────────────────────────────────────────────

/**
 * In-memory vector store with cosine similarity search.
 *
 * - All vectors kept in a `Map` for O(n) linear scan.
 * - Persisted to `.yuan/vector-store.json` for cross-session reuse.
 * - Accepts any `VectorEmbeddingProvider` (Ollama, TF-IDF, OpenAI, etc.).
 *
 * @example
 * ```ts
 * const store = new InMemoryVectorStore({
 *   projectId: "my-project",
 *   projectPath: "/path/to/project",
 *   embeddingProvider: new OllamaEmbeddingProvider(),
 * });
 * await store.load();
 * await store.addDocument("doc-1", "user authentication logic", { file: "auth.ts" });
 * const results = await store.search("login flow", 5);
 * ```
 */
export class InMemoryVectorStore {
  private readonly projectId: string;
  private readonly storePath: string;
  private readonly embeddingProvider: VectorEmbeddingProvider;
  private readonly documents: Map<string, StoredDocument>;
  private dirty: boolean;

  constructor(options: {
    projectId: string;
    /** Project root — store file is written to <projectPath>/.yuan/vector-store.json */
    projectPath: string;
    embeddingProvider: VectorEmbeddingProvider;
  }) {
    this.projectId = options.projectId;
    this.storePath = path.join(options.projectPath, ".yuan", "vector-store.json");
    this.embeddingProvider = options.embeddingProvider;
    this.documents = new Map();
    this.dirty = false;
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  /**
   * Load persisted documents from disk.
   * Safe to call even if the file doesn't exist yet.
   */
  async load(): Promise<void> {
    try {
      if (!fs.existsSync(this.storePath)) return;
      const raw = fs.readFileSync(this.storePath, "utf8");
      const data = JSON.parse(raw) as SerializedStore;
      if (data.version !== 1 || data.projectId !== this.projectId) return;
      for (const [id, doc] of Object.entries(data.documents)) {
        this.documents.set(id, doc);
      }
    } catch {
      // Corrupt file — start fresh
      this.documents.clear();
    }
  }

  /**
   * Persist current documents to disk.
   * Creates `.yuan/` directory if it doesn't exist.
   */
  async save(): Promise<void> {
    if (!this.dirty) return;
    const dir = path.dirname(this.storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data: SerializedStore = {
      version: 1,
      projectId: this.projectId,
      documents: Object.fromEntries(this.documents.entries()),
    };
    fs.writeFileSync(this.storePath, JSON.stringify(data, null, 2), "utf8");
    this.dirty = false;
  }

  // ─── Indexing ─────────────────────────────────────────────────────────────

  /**
   * Add or update a document. Generates embedding from the provided text.
   *
   * @param id       - Unique document identifier
   * @param text     - Text content to embed
   * @param metadata - Arbitrary metadata attached to the document
   */
  async addDocument(
    id: string,
    text: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const [vector] = await this.embeddingProvider.embed([text]);
    this.documents.set(id, { vector, text, metadata });
    this.dirty = true;
  }

  /**
   * Remove a document by id.
   * @returns true if the document existed and was removed.
   */
  removeDocument(id: string): boolean {
    const existed = this.documents.delete(id);
    if (existed) this.dirty = true;
    return existed;
  }

  /**
   * Remove all documents whose metadata.filePath matches the given path.
   * @returns number of removed documents.
   */
  async removeByFile(filePath: string): Promise<number> {
    let removed = 0;
    for (const [id, doc] of this.documents.entries()) {
      if (doc.metadata["filePath"] === filePath) {
        this.documents.delete(id);
        removed++;
      }
    }
    if (removed > 0) this.dirty = true;
    return removed;
  }

  /**
   * Clear all documents.
   */
  clear(): void {
    this.documents.clear();
    this.dirty = true;
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  /**
   * Semantic search: embed queryText then rank all documents by cosine similarity.
   *
   * @param queryText - Natural language or code query
   * @param topK      - Maximum number of results to return (default 10)
   * @param threshold - Minimum similarity score to include (default 0)
   * @returns Array of results sorted by similarity descending
   */
  async search(
    queryText: string,
    topK = 10,
    threshold = 0,
  ): Promise<MemorySearchResult[]> {
    if (this.documents.size === 0) return [];

    const [queryVec] = await this.embeddingProvider.embed([queryText]);

    const scored: Array<{ id: string; sim: number; doc: StoredDocument }> = [];

    for (const [id, doc] of this.documents.entries()) {
      const sim = cosineSimilarity(queryVec, doc.vector);
      if (sim >= threshold) {
        scored.push({ id, sim, doc });
      }
    }

    scored.sort((a, b) => b.sim - a.sim);

    return scored.slice(0, topK).map(({ id, sim, doc }) => ({
      id,
      text: doc.text,
      similarity: sim,
      metadata: doc.metadata,
    }));
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  /** Total number of stored documents. */
  get size(): number {
    return this.documents.size;
  }

  /** Returns true if there are no stored documents. */
  get isEmpty(): boolean {
    return this.documents.size === 0;
  }
}

// ─── Config option type ───────────────────────────────────────────────────────

/**
 * Vector store backend selection.
 *
 * - `"postgres"` — pgvector only (fail if unavailable)
 * - `"memory"`   — InMemoryVectorStore only (never touches Postgres)
 * - `"auto"`     — try Postgres first, fall back to InMemoryVectorStore
 *
 * @default "auto"
 */
export type VectorStoreMode = "postgres" | "memory" | "auto";
