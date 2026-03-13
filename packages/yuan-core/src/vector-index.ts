/**
 * @module vector-index
 * @description Vector DB Code Indexer — pgvector 기반 시맨틱 코드 검색.
 *
 * 코드 임베딩을 PostgreSQL pgvector에 저장하고, 자연어 / 코드 유사도로 검색.
 * DB 연결은 외부에서 주입 (SQLExecutor), 임베딩 생성도 외부에서 주입 (EmbeddingProvider).
 *
 * 주요 기능:
 * - 코드 심볼 인덱싱 (함수, 클래스, 인터페이스, 타입, enum 등)
 * - 시맨틱 검색 (자연어 → 코드)
 * - 코드 유사도 검색 (중복/유사 코드 탐지)
 * - 파일 단위 재인덱싱
 * - 프로젝트 통계
 */

// ─── Types ─────────────────────────────────────────────────────────

/** 코드 심볼의 타입 */
export type SymbolType =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "method";

/** 코드 임베딩 레코드 */
export interface CodeEmbedding {
  /** DB primary key (auto-generated) */
  id?: number;
  /** 프로젝트 식별자 */
  projectId: string;
  /** 소스 파일 경로 (프로젝트 루트 기준 상대경로) */
  filePath: string;
  /** 심볼 이름 (함수명, 클래스명 등) */
  symbolName: string;
  /** 심볼 종류 */
  symbolType: SymbolType;
  /** 코드 스니펫 원문 */
  codeSnippet: string;
  /** 임베딩 벡터 (1536-dim for OpenAI, 768 for others) */
  embedding: number[];
  /** 심볼 메타데이터 */
  metadata: {
    /** 시작 라인 (1-based) */
    line: number;
    /** 종료 라인 (1-based) */
    endLine: number;
    /** 함수 파라미터 시그니처 */
    params?: string;
    /** 반환 타입 */
    returnType?: string;
    /** export 여부 */
    exported: boolean;
    /** 코드 복잡도 (cyclomatic) */
    complexity?: number;
  };
  /** 마지막 인덱싱 시각 */
  updatedAt: Date;
}

/** 벡터 검색 결과 */
export interface VectorSearchResult {
  /** 심볼 이름 */
  symbolName: string;
  /** 파일 경로 */
  filePath: string;
  /** 심볼 종류 */
  symbolType: string;
  /** 코드 스니펫 */
  codeSnippet: string;
  /** 코사인 유사도 (0–1, 1이 완전 일치) */
  similarity: number;
  /** 메타데이터 */
  metadata: Record<string, unknown>;
}

/**
 * 임베딩 생성 프로바이더.
 * 외부에서 주입 — OpenAI, Cohere, local model 등.
 */
export interface EmbeddingProvider {
  /** 텍스트 배열을 임베딩 벡터 배열로 변환 */
  embed(texts: string[]): Promise<number[][]>;
  /** 임베딩 차원 수 (1536 for OpenAI text-embedding-3-small, 768 for others) */
  dimension: number;
}
/**
 * Optional embedding cache
 * (Redis, memory, etc)
 */
export interface EmbeddingCache {
  get(key: string): Promise<number[] | null>;
  set(key: string, embedding: number[]): Promise<void>;
}
/**
 * SQL 실행기 — 외부에서 주입 (yua-backend의 PostgreSQL pool).
 * 이 모듈은 직접 DB 연결을 하지 않는다.
 */
export interface SQLExecutor {
  /** SQL 쿼리 실행 */
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

/** VectorIndex 설정 */
export interface VectorIndexConfig {
  /** 프로젝트 식별자 */
  projectId: string;
  /** 임베딩 생성 프로바이더 */
  embeddingProvider: EmbeddingProvider;
  /** SQL 실행기 */
  sqlExecutor: SQLExecutor;
  /** 배치 인덱싱 크기 (default: 50) */
  batchSize?: number;
  /** 임베딩 차원 (default: 1536) */
  dimension?: number;
  /** optional embedding cache */
  embeddingCache?: EmbeddingCache;

