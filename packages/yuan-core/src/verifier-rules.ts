/**
 * @module verifier-rules
 * @description Deterministic verification of tool execution results.
 * Checks: file exists after write, build/test commands succeeded, etc.
 * NO LLM, pure pattern matching.
 */

export type VerifyVerdict = "PASS" | "FAIL" | "WARN";

export interface VerifyResult {
  verdict: VerifyVerdict;
  reason?: string;
  suggestedAction?: "retry" | "rollback" | "continue" | "ask_user";
}

/** Verify a tool result after execution */
export function verifyToolResult(
  toolName: string,
  _args: Record<string, unknown>,
  output: string,
  success: boolean,
): VerifyResult {
  // Always pass if tool reports success and output looks clean
  if (success && !hasErrorSignals(output)) {
    return { verdict: "PASS" };
  }

  // Tool reported failure
  if (!success) {
    return classifyFailure(toolName, output);
  }

  // Tool reported success but output has error signals
  if (hasErrorSignals(output)) {
    return {
      verdict: "WARN",
      reason: "Tool succeeded but output contains error patterns",
      suggestedAction: "continue",
    };
  }

  return { verdict: "PASS" };
}

// ─── Internal helpers ───

const ERROR_SIGNAL_RE =
  /error\s*:|Error:|FAIL|FAILED|Cannot find|not found|Permission denied|ENOENT|EACCES|SyntaxError|TypeError|ReferenceError/i;

function hasErrorSignals(output: string): boolean {
  return ERROR_SIGNAL_RE.test(output);
}

function classifyFailure(_toolName: string, output: string): VerifyResult {
  // Build/compile failures
  if (/tsc|typescript|TS\d{4}|type error/i.test(output)) {
    return {
      verdict: "FAIL",
      reason: "TypeScript compilation error",
      suggestedAction: "retry",
    };
  }
  // Test failures
  if (/FAIL|test failed|assertion|expect/i.test(output)) {
    return {
      verdict: "FAIL",
      reason: "Test failure",
      suggestedAction: "retry",
    };
  }
  // Permission
  if (/EACCES|Permission denied/i.test(output)) {
    return {
      verdict: "FAIL",
      reason: "Permission denied",
      suggestedAction: "ask_user",
    };
  }
  // File not found
  if (/ENOENT|not found|No such file/i.test(output)) {
    return {
      verdict: "FAIL",
      reason: "File not found",
      suggestedAction: "retry",
    };
  }
  // Network
  if (/ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(output)) {
    return {
      verdict: "FAIL",
      reason: "Network error",
      suggestedAction: "retry",
    };
  }
  // Default
  return {
    verdict: "FAIL",
    reason: "Tool execution failed",
    suggestedAction: "retry",
  };
}
