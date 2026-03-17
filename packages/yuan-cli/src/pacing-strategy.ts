/**
 * pacing-strategy.ts — Content-Aware Pacer for YUAN CLI.
 *
 * Routes classified content lines to one of 5 pacing modes, each with
 * its own buffering semantics and timing.  All timers are cancellable
 * for clean shutdown.
 *
 * Modes:
 *   immediate       — heading, inline → zero-delay passthrough
 *   sentence_stream — narration → buffer until sentence boundary, stagger 80 ms
 *   collect_flush   — prose → accumulate, flush on paragraph / idle / deadline
 *   block_buffer    — code_block, diff, table → accumulate until block end
 *   line_stream     — list → one line per 30 ms tick
 */

import type { ContentType, ClassifiedLine } from "./incremental-classifier.js";

// ─── Pacing Modes ───────────────────────────────────────────────────────────

export type PacingMode =
  | "immediate"
  | "sentence_stream"
  | "collect_flush"
  | "block_buffer"
  | "line_stream";

export const CONTENT_TO_PACING: Record<ContentType, PacingMode> = {
  narration: "sentence_stream",
  prose: "collect_flush",
  code_block: "block_buffer",
  diff: "block_buffer",
  heading: "immediate",
  list: "line_stream",
  table: "block_buffer",
  inline: "immediate",
};

// ─── Output ─────────────────────────────────────────────────────────────────

export interface PacingOutput {
  content: string;
  pacingMode: PacingMode;
  scheduledDelay: number;
  useSyncOutput: boolean;
  priority: number;
}

// ─── Timing Config (SSOT) ───────────────────────────────────────────────────

export const PACING_CONFIG = {
  narration: { delayPerSentence: 80, firstSentenceDelay: 0, maxBuffer: 500 },
  prose: {
    firstVisibleDeadline: 1500,
    idleTimeout: 2000,
    maxCollectTime: 8000,
    paragraphFlushThreshold: 2,
  },
  codeBlock: { maxBufferLines: 200, maxBufferTime: 10_000 },
  diff: { maxBufferLines: 100, maxBufferTime: 5_000 },
  list: { delayPerLine: 30 },
  table: { maxBufferLines: 50, maxBufferTime: 3_000 },
  queue: { agingThreshold: 3_000, minFlushInterval: 16 },
  memory: {
    maxProseBuffer: 50_000,
    maxCodeBuffer: 100_000,
    maxDiffBuffer: 50_000,
    maxTableBuffer: 20_000,
    maxTotalBuffer: 200_000,
  },
} as const;

export type PacingConfig = typeof PACING_CONFIG;

/** Mutable version of PacingConfig — widens literal number types for runtime updates. */
type Widen<T> = T extends number ? number : T extends string ? string : T extends boolean ? boolean : T;
export type MutablePacingConfig = {
  -readonly [K in keyof PacingConfig]: {
    -readonly [P in keyof PacingConfig[K]]: Widen<PacingConfig[K][P]>;
  };
};

// ─── Sentence Splitting ─────────────────────────────────────────────────────

/**
 * Korean-friendly sentence splitter.
 *
 * Primary:  newline boundary.
 * Secondary: punctuation followed by uppercase Latin or Hangul start.
 * Exceptions: version strings (1.2.3), filenames (foo.ts), ellipsis (...).
 */
const SENTENCE_BOUNDARY =
  /(?<=[.!?。！？])\s+(?=[A-Z가-힣])/;

/** Patterns that look like sentence ends but are not. */
const FALSE_BOUNDARY_PATTERNS: readonly RegExp[] = [
  /\d\.\d/,       // version: 1.2.3
  /\.\w{1,5}$/,   // filename: file.ts  (checks the part before boundary)
  /\.{3}/,        // ellipsis: ...
];

