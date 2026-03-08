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
