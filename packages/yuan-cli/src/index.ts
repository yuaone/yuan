/**
 * YUAN CLI — Public API Exports
 *
 * Re-exports all modules for programmatic use.
 */

export { ConfigManager, type YuanConfig, type Provider } from "./config.js";
export { TerminalRenderer, Spinner, colors } from "./renderer.js";
export {
  DiffRenderer,
  type UnifiedDiff,
  type DiffHunk,
  type DiffLine,
  type DiffDecision,
} from "./diff-renderer.js";
export {
  SessionManager,
  type SessionData,
  type SessionMessage,
} from "./session.js";
export { InteractiveSession } from "./interactive.js";
export { runOneshot } from "./oneshot.js";
export {
  login,
  logout,
  getAuth,
  verifyAuth,
  type AuthData,
  type AuthUser,
  type AuthPlan,
} from "./auth.js";
export { YSpinner } from "./y-spinner.js";
export { DesignRenderer } from "./design-renderer.js";
export {
  ProgressRenderer,
  renderBar,
  type ProgressRendererConfig,
  type AgentPhase,
  type StatusEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type ApprovalEvent,
  type DoneResult,
} from "./progress-renderer.js";
