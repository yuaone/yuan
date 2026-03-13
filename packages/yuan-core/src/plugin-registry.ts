/**
 * PluginRegistry — Manages installed plugins and their lifecycle
 *
 * Responsibilities:
 * - Register/unregister plugins
 * - Enable/disable plugins
 * - Aggregate skills and tools from all enabled plugins
 * - Match triggers against error/task context
 * - Serialize/deserialize for persistence
 */

import type {
  PluginManifest,
  InstalledPlugin,
  SkillDefinition,
  PluginToolDefinition,
  SkillContext,
  PluginTrigger,
} from "./plugin-types.js";

/** Trigger match result with source plugin info */
export interface TriggerMatch {
  /** Plugin that owns this trigger */
  pluginId: string;
  /** The matched trigger */
  trigger: PluginTrigger;
  /** The matched skill definition (if found) */
  skill?: SkillDefinition;
  /** Match priority (higher = more preferred) */
  priority: number;
}

/** Serialized form for persistence */
interface SerializedRegistry {
  version: number;
  plugins: Array<{
    manifest: PluginManifest;
    enabled: boolean;
    config: Record<string, unknown>;
    installedAt: number;
    updatedAt: number;
  }>;
}

export class PluginRegistry {
  private plugins: Map<string, InstalledPlugin> = new Map();

  // ─── Registration ───

  /**
   * Register a plugin from its manifest.
   * If already registered, updates the existing entry.
   */
  register(manifest: PluginManifest, config?: Record<string, unknown>): void {
    const now = Date.now();
    const existing = this.plugins.get(manifest.id);

    // Merge default config from manifest with provided config
    const defaultConfig: Record<string, unknown> = {};
    if (manifest.config) {
      for (const [key, field] of Object.entries(manifest.config)) {
        defaultConfig[key] = field.default;
      }
    }

    const mergedConfig = { ...defaultConfig, ...config };

    if (existing) {
      // Update existing plugin
      existing.manifest = manifest;
      existing.config = { ...existing.config, ...mergedConfig };
      existing.updatedAt = now;
    } else {
      // New registration
      this.plugins.set(manifest.id, {
        manifest,
        enabled: true,
        config: mergedConfig,
        installedAt: now,
        updatedAt: now,
      });
    }
  }

  /**
   * Unregister a plugin by ID.
   * @returns true if the plugin was found and removed
   */
  unregister(pluginId: string): boolean {
    return this.plugins.delete(pluginId);
  }

  // ─── Queries ───

  /**
   * Get an installed plugin by ID.
   */
  get(pluginId: string): InstalledPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  /**
   * List all installed plugins.
   */
  list(): InstalledPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * List only enabled plugins.
   */
  listEnabled(): InstalledPlugin[] {
    return Array.from(this.plugins.values()).filter((p) => p.enabled);
  }

  /**
   * Get the total number of installed plugins.
   */
  get size(): number {
    return this.plugins.size;
  }

  // ─── Skill & Tool Aggregation ───

  /**
   * Get all skills from all enabled plugins.
   * Returns skills with their owning plugin ID.
   */
  getAllSkills(): Array<{ pluginId: string; skill: SkillDefinition }> {
    const results: Array<{ pluginId: string; skill: SkillDefinition }> = [];

    for (const [pluginId, installed] of this.plugins) {
      if (!installed.enabled) continue;
      const skills = installed.manifest.skills ?? [];
      for (const skill of skills) {
        if (skill.enabled) {
          results.push({ pluginId, skill });
        }
      }
    }

    return results;
  }

  /**
   * Enabled skill definitions only, flattened.
   */
  getEnabledSkillDefinitions(): SkillDefinition[] {
    return this.getAllSkills().map((entry) => entry.skill);
  }
  /**
   * Get compact summary of all skills (names only, for system prompt).
   * Use this instead of getAllSkills() when you only need identifiers
   * to minimize token usage in prompts.
   */
  getSkillSummary(): string[] {
    return this.getAllSkills().map((s) => `${s.pluginId}/${s.skill.name}`);
  }

  /**
   * Get all tools from all enabled plugins.
   * Returns tools with their owning plugin ID.
   */
  getAllTools(): Array<{ pluginId: string; tool: PluginToolDefinition }> {
    const results: Array<{ pluginId: string; tool: PluginToolDefinition }> = [];

    for (const [pluginId, installed] of this.plugins) {
      if (!installed.enabled) continue;
      const tools = installed.manifest.tools ?? [];
      for (const tool of tools) {
        results.push({ pluginId, tool });
      }
    }

    return results;
  }

  // ─── Trigger Matching ───

  /**
   * Find skills that match the given context.
   * Matches against skill triggers (file patterns, commands, auto).
   */
  findMatchingSkills(context: SkillContext): SkillDefinition[] {
    const matched: SkillDefinition[] = [];

    for (const installed of this.plugins.values()) {
      if (!installed.enabled) continue;
      const skills = installed.manifest.skills ?? [];

      for (const skill of skills) {
        if (!skill.enabled) continue;
        if (this.skillMatchesContext(skill, context)) {
          matched.push(skill);
        }
      }
    }

    return matched;
  }

