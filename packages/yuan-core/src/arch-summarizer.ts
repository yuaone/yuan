/**
 * @module arch-summarizer
 * @description Architecture Auto-Summarizer.
 *
 * Scans the project and generates a concise architecture summary cached at
 * `.yuan/cache/arch-summary.md`. Refreshes when dependency graph changes
 * (detected via mtime of package.json / tsconfig.json) or when explicitly
 * called after a major refactor.
 *
 * Design constraints:
 * - Runs async, never blocks main loop
 * - Uses only local file system — no LLM calls
 * - Cache TTL: 24 hours + invalidated by package.json/tsconfig mtime change
 */

import { mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { homedir } from "node:os";
import { readdirSync } from "node:fs";

interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

interface ArchSummaryCache {
  /** When the summary was generated (ISO string) */
  generatedAt: string;
  /** mtime of package.json when generated */
  packageJsonMtime: number;
  /** mtime of tsconfig.json when generated */
  tsconfigMtime: number;
  /** The markdown summary */
  content: string;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export class ArchSummarizer {
  private readonly cacheDir: string;
  private readonly cachePath: string;

  constructor(
    private readonly projectPath: string,
    cacheBase?: string,
  ) {
    this.cacheDir = cacheBase ?? join(homedir(), ".yuan", "cache");
    this.cachePath = join(this.cacheDir, "arch-summary.md");
  }

  /** Path to the cached summary file */
  get path(): string {
    return this.cachePath;
  }

  /**
   * Returns cached summary if fresh, otherwise regenerates.
   * Never throws — returns empty string on failure.
   */
  async getSummary(): Promise<string> {
    try {
      const cached = this.loadCache();
      if (cached && this.isFresh(cached)) {
        return cached.content;
      }
      return await this.regenerate();
    } catch {
      return "";
    }
  }

  /**
   * Force-regenerate the summary and update cache.
   * Safe to call after a dependency graph change.
   */
  async regenerate(): Promise<string> {
    try {
      const summary = await this.buildSummary();
      this.saveCache(summary);
      return summary;
    } catch {
      return "";
    }
  }

  /**
   * Check if a dependency-graph-relevant file changed since last cache.
   * Lightweight mtime check — no file reading.
   */
  isDirty(): boolean {
    try {
      const cached = this.loadCache();
      if (!cached) return true;
      return !this.isFresh(cached);
    } catch {
      return true;
    }
  }

  // ─── private ───────────────────────────────────────────────────────────────

  private loadCache(): ArchSummaryCache | null {
    try {
      const raw = readFileSync(this.cachePath, "utf-8");
      // Cache header is a JSON comment at the top: <!-- CACHE:{...} -->
      const match = raw.match(/^<!-- CACHE:(.*?) -->/);
      if (!match) return null;
      const meta = JSON.parse(match[1]) as ArchSummaryCache;
      meta.content = raw.replace(/^<!-- CACHE:.*? -->\n/, "");
      return meta;
    } catch {
      return null;
    }
  }

  private isFresh(cache: ArchSummaryCache): boolean {
    const age = Date.now() - new Date(cache.generatedAt).getTime();
    if (age > CACHE_TTL_MS) return false;

    const pkgMtime = this.getMtime(join(this.projectPath, "package.json"));
    const tscMtime = this.getMtime(join(this.projectPath, "tsconfig.json"));

    return pkgMtime === cache.packageJsonMtime && tscMtime === cache.tsconfigMtime;
  }

  private getMtime(filePath: string): number {
    try {
      return statSync(filePath).mtimeMs;
    } catch {
      return 0;
    }
  }

  private async buildSummary(): Promise<string> {
    const projectPath = this.projectPath;

    // 1. Read package.json
    let pkg: PackageJson = {};
    try {
      pkg = JSON.parse(readFileSync(join(projectPath, "package.json"), "utf-8")) as PackageJson;
    } catch { /* ok */ }

    // 2. Detect project type
    const isMonorepo = this.fileExists(join(projectPath, "pnpm-workspace.yaml"))
      || this.fileExists(join(projectPath, "lerna.json"))
      || this.fileExists(join(projectPath, "turbo.json"));

    const hasNextJs = this.depExists(pkg, "next");
    const hasReact = this.depExists(pkg, "react");
    const hasExpress = this.depExists(pkg, "express") || this.depExists(pkg, "fastify") || this.depExists(pkg, "hono");
    const hasTypeScript = this.devDepExists(pkg, "typescript") || this.fileExists(join(projectPath, "tsconfig.json"));
    const hasPrisma = this.depExists(pkg, "@prisma/client") || this.fileExists(join(projectPath, "prisma/schema.prisma"));
    const hasVite = this.devDepExists(pkg, "vite");

    // 3. Collect top-level dirs
    const topDirs = this.listDirs(projectPath).slice(0, 20);

    // 4. Count source files
    const srcFileCount = this.countSourceFiles(projectPath, 3);

    // 5. Key scripts
    const scripts = Object.keys(pkg.scripts ?? {}).slice(0, 10);

    // 6. Build summary
    const lines: string[] = [
      `# Architecture Summary`,
      ``,
      `**Project:** ${pkg.name ?? "unknown"} ${pkg.version ? `v${pkg.version}` : ""}`,
      pkg.description ? `**Description:** ${pkg.description}` : "",
      ``,
      `## Stack`,
      ``,
    ];

    const stackItems: string[] = [];
    if (isMonorepo) stackItems.push("Monorepo (pnpm workspace)");
    if (hasTypeScript) stackItems.push("TypeScript");
    if (hasNextJs) stackItems.push("Next.js");
    if (hasReact && !hasNextJs) stackItems.push("React");
    if (hasVite) stackItems.push("Vite");
    if (hasExpress) stackItems.push("Node.js backend (Express/Fastify/Hono)");
    if (hasPrisma) stackItems.push("Prisma ORM");

    for (const item of stackItems) {
      lines.push(`- ${item}`);
    }

    lines.push(``, `## Structure`, ``);
    lines.push(`\`\`\``);
    for (const dir of topDirs) {
      lines.push(`${dir}/`);
    }
    lines.push(`\`\`\``);

    lines.push(
      ``,
      `## Stats`,
      ``,
      `- Source files: ~${srcFileCount}`,
      `- Scripts: ${scripts.join(", ")}`,
      ``,
      `## Key Dependencies`,
      ``,
    );

    const allDeps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ].filter(d => !d.startsWith("@types/")).slice(0, 20);

    for (const dep of allDeps) {
      lines.push(`- \`${dep}\``);
    }

    return lines.filter(l => l !== "").join("\n") + "\n";
  }

  private saveCache(content: string): void {
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      const meta: Omit<ArchSummaryCache, "content"> = {
        generatedAt: new Date().toISOString(),
        packageJsonMtime: this.getMtime(join(this.projectPath, "package.json")),
        tsconfigMtime: this.getMtime(join(this.projectPath, "tsconfig.json")),
      };
      const header = `<!-- CACHE:${JSON.stringify(meta)} -->\n`;
      writeFileSync(this.cachePath, header + content, "utf-8");
    } catch { /* non-fatal */ }
  }

  private fileExists(p: string): boolean {
    try { statSync(p); return true; } catch { return false; }
  }

  private depExists(pkg: PackageJson, name: string): boolean {
    return name in (pkg.dependencies ?? {});
  }

  private devDepExists(pkg: PackageJson, name: string): boolean {
    return name in (pkg.devDependencies ?? {});
  }

  private listDirs(dir: string): string[] {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
        .map(e => e.name)
        .sort();
    } catch { return []; }
  }

  private countSourceFiles(dir: string, maxDepth: number): number {
    const SRC_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".py", ".go", ".rs", ".java"]);
    let count = 0;
    const walk = (d: string, depth: number) => {
      if (depth > maxDepth) return;
      try {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
          if (entry.isDirectory()) walk(join(d, entry.name), depth + 1);
          else if (SRC_EXTS.has(extname(entry.name))) count++;
        }
      } catch { /* skip unreadable dirs */ }
    };
    walk(dir, 0);
    return count;
  }
}
