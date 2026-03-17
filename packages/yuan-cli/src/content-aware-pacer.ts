/**
 * content-aware-pacer.ts — Main orchestrator for the YUAN CLI Content-Aware Pacer.
 *
 * Ties together IncrementalClassifier, PacingStrategy, OutputQueue, and
 * WriteGate into a single pipeline.  All streaming text_delta events flow
 * through ingest(), and tool/lifecycle events update the pipeline state.
 *
 * Pipeline:
 *   text_delta → sanitize CRLF → classifier.ingest() → for each classified
 *   line → strategy.route() → strategy calls onOutput → queue.enqueue()
 *   → queue flushes → writeGate.write()
 *
 * Fallback: if classifier or strategy throws, the pacer switches to
 * fallbackMode and writes deltas directly through the WriteGate.
 */

import {
  IncrementalClassifier,
  type ClassifiedLine,
} from "./incremental-classifier.js";
import {
  PacingStrategy,
  PACING_CONFIG,
  type PacingOutput,
} from "./pacing-strategy.js";
import { OutputQueue } from "./output-queue.js";
import { WriteGate } from "./write-gate.js";
import { SummaryBuilder, type StructuredSummary } from "./summary-builder.js";
import { PacerMetrics, type PacerMetricsData } from "./pacer-metrics.js";

// ─── Idempotency Key Counter ────────────────────────────────────────────────

let idempotencySeq = 0;

function nextIdempotencyKey(): string {
  return `pacer-${++idempotencySeq}`;
}

// ─── ContentAwarePacer ──────────────────────────────────────────────────────

export class ContentAwarePacer {
  private readonly classifier: IncrementalClassifier;
  private readonly strategy: PacingStrategy;
  private readonly queue: OutputQueue;
  private readonly writeGate: WriteGate;
  private readonly summaryBuilder: SummaryBuilder;
  private readonly metrics: PacerMetrics;

  private fallbackMode = false;
  private turnStartTime = 0;
  private firstOutputEmitted = false;

  constructor(writeGate: WriteGate) {
    this.writeGate = writeGate;
    this.classifier = new IncrementalClassifier();
    this.metrics = new PacerMetrics();
    this.summaryBuilder = new SummaryBuilder();

    // OutputQueue writes through the WriteGate
    this.queue = new OutputQueue((content: string, useSyncOutput: boolean) => {
      this.writeGate.write(content, useSyncOutput);

      if (!this.firstOutputEmitted && this.turnStartTime > 0) {
        this.firstOutputEmitted = true;
        this.metrics.recordFirstVisibleOutput(this.turnStartTime);
      }
    });

    // PacingStrategy emits PacingOutput → enqueue into OutputQueue
    this.strategy = new PacingStrategy(PACING_CONFIG, (output: PacingOutput) => {
      this.enqueueOutput(output);
    });
  }

  // ── Main Entry ──────────────────────────────────────────────────────────

  /**
   * Ingest a raw text_delta from the stream.  The delta is classified
   * line-by-line and routed through the pacing strategy into the output queue.
   *
   * If the classifier or strategy throws, the pacer switches to fallback
   * mode and writes directly through the WriteGate for the rest of the turn.
   */
  ingest(text: string): void {
    if (this.fallbackMode) {
      this.writeGate.write(text);
      return;
    }

    try {
      // Sanitize CRLF (classifier also normalizes, but belt-and-suspenders)
      const sanitized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

      const classified: ClassifiedLine[] = this.classifier.ingest(sanitized);

      for (const line of classified) {
        this.metrics.recordClassification(line.type);

        // Detect block completion: classifier transitions back to DEFAULT
        // after closing a code fence / exiting diff mode.
        const blockComplete = false; // strategy handles this via transitions

        this.strategy.route(line, blockComplete);
      }

      // Notify strategy of delta activity for idle timeout tracking
      this.strategy.notifyDelta();
    } catch (err) {
      this.activateFallback(err);
      // Write the original text directly
      this.writeGate.write(text);
    }
  }

  // ── Event Context Updates ───────────────────────────────────────────────

  /**
   * Called when a tool call starts.  Flushes all buffered output first
   * (tool calls are visual anchors), then updates the classifier context.
   */
  onToolCall(tool: string): void {
    this.flushAll("tool_call");

    this.classifier.setEventContext({
      recentToolCall: true,
      betweenTools: false,
    });

    void tool; // consumed for context; tool name not needed for classification
  }

