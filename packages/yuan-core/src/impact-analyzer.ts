/**
 * @module impact-analyzer
 * @description Impact Analysis Engine — analyzes the impact of code changes,
 * determines which files are affected, which tests should run, and whether
 * changes are breaking.
 *
 * Uses regex-based analysis consistent with the rest of yuan-core.
 * Integrates with CodebaseContext, TestIntelligence, and CrossFileRefactor.
 */

import { readFile } from "node:fs/promises";
import { join, basename, dirname, extname, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ─── Types ───

export interface AffectedFile {
  path: string;
  reason: string;
  confidence: number;
  type: "source" | "test" | "config" | "doc";
}

export interface AffectedTest {
  path: string;
  testName?: string;
  reason: string;
  priority: "must_run" | "should_run" | "optional";
}

export interface AffectedAPI {
  endpoint?: string;
  functionName: string;
  file: string;
  changeType: "signature" | "behavior" | "removed" | "added";
}

export interface ImpactBreakingChange {
  file: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low";
  suggestion: string;
}
export interface DeadCodeCandidate {
  file: string;
  symbol: string;
  kind: "export" | "type_export";
  confidence: number;
}

export interface TestCoverageInference {
  file: string;
  hasDirectTest: boolean;
  hasImporterTests: boolean;
  inferredCoverage: "high" | "medium" | "low" | "unknown";
  reason: string;
}

export interface RefactorStep {
  step: number;
  action: string;
  files: string[];
  risk: "low" | "medium" | "high";
}
export type RiskLevel = "minimal" | "low" | "moderate" | "high" | "critical";

export interface ImpactReport {
  changedFiles: string[];
  affectedFiles: AffectedFile[];
  affectedTests: AffectedTest[];
  affectedAPIs: AffectedAPI[];
  breakingChanges: ImpactBreakingChange[];
  deadCodeCandidates: DeadCodeCandidate[];
  testCoverage: TestCoverageInference[];
  refactorPlan: RefactorStep[];
  riskLevel: RiskLevel;
  summary: string;
  suggestedActions: string[];
}

export interface ImpactAnalyzerConfig {
  projectPath: string;
  maxDepth?: number;
  includeTests?: boolean;
  includeAPIs?: boolean;
  strictMode?: boolean;
}

// ─── Patterns ───

const EXPORT_PATTERN =
  /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g;

const IMPORT_FROM_PATTERN = /(?:import|from)\s+['"]([^'"]+)['"]/g;

const TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /__tests__\//,
];

const CONFIG_FILE_PATTERNS = [
  /\.config\.[jt]s$/,
  /tsconfig.*\.json$/,
  /package\.json$/,
  /\.env/,
  /\.eslintrc/,
];

const DOC_FILE_PATTERNS = [/\.md$/, /\.mdx$/, /\.txt$/, /CHANGELOG/];

