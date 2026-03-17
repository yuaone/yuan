/**
 * @module model-weakness-tracker
 * @description Learns and tracks model-specific repeated mistakes.
 * Scoped: model + repo + language (no global pollution).
 * Outputs: prompt hints + engine coefficient boosts.
 * Max 3 hints injected. 7-day decay on unused patterns.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface ModelWeaknessEntry {
  pattern: string;          // "empty_function_body", "any_type", "console_log_leak"
  frequency: number;
  lastSeen: number;
  preventiveHint: string;
  scope: ModelWeaknessScope;
  // Engine coefficients (not just prompt)
  validatorSeverityBoost?: number;   // boost validator strictness
  patchRiskBoost?: number;           // boost failureSurface.patchRisk
}

export interface ModelWeaknessScope {
  model: string;
  repoHash: string;
  language?: string;
}

export class ModelWeaknessTracker {
  private entries: ModelWeaknessEntry[] = [];
  private storagePath: string;
  private scope: ModelWeaknessScope;

  constructor(projectPath: string, model: string) {
    this.storagePath = join(projectPath, ".yuan", "cache", "model-weaknesses.json");
    this.scope = {
      model,
      repoHash: createHash("sha256").update(projectPath).digest("hex").slice(0, 8),
    };
    this.load();
    this.decay(); // Auto-decay on load
  }

  private load(): void {
    try {
      const all: ModelWeaknessEntry[] = JSON.parse(readFileSync(this.storagePath, "utf-8"));
      // Filter to current scope
      this.entries = all.filter(e =>
        e.scope.model === this.scope.model && e.scope.repoHash === this.scope.repoHash
      );
    } catch {
      this.entries = [];
    }
  }

  private save(): void {
    try {
      // Load all, replace current scope, save
      let all: ModelWeaknessEntry[] = [];
      try { all = JSON.parse(readFileSync(this.storagePath, "utf-8")); } catch { /* first write */ }
      all = all.filter(e => !(e.scope.model === this.scope.model && e.scope.repoHash === this.scope.repoHash));
      all.push(...this.entries);
      mkdirSync(join(this.storagePath, ".."), { recursive: true });
      writeFileSync(this.storagePath, JSON.stringify(all, null, 2));
    } catch { /* non-fatal */ }
  }

  /** Auto-decay: reduce frequency of patterns not seen in 7 days */
  private decay(): void {
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    this.entries = this.entries.filter(e => {
      if (now - e.lastSeen > SEVEN_DAYS) {
        e.frequency = Math.max(0, e.frequency - 1);
        return e.frequency > 0;
      }
      return true;
    });
  }

  /** Record a weakness (called when validator blocks or warns) */
  record(pattern: string, hint: string, language?: string): void {
    const existing = this.entries.find(e => e.pattern === pattern);
    if (existing) {
      existing.frequency++;
      existing.lastSeen = Date.now();
    } else {
      this.entries.push({
        pattern,
        frequency: 1,
        lastSeen: Date.now(),
        preventiveHint: hint,
        scope: { ...this.scope, language },
      });
    }
    // Auto-compute engine coefficients based on frequency
    for (const e of this.entries) {
      e.validatorSeverityBoost = Math.min(0.3, e.frequency * 0.05);
      e.patchRiskBoost = Math.min(0.2, e.frequency * 0.03);
    }
    this.save();
  }

  /** Get top N preventive hints for prompt injection (max 3) */
  getPreventiveHints(maxHints: number = 3): string[] {
    return this.entries
      .filter(e => e.frequency >= 2) // Only inject after 2+ occurrences
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, maxHints)
      .map(e => e.preventiveHint);
  }

  /** Get aggregate engine coefficient boosts */
  getEngineBoosts(): { validatorBoost: number; patchRiskBoost: number } {
    let validatorBoost = 0;
    let patchRiskBoost = 0;
    for (const e of this.entries) {
      validatorBoost += e.validatorSeverityBoost ?? 0;
      patchRiskBoost += e.patchRiskBoost ?? 0;
    }
    return {
      validatorBoost: Math.min(0.5, validatorBoost),
      patchRiskBoost: Math.min(0.3, patchRiskBoost),
    };
  }

  get size(): number { return this.entries.length; }
}
