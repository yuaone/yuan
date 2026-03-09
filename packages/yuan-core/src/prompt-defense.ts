/**
 * Prompt Injection Defense Module
 *
 * Sanitizes tool outputs and user inputs to prevent prompt injection attacks.
 * Standalone module — no internal imports.
 */

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface SanitizeResult {
  output: string;
  injectionDetected: boolean;
  patternsFound: string[];
  truncated: boolean;
  originalLength: number;
}

export interface ValidationResult {
  valid: boolean;
  injectionDetected: boolean;
  severity: InjectionSeverity;
  patternsFound: string[];
  sanitizedInput: string;
}

export type InjectionSeverity = "none" | "low" | "medium" | "high" | "critical";

export interface InjectionMatch {
  pattern: string;
  match: string;
  position: number;
}

export interface InjectionDetection {
  detected: boolean;
  severity: InjectionSeverity;
  patterns: InjectionMatch[];
  recommendation: "allow" | "sanitize" | "block";
}

export type StrictnessLevel = "low" | "medium" | "high";

// ── Pattern definitions ─────────────────────────────────────────────────────

interface PatternDef {
  name: string;
  regex: RegExp;
  severity: InjectionSeverity;
}

const INJECTION_PATTERNS: PatternDef[] = [
  {
    name: "ignore_previous_instructions",
    regex: /ignore\s+previous\s+instructions/gi,
    severity: "critical",
  },
  {
    name: "ignore_all_instructions",
    regex: /ignore\s+all\s+instructions/gi,
    severity: "critical",
  },
  {
    name: "disregard_directive",
    regex: /disregard\s+(previous|all|above|system)/gi,
    severity: "critical",
  },
  {
    name: "identity_override",
    regex: /you\s+are\s+now/gi,
    severity: "high",
  },
  {
    name: "new_instructions",
    regex: /new\s+instructions\s*:/gi,
    severity: "high",
  },
  {
    name: "system_prompt_extraction",
    regex: /system\s+prompt\s*:/gi,
    severity: "critical",
  },
  {
    name: "reveal_instructions",
    regex: /reveal\s+your\s+(instructions|prompt|system)/gi,
    severity: "critical",
  },
  {
    name: "override_safety",
    regex: /override\s+(safety|security|rules)/gi,
    severity: "critical",
  },
  {
    name: "jailbreak",
    regex: /\bjailbreak\b/gi,
    severity: "high",
  },
  {
    name: "dan_mode",
    regex: /\bDAN\s+mode\b/gi,
    severity: "high",
  },
  {
    name: "pretend_override",
    regex: /pretend\s+you\s+are/gi,
    severity: "medium",
  },
  {
    name: "act_as_override",
    regex: /act\s+as\s+if\s+you/gi,
    severity: "medium",
  },
  {
    name: "forget_everything",
    regex: /forget\s+everything/gi,
    severity: "high",
  },
  {
    name: "prompt_format_system",
    regex: /\[SYSTEM\]/gi,
    severity: "high",
  },
  {
    name: "prompt_format_inst",
    regex: /\[INST\]/gi,
    severity: "high",
  },
  {
    name: "prompt_format_sys_tag",
    regex: /<<SYS>>/gi,
    severity: "high",
  },
];

// ── Size limits per tool ────────────────────────────────────────────────────

const TOOL_OUTPUT_LIMITS: Record<string, number> = {
  file_read: 50_000,
  grep: 20_000,
  glob: 10_000,
  shell_exec: 30_000,
  git_ops: 20_000,
  test_run: 30_000,
  code_search: 20_000,
};

const DEFAULT_OUTPUT_LIMIT = 10_000;

// ── Helpers ─────────────────────────────────────────────────────────────────

function getOutputLimit(toolName: string): number {
  return TOOL_OUTPUT_LIMITS[toolName] ?? DEFAULT_OUTPUT_LIMIT;
}

/**
 * Attempt to decode base64 segments in a string and check for injections.
 * Returns any injection matches found in decoded segments.
 */
function detectBase64Injections(text: string): InjectionMatch[] {
  const matches: InjectionMatch[] = [];
  // Match potential base64 strings (at least 16 chars, valid base64 alphabet)
  const b64Regex = /[A-Za-z0-9+/]{16,}={0,2}/g;
  let b64Match: RegExpExecArray | null;

  while ((b64Match = b64Regex.exec(text)) !== null) {
    let decoded: string;
    try {
      decoded = Buffer.from(b64Match[0], "base64").toString("utf-8");
    } catch {
      continue;
    }

    // Check if the decoded string is mostly printable ASCII (sanity check)
    const printable = decoded.replace(/[^\x20-\x7E]/g, "");
    if (printable.length < decoded.length * 0.7) {
      continue;
    }

    for (const pat of INJECTION_PATTERNS) {
      const patRegex = new RegExp(pat.regex.source, pat.regex.flags);
      const innerMatch = patRegex.exec(decoded);
      if (innerMatch) {
        matches.push({
          pattern: `base64:${pat.name}`,
          match: b64Match[0].substring(0, 40),
          position: b64Match.index,
        });
      }
    }
  }

  return matches;
}

function severityRank(s: InjectionSeverity): number {
  const ranks: Record<InjectionSeverity, number> = {
    none: 0,
    low: 1,
    medium: 2,
    high: 3,
    critical: 4,
  };
  return ranks[s];
}