function splitSentences(text: string): string[] {
  // Primary: split on newlines first
  const lines = text.split("\n");
  const sentences: string[] = [];

  for (const line of lines) {
    if (line.length === 0) {
      sentences.push("");
      continue;
    }

    // Secondary: split on sentence boundary regex
    let remaining = line;
    let match = SENTENCE_BOUNDARY.exec(remaining);

    while (match !== null) {
      const idx = match.index;
      const before = remaining.slice(0, idx);

      // Check for false boundaries
      const isFalse = FALSE_BOUNDARY_PATTERNS.some((p) => p.test(before));
      if (isFalse) {
        // Skip this boundary, keep searching after it
        const skip = idx + match[0].length;
        const rest = remaining.slice(skip);
        match = SENTENCE_BOUNDARY.exec(rest);
        if (match !== null) {
          match = {
            ...match,
            index: match.index + skip,
          } as RegExpExecArray;
        }
        continue;
      }

      sentences.push(remaining.slice(0, idx + 1).trim());
      remaining = remaining.slice(idx + match[0].length);
      match = SENTENCE_BOUNDARY.exec(remaining);
    }

    if (remaining.length > 0) {
      sentences.push(remaining.trim());
    }
  }

  return sentences.filter((s) => s.length > 0);
}

// ─── Timer Handle ───────────────────────────────────────────────────────────

/** All timers must be tracked for cancellation on reset/flush. */
type TimerHandle = ReturnType<typeof setTimeout>;

// ─── PacingStrategy ─────────────────────────────────────────────────────────

export class PacingStrategy {
  private config: MutablePacingConfig;
  private readonly onOutput: (output: PacingOutput) => void;

  // ── Per-mode buffers ────────────────────────────────────────────────────

  private sentenceBuffer = "";
  private sentenceIndex = 0;
  private sentenceTimer: TimerHandle | null = null;

  private proseBuffer = "";
  private proseFirstDeltaTime = 0;
  private proseDeadlineTimer: TimerHandle | null = null;
  private proseIdleTimer: TimerHandle | null = null;
  private proseMaxTimer: TimerHandle | null = null;

  private blockBuffer = "";
  private blockLineCount = 0;
  private blockType: ContentType | null = null;
  private blockTimer: TimerHandle | null = null;

  private lineQueue: string[] = [];
  private lineTimer: TimerHandle | null = null;
  private lineIndex = 0;

  // ── Delta tracking (idle timeout) ───────────────────────────────────────

  private lastDeltaTime = 0;

  // ── Previous content type (transition detection) ────────────────────────

  private prevType: ContentType | null = null;

