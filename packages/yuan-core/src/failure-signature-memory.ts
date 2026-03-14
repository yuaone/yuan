/**
 * @module failure-signature-memory
 * @description Failure Signature Memory 2.0 — queryable store of error signatures,
 * root causes, and successful fix strategies.
 *
 * Storage: ~/.yuan/failure-signatures/{projectHash}.json
 * projectHash = stable 8-char hash of projectPath
 *
 * Design:
 * - Signatures are indexed by clusterKey (normalized errorType + stripped message)
 * - Query by exact clusterKey match first, then Jaccard similarity fallback
 * - Fix strategies are ranked by successCount / (successCount + failCount)
 * - Emits events but does NOT block main loop
 * - All writes are atomic (write to .tmp then rename)
 */

import { EventEmitter } from "events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

export interface FixRecord {
  strategy: string;
  toolSequence: string[];
  codeSnippet?: string;
  successCount: number;
  failCount: number;
}

export interface FailureSignature {
  id: string;
  clusterKey: string;
  errorType: string;
  messagePattern: string;
  rootCause: string;
  fixes: FixRecord[];
  seenCount: number;
  firstSeen: string;
  lastSeen: string;
  confidence: number;
  affectedFilePatterns: string[];
  /** Runtime environment tags — same error behaves differently per env */
  environment: string[];  // e.g. ["node18", "typescript5", "nextjs", "vite"]
}

export interface FailureSignatureMemoryConfig {
  projectPath?: string;
  storageDir?: string;
  maxSignatures?: number;
  similarityThreshold?: number;
}

// ─── Helpers ───

function detectErrorType(raw: string): string {
  if (/TS\d+/.test(raw)) return "TypeScript";
  if (/ENOENT|no such file/i.test(raw)) return "FileNotFound";
  if (/EACCES|permission denied/i.test(raw)) return "Permission";
  if (/test/i.test(raw) && /fail/i.test(raw)) return "Test";
  if (/build/i.test(raw) && /fail/i.test(raw)) return "Build";
  if (raw.trim().length > 0) return "Runtime";
  return "Unknown";
}

function stripNumbers(msg: string): string {
  return msg.replace(/:\d+:\d+/g, "").replace(/\s+/g, " ").trim();
}

function buildClusterKey(errorType: string, raw: string): string {
  const stripped = stripNumbers(raw).toLowerCase().slice(0, 120);
  return `${errorType}:${stripped}`;
}

function buildMessagePattern(raw: string): string {
  return stripNumbers(raw).slice(0, 200);
}

/** Detect runtime environment tags from package.json / node version. */
function detectEnvironment(): string[] {
  const tags: string[] = [];
  // Node.js version
  const nodeMajor = parseInt(process.version.replace("v", "").split(".")[0] ?? "0", 10);
  if (nodeMajor > 0) tags.push(`node${nodeMajor}`);
  // Read package.json deps for framework detection
  try {
    const pkgPath = join(process.cwd(), "package.json");
    const raw = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const allDeps = { ...((pkg.dependencies ?? {}) as object), ...((pkg.devDependencies ?? {}) as object) };
    const names = Object.keys(allDeps);
    if (names.some(n => n === "typescript")) {
      // Try to get TS version
      try {
        const tsPkg = JSON.parse(readFileSync(join(process.cwd(), "node_modules/typescript/package.json"), "utf-8")) as { version?: string };
        const tsMajor = parseInt((tsPkg.version ?? "0").split(".")[0], 10);
        if (tsMajor > 0) tags.push(`typescript${tsMajor}`);
      } catch { tags.push("typescript"); }
    }
    if (names.some(n => n === "next")) tags.push("nextjs");
    if (names.some(n => n === "vite")) tags.push("vite");
    if (names.some(n => n === "react")) tags.push("react");
    if (names.some(n => n === "vue")) tags.push("vue");
    if (names.some(n => n.startsWith("@nestjs"))) tags.push("nestjs");
    if (names.some(n => n === "express")) tags.push("express");
  } catch { /* not a node project or no package.json */ }
  return tags;
}

function tokenize(msg: string): Set<string> {
  return new Set(msg.toLowerCase().split(/\W+/).filter((t) => t.length > 1));
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function bestFixRatio(fix: FixRecord): number {
  return fix.successCount / (fix.successCount + fix.failCount + 1);
}

function selectBestFix(fixes: FixRecord[]): FixRecord | null {
  if (fixes.length === 0) return null;
  return fixes.reduce((best, f) => (bestFixRatio(f) > bestFixRatio(best) ? f : best));
}

function computeConfidence(fixes: FixRecord[]): number {
  if (fixes.length === 0) return 0;
  const avg = fixes.reduce((sum, f) => sum + bestFixRatio(f), 0) / fixes.length;
  return Math.min(avg, 0.95);
}

function stableHash(projectPath: string): string {
  return Buffer.from(projectPath)
    .toString("base64")
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 8);
}

// ─── Class ───

export class FailureSignatureMemory extends EventEmitter {
  private readonly storageFile: string;
  private readonly maxSignatures: number;
  private readonly similarityThreshold: number;
  private signatures: FailureSignature[];