  /** enable HNSW tuning */
  hnswSearchEf?: number;
}

/** 인덱스 통계 */
export interface IndexStats {
  /** 총 임베딩 수 */
  totalEmbeddings: number;
  /** 인덱싱된 파일 수 */
  totalFiles: number;
  /** 마지막 인덱싱 시각 */
  lastIndexedAt: Date | null;
  /** 인덱스 테이블 크기 (bytes, 추정) */
  indexSizeBytes: number;
}

// ─── Constants ─────────────────────────────────────────────────────

const TABLE_NAME = "code_embeddings";
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_DIMENSION = 1536;
const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_SIMILARITY_THRESHOLD = 0.7;

// ─── VectorIndex ───────────────────────────────────────────────────

/**
 * VectorIndex — pgvector 기반 코드 시맨틱 인덱서.
 *
 * 코드 심볼을 벡터로 변환하여 PostgreSQL에 저장하고,
 * 자연어 질의 또는 코드 유사도로 검색하는 기능을 제공한다.
 *
 * @example
 * ```ts
 * const index = new VectorIndex({
 *   projectId: "my-project",
 *   embeddingProvider: openaiEmbedder,
 *   sqlExecutor: pgPool,
 * });
 * await index.initialize();
 * await index.indexBatch(symbols);
 * const results = await index.search("user authentication logic");
 * ```
 */
export class VectorIndex {
  private config: VectorIndexConfig & {
    batchSize: number;
    dimension: number;
  };

  constructor(config: VectorIndexConfig) {
    this.config = {
      projectId: config.projectId,
      embeddingProvider: config.embeddingProvider,
      sqlExecutor: config.sqlExecutor,
      batchSize: config.batchSize ?? DEFAULT_BATCH_SIZE,
      dimension: config.dimension ?? DEFAULT_DIMENSION,
     embeddingCache: config.embeddingCache,
      hnswSearchEf: config.hnswSearchEf,
    };
  }

  // ─── Schema ────────────────────────────────────────────────────

  /**
   * CREATE TABLE + INDEX SQL을 생성한다 (idempotent).
   * pgvector extension, 테이블, 인덱스를 모두 포함.
   *
   * @returns 실행할 SQL 문자열
   */
  getCreateTableSQL(): string {
    const dim = this.config.dimension;
    return `
-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Code embeddings table
CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
  id SERIAL PRIMARY KEY,
  project_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  symbol_name TEXT NOT NULL,
  symbol_type TEXT NOT NULL,
  code_snippet TEXT NOT NULL,
  embedding vector(${dim}) NOT NULL,
  metadata JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Unique constraint for upsert
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_code_embedding_symbol'
  ) THEN
    ALTER TABLE ${TABLE_NAME}
    ADD CONSTRAINT uq_code_embedding_symbol
    UNIQUE (project_id, file_path, symbol_name, symbol_type);
  END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_code_embedding_project
  ON ${TABLE_NAME} (project_id);
CREATE INDEX IF NOT EXISTS idx_code_embedding_file
  ON ${TABLE_NAME} (project_id, file_path);
CREATE INDEX IF NOT EXISTS idx_code_embedding_type
  ON ${TABLE_NAME} (project_id, symbol_type);

-- IVFFlat vector index (cosine distance)
-- Note: requires at least 100 rows for lists=100 to be effective.
-- For small datasets, pgvector falls back to sequential scan automatically.
 CREATE INDEX IF NOT EXISTS idx_code_embedding_vector
  ON ${TABLE_NAME}
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
`.trim();
  }

  /**
   * 테이블을 초기화한다 (startup 시 호출).
   * CREATE TABLE + INDEX를 실행한다 (idempotent).
   */
  async initialize(): Promise<void> {
    const sql = this.getCreateTableSQL();
    // Split by semicolons and execute each statement
    // (some drivers don't support multi-statement execution)
    const statements = this.splitStatements(sql);
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (trimmed.length > 0) {
        await this.config.sqlExecutor.query(trimmed);
      }
    }
  }

  // ─── Indexing ──────────────────────────────────────────────────

