/**
 * @module self-evaluation
 * @description Lightweight self-evaluation before reporting success.
 * Checks: files actually changed, build not broken, no pending errors.
 * NO LLM, deterministic checks only.
 */

export interface SelfEvalResult {
  passed: boolean;
  score: number;         // 0~1
  issues: string[];
  recommendation: "report_success" | "run_verification" | "report_partial";
}

export function selfEvaluate(params: {
  changedFiles: string[];
  toolErrors: number;
  toolSuccesses: number;
  verificationRan: boolean;
  verificationPassed: boolean;
  iterationCount: number;
  maxIterations: number;
}): SelfEvalResult {
  const { changedFiles, toolErrors, toolSuccesses, verificationRan, verificationPassed, iterationCount, maxIterations } = params;
  const issues: string[] = [];
  let score = 1.0;

  // No changes made
  if (changedFiles.length === 0) {
    issues.push("No files were changed");
    score -= 0.3;
  }

  // High error rate
  const totalTools = toolErrors + toolSuccesses;
  if (totalTools > 0 && toolErrors / totalTools > 0.3) {
    issues.push(`High tool error rate: ${toolErrors}/${totalTools}`);
    score -= 0.2;
  }

  // Verification not run
  if (changedFiles.length > 0 && !verificationRan) {
    issues.push("Files changed but no verification was run");
    score -= 0.2;
  }

  // Verification failed
  if (verificationRan && !verificationPassed) {
    issues.push("Verification failed");
    score -= 0.4;
  }

  // Used too many iterations (possible struggle)
  if (iterationCount > maxIterations * 0.8) {
    issues.push("Used most of iteration budget — may have struggled");
    score -= 0.1;
  }

  score = Math.max(0, Math.min(1, score));

  const recommendation: SelfEvalResult["recommendation"] =
    score >= 0.7 ? "report_success"
    : !verificationRan && changedFiles.length > 0 ? "run_verification"
    : "report_partial";

  return { passed: score >= 0.5, score, issues, recommendation };
}
