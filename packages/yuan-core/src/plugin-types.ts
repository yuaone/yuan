/**
 * Plugin System Types — YUAN Agent Plugin & Skill Framework
 *
 * Defines the complete type system for plugins, skills, strategies,
 * patterns, validators, and their runtime states.
 */

// ─── Trust & Categories ───

/** Trust levels for plugins — determines security policy */
export type PluginTrustLevel = "official" | "verified" | "community" | "local";

/** Plugin categories for organization and discovery */
export type PluginCategory =
  | "coding"
  | "devops"
  | "security"
  | "design"
  | "no-code"
  | "data"
  | "general";

/** Plugin type — determines security policy */
export type PluginType = "knowledge" | "tool" | "hybrid";

/** Sandbox mode for tool plugins */
export type PluginSandboxMode = "none" | "restricted" | "isolated";

/** How a plugin's triggers activate */
export type PluginTriggerMode = "auto" | "suggest" | "manual";

// ─── Plugin Manifest (plugin.yaml parsed) ───

/** Plugin manifest — the SSOT for a plugin's metadata and contents */
export interface PluginManifest {
  /** Unique plugin ID, e.g. "@yuaone/plugin-typescript" */
  id: string;
  /** Display name */
  name: string;
  /** Semver version string */
  version: string;
  /** Human-readable description */
  description: string;
  /** Author name or org */
  author: string;
  /** Plugin category */
  category: PluginCategory;
  /** Trust level */
  trustLevel: PluginTrustLevel;
  /** Plugin type — knowledge, tool, or hybrid */
  type: PluginType;
  /** Sandbox mode for tool execution */
  sandbox?: PluginSandboxMode;
  /** Default trigger mode */
  triggerMode?: PluginTriggerMode;
  /** Plugin API version (for compatibility checks) */
  pluginApiVersion?: number;
  /** Estimated prompt tokens when injected */
  estimatedPromptTokens?: number;
  /** Integrity checksum, e.g. "sha256:abc123..." */
  checksum?: string;

  /** Auto-detect configuration */
  detect?: PluginDetectConfig;

  /** Skill definitions */
  skills?: SkillDefinition[];
  /** Tool definitions */
  tools?: PluginToolDefinition[];
  /** Code pattern definitions */
  patterns?: PatternDefinition[];
  /** Strategy definitions */
  strategies?: StrategyDefinition[];
  /** Validator definitions */
  validators?: ValidatorDefinition[];
  /** Trigger definitions */
  triggers?: PluginTrigger[];

  /** Required permissions */
  permissions?: PluginPermissions;
  /** User-configurable settings */
  config?: Record<string, PluginConfigField>;

  /** Other plugin dependencies (id → semver range) */
  dependencies?: Record<string, string>;
  /** Minimum YUAN engine version */
  engineVersion?: string;
  /** License identifier */
  license?: string;
}

// ─── Auto-Detect ───

/** Configuration for automatic plugin detection */
export interface PluginDetectConfig {
  /** Files that must exist */
  files?: string[];
  /** Package dependencies to check */
  dependencies?: string[];
  /** Glob patterns for file existence */
  glob?: string[];
  /** Environment variables to check */
  env?: string[];
}

// ─── Skills ───

/** Skill definition within a plugin */
export interface SkillDefinition {
  /** Unique skill ID within the plugin */
  id: string;
  /** Display name */
  name: string;
  /** Human-readable description */
  description: string;
  /** How this skill gets triggered */
  trigger: SkillTrigger;
  /** Markdown template path (relative to plugin) or inline content */
  template: string;
  /** Whether this skill is enabled by default */
  enabled: boolean;
  /** Tags for search/matching */
  tags?: string[];
}

/** How a skill gets triggered */
export interface SkillTrigger {
  /** Trigger kind */
  kind: "file_pattern" | "command" | "auto" | "manual";
  /** Glob or regex pattern (for file_pattern / auto) */
  pattern?: string;
  /** Slash command name (for command kind) */
  command?: string;
  /** Auto-trigger confidence threshold (0–1) */
  confidence?: number;
  /** Required context items for activation */
  requires?: string[];
  /** Exclusion patterns */
  exclude?: string[];
  /** Minimum ms between triggers (debounce) */
  cooldown?: number;
}

// ─── Plugin Triggers ───

