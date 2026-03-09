/**
 * @module test-intelligence
 * @description Test Intelligence System — discovers test files, maps source-to-test coverage,
 * detects affected tests for changed files, identifies coverage gaps, and generates test suggestions.
 *
 * Uses regex-based analysis (no external test runner dependency). Designed for the YUAN coding agent
 * to intelligently run only relevant tests and suggest missing test coverage.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve, dirname, extname, basename, relative } from "node:path";

// ─── Types ───

/** Represents a discovered test file with its metadata. */
export interface TestFile {
  /** Absolute file path */
  path: string;
  /** Detected test framework */
  framework: "vitest" | "jest" | "mocha" | "node_test" | "unknown";
  /** Extracted test cases */
  testCases: TestCase[];
  /** Absolute paths of files this test imports */
  imports: string[];
  /** Last known test run result */
  lastRun?: TestRunResult;
}

/** A single test case extracted from a test file. */
export interface TestCase {
  /** Test case description */
  name: string;
  /** Line number (1-based) */
  line: number;
  /** Inferred test type */
  type: "unit" | "integration" | "e2e";
  /** Tags extracted from test name or describe block */
  tags: string[];
}

/** Structured result of a test run. */
export interface TestRunResult {
  /** Test file path */
  file: string;
  /** Number of passed tests */
  passed: number;
  /** Number of failed tests */
  failed: number;
  /** Number of skipped tests */
  skipped: number;
  /** Total duration in milliseconds */
  duration: number;
  /** Errors from failed tests */
  errors: TestError[];
  /** Epoch timestamp of the run */
  timestamp: number;
}

/** A single test error with diagnostic info. */
export interface TestError {
  /** Name of the failing test */
  testName: string;
  /** Error message */
  message: string;
  /** Stack trace */
  stack?: string;
  /** File containing the error */
  file: string;
  /** Line number of the error */
  line?: number;
  /** Expected value (for assertion errors) */
  expected?: string;
  /** Actual value (for assertion errors) */
  actual?: string;
}

/** Result of affected test detection. */
export interface AffectedTestResult {
  /** Files that were changed */
  changedFiles: string[];
  /** Test files that directly import changed files */
  directTests: string[];
  /** Test files that indirectly depend on changed files */
  transitiveTests: string[];
  /** Integration/e2e tests in the same module */
  integrationTests: string[];
  /** Total number of affected tests */
  totalTests: number;
  /** Confidence score (0-1) for completeness */
  confidence: number;
  /** Reasoning for why each test was included */
  reasoning: string[];
}

/** A gap in test coverage. */
export interface CoverageGap {
  /** Source file path */
  file: string;
  /** Untested symbol name */
  symbol: string;
  /** Symbol type (function, class, etc.) */
  symbolType: string;
  /** Line number of the symbol */
  line: number;
  /** Reason for the gap */
  reason: string;
  /** Severity level */
  severity: "high" | "medium" | "low";
  /** Suggested test description */
  suggestion: string;
}

/** A suggestion for a new test. */
export interface TestSuggestion {
  /** Source file to test */
  targetFile: string;
  /** Symbol to test */
  targetSymbol: string;
  /** Where to write the test */
  testFile: string;
  /** Framework to use */
  framework: string;
  /** Suggested test cases */
  testCases: SuggestedTestCase[];
  /** Priority level */
  priority: "high" | "medium" | "low";
}

/** A suggested test case with hints for implementation. */
export interface SuggestedTestCase {
  /** Test description */
  name: string;
  /** Test case type */
  type: "happy_path" | "edge_case" | "error_case" | "boundary" | "null_check";
  /** Human-readable description */
  description: string;
  /** Suggested input hint */
  inputHint: string;
  /** Expected outcome hint */
  expectedHint: string;
}

/** Configuration for the Test Intelligence system. */
export interface TestIntelligenceConfig {
  /** Project root path */
  projectPath: string;
  /** Glob patterns for test files */
  testPatterns?: string[];
  /** Patterns to ignore */
  ignorePatterns?: string[];
  /** Max depth for reverse dependency traversal (default: 3) */
  maxTransitiveDepth?: number;
  /** Whether to include integration tests (default: true) */
  includeIntegrationTests?: boolean;
}

// ─── Constants ───

const DEFAULT_TEST_PATTERNS = [
  "**/*.test.ts",
  "**/*.spec.ts",
  "**/*.test.js",
  "**/*.spec.js",
  "**/__tests__/**/*.ts",
  "**/__tests__/**/*.js",
  "**/test/**/*.ts",
  "**/test/**/*.js",
];

const DEFAULT_IGNORE_PATTERNS = [
  "node_modules",
  "dist",
  "build",
  ".git",
  "coverage",
  ".next",
  ".turbo",
  "__pycache__",
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

/** Regex for test file naming conventions */
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$/;
const TEST_DIR_RE = /(?:^|[/\\])(?:__tests__|test)[/\\]/;
const INTEGRATION_TEST_RE = /\.(?:integration|e2e)\.(test|spec)\.(ts|tsx|js|jsx)$/;

// ─── Import parsing regex (mirrors dependency-analyzer.ts) ───

const IMPORT_RE =
  /import\s+(?:type\s+)?(?:\{([^}]*)\}|(\w+)|\*\s+as\s+(\w+))\s+from\s+["']([^"']+)["']/g;
const RE_EXPORT_RE = /export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
const REQUIRE_RE = /require\s*\(\s*["']([^"']+)["']\s*\)/g;

// ─── Test case extraction regex ───

