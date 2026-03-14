/**
 * @module causal-chain-resolver
 * @description Phase 9 — registry-driven root-cause analysis.
 *
 * Language detection and error patterns are fully driven by LANGUAGE_REGISTRY (SSOT).
 * No language-specific hardcoding here — add a language to language-registry.ts
 * and the resolver picks it up automatically.
 *
 * Role: advisor only. Never modifies files or controls the agent loop.
 */

import { extname } from "node:path";
import {
  LANGUAGE_REGISTRY,
  getLanguageByExtension,
  type LanguageRegistryEntry,
} from "./language-registry.js";
import type { FailureSignatureMemory } from "./failure-signature-memory.js";
import type { DependencyAnalyzer } from "./dependency-analyzer.js";

// ─── Types ───

export interface CausalChainResult {
  /** Normalized error/failure signature */
  failureSignature: string;
  /** Detected language (from registry) */
  detectedLanguage?: string;
  /** Best guess at the real root cause (not the symptom) */
  suspectedRootCause: string;
  /** Supporting evidence list */
  evidence: string[];
  /** Files likely involved in the root cause */
  affectedFiles: string[];
  /** Symbol names involved (if known) */
  affectedSymbols: string[];
  /** 0.0–1.0 confidence */
  confidence: number;
  /** Suggested next strategy (optional) */
  recommendedStrategy?: string;
}

// ─── Language-agnostic root cause hints ───
// Keyed by normalized pattern (lowercase). Values are { hint, confidence }.
// These cover the commonErrors from LANGUAGE_REGISTRY across all language groups.