  /**
   * 단일 심볼을 인덱싱한다 (upsert).
   * 이미 임베딩이 포함된 CodeEmbedding을 받는다.
   *
   * @param symbol - 임베딩이 포함된 코드 심볼
   */
  async indexSymbol(symbol: CodeEmbedding): Promise<void> {
    const { sql, params } = this.buildUpsertSQL(symbol);
    await this.config.sqlExecutor.query(sql, params);
  }

  /**
   * 여러 심볼을 배치로 인덱싱한다.
   * 임베딩이 없는 심볼을 받아 자동으로 임베딩을 생성한다.
   *
   * @param symbols - 임베딩 없는 코드 심볼 배열
   * @returns 인덱싱된 심볼 수
   */
  async indexBatch(
    symbols: Omit<CodeEmbedding, "embedding">[],
  ): Promise<number> {
    if (symbols.length === 0) return 0;

    let indexed = 0;
    const batchSize = this.config.batchSize;

    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);

      // Build text representations for embedding
      const texts = batch.map((s) =>
        this.buildSnippetForEmbedding({
          name: s.symbolName,
          type: s.symbolType,
          code: s.codeSnippet,
          file: s.filePath,
        }),
      );

      // Generate embeddings
      const embeddings = await this.generateEmbeddings(texts);

      // Upsert each symbol
      const rows: CodeEmbedding[] = batch.map((symbol, idx) => ({
        ...symbol,
        embedding: embeddings[idx],
      }));