const IT_RE = /it\(\s*['"`](.+?)['"`]\s*,/g;
const TEST_RE = /test\(\s*['"`](.+?)['"`]\s*,/g;
const DESCRIBE_RE = /describe\(\s*['"`](.+?)['"`]\s*,/g;

// ─── Framework detection regex ───

const VITEST_IMPORT_RE = /import\s+\{[^}]*\}\s+from\s+['"]vitest['"]/;
const VITEST_IMPORT_TEST_RE = /import\s+\{?\s*test\s*\}?\s+from\s+['"]vitest['"]/;
const NODE_TEST_RE = /import\s+(?:\{[^}]*\}|test)\s+from\s+['"]node:test['"]/;
const CHAI_RE = /require\s*\(\s*['"]chai['"]\s*\)/;

// ─── Symbol extraction regex (simplified from codebase-context.ts) ───

const EXPORT_SYMBOL_RE =
  /export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|interface|type|enum)\s+(\w+)/g;

/**
 * Test Intelligence System — discovers, maps, and analyzes test coverage.
 *
 * Provides affected test detection, coverage gap analysis, test suggestions,
 * and test command building for the YUAN coding agent.
 */
export class TestIntelligence {
  private config: Required<TestIntelligenceConfig>;
  private testFiles: Map<string, TestFile>;
  private sourceToTests: Map<string, string[]>;
  private testHistory: TestRunResult[];

  constructor(config: TestIntelligenceConfig) {
    this.config = {
      projectPath: resolve(config.projectPath),
      testPatterns: config.testPatterns ?? DEFAULT_TEST_PATTERNS,
      ignorePatterns: config.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS,
      maxTransitiveDepth: config.maxTransitiveDepth ?? 3,
      includeIntegrationTests: config.includeIntegrationTests ?? true,
    };
    this.testFiles = new Map();
    this.sourceToTests = new Map();
    this.testHistory = [];
  }

  // ─── Discovery ───

  /**
   * Scan the project for all test files, parse their content,
   * and build the internal test file index.
   *
   * @returns Array of discovered test files
   */
  async discoverTests(): Promise<TestFile[]> {
    const testPaths = await this.findTestFiles();
    this.testFiles.clear();

    for (const filePath of testPaths) {
      const content = await this.readFile(filePath);
      if (!content) continue;

      const framework = this.detectFramework(content);
      const testCases = this.parseTestCases(content, framework);
      const imports = this.parseTestImports(content, filePath);

      const testFile: TestFile = {
        path: filePath,
        framework,
        testCases,
        imports,
      };

      this.testFiles.set(filePath, testFile);
    }

    return [...this.testFiles.values()];
  }

  /**
   * Detect the test framework used in a file based on its content.
   *
   * Detection priority:
   * 1. Vitest (explicit import from 'vitest')
   * 2. Node.js test runner (import from 'node:test')
   * 3. Mocha (chai require)
   * 4. Jest (describe/it/test without vitest import)
   * 5. Unknown (fallback)
   *
   * @param content - File content to analyze
   * @returns Detected framework identifier
   */
  detectFramework(content: string): TestFile["framework"] {
    if (VITEST_IMPORT_RE.test(content) || VITEST_IMPORT_TEST_RE.test(content)) {
      return "vitest";
    }
    if (NODE_TEST_RE.test(content)) {
      return "node_test";
    }
    if (CHAI_RE.test(content)) {
      return "mocha";
    }
    // Jest uses describe/it/test as globals (no explicit import needed)
    const hasDescribe = /\bdescribe\s*\(/.test(content);
    const hasItOrTest = /\b(?:it|test)\s*\(/.test(content);
    if (hasDescribe && hasItOrTest) {
      return "jest";
    }
    if (hasItOrTest) {
      return "jest";
    }
    return "unknown";
  }

  /**
   * Extract test cases from file content.
   *
   * Parses `it()`, `test()`, and `describe()` blocks, infers test type
   * from naming patterns, and extracts tags from the description.
   *
   * @param content - File content to parse
   * @param _framework - Framework identifier (reserved for future framework-specific parsing)
   * @returns Array of extracted test cases
   */
  parseTestCases(content: string, _framework: string): TestCase[] {
    const cases: TestCase[] = [];
    const lines = content.split("\n");

    // Build a line lookup for fast line-number resolution
    const lineOffsets: number[] = [];
    let offset = 0;
    for (const line of lines) {
      lineOffsets.push(offset);
      offset += line.length + 1; // +1 for newline
    }

    const getLineNumber = (charIndex: number): number => {
      let lo = 0;
      let hi = lineOffsets.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (lineOffsets[mid] <= charIndex) {
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return lo; // 1-based
    };

    // Extract describe blocks for context
    const describeNames: string[] = [];
    const describeRe = new RegExp(DESCRIBE_RE.source, "g");
    let match: RegExpExecArray | null;
    while ((match = describeRe.exec(content)) !== null) {
      describeNames.push(match[1]);
    }

    // Extract it() cases
    const itRe = new RegExp(IT_RE.source, "g");
    while ((match = itRe.exec(content)) !== null) {
      const name = match[1];
      const line = getLineNumber(match.index);
      cases.push({
        name,
        line,
        type: this.inferTestType(name, describeNames),
        tags: this.extractTags(name),
      });
    }

    // Extract test() cases
    const testRe = new RegExp(TEST_RE.source, "g");
    while ((match = testRe.exec(content)) !== null) {
      const name = match[1];
      const line = getLineNumber(match.index);
      // Avoid duplicates (test() and it() may overlap in pattern matching)
      if (!cases.some((c) => c.line === line)) {
        cases.push({
          name,
          line,
          type: this.inferTestType(name, describeNames),
          tags: this.extractTags(name),
        });
      }
    }

    return cases;
  }

  /**
   * Build a mapping from source files to their corresponding test files.
   *
   * Uses two strategies:
   * 1. Import-based: checks what each test file imports
   * 2. Convention-based: maps test file names to source files
   *
   * @returns Map from source file path to array of test file paths
   */
  async buildTestMap(): Promise<Map<string, string[]>> {
    if (this.testFiles.size === 0) {
      await this.discoverTests();
    }

    this.sourceToTests.clear();

    for (const [testPath, testFile] of this.testFiles) {
      // Strategy 1: import-based mapping
      for (const importedFile of testFile.imports) {
        if (!this.isTestFile(importedFile)) {
          const existing = this.sourceToTests.get(importedFile) ?? [];
          if (!existing.includes(testPath)) {
            existing.push(testPath);
          }
          this.sourceToTests.set(importedFile, existing);
        }
      }

      // Strategy 2: convention-based mapping
      const sourceFile = this.findSourceForTest(testPath);
      if (sourceFile) {
        const existing = this.sourceToTests.get(sourceFile) ?? [];
        if (!existing.includes(testPath)) {
          existing.push(testPath);
        }
        this.sourceToTests.set(sourceFile, existing);
      }
    }

    return new Map(this.sourceToTests);
  }

  // ─── Affected Tests ───

  /**
   * Find all tests affected by a set of changed files.
   *
   * Algorithm:
   * 1. Direct: test files that directly import any changed file
   * 2. Transitive: test files that depend on changed files through intermediaries
   * 3. Integration: integration/e2e tests in the same module directory
   *
   * Confidence scoring:
   * - 1.0 if only direct tests found
   * - 0.8 if transitive depth <= 2
   * - 0.6 if transitive depth > 2
   * - -0.1 for each changed file without any test coverage
   *
   * @param changedFiles - Array of absolute file paths that changed
   * @returns Affected test result with confidence and reasoning
   */
  async findAffectedTests(changedFiles: string[]): Promise<AffectedTestResult> {
    if (this.sourceToTests.size === 0) {
      await this.buildTestMap();
    }

    const directTests = new Set<string>();
    const transitiveTests = new Set<string>();
    const integrationTests = new Set<string>();
    const reasoning: string[] = [];
    let maxDepthUsed = 0;
    let filesWithoutTests = 0;

    const resolvedChanged = changedFiles.map((f) => resolve(f));

    for (const changedFile of resolvedChanged) {
      // 1. Direct tests
      const directForFile = this.sourceToTests.get(changedFile) ?? [];
      if (directForFile.length === 0 && !this.isTestFile(changedFile)) {
        filesWithoutTests++;
      }
      for (const testPath of directForFile) {
        directTests.add(testPath);
        reasoning.push(`Direct: ${relative(this.config.projectPath, testPath)} imports ${relative(this.config.projectPath, changedFile)}`);
      }

      // If the changed file is itself a test, include it
      if (this.isTestFile(changedFile) && this.testFiles.has(changedFile)) {
        directTests.add(changedFile);
        reasoning.push(`Direct: ${relative(this.config.projectPath, changedFile)} is a test file that was modified`);
      }

      // 2. Transitive tests
      const visited = new Set<string>();
      const transitive = this.findTransitiveTestDeps(changedFile, this.config.maxTransitiveDepth, visited);
      for (const testPath of transitive) {
        if (!directTests.has(testPath)) {
          transitiveTests.add(testPath);
          const depth = visited.size;
          if (depth > maxDepthUsed) maxDepthUsed = depth;
          reasoning.push(`Transitive: ${relative(this.config.projectPath, testPath)} depends on ${relative(this.config.projectPath, changedFile)} (via reverse deps)`);
        }
      }

      // 3. Integration tests
      if (this.config.includeIntegrationTests) {
        const integrationForFile = this.findModuleIntegrationTests(changedFile);
        for (const testPath of integrationForFile) {
          if (!directTests.has(testPath) && !transitiveTests.has(testPath)) {
            integrationTests.add(testPath);
            reasoning.push(`Integration: ${relative(this.config.projectPath, testPath)} is an integration test in the same module as ${relative(this.config.projectPath, changedFile)}`);
          }
        }
      }
    }

    // Confidence scoring
    let confidence = 1.0;
    if (transitiveTests.size > 0) {
      confidence = maxDepthUsed > 2 ? 0.6 : 0.8;
    }
    confidence = Math.max(0, confidence - filesWithoutTests * 0.1);

    const allTests = new Set([...directTests, ...transitiveTests, ...integrationTests]);

    return {
      changedFiles: resolvedChanged,
      directTests: [...directTests],
      transitiveTests: [...transitiveTests],
      integrationTests: [...integrationTests],
      totalTests: allTests.size,
      confidence: Math.round(confidence * 100) / 100,
      reasoning,
    };
  }

  /**
   * Quick check: does a source file have any tests?
   *
   * @param sourceFile - Absolute path to the source file
   * @returns True if at least one test file covers this source
   */
  hasTests(sourceFile: string): boolean {
    const resolved = resolve(sourceFile);
    const tests = this.sourceToTests.get(resolved);
    return tests !== undefined && tests.length > 0;
  }

  /**
   * Get test file paths for a source file.
   *
   * @param sourceFile - Absolute path to the source file
   * @returns Array of absolute test file paths
   */
  getTestsFor(sourceFile: string): string[] {
    const resolved = resolve(sourceFile);
    return this.sourceToTests.get(resolved) ?? [];
  }

  // ─── Coverage Analysis ───

  /**
   * Find untested code (coverage gaps).
   *
   * For each source file, checks:
   * 1. Whether a corresponding test file exists
   * 2. Whether exported symbols are referenced in any test
   * 3. Whether error cases are tested
   *
   * @param files - Optional list of files to check (defaults to all source files)
   * @returns Array of coverage gaps
   */
  async findCoverageGaps(files?: string[]): Promise<CoverageGap[]> {
    if (this.sourceToTests.size === 0) {
      await this.buildTestMap();
    }

    const sourceFiles = files
      ? files.map((f) => resolve(f))
      : await this.collectSourceFiles();

    const gaps: CoverageGap[] = [];

    for (const filePath of sourceFiles) {
      if (this.isTestFile(filePath)) continue;

      const content = await this.readFile(filePath);
      if (!content) continue;

      const tests = this.sourceToTests.get(filePath) ?? [];
      const relPath = relative(this.config.projectPath, filePath);

      // No test file at all
      if (tests.length === 0) {
        // Extract exported symbols to report gaps
        const symbols = this.extractExportedSymbols(content);
        if (symbols.length > 0) {
          for (const sym of symbols) {
            gaps.push({
              file: filePath,
              symbol: sym.name,
              symbolType: sym.kind,
              line: sym.line,
              reason: "no test file",
              severity: "high",
              suggestion: `Add test for ${sym.kind} '${sym.name}' from ${relPath}`,
            });
          }
        } else {
          gaps.push({
            file: filePath,
            symbol: basename(filePath, extname(filePath)),
            symbolType: "module",
            line: 1,
            reason: "no test file",
            severity: "medium",
            suggestion: `Add test file for ${relPath}`,
          });
        }
        continue;
      }

      // Has test files — check if specific exported symbols are tested
      const symbols = this.extractExportedSymbols(content);
      let testContents = "";
      for (const testPath of tests) {
        const tc = await this.readFile(testPath);
        if (tc) testContents += "\n" + tc;
      }

      for (const sym of symbols) {
        const symbolRe = new RegExp(`\\b${this.escapeRegex(sym.name)}\\b`);
        if (!symbolRe.test(testContents)) {
          gaps.push({
            file: filePath,
            symbol: sym.name,
            symbolType: sym.kind,
            line: sym.line,
            reason: "untested function",
            severity: sym.exported ? "high" : "low",
            suggestion: `Add test for ${sym.kind} '${sym.name}' in ${relPath}`,
          });
        }
      }

      // Check for error case testing
      const hasThrows = /\bthrow\s+new\b/.test(content);
      const hasErrorTests = /\b(?:toThrow|rejects|throws|expect.*error|expect.*Error)\b/i.test(testContents);
      if (hasThrows && !hasErrorTests) {
        gaps.push({
          file: filePath,
          symbol: basename(filePath, extname(filePath)),
          symbolType: "module",
          line: 1,
          reason: "no error case",
          severity: "medium",
          suggestion: `Add error case tests for ${relPath} (has throw statements but no error assertions in tests)`,
        });
      }
    }

    return gaps;
  }

  /**
   * Suggest tests for a specific source file.
   *
   * Generates test case suggestions based on exported symbols,
   * their types, parameters, and common testing patterns.
   *
   * @param sourceFile - Absolute path to the source file
   * @param symbols - Optional list of specific symbol names to suggest tests for
   * @returns Array of test suggestions
   */
  suggestTests(sourceFile: string, symbols?: string[]): TestSuggestion[] {
    const resolved = resolve(sourceFile);
    const suggestions: TestSuggestion[] = [];

    // Read from cache if we have the content (best-effort, may need async)
    const testFile = this.inferTestFilePath(resolved);
    const existingTests = this.testFiles.get(testFile);
    const framework = existingTests?.framework ?? "vitest";

    // We need synchronous access, so we work with what we have in cache
    // For full analysis, callers should use findCoverageGaps() first
    const existingTestNames = new Set(
      existingTests?.testCases.map((tc) => tc.name) ?? [],
    );

    // Generate suggestions based on file naming patterns
    const fileName = basename(resolved, extname(resolved));
    const isClass = /[A-Z]/.test(fileName[0] ?? "");
    const targetSymbol = symbols?.[0] ?? fileName;

    const testCases: SuggestedTestCase[] = [];

    // Happy path
    testCases.push({
      name: `should ${isClass ? "create instance" : "return expected result"}`,
      type: "happy_path",
      description: `Verify ${targetSymbol} works with valid input`,
      inputHint: "valid input matching expected type",
      expectedHint: "expected return value or side effect",
    });

    // Edge case
    testCases.push({
      name: `should handle empty input`,
      type: "edge_case",
      description: `Verify ${targetSymbol} handles edge cases gracefully`,
      inputHint: "empty string, empty array, or zero",
      expectedHint: "graceful handling (default value or empty result)",
    });

    // Error case
    testCases.push({
      name: `should throw on invalid input`,
      type: "error_case",
      description: `Verify ${targetSymbol} rejects invalid input`,
      inputHint: "null, undefined, or malformed data",
      expectedHint: "throws appropriate error",
    });

    // Null check
    testCases.push({
      name: `should handle null/undefined`,
      type: "null_check",
      description: `Verify ${targetSymbol} handles nullish values`,
      inputHint: "null or undefined",
      expectedHint: "does not crash, returns default or throws",
    });

    // Boundary case
    testCases.push({
      name: `should handle boundary values`,
      type: "boundary",
      description: `Verify ${targetSymbol} at boundary conditions`,
      inputHint: "max int, empty collection, single element",
      expectedHint: "correct behavior at boundaries",
    });

    // Filter out already-existing tests
    const filteredCases = testCases.filter(
      (tc) => !existingTestNames.has(tc.name),
    );

    if (filteredCases.length > 0) {
      suggestions.push({
        targetFile: resolved,
        targetSymbol,
        testFile,
        framework,
        testCases: filteredCases,
        priority: this.hasTests(resolved) ? "medium" : "high",
      });
    }

    return suggestions;
  }

  // ─── Test Execution ───

  /**
   * Build the shell command to run specific test files with a given framework.
   *
   * @param testFiles - Array of test file paths to run
   * @param framework - Test framework identifier
   * @returns Shell command string
   */
  buildTestCommand(testFiles: string[], framework: string): string {
    const files = testFiles
      .map((f) => relative(this.config.projectPath, resolve(f)))
      .join(" ");

    switch (framework) {
      case "vitest":
        return `npx vitest run ${files}`;
      case "jest":
        return `npx jest ${files}`;
      case "node_test":
        return `node --test ${files}`;
      case "mocha":
        return `npx mocha ${files}`;
      default:
        return `npx vitest run ${files}`;
    }
  }

  /**
   * Parse test runner output into a structured TestRunResult.
   *
   * Supports vitest, jest, mocha, and node:test output formats.
   *
   * @param output - Raw test runner stdout/stderr
   * @param framework - Framework that produced the output
   * @returns Parsed test run result
   */
  parseTestOutput(output: string, framework: string): TestRunResult {
    const result: TestRunResult = {
      file: "",
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      errors: [],
      timestamp: Date.now(),
    };

    switch (framework) {
      case "vitest":
        this.parseVitestOutput(output, result);
        break;
      case "jest":
        this.parseJestOutput(output, result);
        break;
      case "node_test":
        this.parseNodeTestOutput(output, result);
        break;
      case "mocha":
        this.parseMochaOutput(output, result);
        break;
      default:
        this.parseGenericOutput(output, result);
        break;
    }

    return result;
  }

  /**
   * Record a test run result for history tracking.
   *
   * @param result - Test run result to record
   */
  recordResult(result: TestRunResult): void {
    this.testHistory.push(result);

    // Update lastRun on the test file if we have it
    const testFile = this.testFiles.get(resolve(result.file));
    if (testFile) {
      testFile.lastRun = result;
    }
  }

  /**
   * Get test run history for a specific test file.
   *
   * @param testFile - Absolute path to the test file
   * @returns Array of test run results, most recent first
   */
  getHistory(testFile: string): TestRunResult[] {
    const resolved = resolve(testFile);
    return this.testHistory
      .filter((r) => resolve(r.file) === resolved)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  // ─── Stats ───

  /**
   * Get test coverage statistics for the project.
   *
   * @returns Test coverage summary
   */
  getStats(): {
    totalTestFiles: number;
    totalTestCases: number;
    sourceFilesWithTests: number;
    sourceFilesWithoutTests: number;
    coveragePercent: number;
    frameworkBreakdown: Record<string, number>;
  } {
    const totalTestFiles = this.testFiles.size;
    let totalTestCases = 0;
    const frameworkBreakdown: Record<string, number> = {};

    for (const testFile of this.testFiles.values()) {
      totalTestCases += testFile.testCases.length;
      frameworkBreakdown[testFile.framework] =
        (frameworkBreakdown[testFile.framework] ?? 0) + 1;
    }

    const sourceFilesWithTests = this.sourceToTests.size;

    // Count unique source files we know about (from test imports)
    const allSourceFiles = new Set<string>();
    for (const testFile of this.testFiles.values()) {
      for (const imp of testFile.imports) {
        if (!this.isTestFile(imp)) {
          allSourceFiles.add(imp);
        }
      }
    }
    // Also add source files from sourceToTests that have no tests
    for (const src of this.sourceToTests.keys()) {
      allSourceFiles.add(src);
    }

    const totalSourceFiles = Math.max(allSourceFiles.size, sourceFilesWithTests);
    const sourceFilesWithoutTests = totalSourceFiles - sourceFilesWithTests;
    const coveragePercent =
      totalSourceFiles > 0
        ? Math.round((sourceFilesWithTests / totalSourceFiles) * 100)
        : 0;

    return {
      totalTestFiles,
      totalTestCases,
      sourceFilesWithTests,
      sourceFilesWithoutTests,
      coveragePercent,
      frameworkBreakdown,
    };
  }

  // ─── Private Methods ───

  /**
   * Find test files matching configured patterns.
   * Walks the project directory and filters by test file conventions.
   */
  private async findTestFiles(): Promise<string[]> {
    const allFiles = await this.walkDirectory(this.config.projectPath);
    return allFiles.filter((f) => this.isTestFile(f));
  }

  /**
   * Check if a file path matches test file conventions.
   *
   * @param filePath - File path to check
   * @returns True if the file is a test file
   */
  private isTestFile(filePath: string): boolean {
    const rel = relative(this.config.projectPath, filePath);
    return TEST_FILE_RE.test(rel) || TEST_DIR_RE.test(rel);
  }

  /**
   * Find the source file for a test file using naming conventions.
   *
   * Conventions:
   * - `foo.test.ts` → `foo.ts`
   * - `foo.spec.ts` → `foo.ts`
   * - `__tests__/foo.ts` → `../foo.ts`
   *
   * @param testFile - Absolute test file path
   * @returns Absolute source file path, or null if not found
   */
  private findSourceForTest(testFile: string): string | null {
    const dir = dirname(testFile);
    const base = basename(testFile);

    // foo.test.ts → foo.ts
    const sourceMatch = base.match(/^(.+)\.(test|spec)\.(ts|tsx|js|jsx)$/);
    if (sourceMatch) {
      const sourceName = sourceMatch[1];
      const ext = sourceMatch[3];

      // Check same directory
      const sameDirPath = join(dir, `${sourceName}.${ext}`);
      // Check parent directory (for __tests__/ convention)
      const parentDirPath = join(dirname(dir), `${sourceName}.${ext}`);
      // Check src/ sibling (for test/ convention)
      const srcDirPath = join(dirname(dir), "src", `${sourceName}.${ext}`);

      // Return the first plausible path (we can't verify existence synchronously)
      if (dirname(dir).endsWith("__tests__") || basename(dir) === "__tests__") {
        return parentDirPath;
      }
      if (basename(dir) === "test") {
        return srcDirPath;
      }
      return sameDirPath;
    }

    // __tests__/foo.ts → ../foo.ts
    if (basename(dir) === "__tests__") {
      return join(dirname(dir), base);
    }

    return null;
  }

  /**
   * Traverse reverse dependency graph to find test files that
   * transitively depend on a given source file.
   *
   * @param file - Starting file path
   * @param depth - Maximum traversal depth
   * @param visited - Set of already-visited paths (cycle prevention)
   * @returns Array of test file paths found via transitive dependencies
   */
  private findTransitiveTestDeps(
    file: string,
    depth: number,
    visited: Set<string>,
  ): string[] {
    if (depth <= 0) return [];
    visited.add(file);

    const results: string[] = [];

    // Find all files that import this file (reverse lookup from sourceToTests)
    // We need to check all test files' imports
    for (const [testPath, testFile] of this.testFiles) {
      if (visited.has(testPath)) continue;

      // Check if any of the test's imports transitively reach our file
      for (const importedFile of testFile.imports) {
        if (importedFile === file && !visited.has(testPath)) {
          results.push(testPath);
          visited.add(testPath);
        }
      }
    }

    // Also check non-test files that import this file, then find their tests
    for (const [sourcePath, testPaths] of this.sourceToTests) {
      if (visited.has(sourcePath)) continue;

      // Check if any test of this source file imports our target file
      // This is a simplified transitive check — for deeper traversal,
      // we'd need the full dependency graph from DependencyAnalyzer
      for (const testPath of testPaths) {
        if (visited.has(testPath)) continue;
        const testFile = this.testFiles.get(testPath);
        if (!testFile) continue;

        for (const imp of testFile.imports) {
          if (imp === file) {
            results.push(testPath);
            visited.add(testPath);
          }
        }
      }
    }

    // Recurse into dependents at reduced depth
    // Simplified: look for source files that import the current file
    for (const [testPath, testFile] of this.testFiles) {
      if (visited.has(testPath)) continue;
      for (const imp of testFile.imports) {
        if (!visited.has(imp) && !this.isTestFile(imp)) {
          const deeper = this.findTransitiveTestDeps(imp, depth - 1, visited);
          results.push(...deeper);
        }
      }
    }

    return [...new Set(results)];
  }

  /**
   * Find integration/e2e test files in the same directory or module.
   *
   * @param sourceFile - Source file to find integration tests for
   * @returns Array of integration test file paths
   */
  private findModuleIntegrationTests(sourceFile: string): string[] {
    const dir = dirname(sourceFile);
    const results: string[] = [];

    for (const [testPath] of this.testFiles) {
      if (INTEGRATION_TEST_RE.test(testPath) && dirname(testPath) === dir) {
        results.push(testPath);
      }
      // Also check parent directory for integration tests
      if (INTEGRATION_TEST_RE.test(testPath) && dirname(testPath) === dirname(dir)) {
        results.push(testPath);
      }
    }

    return results;
  }

  /**
   * Collect all source (non-test) files in the project.
   */
  private async collectSourceFiles(): Promise<string[]> {
    const allFiles = await this.walkDirectory(this.config.projectPath);
    return allFiles.filter((f) => !this.isTestFile(f));
  }

  /**
   * Read a file's content, returning empty string on failure.
   *
   * @param path - Absolute file path
   * @returns File content or empty string
   */
  private async readFile(path: string): Promise<string> {
    try {
      return await readFile(path, "utf-8");
    } catch {
      return "";
    }
  }

  /**
   * Recursively walk a directory, collecting source files.
   * Skips ignored directories (node_modules, dist, etc.).
   */
  private async walkDirectory(dir: string): Promise<string[]> {
    const results: string[] = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return results;
    }

    const ignoreSet = new Set(this.config.ignorePatterns);

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoreSet.has(entry.name)) {
          const sub = await this.walkDirectory(fullPath);
          results.push(...sub);
        }
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        results.push(fullPath);
      }
    }

    return results;
  }

  /**
   * Parse import paths from test file content and resolve them to absolute paths.
   */
  private parseTestImports(content: string, fromFile: string): string[] {
    const imports: string[] = [];
    const dir = dirname(fromFile);

    let match: RegExpExecArray | null;

    // Standard imports
    const importRe = new RegExp(IMPORT_RE.source, "g");
    while ((match = importRe.exec(content)) !== null) {
      const source = match[4];
      if (source.startsWith(".")) {
        const resolved = this.resolveImportPath(dir, source);
        if (resolved) imports.push(resolved);
      }
    }

    // Re-exports
    const reExportRe = new RegExp(RE_EXPORT_RE.source, "g");
    while ((match = reExportRe.exec(content)) !== null) {
      const source = match[2];
      if (source.startsWith(".")) {
        const resolved = this.resolveImportPath(dir, source);
        if (resolved) imports.push(resolved);
      }
    }

    // CJS requires
    const requireRe = new RegExp(REQUIRE_RE.source, "g");
    while ((match = requireRe.exec(content)) !== null) {
      const source = match[1];
      if (source.startsWith(".")) {
        const resolved = this.resolveImportPath(dir, source);
        if (resolved) imports.push(resolved);
      }
    }

    return [...new Set(imports)];
  }

  /**
   * Resolve a relative import specifier to an absolute path.
   * Handles .js → .ts resolution for ESM TypeScript projects.
   */
  private resolveImportPath(fromDir: string, importPath: string): string | null {
    let resolved = resolve(fromDir, importPath);

    // Strip .js extension and try .ts (ESM TS convention)
    if (resolved.endsWith(".js")) {
      const tsPath = resolved.slice(0, -3) + ".ts";
      return tsPath;
    }

    // If it already has a known extension, return as-is
    if (SOURCE_EXTENSIONS.has(extname(resolved))) {
      return resolved;
    }

    // Try adding .ts extension (most common in this codebase)
    return resolved + ".ts";
  }

  /**
   * Infer the test type from test name and describe block context.
   */
  private inferTestType(
    testName: string,
    describeNames: string[],
  ): TestCase["type"] {
    const combined = `${testName} ${describeNames.join(" ")}`.toLowerCase();

    if (/\b(?:e2e|end.to.end|playwright|cypress|browser)\b/.test(combined)) {
      return "e2e";
    }
    if (/\b(?:integration|api|database|db|http|server|route)\b/.test(combined)) {
      return "integration";
    }
    return "unit";
  }

  /**
   * Extract tags from a test name.
   * Tags are inferred from keywords in the test description.
   */
  private extractTags(testName: string): string[] {
    const tags: string[] = [];
    const lower = testName.toLowerCase();

    if (/\b(?:error|fail|throw|reject)\b/.test(lower)) tags.push("error");
    if (/\b(?:edge|boundary|limit|max|min)\b/.test(lower)) tags.push("edge-case");
    if (/\b(?:async|await|promise)\b/.test(lower)) tags.push("async");
    if (/\b(?:mock|stub|spy)\b/.test(lower)) tags.push("mock");
    if (/\b(?:snapshot)\b/.test(lower)) tags.push("snapshot");
    if (/\b(?:performance|perf|bench)\b/.test(lower)) tags.push("performance");
    if (/\b(?:security|auth|permission)\b/.test(lower)) tags.push("security");
    if (/\b(?:regression)\b/.test(lower)) tags.push("regression");

    return tags;
  }

  /**
   * Extract exported symbols from file content.
   */
  private extractExportedSymbols(
    content: string,
  ): Array<{ name: string; kind: string; line: number; exported: boolean }> {
    const symbols: Array<{ name: string; kind: string; line: number; exported: boolean }> = [];
    const lines = content.split("\n");

    // Build line offset map
    const lineOffsets: number[] = [];
    let offset = 0;
    for (const line of lines) {
      lineOffsets.push(offset);
      offset += line.length + 1;
    }

    const getLineNumber = (charIndex: number): number => {
      let lo = 0;
      let hi = lineOffsets.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (lineOffsets[mid] <= charIndex) {
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return lo;
    };

    const exportRe = new RegExp(EXPORT_SYMBOL_RE.source, "g");
    let match: RegExpExecArray | null;
    while ((match = exportRe.exec(content)) !== null) {
      const name = match[1];
      const line = getLineNumber(match.index);

      // Determine kind from the match
      const fullMatch = match[0];
      let kind = "variable";
      if (/\bfunction\b/.test(fullMatch)) kind = "function";
      else if (/\bclass\b/.test(fullMatch)) kind = "class";
      else if (/\binterface\b/.test(fullMatch)) kind = "interface";
      else if (/\btype\b/.test(fullMatch)) kind = "type";
      else if (/\benum\b/.test(fullMatch)) kind = "enum";

      symbols.push({ name, kind, line, exported: true });
    }

    return symbols;
  }

  /**
   * Infer the expected test file path for a source file.
   */
  private inferTestFilePath(sourceFile: string): string {
    const dir = dirname(sourceFile);
    const ext = extname(sourceFile);
    const base = basename(sourceFile, ext);
    return join(dir, `${base}.test${ext}`);
  }

  /**
   * Escape special regex characters in a string.
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // ─── Output Parsers (Private) ───

  /**
   * Parse vitest output format.
   *
   * Vitest output example:
   * ```
   * ✓ src/foo.test.ts (3 tests) 45ms
   *   ✓ should do X
   *   × should do Y
   * Tests  2 passed | 1 failed
   * ```
   */
  private parseVitestOutput(output: string, result: TestRunResult): void {
    // Match summary line: "Tests  N passed | N failed | N skipped"
    const summaryMatch = output.match(
      /Tests\s+(?:(\d+)\s+passed)?(?:\s*\|\s*(\d+)\s+failed)?(?:\s*\|\s*(\d+)\s+skipped)?/,
    );
    if (summaryMatch) {
      result.passed = parseInt(summaryMatch[1] ?? "0", 10);
      result.failed = parseInt(summaryMatch[2] ?? "0", 10);
      result.skipped = parseInt(summaryMatch[3] ?? "0", 10);
    }

    // Match duration: "Duration  1.23s" or "Time  45ms"
    const durationMatch = output.match(/(?:Duration|Time)\s+([\d.]+)\s*(s|ms)/);
    if (durationMatch) {
      const value = parseFloat(durationMatch[1]);
      result.duration = durationMatch[2] === "s" ? value * 1000 : value;
    }

    // Extract failures
    this.extractFailureBlocks(output, result);
  }

  /**
   * Parse jest output format.
   *
   * Jest output example:
   * ```
   * Tests:  1 failed, 2 passed, 3 total
   * Time:   1.234 s
   * ```
   */
  private parseJestOutput(output: string, result: TestRunResult): void {
    const summaryMatch = output.match(
      /Tests:\s+(?:(\d+)\s+failed,\s+)?(?:(\d+)\s+passed,\s+)?(\d+)\s+total/,
    );
    if (summaryMatch) {
      result.failed = parseInt(summaryMatch[1] ?? "0", 10);
      result.passed = parseInt(summaryMatch[2] ?? "0", 10);
      const total = parseInt(summaryMatch[3] ?? "0", 10);
      result.skipped = total - result.passed - result.failed;
    }

    const durationMatch = output.match(/Time:\s+([\d.]+)\s*(s|ms)/);
    if (durationMatch) {
      const value = parseFloat(durationMatch[1]);
      result.duration = durationMatch[2] === "s" ? value * 1000 : value;
    }

    this.extractFailureBlocks(output, result);
  }

  /**
   * Parse node:test output format (TAP-like).
   *
   * Node test output example:
   * ```
   * TAP version 13
   * ok 1 - should work
   * not ok 2 - should fail
   * 1..2
   * # tests 2
   * # pass 1
   * # fail 1
   * ```
   */
  private parseNodeTestOutput(output: string, result: TestRunResult): void {
    const passMatch = output.match(/#\s*pass\s+(\d+)/);
    const failMatch = output.match(/#\s*fail\s+(\d+)/);
    const skipMatch = output.match(/#\s*skip\s+(\d+)/);

    result.passed = parseInt(passMatch?.[1] ?? "0", 10);
    result.failed = parseInt(failMatch?.[1] ?? "0", 10);
    result.skipped = parseInt(skipMatch?.[1] ?? "0", 10);

    const durationMatch = output.match(/#\s*duration_ms\s+([\d.]+)/);
    if (durationMatch) {
      result.duration = parseFloat(durationMatch[1]);
    }

    // Extract "not ok" lines as failures
    const failLineRe = /not ok \d+ - (.+)/g;
    let match: RegExpExecArray | null;
    while ((match = failLineRe.exec(output)) !== null) {
      result.errors.push({
        testName: match[1],
        message: match[1],
        file: result.file,
      });
    }
  }

  /**
   * Parse mocha output format.
   *
   * Mocha output example:
   * ```
   *   2 passing (45ms)
   *   1 failing
   * ```
   */
  private parseMochaOutput(output: string, result: TestRunResult): void {
    const passMatch = output.match(/(\d+)\s+passing/);
    const failMatch = output.match(/(\d+)\s+failing/);
    const pendingMatch = output.match(/(\d+)\s+pending/);

    result.passed = parseInt(passMatch?.[1] ?? "0", 10);
    result.failed = parseInt(failMatch?.[1] ?? "0", 10);
    result.skipped = parseInt(pendingMatch?.[1] ?? "0", 10);

    const durationMatch = output.match(/passing\s+\((\d+)(ms|s)\)/);
    if (durationMatch) {
      const value = parseInt(durationMatch[1], 10);
      result.duration = durationMatch[2] === "s" ? value * 1000 : value;
    }

    this.extractFailureBlocks(output, result);
  }

  /**
   * Generic output parser — tries common patterns.
   */
  private parseGenericOutput(output: string, result: TestRunResult): void {
    // Try to find pass/fail counts from any format
    const passMatch = output.match(/(\d+)\s+(?:pass(?:ed|ing)?)/i);
    const failMatch = output.match(/(\d+)\s+(?:fail(?:ed|ing|ure)?)/i);

    result.passed = parseInt(passMatch?.[1] ?? "0", 10);
    result.failed = parseInt(failMatch?.[1] ?? "0", 10);

    this.extractFailureBlocks(output, result);
  }

  /**
   * Extract failure blocks from test output.
   * Looks for common failure patterns across frameworks.
   */
  private extractFailureBlocks(output: string, result: TestRunResult): void {
    // Common pattern: "FAIL" or "✕" or "×" followed by test name
    const failRe = /(?:FAIL|✕|×|✗)\s+(.+?)(?:\n|$)/g;
    let match: RegExpExecArray | null;
    while ((match = failRe.exec(output)) !== null) {
      const testName = match[1].trim();
      if (testName && !result.errors.some((e) => e.testName === testName)) {
        result.errors.push({
          testName,
          message: testName,
          file: result.file,
        });
      }
    }

    // Extract assertion errors: "Expected: X" / "Received: Y"
    const assertRe = /Expected:\s*(.+?)\n\s*Received:\s*(.+?)(?:\n|$)/g;
    while ((match = assertRe.exec(output)) !== null) {
      const lastError = result.errors[result.errors.length - 1];
      if (lastError) {
        lastError.expected = match[1].trim();
        lastError.actual = match[2].trim();
      }
    }

    // Extract file:line references
    const fileLineRe = /at\s+(?:\S+\s+)?\(?(.+?):(\d+):\d+\)?/g;
    while ((match = fileLineRe.exec(output)) !== null) {
      const lastError = result.errors[result.errors.length - 1];
      if (lastError && !lastError.line) {
        lastError.file = match[1];
        lastError.line = parseInt(match[2], 10);
      }
    }
  }
}
