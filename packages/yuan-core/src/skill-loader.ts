/**
 * SkillLoader — Loads and resolves skill templates from plugins
 *
 * Responsibilities:
 * - Parse skill markdown into structured ParsedSkill objects
 * - Resolve template variables with context
 * - Match skill triggers against runtime context
 * - Load local skills from .yuan/skills/ directory
 */

import type {
  SkillDefinition,
  SkillContext,
  ParsedSkill,
  ParsedKnownPattern,
} from "./plugin-types.js";

/** Result of parsing a skill markdown's ## Identity section */
interface IdentityBlock {
  domain?: string;
  type?: string;
  confidence?: number;
}

export class SkillLoader {
  /**
   * Load and parse a skill's markdown template into a ParsedSkill.
   * The template can be inline content or a file path — this method
   * accepts the raw template string (caller is responsible for reading files).
   */
  loadTemplate(skill: SkillDefinition, templateContent?: string): ParsedSkill {
    const content = templateContent ?? skill.template;

    // Warn if content looks like a file path rather than markdown
    if (content && /^\.?\/[\w\-./]+\.\w{1,5}$/.test(content.trim())) {
      // Content is likely a file path, not markdown — return minimal ParsedSkill
      return {
        definition: skill,
        content,
        knownPatterns: [],
        validationChecklist: [],
        toolSequence: [],
      };
    }

    const identity = this.parseIdentity(content);
    const knownPatterns = this.parseKnownPatterns(content);
    const validationChecklist = this.parseValidationChecklist(content);
    const toolSequence = this.parseToolSequence(content);

    return {
      definition: skill,
      content,
      domain: identity.domain,
      type: identity.type,
      confidence: identity.confidence,
      knownPatterns: knownPatterns.length > 0 ? knownPatterns : undefined,
      validationChecklist:
        validationChecklist.length > 0 ? validationChecklist : undefined,
      toolSequence: toolSequence.length > 0 ? toolSequence : undefined,
    };
  }