  constructor(config: PacingConfig, onOutput: (output: PacingOutput) => void) {
    // Deep-copy config so runtime updates don't mutate the original const.
    this.config = JSON.parse(JSON.stringify(config)) as MutablePacingConfig;
    this.onOutput = onOutput;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Route a classified line to the appropriate pacing strategy.
   *
   * @param blockComplete — external signal from the classifier that the
   *   current block (code_block, diff, table) has ended.  Only relevant
   *   for `block_buffer` mode.
   */
  route(item: ClassifiedLine, blockComplete = false): void {
    const newType = item.type;
    const prevType = this.prevType;

    if (prevType !== null && prevType !== newType) {
      this.handleTransition(prevType, newType);
    }

    this.prevType = newType;
    this.checkMemoryCap();

    const mode = CONTENT_TO_PACING[newType];
    switch (mode) {
      case "immediate":
        this.emitImmediate(item.content);
        break;
      case "sentence_stream":
        this.feedSentenceStream(item.content);
        break;
      case "collect_flush":
        this.feedCollectFlush(item.content);
        break;
      case "block_buffer":
        this.feedBlockBuffer(item.content, newType, blockComplete);
        break;
      case "line_stream":
        this.feedLineStream(item.content);
        break;
    }
  }

  /** Flush the previous type's buffer when content type changes. */
  handleTransition(prevType: ContentType, newType: ContentType): void {
    const prevMode = CONTENT_TO_PACING[prevType];
    switch (prevMode) {
      case "sentence_stream":
        this.flushSentenceBuffer();
        break;
      case "collect_flush":
        this.flushProseBuffer();
        break;
      case "block_buffer":
        this.flushBlockBuffer();
        break;
      case "line_stream":
        this.flushLineQueue();
        break;
      // immediate: nothing to flush
    }
    void newType; // consumed by caller
  }

  /** Force flush all strategy buffers. */
  flushAll(): void {
    this.flushSentenceBuffer();
    this.flushProseBuffer();
    this.flushBlockBuffer();
    this.flushLineQueue();
  }

  /** Reset all state and cancel all timers. */
  reset(): void {
    this.clearTimer("sentenceTimer");
    this.clearTimer("proseDeadlineTimer");
    this.clearTimer("proseIdleTimer");
    this.clearTimer("proseMaxTimer");
    this.clearTimer("blockTimer");
    this.clearTimer("lineTimer");

    this.sentenceBuffer = "";
    this.sentenceIndex = 0;

    this.proseBuffer = "";
    this.proseFirstDeltaTime = 0;

    this.blockBuffer = "";
    this.blockLineCount = 0;
    this.blockType = null;

    this.lineQueue = [];
    this.lineIndex = 0;

    this.lastDeltaTime = 0;
    this.prevType = null;
  }

  /** Notify of delta activity — resets idle timers. */
  notifyDelta(): void {
    this.lastDeltaTime = Date.now();
  }

  /**
   * Update pacing config at runtime.
   *
   * Called when Decision Engine events (agent:interaction_mode,
   * agent:decision) change the desired pacing behavior.  Only the
   * provided fields are merged — omitted fields keep their current
   * values.
   */
  updateConfig(overrides: {
    prose?: Partial<MutablePacingConfig["prose"]>;
    narration?: Partial<MutablePacingConfig["narration"]>;
    codeBlock?: Partial<MutablePacingConfig["codeBlock"]>;
    list?: Partial<MutablePacingConfig["list"]>;
  }): void {
    if (overrides.prose) {
      Object.assign(this.config.prose, overrides.prose);
    }
    if (overrides.narration) {
      Object.assign(this.config.narration, overrides.narration);
    }
    if (overrides.codeBlock) {
      Object.assign(this.config.codeBlock, overrides.codeBlock);
    }
    if (overrides.list) {
      Object.assign(this.config.list, overrides.list);
    }
  }

  // ── Mode 1: immediate ──────────────────────────────────────────────────

  private emitImmediate(content: string): void {
    this.onOutput({
      content,
      pacingMode: "immediate",
      scheduledDelay: 0,
      useSyncOutput: false,
      priority: 2,
    });
  }

  // ── Mode 2: sentence_stream ────────────────────────────────────────────

  private feedSentenceStream(text: string): void {
    this.sentenceBuffer += text + "\n";

    const sentences = splitSentences(this.sentenceBuffer);

    if (sentences.length > 1) {
      // We have at least one complete sentence — emit all but the last
      // (last may be incomplete).
      for (let i = 0; i < sentences.length - 1; i++) {
        const delay =
          this.sentenceIndex === 0
            ? this.config.narration.firstSentenceDelay
            : this.config.narration.delayPerSentence * this.sentenceIndex;

        this.onOutput({
          content: sentences[i],
          pacingMode: "sentence_stream",
          scheduledDelay: delay,
          useSyncOutput: false,
          priority: 2,
        });
        this.sentenceIndex++;
      }
      // Keep the last (possibly incomplete) fragment
      this.sentenceBuffer = sentences[sentences.length - 1];
    }

    // Start maxBuffer timer if not already running
    this.restartSentenceMaxTimer();
  }

  private restartSentenceMaxTimer(): void {
    this.clearTimer("sentenceTimer");
    this.sentenceTimer = setTimeout(() => {
      this.sentenceTimer = null;
      if (this.sentenceBuffer.length > 0) {
        this.flushSentenceBuffer();
      }
    }, this.config.narration.maxBuffer);
  }

  private flushSentenceBuffer(): void {
    this.clearTimer("sentenceTimer");

    if (this.sentenceBuffer.length === 0) return;

    const delay =
      this.sentenceIndex === 0
        ? this.config.narration.firstSentenceDelay
        : this.config.narration.delayPerSentence * this.sentenceIndex;

    this.onOutput({
      content: this.sentenceBuffer,
      pacingMode: "sentence_stream",
      scheduledDelay: delay,
      useSyncOutput: false,
      priority: 2,
    });

    this.sentenceBuffer = "";
    this.sentenceIndex = 0;
  }

  // ── Mode 3: collect_flush ──────────────────────────────────────────────

  private feedCollectFlush(text: string): void {
    const now = Date.now();

    if (this.proseBuffer.length === 0) {
      this.proseFirstDeltaTime = now;
      this.startProseDeadlineTimer();
      this.startProseMaxTimer();
    }

    this.proseBuffer += text + "\n";

    // Restart idle timer on every new content
    this.restartProseIdleTimer();

    // Check paragraph flush threshold
    this.checkParagraphFlush();
  }

  private startProseDeadlineTimer(): void {
    this.clearTimer("proseDeadlineTimer");
    this.proseDeadlineTimer = setTimeout(() => {
      this.proseDeadlineTimer = null;
      // Partial flush if buffer is non-empty and no other output yet
      if (this.proseBuffer.length > 0) {
        this.flushProseBuffer();
      }
    }, this.config.prose.firstVisibleDeadline);
  }

  private restartProseIdleTimer(): void {
    this.clearTimer("proseIdleTimer");
    this.proseIdleTimer = setTimeout(() => {
      this.proseIdleTimer = null;
      if (this.proseBuffer.length > 0) {
        this.flushProseBuffer();
      }
    }, this.config.prose.idleTimeout);
  }

  private startProseMaxTimer(): void {
    this.clearTimer("proseMaxTimer");
    this.proseMaxTimer = setTimeout(() => {
      this.proseMaxTimer = null;
      if (this.proseBuffer.length > 0) {
        this.flushProseBuffer();
      }
    }, this.config.prose.maxCollectTime);
  }

  /**
   * Flush completed paragraphs when the threshold is reached.
   * Paragraphs are separated by double newlines.
   */
  private checkParagraphFlush(): void {
    const paragraphs = this.proseBuffer.split(/\n\n/);
    if (paragraphs.length > this.config.prose.paragraphFlushThreshold) {
      // Flush all completed paragraphs, keep the last (may be incomplete)
      const toFlush = paragraphs.slice(0, -1).join("\n\n");
      this.proseBuffer = paragraphs[paragraphs.length - 1];

      this.onOutput({
        content: toFlush,
        pacingMode: "collect_flush",
        scheduledDelay: 0,
        useSyncOutput: true,
        priority: 3,
      });
    }
  }

  private flushProseBuffer(): void {
    this.clearTimer("proseDeadlineTimer");
    this.clearTimer("proseIdleTimer");
    this.clearTimer("proseMaxTimer");

    if (this.proseBuffer.length === 0) return;

    this.onOutput({
      content: this.proseBuffer,
      pacingMode: "collect_flush",
      scheduledDelay: 0,
      useSyncOutput: true,
      priority: 3,
    });

    this.proseBuffer = "";
    this.proseFirstDeltaTime = 0;
  }

  // ── Mode 4: block_buffer ───────────────────────────────────────────────

  private feedBlockBuffer(
    text: string,
    contentType: ContentType,
    blockComplete: boolean,
  ): void {
    if (this.blockType === null) {
      this.blockType = contentType;
      this.startBlockTimer(contentType);
    }

    this.blockBuffer += text + "\n";
    this.blockLineCount++;

    // Check line limit
    const maxLines = this.getBlockMaxLines(contentType);
    if (this.blockLineCount >= maxLines) {
      this.flushBlockBuffer();
      return;
    }

    // Block completion signal from classifier
    if (blockComplete) {
      this.flushBlockBuffer();
    }
  }

  private getBlockMaxLines(contentType: ContentType): number {
    switch (contentType) {
      case "code_block":
        return this.config.codeBlock.maxBufferLines;
      case "diff":
        return this.config.diff.maxBufferLines;
      case "table":
        return this.config.table.maxBufferLines;
      default:
        return this.config.codeBlock.maxBufferLines;
    }
  }

  private getBlockMaxTime(contentType: ContentType): number {
    switch (contentType) {
      case "code_block":
        return this.config.codeBlock.maxBufferTime;
      case "diff":
        return this.config.diff.maxBufferTime;
      case "table":
        return this.config.table.maxBufferTime;
      default:
        return this.config.codeBlock.maxBufferTime;
    }
  }

  private startBlockTimer(contentType: ContentType): void {
    this.clearTimer("blockTimer");
    const maxTime = this.getBlockMaxTime(contentType);
    this.blockTimer = setTimeout(() => {
      this.blockTimer = null;
      if (this.blockBuffer.length > 0) {
        this.flushBlockBuffer();
      }
    }, maxTime);
  }

  private flushBlockBuffer(): void {
    this.clearTimer("blockTimer");

    if (this.blockBuffer.length === 0) return;

    this.onOutput({
      content: this.blockBuffer,
      pacingMode: "block_buffer",
      scheduledDelay: 0,
      useSyncOutput: true,
      priority: 2,
    });

    this.blockBuffer = "";
    this.blockLineCount = 0;
    this.blockType = null;
  }

  // ── Mode 5: line_stream ────────────────────────────────────────────────

  private feedLineStream(text: string): void {
    this.lineQueue.push(text);

    // If no drain timer is running, start one
    if (this.lineTimer === null) {
      this.drainLineQueue();
    }
  }

  private drainLineQueue(): void {
    if (this.lineQueue.length === 0) {
      this.lineTimer = null;
      this.lineIndex = 0;
      return;
    }

    const line = this.lineQueue.shift()!;
    const delay = this.config.list.delayPerLine * this.lineIndex;

    this.onOutput({
      content: line,
      pacingMode: "line_stream",
      scheduledDelay: delay,
      useSyncOutput: false,
      priority: 2,
    });

    this.lineIndex++;

    this.lineTimer = setTimeout(() => {
      this.drainLineQueue();
    }, this.config.list.delayPerLine);
  }

  private flushLineQueue(): void {
    this.clearTimer("lineTimer");

    // Emit all remaining lines immediately
    for (const line of this.lineQueue) {
      this.onOutput({
        content: line,
        pacingMode: "line_stream",
        scheduledDelay: 0,
        useSyncOutput: false,
        priority: 2,
      });
    }

    this.lineQueue = [];
    this.lineIndex = 0;
  }

  // ── Memory Cap ─────────────────────────────────────────────────────────

  private checkMemoryCap(): void {
    const mem = this.config.memory;
    let needsFlush = false;

    if (this.proseBuffer.length > mem.maxProseBuffer) needsFlush = true;
    if (
      this.blockType === "code_block" &&
      this.blockBuffer.length > mem.maxCodeBuffer
    )
      needsFlush = true;
    if (
      this.blockType === "diff" &&
      this.blockBuffer.length > mem.maxDiffBuffer
    )
      needsFlush = true;
    if (
      this.blockType === "table" &&
      this.blockBuffer.length > mem.maxTableBuffer
    )
      needsFlush = true;

    const totalBuffer =
      this.sentenceBuffer.length +
      this.proseBuffer.length +
      this.blockBuffer.length +
      this.lineQueue.reduce((sum, l) => sum + l.length, 0);

    if (totalBuffer > mem.maxTotalBuffer) needsFlush = true;

    if (needsFlush) {
      this.flushAll();
    }
  }

  // ── Timer Utility ─────────────────────────────────────────────────────

  private clearTimer(
    field:
      | "sentenceTimer"
      | "proseDeadlineTimer"
      | "proseIdleTimer"
      | "proseMaxTimer"
      | "blockTimer"
      | "lineTimer",
  ): void {
    const handle = this[field];
    if (handle !== null) {
      clearTimeout(handle);
      this[field] = null;
    }
  }
}
