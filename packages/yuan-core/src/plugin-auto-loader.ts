/**
 * PluginAutoLoader — Discovers and registers plugins at startup.
 *
 * Scan order:
 * 1. Built-in plugins (packages/yuan-core/plugins/)
 * 2. Project-local plugins (.yuan/plugins/)
 * 3. User global plugins (~/.yuan/plugins/)
 * 4. npm-installed plugins (node_modules/@yuaone/plugin-*, node_modules/yuan-plugin-*)
 *
 * Each plugin's detect conditions are checked against the project.
 * Matching plugins are auto-registered.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import { PluginRegistry } from "./plugin-registry.js";
import type { PluginManifest, PluginDetectConfig, PluginLifecycle } from "./plugin-types.js";

// ─── Public Types ───

export interface AutoLoaderConfig {
  /** Project root directory */
  projectRoot: string;
  /** Additional plugin search paths */
  extraPaths?: string[];
  /** Skip detect checks (force-load all found plugins) */
  loadAll?: boolean;
  /** Whether to scan node_modules for npm-installed plugins (default: true) */
  scanNodeModules?: boolean;
}

export interface LoadResult {
  loaded: string[];
  skipped: string[];
  errors: Array<{ pluginId: string; error: string }>;
}

// ─── Simple YAML Parser ───

type YamlValue = string | number | boolean | null | YamlValue[] | YamlObject;
interface YamlObject {
  [key: string]: YamlValue;
}

/**
 * Minimal YAML parser that handles:
 * - Key-value pairs
 * - Arrays (with - prefix)
 * - Nested objects (via indentation)
 * - String values (quoted and unquoted)
 * - Boolean and number values
 *
 * Does NOT handle multi-line strings, anchors, tags, or flow style.
 */
function parseSimpleYaml(text: string): YamlObject {
  const lines = text.split("\n");
  return parseBlock(lines, 0, 0).value as YamlObject;
}

interface ParseResult {
  value: YamlValue;
  consumed: number;
}

function parseBlock(lines: string[], startIdx: number, parentIndent: number): ParseResult {
  const result: YamlObject = {};
  let i = startIdx;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines and comments
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const indent = getIndent(line);

    // If indentation drops below or to parent level, this block is done
    if (indent < parentIndent) {
      break;
    }
    // If exactly at parent indent, also done (sibling of parent)
    if (indent < parentIndent) {
      break;
    }

    // Only process lines at our expected indent level
    if (i === startIdx) {
      // First line sets the indent for this block
    }

    const trimmed = line.trim();

    // Array item at this level: "- value" or "- key: value"
    if (trimmed.startsWith("- ")) {
      // This is an array — but arrays are handled within key parsing
      // If we hit a bare array at block level, skip
      i++;
      continue;
    }

    // Key-value pair
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = trimmed.substring(0, colonIdx).trim();
    const afterColon = trimmed.substring(colonIdx + 1).trim();

    if (afterColon === "" || afterColon === "|" || afterColon === ">") {
      // Value is a nested block (object or array) on next lines
      const childIndent = findChildIndent(lines, i + 1);
      if (childIndent <= indent) {
        // Empty value
        result[key] = null;
        i++;
        continue;
      }

      // Check if children are array items
      const nextNonEmpty = findNextNonEmpty(lines, i + 1);
      if (nextNonEmpty !== -1 && lines[nextNonEmpty].trim().startsWith("- ")) {
        const arrayResult = parseArray(lines, i + 1, childIndent);
        result[key] = arrayResult.value;
        i = i + 1 + arrayResult.consumed;
      } else {
        // Nested object
        const blockResult = parseBlock(lines, i + 1, childIndent);
        result[key] = blockResult.value;
        i = i + 1 + blockResult.consumed;
      }
    } else {
      // Inline value
      result[key] = parseScalar(afterColon);
      i++;
    }
  }

  return { value: result, consumed: i - startIdx };
}