function maxSeverity(a: InjectionSeverity, b: InjectionSeverity): InjectionSeverity {
  return severityRank(a) >= severityRank(b) ? a : b;
}

function severityToRecommendation(severity: InjectionSeverity): "allow" | "sanitize" | "block" {
  switch (severity) {
    case "none":
      return "allow";
    case "low":
    case "medium":
      return "sanitize";
    case "high":
    case "critical":
      return "block";
  }
}

/**
 * Filter characters for high-strictness mode.
 * Removes non-printable control characters (except newline, tab, carriage return).
 */
function filterChars(text: string): string {
  // Keep printable ASCII, newline, tab, CR, and common unicode
  // Strip control chars 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

// ── PromptDefense Class ─────────────────────────────────────────────────────

export class PromptDefense {
  private readonly defaultLevel: StrictnessLevel;

  constructor(defaultLevel: StrictnessLevel = "medium") {
    this.defaultLevel = defaultLevel;
  }

  /**
   * Detect injection patterns in text, including base64-encoded variants.
   */
  detectInjection(text: string): InjectionDetection {
    const patterns: InjectionMatch[] = [];
    let overallSeverity: InjectionSeverity = "none";

    // Direct pattern matching
    for (const pat of INJECTION_PATTERNS) {
      const regex = new RegExp(pat.regex.source, pat.regex.flags);
      let m: RegExpExecArray | null;
      while ((m = regex.exec(text)) !== null) {
        patterns.push({
          pattern: pat.name,
          match: m[0],
          position: m.index,
        });
        overallSeverity = maxSeverity(overallSeverity, pat.severity);
      }
    }

    // Base64-encoded pattern matching
    const b64Matches = detectBase64Injections(text);
    for (const bm of b64Matches) {
      patterns.push(bm);
      // Base64-encoded injections are at least high severity (they imply intent)
      overallSeverity = maxSeverity(overallSeverity, "high");
    }

    return {
      detected: patterns.length > 0,
      severity: overallSeverity,
      patterns,
      recommendation: severityToRecommendation(overallSeverity),
    };
  }

  /**
   * Sanitize a string: strip injection patterns, optionally truncate and filter.
   */
  sanitize(text: string, level?: StrictnessLevel): string {
    const effectiveLevel = level ?? this.defaultLevel;
    let result = text;

    // All levels: strip injection patterns
    for (const pat of INJECTION_PATTERNS) {
      result = result.replace(new RegExp(pat.regex.source, pat.regex.flags), "[REDACTED]");
    }

    // Medium+: also strip base64-encoded injections
    if (effectiveLevel === "medium" || effectiveLevel === "high") {
      const b64Regex = /[A-Za-z0-9+/]{16,}={0,2}/g;
      const b64Segments: Array<{ start: number; end: number }> = [];
      let b64Match: RegExpExecArray | null;

      while ((b64Match = b64Regex.exec(result)) !== null) {
        let decoded: string;
        try {
          decoded = Buffer.from(b64Match[0], "base64").toString("utf-8");
        } catch {
          continue;
        }
        const printable = decoded.replace(/[^\x20-\x7E]/g, "");
        if (printable.length < decoded.length * 0.7) continue;

        for (const pat of INJECTION_PATTERNS) {
          if (new RegExp(pat.regex.source, pat.regex.flags).test(decoded)) {
            b64Segments.push({
              start: b64Match.index,
              end: b64Match.index + b64Match[0].length,
            });
            break;
          }
        }
      }

      // Replace b64 segments in reverse order to preserve indices
      for (let i = b64Segments.length - 1; i >= 0; i--) {
        const seg = b64Segments[i]!;
        result =
          result.substring(0, seg.start) +
          "[REDACTED:BASE64]" +
          result.substring(seg.end);
      }
    }

    // High: aggressive character filtering
    if (effectiveLevel === "high") {
      result = filterChars(result);
    }

    return result;
  }

  /**
   * Sanitize tool output: detect injections, strip patterns, truncate to limit.
   */
  sanitizeToolOutput(toolName: string, output: string): SanitizeResult {
    const originalLength = output.length;
    const limit = getOutputLimit(toolName);

    // Detect before sanitizing (for reporting)
    const detection = this.detectInjection(output);

    // Sanitize
    let sanitized = this.sanitize(output, this.defaultLevel);

    // Truncate
    let truncated = false;
    if (sanitized.length > limit) {
      sanitized = sanitized.substring(0, limit) + "\n... [truncated]";
      truncated = true;
    }

    return {
      output: sanitized,
      injectionDetected: detection.detected,
      patternsFound: detection.patterns.map((p) => p.pattern),
      truncated,
      originalLength,
    };
  }

  /**
   * Validate user input for injection attempts.
   */
  validateUserInput(input: string): ValidationResult {
    const detection = this.detectInjection(input);
    const sanitizedInput = this.sanitize(input, this.defaultLevel);

    return {
      valid: !detection.detected || detection.severity === "low",
      injectionDetected: detection.detected,
      severity: detection.severity,
      patternsFound: detection.patterns.map((p) => p.pattern),
      sanitizedInput,
    };
  }

  /**
   * Wrap tool output with safety markers to prevent the LLM from confusing
   * tool output with its own instructions.
   */
  wrapToolOutput(toolName: string, output: string): string {
    const result = this.sanitizeToolOutput(toolName, output);
    return `[Tool Output: ${toolName}]\n${result.output}\n[End Tool Output]`;
  }
}