/** Plugin-level trigger — maps error/task patterns to skills and strategies */
export interface PluginTrigger {
  /** Regex pattern to match against errors/tasks */
  pattern: string;
  /** Trigger kind classification */
  kind?: "error" | "task" | "file" | "dependency";
  /** Skill to activate */
  skill: string;
  /** Strategy to apply (optional) */
  strategy?: string;
  /** Priority (higher = more preferred) */
  priority?: number;
  /** Required dependencies for this trigger */
  requires?: string[];
  /** Exclusion conditions */
  exclude?: string[];
  /** Cooldown in minutes */
  cooldown?: number;
  /** Max matches per session */
  maxMatches?: number;
  /** Trigger activation mode */
  triggerMode?: PluginTriggerMode;
}

// ─── Tools ───

/** Side effect level for tools — determines approval requirements */
export type ToolSideEffectLevel = "none" | "read" | "write" | "execute" | "destructive";

/** Tool provided by a plugin */
export interface PluginToolDefinition {
  /** Tool name (snake_case) */
  name: string;
  /** Human-readable description */
  description: string;
  /** JSON Schema for input parameters */
  inputSchema: Record<string, unknown>;
  /** Whether this tool requires user approval */
  requiresApproval?: boolean;
  /** Risk level classification */
  riskLevel?: "low" | "medium" | "high";
  /** Side effect level — determines approval policy */
  sideEffectLevel?: ToolSideEffectLevel;
}

// ─── Patterns ───

/** Code pattern for recognition and action */
export interface PatternDefinition {
  /** Unique pattern ID */
  id: string;
  /** Display name */
  name: string;
  /** Detection regex or AST query */
  detect: string;
  /** Action to take when detected */
  action: "suggest" | "auto-fix" | "warn";
  /** Fix template (if action is auto-fix or suggest) */
  template?: string;
}

// ─── Strategies ───

/** Strategy for agent behavior — a multi-step plan for solving a problem class */
export interface StrategyDefinition {
  /** Unique strategy ID */
  id: string;
  /** Display name */
  name: string;
  /** Human-readable description */
  description: string;
  /** Problem class this strategy addresses */
  problemClass?: string;
  /** Ordered execution phases */
  phases: StrategyPhase[];
  /** Criteria that must be met for success */
  exitCriteria?: string[];
  /** Fallback strategy ID if this one fails */
  fallback?: string;
  /** Estimated token cost */
  estimatedTokens?: number;
  /** Confidence level (0–1) */
  confidence?: number;
}

/** A phase within a strategy */
export interface StrategyPhase {
  /** Phase name */
  name: string;
  /** Tools allowed in this phase */
  tools: string[];
  /** Maximum iterations for this phase */
  maxIterations: number;
  /** Human-readable success criteria */
  successCriteria: string;
}

// ─── Validators ───

/** Validator for quality/safety checks */
export interface ValidatorDefinition {
  /** Unique validator ID */
  id: string;
  /** Validation stage */
  stage: "pre" | "post" | "quality" | "safety";
  /** Display name */
  name: string;
  /** Command or function reference to execute */
  check: string;
  /** Severity level */
  severity?: "warning" | "error" | "critical";
}

// ─── Permissions ───

/** Plugin permissions — what a plugin is allowed to do */
export interface PluginPermissions {
  /** Can read files */
  fileRead?: boolean;
  /** Can write/modify files */
  fileWrite?: boolean;
  /** Can execute shell commands */
  shellExec?: boolean;
  /** Can make network requests */
  networkAccess?: boolean;
  /** Can perform git operations */
  gitOps?: boolean;
  /** Maximum tokens per tool call */
  maxTokensPerCall?: number;
}

// ─── Config Fields ───

/** Plugin config field definition — for user-configurable settings */
export interface PluginConfigField {
  /** Value type */
  type: "string" | "number" | "boolean" | "select";
  /** Default value */
  default: unknown;
  /** Human-readable description */
  description: string;
  /** Options for select type */
  options?: string[];
}

// ─── Runtime State ───

/** Installed plugin state — tracks an installed plugin and its config */
export interface InstalledPlugin {
  /** The plugin manifest */
  manifest: PluginManifest;
  /** Whether the plugin is currently enabled */
  enabled: boolean;
  /** User-configured values (overrides manifest defaults) */
  config: Record<string, unknown>;
  /** Installation timestamp (epoch ms) */
  installedAt: number;
  /** Last update timestamp (epoch ms) */
  updatedAt: number;
}