      await this.bulkUpsert(rows);
      indexed += rows.length;
    }

    return indexed;
  }

  /**
   * 파일 하나를 재인덱싱한다.
   * 기존 임베딩을 삭제하고 새로운 심볼로 교체한다.
   *
   * @param filePath - 파일 경로 (프로젝트 루트 기준)
   * @param symbols - 새로운 심볼 배열 (임베딩 없음)
   * @returns 인덱싱된 심볼 수
   */
  async reindexFile(
    filePath: string,
    symbols: Omit<CodeEmbedding, "embedding">[],
  ): Promise<number> {
    // Delete existing embeddings for this file
    await this.removeFile(filePath);

    // Index new symbols
    if (symbols.length === 0) return 0;
    return this.indexBatch(symbols);
  }

  /**
   * 파일의 모든 임베딩을 삭제한다.
   *
   * @param filePath - 파일 경로
   * @returns 삭제된 행 수
   */
  async removeFile(filePath: string): Promise<number> {
    const sql = `DELETE FROM ${TABLE_NAME} WHERE project_id = $1 AND file_path = $2`;
    const result = await this.config.sqlExecutor.query(sql, [
      this.config.projectId,
      filePath,
    ]);
    // PostgreSQL returns rowCount, but our interface uses rows.
    // Convention: the executor can return affected count via rows length or a special field.
    const rowCount = (result as any).rowCount;
    if (typeof rowCount === "number") return rowCount;
    return 0;
  }

  /**
   * 프로젝트의 모든 임베딩을 삭제한다.
   *
   * @returns 삭제된 행 수
   */
  async clearProject(): Promise<number> {
    const sql = `DELETE FROM ${TABLE_NAME} WHERE project_id = $1`;
    const result = await this.config.sqlExecutor.query(sql, [
      this.config.projectId,
    ]);
    const rowCount = (result as any).rowCount;
    if (typeof rowCount === "number") return rowCount;
    return 0;
  }

  // ─── Search ────────────────────────────────────────────────────

  /**
   * 자연어 쿼리로 시맨틱 검색한다.
   *
   * @param query - 자연어 검색 쿼리 (e.g., "user authentication logic")
   * @param limit - 최대 결과 수 (default: 10)
   * @returns 유사도 순으로 정렬된 검색 결과
   */
  async search(
    query: string,
    limit: number = DEFAULT_SEARCH_LIMIT,
  ): Promise<VectorSearchResult[]> {
  if (this.config.hnswSearchEf) {
    await this.config.sqlExecutor.query(
      `SET LOCAL hnsw.ef_search = ${this.config.hnswSearchEf}`
    );
  }
    const [embedding] = await this.generateEmbeddings([query]);
    const { sql, params } = this.buildSearchSQL(embedding, limit);
    const result = await this.config.sqlExecutor.query(sql, params);
    return this.mapSearchResults(result.rows);
  }

  /**
   * 코드 스니펫 유사도로 검색한다.
   *
   * @param codeSnippet - 비교할 코드 스니펫
   * @param limit - 최대 결과 수 (default: 10)
   * @param threshold - 최소 유사도 임계값 (default: 0.7)
   * @returns 유사도 순으로 정렬된 검색 결과 (threshold 이상만)
   */
  async searchBySimilarity(
    codeSnippet: string,
    limit: number = DEFAULT_SEARCH_LIMIT,
    threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
  ): Promise<VectorSearchResult[]> {
    const [embedding] = await this.generateEmbeddings([codeSnippet]);
    const { sql, params } = this.buildSearchSQL(embedding, limit, {
      threshold,
    });
    const result = await this.config.sqlExecutor.query(sql, params);
    return this.mapSearchResults(result.rows);
  }

  /**
   * 심볼 타입으로 필터링하여 검색한다.
   *
   * @param query - 자연어 검색 쿼리
   * @param symbolType - 필터링할 심볼 타입 (e.g., "function", "class")
   * @param limit - 최대 결과 수 (default: 10)
   * @returns 유사도 순으로 정렬된 검색 결과
   */
  async searchByType(
    query: string,
    symbolType: string,
    limit: number = DEFAULT_SEARCH_LIMIT,
  ): Promise<VectorSearchResult[]> {
    const [embedding] = await this.generateEmbeddings([query]);
    const { sql, params } = this.buildSearchSQL(embedding, limit, {
      symbolType,
    });
    const result = await this.config.sqlExecutor.query(sql, params);
    return this.mapSearchResults(result.rows);
  }

  /**
   * 중복/유사 코드를 탐지한다.
   *
   * @param codeSnippet - 비교할 코드 스니펫
   * @param threshold - 최소 유사도 임계값 (default: 0.85, 높은 값으로 중복 탐지)
   * @returns 유사도 순으로 정렬된 검색 결과
   */
  async findSimilarCode(
    codeSnippet: string,
    threshold: number = 0.85,
  ): Promise<VectorSearchResult[]> {
    const [embedding] = await this.generateEmbeddings([codeSnippet]);
    const { sql, params } = this.buildSearchSQL(embedding, 20, { threshold });
    const result = await this.config.sqlExecutor.query(sql, params);
    return this.mapSearchResults(result.rows);
  }

  // ─── Queries ───────────────────────────────────────────────────

  /**
   * 파일의 모든 심볼을 조회한다.
   *
   * @param filePath - 파일 경로
   * @returns 해당 파일의 CodeEmbedding 배열
   */
  async getFileSymbols(filePath: string): Promise<CodeEmbedding[]> {
    const sql = `
      SELECT id, project_id, file_path, symbol_name, symbol_type,
             code_snippet, embedding::text, metadata, updated_at
      FROM ${TABLE_NAME}
      WHERE project_id = $1 AND file_path = $2
      ORDER BY (metadata->>'line')::int ASC NULLS LAST
    `;
    const result = await this.config.sqlExecutor.query(sql, [
      this.config.projectId,
      filePath,
    ]);
    return result.rows.map((row) => this.mapRowToEmbedding(row));
  }

  /**
   * 인덱스 통계를 조회한다.
   *
   * @returns 인덱스 통계 (총 임베딩 수, 파일 수, 마지막 인덱싱 시각, 테이블 크기)
   */
  async getStats(): Promise<IndexStats> {
    const sql = `
      SELECT
        COUNT(*) AS total_embeddings,
        COUNT(DISTINCT file_path) AS total_files,
        MAX(updated_at) AS last_indexed_at,
        pg_total_relation_size('${TABLE_NAME}') AS index_size_bytes
      FROM ${TABLE_NAME}
      WHERE project_id = $1
    `;
    const result = await this.config.sqlExecutor.query(sql, [
      this.config.projectId,
    ]);

    if (result.rows.length === 0) {
      return {
        totalEmbeddings: 0,
        totalFiles: 0,
        lastIndexedAt: null,
        indexSizeBytes: 0,
      };
    }

    const row = result.rows[0];
    return {
      totalEmbeddings: Number(row.total_embeddings) || 0,
      totalFiles: Number(row.total_files) || 0,
      lastIndexedAt: row.last_indexed_at
        ? new Date(row.last_indexed_at as string)
        : null,
      indexSizeBytes: Number(row.index_size_bytes) || 0,
    };
  }

  /**
   * 파일이 인덱싱되어 있는지 확인한다.
   *
   * @param filePath - 파일 경로
   * @returns 인덱싱 여부
   */
  async isFileIndexed(filePath: string): Promise<boolean> {
    const sql = `
      SELECT EXISTS(
        SELECT 1 FROM ${TABLE_NAME}
        WHERE project_id = $1 AND file_path = $2
        LIMIT 1
      ) AS indexed
    `;
    const result = await this.config.sqlExecutor.query(sql, [
      this.config.projectId,
      filePath,
    ]);
    return result.rows[0]?.indexed === true;
  }

  // ─── Helpers ───────────────────────────────────────────────────

  /**
   * 코드 심볼을 임베딩용 텍스트로 변환한다.
   * 파일 경로, 심볼 타입, 이름, 코드를 포함한 리치 텍스트를 생성하여
   * 임베딩 품질을 높인다.
   *
   * @param symbol - 심볼 정보
   * @returns 임베딩용 텍스트
   *
   * @example
   * ```
   * File: src/auth/login.ts
   * Type: function
   * Name: validateUser
   * Code:
   * async function validateUser(email: string): Promise<User | null> { ... }
   * ```
   */
  buildSnippetForEmbedding(symbol: {
    name: string;
    type: string;
    code: string;
    file: string;
  }): string {
    // Extract signature from code if it's a function/method
    const signature = this.extractSignature(symbol.code, symbol.type);

    const parts: string[] = [
      `File: ${symbol.file}`,
      `Type: ${symbol.type}`,
      `Name: ${symbol.name}`,
    ];

    if (signature && signature !== symbol.code.trim()) {
      parts.push(`Signature: ${signature}`);
    }

    parts.push(`Code:`, symbol.code);

    return parts.join("\n");
  }

  // ─── Private Methods ──────────────────────────────────────────

  /**
   * 텍스트 배열의 임베딩을 생성한다.
   * 프로바이더의 batch API를 사용한다.
   */
  private async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const chunk = 32;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += chunk) {
      const slice = texts.slice(i, i + chunk);
    const embBatch: number[][] = [];

    for (const text of slice) {
      const key = this.hash(text);

      if (this.config.embeddingCache) {
        const cached = await this.config.embeddingCache.get(key);
        if (cached) {
          embBatch.push(cached);
          continue;
        }
      }

    const emb = (await this.config.embeddingProvider.embed([text]))[0];

      if (this.config.embeddingCache) {
        await this.config.embeddingCache.set(key, emb);
      }

      embBatch.push(emb);
    }

    results.push(...embBatch);
    }

    return results;
  }

  /**
   * 임베딩 벡터를 PostgreSQL vector 리터럴 형식으로 변환한다.
   *
   * @param embedding - 숫자 배열
   * @returns "[0.1,0.2,...]" 형식의 문자열
   */
  private formatVector(embedding: number[]): string {
  let s = "[";
  for (let i = 0; i < embedding.length; i++) {
    if (i) s += ",";
    s += embedding[i];
  }
  return s + "]";
  }

  /**
   * Upsert SQL을 생성한다.
   * (project_id, file_path, symbol_name, symbol_type) 기준으로 UPSERT.
   */
  private buildUpsertSQL(embedding: CodeEmbedding): {
    sql: string;
    params: unknown[];
  } {
    const sql = `
      INSERT INTO ${TABLE_NAME}
        (project_id, file_path, symbol_name, symbol_type, code_snippet, embedding, metadata, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6::vector, $7::jsonb, NOW())
      ON CONFLICT ON CONSTRAINT uq_code_embedding_symbol
      DO UPDATE SET
        code_snippet = EXCLUDED.code_snippet,
        embedding = EXCLUDED.embedding,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
    `;

    const params = [
      embedding.projectId,
      embedding.filePath,
      embedding.symbolName,
      embedding.symbolType,
      embedding.codeSnippet,
      this.formatVector(embedding.embedding),
      JSON.stringify(embedding.metadata),
    ];

    return { sql: sql.trim(), params };
  }

    private async bulkUpsert(rows: CodeEmbedding[]): Promise<void> {
    if (rows.length === 0) return;

    const values: string[] = [];
    const params: unknown[] = [];

    let p = 1;

    for (const row of rows) {
      values.push(
        `($${p++},$${p++},$${p++},$${p++},$${p++},$${p++}::vector,$${p++}::jsonb,NOW())`
      );

      params.push(
        row.projectId,
        row.filePath,
        row.symbolName,
        row.symbolType,
        row.codeSnippet,
        this.formatVector(row.embedding),
        JSON.stringify(row.metadata)
      );
    }

    const sql = `
      INSERT INTO ${TABLE_NAME}
      (project_id,file_path,symbol_name,symbol_type,code_snippet,embedding,metadata,updated_at)
      VALUES ${values.join(",")}
      ON CONFLICT ON CONSTRAINT uq_code_embedding_symbol
      DO UPDATE SET
        code_snippet = EXCLUDED.code_snippet,
        embedding = EXCLUDED.embedding,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
    `;

    await this.config.sqlExecutor.query(sql, params);
  }
  /**
   * 벡터 검색 SQL을 생성한다.
   * 코사인 거리(<=>)를 사용하여 유사도 순으로 정렬한다.
   *
   * @param embedding - 쿼리 임베딩 벡터
   * @param limit - 최대 결과 수
   * @param filters - 선택적 필터 (symbolType, threshold)
   */
  private buildSearchSQL(
    embedding: number[],
    limit: number,
    filters?: Record<string, unknown>,
  ): { sql: string; params: unknown[] } {
    const conditions: string[] = [`project_id = $2`];
    const params: unknown[] = [this.formatVector(embedding), this.config.projectId];
    let paramIndex = 3;

    // Symbol type filter
    if (filters?.symbolType) {
      conditions.push(`symbol_type = $${paramIndex}`);
      params.push(filters.symbolType);
      paramIndex++;
    }

    // Similarity threshold filter (cosine distance: 0 = identical, 2 = opposite)
    // similarity = 1 - distance, so distance < 1 - threshold
    let havingClause = "";
    if (filters?.threshold != null) {
      havingClause = `HAVING 1 - (embedding <=> $1::vector) >= $${paramIndex}`;
      params.push(filters.threshold);
      paramIndex++;
    }

    const whereClause = conditions.join(" AND ");

    // Use a subquery to apply HAVING-like filtering via WHERE on an outer query
    let sql: string;
    if (havingClause) {
      sql = `
        SELECT symbol_name, file_path, symbol_type, code_snippet, metadata, similarity
        FROM (
          SELECT symbol_name, file_path, symbol_type, code_snippet, metadata,
                 1 - (embedding <=> $1::vector) AS similarity
          FROM ${TABLE_NAME}
          WHERE ${whereClause}
        ) sub
        WHERE similarity >= $${paramIndex - 1}
        ORDER BY similarity DESC
        LIMIT $${paramIndex}
      `;
      params.push(limit);
    } else {
      sql = `
        SELECT symbol_name, file_path, symbol_type, code_snippet, metadata,
               1 - (embedding <=> $1::vector) AS similarity
        FROM ${TABLE_NAME}
        WHERE ${whereClause}
        ORDER BY embedding <=> $1::vector
        LIMIT $${paramIndex}
      `;
      params.push(limit);
    }

    return { sql: sql.trim(), params };
  }

  /**
   * DB 행 배열을 VectorSearchResult 배열로 변환한다.
   */
  private mapSearchResults(
    rows: Record<string, unknown>[],
  ): VectorSearchResult[] {
    return rows.map((row) => ({
      symbolName: row.symbol_name as string,
      filePath: row.file_path as string,
      symbolType: row.symbol_type as string,
      codeSnippet: row.code_snippet as string,
      similarity: Number(row.similarity) || 0,
      metadata: this.parseJsonb(row.metadata),
    }));
  }

  /**
   * DB 행을 CodeEmbedding으로 변환한다.
   */
  private mapRowToEmbedding(row: Record<string, unknown>): CodeEmbedding {
    return {
      id: Number(row.id),
      projectId: row.project_id as string,
      filePath: row.file_path as string,
      symbolName: row.symbol_name as string,
      symbolType: row.symbol_type as SymbolType,
      codeSnippet: row.code_snippet as string,
      embedding: this.parseVector(row.embedding as string),
      metadata: this.parseEmbeddingMetadata(row.metadata),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  /**
   * PostgreSQL vector 리터럴 "[0.1,0.2,...]"을 숫자 배열로 파싱한다.
   */
  private parseVector(vectorStr: string): number[] {
    if (!vectorStr) return [];
    // pgvector returns "[0.1,0.2,...]" format
    const cleaned = vectorStr.replace(/^\[/, "").replace(/\]$/, "");
    if (cleaned.length === 0) return [];
    return cleaned.split(",").map(Number);
  }

  /**
   * JSONB 값을 Record<string, unknown>으로 파싱한다.
   */
  private parseJsonb(value: unknown): Record<string, unknown> {
    if (value === null || value === undefined) return {};
    if (typeof value === "object") return value as Record<string, unknown>;
    if (typeof value === "string") {
      try {
        return JSON.parse(value) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    return {};
  }

  /**
   * JSONB 메타데이터를 CodeEmbedding.metadata 형식으로 파싱한다.
   */
  private parseEmbeddingMetadata(value: unknown): CodeEmbedding["metadata"] {
    const raw = this.parseJsonb(value);
    return {
      line: Number(raw.line) || 0,
      endLine: Number(raw.endLine) || 0,
      params: raw.params as string | undefined,
      returnType: raw.returnType as string | undefined,
      exported: Boolean(raw.exported),
      complexity: raw.complexity != null ? Number(raw.complexity) : undefined,
    };
  }

  /**
   * 코드에서 함수/메서드 시그니처를 추출한다.
   * 임베딩에 시그니처를 포함하면 검색 품질이 향상된다.
   */
  private extractSignature(code: string, type: string): string | null {
    if (type !== "function" && type !== "method") return null;

    const lines = code.split("\n");
    const firstLine = lines[0]?.trim();
    if (!firstLine) return null;

    // Match function/method declarations
    // e.g., "async function validateUser(email: string): Promise<User>"
    // e.g., "async validateUser(email: string): Promise<User> {"
    const match = firstLine.match(
      /^(?:export\s+)?(?:async\s+)?(?:function\s+)?\w+\s*\([^)]*\)(?:\s*:\s*[^{]+)?/,
    );
    return match ? match[0].trim() : firstLine;
  }
private hash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h << 5) - h + text.charCodeAt(i);
    h |= 0;
  }
  return h.toString();
}
  /**
   * SQL 문자열을 개별 statement로 분리한다.
   * DO $$ ... $$ 블록을 올바르게 처리한다.
   */
  private splitStatements(sql: string): string[] {
    const statements: string[] = [];
    let current = "";
    let inDollarBlock = false;

    const lines = sql.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();

      // Track DO $$ blocks
      if (trimmed.startsWith("DO $$") || trimmed === "DO $$") {
        inDollarBlock = true;
        current += line + "\n";
        continue;
      }

      if (inDollarBlock) {
        current += line + "\n";
        // End of DO $$ block
        if (trimmed === "$$;" || trimmed.endsWith("$$;")) {
          inDollarBlock = false;
          statements.push(current.trim());
          current = "";
        }
        continue;
      }

      // Regular statement — split on semicolons at end of line
      current += line + "\n";
      if (trimmed.endsWith(";") && !inDollarBlock) {
        statements.push(current.trim());
        current = "";
      }
    }

    // Handle any remaining content
    if (current.trim().length > 0) {
      statements.push(current.trim());
    }

    return statements.filter((s) => {
      const cleaned = s.replace(/--.*$/gm, "").trim();
      return cleaned.length > 0 && cleaned !== ";";
    });
  }
}
