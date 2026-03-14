/**
 * @module autonomous
 * @description Phase 3 Autonomous Engineering Loop — exports all 5 components.
 */

export { TaskMemory } from "./task-memory.js";
export type {
  TaskState,
  TaskStatus as AutonomousTaskStatus,
  TaskPhase as TaskMemoryPhase,
  EvidenceEntry,
} from "./task-memory.js";

export { ResearchAgent } from "./research-agent.js";
export type { ResearchResult, ResearchSource, ResearchAgentConfig } from "./research-agent.js";

export { ExplicitPlanningEngine } from "./explicit-planner.js";
export type {
  ExplicitPlan,
  AutonomousPlanStep,
  ExplicitPlannerConfig,
} from "./explicit-planner.js";

export { PatchTournamentExecutor } from "./patch-tournament.js";
export type {
  TournamentResult,
  CandidatePatch,
  RunAgentCallback,
  PatchTournamentConfig,
} from "./patch-tournament.js";

export { IncidentDebugger } from "./incident-debugger.js";
export type { DebugReport, DebugEvidence, IncidentDebuggerConfig } from "./incident-debugger.js";
