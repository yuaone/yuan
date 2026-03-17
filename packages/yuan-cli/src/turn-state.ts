/**
 * Turn Lifecycle State Machine for YUAN CLI.
 *
 * Replaces ad-hoc booleans (streamingText, compactMode, locked)
 * with a single deterministic state machine that enforces
 * valid phase transitions and notifies listeners.
 */

export type TurnPhase =
  | "idle"
  | "submitting"
  | "thinking"
  | "tool_running"
  | "streaming"
  | "approval"
  | "queued"
  | "completed"
  | "interrupted"
  | "failed";

const VALID_TRANSITIONS: Record<TurnPhase, TurnPhase[]> = {
  idle: ["submitting"],
  submitting: ["thinking", "failed"],
  thinking: [
    "tool_running",
    "streaming",
    "completed",
    "interrupted",
    "failed",
    "approval",
  ],
  tool_running: [
    "thinking",
    "streaming",
    "completed",
    "interrupted",
    "failed",
    "approval",
  ],
  streaming: ["tool_running", "thinking", "completed", "interrupted", "failed"],
  approval: ["tool_running", "thinking", "streaming", "interrupted"],
  queued: ["submitting"],
  completed: ["idle", "queued"],
  interrupted: ["idle", "queued"],
  failed: ["idle", "queued"],
};

/** Phases where the agent is NOT actively running. */
const TERMINAL_PHASES: ReadonlySet<TurnPhase> = new Set([
  "idle",
  "completed",
  "interrupted",
  "failed",
  "queued",
]);

/**
 * Phases where the user can type input.
 * - idle: normal input
 * - queued: user typed while agent was busy — message waits in queue
 * - streaming / thinking / tool_running: queue-mode input accepted
 */
const INPUT_PHASES: ReadonlySet<TurnPhase> = new Set([
  "idle",
  "queued",
  "streaming",
  "thinking",
  "tool_running",
]);

export class TurnState {
  private _phase: TurnPhase = "idle";
  private _listeners: Array<(from: TurnPhase, to: TurnPhase) => void> = [];

  get phase(): TurnPhase {
    return this._phase;
  }

  /** Attempt state transition. Invalid transitions are silently ignored. */
  transition(to: TurnPhase): boolean {
    const valid = VALID_TRANSITIONS[this._phase];
    if (!valid.includes(to)) {
      return false;
    }

    const from = this._phase;
    this._phase = to;

    for (const listener of this._listeners) {
      listener(from, to);
    }

    return true;
  }

  /** Whether the agent is currently running (not idle/completed/interrupted/failed/queued) */
  get isRunning(): boolean {
    return !TERMINAL_PHASES.has(this._phase);
  }

  /** Whether the user can type input */
  get canAcceptInput(): boolean {
    return INPUT_PHASES.has(this._phase);
  }

  /** Register a listener for state changes */
  onChange(listener: (from: TurnPhase, to: TurnPhase) => void): void {
    this._listeners.push(listener);
  }

  /** Reset to idle */
  reset(): void {
    const from = this._phase;
    if (from === "idle") return;

    this._phase = "idle";

    for (const listener of this._listeners) {
      listener(from, "idle");
    }
  }
}