  constructor(config: FailureSignatureMemoryConfig = {}) {
    super();
    const projectPath = config.projectPath ?? process.cwd();
    const storageDir = config.storageDir ?? join(homedir(), ".yuan", "failure-signatures");
    this.maxSignatures = config.maxSignatures ?? 500;
    this.similarityThreshold = config.similarityThreshold ?? 0.3;

    const hash = stableHash(projectPath);
    this.storageFile = join(storageDir, `${hash}.json`);
    this.signatures = this._load(storageDir);
  }

  // ─── Public API ───

  query(
    errorOutput: string
  ): Array<{ signature: FailureSignature; similarity: number; bestFix: FixRecord | null }> {
    const errorType = detectErrorType(errorOutput);
    const clusterKey = buildClusterKey(errorType, errorOutput);
    const results: Array<{
      signature: FailureSignature;
      similarity: number;
      bestFix: FixRecord | null;
    }> = [];

    for (const sig of this.signatures) {
      let similarity = 0;
      if (sig.clusterKey === clusterKey) {
        similarity = 1.0;
      } else {
        similarity = jaccardSimilarity(sig.messagePattern, buildMessagePattern(errorOutput));
      }

      if (similarity >= this.similarityThreshold || sig.clusterKey === clusterKey) {
        results.push({ signature: sig, similarity, bestFix: selectBestFix(sig.fixes) });
      }
    }

    // Sort: exact match first, then by similarity desc
    results.sort((a, b) => {
      if (a.similarity === 1.0 && b.similarity !== 1.0) return -1;
      if (b.similarity === 1.0 && a.similarity !== 1.0) return 1;
      return b.similarity - a.similarity;
    });

    if (results.length > 0) {
      const top = results[0];
      const bf = top.bestFix;
      this.emit("agent:failure_sig_hit", {
        kind: "agent:failure_sig_hit",
        signatureId: top.signature.id,
        similarity: top.similarity,
        suggestedStrategy: bf ? bf.strategy : "",
        timestamp: Date.now(),
      });
    }

    return results;
  }

  promote(
    errorOutput: string,
    strategy: string,
    toolSequence: string[],
    success: boolean
  ): void {
    const errorType = detectErrorType(errorOutput);
    const clusterKey = buildClusterKey(errorType, errorOutput);
    const messagePattern = buildMessagePattern(errorOutput);
    const now = new Date().toISOString();

    let existing = this.signatures.find((s) => s.clusterKey === clusterKey);
    let action: "created" | "updated";

    if (existing) {
      action = "updated";
      existing.seenCount += 1;
      existing.lastSeen = now;

      const fix = existing.fixes.find((f) => f.strategy === strategy);
      if (fix) {
        if (success) fix.successCount += 1;
        else fix.failCount += 1;
      } else {
        existing.fixes.push({
          strategy,
          toolSequence,
          successCount: success ? 1 : 0,
          failCount: success ? 0 : 1,
        });
      }

      existing.confidence = computeConfidence(existing.fixes);
    } else {
      action = "created";
      const newSig: FailureSignature = {
        id: randomUUID(),
        clusterKey,
        errorType,
        messagePattern,
        rootCause: "",
        fixes: [
          {
            strategy,
            toolSequence,
            successCount: success ? 1 : 0,
            failCount: success ? 0 : 1,
          },
        ],
        seenCount: 1,
        firstSeen: now,
        lastSeen: now,
        confidence: success ? computeConfidence([{ strategy, toolSequence, successCount: 1, failCount: 0 }]) : 0,
        affectedFilePatterns: [],
        environment: detectEnvironment(),
      };
      this.signatures.push(newSig);
      existing = newSig;
    }

    // Cap at maxSignatures — remove oldest by lastSeen
    if (this.signatures.length > this.maxSignatures) {
      this.signatures.sort(
        (a, b) => new Date(a.lastSeen).getTime() - new Date(b.lastSeen).getTime()
      );
      this.signatures = this.signatures.slice(this.signatures.length - this.maxSignatures);
    }

    this._save();

    this.emit("agent:failure_sig_update", {
      kind: "agent:failure_sig_update",
      signatureId: existing.id,
      action,
      errorType,
      timestamp: Date.now(),
    });
  }

  getAll(): FailureSignature[] {
    return [...this.signatures].sort((a, b) => b.seenCount - a.seenCount);
  }

  // ─── Internal ───

  private _load(storageDir: string): FailureSignature[] {
    try {
      if (!existsSync(storageDir)) {
        mkdirSync(storageDir, { recursive: true });
      }
      if (!existsSync(this.storageFile)) return [];
      const raw = readFileSync(this.storageFile, "utf8");
      return JSON.parse(raw) as FailureSignature[];
    } catch {
      return [];
    }
  }

  private _save(): void {
    const tmpFile = `${this.storageFile}.tmp`;
    try {
      writeFileSync(tmpFile, JSON.stringify(this.signatures, null, 2), "utf8");
      renameSync(tmpFile, this.storageFile);
    } catch {
      // Non-fatal: storage failures should not crash the agent loop
    }
  }
}
