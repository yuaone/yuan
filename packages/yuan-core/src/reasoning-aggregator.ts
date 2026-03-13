/**
 * @module reasoning-aggregator
 * @description Streamed reasoning delta를 CLI 친화적인 문장 단위로 묶어준다.
 *
 * 목표:
 * - 1토큰/짧은 조각 단위 reasoning을 그대로 emit하지 않음
 * - 문장 경계 / 줄바꿈 / 길이 임계치 기준으로 flush
 * - 중복 reasoning 조각 반복 emit 방지
 */

export interface ReasoningChunkMeta {
  id?: string;
  provider?: string;
  model?: string;
  source?: "llm" | "agent";
}

export interface AggregatedReasoningChunk extends ReasoningChunkMeta {
  text: string;
}

export class ReasoningAggregator {
  private buffer = "";
  private lastEmitted = "";
  private pendingMeta: ReasoningChunkMeta = {};

  private static readonly SENTENCE_BREAK = /(?:[.!?。！？]+[\])}"'”’]*\s*|\n+)/u;
  private static readonly MAX_BUFFER_LENGTH = 240;
  private static readonly MAX_EMITTED_CACHE = 500;

  push(text: string, meta: ReasoningChunkMeta = {}): AggregatedReasoningChunk[] {
    const normalized = this.normalize(text);
    if (!normalized) return [];

    this.pendingMeta = {
      ...this.pendingMeta,
      ...meta,
    };

    this.buffer += normalized;
    return this.drainReadyChunks();
  }

  flush(): AggregatedReasoningChunk[] {
    const finalText = this.normalize(this.buffer);
    this.buffer = "";

    if (!finalText) return [];
    if (this.isDuplicate(finalText)) return [];

    this.lastEmitted = this.trimCache(finalText);
    return [
      {
        ...this.pendingMeta,
        text: finalText,
      },
    ];
  }

  reset(): void {
    this.buffer = "";
    this.lastEmitted = "";
    this.pendingMeta = {};
  }

  private drainReadyChunks(): AggregatedReasoningChunk[] {
    const chunks: AggregatedReasoningChunk[] = [];

    while (true) {
      const match = this.buffer.match(ReasoningAggregator.SENTENCE_BREAK);
      const shouldForceFlush =
        !match && this.buffer.length >= ReasoningAggregator.MAX_BUFFER_LENGTH;

      if (!match && !shouldForceFlush) break;

      const flushIndex = shouldForceFlush
        ? this.findSoftBreak(this.buffer, ReasoningAggregator.MAX_BUFFER_LENGTH)
        : (match!.index ?? 0) + match![0].length;

      const candidate = this.normalize(this.buffer.slice(0, flushIndex));
      this.buffer = this.buffer.slice(flushIndex);

      if (!candidate) continue;
      if (this.isDuplicate(candidate)) continue;

      this.lastEmitted = this.trimCache(candidate);
      chunks.push({
        ...this.pendingMeta,
        text: candidate,
      });
    }

    return chunks;
  }

  private normalize(text: string): string {
    return text
      .replace(/\r/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  private isDuplicate(text: string): boolean {
    if (!text) return true;
    if (text === this.lastEmitted) return true;
    if (text.length >= 24 && this.lastEmitted.endsWith(text)) return true;
    return false;
  }

  private trimCache(text: string): string {
    if (text.length <= ReasoningAggregator.MAX_EMITTED_CACHE) return text;
    return text.slice(-ReasoningAggregator.MAX_EMITTED_CACHE);
  }

  private findSoftBreak(text: string, maxLen: number): number {
    const slice = text.slice(0, maxLen);
    const lastSpace = slice.lastIndexOf(" ");
    if (lastSpace >= Math.floor(maxLen * 0.6)) {
      return lastSpace + 1;
    }
    return maxLen;
  }
}