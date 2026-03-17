/**
 * @module pre-write-validator
 * @description Validates code quality BEFORE writing to file.
 * Catches: TODO/stub, unbalanced braces, empty functions, any types.
 * Context-aware: checks changed hunks, respects file role.
 * Role: QUALITY GATE only. Does NOT protect paths or manage budget.
 */

export type FileRole = "source" | "test" | "config" | "doc" | "fixture" | "generated";

export interface ValidationContext {
  path: string;
  language?: string;
  fileRole: FileRole;
  changedHunksOnly: boolean;
}

export interface PreWriteIssue {
  severity: "error" | "warning";
  message: string;
  line?: number;
}

export interface PreWriteResult {
  valid: boolean;
  issues: PreWriteIssue[];
  blockedReason?: string;
}

/** Detect file role from path */
export function detectFileRole(path: string): FileRole {
  if (/\.(test|spec)\.[jt]sx?$/.test(path)) return "test";
  if (/\.(md|txt|rst|adoc)$/.test(path)) return "doc";
  if (/(fixture|mock|stub|sample|example)/.test(path)) return "fixture";
  if (/(dist|build|\.next|__generated__|\.gen\.)/.test(path)) return "generated";
  if (/\.(json|yaml|yml|toml|ini|conf|config)/.test(path) || /(tsconfig|package\.json|\.eslintrc)/.test(path)) return "config";
  return "source";
}

/** Validate content before writing */
export function validateBeforeWrite(content: string, ctx: ValidationContext): PreWriteResult {
  const issues: PreWriteIssue[] = [];
  const role = ctx.fileRole;

  // Generated files: never validate
  if (role === "generated") return { valid: true, issues: [] };

  // Config files: minimal validation
  if (role === "config") {
    // Check JSON validity for .json files
    if (ctx.path.endsWith(".json")) {
      try { JSON.parse(content); } catch { issues.push({ severity: "error", message: "Invalid JSON" }); }
    }
    return { valid: issues.filter(i => i.severity === "error").length === 0, issues };
  }

  // Source/test files: full validation
  const lines = content.split("\n");

  // 1. TODO/FIXME/HACK in source (not test/doc/fixture)
  if (role === "source") {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Only flag if it's a code comment with TODO, not a string/doc
      if (/\/\/\s*(TODO|FIXME|HACK|XXX)\b/i.test(line) || /\/\*\s*(TODO|FIXME|HACK)\b/i.test(line)) {
        issues.push({ severity: "error", message: `TODO/FIXME/HACK comment at line ${i + 1}`, line: i + 1 });
      }
    }
  }

  // 2. Empty function body (not in interfaces/abstract/test)
  if (role === "source") {
    const emptyFunc = content.match(/\)\s*\{[\s\n]*\}/g);
    if (emptyFunc && emptyFunc.length > 0) {
      // Check it's not an interface or abstract method
      for (const match of emptyFunc) {
        const matchIdx = content.indexOf(match);
        const preceding = content.slice(Math.max(0, matchIdx - 50), matchIdx);
        if (!/interface|abstract|noop|intentional/i.test(preceding)) {
          issues.push({ severity: "error", message: "Empty function body detected" });
          break;
        }
      }
    }
  }

  // 3. Brace balance
  const opens = (content.match(/\{/g) ?? []).length;
  const closes = (content.match(/\}/g) ?? []).length;
  if (Math.abs(opens - closes) > 1) {
    issues.push({ severity: "error", message: `Unbalanced braces: ${opens} opens, ${closes} closes` });
  }

  // 4. TypeScript: 'any' type usage (source only, not test)
  if (role === "source" && /\.tsx?$/.test(ctx.path)) {
    const anyMatches = content.match(/:\s*any\b/g);
    if (anyMatches && anyMatches.length > 0) {
      issues.push({ severity: "warning", message: `'any' type used ${anyMatches.length} time(s)` });
    }
  }

  // 5. console.log in production code (not test)
  if (role === "source" && /console\.(log|warn|error)\(/.test(content)) {
    issues.push({ severity: "warning", message: "console.log left in production code" });
  }

  // 6. throw new Error("not implemented") — stub
  if (role === "source" && /throw\s+new\s+Error\s*\(\s*["']not\s+implemented["']\s*\)/i.test(content)) {
    issues.push({ severity: "error", message: "Stub implementation: throw new Error('not implemented')" });
  }

  const errorCount = issues.filter(i => i.severity === "error").length;
  return {
    valid: errorCount === 0,
    issues,
    blockedReason: errorCount > 0 ? `${errorCount} quality issue(s) found` : undefined,
  };
}
