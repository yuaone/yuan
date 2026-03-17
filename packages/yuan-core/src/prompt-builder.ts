/**
 * @module prompt-builder
 * @description YUAN PromptBuilder -- dumb renderer.
 *
 * Rules:
 * 1. PromptEnvelope -> string conversion only
 * 2. No policy decisions (mode, budget, role interpretation forbidden)
 * 3. Section order: core -> policy -> role -> context -> ephemeral -> reinforce
 * 4. When token budget exceeded, droppable sections are removed first
 *
 * YUA reference: prompt-builder.ts (1436 lines) -- YUAN is much thinner
 */

import type { PromptEnvelope, PromptSection } from "./prompt-envelope.js";

/** Rough token estimation (1 token ~ 3.5 chars for mixed Korean/English) */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** Section separator used between prompt sections */
const SECTION_SEP = "\n\n---\n\n";

function sortGroup(sections: PromptSection[]): PromptSection[] {
  return [...sections].sort((a, b) => a.priority - b.priority);
}

function orderedGroups(envelope: PromptEnvelope): PromptSection[][] {
  return [
    sortGroup(envelope.systemCoreSections),
    sortGroup(envelope.runtimePolicySections),
    sortGroup(envelope.roleSections),
    sortGroup(envelope.taskContextSections),
    sortGroup(envelope.ephemeralSections),
    sortGroup(envelope.reinforceSections),
  ];
}

function appendSection(current: string, next: string): string {
  if (!current.trim()) return next.trim();
  return `${current}${SECTION_SEP}${next.trim()}`.trim();
}

/**
 * PromptEnvelope -> final system prompt string.
 * No decisions. Just concatenation.
 *
 * @param envelope - The compiled prompt envelope from PromptRuntime
 * @param maxTokens - Optional token budget. If set, droppable sections are
 *                    removed (lowest priority first) until budget is met.
 *                    Required sections (droppable=false) are never removed.
 * @returns Final system prompt string ready for LLM consumption
 */
export function buildPrompt(envelope: PromptEnvelope, maxTokens?: number): string {
  // envelope.maxTokens가 있으면 우선 사용 (PromptRuntime이 예산 계산)
  const effectiveMaxTokens = maxTokens ?? envelope.maxTokens;
  const groups = orderedGroups(envelope);
  const allSections = groups.flat();

  // No token budget -> include everything
  if (!effectiveMaxTokens) {
    return joinSections(allSections);
  }

  // Preserve canonical zone order:
  // core -> policy -> role -> context -> ephemeral -> reinforce
  // Required sections are always kept; droppable sections are appended in-group
  // until budget is exhausted.
  let result = "";
  let usedTokens = 0;

  for (const group of groups) {
    for (const s of group) {
      if (!s.content.length || s.droppable) continue;
      const next = appendSection(result, s.content);
      result = next;
      usedTokens = estimateTokens(result);
    }
  }

  for (const group of groups) {
    for (const s of group) {
      if (!s.content.length || !s.droppable) continue;
      const candidate = appendSection(result, s.content);
      const candidateTokens = estimateTokens(candidate);
      if (candidateTokens <= effectiveMaxTokens) {
        result = candidate;
        usedTokens = candidateTokens;
      }
    }
  }

  return result.trim();
}

/** Join non-empty sections with separator */
function joinSections(sections: PromptSection[]): string {
  return sections
    .filter(s => s.content.length > 0)
    .map(s => s.content)
    .join(SECTION_SEP)
    .trim();
}
