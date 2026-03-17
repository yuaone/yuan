/**
 * IncrementalClassifier — Content-Aware Pacer for YUAN CLI.
 *
 * Classifies raw streaming text deltas into content types using a 6-state
 * machine. Raw deltas are NOT line-aligned, so we buffer incomplete lines
 * and only classify completed ones.
 *
 * State machine: DEFAULT -> CODE_BLOCK / DIFF / TABLE (and partial variants).
 * Classification priority is documented inline at each rule.
 */

// ─── Public Types ────────────────────────────────────────────────────────────

export type ContentType =
  | "narration"
  | "prose"
  | "code_block"
  | "diff"
  | "heading"
  | "list"
  | "table"
  | "inline";

export type ClassifierMode =
  | "DEFAULT"
  | "CODE_BLOCK"
  | "CODE_BLOCK_PARTIAL"
  | "DIFF"
  | "DIFF_PARTIAL"
  | "TABLE";

export interface ClassifiedLine {
  type: ContentType;
  content: string;
}

export interface EventContext {
  recentToolCall: boolean;
  planningPhase: boolean;
  betweenTools: boolean;
}

// ─── Patterns ────────────────────────────────────────────────────────────────

const CODE_FENCE_RE = /^```/;

/** Diff requires 2+ strong signals — NOT bare +/- lines. */
const DIFF_GIT_RE = /^diff --git /;
const DIFF_MINUS_RE = /^--- /;
const DIFF_PLUS_RE = /^\+\+\+ /;
const DIFF_HUNK_RE = /^@@ /;

const HEADING_RE = /^#{1,3}\s/;
const TABLE_CELL_RE = /^\|.+\|/;
const TABLE_SEP_RE = /^\|[\s:|-]+\|$/;
const LIST_RE = /^[-*+]\s|^\d+[.)]\s/;

const NARRATION_EN_RE =
  /^(I'll |Let me |Now |First,? |Next,? |Reading |Writing |Analyzing |Checking |Running |Creating |Updating |Modifying |Looking at |Searching |Applying )/i;
const NARRATION_KO_RE = /^.{0,5}(분석|수정|생성|삭제|확인|검사|실행|적용|비교|검색|설치)/;

// ─── Buffer Limits ───────────────────────────────────────────────────────────

const MAX_CODE_BLOCK_BUFFER = 200;
const MAX_DIFF_BUFFER = 100;
const MAX_TABLE_BUFFER = 50;

// ─── Classifier ──────────────────────────────────────────────────────────────

export class IncrementalClassifier {
  private mode: ClassifierMode = "DEFAULT";
  private lineBuffer = "";
  private totalLinesInTurn = 0;
  private modeLineCount = 0;
  private pendingSeparatorRow = false;

  private ctx: EventContext = {
    recentToolCall: false,
    planningPhase: false,
    betweenTools: false,
  };

  /**
   * Ingest a raw streaming delta. Returns zero or more classified lines
   * for every complete line found after buffering.
   */
  ingest(chunk: string): ClassifiedLine[] {
    // CRLF normalization
    const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    this.lineBuffer += normalized;

    // Safety: prevent unbounded lineBuffer growth (e.g., minified JS from Gemini)
    // Force-emit if buffer exceeds 10KB without a newline
    const MAX_LINE_BUFFER = 10_000;
    if (this.lineBuffer.length > MAX_LINE_BUFFER && this.lineBuffer.indexOf("\n") === -1) {
      const forced = this.classifyLine(this.lineBuffer);
      const result = forced ? [forced] : [];
      this.lineBuffer = "";
      return result;
    }

    const results: ClassifiedLine[] = [];
    let idx = this.lineBuffer.indexOf("\n");

    while (idx !== -1) {
      const line = this.lineBuffer.slice(0, idx);
      this.lineBuffer = this.lineBuffer.slice(idx + 1);
      this.totalLinesInTurn++;

      const classified = this.classifyLine(line);
      if (classified) {
        results.push(classified);
      }

      // Partial flush checks for long blocks
      const flushed = this.checkPartialFlush();
      if (flushed) {
        results.push(flushed);
      }

      idx = this.lineBuffer.indexOf("\n");
    }

    return results;
  }

  /** Flush any remaining incomplete line in the buffer. */
  flushIncomplete(): ClassifiedLine | null {
    if (!this.lineBuffer) return null;

    const line = this.lineBuffer;
    this.lineBuffer = "";
    this.totalLinesInTurn++;
    return this.classifyLine(line);
  }

  /** Update event context for narration classification. */
  setEventContext(ctx: Partial<EventContext>): void {
    Object.assign(this.ctx, ctx);
  }

  /** Reset all state for a new turn. */
  reset(): void {
    this.mode = "DEFAULT";
    this.lineBuffer = "";
    this.totalLinesInTurn = 0;
    this.modeLineCount = 0;
    this.pendingSeparatorRow = false;
    this.ctx = { recentToolCall: false, planningPhase: false, betweenTools: false };
  }

  /** Current state machine mode. */
  getMode(): ClassifierMode {
    return this.mode;
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private classifyLine(line: string): ClassifiedLine {
    const trimmed = line.trimStart();

    // Priority 1: Inside CODE_BLOCK / CODE_BLOCK_PARTIAL
    if (this.mode === "CODE_BLOCK" || this.mode === "CODE_BLOCK_PARTIAL") {
      this.modeLineCount++;
      if (CODE_FENCE_RE.test(trimmed)) {
        this.mode = "DEFAULT";
        this.modeLineCount = 0;
      }
      return { type: "code_block", content: line };
    }

    // Priority 2: Inside DIFF / DIFF_PARTIAL
    if (this.mode === "DIFF" || this.mode === "DIFF_PARTIAL") {
      if (this.isDiffLine(trimmed)) {
        this.modeLineCount++;
        return { type: "diff", content: line };
      }
      // Empty line is still part of diff context
      if (trimmed === "") {
        this.modeLineCount++;
        return { type: "diff", content: line };
      }
      // Non-diff, non-empty line exits diff mode
      this.mode = "DEFAULT";
      this.modeLineCount = 0;
      // Fall through to default classification
    }

    // Priority 3: Inside TABLE
    if (this.mode === "TABLE") {
      if (TABLE_CELL_RE.test(trimmed)) {
        this.modeLineCount++;
        return { type: "table", content: line };
      }
      this.mode = "DEFAULT";
      this.modeLineCount = 0;
      // Fall through
    }

    // Priority 4: Code fence opens
    if (CODE_FENCE_RE.test(trimmed)) {
      this.mode = "CODE_BLOCK";
      this.modeLineCount = 1;
      return { type: "code_block", content: line };
    }

    // Priority 5: Diff detection (requires 2+ strong signals in one line)
    if (this.isDiffStart(trimmed)) {
      this.mode = "DIFF";
      this.modeLineCount = 1;
      return { type: "diff", content: line };
    }

    // Priority 6: Heading
    if (HEADING_RE.test(trimmed)) {
      return { type: "heading", content: line };
    }

    // Priority 7: Table detection (cell row + pending separator check)
    if (TABLE_CELL_RE.test(trimmed)) {
      if (TABLE_SEP_RE.test(trimmed)) {
        // Separator row confirms table mode
        this.mode = "TABLE";
        this.modeLineCount = 1;
        this.pendingSeparatorRow = false;
        return { type: "table", content: line };
      }
      if (this.pendingSeparatorRow) {
        // Two cell rows without a separator — not a real table, reset
        this.pendingSeparatorRow = false;
        return { type: "prose", content: line };
      }
      this.pendingSeparatorRow = true;
      return { type: "table", content: line };
    }
    this.pendingSeparatorRow = false;

    // Priority 8: List
    if (LIST_RE.test(trimmed)) {
      return { type: "list", content: line };
    }

    // Priority 9: Narration (requires 2 of 3 signals)
    if (this.isNarration(trimmed)) {
      return { type: "narration", content: line };
    }

    // Priority 10: Inline (total output <= 2 lines in this turn)
    if (this.totalLinesInTurn <= 2) {
      return { type: "inline", content: line };
    }

    // Priority 11: Default
    return { type: "prose", content: line };
  }

  /** Check if a line is a strong diff signal (for continuing diff blocks). */
  private isDiffLine(trimmed: string): boolean {
    return (
      DIFF_GIT_RE.test(trimmed) ||
      DIFF_MINUS_RE.test(trimmed) ||
      DIFF_PLUS_RE.test(trimmed) ||
      DIFF_HUNK_RE.test(trimmed) ||
      /^[+ -]/.test(trimmed) // context/add/remove lines within a confirmed diff
    );
  }

  /**
   * Diff start requires 2+ strong signals: `diff --git`, `---`+`+++`,
   * or `@@` hunk headers. Single +/- lines are NOT enough.
   */
  private isDiffStart(trimmed: string): boolean {
    let signals = 0;
    if (DIFF_GIT_RE.test(trimmed)) signals++;
    if (DIFF_HUNK_RE.test(trimmed)) signals++;
    // A single line can only be one of these — but `diff --git` alone is
    // strong enough as it is unambiguous.
    return signals >= 1 && DIFF_GIT_RE.test(trimmed);
  }

  /**
   * Narration requires 2 of 3 signals:
   *   1. Keyword match (EN or KO action verb)
   *   2. Event context (recentToolCall, planningPhase, betweenTools)
   *   3. Short sentence (<80 chars ending with period)
   */
  private isNarration(trimmed: string): boolean {
    let signals = 0;

    // Signal 1: keyword match
    if (NARRATION_EN_RE.test(trimmed) || NARRATION_KO_RE.test(trimmed)) {
      signals++;
    }

    // Signal 2: event context
    if (this.ctx.recentToolCall || this.ctx.planningPhase || this.ctx.betweenTools) {
      signals++;
    }

    // Signal 3: short sentence ending with period
    if (trimmed.length < 80 && /\.$/.test(trimmed)) {
      signals++;
    }

    return signals >= 2;
  }

  /** Partial flush for oversized blocks. Returns a sentinel if flushed. */
  private checkPartialFlush(): ClassifiedLine | null {
    if ((this.mode === "CODE_BLOCK" || this.mode === "CODE_BLOCK_PARTIAL") &&
        this.modeLineCount >= MAX_CODE_BLOCK_BUFFER) {
      this.mode = "CODE_BLOCK_PARTIAL";
      this.modeLineCount = 0;
      return null; // lines already emitted inline; mode marker updated
    }

    if ((this.mode === "DIFF" || this.mode === "DIFF_PARTIAL") &&
        this.modeLineCount >= MAX_DIFF_BUFFER) {
      this.mode = "DIFF_PARTIAL";
      this.modeLineCount = 0;
      return null;
    }

    if (this.mode === "TABLE" && this.modeLineCount >= MAX_TABLE_BUFFER) {
      this.mode = "DEFAULT";
      this.modeLineCount = 0;
      return null;
    }

    return null;
  }
}
