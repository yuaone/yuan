/**
 * @module stall-detector
 * @description Detects when an agent task has stalled, based on iteration patterns.
 *
 * Stall types:
 * 1. iteration_overrun: actual iterations > estimated * 2.5
 * 2. repeated_errors: same error signature 3+ times in last 5 iterations
 * 3. no_progress: 5+ consecutive iterations with 0 files changed
 * 4. patch_entropy: same lines modified repeatedly (agent thrashing)
 *
 * Design: purely stateful observer — does NOT affect the main loop.
 * Call check() each iteration. It returns a StallReason or null.
 */

export type StallReason =
  | "iteration_overrun"
  | "repeated_errors"
  | "no_progress"
  | "patch_entropy";

export interface StallCheckResult {
  stalled: boolean;
  reason: StallReason | null;
  detail: string;
  iterationsElapsed: number;
}

export interface StallDetectorConfig {
  /** default 2.5 */
  overrunMultiplier?: number;
  /** default 5 iterations */
  repeatedErrorWindow?: number;
  /** default 3 */
  repeatedErrorThreshold?: number;
  /** default 5 iterations */
  noProgressWindow?: number;
  /** default 4 iterations */
  patchEntropyWindow?: number;
  /** default 3 (same file+lines modified 3+ times) */
  patchEntropyThreshold?: number;
}

interface IterationRecord {
  changedFiles: string[];
  errorSig?: string;
  editedLines?: Map<string, Set<number>>;
}

export class StallDetector {
  private estimatedIterations: number;
  private overrunMultiplier: number;
  private repeatedErrorWindow: number;
  private repeatedErrorThreshold: number;
  private noProgressWindow: number;
  private patchEntropyWindow: number;
  private patchEntropyThreshold: number;

  private history: IterationRecord[] = [];

  constructor(estimatedIterations: number, config?: StallDetectorConfig) {
    this.estimatedIterations = estimatedIterations;
    this.overrunMultiplier = config?.overrunMultiplier ?? 2.5;
    this.repeatedErrorWindow = config?.repeatedErrorWindow ?? 5;
    this.repeatedErrorThreshold = config?.repeatedErrorThreshold ?? 3;
    this.noProgressWindow = config?.noProgressWindow ?? 5;
    this.patchEntropyWindow = config?.patchEntropyWindow ?? 4;
    this.patchEntropyThreshold = config?.patchEntropyThreshold ?? 3;
  }

  /**
   * Check for stall at current iteration.
   * @param iteration current 0-based iteration index
   * @param changedFiles files changed this iteration
   * @param errorSignature current repeated error signature (or undefined)
   * @param editedLines optional: Map<filePath, Set<lineNumber>> for patch entropy detection
   */
  check(
    iteration: number,
    changedFiles: string[],
    errorSignature: string | undefined,
    editedLines?: Map<string, Set<number>>
  ): StallCheckResult {
    // Push current iteration record, keep only what we need
    this.history.push({ changedFiles, errorSig: errorSignature, editedLines });
    const maxWindow = Math.max(
      this.repeatedErrorWindow,
      this.noProgressWindow,
      this.patchEntropyWindow
    );
    if (this.history.length > maxWindow) {
      this.history = this.history.slice(this.history.length - maxWindow);
    }

    // 1. iteration_overrun
    const limit = this.estimatedIterations * this.overrunMultiplier;
    if (iteration > limit) {
      return {
        stalled: true,
        reason: "iteration_overrun",
        detail: `Iteration ${iteration} exceeds estimated ${this.estimatedIterations} × ${this.overrunMultiplier} = ${limit}`,
        iterationsElapsed: iteration,
      };
    }

    // 2. repeated_errors
    const errorWindow = this.history.slice(-this.repeatedErrorWindow);
    if (errorSignature !== undefined) {
      const errorCount = errorWindow.filter(
        (r) => r.errorSig !== undefined && r.errorSig === errorSignature
      ).length;
      if (errorCount >= this.repeatedErrorThreshold) {
        return {
          stalled: true,
          reason: "repeated_errors",
          detail: `Error signature "${errorSignature}" appeared ${errorCount} times in last ${this.repeatedErrorWindow} iterations`,
          iterationsElapsed: iteration,
        };
      }
    }

    // 3. no_progress
    const progressWindow = this.history.slice(-this.noProgressWindow);
    if (
      progressWindow.length >= this.noProgressWindow &&
      progressWindow.every((r) => r.changedFiles.length === 0)
    ) {
      return {
        stalled: true,
        reason: "no_progress",
        detail: `No files changed in last ${this.noProgressWindow} consecutive iterations`,
        iterationsElapsed: iteration,
      };
    }

    // 4. patch_entropy
    const entropyWindow = this.history.slice(-this.patchEntropyWindow);
    if (entropyWindow.length >= this.patchEntropyWindow) {
      // Count how many times each file appeared in the window
      const fileEditCount = new Map<string, number>();
      for (const record of entropyWindow) {
        for (const f of record.changedFiles) {
          fileEditCount.set(f, (fileEditCount.get(f) ?? 0) + 1);
        }
      }

      for (const [file, count] of fileEditCount) {
        if (count >= this.patchEntropyThreshold) {
          // Check for overlapping line numbers if editedLines data is available
          const recordsWithLines = entropyWindow.filter(
            (r) => r.editedLines !== undefined && r.editedLines.has(file)
          );

          if (recordsWithLines.length >= 2) {
            // Find overlapping line numbers across successive edits
            let hasOverlap = false;
            for (let i = 0; i < recordsWithLines.length - 1; i++) {
              const linesA = recordsWithLines[i].editedLines!.get(file)!;
              const linesB = recordsWithLines[i + 1].editedLines!.get(file)!;
              for (const line of linesA) {
                if (linesB.has(line)) {
                  hasOverlap = true;
                  break;
                }
              }
              if (hasOverlap) break;
            }
            if (hasOverlap) {
              return {
                stalled: true,
                reason: "patch_entropy",
                detail: `File "${file}" edited ${count} times in last ${this.patchEntropyWindow} iterations with overlapping line numbers (agent thrashing)`,
                iterationsElapsed: iteration,
              };
            }
          } else {
            // No line info: stall purely on edit frequency
            return {
              stalled: true,
              reason: "patch_entropy",
              detail: `File "${file}" edited ${count} times in last ${this.patchEntropyWindow} iterations (no line data; frequency threshold exceeded)`,
              iterationsElapsed: iteration,
            };
          }
        }
      }
    }

    return {
      stalled: false,
      reason: null,
      detail: "",
      iterationsElapsed: iteration,
    };
  }

  /** Reset state (call when task changes or goal changes) */
  reset(): void {
    this.history = [];
  }
}
