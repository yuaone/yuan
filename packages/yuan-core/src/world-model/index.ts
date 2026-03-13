export { StateStore } from "./state-store.js";
export type {
  WorldState,
  FileState,
  BuildState,
  TestState,
  GitState,
  DepsState,
  // New delta-patch types
  FilePatch,
  StatePatch,
  PatchHistoryEntry,
  MemoryStats,
  // Backward-compat alias
  StateHistoryEntry,
} from "./state-store.js";
export { TransitionModel } from "./transition-model.js";
export type { StateDelta, StateTransition } from "./transition-model.js";
export { SimulationEngine } from "./simulation-engine.js";
export type { SimulationStep, SimulationResult } from "./simulation-engine.js";
export { StateUpdater } from "./state-updater.js";