function parseArray(lines: string[], startIdx: number, expectedIndent: number): ParseResult {
  const result: YamlValue[] = [];
  let i = startIdx;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const indent = getIndent(line);
    if (indent < expectedIndent) {
      break;
    }

    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) {
      break;
    }

    const itemContent = trimmed.substring(2).trim();

    // Check if the array item has a colon (object item)
    const colonIdx = itemContent.indexOf(":");
    if (colonIdx !== -1 && !isQuotedColon(itemContent, colonIdx)) {
      // Could be an inline object like "- key: value"
      // or start of a nested object block
      const key = itemContent.substring(0, colonIdx).trim();
      const afterColon = itemContent.substring(colonIdx + 1).trim();

      // Build an object for this array item
      const obj: YamlObject = {};

      if (afterColon === "") {
        // Nested block under this array item key
        const childIndent = findChildIndent(lines, i + 1);
        if (childIndent > indent) {
          const blockResult = parseBlock(lines, i + 1, childIndent);
          obj[key] = blockResult.value;
          i = i + 1 + blockResult.consumed;
        } else {
          obj[key] = null;
          i++;
        }
      } else {
        obj[key] = parseScalar(afterColon);
        i++;
      }

      // Check for additional keys at deeper indent (part of same object)
      const nextChildIndent = indent + 2;
      while (i < lines.length) {
        const nextLine = lines[i];
        if (nextLine.trim() === "" || nextLine.trim().startsWith("#")) {
          i++;
          continue;
        }
        const nextIndent = getIndent(nextLine);
        if (nextIndent < nextChildIndent) break;
        if (nextIndent !== nextChildIndent) break;

        const nextTrimmed = nextLine.trim();
        if (nextTrimmed.startsWith("- ")) break;

        const nextColonIdx = nextTrimmed.indexOf(":");
        if (nextColonIdx === -1) break;

        const nextKey = nextTrimmed.substring(0, nextColonIdx).trim();
        const nextAfterColon = nextTrimmed.substring(nextColonIdx + 1).trim();

        if (nextAfterColon === "") {
          const deepChildIndent = findChildIndent(lines, i + 1);
          if (deepChildIndent > nextIndent) {
            const nextNonEmpty = findNextNonEmpty(lines, i + 1);
            if (nextNonEmpty !== -1 && lines[nextNonEmpty].trim().startsWith("- ")) {
              const arrResult = parseArray(lines, i + 1, deepChildIndent);
              obj[nextKey] = arrResult.value;
              i = i + 1 + arrResult.consumed;
            } else {
              const blockResult = parseBlock(lines, i + 1, deepChildIndent);
              obj[nextKey] = blockResult.value;
              i = i + 1 + blockResult.consumed;
            }
          } else {
            obj[nextKey] = null;
            i++;
          }
        } else {
          obj[nextKey] = parseScalar(nextAfterColon);
          i++;
        }
      }

      result.push(obj);
    } else {
      // Simple scalar item
      result.push(parseScalar(itemContent));
      i++;
    }
  }

  return { value: result, consumed: i - startIdx };
}

function parseScalar(value: string): string | number | boolean | null {
  if (value === "" || value === "null" || value === "~") return null;

  // Quoted strings
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  // Booleans
  const lower = value.toLowerCase();
  if (lower === "true" || lower === "yes" || lower === "on") return true;
  if (lower === "false" || lower === "no" || lower === "off") return false;

  // Numbers
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);

  // Strip inline comments
  const commentIdx = value.indexOf(" #");
  if (commentIdx !== -1) {
    return value.substring(0, commentIdx).trim();
  }

  return value;
}

function getIndent(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function findChildIndent(lines: string[], startIdx: number): number {
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== "" && !line.trim().startsWith("#")) {
      return getIndent(line);
    }
  }
  return 0;
}

function findNextNonEmpty(lines: string[], startIdx: number): number {
  for (let i = startIdx; i < lines.length; i++) {
    if (lines[i].trim() !== "" && !lines[i].trim().startsWith("#")) {
      return i;
    }
  }
  return -1;
}

function isQuotedColon(text: string, colonIdx: number): boolean {
  // Check if the colon is inside quotes
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < colonIdx; i++) {
    if (text[i] === "'" && !inDouble) inSingle = !inSingle;
    if (text[i] === '"' && !inSingle) inDouble = !inDouble;
  }
  return inSingle || inDouble;
}

// ─── Main Class ───

/** Lifecycle hook names that can be invoked */
export type LifecycleHookName =
  | "onLoad"
  | "onUnload"
  | "beforeAgentRun"
  | "afterAgentRun"
  | "onError"
  | "onProjectScan";

/** Stored lifecycle hooks for a plugin (command strings from manifest) */
interface PluginLifecycleHooks {
  [hookName: string]: string | undefined;
}

export class PluginAutoLoader {
  private config: AutoLoaderConfig;
  /** Lifecycle hooks stored per plugin ID */
  private lifecycleHooks: Map<string, PluginLifecycleHooks> = new Map();