const API_ENDPOINT_PATTERN =
  /\.(get|post|put|patch|delete|all|use)\s*\(\s*['"`]([^'"`]+)['"`]/g;

const FUNCTION_SIGNATURE_PATTERN =
  /export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
const TYPE_EXPORT_PATTERN =
  /export\s+(?:type|interface)\s+(\w+)/g;
const SYMBOL_USAGE_PATTERN =
  /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;

const FUNCTION_CALL_PATTERN =
  /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
// ─── Helpers ───

function classifyFile(filePath: string): AffectedFile["type"] {
  if (TEST_FILE_PATTERNS.some((p) => p.test(filePath))) return "test";
  if (CONFIG_FILE_PATTERNS.some((p) => p.test(filePath))) return "config";
  if (DOC_FILE_PATTERNS.some((p) => p.test(filePath))) return "doc";
  return "source";
}

function extractTypeExports(content: string): string[] {
  const out: string[] = [];
  const re = new RegExp(TYPE_EXPORT_PATTERN.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function fileNameWithoutExt(filePath: string): string {
  const base = basename(filePath);
  const ext = extname(base);
  return base.slice(0, -ext.length);
}
function resolveProjectPath(projectPath: string, filePath: string): string {
  return filePath.startsWith("/") ? filePath : join(projectPath, filePath);
}
function extractExports(content: string): string[] {
  const exports: string[] = [];
  const re = new RegExp(EXPORT_PATTERN.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    exports.push(m[1]);
  }
  return exports;
}

function extractSymbolUsage(content: string): string[] {
  const out: string[] = [];
  const re = new RegExp(SYMBOL_USAGE_PATTERN.source, "g");
  let m: RegExpExecArray | null;

  while ((m = re.exec(content)) !== null) {
    out.push(m[1]);
  }

  return out;
}

function extractFunctionCalls(content: string): string[] {
  const out: string[] = [];
  const re = new RegExp(FUNCTION_CALL_PATTERN.source, "g");
  let m: RegExpExecArray | null;

  while ((m = re.exec(content)) !== null) {
    out.push(m[1]);
  }

  return out;
}

function extractImportPaths(content: string): string[] {
  const paths: string[] = [];
  const re = new RegExp(IMPORT_FROM_PATTERN.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    paths.push(m[1]);
  }
  return paths;
}

function extractAPIs(
  content: string,
  filePath: string,
): AffectedAPI[] {
  const apis: AffectedAPI[] = [];
  const re = new RegExp(API_ENDPOINT_PATTERN.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    apis.push({
      endpoint: `${m[1].toUpperCase()} ${m[2]}`,
      functionName: m[1],
      file: filePath,
      changeType: "behavior",
    });
  }
  return apis;
}

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function gitDiff(
  projectPath: string,
  filePath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "HEAD", "--", filePath], {
      cwd: projectPath,
    });
    return stdout || null;
  } catch {
    return null;
  }
}

async function walkDir(dir: string, maxFiles = 5000): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const files: string[] = [];
  const queue = [dir];

  while (queue.length > 0 && files.length < maxFiles) {
    if(queue.length > 20000) break
    const current = queue.shift()!;
    try {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") {
          continue;
        }
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          queue.push(fullPath);
        } else if (/\.[jt]sx?$|\.json$/.test(entry.name)) {
          files.push(fullPath);
        }
      }
    } catch {
      // skip inaccessible directories
    }
  }
  return files;
}

// ─── ImpactAnalyzer ───

export class ImpactAnalyzer {
  private readonly projectPath: string;
  private readonly maxDepth: number;
  private readonly includeTests: boolean;
  private readonly includeAPIs: boolean;
  private readonly strictMode: boolean;
   private symbolGraph?: SymbolGraph;
  constructor(config: ImpactAnalyzerConfig) {
    this.projectPath = config.projectPath;
    this.maxDepth = config.maxDepth ?? 3;
    this.includeTests = config.includeTests ?? true;
    this.includeAPIs = config.includeAPIs ?? true;
    this.strictMode = config.strictMode ?? false;
  }

  /**
   * Full impact analysis for a set of changed files.
   */
  async analyzeChanges(changedFiles: string[]): Promise<ImpactReport> {
    try {
    const graph = await this.getGraph();
    await graph.update(
      changedFiles.map((f) => resolveProjectPath(this.projectPath, f)),
    );
    const cycles = graph.detectCycles();
      const [
        affectedFiles,
        affectedTests,
        affectedAPIs,
        breakingChanges,
        deadCodeCandidates,
        testCoverage,
        refactorPlan,
      ] =
        await Promise.all([
          this.collectAffectedFiles(changedFiles),
          this.includeTests ? this.suggestTests(changedFiles) : Promise.resolve([]),
          this.includeAPIs ? this.collectAffectedAPIs(changedFiles) : Promise.resolve([]),
          this.detectBreaking(changedFiles),
        this.detectDeadCode(changedFiles),
          this.inferTestCoverage(changedFiles),
          this.buildSafeRefactorPlan(changedFiles),
        ]);

      const riskLevel = this.estimateRisk({
        files: changedFiles,
        linesChanged: affectedFiles.length * 20, // rough estimate
      });

     let summary = this.buildSummary(
        changedFiles,
        affectedFiles,
        affectedTests,
        breakingChanges,
        riskLevel,
      );
if (cycles.length > 0) {
  summary += ` ${cycles.length} dependency cycle(s) detected.`;
}
      const suggestedActions = this.buildSuggestedActions(
        affectedTests,
        breakingChanges,
        riskLevel,
        deadCodeCandidates,
        testCoverage,
      );

      return {
        changedFiles,
        affectedFiles,
        affectedTests,
        affectedAPIs,
        breakingChanges,
        deadCodeCandidates,
        testCoverage,
        refactorPlan,
        riskLevel,
        summary,
        suggestedActions,
      };
    } catch {
      return {
        changedFiles,
        affectedFiles: [],
        affectedTests: [],
        affectedAPIs: [],
        deadCodeCandidates: [],
        testCoverage: [],
        refactorPlan: [],
        breakingChanges: [],
        riskLevel: "minimal",
        summary: "Impact analysis could not be completed.",
        suggestedActions: [],
      };
    }
  }

  /**
   * Find all files affected by changes to a specific file.
   */
  async findAffectedFiles(filePath: string): Promise<AffectedFile[]> {
    try {
      const absoluteFilePath = resolveProjectPath(this.projectPath, filePath);
      const content = await readFileSafe(absoluteFilePath);
      if (!content) return [];

      const exports = extractExports(content);
      const changedName = basename(absoluteFilePath).replace(/\.[jt]sx?$/, "");
      const graph = await this.getGraph();

      const affected: AffectedFile[] = [];
      const seen = new Set<string>();

      // BFS through import graph
      const queue: Array<{ file: string; depth: number; reason: string; confidence: number }> = [];

const importers = graph.reverseImports.get(changedName) ?? new Set<string>();

for (const importer of importers) {
  if (seen.has(importer) || importer === absoluteFilePath) continue;

  queue.push({
    file: importer,
    depth: 1,
    reason: `imports changed module "${changedName}"`,
    confidence: 0.95,
  });
}

      // Process queue up to maxDepth
      while (queue.length > 0) {
        const { file, depth, reason, confidence } = queue.shift()!;
        if (seen.has(file)) continue;
        seen.add(file);

        const fileType = classifyFile(file);
        affected.push({
          path: file,
          reason,
          confidence: Math.round(confidence * 100) / 100,
          type: fileType,
        });

        if (depth < this.maxDepth) {
 const transitiveKey = basename(file).replace(/\.[jt]sx?$/, "");
 const nextImporters = graph.reverseImports.get(transitiveKey) ?? new Set<string>();

for (const pf of nextImporters) {
  if (seen.has(pf)) continue;

  queue.push({
    file: pf,
    depth: depth + 1,
    reason: `transitively affected via "${transitiveKey}"`,
    confidence: confidence * 0.7,
  });
}
        }
      }

      // If an export is a function/class used in test files, flag those too
      if (this.includeTests) {
for (const [pf, pfContent] of graph.fileContents.entries()) {
  if (seen.has(pf) || pf === absoluteFilePath) continue;

 const usesExport = exports.some((exp) =>
   new RegExp(`\\b${exp}\\b`).test(pfContent)
 );

  if (usesExport) {
    affected.push({
      path: pf,
       reason: `test for changed module "${changedName}"`,
      confidence: 0.8,
      type: "test",
    });
  }
}
      }

      return affected;
    } catch {
      return [];
    }
  }

  /**
   * Estimate risk level for a set of changes.
   */
  estimateRisk(changes: { files: string[]; linesChanged: number }): RiskLevel {
    let score = 0;
    score += changes.files.length * 2;
    score += changes.linesChanged / 100;

    for (const file of changes.files) {
      if (/config|package\.json|tsconfig/.test(file)) score += 5;
      if (/index\.[jt]sx?$|main\.[jt]sx?$|app\.[jt]sx?$/.test(file)) score += 3;
    }

    if (changes.files.length > 10) score += 5;

    if (this.strictMode) {
      score *= 1.3;
    }

    if (score <= 3) return "minimal";
    if (score <= 6) return "low";
    if (score <= 10) return "moderate";
    if (score <= 15) return "high";
    return "critical";
  }

  /**
   * Suggest which tests should run for the given changed files.
   */
  async suggestTests(changedFiles: string[]): Promise<AffectedTest[]> {
    try {
      const graph = await this.getGraph();
      const projectFiles = await walkDir(this.projectPath);
      const testFiles = projectFiles.filter((f) =>
        TEST_FILE_PATTERNS.some((p) => p.test(f)),
      );
      const tests: AffectedTest[] = [];
      const seen = new Set<string>();

      for (const changedFile of changedFiles) {
        const changedName = fileNameWithoutExt(changedFile);
        const changedDir = dirname(changedFile);

        for (const tf of testFiles) {
          if (seen.has(tf)) continue;
          const testName = basename(tf);

          // Direct test file by naming convention
          if (
            testName === `${changedName}.test.ts` ||
            testName === `${changedName}.test.tsx` ||
            testName === `${changedName}.spec.ts` ||
            testName === `${changedName}.spec.tsx`
          ) {
            seen.add(tf);
            tests.push({
              path: tf,
              reason: `direct test for "${changedName}"`,
              priority: "must_run",
            });
            continue;
          }

          // __tests__ directory convention
          if (
            tf.includes("__tests__") &&
            basename(tf).startsWith(changedName)
          ) {
            seen.add(tf);
            tests.push({
              path: tf,
              reason: `__tests__ convention for "${changedName}"`,
              priority: "must_run",
            });
            continue;
          }

          // Test imports the changed module
          const tfContent = graph.fileContents.get(tf) ?? await readFileSafe(tf);
          if (!tfContent) continue;

          const importPaths = extractImportPaths(tfContent);
          if (importPaths.some((ip) => ip.includes(changedName))) {
            seen.add(tf);
            tests.push({
              path: tf,
              reason: `imports changed module "${changedName}"`,
              priority: "should_run",
            });
            continue;
          }

          // Nearby test in same directory
          if (dirname(tf) === changedDir && !seen.has(tf)) {
            seen.add(tf);
            tests.push({
              path: tf,
              reason: `nearby test in same directory`,
              priority: "optional",
            });
          }
        }
      }

      // Sort: must_run first, then should_run, then optional
      const priorityOrder = { must_run: 0, should_run: 1, optional: 2 };
      tests.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

      return tests;
    } catch {
      return [];
    }
  }

  /**
   * Detect breaking changes in the given files.
   * If diffs are provided, analyzes them; otherwise attempts git diff.
   */
  async detectBreaking(
    changedFiles: string[],
    diffs?: string[],
  ): Promise<ImpactBreakingChange[]> {
    try {
      const breaking: ImpactBreakingChange[] = [];
      const renameMap = new Map<string, string>();
      for (let i = 0; i < changedFiles.length; i++) {
        const file = changedFiles[i];
        const resolvedFile = resolveProjectPath(this.projectPath, file);
        const diff = diffs?.[i] ?? (await gitDiff(this.projectPath, resolvedFile));
        if (!diff) continue;

        const lines = diff.split("\n");

        for (const line of lines) {
          // Removed export
          if (/^-\s*export\s+/.test(line) && !line.startsWith("---")) {
            const exportMatch = line.match(
              /^-\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/,
            );
            if (exportMatch) {
              // Check if it was renamed (corresponding + line with same kind)
              const exportName = exportMatch[1];
              const hasReplacement = lines.some((l) =>
                new RegExp(`^\\+\\s*export\\s+.*\\b${exportName}\\b`).test(l),
              );

              if (!hasReplacement) {
                breaking.push({
                  file,
                  description: `Removed export "${exportName}"`,
                  severity: "critical",
                  suggestion: `Restore the export or add a deprecation notice and re-export from a compatibility module.`,
                });
              }
            }
          }

          // Changed function signature (removed params)
          if (
            /^-\s*export\s+(?:default\s+)?(?:async\s+)?function\s+\w+\s*\(/.test(line) &&
            !line.startsWith("---")
          ) {
            const oldSigMatch = line.match(
              /^-\s*export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/,
            );
            if (oldSigMatch) {
              const fnName = oldSigMatch[1];
              const oldParams = oldSigMatch[2]
                .split(",")
                .map((p) => p.trim())
                .filter(Boolean);

              // Find the new signature
              const newSigLine = lines.find((l) =>
                new RegExp(
                  `^\\+\\s*export\\s+(?:default\\s+)?(?:async\\s+)?function\\s+${fnName}\\s*\\(`,
                ).test(l),
              );

              if (newSigLine) {
                const newSigMatch = newSigLine.match(
                  /function\s+\w+\s*\(([^)]*)\)/,
                );
                if (newSigMatch) {
                  const newParams = newSigMatch[1]
                    .split(",")
                    .map((p) => p.trim())
                    .filter(Boolean);

                  if (newParams.length < oldParams.length) {
                    breaking.push({
                      file,
                      description: `Function "${fnName}" lost parameters (${oldParams.length} → ${newParams.length})`,
                      severity: "high",
                      suggestion: `Make removed parameters optional or provide default values to maintain backward compatibility.`,
                    });
                  } else if (newParams.length > oldParams.length) {
                    // Check if new params are optional
                    const addedParams = newParams.slice(oldParams.length);
                    const allOptional = addedParams.every(
                      (p) => p.includes("?") || p.includes("="),
                    );
                    if (!allOptional) {
                      breaking.push({
                        file,
                        description: `Function "${fnName}" added required parameters`,
                        severity: "high",
                        suggestion: `Make new parameters optional or provide default values.`,
                      });
                    }
                  }
                }
              }
            }
          }
        }

        // Check for renamed exports (export existed before, now different name)
        const removedExports = lines
          .filter((l) => /^-\s*export\s+/.test(l) && !l.startsWith("---"))
          .map((l) => {
            const m = l.match(/(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/);
            return m?.[1];
          })
          .filter(Boolean) as string[];

        const addedExports = lines
          .filter((l) => /^\+\s*export\s+/.test(l) && !l.startsWith("+++"))
          .map((l) => {
            const m = l.match(/(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/);
            return m?.[1];
          })
          .filter(Boolean) as string[];

        // If same number removed & added, likely renames
        if (removedExports.length > 0 && removedExports.length === addedExports.length) {
          for (let j = 0; j < removedExports.length; j++) {
            if (removedExports[j] !== addedExports[j]) {
              renameMap.set(removedExports[j], addedExports[j]);
              // Already reported as removed? Skip duplication
              if (!breaking.some((b) => b.description.includes(removedExports[j]))) {
                breaking.push({
                  file,
                  description: `Export renamed: "${removedExports[j]}" → "${addedExports[j]}"`,
                  severity: "medium",
                  suggestion: `Add a re-export alias: export { ${addedExports[j]} as ${removedExports[j]} }`,
                });
              }
            }
          }
        }
        if (renameMap.size > 0) {
          const renamedOldNames = new Set(renameMap.keys());
          for (let k = breaking.length - 1; k >= 0; k--) {
            const item = breaking[k];
            if (
              item.file === file &&
              item.severity === "critical"
            ) {
              const m = item.description.match(/^Removed export "(.+)"$/);
              if (m && renamedOldNames.has(m[1])) {
                breaking.splice(k, 1);
              }
            }
          }
        }
      }

       // ─── rename impact propagation ───
      if (renameMap.size > 0) {
        const graph = await this.getGraph();

        for (const [oldName, newName] of renameMap.entries()) {
          for (const [usageFile, usages] of graph.symbolUsage.entries()) {
            if (!usages.includes(oldName)) continue;

            if (!breaking.some(
              (b) =>
                b.file === usageFile &&
                b.description === `Symbol "${oldName}" renamed to "${newName}"`,
            )) {
              breaking.push({
                file: usageFile,
                description: `Symbol "${oldName}" renamed to "${newName}"`,
                severity: "high",
                suggestion: `Update import or usage to "${newName}".`,
              });
            }
          }
        }
        for (const [file, calls] of graph.callGraph.entries()) {
          for (const [oldName, newName] of renameMap.entries()) {
            if (!calls.includes(oldName)) continue;

            if (!breaking.some(
              (b) =>
                b.file === file &&
                b.description === `Call to renamed function "${oldName}"`,
            )) {
              breaking.push({
                file,
                description: `Call to renamed function "${oldName}"`,
                severity: "high",
                suggestion: `Update call to "${newName}".`,
              });
            }
          }
        }
      }

      return breaking;
    } catch {
      
      return [];
    }
  }

  /**
   * Format an impact report as compact markdown for LLM context injection.
   */
  formatForPrompt(report: ImpactReport): string {
    const lines: string[] = [];

    lines.push("## Impact Analysis");
    lines.push(`**Risk Level:** ${report.riskLevel}`);
    lines.push(`**Changed Files:** ${report.changedFiles.length}`);
    lines.push(`**Affected Files:** ${report.affectedFiles.length}`);
    lines.push("");
    lines.push(report.summary);

    if (report.breakingChanges.length > 0) {
      lines.push("");
      lines.push("### Breaking Changes");
      for (const bc of report.breakingChanges) {
        lines.push(`- **[${bc.severity}]** ${bc.description} (${bc.file})`);
        lines.push(`  → ${bc.suggestion}`);
      }
    }

    if (report.affectedTests.length > 0) {
      lines.push("");
      lines.push("### Tests to Run");
      const mustRun = report.affectedTests.filter((t) => t.priority === "must_run");
      const shouldRun = report.affectedTests.filter((t) => t.priority === "should_run");
      if (mustRun.length > 0) {
        lines.push("**Must run:**");
        for (const t of mustRun) lines.push(`- ${t.path}`);
      }
      if (shouldRun.length > 0) {
        lines.push("**Should run:**");
        for (const t of shouldRun) lines.push(`- ${t.path}`);
      }
    }

    if (report.affectedAPIs.length > 0) {
      lines.push("");
      lines.push("### Affected APIs");
      for (const api of report.affectedAPIs) {
        lines.push(`- ${api.endpoint ?? api.functionName} (${api.changeType}) in ${api.file}`);
      }
    }

    if (report.suggestedActions.length > 0) {
      lines.push("");
      lines.push("### Suggested Actions");
      for (const action of report.suggestedActions) {
        lines.push(`- ${action}`);
      }
    }

    return lines.join("\n");
  }

  // ─── Private Helpers ───

  private async collectAffectedFiles(
    changedFiles: string[],
  ): Promise<AffectedFile[]> {
    const all: AffectedFile[] = [];
    const seen = new Set<string>();

    for (const file of changedFiles) {
      const affected = await this.findAffectedFiles(file);
      for (const af of affected) {
        if (!seen.has(af.path) && !changedFiles.includes(af.path)) {
          seen.add(af.path);
          all.push(af);
        }
      }
    }
    return all;
  }

  private async collectAffectedAPIs(
    changedFiles: string[],
  ): Promise<AffectedAPI[]> {
    const apis: AffectedAPI[] = [];
    const graph = await this.getGraph();
    for (const file of changedFiles) {
 const resolvedFile = resolveProjectPath(this.projectPath, file);
      const content = graph.fileContents.get(resolvedFile) ?? await readFileSafe(resolvedFile);
      if (!content) continue;

      const fileAPIs = extractAPIs(content, file);
      apis.push(...fileAPIs);
      const endpoints = graph.apiEndpoints.get(resolvedFile) ?? [];
      for (const ep of endpoints) {
        if (!ep) continue;
        if (!apis.some((a) => a.endpoint === ep && a.file === file)) {
          apis.push({
            endpoint: ep,
            functionName: ep,
            file,
            changeType: "behavior",
          });
        }
      }
      // Also extract exported functions as potential API surface
      const exports = extractExports(content);
      for (const exp of exports) {
        if (!apis.some((a) => a.functionName === exp && a.file === file)) {
          apis.push({
            functionName: exp,
            file,
            changeType: "behavior",
          });
        }
      }
    }
    return apis;
  }
  private async getGraph(): Promise<SymbolGraph> {
    if (!this.symbolGraph) {
      this.symbolGraph = await SymbolGraph.build(this.projectPath);
    }
    return this.symbolGraph;
  }
  private buildSummary(
    changedFiles: string[],
    affectedFiles: AffectedFile[],
    affectedTests: AffectedTest[],
    breakingChanges: ImpactBreakingChange[],
    riskLevel: RiskLevel,
  ): string {
    const parts: string[] = [];
    parts.push(
      `${changedFiles.length} file(s) changed, affecting ${affectedFiles.length} other file(s).`,
    );

    if (affectedTests.length > 0) {
      const mustRun = affectedTests.filter((t) => t.priority === "must_run").length;
      parts.push(`${affectedTests.length} test(s) identified (${mustRun} must run).`);
    }

    if (breakingChanges.length > 0) {
      const critical = breakingChanges.filter((b) => b.severity === "critical").length;
      parts.push(
        `${breakingChanges.length} breaking change(s) detected${critical > 0 ? ` (${critical} critical)` : ""}.`,
      );
    }

    parts.push(`Risk level: ${riskLevel}.`);
    return parts.join(" ");
  }

  private async detectDeadCode(
    changedFiles: string[],
  ): Promise<DeadCodeCandidate[]> {
    const graph = await this.getGraph();
    const out: DeadCodeCandidate[] = [];

    for (const file of changedFiles) {
      const resolvedFile = resolveProjectPath(this.projectPath, file);
      const exports = graph.exportsByFile.get(resolvedFile) ?? [];
      const typeExports = graph.typeExportsByFile.get(resolvedFile) ?? [];

      for (const symbol of exports) {
        let used = false;
        for (const [otherFile, usages] of graph.symbolUsage.entries()) {
          if (otherFile === resolvedFile) continue;
          if (usages.includes(symbol)) {
            used = true;
            break;
          }
        }
        if (!used) {
          out.push({
            file,
            symbol,
            kind: "export",
            confidence: 0.75,
          });
        }
      }

      for (const symbol of typeExports) {
        let used = false;
        for (const [otherFile, usages] of graph.symbolUsage.entries()) {
          if (otherFile === resolvedFile) continue;
          if (usages.includes(symbol)) {
            used = true;
            break;
          }
        }
        if (!used) {
          out.push({
            file,
            symbol,
            kind: "type_export",
            confidence: 0.7,
          });
        }
      }
    }

    return out;
  }

  private async inferTestCoverage(
    changedFiles: string[],
  ): Promise<TestCoverageInference[]> {
    const tests = await this.suggestTests(changedFiles);
    const out: TestCoverageInference[] = [];

    for (const file of changedFiles) {
      const changedName = fileNameWithoutExt(file);
      const direct = tests.some(
        (t) =>
          basename(t.path) === `${changedName}.test.ts` ||
          basename(t.path) === `${changedName}.test.tsx` ||
          basename(t.path) === `${changedName}.spec.ts` ||
          basename(t.path) === `${changedName}.spec.tsx`,
      );

      const importerTests = tests.some((t) => t.reason.includes("imports changed module"));

      let inferredCoverage: "high" | "medium" | "low" | "unknown" = "unknown";
      let reason = "No clear signals.";

      if (direct) {
        inferredCoverage = "high";
        reason = "Direct test file exists.";
      } else if (importerTests) {
        inferredCoverage = "medium";
        reason = "Importer-based tests exist.";
      } else {
        inferredCoverage = "low";
        reason = "No direct or importer-linked tests found.";
      }

      out.push({
        file,
        hasDirectTest: direct,
        hasImporterTests: importerTests,
        inferredCoverage,
        reason,
      });
    }

    return out;
  }

  private async buildSafeRefactorPlan(
    changedFiles: string[],
  ): Promise<RefactorStep[]> {
    const graph = await this.getGraph();
    const steps: RefactorStep[] = [];
    let step = 1;

    for (const file of changedFiles) {
      const resolvedFile = resolveProjectPath(this.projectPath, file);
      const moduleKey = basename(resolvedFile).replace(/\.[jt]sx?$/, "");
      const importers = [...(graph.reverseImports.get(moduleKey) ?? new Set<string>())];
      const exportedSymbols = graph.exportsByFile.get(resolvedFile) ?? [];
      steps.push({
        step: step++,
        action: `Stabilize exports in ${file} with compatibility alias if needed.`,
        files: [file],
        risk: "low",
      });

      if (importers.length > 0) {
        steps.push({
          step: step++,
          action: `Update importer references for ${file}.`,
          files: importers,
          risk: "medium",
        });
      }

      const callSites = [...graph.callGraph.entries()]
        .filter(([, calls]) =>
          exportedSymbols.some((symbol) => calls.includes(symbol)),
        )
        .map(([callFile]) => callFile);

      if (callSites.length > 0) {
        steps.push({
          step: step++,
          action: `Review call sites potentially affected by refactor in ${file}.`,
          files: callSites,
          risk: "high",
        });
      }
    }

    return steps;
  }

  private buildSuggestedActions(
    affectedTests: AffectedTest[],
    breakingChanges: ImpactBreakingChange[],
    riskLevel: RiskLevel,
    deadCodeCandidates: DeadCodeCandidate[] = [],
    testCoverage: TestCoverageInference[] = [],
  ): string[] {
    const actions: string[] = [];

    const mustRun = affectedTests.filter((t) => t.priority === "must_run");
    if (mustRun.length > 0) {
      actions.push(`Run ${mustRun.length} critical test(s) before merging.`);
    }

    for (const bc of breakingChanges) {
      if (bc.severity === "critical" || bc.severity === "high") {
        actions.push(bc.suggestion);
      }
    }
    if (deadCodeCandidates.length > 0) {
      actions.push(`Review ${deadCodeCandidates.length} dead code candidate(s) before deleting exports.`);
    }

    if (testCoverage.some((t) => t.inferredCoverage === "low")) {
      actions.push("Add tests for changed modules with low inferred coverage.");
    }
    if (riskLevel === "high" || riskLevel === "critical") {
      actions.push("Request a thorough code review before merging.");
    }

    if (riskLevel === "critical") {
      actions.push("Consider splitting this change into smaller, incremental PRs.");
    }



    return actions;
  }
}
// ─── Symbol Graph Cache ───

class SymbolGraph {
  readonly fileContents = new Map<string, string>();
  readonly exportsByFile = new Map<string, string[]>();
  readonly typeExportsByFile = new Map<string, string[]>();
  readonly importsByFile = new Map<string, string[]>();
  readonly reverseImports = new Map<string, Set<string>>();
  readonly apiEndpoints = new Map<string, string[]>();
 readonly symbolUsage = new Map<string, string[]>();
  readonly callGraph = new Map<string, string[]>();
  /**
   * Incrementally update graph for changed files.
   */
  async update(files: string[]): Promise<void> {
    for (const file of files) {
      const content = await readFileSafe(file);

      if (!content) {
        this.removeFile(file);
        continue;
      }

      const prevImports = this.importsByFile.get(file) ?? [];

      // remove previous reverse edges
      for (const imp of prevImports) {
        const base = basename(imp).replace(/\.[jt]sx?$/, "");
        const set = this.reverseImports.get(base);
        if (set) {
          set.delete(file);
          if (set.size === 0) this.reverseImports.delete(base);
        }
      }

      const exports = extractExports(content);
      const typeExports = extractTypeExports(content);
      const imports = extractImportPaths(content);
      const apis = extractAPIs(content, file);
const symbols = extractSymbolUsage(content);
const calls = extractFunctionCalls(content);
      this.fileContents.set(file, content);
      this.exportsByFile.set(file, exports);
      this.typeExportsByFile.set(file, typeExports);
      this.importsByFile.set(file, imports);
this.symbolUsage.set(file, symbols);
this.callGraph.set(file, calls);
      this.apiEndpoints.set(
        file,
        apis.map((a) => a.endpoint).filter((ep): ep is string => Boolean(ep)),
      );
      for (const imp of imports) {
        const base = basename(imp).replace(/\.[jt]sx?$/, "");

        if (!this.reverseImports.has(base)) {
          this.reverseImports.set(base, new Set());
        }

        this.reverseImports.get(base)!.add(file);
      }
    }
  }

  private removeFile(file: string) {
    const prevImports = this.importsByFile.get(file) ?? [];

    for (const imp of prevImports) {
     const base = basename(imp).replace(/\.[jt]sx?$/, "");
      const set = this.reverseImports.get(base);
      if (set) {
        set.delete(file);
        if (set.size === 0) this.reverseImports.delete(base);
      }
    }

    this.fileContents.delete(file);
    this.exportsByFile.delete(file);
    this.typeExportsByFile.delete(file);
    this.importsByFile.delete(file);
    this.apiEndpoints.delete(file);
  this.symbolUsage.delete(file);
this.callGraph.delete(file);
  }
  static async build(projectPath: string): Promise<SymbolGraph> {
    const graph = new SymbolGraph();

    const files = await walkDir(projectPath);

    const contents = await Promise.all(
      files.map(async (f) => [f, await readFileSafe(f)] as const),
    );

    for (const [file, content] of contents) {
      if (!content) continue;

      graph.fileContents.set(file, content);

      const exports = extractExports(content);
      const typeExports = extractTypeExports(content);
      const imports = extractImportPaths(content);
      const apis = extractAPIs(content, file);
const symbols = extractSymbolUsage(content);
const calls = extractFunctionCalls(content);
      graph.exportsByFile.set(file, exports);
      graph.typeExportsByFile.set(file, typeExports);
      graph.importsByFile.set(file, imports);
graph.symbolUsage.set(file, symbols);
graph.callGraph.set(file, calls);
      graph.apiEndpoints.set(
        file,
        apis.map((a) => a.endpoint).filter((ep): ep is string => Boolean(ep)),
      );
      for (const imp of imports) {
        const base = basename(imp).replace(/\.[jt]sx?$/, "");

        if (!graph.reverseImports.has(base)) {
          graph.reverseImports.set(base, new Set());
        }

        graph.reverseImports.get(base)!.add(file);
      }
    }

    return graph;
  }
  detectCycles(): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const stack = new Set<string>();

    const visit = (node: string, path: string[]) => {
      if (stack.has(node)) {
        const cycleStart = path.indexOf(node);
        cycles.push(path.slice(cycleStart));
        return;
      }

      if (visited.has(node)) return;

      visited.add(node);
      stack.add(node);

      const imports = this.importsByFile.get(node) ?? [];

      for (const imp of imports) {
        const base = basename(imp).replace(/\.[jt]sx?$/, "");

        for (const [file] of this.fileContents) {
          if (basename(file).replace(/\.[jt]sx?$/, "") === base) {
            visit(file, [...path, file]);
          }
        }
      }

      stack.delete(node);
    };

    for (const file of this.fileContents.keys()) {
      visit(file, [file]);
    }

    return cycles;
  }
}