const ERROR_HINT_MAP: Record<string, { hint: string; confidence: number }> = {
  // Systems (C/C++)
  "undefined reference":       { hint: "Linker error: symbol not defined in any compiled unit. Check library flags or missing .c/.cpp file.", confidence: 0.80 },
  "implicit declaration":      { hint: "Function used before declaration. Add a header include or forward-declare.", confidence: 0.75 },
  "segmentation fault":        { hint: "Null/invalid pointer dereference or stack overflow. Check pointer initialization and bounds.", confidence: 0.65 },
  "no matching function":      { hint: "Function overload not found. Check argument types or template instantiation.", confidence: 0.75 },
  "use of deleted function":   { hint: "Trying to copy/assign a non-copyable type. Use std::move or a unique_ptr.", confidence: 0.80 },

  // Rust
  "cannot borrow":             { hint: "Borrow checker violation. Check ownership — likely a mutable borrow while immutably borrowed.", confidence: 0.85 },
  "lifetime":                  { hint: "Lifetime annotation required or mismatched. The borrow may outlive the data it references.", confidence: 0.80 },
  "mismatched types":          { hint: "Type mismatch between expected and actual. Check return type or function argument.", confidence: 0.80 },
  "cannot move":               { hint: "Moving out of a borrowed/used value. Clone the value or restructure ownership.", confidence: 0.80 },

  // Go
  "undefined:":                { hint: "Symbol undefined. Check import path or package name.", confidence: 0.80 },
  "cannot use":                { hint: "Type incompatibility. Check interface implementation or type assertion.", confidence: 0.75 },
  "declared but not used":     { hint: "Go requires all declared variables to be used. Remove or use the variable.", confidence: 0.95 },
  "import cycle":              { hint: "Circular import detected. Restructure packages to break the cycle.", confidence: 0.90 },

  // TypeScript / JavaScript
  "ts2304":                    { hint: "Symbol not found. Check: is it exported? Is the import path correct?", confidence: 0.85 },
  "ts2552":                    { hint: "Symbol not found (did you mean). Check spelling and export chain.", confidence: 0.80 },
  "ts2307":                    { hint: "Module not found. File may have moved or import path is wrong.", confidence: 0.85 },
  "ts2345":                    { hint: "Type mismatch on function argument. Check interface or function signature change.", confidence: 0.80 },
  "ts2322":                    { hint: "Type assignment mismatch. Check interface definition change.", confidence: 0.80 },
  "ts7006":                    { hint: "Implicit any. Add explicit type annotation.", confidence: 0.90 },
  "ts2339":                    { hint: "Property does not exist on type. Interface may have changed or wrong object accessed.", confidence: 0.80 },
  "is not a function":         { hint: "Calling something that is undefined or not callable. Check import and initialization order.", confidence: 0.75 },
  "cannot read properties of": { hint: "Null/undefined property access. Add null check or verify object is initialized.", confidence: 0.75 },
  "is not defined":            { hint: "Variable not in scope. Check import, declaration order, or typo.", confidence: 0.80 },

  // React / JSX
  "jsx element":               { hint: "JSX type error. Check component props interface.", confidence: 0.75 },
  "react hook":                { hint: "Hook rules violation. Hooks can only be called at the top level of a function component.", confidence: 0.85 },
  "key prop":                  { hint: "Missing key prop on list element. Add unique key to each rendered item.", confidence: 0.90 },

  // Python
  "typeerror":                 { hint: "Wrong type passed to function. Check argument types and function signature.", confidence: 0.75 },
  "attributeerror":            { hint: "Object has no such attribute. Check class definition or typo.", confidence: 0.80 },
  "importerror":               { hint: "Import failed. Check module name, virtual env, or PYTHONPATH.", confidence: 0.80 },
  "modulenotfounderror":       { hint: "Module not installed or not on path. Run pip install or check PYTHONPATH.", confidence: 0.85 },
  "indentationerror":          { hint: "Indentation is wrong. Mix of tabs and spaces, or wrong indent level.", confidence: 0.95 },

  // Java
  "nullpointerexception":      { hint: "Null reference accessed. Add null check before usage.", confidence: 0.75 },
  "classnotfoundexception":    { hint: "Class not on classpath. Check dependency or build output.", confidence: 0.80 },
  "cannot find symbol":        { hint: "Symbol not found at compile time. Check import or method name.", confidence: 0.80 },
  "incompatible types":        { hint: "Type mismatch. Check cast or method return type.", confidence: 0.75 },

  // Kotlin
  "unresolved reference":      { hint: "Symbol not found. Check import or class name.", confidence: 0.80 },
  "type mismatch":             { hint: "Kotlin type mismatch. Check nullability (T vs T?).", confidence: 0.80 },
  "smart cast is impossible":  { hint: "Nullable variable reassigned between check and use. Use local val.", confidence: 0.85 },

  // Ruby
  "nomethoderror":             { hint: "Method called on nil or wrong type. Check object initialization.", confidence: 0.75 },
  "nameerror":                 { hint: "Uninitialized constant or undefined variable. Check require/load.", confidence: 0.80 },
  "loaderror":                 { hint: "File not found for require. Check gem or file path.", confidence: 0.80 },

  // PHP
  "undefined variable":        { hint: "Variable used before assignment. Check scope or initialization.", confidence: 0.80 },
  "class not found":           { hint: "Class not autoloaded. Check namespace, use statement, or composer autoload.", confidence: 0.80 },
  "parse error":               { hint: "PHP syntax error. Check for missing semicolons, brackets, or PHP version.", confidence: 0.85 },

  // C# / .NET
  "cs0246":                    { hint: "Type or namespace not found. Check using directive or missing reference.", confidence: 0.85 },
  "cs0103":                    { hint: "Name does not exist in context. Check scope or missing using.", confidence: 0.80 },
  "cs1061":                    { hint: "No definition for member. Check interface implementation or typo.", confidence: 0.80 },

  // Bash / Shell
  "command not found":         { hint: "Binary not in PATH or not installed. Check shebang, PATH, or install.", confidence: 0.90 },
  "permission denied":         { hint: "File not executable or no read access. Run chmod +x or check permissions.", confidence: 0.90 },
  "no such file":              { hint: "File path wrong or file missing. Check relative/absolute path.", confidence: 0.85 },

  // Dart / Flutter
  "null safety":               { hint: "Null safety violation. Add null check (?) or assert non-null (!). Prefer null-safe types.", confidence: 0.85 },
  "native module cannot be null": { hint: "Native module not linked. Run flutter pub get or re-link native dependencies.", confidence: 0.85 },
  "the getter":                { hint: "Property access on null. Check if the object is initialized before accessing.", confidence: 0.75 },

  // Swift
  "force unwrap":              { hint: "Forced unwrap of nil optional. Use if let / guard let / nil coalescing (??) instead.", confidence: 0.90 },
  "method not found":          { hint: "Method does not exist on this type. Check protocol conformance or import.", confidence: 0.80 },
  "not copyable":              { hint: "~Copyable type used where copy is required. Use move semantics or borrow.", confidence: 0.80 },

  // Elixir
  "keyerror":                  { hint: "Map key not found. Use Map.get/3 with a default or pattern match with guards.", confidence: 0.85 },
  "cycle in dependency graph": { hint: "Circular module dependency detected. Restructure to break the cycle.", confidence: 0.90 },

  // Haskell / F# / OCaml (functional)
  "non-exhaustive patterns":   { hint: "Pattern match is incomplete. Add a catch-all case or the missing constructor.", confidence: 0.90 },
  "this expression was expected to have type": { hint: "Type mismatch in expression. Check return type annotation or inferred type.", confidence: 0.80 },

  // SQL
  "null value in column":      { hint: "NOT NULL constraint violated. Provide a value or add a DEFAULT.", confidence: 0.90 },
  "syntax error near unexpected token": { hint: "SQL syntax error. Check for missing commas, wrong keyword order, or unmatched quotes.", confidence: 0.85 },

  // Makefile
  "recipe for target failed":  { hint: "Make rule returned non-zero. Check the command in the Makefile rule above this line.", confidence: 0.85 },
  "no rule to make target":    { hint: "Make target not defined. Check spelling or add the missing rule/file.", confidence: 0.85 },

  // C# / .NET (additional)
  "cs0161":                    { hint: "Not all code paths return a value. Add a return statement or throw for all branches.", confidence: 0.90 },
  "object reference not set":  { hint: "NullReferenceException. Object is null. Add null check before accessing.", confidence: 0.80 },

  // Kotlin additional
  "val cannot be reassigned":  { hint: "Kotlin immutable val reassignment. Change val to var or restructure the logic.", confidence: 0.95 },

  // General arithmetic / runtime
  "arithmetic overflow":       { hint: "Integer overflow. Use checked arithmetic, larger type, or BigInteger.", confidence: 0.80 },
  "division by zero":          { hint: "Division by zero. Add a guard check before the division.", confidence: 0.90 },
  "assertion failed":          { hint: "Assertion failed. A precondition was violated. Check the assertion condition.", confidence: 0.75 },
  "use of uninitialized value": { hint: "Uninitialized memory read (likely C/C++ or Valgrind). Initialize the variable before use.", confidence: 0.85 },

  // TPU / JAX / XLA
  "xlaruntimeerror":                 { hint: "XLA runtime error. Check device memory, shape compatibility, or kernel compilation.", confidence: 0.80 },
  "resource_exhausted":              { hint: "TPU/GPU HBM OOM. Reduce batch size, use gradient checkpointing, or split across more devices.", confidence: 0.90 },
  "tracerarrayconversionerror":      { hint: "Tried to convert JAX tracer to concrete value. Avoid Python-level branching on traced values inside jit.", confidence: 0.90 },
  "unexpectedtracererror":           { hint: "JAX tracer escaped scope. Dynamic shapes or side effects inside jit/vmap. Use static_argnums or lax.cond.", confidence: 0.85 },
  "shapes must be compatible":       { hint: "XLA shape mismatch. Check tensor dimensions before the op or reshape explicitly.", confidence: 0.85 },
  "mark_step":                       { hint: "torch_xla: missing xm.mark_step(). Add it at the end of each training step to sync TPU.", confidence: 0.90 },
  "xla device not found":            { hint: "TPU/XLA device unavailable. Check PJRT_DEVICE env var or TPU pod connectivity.", confidence: 0.85 },

  // NPU
  "unsupported op":                  { hint: "NPU doesn't support this op. Check target compute unit (CPU/GPU/ANE) or use a supported substitute op.", confidence: 0.85 },
  "model conversion failed":         { hint: "CoreML/OpenVINO model conversion error. Check input types, op support, and model precision.", confidence: 0.80 },
  "operator not supported in target compute unit": { hint: "Op not runnable on ANE/NPU. Set computeUnits to cpuAndGpu or cpuOnly.", confidence: 0.90 },
  "unsupported primitive":           { hint: "OpenVINO: op not supported in this version or target device. Check layer compatibility table.", confidence: 0.85 },
  "snpe error":                      { hint: "Qualcomm SNPE error. Check DLC model, runtime backend (CPU/GPU/DSP/AIP), and input tensor shapes.", confidence: 0.80 },
  "quantization failed":             { hint: "NPU quantization error. Ensure calibration data covers input range, or switch to float16.", confidence: 0.80 },

  // QPU
  "qiskiterror":                     { hint: "Qiskit error. Check circuit validity, backend connectivity, and qubit count.", confidence: 0.80 },
  "circuiterror":                     { hint: "Circuit construction error. Check gate args, qubit register size, or incompatible operations.", confidence: 0.85 },
  "transfilererror":                  { hint: "Qiskit transpiler failed. Circuit may not be compatible with target backend's native gate set.", confidence: 0.80 },
  "circuit too wide":                { hint: "Circuit uses more qubits than the backend supports. Reduce qubit count or use a larger backend.", confidence: 0.90 },
  "backendjoблimit":                  { hint: "Too many concurrent jobs on IBM Quantum. Wait for existing jobs to complete.", confidence: 0.85 },
  "gate not supported on device":    { hint: "QPU gate not in backend's basis gates. Use transpile() to decompose to native gates.", confidence: 0.85 },
  "gradient not defined":            { hint: "PennyLane: gradient not defined for this operation. Use a differentiable op or custom gradient.", confidence: 0.85 },

  // CUDA / GPU
  "cuda error":                { hint: "CUDA runtime error. Check device memory, kernel launch config, or synchronization.", confidence: 0.80 },
  "device mismatch":           { hint: "Tensor on wrong device (CPU vs CUDA). Add .to(device) or .cuda() call.", confidence: 0.85 },
  "out of memory":             { hint: "GPU OOM. Reduce batch size, use gradient checkpointing, or clear cache with torch.cuda.empty_cache().", confidence: 0.90 },
  "cl_compiler_not_available": { hint: "OpenCL compiler not found. Install GPU drivers or OpenCL SDK for the target device.", confidence: 0.85 },
  "illegal memory access":     { hint: "CUDA illegal memory access. Check array bounds, pointer arithmetic, or race conditions.", confidence: 0.80 },
  "no kernel image":           { hint: "CUDA kernel not compiled for this GPU arch. Recompile with correct --arch flag (e.g. sm_80).", confidence: 0.85 },

  // Kubernetes / DevOps
  "errimagepull":              { hint: "Kubernetes cannot pull the image. Check image name, tag, and registry credentials.", confidence: 0.90 },
  "access is denied":          { hint: "Permission error. Check file permissions, sudo requirements, or RBAC policies.", confidence: 0.80 },
  "hash mismatch":             { hint: "Package hash mismatch (Nix/lock file). Run the lock file update command.", confidence: 0.85 },

  // Generic
  "enoent":                    { hint: "File not found. Check path and working directory.", confidence: 0.85 },
  "econnrefused":              { hint: "Connection refused. Service may not be running or wrong port.", confidence: 0.80 },
  "cannot find module":        { hint: "Module not installed or wrong path. Run install command or check path.", confidence: 0.85 },
  "build failure":             { hint: "Build failed. Check compiler output for specific error above this line.", confidence: 0.60 },
  "build failed":              { hint: "Build failed. Scroll up for the specific compilation error.", confidence: 0.60 },
};

