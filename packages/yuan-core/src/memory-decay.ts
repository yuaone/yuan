/**
 * @module memory-decay
 * @description Time-based confidence decay for memory entries.
 * Older learnings lose confidence exponentially.
 * Entries below threshold are pruned.
 * NO LLM, pure math.
 * YUA reference: ai/memory/memory-decay-engine.ts
 */

export interface DecayableEntry {
  confidence: number;
  timestamp: number;      // when the entry was created/updated
  category?: string;
}

export interface DecayConfig {
  halfLifeDays: number;   // confidence halves every N days (default: 30)
  minConfidence: number;  // prune entries below this (default: 0.15)
  protectedCategories: string[];  // never decay these (e.g., "project_rule")
}

const DEFAULT_DECAY_CONFIG: DecayConfig = {
  halfLifeDays: 30,
  minConfidence: 0.15,
  protectedCategories: ["project_rule"],
};

/**
 * Apply exponential decay to a confidence value.
 * Formula: confidence * 2^(-daysSince / halfLife)
 */
export function decayConfidence(
  originalConfidence: number,
  timestampMs: number,
  config: DecayConfig = DEFAULT_DECAY_CONFIG,
): number {
  const daysSince = (Date.now() - timestampMs) / (1000 * 60 * 60 * 24);
  if (daysSince <= 0) return originalConfidence;

  const decayFactor = Math.pow(2, -daysSince / config.halfLifeDays);
  return originalConfidence * decayFactor;
}

/**
 * Apply decay to an array of entries. Removes entries below minConfidence.
 * Returns: { kept, pruned }
 */
export function applyDecayToEntries<T extends DecayableEntry>(
  entries: T[],
  config: DecayConfig = DEFAULT_DECAY_CONFIG,
): { kept: T[]; pruned: T[] } {
  const kept: T[] = [];
  const pruned: T[] = [];

  for (const entry of entries) {
    // Protected categories never decay
    if (entry.category && config.protectedCategories.includes(entry.category)) {
      kept.push(entry);
      continue;
    }

    const decayed = decayConfidence(entry.confidence, entry.timestamp, config);
    if (decayed >= config.minConfidence) {
      kept.push({ ...entry, confidence: Number(decayed.toFixed(3)) });
    } else {
      pruned.push(entry);
    }
  }

  return { kept, pruned };
}

/**
 * Check if two entries conflict (same topic, contradictory).
 * Simple heuristic: same first 5 words but different content.
 */
export function detectConflict(a: { content: string }, b: { content: string }): boolean {
  const normalize = (s: string) =>
    s.toLowerCase().trim().split(/\s+/).slice(0, 5).join(" ");
  const headA = normalize(a.content);
  const headB = normalize(b.content);

  // Same head but different full content → potential conflict
  if (headA === headB && a.content.trim() !== b.content.trim()) {
    return true;
  }
  return false;
}