  /**
   * Called when a tool call completes.  Updates the classifier context and
   * tracks the result for summary building.
   */
  onToolResult(
    tool: string,
    args: unknown,
    output: string,
    success: boolean,
    durationMs: number,
  ): void {
    this.classifier.setEventContext({
      recentToolCall: false,
      betweenTools: true,
    });

    this.summaryBuilder.trackToolResult(tool, args, output, success);

    void durationMs; // available for future latency tracking
  }

  /**
   * Called when the assistant turn completes.  Flushes all buffers, builds
   * a structured summary, and writes it through the WriteGate.
   */
  onCompleted(event: {
    summary: string;
    filesChanged: string[];
    tokenUsage: { input: number; output: number };
    duration: number;
  }): void {
    // Flush any remaining incomplete line from the classifier
    this.flushIncomplete();

    // Flush all strategy buffers and queue entries
    this.flushAll("completed");

    // Build and render structured summary
    const summary: StructuredSummary = this.summaryBuilder.build(event);
    const rendered = this.summaryBuilder.render(summary);

    this.writeGate.write(rendered, true);

    // Write metrics to log
    this.metrics.writeToLog();
  }

  /**
   * Called on stream error.  Flushes all buffers and writes the error.
   */
  onError(message: string): void {
    this.flushAll("error");
    this.writeGate.write(message);
  }

  /**
   * Called when a QA/test result is available.
   */
  onQaResult(stage: string, passed: boolean, issues: string[]): void {
    this.summaryBuilder.trackQaResult(stage, passed, issues);
  }

  // ── Turn Lifecycle ──────────────────────────────────────────────────────

  /**
   * Reset all state for a new assistant turn.
   */
  startTurn(): void {
    this.classifier.reset();
    this.strategy.reset();
    this.queue.clear();
    this.summaryBuilder.reset();
    this.metrics.reset();

    this.fallbackMode = false;
    this.turnStartTime = Date.now();
    this.firstOutputEmitted = false;

    idempotencySeq = 0;
  }

  /**
   * Force flush all buffers.  Used at turn boundaries, before tool calls,
   * and on error.  The cause is recorded in metrics.
   */
  flushAll(cause = "explicit"): void {
    this.metrics.recordFlushAll(cause);

    // Flush incomplete classifier buffer
    this.flushIncomplete();

    // Flush all strategy buffers (sentence, prose, block, line)
    if (!this.fallbackMode) {
      try {
        this.strategy.flushAll();
      } catch (err) {
        this.activateFallback(err);
      }
    }

    // Flush all queue entries regardless of scheduled time
    this.queue.flushAll();
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  /**
   * Dispose all resources.  Safe to call multiple times.
   */
  dispose(): void {
    this.strategy.reset(); // cancels all timers
    this.queue.clear();
  }

  // ── Metrics ─────────────────────────────────────────────────────────────

  getMetrics(): PacerMetricsData {
    return this.metrics.getData();
  }

  // ── Private ─────────────────────────────────────────────────────────────

  /**
   * Enqueue a PacingOutput into the OutputQueue with proper scheduling.
   */
  private enqueueOutput(output: PacingOutput): void {
    const now = Date.now();
    const scheduledAt = now + output.scheduledDelay;

    this.queue.enqueue({
      idempotencyKey: nextIdempotencyKey(),
      contentType: output.pacingMode,
      pacingMode: output.pacingMode,
      content: output.content + "\n",
      scheduledAt,
      priority: output.priority,
    });

    // Record block size for metrics
    this.metrics.recordBlockSize(output.pacingMode, output.content.length);
  }

  /**
   * Flush any incomplete line buffered in the classifier.
   */
  private flushIncomplete(): void {
    if (this.fallbackMode) return;

    try {
      const remaining = this.classifier.flushIncomplete();
      if (remaining) {
        this.metrics.recordClassification(remaining.type);
        this.strategy.route(remaining);
      }
    } catch (err) {
      this.activateFallback(err);
    }
  }

  /**
   * Switch to fallback mode — bypass classifier/strategy and write
   * directly through WriteGate.  This is a one-way switch per turn;
   * startTurn() resets it.
   */
  private activateFallback(_err: unknown): void {
    if (this.fallbackMode) return;

    this.fallbackMode = true;
    this.metrics.recordFallbackActivation();

    // Attempt to flush whatever is buffered in strategy/queue
    try {
      this.strategy.flushAll();
    } catch {
      // Strategy is broken — ignore
    }

    try {
      this.queue.flushAll();
    } catch {
      // Queue is broken — ignore
    }
  }
}