// ─── Helpers ───

/**
 * Normalize a raw error message into a stable cluster key.
 */
function normalizeSignature(raw: string): string {
  return raw
    .replace(/\(.*?\)/g, "")
    .replace(/at\s+\S+/g, "")
    .replace(/\/[\w./\-]+/g, "<path>")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * Detect language from error text by matching LANGUAGE_REGISTRY errorSignal patterns.
 */
function detectLanguageFromError(rawError: string): LanguageRegistryEntry | null {
  for (const entry of LANGUAGE_REGISTRY) {
    if (entry.errorSignal && rawError.includes(entry.errorSignal)) {
      return entry;
    }
  }
  return null;
}

/**
 * Detect language from file extensions using LANGUAGE_REGISTRY via getLanguageByExtension.
 */
function detectLanguageFromFiles(files: string[]): LanguageRegistryEntry | null {
  for (const file of files) {
    const ext = extname(file);
    if (!ext) continue;
    const entry = getLanguageByExtension(ext);
    if (entry) return entry;
  }
  return null;
}

/**
 * Match raw error against ERROR_HINT_MAP keys (case-insensitive substring).
 * Also checks commonErrors from the detected language registry entry.
 */
function matchErrorHint(
  rawError: string,
  langEntry: LanguageRegistryEntry | null,
): { hint: string; confidence: number; matchedPattern: string } | null {
  const lower = rawError.toLowerCase();

  // 1. Direct hint map lookup
  for (const [pattern, value] of Object.entries(ERROR_HINT_MAP)) {
    if (lower.includes(pattern)) {
      return { ...value, matchedPattern: pattern };
    }
  }

  // 2. Fallback: language commonErrors from registry → generic hint
  if (langEntry?.commonErrors) {
    for (const pattern of langEntry.commonErrors) {
      if (lower.includes(pattern.toLowerCase())) {
        return {
          hint: `Known ${langEntry.displayName} error pattern: "${pattern}". Check the ${langEntry.displayName} documentation or build output for details.`,
          confidence: 0.55,
          matchedPattern: pattern,
        };
      }
    }
  }

  return null;
}

// ─── CausalChainResolver ───

export class CausalChainResolver {
  private readonly failureMem: FailureSignatureMemory;
  private readonly depAnalyzer: DependencyAnalyzer | null;

  constructor(
    failureMem: FailureSignatureMemory,
    depAnalyzer?: DependencyAnalyzer,
  ) {
    this.failureMem = failureMem;
    this.depAnalyzer = depAnalyzer ?? null;
  }

  /**
   * Analyze a failure and return the most likely root cause with evidence.
   * Language detection is fully registry-driven — no hardcoded language checks.
   */
  async resolve(
    rawError: string,
    recentlyChangedFiles: string[],
    projectPath: string,
  ): Promise<CausalChainResult> {
    const sig = normalizeSignature(rawError);
    const evidence: string[] = [];
    const affectedFiles: string[] = [...recentlyChangedFiles];
    const affectedSymbols: string[] = [];
    let confidence = 0.3;
    let suspectedRootCause = "Unknown — manual investigation needed.";
    let recommendedStrategy: string | undefined;

    // ── Step 1: Detect language (error signal first, then file extensions) ──
    const langFromError = detectLanguageFromError(rawError);
    const langFromFiles = detectLanguageFromFiles(recentlyChangedFiles);
    const detectedLang = langFromError ?? langFromFiles;

    if (detectedLang) {
      evidence.push(`Detected language: ${detectedLang.displayName}`);
    }

    // ── Step 2: FailureSignatureMemory — known patterns from past runs ──
    const known = this.failureMem.query(rawError);
    if (known.length > 0) {
      const top = known[0]!;
      const { signature, bestFix } = top;
      suspectedRootCause = signature.rootCause;
      confidence = Math.min(0.9, 0.5 + signature.seenCount * 0.05);
      evidence.push(`Known failure pattern (seen ${signature.seenCount}x): ${signature.messagePattern}`);
      if (bestFix) {
        recommendedStrategy = bestFix.strategy;
        evidence.push(`Best known fix: "${bestFix.strategy}" (${bestFix.successCount} successes)`);
      }
    }

    // ── Step 3: Registry-driven error pattern matching ──
    const hintMatch = matchErrorHint(rawError, detectedLang);
    if (hintMatch) {
      // If FailureSignatureMemory didn't find anything better, use this
      if (confidence < 0.6) {
        suspectedRootCause = hintMatch.hint;
        confidence = Math.max(confidence, hintMatch.confidence);
      } else {
        // Use as corroborating evidence
        evidence.push(`Pattern match "${hintMatch.matchedPattern}": ${hintMatch.hint}`);
        confidence = Math.min(0.95, confidence + 0.1);
      }
    }

    // ── Step 4: Build command hint from registry ──
    // If "build failed" or "build failure" error — suggest the language's build command
    if (detectedLang?.buildCmd && /build.*(fail|error)|error.*(build|compile)/i.test(rawError)) {
      evidence.push(`${detectedLang.displayName} build command: ${detectedLang.buildCmd}`);
    }

    // ── Step 5: Import chain analysis via DependencyAnalyzer ──
    if (this.depAnalyzer && recentlyChangedFiles.length > 0) {
      try {
        const graph = await this.depAnalyzer.analyze(projectPath);
        for (const changedFile of recentlyChangedFiles.slice(0, 5)) {
          // Find files that import the changed file (reverse deps)
          const importers: string[] = [];
          for (const [file, deps] of graph.edges) {
            if (deps.some((d: string) => d.includes(changedFile.replace(/\.[^.]+$/, "")))) {
              importers.push(file);
            }
          }
          if (importers.length > 0) {
            evidence.push(`${changedFile} is imported by: ${importers.slice(0, 3).join(", ")}`);
            affectedFiles.push(...importers.slice(0, 3));
          }
          // Get exports of changed file
          const node = graph.nodes.get(changedFile);
          if (node?.exports.length) {
            affectedSymbols.push(...node.exports.slice(0, 5));
          }
        }
        confidence = Math.min(0.95, confidence + 0.15);
      } catch {
        // DependencyAnalyzer failure is non-blocking
      }
    }

    // ── Step 6: Symptom vs root cause divergence heuristic ──
    // If error mentions a file that's NOT in recentlyChangedFiles → symptom/cause split
    const errorFileMatch = rawError.match(/(?:at |in |file\s+)?([^\s:'"]+\.[a-zA-Z]{1,6})/);
    if (errorFileMatch) {
      const errorFile = errorFileMatch[1]!;
      const isSourceFile = /\.[cm]?[jt]sx?$|\.(py|go|rs|java|kt|rb|php|cs|swift|c|cpp|h|hpp)$/.test(errorFile);
      if (isSourceFile && !recentlyChangedFiles.some(f => f.endsWith(errorFile) || errorFile.endsWith(f))) {
        evidence.push(
          `Error in "${errorFile}" but recently changed: [${recentlyChangedFiles.slice(-2).join(", ")}]. ` +
          `Symptom file ≠ changed file — your change may have broken an import/export in ${errorFile}.`
        );
        confidence = Math.max(confidence, 0.60);
      }
    }

    return {
      failureSignature: sig,
      detectedLanguage: detectedLang?.displayName,
      suspectedRootCause,
      evidence: [...new Set(evidence)],
      affectedFiles: [...new Set(affectedFiles)].slice(0, 10),
      affectedSymbols: [...new Set(affectedSymbols)].slice(0, 10),
      confidence,
      recommendedStrategy,
    };
  }

  /**
   * Format result as a compact string for context injection.
   */
  formatForContext(result: CausalChainResult): string {
    const lines = [
      `[CausalAnalysis]${result.detectedLanguage ? ` lang=${result.detectedLanguage}` : ""} confidence=${(result.confidence * 100).toFixed(0)}%`,
      `root_cause: ${result.suspectedRootCause}`,
    ];
    if (result.evidence.length > 0) {
      lines.push(`evidence: ${result.evidence.slice(0, 3).join(" | ")}`);
    }
    if (result.affectedFiles.length > 0) {
      lines.push(`affected: ${result.affectedFiles.slice(0, 4).join(", ")}`);
    }
    if (result.recommendedStrategy) {
      lines.push(`suggested_strategy: ${result.recommendedStrategy}`);
    }
    return lines.join("\n");
  }
}