  constructor(config: AutoLoaderConfig) {
    this.config = config;
  }

  /**
   * Invoke a lifecycle hook for a plugin.
   * Returns the shell command string if the hook exists, or null if not defined.
   * The caller (agent) is responsible for executing the command — we don't
   * auto-execute for security reasons.
   */
  invokeHook(
    pluginId: string,
    hookName: LifecycleHookName,
    _context?: Record<string, unknown>,
  ): string | null {
    const hooks = this.lifecycleHooks.get(pluginId);
    if (!hooks) return null;

    const command = hooks[hookName];
    if (!command || typeof command !== "string") return null;

    return command;
  }

  /**
   * Get all stored lifecycle hooks for a plugin.
   */
  getLifecycleHooks(pluginId: string): PluginLifecycleHooks | undefined {
    return this.lifecycleHooks.get(pluginId);
  }

  /**
   * Discover and register all matching plugins.
   */
  async loadAll(registry: PluginRegistry): Promise<LoadResult> {
    const result: LoadResult = { loaded: [], skipped: [], errors: [] };

    // 1. Find all plugin directories
    const pluginDirs = this.discoverPluginDirs();

    // 2. Parse each plugin.yaml and register
    for (const dir of pluginDirs) {
      try {
        const manifest = this.parsePluginYaml(dir);
        if (!manifest) {
          result.errors.push({
            pluginId: dir,
            error: "Invalid or missing plugin.yaml",
          });
          continue;
        }

        // 3. Check detect conditions
        if (!this.config.loadAll && !this.matchesDetect(manifest)) {
          result.skipped.push(manifest.id);
          continue;
        }

        // 4. Register plugin
        registry.register(manifest);
        result.loaded.push(manifest.id);

        // 5. Store lifecycle hooks if defined in manifest YAML
        this.storeLifecycleHooks(manifest, dir);
      } catch (err) {
        result.errors.push({
          pluginId: dir,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  /**
   * Extract and store lifecycle hooks from a plugin's manifest directory.
   * Looks for a "lifecycle" section in the parsed YAML (keyed by hook name → command string).
   * If none found, checks for a lifecycle.yaml/yml file in the plugin directory.
   */
  private storeLifecycleHooks(manifest: PluginManifest, pluginDir: string): void {
    // Try to read lifecycle hooks from the manifest YAML's raw "lifecycle" key
    // Since our parsePluginYaml doesn't extract lifecycle, re-read it minimally
    let lifecyclePath = path.join(pluginDir, "plugin.yaml");
    if (!fs.existsSync(lifecyclePath)) {
      lifecyclePath = path.join(pluginDir, "plugin.yml");
      if (!fs.existsSync(lifecyclePath)) return;
    }

    try {
      const content = fs.readFileSync(lifecyclePath, "utf-8");
      // Quick check: does the file mention "lifecycle"?
      if (!content.includes("lifecycle")) return;

      // Extract lifecycle section via simple line parsing
      const hooks: PluginLifecycleHooks = {};
      const lines = content.split("\n");
      let inLifecycle = false;
      let lifecycleIndent = -1;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;

        const indent = line.length - line.trimStart().length;

        if (trimmed.startsWith("lifecycle:")) {
          inLifecycle = true;
          lifecycleIndent = indent;
          continue;
        }

        if (inLifecycle) {
          if (indent <= lifecycleIndent) {
            // Exited lifecycle block
            break;
          }
          const colonIdx = trimmed.indexOf(":");
          if (colonIdx > 0) {
            const key = trimmed.substring(0, colonIdx).trim();
            const value = trimmed.substring(colonIdx + 1).trim();
            if (value) {
              // Strip quotes
              const unquoted =
                (value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))
                  ? value.slice(1, -1)
                  : value;
              hooks[key] = unquoted;
            }
          }
        }
      }

      if (Object.keys(hooks).length > 0) {
        this.lifecycleHooks.set(manifest.id, hooks);
      }
    } catch {
      // Failed to read lifecycle hooks — not critical
    }
  }

  /**
   * Discover plugin directories from all search paths.
   * Returns absolute paths to directories containing plugin.yaml.
   */
  private discoverPluginDirs(): string[] {
    const searchPaths: string[] = [];

    // 1. Built-in plugins: relative to this source file's package
const __filename = fileURLToPath(import.meta.url);
const __dirnameLocal = path.dirname(__filename);
const builtinDir = path.resolve(__dirnameLocal, "..", "plugins");
    searchPaths.push(builtinDir);

    // 2. Project-local plugins
    const localDir = path.resolve(this.config.projectRoot, ".yuan", "plugins");
    searchPaths.push(localDir);

    // 3. User global plugins
    const globalDir = path.resolve(os.homedir(), ".yuan", "plugins");
    searchPaths.push(globalDir);

    // 4. Extra paths from config
    if (this.config.extraPaths) {
      searchPaths.push(...this.config.extraPaths);
    }

    const pluginDirs: string[] = [];

    for (const searchPath of searchPaths) {
      if (!fs.existsSync(searchPath)) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(searchPath);
      } catch {
        continue;
      }

      if (!stat.isDirectory()) continue;

      // Each subdirectory that contains a plugin.yaml is a plugin
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(searchPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const pluginDir = path.join(searchPath, entry.name);
        const manifestPath = path.join(pluginDir, "plugin.yaml");
        const manifestPathYml = path.join(pluginDir, "plugin.yml");

        if (fs.existsSync(manifestPath) || fs.existsSync(manifestPathYml)) {
          pluginDirs.push(pluginDir);
        }
      }
    }

    // 5. npm-installed plugins (node_modules)
    if (this.config.scanNodeModules !== false) {
      const nodeModulesDir = path.resolve(this.config.projectRoot, "node_modules");
      if (fs.existsSync(nodeModulesDir)) {
        // 5a. Scoped: @yuaone/plugin-*
        const yuaoneScopeDir = path.join(nodeModulesDir, "@yuaone");
        if (fs.existsSync(yuaoneScopeDir)) {
          try {
            const entries = fs.readdirSync(yuaoneScopeDir, { withFileTypes: true });
            for (const entry of entries) {
              if (!entry.isDirectory()) continue;
              if (!entry.name.startsWith("plugin-")) continue;
              const pkgDir = path.join(yuaoneScopeDir, entry.name);
              if (
                fs.existsSync(path.join(pkgDir, "plugin.yaml")) ||
                fs.existsSync(path.join(pkgDir, "plugin.yml"))
              ) {
                pluginDirs.push(pkgDir);
              }
            }
          } catch {
            // Cannot read @yuaone scope — skip
          }
        }

        // 5b. Community: yuan-plugin-*
        try {
          const entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (!entry.name.startsWith("yuan-plugin-")) continue;
            const pkgDir = path.join(nodeModulesDir, entry.name);
            if (
              fs.existsSync(path.join(pkgDir, "plugin.yaml")) ||
              fs.existsSync(path.join(pkgDir, "plugin.yml"))
            ) {
              pluginDirs.push(pkgDir);
            }
          }
        } catch {
          // Cannot read node_modules — skip
        }
      }
    }

    return pluginDirs;
  }

  /**
   * Parse a plugin.yaml file into a PluginManifest.
   * Uses a simple YAML parser (no external deps).
   */
  private parsePluginYaml(pluginDir: string): PluginManifest | null {
    let manifestPath = path.join(pluginDir, "plugin.yaml");
    if (!fs.existsSync(manifestPath)) {
      manifestPath = path.join(pluginDir, "plugin.yml");
      if (!fs.existsSync(manifestPath)) {
        return null;
      }
    }

    const content = fs.readFileSync(manifestPath, "utf-8");
    const raw = parseSimpleYaml(content) as YamlObject;

    // Validate required fields
    if (
      typeof raw["id"] !== "string" ||
      typeof raw["name"] !== "string" ||
      typeof raw["version"] !== "string"
    ) {
      return null;
    }

    const manifest: PluginManifest = {
      id: raw["id"] as string,
      name: raw["name"] as string,
      version: raw["version"] as string,
      description: (raw["description"] as string) ?? "",
      author: (raw["author"] as string) ?? "unknown",
      category: (raw["category"] as PluginManifest["category"]) ?? "general",
      trustLevel: (raw["trustLevel"] as PluginManifest["trustLevel"]) ?? "community",
      type: (raw["type"] as PluginManifest["type"]) ?? "knowledge",
    };

    // Optional scalar fields
    if (raw["sandbox"] != null) manifest.sandbox = raw["sandbox"] as PluginManifest["sandbox"];
    if (raw["triggerMode"] != null) manifest.triggerMode = raw["triggerMode"] as PluginManifest["triggerMode"];
    if (raw["pluginApiVersion"] != null) manifest.pluginApiVersion = raw["pluginApiVersion"] as number;
    if (raw["estimatedPromptTokens"] != null) manifest.estimatedPromptTokens = raw["estimatedPromptTokens"] as number;
    if (raw["checksum"] != null) manifest.checksum = raw["checksum"] as string;
    if (raw["license"] != null) manifest.license = raw["license"] as string;
    if (raw["engineVersion"] != null) manifest.engineVersion = raw["engineVersion"] as string;

    // Detect config
    if (raw["detect"] != null && typeof raw["detect"] === "object") {
      manifest.detect = this.parseDetectConfig(raw["detect"] as YamlObject);
    }

    // Skills array
    if (Array.isArray(raw["skills"])) {
      manifest.skills = this.parseSkillsArray(raw["skills"] as YamlObject[]);
    }

    // Tools array
    if (Array.isArray(raw["tools"])) {
      manifest.tools = this.parseToolsArray(raw["tools"] as YamlObject[]);
    }

    // Triggers array
    if (Array.isArray(raw["triggers"])) {
      manifest.triggers = this.parseTriggersArray(raw["triggers"] as YamlObject[]);
    }

    // Permissions
    if (raw["permissions"] != null && typeof raw["permissions"] === "object") {
      manifest.permissions = raw["permissions"] as PluginManifest["permissions"];
    }

    // Dependencies (plugin deps)
    if (raw["dependencies"] != null && typeof raw["dependencies"] === "object" && !Array.isArray(raw["dependencies"])) {
      manifest.dependencies = raw["dependencies"] as Record<string, string>;
    }

    // Config fields
    if (raw["config"] != null && typeof raw["config"] === "object" && !Array.isArray(raw["config"])) {
      manifest.config = raw["config"] as unknown as PluginManifest["config"];
    }

    return manifest;
  }

  /**
   * Parse detect config from raw YAML object.
   */
  private parseDetectConfig(raw: YamlObject): PluginDetectConfig {
    const detect: PluginDetectConfig = {};

    if (Array.isArray(raw["files"])) {
      detect.files = (raw["files"] as YamlValue[]).map(String);
    }
    if (Array.isArray(raw["dependencies"])) {
      detect.dependencies = (raw["dependencies"] as YamlValue[]).map(String);
    }
    if (Array.isArray(raw["glob"])) {
      detect.glob = (raw["glob"] as YamlValue[]).map(String);
    }
    if (Array.isArray(raw["env"])) {
      detect.env = (raw["env"] as YamlValue[]).map(String);
    }

    return detect;
  }

  /**
   * Parse skills array from raw YAML.
   */
  private parseSkillsArray(rawSkills: YamlObject[]): PluginManifest["skills"] {
    return rawSkills
      .filter((s) => typeof s["id"] === "string" && typeof s["name"] === "string")
      .map((s) => ({
        id: s["id"] as string,
        name: s["name"] as string,
        description: (s["description"] as string) ?? "",
        trigger: this.parseSkillTrigger(s["trigger"] as YamlObject | undefined),
        template: (s["template"] as string) ?? "",
        enabled: s["enabled"] !== false,
        tags: Array.isArray(s["tags"]) ? (s["tags"] as YamlValue[]).map(String) : undefined,
      }));
  }

  /**
   * Parse a skill trigger from raw YAML.
   */
  private parseSkillTrigger(raw: YamlObject | undefined): PluginManifest["skills"] extends (infer S)[] | undefined ? S extends { trigger: infer T } ? T : never : never {
    type SkillTriggerType = NonNullable<PluginManifest["skills"]>[number]["trigger"];
    if (!raw) {
      return { kind: "manual" } as SkillTriggerType;
    }
    const trigger: SkillTriggerType = {
      kind: (raw["kind"] as SkillTriggerType["kind"]) ?? "manual",
    };
    if (raw["pattern"] != null) trigger.pattern = raw["pattern"] as string;
    if (raw["command"] != null) trigger.command = raw["command"] as string;
    if (raw["confidence"] != null) trigger.confidence = raw["confidence"] as number;
    if (Array.isArray(raw["requires"])) trigger.requires = (raw["requires"] as YamlValue[]).map(String);
    if (Array.isArray(raw["exclude"])) trigger.exclude = (raw["exclude"] as YamlValue[]).map(String);
    if (raw["cooldown"] != null) trigger.cooldown = raw["cooldown"] as number;
    return trigger;
  }

  /**
   * Parse tools array from raw YAML.
   */
  private parseToolsArray(rawTools: YamlObject[]): PluginManifest["tools"] {
    return rawTools
      .filter((t) => typeof t["name"] === "string")
      .map((t) => ({
        name: t["name"] as string,
        description: (t["description"] as string) ?? "",
        inputSchema: (t["inputSchema"] as Record<string, unknown>) ?? {},
        requiresApproval: t["requiresApproval"] as boolean | undefined,
        riskLevel: t["riskLevel"] as "low" | "medium" | "high" | undefined,
        sideEffectLevel: t["sideEffectLevel"] as PluginManifest["tools"] extends (infer T)[] | undefined ? T extends { sideEffectLevel?: infer S } ? S : never : never,
      }));
  }

  /**
   * Parse triggers array from raw YAML.
   */
  private parseTriggersArray(rawTriggers: YamlObject[]): PluginManifest["triggers"] {
    return rawTriggers
      .filter((t) => typeof t["pattern"] === "string" && typeof t["skill"] === "string")
      .map((t) => ({
        pattern: t["pattern"] as string,
        kind: t["kind"] as "error" | "task" | "file" | "dependency" | undefined,
        skill: t["skill"] as string,
        strategy: t["strategy"] as string | undefined,
        priority: t["priority"] as number | undefined,
        triggerMode: t["triggerMode"] as PluginManifest["triggerMode"],
      }));
  }

  /**
   * Check if a plugin's detect conditions match the current project.
   *
   * Logic: ANY file match OR ANY dependency match triggers activation.
   * If no detect config exists, the plugin is always activated.
   */
  private matchesDetect(manifest: PluginManifest): boolean {
    const detect = manifest.detect;
    if (!detect) return true;

    const hasAnyCondition =
      (detect.files && detect.files.length > 0) ||
      (detect.dependencies && detect.dependencies.length > 0) ||
      (detect.glob && detect.glob.length > 0) ||
      (detect.env && detect.env.length > 0);

    if (!hasAnyCondition) return true;

    // Check file existence
    if (detect.files) {
      for (const file of detect.files) {
        const filePath = path.resolve(this.config.projectRoot, file);
        if (fs.existsSync(filePath)) return true;
      }
    }

    // Check dependencies in package.json
    if (detect.dependencies && detect.dependencies.length > 0) {
      const pkgJsonPath = path.resolve(this.config.projectRoot, "package.json");
      if (fs.existsSync(pkgJsonPath)) {
        try {
          const pkgContent = fs.readFileSync(pkgJsonPath, "utf-8");
          const pkg = JSON.parse(pkgContent) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
            peerDependencies?: Record<string, string>;
          };

          const allDeps = new Set<string>([
            ...Object.keys(pkg.dependencies ?? {}),
            ...Object.keys(pkg.devDependencies ?? {}),
            ...Object.keys(pkg.peerDependencies ?? {}),
          ]);

          for (const dep of detect.dependencies) {
            if (allDeps.has(dep)) return true;
          }
        } catch {
          // Invalid package.json — skip dependency check
        }
      }
    }

    // Check glob patterns
    if (detect.glob) {
      for (const pattern of detect.glob) {
        if (this.globExistsInProject(pattern)) return true;
      }
    }

    // Check environment variables
    if (detect.env) {
      for (const envVar of detect.env) {
        if (process.env[envVar] != null) return true;
      }
    }

    return false;
  }

  /**
   * Check if any file matching a glob pattern exists in the project root.
   * Uses a simple top-level check (does not recurse for **).
   */
  private globExistsInProject(pattern: string): boolean {
    // Convert glob to regex for matching
    const regexStr = pattern
      .replace(/\./g, "\\.")
      .replace(/\*\*/g, "<<GLOBSTAR>>")
      .replace(/\*/g, "[^/]*")
      .replace(/<<GLOBSTAR>>/g, ".*");

    let regex: RegExp;
    try {
      regex = new RegExp(`^${regexStr}$`);
    } catch {
      return false;
    }

    // For simple patterns like "*.ts" or "tsconfig.json", just check root
    try {
      const entries = fs.readdirSync(this.config.projectRoot);
      for (const entry of entries) {
        if (regex.test(entry)) return true;
      }
    } catch {
      // Cannot read directory
    }

    return false;
  }
}