// ─── Marketplace ───

/** Plugin search result from marketplace */
export interface PluginSearchResult {
  /** Plugin ID */
  id: string;
  /** Display name */
  name: string;
  /** Description */
  description: string;
  /** Latest version */
  version: string;
  /** Author */
  author: string;
  /** Category */
  category: PluginCategory;
  /** Trust level */
  trustLevel: PluginTrustLevel;
  /** Total downloads */
  downloads: number;
  /** Average rating (0–5) */
  rating: number;
  /** Number of ratings */
  ratingCount: number;
}

// ─── Skill Context (for trigger matching) ───

/** Context passed to skill trigger matching */
export interface SkillContext {
  /** Current file path being worked on */
  filePath?: string;
  /** Slash command entered by user */
  command?: string;
  /** Error message (if triggered by error) */
  errorMessage?: string;
  /** Current task description */
  taskDescription?: string;
  /** Project dependencies (package names) */
  projectDependencies?: string[];
}

// ─── Loaded Plugin (runtime) ───

/** A fully loaded plugin with parsed resources */
export interface LoadedPlugin {
  /** The original manifest */
  manifest: PluginManifest;
  /** Parsed skills keyed by ID */
  skills: Map<string, ParsedSkill>;
  /** Parsed strategies keyed by ID */
  strategies: Map<string, StrategyDefinition>;
  /** Patterns keyed by ID */
  patterns: Map<string, PatternDefinition>;
  /** Validators */
  validators: ValidatorDefinition[];
  /** Base path of the plugin on disk */
  basePath: string;
}

/** A parsed skill with resolved template content */
export interface ParsedSkill {
  /** Original definition */
  definition: SkillDefinition;
  /** Resolved template content (markdown) */
  content: string;
  /** Extracted domain from ## Identity section */
  domain?: string;
  /** Extracted type from ## Identity section */
  type?: string;
  /** Extracted confidence from ## Identity section */
  confidence?: number;
  /** Extracted known patterns */
  knownPatterns?: ParsedKnownPattern[];
  /** Extracted validation checklist items */
  validationChecklist?: string[];
  /** Extracted tool sequence */
  toolSequence?: string[];
}

/** A known pattern extracted from skill markdown */
export interface ParsedKnownPattern {
  /** Pattern name */
  name: string;
  /** Symptoms list */
  symptoms: string[];
  /** Root causes */
  causes: string[];
  /** Resolution strategies */
  strategy: string[];
  /** Tools to use */
  tools: string[];
  /** Common pitfalls */
  pitfalls: string[];
}

// ─── Plugin Lifecycle Hooks ───

/** Plugin lifecycle hooks — optional hooks plugins can implement */
export interface PluginLifecycle {
  /** Called when the plugin is loaded */
  onLoad?(context: PluginLifecycleContext): Promise<void>;
  /** Called when the plugin is unloaded */
  onUnload?(): Promise<void>;
  /** Called before the agent runs a task */
  beforeAgentRun?(task: string): Promise<PluginAdvice | null>;
  /** Called after the agent completes a task */
  afterAgentRun?(result: PluginAgentResult): Promise<void>;
  /** Called when an error occurs */
  onError?(error: string): Promise<PluginAdvice | null>;
  /** Called when the project is scanned */
  onProjectScan?(projectInfo: PluginProjectInfo): Promise<void>;
}

/** Context provided to plugin lifecycle hooks */
export interface PluginLifecycleContext {
  /** Project root path */
  workDir: string;
  /** Plugin configuration */
  config: Record<string, unknown>;
}

/** Advice returned by plugin hooks */
export interface PluginAdvice {
  /** Suggested skill to use */
  skill?: string;
  /** Suggested strategy to apply */
  strategy?: string;
  /** Additional context to inject */
  context?: string;
  /** Confidence in the advice */
  confidence?: number;
}

/** Simplified agent result for plugin hooks */
export interface PluginAgentResult {
  /** Whether the task succeeded */
  success: boolean;
  /** Summary of what was done */
  summary: string;
  /** Files that were changed */
  changedFiles: string[];
}

/** Project info for plugin detection hooks */
export interface PluginProjectInfo {
  /** Project root path */
  workDir: string;
  /** Detected dependencies */
  dependencies: string[];
  /** Detected files */
  files: string[];
}