  /**
   * Resolve template variables in a skill template string.
   * Variables use {{variable}} syntax.
   *
   * @param template - Template string with {{variable}} placeholders
   * @param context - Key-value pairs to substitute
   * @returns Resolved template string
   */
  resolveTemplate(
    template: string,
    context: Record<string, unknown>,
  ): string {
    return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, key: string) => {
      // Support dotted paths like "project.name"
      const parts = key.split(".");
      let value: unknown = context;

      for (const part of parts) {
        if (value === null || value === undefined) return `{{${key}}}`;
        if (typeof value === "object") {
          value = (value as Record<string, unknown>)[part];
        } else {
          return `{{${key}}}`;
        }
      }

      if (value === null || value === undefined) return `{{${key}}}`;
      return String(value);
    });
  }

  /**
   * Match skill triggers against the current context.
   * Returns skills whose triggers match, sorted by confidence (highest first).
   */
  matchTriggers(
    skills: SkillDefinition[],
    context: SkillContext,
  ): SkillDefinition[] {
    const matched: Array<{ skill: SkillDefinition; score: number }> = [];

    for (const skill of skills) {
      if (!skill.enabled) continue;

      const score = this.scoreTriggerMatch(skill, context);
      if (score > 0) {
        matched.push({ skill, score });
      }
    }

    // Sort by score descending
    matched.sort((a, b) => b.score - a.score);

    return matched.map((m) => m.skill);
  }

  // ─── Markdown Parsing ───

  /**
   * Parse the ## Identity section from skill markdown.
   *
   * Expected format:
   * ```
   * ## Identity
   * - domain: react
   * - type: bugfix
   * - confidence: 0.85
   * ```
   */
  private parseIdentity(content: string): IdentityBlock {
    const result: IdentityBlock = {};

    // Find ## Identity section
    const identityMatch = content.match(
      /## Identity\s*\n([\s\S]*?)(?=\n## |\n---|$)/,
    );
    if (!identityMatch) return result;

    const section = identityMatch[1];

    const domainMatch = section.match(/-\s*domain:\s*(.+)/i);
    if (domainMatch) result.domain = domainMatch[1].trim();

    const typeMatch = section.match(/-\s*type:\s*(.+)/i);
    if (typeMatch) result.type = typeMatch[1].trim();

    const confidenceMatch = section.match(/-\s*confidence:\s*([\d.]+)/i);
    if (confidenceMatch) result.confidence = parseFloat(confidenceMatch[1]);

    return result;
  }

  /**
   * Parse ### Known Error Patterns subsections.
   *
   * Expected format:
   * ```
   * ### Pattern Name
   * - **증상**: "..."
   * - **원인**: ...
   * - **전략**: 1. ... 2. ...
   * - **도구 시퀀스**: grep → file_read → ...
   * - **함정**: ...
   * ```
   */
  private parseKnownPatterns(content: string): ParsedKnownPattern[] {
    const patterns: ParsedKnownPattern[] = [];

    // Find sections that start with ### under ## Known Error Patterns
    const knownSection = content.match(
      /## Known (?:Error )?Patterns\s*\n([\s\S]*?)(?=\n## |\n---|$)/,
    );
    if (!knownSection) return patterns;

    const sectionContent = knownSection[1];

    // Split by ### headers
    const subsections = sectionContent.split(/\n### /).filter(Boolean);

    for (const sub of subsections) {
      const lines = sub.trim().split("\n");
      const name = lines[0]?.trim() ?? "";
      if (!name) continue;

      const body = lines.slice(1).join("\n");

      const pattern: ParsedKnownPattern = {
        name,
        symptoms: this.extractListItems(body, /\*\*증상\*\*[:\s]*/i),
        causes: this.extractListItems(body, /\*\*원인\*\*[:\s]*/i),
        strategy: this.extractNumberedItems(body, /\*\*전략\*\*[:\s]*/i),
        tools: this.extractToolSequence(body),
        pitfalls: this.extractListItems(body, /\*\*함정\*\*[:\s]*/i),
      };

      patterns.push(pattern);
    }

    return patterns;
  }

  /**
   * Parse ## Validation Checklist section.
   * Extracts - [ ] items.
   */
  private parseValidationChecklist(content: string): string[] {
    const items: string[] = [];

    const checklistMatch = content.match(
      /## Validation Checklist\s*\n([\s\S]*?)(?=\n## |\n---|$)/,
    );
    if (!checklistMatch) return items;

    const section = checklistMatch[1];
    const matches = section.matchAll(/- \[[ x]?\]\s*(.+)/gi);

    for (const match of matches) {
      items.push(match[1].trim());
    }

    return items;
  }

  /**
   * Parse tool sequence from content.
   * Looks for patterns like: "도구 시퀀스: grep → file_read → file_edit"
   */
  private parseToolSequence(content: string): string[] {
    const match = content.match(
      /(?:\*\*도구 시퀀스\*\*|tool.?sequence)[:\s]*(.+)/i,
    );
    if (!match) return [];

    return match[1]
      .split(/→|->|,/)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  // ─── Trigger Matching ───

  /**
   * Score how well a skill matches the given context.
   * Returns 0 for no match, higher for better match.
   */
  private scoreTriggerMatch(
    skill: SkillDefinition,
    context: SkillContext,
  ): number {
    const trigger = skill.trigger;

    switch (trigger.kind) {
      case "file_pattern": {
        if (!context.filePath || !trigger.pattern) return 0;
        return this.globMatch(trigger.pattern, context.filePath) ? 1 : 0;
      }

      case "command": {
        if (!context.command || !trigger.command) return 0;
        const cmd = context.command.replace(/^\//, "");
        return cmd === trigger.command ? 10 : 0; // High score for exact command match
      }

      case "auto": {
        let score = 0;

        if (trigger.pattern) {
          try {
            const regex = new RegExp(trigger.pattern, "i");
            if (context.filePath && regex.test(context.filePath)) score += 1;
            if (context.errorMessage && regex.test(context.errorMessage))
              score += 2; // Errors are higher signal
            if (context.taskDescription && regex.test(context.taskDescription))
              score += 1;
          } catch {
            return 0;
          }
        }

        // Apply confidence threshold
        if (trigger.confidence && score > 0) {
          score *= trigger.confidence;
        }

        // Check tag matches against task description
        if (skill.tags && context.taskDescription) {
          const taskLower = context.taskDescription.toLowerCase();
          for (const tag of skill.tags) {
            if (taskLower.includes(tag.toLowerCase())) {
              score += 0.5;
            }
          }
        }

        return score;
      }

      case "manual":
        return 0;

      default:
        return 0;
    }
  }

  // ─── Utility Helpers ───

  /**
   * Extract list items following a marker pattern.
   */
  private extractListItems(content: string, markerPattern: RegExp): string[] {
    const match = content.match(
      new RegExp(markerPattern.source + "(.+)", "i"),
    );
    if (!match) return [];

    const text = match[1].trim();
    // Handle quoted content
    const quoted = text.match(/"([^"]+)"/);
    if (quoted) return [quoted[1]];

    // Handle comma-separated
    return text
      .split(/,|;/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * Extract numbered items (1. ... 2. ... 3. ...).
   */
  private extractNumberedItems(
    content: string,
    markerPattern: RegExp,
  ): string[] {
    const markerMatch = content.match(
      new RegExp(markerPattern.source + "[\\s\\S]*?(?=\\n- \\*\\*|$)", "i"),
    );
    if (!markerMatch) return [];

    const section = markerMatch[0];
    const items: string[] = [];
    const matches = section.matchAll(/\d+\.\s*(.+)/g);

    for (const match of matches) {
      items.push(match[1].trim());
    }

    return items;
  }

  /**
   * Extract tool sequence from a pattern section.
   */
  private extractToolSequence(content: string): string[] {
    const match = content.match(
      /(?:\*\*도구 시퀀스\*\*|tool.?sequence)[:\s]*(.+)/i,
    );
    if (!match) return [];

    return match[1]
      .split(/→|->|,/)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  /**
   * Simple glob matching for file patterns.
   */
  private globMatch(pattern: string, filePath: string): boolean {
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