  /**
   * Match plugin-level triggers against an error message or task description.
   * Returns matches sorted by priority (highest first).
   */
  matchTriggers(context: SkillContext): TriggerMatch[] {
    const matches: TriggerMatch[] = [];
    const input = context.errorMessage ?? context.taskDescription ?? "";

    if (!input) return matches;

    for (const [pluginId, installed] of this.plugins) {
      if (!installed.enabled) continue;
      const triggers = installed.manifest.triggers ?? [];

      for (const trigger of triggers) {
        try {
          const regex = new RegExp(trigger.pattern, "i");
          if (regex.test(input)) {
            // Find the referenced skill
            const skills = installed.manifest.skills ?? [];
            const skill = skills.find(
              (s) => s.id === trigger.skill || s.name === trigger.skill,
            );

            matches.push({
              pluginId,
              trigger,
              skill: skill?.enabled ? skill : undefined,
              priority: trigger.priority ?? 0,
            });
          }
        } catch {
          // Invalid regex — skip this trigger
          continue;
        }
      }
    }

    // Sort by priority descending
    matches.sort((a, b) => b.priority - a.priority);

    return matches;
  }

  // ─── Enable/Disable ───

  /**
   * Enable or disable a plugin.
   * @returns true if the plugin was found and state was changed
   */
  setEnabled(pluginId: string, enabled: boolean): boolean {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return false;
    plugin.enabled = enabled;
    plugin.updatedAt = Date.now();
    return true;
  }

  // ─── Config ───

  /**
   * Update a plugin's configuration.
   * Merges with existing config (does not replace).
   * @returns true if the plugin was found and config was updated
   */
  updateConfig(pluginId: string, config: Record<string, unknown>): boolean {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return false;
    plugin.config = { ...plugin.config, ...config };
    plugin.updatedAt = Date.now();
    return true;
  }

  // ─── Serialization ───

  /**
   * Serialize the registry to a JSON string for persistence.
   */
  toJSON(): string {
    const data: SerializedRegistry = {
      version: 1,
      plugins: Array.from(this.plugins.values()).map((p) => ({
        manifest: p.manifest,
        enabled: p.enabled,
        config: p.config,
        installedAt: p.installedAt,
        updatedAt: p.updatedAt,
      })),
    };

    return JSON.stringify(data, null, 2);
  }

  /**
   * Restore a registry from a JSON string.
   */
  static fromJSON(json: string): PluginRegistry {
    const registry = new PluginRegistry();

    try {
      const data = JSON.parse(json) as SerializedRegistry;

      if (data.version !== 1) {
        throw new Error(
          `Unsupported plugin registry version: ${String(data.version)}`,
        );
      }

      if (!Array.isArray(data.plugins)) {
        return registry;
      }

      for (const entry of data.plugins) {
        registry.plugins.set(entry.manifest.id, {
          manifest: entry.manifest,
          enabled: entry.enabled,
          config: entry.config,
          installedAt: entry.installedAt,
          updatedAt: entry.updatedAt,
        });
      }
    } catch (err) {
      // If parsing fails, return an empty registry
      if (err instanceof Error && err.message.startsWith("Unsupported")) {
        throw err;
      }
      // Otherwise silently return empty registry (corrupted data)
    }

    return registry;
  }

  // ─── Private Helpers ───

  /**
   * Check if a skill's trigger matches the given context.
   */
  private skillMatchesContext(
    skill: SkillDefinition,
    context: SkillContext,
  ): boolean {
    const trigger = skill.trigger;

    switch (trigger.kind) {
      case "file_pattern": {
        if (!context.filePath || !trigger.pattern) return false;
        return this.globMatch(trigger.pattern, context.filePath);
      }

      case "command": {
        if (!context.command || !trigger.command) return false;
        return (
          context.command === trigger.command ||
          context.command === `/${trigger.command}`
        );
      }

      case "auto": {
        // Auto triggers match on file patterns, error messages, or task descriptions
        if (trigger.pattern) {
          try {
            const regex = new RegExp(trigger.pattern, "i");
            if (context.filePath && regex.test(context.filePath)) return true;
            if (context.errorMessage && regex.test(context.errorMessage))
              return true;
            if (context.taskDescription && regex.test(context.taskDescription))
              return true;
          } catch {
            return false;
          }
        }
        return false;
      }

      case "manual":
        // Manual skills are never auto-matched
        return false;

      default:
        return false;
    }
  }

  /**
   * Simple glob matching for file patterns.
   * Supports * (any segment chars) and ** (any path depth).
   */
  private globMatch(pattern: string, filePath: string): boolean {
    // Convert glob to regex
    const regexStr = pattern
      .replace(/\./g, "\\.")
      .replace(/\*\*/g, "<<GLOBSTAR>>")
      .replace(/\*/g, "[^/]*")
      .replace(/<<GLOBSTAR>>/g, ".*");

    try {
      const regex = new RegExp(`^${regexStr}$`);
      return regex.test(filePath);
    } catch {
      return false;
    }
  }
}
