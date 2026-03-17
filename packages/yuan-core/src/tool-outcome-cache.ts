/**
 * @module tool-outcome-cache
 * @description Caches deterministic tool outcomes to avoid redundant execution.
 * Example: tsc --noEmit with same tsconfig + files → cached result.
 * Uses content hash for invalidation.
 * NO LLM.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface CachedOutcome {
  command: string;
  hash: string;
  output: string;
  success: boolean;
  cachedAt: number;
  ttlMs: number;
}

export class ToolOutcomeCache {
  private cache = new Map<string, CachedOutcome>();
  private maxEntries: number;
  private defaultTTL: number;

  constructor(opts?: { maxEntries?: number; defaultTTL?: number }) {
    this.maxEntries = opts?.maxEntries ?? 50;
    this.defaultTTL = opts?.defaultTTL ?? 300_000; // 5 minutes
  }

  /**
   * Compute a content hash for cache key.
   * For shell commands: hash the command + relevant file contents.
   */
  computeHash(command: string, relevantFiles: string[]): string {
    const hasher = createHash("sha256");
    hasher.update(command);
    for (const file of relevantFiles.sort()) {
      try {
        hasher.update(file + ":" + readFileSync(file, "utf-8"));
      } catch {
        hasher.update(file + ":MISSING");
      }
    }
    return hasher.digest("hex").slice(0, 16);
  }

  /** Check if a cached result exists and is valid */
  get(command: string, hash: string): CachedOutcome | null {
    const key = `${command}:${hash}`;
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > entry.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry;
  }

  /** Store a tool outcome */
  set(command: string, hash: string, output: string, success: boolean, ttlMs?: number): void {
    const key = `${command}:${hash}`;
    // Evict oldest if full
    if (this.cache.size >= this.maxEntries) {
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }
    this.cache.set(key, {
      command, hash, output, success,
      cachedAt: Date.now(),
      ttlMs: ttlMs ?? this.defaultTTL,
    });
  }

  /** Check if a command is cacheable (deterministic) */
  static isCacheable(command: string): boolean {
    const cacheable = [
      /\btsc\s+--noEmit\b/,
      /\bnpx\s+tsc\b/,
      /\bpnpm\s+run\s+build\b/,
      /\bnpm\s+run\s+build\b/,
      /\bpnpm\s+run\s+lint\b/,
      /\bnpm\s+run\s+lint\b/,
      /\beslint\b/,
    ];
    return cacheable.some(p => p.test(command));
  }

  /** Invalidate all entries (e.g., after file changes) */
  invalidateAll(): void {
    this.cache.clear();
  }

  /** Invalidate entries whose hash involves specific files */
  invalidateForFiles(_changedFiles: string[]): void {
    // Simple: just clear all (file-level invalidation would need hash tracking)
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
